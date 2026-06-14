import { ReactNode, useState, useCallback, useRef, useMemo, memo, createContext, useContext } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { usePathname, useRouter } from "next/navigation";
import { useLocation } from "react-router";
import { isNonTabRoute } from "../src/compat/tabRouting";
import { withApplyingViewHistory, type InboxViewSnapshot } from "../lib/inboxViewHistory";
import { RecentlyViewedMenu } from "./RecentlyViewedMenu";
import { useMutation, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { GlobalSearch } from "./GlobalSearch";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { TeamAvatarBar } from "./TeamAvatarBar";
import { TeamSwitcher } from "./TeamSwitcher";
import { ErrorBoundary } from "./ErrorBoundary";
import { soundNewSession } from "../lib/sounds";
import { subscribeComposeOptimistic } from "../lib/composeBridge";
import { animateSessionEnter } from "../store/undoActions";
import { Plus, PanelLeft, PanelRight } from "lucide-react";
import { SetupPromptBanner } from "./SetupPromptBanner";
import { DesktopAppBanner } from "./DesktopAppBanner";
import { CliOfflineBanner } from "./CliOfflineBanner";
import { DaemonStatusChip } from "./DaemonStatusChip";
import { SyncStatusChip } from "./SyncStatusChip";
import { TmuxMissingBanner } from "./TmuxMissingBanner";
import { FindBar } from "./FindBar";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsHelp";
import { SettingsModal } from "./settings/SettingsModal";
import { NewSessionModal } from "./ConversationList";
import { useInboxStore, useTrackedStore, categorizeSessions, sessionsWithPendingSend, isSessionHidden } from "../store/inboxStore";
import { useShortcutAction, useShortcutContext, useGlobalShortcutActions, formatShortcutLabel } from "../shortcuts";
import { usePrefetch } from "../hooks/usePrefetch";
import { desktopHeaderClass, setupDesktopDrag, isElectron } from "../lib/desktop";
import { CollapsedSessionRail, SessionListPanel, ConversationColumn } from "./GlobalSessionPanel";
import { useSyncInboxSessions } from "../hooks/useSyncInboxSessions";
import { useSyncBuckets } from "../hooks/useSyncBuckets";
import { useSyncDocs, useSyncMentionDocs } from "../hooks/useSyncDocs";
import { useSyncMentionPlans } from "../hooks/useSyncPlans";
import { useSyncMentionTasks } from "../hooks/useSyncTasks";
import { isInboxSessionView, resolveSessionSelectKind } from "../lib/inboxRouting";
import { useSessionSwitcher } from "../hooks/useSessionSwitcher";
import { SessionSwitcher } from "./SessionSwitcher";
import { TabBar, pathLabel } from "./TabBar";
import { TabContent } from "./TabContent";
import { useTipActions } from "../tips";

interface DashboardLayoutProps {
  children: ReactNode;
  hideSidebar?: boolean;
}

const DEFAULT_LAYOUT = { sidebar: 25, main: 75 };
const separatorClass = "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

// Stash on globalThis so the context identity survives Vite HMR reloads —
// without this, a hot-updated inner DashboardLayout reads a fresh context
// (default false) instead of the still-mounted outer's Provider (true),
// causing the full layout to render twice.
const _g = globalThis as Record<string, unknown>;
const DashboardNestCtx: React.Context<boolean> =
  (_g.__DashboardNestCtx as React.Context<boolean>) ??
  (_g.__DashboardNestCtx = createContext(false));

// The "N agents running" badge is the ONLY thing in the dashboard shell that
// needs the full sessions map. Keeping its subscription here (rather than in
// DashboardLayoutInner) means a streaming session heartbeat re-renders just
// this tiny button instead of the entire shell (Sidebar, CommandPalette,
// keyboard panel, main content) on every tick.
const ActiveAgentsBadge = memo(function ActiveAgentsBadge({ isOnInboxPage }: { isOnInboxPage: boolean }) {
  const s = useTrackedStore([
    s => s.sessions,
    s => s.sessionsWithQueuedMessages,
    s => s.pendingMessages,
  ]);
  const working = useMemo(
    () => categorizeSessions(s.sessions, s.sessionsWithQueuedMessages, sessionsWithPendingSend(s.pendingMessages)).working,
    [s.sessions, s.sessionsWithQueuedMessages, s.pendingMessages],
  );
  if (working.length === 0) return null;
  const activeAgentCount = working.length;
  return (
    <button
      onClick={() => {
        const store = useInboxStore.getState();
        if (!store.sidePanelOpen) store.toggleSidePanel();
        const firstWorking = working[0];
        if (firstWorking) {
          if (isOnInboxPage) store.setCurrentSession(firstWorking._id);
          else store.selectPanelSession(firstWorking._id);
        }
      }}
      className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-full cursor-pointer select-none transition-all duration-300"
      style={{
        background: 'color-mix(in srgb, var(--sol-green) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--sol-green) 20%, transparent)',
        boxShadow: '0 0 10px color-mix(in srgb, var(--sol-green) 12%, transparent)',
      }}
      title={`${activeAgentCount} agent${activeAgentCount !== 1 ? 's' : ''} running`}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-40" style={{ animationDuration: '1.5s' }} />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-sol-green" />
      </span>
      <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: 'var(--sol-green)' }}>
        {activeAgentCount}
      </span>
    </button>
  );
});

export function DashboardLayout(props: DashboardLayoutProps) {
  const isNested = useContext(DashboardNestCtx);
  if (isNested) return <>{props.children}</>;
  return (
    <DashboardNestCtx.Provider value={true}>
      <DashboardLayoutInner {...props} />
    </DashboardNestCtx.Provider>
  );
}

function DashboardLayoutInner({ children, hideSidebar }: DashboardLayoutProps) {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const isGuest = !isAuthenticated && !isAuthLoading;
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const s = useTrackedStore([
    s => s.clientStateInitialized,
    s => s.clientState.ui?.zen_mode,
    s => s.clientState.ui?.sidebar_collapsed,
    s => s.clientState.layouts?.dashboard,
    s => s.currentConversation?.source,
    s => s.sidePanelOpen,
    s => s.sidePanelSessionId,
    s => s.currentSessionId,
    s => s.viewingDismissedId,
    s => s.newSession.isOpen,
    s => s.tabs.length,
    s => s.activeTabId,
    s => s.tabs.find(t => t.id === s.activeTabId)?.path,
  ]);
  // The activity feed (/team/activity) carries the active workspace filter in its
  // URL as `?dir=`. The sidebar lives outside the tab's search-param context, so we
  // derive the filter here from the active tab's stored path and feed it down — this
  // drives the "Workspaces" highlight and the new-session git-context fallback below.
  const activeTabPath = s.tabs.find(t => t.id === s.activeTabId)?.path ?? "";
  const directoryFilter = useMemo(() => {
    const query = activeTabPath.split("?")[1];
    return query ? new URLSearchParams(query).get("dir") : null;
  }, [activeTabPath]);
  const isZenMode = s.clientState.ui?.zen_mode ?? false;
  const sidebarCollapsed = s.clientState.ui?.sidebar_collapsed ?? false;
  const rawLayout = s.clientState.layouts?.dashboard ?? DEFAULT_LAYOUT;
  const layout = {
    sidebar: Math.max(10, Math.min(50, rawLayout.sidebar ?? 25)),
    main: Math.max(30, Math.min(90, rawLayout.main ?? 75)),
  };
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();
  // The real browser URL from react-router. `pathname` (usePathname compat) can
  // report the active in-app tab's route instead — e.g. on Settings it returns a
  // carried "/inbox" tab — so use this when we need to know the page that's
  // actually mounted, not the tab the user last worked in.
  const routerLocation = useLocation();
  const router = useRouter();

  const [desktopClass, setDesktopClass] = useState("");
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  const [zoomHeight, setZoomHeight] = useState("100vh");
  const zoomRef = useRef(1);
  const headerRef = useRef<HTMLElement>(null);
  const prevWasInboxRef = useRef(false);
  const prevPathnameRef = useRef(pathname);
  usePrefetch();
  useSyncDocs();
  useSyncMentionTasks();
  useSyncMentionDocs();
  useSyncMentionPlans();
  useSyncInboxSessions();
  useSyncBuckets();
  const tipActions = useTipActions();

  const recalcHeight = useCallback(() => {
    if (typeof window === 'undefined') return;
    const z = zoomRef.current;
    setZoomHeight(z === 1 ? '100vh' : `calc(100vh / ${z})`);
  }, []);

  const createQuickSession = useMutation(api.conversations.createQuickSession);

  useMountEffect(() => {
    setDesktopClass(desktopHeaderClass());
    setIsDesktopApp(isElectron());
    recalcHeight();
    const timer = setTimeout(() => { setDesktopClass(desktopHeaderClass()); setIsDesktopApp(isElectron()); }, 500);
    return () => clearTimeout(timer);
  });

  useEventListener('resize', recalcHeight);

  useWatchEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    return setupDesktopDrag(header);
  }, [desktopClass]);

  const isOnConversationPage = pathname?.includes("/conversation/") ?? false;
  const isOnCommitPage = pathname?.includes("/commit/") ?? false;
  const isOnPRPage = pathname?.includes("/pr/") ?? false;
  const isOnInboxPage = isInboxSessionView(pathname, s.currentConversation?.source);
  const isOnTasksPage = pathname === "/tasks" || (pathname?.startsWith("/tasks/") ?? false);
  const isOnWorkflowsPage = pathname === "/workflows" || (pathname?.startsWith("/workflows/") ?? false);
  const isOnRoutinesPage = pathname === "/routines" || (pathname?.startsWith("/routines/") ?? false);
  const isOnSchedulesPage = pathname === "/schedules" || (pathname?.startsWith("/schedules/") ?? false);
  const isOnPlansPage = pathname === "/plans" || (pathname?.startsWith("/plans/") ?? false);
  const isOnDocsPage = pathname === "/docs" || (pathname?.startsWith("/docs/") ?? false);
  const isOnProjectsPage = pathname === "/projects" || (pathname?.startsWith("/projects/") ?? false);
  const isOnWindowsPage = pathname === "/windows";
  // Settings is a modal-like surface, not a working surface — selecting a session
  // there means "I'm done configuring, take me to it", not "peek beside". Keyed off
  // the real router URL because `pathname` lies here (returns the carried tab route).
  const isOnSettingsPage = routerLocation.pathname.startsWith("/settings");
  const isFullWidthPage = isOnConversationPage || isOnCommitPage || isOnPRPage || isOnInboxPage || isOnTasksPage || isOnWorkflowsPage || isOnRoutinesPage || isOnSchedulesPage || isOnPlansPage || isOnDocsPage || isOnProjectsPage || isOnWindowsPage;


  const showCollapsedRail = !s.sidePanelOpen && !isMobile;
  const showSessionList = s.sidePanelOpen && !isMobile;
  const showMobileSessionList = s.sidePanelOpen && isMobile;
  const showConversationColumn = !!s.sidePanelSessionId && !isOnInboxPage && !isOnConversationPage && !isOnSettingsPage && !isMobile;

  // Clear stale conversation-column session on full conversation pages so the
  // column doesn't reappear when navigating away. Only clear the session ID;
  // leave sidePanelOpen untouched so the session list sidebar stays visible.
  useWatchEffect(() => {
    if (isOnConversationPage && s.sidePanelSessionId) {
      s.clearSidePanelSession();
    }
  }, [isOnConversationPage, s.sidePanelSessionId]);

  const handleInboxSessionSelect = useCallback((id: string) => {
    const store = useInboxStore.getState();
    const sess = store.sessions[id];
    if (sess?.forked_from) {
      store.navigateToSession(id);
      if (store.showMySessions) store.setShowMySessions(false);
      return;
    }
    if (sess) {
      if (isSessionHidden(sess)) {
        store.setViewingDismissedId(id);
      } else {
        store.setCurrentSession(id);
      }
      if (store.showMySessions) store.setShowMySessions(false);
    } else {
      useInboxStore.getState().requestNavigate(id, { showMySessions: false });
    }
  }, []);

  // On conversation pages, derive active ID from the URL so non-owner viewers
  // (ViewerView) get correct sidebar highlighting — they don't set currentSessionId.
  const conversationPageId = isOnConversationPage && pathname
    ? pathname.replace('/conversation/', '').split(/[/?#]/)[0]
    : null;

  const sessionListActiveId = isOnInboxPage
    ? (s.viewingDismissedId ?? s.currentSessionId)
    : isOnConversationPage
    ? (conversationPageId ?? s.currentSessionId)
    : s.sidePanelSessionId;

  // Leave the current page and open the session in the inbox. Used by
  // conversation pages (ViewerView for non-owner access) and by Settings/config
  // — surfaces where selecting a session means "go work on it", not "peek
  // alongside". Routes through navigateToSession so forks/dismissed/pending all
  // resolve correctly.
  const handleLeaveAndOpenSession = useCallback((id: string) => {
    useInboxStore.getState().navigateToSession(id);
    router.push('/inbox');
  }, [router]);

  const sessionSelectKind = resolveSessionSelectKind({ isOnSettingsPage, isOnInboxPage, isOnConversationPage });
  const sessionListOnSelect = sessionSelectKind === "leave"
    ? handleLeaveAndOpenSession
    : sessionSelectKind === "inboxInPlace"
    ? handleInboxSessionSelect
    : s.selectPanelSession;

  useMountEffect(() => {
    setIsMobile(window.innerWidth < 768);
  });

  useEventListener("resize", () => {
    setIsMobile(window.innerWidth < 768);
  });

  useWatchEffect(() => {
    const wasInbox = prevWasInboxRef.current;
    prevWasInboxRef.current = isOnInboxPage;
    if (wasInbox && !isOnInboxPage) {
      const store = useInboxStore.getState();
      if (store.sidePanelUserClosed) return;
      const current = store.currentSessionId;
      if (current) {
        store.openSidePanel(current);
      } else {
        store.clearSidePanelSession();
      }
    }
  }, [isOnInboxPage]);

  useWatchEffect(() => {
    const prev = prevPathnameRef.current;
    prevPathnameRef.current = pathname;
    if (!prev || prev === pathname) return;
    const store = useInboxStore.getState();
    if (store.sidePanelUserClosed) return;
    const wasConvPage = prev.includes("/conversation/");
    const isNowConvPage = pathname?.includes("/conversation/");
    if (wasConvPage && !isNowConvPage) {
      const sessionId = prev.split("/conversation/")[1]?.split("?")[0];
      if (sessionId) {
        store.openSidePanel(sessionId);
      }
    }
    // Arriving at a conversation page (from notification, link, etc.) — open side panel
    if (isNowConvPage && !isOnInboxPage) {
      const sessionId = pathname?.split("/conversation/")[1]?.split("?")[0];
      if (sessionId) {
        store.openSidePanel(sessionId);
      }
    }
  }, [pathname, isOnInboxPage]);

  const resolveNewSessionContext = useCallback(() => {
    const store = useInboxStore.getState();
    // Ctrl+N always clones the selected session's project path — the session the
    // user sees highlighted (sessionListActiveId). No other source is consulted
    // while a session is selected, so directoryFilter and stale currentConversation
    // state can never override what the user has in focus.
    const selected = sessionListActiveId
      ? (store.sessions[sessionListActiveId]
          ?? store.conversations[sessionListActiveId])
      : null;
    if (selected?.project_path) {
      return {
        path: selected.project_path,
        gitRoot: selected.git_root || selected.project_path,
        agentType: selected.agent_type,
      };
    }
    // No session selected — only now fall back to dashboard directory filter, then git root.
    const ctx = store.currentConversation;
    if (directoryFilter) {
      return { path: directoryFilter, gitRoot: ctx.gitRoot || directoryFilter, agentType: ctx.agentType };
    }
    return { path: ctx.gitRoot, gitRoot: ctx.gitRoot, agentType: ctx.agentType };
  }, [directoryFilter, sessionListActiveId]);

  const handleQuickCreate = useCallback(() => {
    const store = useInboxStore.getState();
    if (!isOnInboxPage && store.showMySessions) store.setShowMySessions(false);
    soundNewSession();
    const { path, gitRoot, agentType: rawAgent } = resolveNewSessionContext();
    const agentType = (rawAgent || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";

    // Shared optimistic-create path — see store.beginOptimisticSession. It tracks the
    // in-flight create so a message send can await the rekey instead of polling (a slow
    // roundtrip would otherwise blow waitForConvexId's budget → spurious "not yet created").
    // reuse: a repeated Ctrl+N lands back on the existing blank session for this
    // project+agent instead of stranding another empty conversation per press.
    const { stubId: sessionId } = store.beginOptimisticSession({
      agentType,
      projectPath: path,
      gitRoot: gitRoot || path,
      reuse: true,
      create: (stubId) => store.createSession({
        agent_type: agentType,
        project_path: path,
        git_root: gitRoot || path,
        session_id: stubId,
      }),
    });
    animateSessionEnter(sessionId);

    if (isOnInboxPage || isOnConversationPage) {
      store.setCurrentSession(sessionId);
    } else if (store.sidePanelOpen) {
      useInboxStore.setState({ sidePanelSessionId: sessionId });
    } else {
      router.push(`/conversation/${sessionId}?focus=1`);
    }
  }, [resolveNewSessionContext, router, isOnInboxPage, isOnConversationPage]);

  const handleQuickCreateIsolated = useCallback(async () => {
    const { path, gitRoot, agentType: rawAgent } = resolveNewSessionContext();
    if (!path) {
      s.openNewSession({ source: isOnInboxPage ? "inbox" : "sessions" });
      return;
    }
    soundNewSession();
    const agentType = (rawAgent || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const conversationId = await createQuickSession({
      agent_type: agentType,
      project_path: path,
      git_root: gitRoot || path,
      isolated: true,
    });
    const store = useInboxStore.getState();
    if (isOnInboxPage || isOnConversationPage) {
      store.setCurrentSession(conversationId as string);
    } else if (store.sidePanelOpen) {
      useInboxStore.setState({ sidePanelSessionId: conversationId as string });
    } else {
      router.push(`/conversation/${conversationId}?focus=1`);
    }
  }, [resolveNewSessionContext, router, isOnInboxPage, isOnConversationPage, createQuickSession, s.openNewSession]);

  // Bridge for the Electron global "New Session" shortcut / tray / dock / app
  // menu and the in-app `codecast-new-session` event. These must do exactly what
  // the in-app Ctrl+N does: create a blank session and route to it (the inline
  // project + agent picker). They must NOT pop the modal — the modal
  // (openNewSession) is reserved for explicit "pick a different directory"
  // actions like the ProjectSwitcher "other" button. handleQuickCreate is read
  // through a ref so the once-mounted bridge always calls the latest closure.
  const quickCreateRef = useRef(handleQuickCreate);
  useWatchEffect(() => {
    quickCreateRef.current = handleQuickCreate;
  }, [handleQuickCreate]);
  useMountEffect(() => {
    const open = () => quickCreateRef.current();
    (window as any).__CODECAST_NEW_SESSION = open;
    window.addEventListener('codecast-new-session', open);
    return () => {
      delete (window as any).__CODECAST_NEW_SESSION;
      window.removeEventListener('codecast-new-session', open);
    };
  });

  // Main-window receiver for the compose popup's "send & open". The popup is a
  // separate window/store, so it broadcasts the {conversationId, content, clientId}
  // of the send it already dispatched; we paint the same message optimistically
  // here so it's visible the instant we navigate onto the new conversation. The
  // shared clientId dedupes it against the server echo (no duplicate bubble), and
  // there's no send here — the popup owns delivery, so a missed broadcast just
  // falls back to the server pending_messages rail (never a lost message).
  useMountEffect(() => subscribeComposeOptimistic(({ conversationId, content, clientId }) => {
    useInboxStore.getState().addOptimisticMessage(conversationId, content, undefined, clientId);
  }));

  // Browser back/forward within the dashboard tab shell. Tab navigations push real
  // history entries (see tabNavigate); on popstate we mirror the URL back into the
  // active tab so TabContent renders the matching page. Inbox session selections
  // carry their own `{ inboxId }` history state and are reconciled by
  // QueuePageClient's popstate listener, so they're skipped here.
  useMountEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const popped = (e.state ?? {}) as { inboxId?: string; inboxView?: InboxViewSnapshot };
      // Inbox view-settings entries (label/project chips, view mode) — restore
      // the snapshot through the regular setters, guarded so they don't push
      // history again while history itself is driving them.
      if (popped.inboxView) {
        const v = popped.inboxView;
        const store = useInboxStore.getState();
        withApplyingViewHistory(() => {
          if (v.bucket !== store.activeBucketFilter || v.project !== store.activeProjectFilter) {
            if (v.bucket) store.setActiveBucketFilter(v.bucket);
            else if (v.project) store.setActiveProjectFilter(v.project, v.projectPath);
            else {
              store.setActiveBucketFilter(null);
              store.setActiveProjectFilter(null, null);
            }
          }
          if (v.mode && v.mode !== store.inboxViewMode()) store.setInboxViewMode(v.mode);
        });
      }
      if (popped.inboxId) return;
      if (isNonTabRoute(window.location.pathname)) return;
      const store = useInboxStore.getState();
      const id = store.activeTabId;
      if (!id) return;
      const full = window.location.pathname + window.location.search;
      store.updateTab(id, { path: full, title: pathLabel(full) });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  useGlobalShortcutActions();
  useShortcutContext('desktop', isDesktopApp);
  const switcherState = useSessionSwitcher();

  useShortcutAction('session.create', handleQuickCreate);

  useShortcutAction('session.createIsolated', useCallback(() => {
    handleQuickCreateIsolated();
  }, [handleQuickCreateIsolated]));

  useShortcutAction('zoom.in', useCallback(() => {
    const r = Math.round(Math.min(zoomRef.current + 0.1, 2) * 10) / 10;
    zoomRef.current = r;
    document.documentElement.style.zoom = String(r);
    requestAnimationFrame(recalcHeight);
  }, [recalcHeight]));

  useShortcutAction('zoom.out', useCallback(() => {
    const r = Math.round(Math.max(zoomRef.current - 0.1, 0.5) * 10) / 10;
    zoomRef.current = r;
    document.documentElement.style.zoom = String(r);
    requestAnimationFrame(recalcHeight);
  }, [recalcHeight]));

  useShortcutAction('zoom.reset', useCallback(() => {
    zoomRef.current = 1;
    document.documentElement.style.zoom = '1';
    requestAnimationFrame(recalcHeight);
  }, [recalcHeight]));

  // Persist user-driven resizes only. Imperative collapse fires onLayoutChange too —
  // ignore those so a collapsed sidebar doesn't stick as a 0-size layout for next mount.
  const handleLayoutChange = (newLayout: { [key: string]: number }) => {
    if ((newLayout.sidebar ?? 0) < 5) return;
    s.updateClientLayout("dashboard", { sidebar: newLayout.sidebar || 25, main: newLayout.main || 75 });
  };

  // Stable layout shell: panels stay mounted across zen/sidebar/sidePanel toggles to
  // avoid remounting ConversationView and its Convex subscriptions (which flash a
  // "Loading conversation..." state). Visibility is driven imperatively.
  const sidebarPanelRef = usePanelRef();
  const sessionListPanelRef = usePanelRef();
  const sidebarHidden = !!hideSidebar || isZenMode || sidebarCollapsed || isMobile;

  useWatchEffect(() => {
    const ref = sidebarPanelRef.current;
    if (!ref) return;
    if (sidebarHidden) {
      if (!ref.isCollapsed()) ref.collapse();
    } else {
      if (ref.isCollapsed()) ref.expand();
    }
  }, [sidebarHidden]);

  useWatchEffect(() => {
    const ref = sessionListPanelRef.current;
    if (!ref) return;
    if (showSessionList) {
      if (ref.isCollapsed()) ref.expand();
    } else {
      if (!ref.isCollapsed()) ref.collapse();
    }
  }, [showSessionList]);

  // Must be above the isGuest early return — React requires stable hook count across renders
  const conversationPanel = useMemo(() => (
    <Panel id="conversation-column" minSize="20%" maxSize="70%" defaultSize="40%">
      <ErrorBoundary name="ConversationColumn" level="panel"><ConversationColumn /></ErrorBoundary>
    </Panel>
  ), []);

  // Guest/unauthenticated: minimal layout, no top header — branding lives in the bottom bar
  if (isGuest) {
    return (
      <div className="bg-sol-bg flex flex-col overflow-hidden" style={{ height: '100vh' }}>
        <div className="flex-1 min-h-0">
          <div className="h-full">{children}</div>
        </div>
      </div>
    );
  }

  const hasTabs = s.tabs.length > 0 && !isNonTabRoute(routerLocation.pathname);
  const content = hasTabs ? <TabContent /> : children;

  const pageContent = isFullWidthPage || hasTabs ? (
    <div className="h-full">{content}</div>
  ) : (
    <div data-main-scroll className="h-full overflow-y-auto px-3 sm:px-6 lg:px-8 py-4">
      <div className="max-w-4xl mx-auto h-full">{content}</div>
    </div>
  );

  const mainContent = showConversationColumn ? (
    <Group orientation="horizontal" className="h-full" defaultLayout={{ "main-content": 60, "conversation-column": 40 }}>
      <Panel id="main-content" minSize="20%">{pageContent}</Panel>
      <Separator className={separatorClass} />
      {conversationPanel}
    </Group>
  ) : pageContent;

  // Group is always rendered; the session-list Panel collapses to 0 when not in use.
  // The collapsed rail renders alongside (outside the Group) when the panel is hidden.
  const rightArea = (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 h-full">
        <Group orientation="horizontal" className="h-full" defaultLayout={{ "right-content": showSessionList ? 70 : 100, "session-list": showSessionList ? 30 : 0 }}>
          <Panel id="right-content" minSize={400}><div className="h-full">{mainContent}</div></Panel>
          <Separator className={`${separatorClass} ${showSessionList ? "" : "invisible"}`} />
          <Panel
            id="session-list"
            panelRef={sessionListPanelRef}
            minSize={200}
            maxSize="50%"
            defaultSize={showSessionList ? 30 : 0}
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              if (size.asPercentage === 0 && showSessionList) {
                s.toggleSidePanel();
              }
            }}
          >
            {!isMobile && (
              <ErrorBoundary name="SessionList" level="panel">
                <div className="w-full h-full border-l border-sol-border/30">
                  <SessionListPanel
                    onSessionSelect={sessionListOnSelect}
                    activeSessionId={sessionListActiveId}
                    onCollapse={s.toggleSidePanel}
                  />
                </div>
              </ErrorBoundary>
            )}
          </Panel>
        </Group>
      </div>
      {showCollapsedRail && <ErrorBoundary name="SessionRail" level="inline"><CollapsedSessionRail onSelect={sessionListOnSelect} /></ErrorBoundary>}
    </div>
  );

  return (
    <div className="bg-sol-bg flex flex-col overflow-hidden" style={{ height: zoomHeight }}>
      {/* Header spans full width */}
      <header ref={headerRef} className={`flex-shrink-0 border-b border-black/10 bg-sol-bg z-[100] ${desktopClass} ${isZenMode ? "hidden" : ""} relative`}>
        {typeof window !== "undefined" && window.location.hostname.includes("local.") && (
          <div className="absolute top-0 left-0 w-0 h-0 border-t-[20px] border-r-[20px] border-t-emerald-500 border-r-transparent z-30" />
        )}
        <div className="px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-3">
          {/* Left section: Sidebar toggle + nav */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={(e) => { s.updateClientUI({ sidebar_collapsed: !sidebarCollapsed }); tipActions.whisper('sidebar.toggleLeft', e); }}
              className="hidden md:flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              title={`${sidebarCollapsed ? "Show sidebar" : "Hide sidebar"} (${formatShortcutLabel('sidebar.toggleLeft')})`}
            >
              <PanelLeft className="w-[18px] h-[18px]" />
            </button>
            {isDesktopApp && (
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => window.history.back()}
                  className="p-1.5 text-sol-text-muted hover:text-sol-text transition-colors rounded hover:bg-sol-bg-alt"
                  title="Back"
                  aria-label="Go back"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => window.history.forward()}
                  className="p-1.5 text-sol-text-muted hover:text-sol-text transition-colors rounded hover:bg-sol-bg-alt"
                  title="Forward"
                  aria-label="Go forward"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
            <ErrorBoundary name="RecentlyViewedMenu" level="inline">
              <RecentlyViewedMenu onSelectSession={sessionListOnSelect} />
            </ErrorBoundary>
            {!hideSidebar && (
              <button
                onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
                className="md:hidden p-1.5 sm:p-2 text-sol-text hover:text-sol-yellow transition-colors"
                aria-label="Toggle menu"
              >
                <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}
          </div>

          {/* Team switcher and avatars — left-aligned */}
          <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
            <ErrorBoundary name="TeamSwitcher" level="inline">
              <TeamSwitcher />
            </ErrorBoundary>
            <ErrorBoundary name="TeamAvatarBar" level="inline">
              <TeamAvatarBar />
            </ErrorBoundary>
          </div>

          {/* Center section: Search */}
          <div className="hidden sm:flex flex-1 justify-center min-w-0">
            <div className="w-full max-w-md">
              <ErrorBoundary name="GlobalSearch" level="inline">
                <GlobalSearch />
              </ErrorBoundary>
            </div>
          </div>

          <div className="hidden md:block flex-shrink-0 mx-1" style={{ width: 1, minWidth: 1, height: 20, backgroundColor: "var(--sol-text-dim)", opacity: 0.35 }} />

          {/* Right section: Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <ErrorBoundary name="DaemonStatusChip" level="inline">
              <DaemonStatusChip />
            </ErrorBoundary>
            <ErrorBoundary name="SyncStatusChip" level="inline">
              <SyncStatusChip />
            </ErrorBoundary>
            <ActiveAgentsBadge isOnInboxPage={isOnInboxPage} />
            <button
              onClick={(e) => {
                const ctx = resolveNewSessionContext();
                if (ctx.path) {
                  handleQuickCreate();
                } else {
                  s.openNewSession({ projectPath: ctx.path, gitRoot: ctx.gitRoot, agentType: ctx.agentType });
                }
                tipActions.whisper('session.create', e);
              }}
              className="hidden md:flex items-center justify-center w-7 h-7 rounded-full border border-sol-text-dim/20 bg-sol-text-dim/8 text-sol-text-dim/50 hover:bg-sol-text-dim/15 hover:text-sol-text-dim/70 hover:border-sol-text-dim/30 transition-colors"
              title={`New session (${formatShortcutLabel('session.create')})`}
            >
              <Plus className="w-[18px] h-[18px]" />
            </button>
            <ThemeToggle />
            <ErrorBoundary name="NotificationBell" level="inline">
              <NotificationBell />
            </ErrorBoundary>
            <ErrorBoundary name="UserMenu" level="inline">
              <UserMenu />
            </ErrorBoundary>
            <button
              onClick={(e) => { s.toggleSidePanel(); tipActions.whisper('sidebar.toggleRight', e); }}
              className="flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              title={`Toggle sessions panel (${formatShortcutLabel('sidebar.toggleRight')})`}
            >
              <PanelRight className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      <ErrorBoundary name="Banners" level="inline">
        <DesktopAppBanner />
        <SetupPromptBanner />
        <CliOfflineBanner />
        <TmuxMissingBanner />
      </ErrorBoundary>

      <ErrorBoundary name="TabBar" level="inline">
        <TabBar />
      </ErrorBoundary>

      {/* Content area with sidebar and main. Group is always mounted; sidebar Panel
          collapses imperatively so toggling zen/sidebar/mobile doesn't remount {rightArea}. */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <Group
            orientation="horizontal"
            className="h-full"
            defaultLayout={sidebarHidden ? { sidebar: 0, main: 100 } : layout}
            onLayoutChange={handleLayoutChange}
          >
            <Panel
              id="sidebar"
              panelRef={sidebarPanelRef}
              minSize={180}
              maxSize="50%"
              collapsible
              collapsedSize={0}
              defaultSize={sidebarHidden ? 0 : layout.sidebar}
              onResize={(size) => {
                // If the user drags below minSize, the panel collapses on its own.
                // Mirror that into store state so the effect doesn't re-expand it.
                if (size.asPercentage === 0 && !sidebarHidden) {
                  s.updateClientUI({ sidebar_collapsed: true });
                }
              }}
            >
              {!isMobile && (
                <div className="h-full bg-sol-bg-alt overflow-auto border-r border-sol-border/30">
                  <ErrorBoundary name="Sidebar" level="panel">
                    <Sidebar
                      directoryFilter={directoryFilter}
                      isMobileOpen={isMobileSidebarOpen}
                      onMobileClose={() => setIsMobileSidebarOpen(false)}
                    />
                  </ErrorBoundary>
                </div>
              )}
            </Panel>
            <Separator className={`${separatorClass} ${sidebarHidden ? "invisible" : ""}`} />
            <Panel id="main" minSize={400}>{rightArea}</Panel>
          </Group>
        </div>
        <KeyboardShortcutsPanel />
      </div>

      <ErrorBoundary name="SettingsModal" level="panel">
        <SettingsModal />
      </ErrorBoundary>

      {/* Mobile sidebar overlay */}
      {isMobileSidebarOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setIsMobileSidebarOpen(false)}
          />
          <div className="md:hidden fixed inset-y-0 left-0 z-50 w-[85vw] max-w-sm shadow-xl animate-slide-in-left">
            <ErrorBoundary name="Sidebar" level="panel">
              <Sidebar
                directoryFilter={directoryFilter}
                isMobileOpen={isMobileSidebarOpen}
                onMobileClose={() => setIsMobileSidebarOpen(false)}
              />
            </ErrorBoundary>
          </div>
        </>
      )}
      {/* Mobile session list overlay — single render point for SessionListPanel on small screens */}
      {showMobileSessionList && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={s.toggleSidePanel} />
          <div className="fixed inset-y-0 right-0 z-50 w-[80vw] max-w-xs shadow-xl animate-slide-in-right">
            <ErrorBoundary name="SessionList" level="panel">
              <SessionListPanel
                onSessionSelect={sessionListOnSelect}
                activeSessionId={sessionListActiveId}
                onCollapse={s.toggleSidePanel}
              />
            </ErrorBoundary>
          </div>
        </>
      )}
      <ErrorBoundary name="CommandPalette" level="inline">
        <CommandPalette />
      </ErrorBoundary>
      <ErrorBoundary name="FindBar" level="inline">
        <FindBar />
      </ErrorBoundary>
      <NewSessionModal isOpen={s.newSession.isOpen} onClose={s.closeNewSession} />
      {switcherState.open && (
        <SessionSwitcher
          sessions={switcherState.mruSessions}
          selectedIndex={switcherState.selectedIndex}
        />
      )}
    </div>
  );
}
