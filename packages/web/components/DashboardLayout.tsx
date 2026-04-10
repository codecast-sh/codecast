import { ReactNode, useState, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { usePathname, useRouter } from "next/navigation";
import { useMutation, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Panel, Group, Separator } from "react-resizable-panels";
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
import { Plus, PanelLeft, PanelRight } from "lucide-react";
import { nanoid } from "nanoid";
import { SetupPromptBanner } from "./SetupPromptBanner";
import { DesktopAppBanner } from "./DesktopAppBanner";
import { CliOfflineBanner } from "./CliOfflineBanner";
import { TmuxMissingBanner } from "./TmuxMissingBanner";
import { FindBar } from "./FindBar";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsHelp";
import { NewSessionModal } from "./ConversationList";
import { CreatePalette } from "./CreatePalette";
import { useInboxStore, useTrackedStore, isSessionEffectivelyIdle } from "../store/inboxStore";
import { useShortcutAction, useShortcutContext, useGlobalShortcutActions, formatShortcutLabel } from "../shortcuts";
import { usePrefetch } from "../hooks/usePrefetch";
import { desktopHeaderClass, setupDesktopDrag, isElectron } from "../lib/desktop";
import { CollapsedSessionRail, SessionListPanel, ConversationColumn } from "./GlobalSessionPanel";
import { useSyncInboxSessions } from "../hooks/useSyncInboxSessions";
import { useSyncDocs } from "../hooks/useSyncDocs";
import { isInboxSessionView } from "../lib/inboxRouting";
import { useSessionSwitcher } from "../hooks/useSessionSwitcher";
import { SessionSwitcher } from "./SessionSwitcher";
import { TabBar } from "./TabBar";
import { TabPanes } from "./TabPanes";
import { useTipActions } from "../tips";

interface DashboardLayoutProps {
  children: ReactNode;
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
  hideSidebar?: boolean;
}

const DEFAULT_LAYOUT = { sidebar: 25, main: 75 };
const separatorClass = "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

// When rendered inside TabPanes, nested DashboardLayouts become pass-through
const DashboardLayoutNestingCtx = createContext(false);

export function DashboardLayout(props: DashboardLayoutProps) {
  const isNested = useContext(DashboardLayoutNestingCtx);
  if (isNested) return <>{props.children}</>;
  return (
    <DashboardLayoutNestingCtx.Provider value={true}>
      <DashboardLayoutInner {...props} />
    </DashboardLayoutNestingCtx.Provider>
  );
}

function DashboardLayoutInner({ children, filter, onFilterChange, directoryFilter, onDirectoryFilterChange, hideSidebar }: DashboardLayoutProps) {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const isGuest = !isAuthenticated && !isAuthLoading;
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const s = useTrackedStore([
    s => s.clientState.ui?.zen_mode,
    s => s.clientState.ui?.sidebar_collapsed,
    s => s.clientState.layouts?.dashboard,
    s => s.currentConversation?.source,
    s => s.sidePanelOpen,
    s => s.sidePanelSessionId,
    s => s.sessions,
    s => s.currentSessionId,
    s => s.viewingDismissedId,
    s => s.newSession.isOpen,
    s => s.tabs.length,
  ]);
  const isZenMode = s.clientState.ui?.zen_mode ?? false;
  const sidebarCollapsed = s.clientState.ui?.sidebar_collapsed ?? false;
  const rawLayout = s.clientState.layouts?.dashboard ?? DEFAULT_LAYOUT;
  const layout = {
    sidebar: Math.max(10, Math.min(50, rawLayout.sidebar ?? 25)),
    main: Math.max(30, Math.min(90, rawLayout.main ?? 75)),
  };
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();
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
  useSyncInboxSessions();
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
  const isOnPlansPage = pathname === "/plans" || (pathname?.startsWith("/plans/") ?? false);
  const isOnDocsPage = pathname === "/docs" || (pathname?.startsWith("/docs/") ?? false);
  const isOnProjectsPage = pathname === "/projects" || (pathname?.startsWith("/projects/") ?? false);
  const isOnWindowsPage = pathname === "/windows";
  const isFullWidthPage = isOnConversationPage || isOnCommitPage || isOnPRPage || isOnInboxPage || isOnTasksPage || isOnWorkflowsPage || isOnPlansPage || isOnDocsPage || isOnProjectsPage || isOnWindowsPage;

  const activeAgentCount = useMemo(() => {
    return Object.values(s.sessions).filter(
      (sess) => !isSessionEffectivelyIdle(sess) && sess.message_count > 0
    ).length;
  }, [s.sessions]);

  const showCollapsedRail = !s.sidePanelOpen && !isMobile;
  const showSessionList = s.sidePanelOpen && !isMobile;
  const showConversationColumn = !!s.sidePanelSessionId && !isOnInboxPage && !isOnConversationPage && !isMobile;

  // Clean up stale panel state after navigating to a full conversation page.
  // The panel is already hidden by !isOnConversationPage — this just prevents
  // it from reappearing when navigating away later.
  useWatchEffect(() => {
    if (isOnConversationPage && s.sidePanelSessionId) {
      s.closeSidePanel();
    }
  }, [isOnConversationPage, s.sidePanelSessionId]);

  const handleInboxSessionSelect = useCallback((id: string) => {
    const store = useInboxStore.getState();
    if (store.sessions[id]) {
      store.setCurrentSession(id);
      if (store.showMySessions) store.setShowMySessions(false);
    } else if (store.dismissedSessions[id]) {
      store.setViewingDismissedId(id);
      if (store.showMySessions) store.setShowMySessions(false);
    } else {
      useInboxStore.setState({ pendingNavigateId: id, showMySessions: false });
    }
  }, []);

  const handleInboxForkSelect = useCallback((forkId: string, parentId: string, _parentMessageUuid: string) => {
    const store = useInboxStore.getState();
    store.setPendingForkActivation(forkId);
    store.setActiveForkHighlight(forkId);
    store.setCurrentSession(parentId);
    if (store.showMySessions) store.setShowMySessions(false);
  }, []);

  const handleConversationForkSelect = useCallback((forkId: string, parentId: string, _parentMessageUuid: string) => {
    const store = useInboxStore.getState();
    store.setPendingForkActivation(forkId);
    store.setActiveForkHighlight(forkId);
    if (isOnConversationPage) {
      // Navigate so both owner and non-owner views update
      router.push(`/conversation/${parentId}`);
    } else {
      store.setCurrentSession(parentId);
      if (store.showMySessions) store.setShowMySessions(false);
    }
  }, [router, isOnConversationPage]);

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

  // Conversation pages use URL navigation so both owner (QueuePageClient) and
  // non-owner (ViewerView) views update correctly on sidebar clicks.
  const handleConversationSessionSelect = useCallback((id: string) => {
    router.push(`/conversation/${id}`);
  }, [router]);

  const sessionListOnSelect = isOnInboxPage
    ? handleInboxSessionSelect
    : isOnConversationPage
    ? handleConversationSessionSelect
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
    const wasConvPage = prev.includes("/conversation/");
    const isNowConvPage = pathname?.includes("/conversation/");
    if (wasConvPage && !isNowConvPage) {
      const sessionId = prev.split("/conversation/")[1]?.split("?")[0];
      if (sessionId) {
        useInboxStore.getState().openSidePanel(sessionId);
      }
    }
    // Arriving at a conversation page (from notification, link, etc.) — open side panel
    if (isNowConvPage && !isOnInboxPage) {
      const sessionId = pathname?.split("/conversation/")[1]?.split("?")[0];
      if (sessionId) {
        useInboxStore.getState().openSidePanel(sessionId);
      }
    }
  }, [pathname, isOnInboxPage]);

  const resolveNewSessionContext = useCallback(() => {
    const store = useInboxStore.getState();
    const ctx = store.currentConversation;
    if (directoryFilter) {
      return { path: directoryFilter, gitRoot: ctx.gitRoot || directoryFilter, agentType: ctx.agentType };
    }
    // Clone parameters from the currently viewed session
    if (ctx.projectPath) {
      return { path: ctx.projectPath, gitRoot: ctx.gitRoot || ctx.projectPath, agentType: ctx.agentType };
    }
    // Fallback: look up the inbox-selected session directly
    const liveId = (store.sidePanelOpen && store.sidePanelSessionId) || store.currentSessionId;
    const liveSess = liveId
      ? (store.sessions[liveId] ?? store.dismissedSessions[liveId] ?? store.conversations[liveId])
      : null;
    if (liveSess?.project_path) {
      return { path: liveSess.project_path, gitRoot: liveSess.git_root || liveSess.project_path, agentType: liveSess.agent_type };
    }
    return { path: ctx.gitRoot, gitRoot: ctx.gitRoot, agentType: ctx.agentType };
  }, [directoryFilter]);

  const handleQuickCreate = useCallback(() => {
    const store = useInboxStore.getState();
    if (!isOnInboxPage && store.showMySessions) store.setShowMySessions(false);
    soundNewSession();
    const { path, gitRoot, agentType: rawAgent } = resolveNewSessionContext();
    const agentType = (rawAgent || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const sessionId = nanoid(10);
    const now = Date.now();

    store.syncRecord("conversations", sessionId, {
      _id: sessionId, _creationTime: now, user_id: "", agent_type: agentType,
      session_id: sessionId, project_path: path, git_root: gitRoot || path,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [],
    });
    store.createSession({
      agent_type: agentType,
      project_path: path,
      git_root: gitRoot || path,
      session_id: sessionId,
    }).then((convexId: string) => {
      if (convexId) useInboxStore.getState().resolveSessionId(sessionId, convexId);
    }).catch(() => {});

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

  const handleLayoutChange = (newLayout: { [key: string]: number }) => {
    s.updateClientLayout("dashboard", { sidebar: newLayout.sidebar || 25, main: newLayout.main || 75 });
  };

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

  const hasTabs = s.tabs.length > 0;
  const content = hasTabs ? <TabPanes /> : children;

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

  const rightArea = showSessionList ? (
    <Group orientation="horizontal" className="h-full" defaultLayout={{ "right-content": 70, "session-list": 30 }}>
      <Panel id="right-content" minSize={400}><div className="h-full">{mainContent}</div></Panel>
      <Separator className={separatorClass} />
      <Panel id="session-list" minSize={200} maxSize="50%" defaultSize="30%">
        <ErrorBoundary name="SessionList" level="panel">
          <div className="w-full h-full border-l border-sol-border/30">
            <SessionListPanel
              onSessionSelect={sessionListOnSelect}
              onForkSelect={isOnInboxPage ? handleInboxForkSelect : handleConversationForkSelect}
              activeSessionId={sessionListActiveId}
              onCollapse={s.toggleSidePanel}
            />
          </div>
        </ErrorBoundary>
      </Panel>
    </Group>
  ) : (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 h-full">{mainContent}</div>
      {showCollapsedRail && <ErrorBoundary name="SessionRail" level="inline"><CollapsedSessionRail /></ErrorBoundary>}
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

          {/* Center section: Search */}
          <div className="hidden sm:flex flex-1 justify-center min-w-0">
            <div className="w-full max-w-md">
              <ErrorBoundary name="GlobalSearch" level="inline">
                <GlobalSearch />
              </ErrorBoundary>
            </div>
          </div>

          {/* Team switcher and avatars */}
          <div className="hidden sm:flex items-center gap-2">
            <ErrorBoundary name="TeamSwitcher" level="inline">
              <TeamSwitcher />
            </ErrorBoundary>
            <ErrorBoundary name="TeamAvatarBar" level="inline">
              <TeamAvatarBar />
            </ErrorBoundary>
          </div>

          <div className="hidden md:block flex-shrink-0 mx-1" style={{ width: 1, minWidth: 1, height: 20, backgroundColor: "var(--sol-text-dim)", opacity: 0.35 }} />

          {/* Right section: Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            {activeAgentCount > 0 && (
              <button
                onClick={() => {
                  if (!s.sidePanelOpen) s.toggleSidePanel();
                  // Select first working session so the list scrolls to it
                  const store = useInboxStore.getState();
                  const firstWorking = Object.values(store.sessions).find(
                    (s) => !isSessionEffectivelyIdle(s) && s.message_count > 0
                  );
                  if (firstWorking) {
                    if (isOnInboxPage) {
                      store.setCurrentSession(firstWorking._id);
                    } else {
                      store.selectPanelSession(firstWorking._id);
                    }
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
            )}
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
              className="hidden md:flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
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

      {/* Content area with sidebar and main */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          {hideSidebar || isZenMode || sidebarCollapsed || isMobile ? (
            <div className="h-full">{rightArea}</div>
          ) : (
            <Group
              orientation="horizontal"
              className="h-full"
              defaultLayout={layout}
              onLayoutChange={handleLayoutChange}
            >
              <Panel id="sidebar" minSize={180} maxSize="50%" collapsible collapsedSize={0}>
                <div className="h-full bg-sol-bg-alt overflow-auto">
                  <ErrorBoundary name="Sidebar" level="panel">
                    <Sidebar
                      filter={filter}
                      onFilterChange={onFilterChange}
                      directoryFilter={directoryFilter}
                      onDirectoryFilterChange={onDirectoryFilterChange}
                      isMobileOpen={isMobileSidebarOpen}
                      onMobileClose={() => setIsMobileSidebarOpen(false)}
                    />
                  </ErrorBoundary>
                </div>
              </Panel>
              <Separator className={separatorClass} />
              <Panel id="main" minSize={400}>{rightArea}</Panel>
            </Group>
          )}
        </div>
        <KeyboardShortcutsPanel />
      </div>

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
                filter={filter}
                onFilterChange={onFilterChange}
                directoryFilter={directoryFilter}
                onDirectoryFilterChange={onDirectoryFilterChange}
                isMobileOpen={isMobileSidebarOpen}
                onMobileClose={() => setIsMobileSidebarOpen(false)}
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
      <ErrorBoundary name="CreatePalette" level="inline">
        <CreatePalette />
      </ErrorBoundary>
      {switcherState.open && (
        <SessionSwitcher
          sessions={switcherState.mruSessions}
          selectedIndex={switcherState.selectedIndex}
        />
      )}
    </div>
  );
}
