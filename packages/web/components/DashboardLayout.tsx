import { ReactNode, useState, useCallback, useRef, useMemo, memo, createContext, useContext } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useDragGatedLayoutPersist } from "../hooks/useDragGatedLayoutPersist";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { installOpenIntent, detachCurrentView } from "../lib/openIntent";
import { usePathname, useRouter } from "next/navigation";
import { useLocation } from "react-router";
import { isNonTabRoute } from "../src/compat/tabRouting";
import { withApplyingViewHistory, sameBucketExtras, type InboxViewSnapshot } from "../lib/inboxViewHistory";
import { RecentlyViewedMenu } from "./RecentlyViewedMenu";
import { useMutation, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { GlobalSearch } from "./GlobalSearch";
import { CommandPalette } from "./CommandPalette";
import { ComposeView } from "./ComposeView";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { TeamAvatarBar } from "./TeamAvatarBar";
import { TeamSwitcher } from "./TeamSwitcher";
import { ErrorBoundary } from "./ErrorBoundary";
import { subscribeComposeOptimistic } from "../lib/composeBridge";
import { NEW_SESSION_EVENT } from "../lib/utils";
import { Plus, PanelLeft, PanelRight, MessageSquare, SquareTerminal } from "lucide-react";
import { SetupPromptBanner } from "./SetupPromptBanner";
import { TriageBar } from "./triage/TriageBar";
import { TriageNuxGate } from "./triage/TriageNux";
import { NewSnippetsBanner } from "./NewSnippetsBanner";
import { DesktopAppBanner } from "./DesktopAppBanner";
import { CliOfflineBanner } from "./CliOfflineBanner";
import { NotificationNudgeBanner } from "./NotificationNudgeBanner";
import { DeviceSetupDialog } from "./permissions/DeviceSetupDialog";
import { ConnectionBanner } from "./ConnectionBanner";
import { StorageHealthBanner } from "./StorageHealthBanner";
import { DaemonStatusChip } from "./DaemonStatusChip";
import { AccountUsageChip } from "./AccountUsageChip";
import { AnchorChip, AnchorPanel } from "./anchor/AnchorPanel";
import { useSyncAnchors } from "../hooks/useSyncAnchors";
import { useIsSyncHost, useSyncReplication } from "../hooks/useSyncRole";
import { SyncStatusChip } from "./SyncStatusChip";
import { TmuxMissingBanner } from "./TmuxMissingBanner";
import { FindBar } from "./FindBar";
import { KeyboardShortcutsPanel, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { AppLoader } from "./AppLoader";
import { SettingsModal } from "./settings/SettingsModal";
import { PeopleWallModal } from "./people/PeopleWallModal";
import { useInboxStore, useTrackedStore, sessionsWakeSig, pendingSendWakeSig, getProjectName, resolveShowOld, selectSessionRailOpen, selectCommentRailOpen, selectSessionRailUserClosed, selectNavCollapsed, bucketProjectPath, placeInboxRows } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { pathOnMyMachines } from "../lib/machinePicker";
import { liveMachineRoster } from "../hooks/useSyncDevices";
import { useShortcutAction, useShortcutContext, useGlobalShortcutActions } from "../shortcuts";
import { usePrefetch } from "../hooks/usePrefetch";
import { desktopHeaderClass, setupDesktopDrag, isElectron, isDetachedTabWindow } from "../lib/desktop";
import { SessionListPanel } from "./GlobalSessionPanel";
import { FilePathMenuHost } from "./FilePathMenuHost";
import { EdgePeek } from "./EdgePeek";
import { useSyncCore } from "../hooks/useSyncCore";
import { useChatChannelsSync, useChatUnread } from "../hooks/useChatSync";
import { useThreadUnreadSync } from "../hooks/useThreadsSync";
import { useChatToasts } from "../hooks/useChatToasts";
import { useCallSync } from "../hooks/useCallSync";
import { useRecorderSync } from "../hooks/useRecorder";
import { useWalkieSync } from "../hooks/useWalkieSync";
import { useCallRing } from "../hooks/useCallRing";
import { CallDock } from "./calls/CallDock";
import { RecordingPill } from "./calls/RecordingPill";
import { ElsewhereCallPill } from "./calls/ElsewhereCallPill";
import { leaveCall } from "../lib/calls/callManager";
import { useSyncDocs, useSyncMentionDocs } from "../hooks/useSyncDocs";
import { useSyncMentionPlans } from "../hooks/useSyncPlans";
import { useSyncMentionTasks } from "../hooks/useSyncTasks";
import { isInboxSessionView, sessionFocusKind } from "../lib/inboxRouting";
import { useOpenSession } from "../hooks/useOpenSession";
import { useRecentSwitcher } from "../hooks/useRecentSwitcher";
import { RecentSwitcher } from "./RecentSwitcher";
import { TabBar, AttachTabButton } from "./TabBar";
import { tabTitle } from "../lib/tabTitle";
import { pathLabel } from "../lib/pathLabel";
import { TabContent } from "./TabContent";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { TerminalDock } from "./terminal/TerminalDock";
import { VaultQuickSwitcherDock } from "./vault/VaultQuickSwitcherDock";
import { isFullWidthRoute, PageShell } from "../lib/pageLayout";
import { useTipActions } from "../tips";
import { GlobalCloseGuardDialog } from "./CloseGuardDialog";

interface DashboardLayoutProps {
  children: ReactNode;
  hideSidebar?: boolean;
  // Public conversation links have no principal cache to hydrate. The shell
  // opts them into the chrome-less guest branch once auth has settled.
  allowUnhydratedGuest?: boolean;
}

const DEFAULT_LAYOUT = { sidebar: 25, main: 75 };
// One handle for every split in the app (see .cc-split in globals.css).
const separatorClass = "cc-split";

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
  const openSession = useOpenSession();
  const s = useTrackedStore([
    // Wake on STRUCTURAL change (bucket/order/identity), never on the ~1s
    // liveness heartbeat: the raw s.sessions ref flips on every tick, and this
    // badge was measured re-running the whole classification over the
    // never-prune cache ~3x/sec at ~50ms a pass. The body still reads
    // s.sessions for data; these signatures only gate the re-render. Same for
    // pendingMessages — only the pending-send MEMBERSHIP matters here.
    // See store/wakeSig.ts and the identical gate on SessionListPanel.
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.blockedReviveRequestedAt,
    s => pendingSendWakeSig(s.pendingMessages),
    s => s.currentUser?._id,
    s => resolveShowOld(s.clientState.ui),
  ]);
  // The chokepoint's time-driven flips (trust TTL, revive expiry, the epoch)
  // ride its deadline signature — keep them alive with a coarse clock, exactly
  // like SessionListPanel (see useCoarseNow / store/wakeSig.ts).
  const coarseNow = useCoarseNow(15_000);
  // Ambient "active agents" count stays MINE-scoped regardless of inbox scope: a
  // teammate row can linger in the shared cache after a team-board visit, but the
  // dock badge counts YOUR working sessions, not the team's. The placement
  // chokepoint (placeInboxRows, sync-convergence C5) forced to "mine" runs the
  // scope filter and the shared working-set selection internally, so a stale
  // "working" card outside it can never inflate the badge.
  const meId = s.currentUser?._id?.toString?.() ?? null;
  // Deps are the wake signatures (memoized by ref — free to re-call here), not
  // the raw s.sessions/s.pendingMessages refs those flip on every heartbeat.
  const working = useMemo(
    () => placeInboxRows(s, { scope: "mine", now: coarseNow }).working,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), resolveShowOld(s.clientState.ui), coarseNow],
  );
  if (working.length === 0) return null;
  const activeAgentCount = working.length;
  return (
    <button
      onClick={() => {
        const store = useInboxStore.getState();
        if (!selectSessionRailOpen(store)) store.toggleSidePanel();
        if (working[0]) openSession(working[0]._id);
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

const noop = () => {};

export function DashboardLayout(props: DashboardLayoutProps) {
  const isNested = useContext(DashboardNestCtx);
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  // Hold the boot loader until the IDB hydration pass lands (clientStateInitialized
  // flips true even when the cache is empty or unreadable, so this can't hang).
  // Without it, React's first frame races loadCache(): the shell mounts on an
  // empty store and paints zero-session null states ("No sessions") for a beat
  // before cached content pops in. AppLoader is pixel-identical to the static
  // #boot-shell in index.html, so the user sees one continuous loader → content.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const isSettledGuest = props.allowUnhydratedGuest &&
    !isAuthenticated && !isAuthLoading;
  if (isNested) return <>{props.children}</>;
  // A settled anonymous share viewer intentionally has no principal store, so
  // `clientStateInitialized` will remain false forever. Let only that explicit
  // route reach DashboardLayoutInner's read-only guest branch.
  if (!hydrated && !isSettledGuest) return <AppLoader />;
  return (
    <DashboardNestCtx.Provider value={true}>
      <DashboardLayoutInner {...props} />
    </DashboardNestCtx.Provider>
  );
}

// Eager background-sync hooks isolated into their own component so a failing
// Convex query (e.g. an OOMing list query) throws HERE and is caught by the
// inline <ErrorBoundary> that wraps this in DashboardLayoutInner — degrading to
// "this data didn't prefetch" instead of taking down the entire dashboard.
// None of these power the core shell/conversation view; they warm stores.
// The global feeder set — everything that subscribes workspace-wide server
// data into the store. Mounted only while this window is the sync host (or its
// own solo host); a follower window receives the same slice over replication
// instead (store/syncReplication.ts), so mounting these there would only
// duplicate every subscription.
function HostFeeders() {
  // The tasks delta cursor machine: its empty deltas re-rendered the whole
  // layout when it lived in DashboardLayoutInner.
  usePrefetch();
  useSyncDocs();
  useSyncMentionTasks();
  useSyncMentionDocs();
  useSyncMentionPlans();
  // THE feeder mount set (useSyncCore, sync-convergence C5): live window,
  // liveness overlay, recovery probes, team feeders, sync-log applier, the
  // decision queue and labels — one hook both platforms mount, so web and
  // mobile replicas are fed identically.
  useSyncCore("web");
  // Chat's channel rail runs app-wide, not on the chat page: the sidebar badge,
  // the document title and the arrival toasts all read it, and a toast that only
  // fires while chat is open is a toast nobody needs.
  useChatChannelsSync();
  // The Threads badge: one scalar, every workspace, not chat-gated — comment
  // and task threads exist whether or not the team has chat on.
  useThreadUnreadSync();
  // The anchors collection feeds the header chip, the slide-over, the inbox's
  // anchor marks and chat's DM naming — one subscription for the whole shell.
  useSyncAnchors();
  return null;
}

function DashboardSyncEffects() {
  // Cross-window replication: elect a sync host, follow one, or run solo.
  // Everything below the feeder gate still runs in every window — toasts,
  // calls and badges READ the store, which replication keeps fed.
  useSyncReplication(true);
  const isSyncHost = useIsSyncHost();
  useChatToasts();
  useChatTitleBadge();
  // Huddles: config/ring/occupancy sync + the incoming-ring pipeline, both
  // app-wide for the same reason as chat toasts — a ring must reach someone
  // who is NOT looking at the team strip.
  useCallSync();
  useCallRing();
  // Push-to-talk's receiving half: a teammate's live burst has to reach someone
  // whose DM is closed, which is exactly why this is not on the chat page.
  useWalkieSync();
  // The recorder's Convex client. The record button and the pill live on
  // different pages, so neither of them can be what binds the engine.
  useRecorderSync();
  return isSyncHost ? <HostFeeders /> : null;
}

// Unread mentions in the browser tab title.
//
// Only mentions. An unread COUNT in the title turns every busy afternoon into a
// number that never reaches zero, and a title that always shouts is a title
// nobody reads. Being named is the one thing worth interrupting a different app
// for, which is exactly what a tab title does.
function useChatTitleBadge() {
  const { mentions } = useChatUnread();
  // The conversation view writes the title too (its own "codecast | <session>"),
  // so the badge is re-asserted on a slow tick rather than only when the count
  // changes — otherwise opening a session silently drops it.
  const tick = useCoarseNow(5_000);
  useWatchEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    const next = mentions > 0 ? `(${mentions}) ${base}` : base;
    if (document.title !== next) document.title = next;
  }, [mentions, tick]);
  return null;
}

// Detached tab window OS title: lead with the surface, then the specific thing
// — "Codecast Chat | design", "Codecast Inbox | Fix the auth race" — so
// alt-tab and the window list name each window by what it shows. Only detached
// windows: the main window keeps its own title writers (ConversationView, the
// mention badge above).
function useDetachedWindowTitle(path: string) {
  const detached = isDetachedTabWindow();
  const title = useInboxStore((s) => {
    if (!detached) return null;
    const label = pathLabel(path);
    // An inbox window titles by the session it is SHOWING (the store pointer);
    // the URL's ?s= deep link is the fallback inside tabTitle.
    const inboxish = path.startsWith("/inbox") || path.startsWith("/conversation");
    const sessionId = inboxish ? s.currentSessionId ?? undefined : undefined;
    const rest = tabTitle({ id: "detached", path, sessionId, title: "", createdAt: 0 }, s.sessions, s.chatChannels);
    return rest && rest !== label ? `Codecast ${label} | ${rest}` : `Codecast ${label}`;
  });
  useWatchEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

function DashboardLayoutInner({ children, hideSidebar }: DashboardLayoutProps) {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const isGuest = !isAuthenticated && !isAuthLoading;
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // Stable handles: an inline lambda here re-rendered the (235-hook) Sidebar on
  // every layout render.
  const closeMobileSidebar = useCallback(() => setIsMobileSidebarOpen(false), []);
  // ComposeView's guarded close (draft keep/discard confirm) — the compose
  // backdrop below routes clicks through it. Null until the popup mounts.
  const composeCloseGuardRef = useRef<(() => void) | null>(null);
  const s = useTrackedStore([
    s => s.clientStateInitialized,
    s => s.clientState.ui?.zen_mode,
    s => selectNavCollapsed(s),
    s => s.clientState.layouts?.dashboard,
    // Slot sizes: a workbench switch rewrites these, and the panels below
    // apply them imperatively.
    s => s.workspace.nav.size,
    s => s.workspace.context.size,
    s => s.workspace.context.pane?.kind,
    s => s.currentConversation?.source,
    s => selectSessionRailOpen(s),
    s => s.sidePanelSessionId,
    s => s.currentSessionId,
    s => s.viewingDismissedId,
    s => selectCommentRailOpen(s),
    s => s.clientState.ui?.comments_enabled ?? false,
    s => s.clientState.ui?.simple_view === true,
    // Re-render the header toggle when comments change, so a teammate's comment on
    // the viewed conversation surfaces the toggle even with the tools off. Subscribe
    // to the comments map REF (O(1) Object.is compare), not a full scan: comments is
    // low-churn (heartbeats never touch it, so the ref is stable between comment
    // syncs), and the actual "does the viewed conversation have comments" boolean is
    // derived below off the same ref. Scanning all comments here re-ran on every ~1s
    // store heartbeat notification app-wide. The viewed conversation id is already a
    // dep (currentSessionId / viewingDismissedId above).
    s => s.comments,
    s => s.compose.open,
    s => s.compose.nonce,
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
  const sidebarCollapsed = selectNavCollapsed(s);
  // The nav slot owns the sidebar's width (so a workbench restores it with the
  // rest of the chrome); the legacy layouts.dashboard value seeds it once for
  // users whose width predates the slot taking ownership.
  const rawLayout = s.clientState.layouts?.dashboard ?? DEFAULT_LAYOUT;
  const navSize = s.workspace.nav.size ?? rawLayout.sidebar ?? 25;
  const layout = {
    sidebar: Math.max(10, Math.min(50, navSize)),
    main: Math.max(30, Math.min(90, 100 - navSize)),
  };
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();
  // The real browser URL from react-router. `pathname` (usePathname compat) can
  // report the active in-app tab's route instead — e.g. on Settings it returns a
  // carried "/inbox" tab — so use this when we need to know the page that's
  // actually mounted, not the tab the user last worked in.
  const routerLocation = useLocation();
  const router = useRouter();
  useDetachedWindowTitle(routerLocation.pathname + routerLocation.search);

  const [desktopClass, setDesktopClass] = useState("");
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  const [zoomHeight, setZoomHeight] = useState("100vh");
  const zoomRef = useRef(1);
  const headerRef = useRef<HTMLElement>(null);
  const prevWasInboxRef = useRef(false);
  const prevPathnameRef = useRef(pathname);
  const tipActions = useTipActions();

  const recalcHeight = useCallback(() => {
    if (typeof window === 'undefined') return;
    const z = zoomRef.current;
    setZoomHeight(z === 1 ? '100vh' : `calc(100vh / ${z})`);
  }, []);

  useMountEffect(() => {
    setDesktopClass(desktopHeaderClass());
    setIsDesktopApp(isElectron());
    recalcHeight();
    const timer = setTimeout(() => { setDesktopClass(desktopHeaderClass()); setIsDesktopApp(isElectron()); }, 500);
    return () => clearTimeout(timer);
  });

  useEventListener('resize', recalcHeight);

  // Desktop: Cmd-click / middle-click on any in-app object opens it in a
  // background tab; Cmd-Shift-click in a detached window (lib/openIntent). One
  // listener for the whole shell — every link and row already routes through
  // the chokepoints it diverts. A no-op on the web (browser keeps Cmd-click).
  useMountEffect(() => installOpenIntent());

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
  const isOnTriggersPage = pathname === "/triggers" || (pathname?.startsWith("/triggers/") ?? false);
  // /schedules = pre-rename alias for /triggers, kept for old links.
  const isOnSchedulesPage = pathname === "/schedules" || (pathname?.startsWith("/schedules/") ?? false);
  const isOnPlansPage = pathname === "/plans" || (pathname?.startsWith("/plans/") ?? false);
  const isOnCallsPage = pathname === "/calls" || (pathname?.startsWith("/calls/") ?? false);
  const isOnDocsPage = pathname === "/docs" || (pathname?.startsWith("/docs/") ?? false);
  const isOnCapabilitiesPage = pathname === "/capabilities";
  const isOnFilesPage = pathname === "/files" || (pathname?.startsWith("/files/") ?? false);
  // /vault = pre-rename alias for /files. Kept as its own flag rather than
  // folded into the one above because the routes.manifest parity test reads the
  // FIRST path literal of each isOn* as that flag's base — one flag naming two
  // bases would leave /vault's full-width claim unguarded.
  const isOnVaultPage = pathname === "/vault" || (pathname?.startsWith("/vault/") ?? false);
  const isOnProjectsPage = pathname === "/projects" || (pathname?.startsWith("/projects/") ?? false);
  const isOnWindowsPage = pathname === "/windows";
  const isOnCrosstalkPage = pathname === "/crosstalk";
  // Settings is a modal-like surface, not a working surface — selecting a session
  // there means "I'm done configuring, take me to it", not "peek beside". Keyed off
  // the real router URL because `pathname` lies here (returns the carried tab route).
  const isOnSettingsPage = routerLocation.pathname.startsWith("/settings");
  // isFullWidthRoute folds in the self-contained full-bleed pages (sessions,
  // admin) so the non-tab path matches the tab shell; the inbox check stays
  // explicit because it is source-aware, not just path-based.
  const isFullWidthPage = isOnConversationPage || isOnCommitPage || isOnPRPage || isOnInboxPage || isOnTasksPage || isOnWorkflowsPage || isOnRoutinesPage || isOnTriggersPage || isOnSchedulesPage || isOnPlansPage || isOnCallsPage || isOnDocsPage || isOnCapabilitiesPage || isOnFilesPage || isOnVaultPage || isOnProjectsPage || isOnWindowsPage || isOnCrosstalkPage || isFullWidthRoute(pathname ?? "");

  // The teammate comment rail is a conversation-scoped overlay, so its header
  // toggle only makes sense when a conversation is actually on screen.
  const isViewingConversation = isOnConversationPage || (isOnInboxPage && !!(s.currentSessionId || s.viewingDismissedId));
  const commentRailOpen = selectCommentRailOpen(s);
  // The comment tools are opt-in (off by default), but a conversation that already
  // has comments still surfaces the toggle so you can open it to read + reply.
  const commentsEnabled = s.clientState.ui?.comments_enabled ?? false;
  const viewedConvIds = [s.currentSessionId, s.viewingDismissedId].filter(Boolean) as string[];
  // Conversation ids that carry at least one comment, indexed once per comments-map
  // change (not per render) so the toggle check below is an O(1) Set lookup.
  const commentedConvIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of Object.values(s.comments) as { conversation_id?: string }[]) {
      if (c.conversation_id) set.add(c.conversation_id);
    }
    return set;
  }, [s.comments]);
  const convHasComments = viewedConvIds.some((id) => commentedConvIds.has(id));
  const showCommentsToggle = isViewingConversation && (commentsEnabled || convHasComments);


  // The rail is ONLY ever the session list — a conversation never renders
  // inside it (clicking a session promotes it to the stage instead; see
  // resolveSessionSelectKind). sidePanelSessionId survives purely as the
  // rail's highlight pointer.
  const railOpen = selectSessionRailOpen(s);
  // The only /settings URLs that reach this layout are the focused flow
  // pages (create team, join team, link GitHub) — section URLs bounce into
  // the modal before rendering here. Those flows are the one thing on
  // screen, so the session rail stays out of them on every size: on a phone
  // it would overlay the whole flow on arrival, on desktop it stacks
  // unrelated inbox cards beside a focused step and pushes the centered
  // shell off axis. The persisted rail choice still applies everywhere else.
  const showSessionList = railOpen && !isMobile && !isOnSettingsPage;
  const showMobileSessionList = railOpen && isMobile && !isOnSettingsPage;
  // Right session list, collapsed: no persistent rail — a right-edge hover-peek
  // slides the full list out, mirroring the left sidebar's collapsed behavior.
  // Never in zen mode (same rule as the left peek): zen means nothing slides in.
  // Keyed to showSessionList, not railOpen, so the flow pages that suppress
  // the rail still reach the list through the edge peek.
  const rightPeekEnabled = !showSessionList && !isMobile && !isZenMode;

  // No route carries a conversation along as a second column any more: the
  // page takes the full stage, and side by side is the tab's split layout,
  // entered by a deliberate drag onto the stage (components/stage).

  // On conversation pages, derive active ID from the URL so non-owner viewers
  // (ViewerView) get correct sidebar highlighting — they don't set currentSessionId.
  const conversationPageId = isOnConversationPage && pathname
    ? pathname.replace('/conversation/', '').split(/[/?#]/)[0]
    : null;

  // Which pointer the rail highlights comes from the shared helper, so
  // whatever MOVES this highlight (the workbench filter's eviction) reads the
  // same answer.
  const focusKind = sessionFocusKind(pathname, s.currentConversation?.source);
  const sessionListActiveId = focusKind === "current"
    ? (s.viewingDismissedId ?? s.currentSessionId)
    : focusKind === "url"
    ? (conversationPageId ?? s.currentSessionId)
    : s.sidePanelSessionId;

  // The one select-kind-aware open path (hooks/useOpenSession): in place on
  // the inbox, leave for the inbox from every other surface. Shared with the
  // Ctrl+Tab switcher and the Ctrl+I/Ctrl+P jump shortcuts.
  const sessionListOnSelect = useOpenSession();

  useMountEffect(() => {
    setIsMobile(window.innerWidth < 768);
  });

  useEventListener("resize", () => {
    setIsMobile(window.innerWidth < 768);
  });

  // The route-default effects below adjust the rail when you NAVIGATE between
  // surfaces. A tab switch also changes `pathname` (it reports the active
  // tab's path), but revealing an already-open tab is not navigation — the
  // frame must stay pixel-identical — so each effect stands down when the
  // pathname change arrived with a tab switch. The ref is updated in a
  // separate effect declared AFTER the consumers: effects run in declaration
  // order, so during a switch they still compare against the pre-switch tab.
  const prevActiveTabRef = useRef(s.activeTabId);

  useWatchEffect(() => {
    const wasInbox = prevWasInboxRef.current;
    prevWasInboxRef.current = isOnInboxPage;
    if (prevActiveTabRef.current !== s.activeTabId) return;
    const store = useInboxStore.getState();
    // Entering the inbox opens the session list beside it (unless you closed
    // it by hand). Runs on first mount too — a boot landing on /inbox seeds
    // the rail for a fresh workspace.
    if (!wasInbox && isOnInboxPage) {
      if (!selectSessionRailOpen(store) && !selectSessionRailUserClosed(store)) {
        store.toggleSidePanel();
      }
    }
    if (wasInbox && !isOnInboxPage) {
      // The Favorites view is a mode of the inbox's session list; leaving the
      // inbox drops back to the active desk so the rail isn't stuck on the shelf.
      if (store.showFavorites) store.setShowFavorites(false);
      if (selectSessionRailUserClosed(store)) return;
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
    if (prevActiveTabRef.current !== s.activeTabId) return;
    const store = useInboxStore.getState();
    if (selectSessionRailUserClosed(store)) return;
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

  // Keep LAST of the trio: the consumers above must see the pre-switch tab id.
  useWatchEffect(() => {
    prevActiveTabRef.current = s.activeTabId;
  }, [s.activeTabId]);

  const resolveNewSessionContext = useCallback(() => {
    const store = useInboxStore.getState();
    // An exclude chip ("everything but X") expresses no project preference for
    // new sessions — only include mode constrains/seeds below.
    const activeProjectFilter = store.chipFilterExclude ? null : store.activeProjectFilter;
    // A label chip nulls activeProjectPath — derive the label's directory instead.
    const activeProjectPath = store.chipFilterExclude ? null : store.activeProjectPath ?? bucketProjectPath(store);
    // Ctrl+N clones the selected session's project path (preserving its worktree /
    // subdirectory) — the session the user sees highlighted (sessionListActiveId).
    // But a project-filter chip is an explicit "I'm working in this project": when
    // one is active, the focused session only wins if it actually lives inside that
    // project, so a stale focus from elsewhere can't pull a new session out of it.
    // And the focused/current session can be a TEAMMATE's (team inbox), whose
    // checkout no machine of ours has — such a path never seeds a new session.
    // Only a LIVE roster may veto a path: the persisted roster paints chips at
    // boot but a stale copy must not block a freshly cloned checkout.
    const seedable = (p: string | null | undefined) => pathOnMyMachines(liveMachineRoster(store), p);
    const selected = sessionListActiveId
      ? (store.sessions[sessionListActiveId]
          ?? store.conversations[sessionListActiveId])
      : null;
    if (
      selected?.project_path &&
      seedable(selected.project_path) &&
      (!activeProjectFilter || getProjectName(selected.git_root, selected.project_path) === activeProjectFilter)
    ) {
      return {
        path: selected.project_path,
        gitRoot: selected.git_root || selected.project_path,
        agentType: selected.agent_type,
      };
    }
    const ctx = store.currentConversation;
    // The project-filter chip the user scoped the inbox to — honor it before the
    // URL directory filter or the last conversation's git root.
    if (activeProjectPath) {
      return { path: activeProjectPath, gitRoot: activeProjectPath, agentType: ctx.agentType };
    }
    if (directoryFilter) {
      return { path: directoryFilter, gitRoot: ctx.gitRoot || directoryFilter, agentType: ctx.agentType };
    }
    const ctxRoot = seedable(ctx.gitRoot) ? ctx.gitRoot : undefined;
    return { path: ctxRoot, gitRoot: ctxRoot, agentType: ctx.agentType };
  }, [directoryFilter, sessionListActiveId]);

  // Every "New Session" affordance opens the floating compose popup (ComposeView
  // in an overlay) — the same surface the command palette uses. ComposeView owns
  // the blank-session create + the project/agent picker, so this is just "show
  // the popup". Reading the action straight off the store keeps it stable.
  const openCompose = useInboxStore((st) => st.openCompose);

  // Ctrl+N opens a FULL new session in the main window (not the modal): seed a
  // DEFERRED blank session and navigate to it. The conversation route renders the
  // same NewSessionView for the empty timeline, and the first send self-heals the
  // stub into a real conversation (awaitConvexId → ensureSessionCreated → rekey),
  // so no eager create — and therefore no "create" sound — until the user sends.
  // deferCreate + reuse means an abandoned (never-sent) open strands nothing:
  // repeated Ctrl+N converges on the one blank for this project+agent, which the
  // ghost sweep reaps. Isolated lives as a toggle inside NewSessionView, so it's
  // reachable here too without a separate eager-create path. Project can be empty
  // (the null-state ProjectSwitcher lets the user pick before sending).
  const handleNewFullSession = useCallback(() => {
    const { path, gitRoot, agentType: rawAgent } = resolveNewSessionContext();
    const agentType = (rawAgent || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const store = useInboxStore.getState();
    const { stubId } = store.beginOptimisticSession({
      agentType,
      projectPath: path,
      gitRoot: gitRoot || path || undefined,
      deferCreate: true,
      reuse: true,
      // Source project + agent from the LIVE stub at create time (not these
      // closure values) so a project/agent switch in NewSessionView before the
      // first send sticks — same contract as the compose popup.
      create: (sid) => store.createSessionFromStub(sid, { agentType, projectPath: path, gitRoot: gitRoot || path || undefined }),
    });
    if (isOnInboxPage || isOnConversationPage) {
      store.setCurrentSession(stubId);
    } else if (selectSessionRailOpen(store)) {
      useInboxStore.setState({ sidePanelSessionId: stubId });
    } else {
      router.push(`/conversation/${stubId}?focus=1`);
    }
  }, [resolveNewSessionContext, router, isOnInboxPage, isOnConversationPage]);

  // Bridge for the Electron "New Session" affordances (the palette's "open full"
  // hand-off, the app menu / dock / tray) — fired via the NEW_SESSION_EVENT DOM
  // event / __CODECAST_NEW_SESSION. Like Ctrl+N, this opens the FULL new session
  // in the main window (not the modal). handleNewFullSession closes over the
  // router + route flags, so the once-mounted listener calls it through a ref
  // kept current each render.
  const newFullSessionRef = useRef(handleNewFullSession);
  newFullSessionRef.current = handleNewFullSession;
  useMountEffect(() => {
    const open = () => newFullSessionRef.current();
    (window as any).__CODECAST_NEW_SESSION = open;
    window.addEventListener(NEW_SESSION_EVENT, open);
    // File › New Window (Cmd+N): the shell asks this window to pop its current
    // view out; the answer to "which view" lives here, not in the shell.
    (window as any).__CODECAST_DETACH_VIEW = detachCurrentView;
    return () => {
      delete (window as any).__CODECAST_NEW_SESSION;
      delete (window as any).__CODECAST_DETACH_VIEW;
      window.removeEventListener(NEW_SESSION_EVENT, open);
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
          if (v.bucket !== store.activeBucketFilter || v.project !== store.activeProjectFilter || !!v.exclude !== store.chipFilterExclude || !sameBucketExtras(v.extras, store.extraBucketFilters)) {
            if (v.bucket) store.setActiveBucketFilter(v.bucket, v.exclude, v.extras);
            else if (v.project) store.setActiveProjectFilter(v.project, v.projectPath, v.exclude);
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
      // A detached tab window navigates via React Router only — the shared
      // tabs its store hydrates belong to the main window, so mirroring this
      // window's URL into the "active tab" would rewrite someone else's tab.
      if (isDetachedTabWindow()) return;
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
  const switcherState = useRecentSwitcher();

  // Ctrl+N / Ctrl+Shift+N → the compose palette (modal overlay here; the
  // always-on-top window on desktop). Ctrl+Alt+N → a full new session in the main
  // window. Isolated-worktree creation lives as a toggle inside the compose surface.
  useShortcutAction('session.create', handleNewFullSession);

  useShortcutAction('session.compose', openCompose);

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

  // Persist user-driven resizes only, once, at drag end (useDragGatedLayoutPersist).
  // Imperative collapse and synced-in layout echoes fire onLayoutChange too —
  // ignoring those keeps a collapsed sidebar from sticking as a 0-size layout
  // and keeps two windows from rewriting each other's clamped values forever.
  // The width a drag just persisted: the store echo of our own gesture, which
  // the apply-external-width effect below must not "re-apply".
  const navDragEchoRef = useRef<number | null>(layout.sidebar);
  const handleLayoutChange = useDragGatedLayoutPersist((newLayout) => {
    if ((newLayout.sidebar ?? 0) < 5) return;
    navDragEchoRef.current = newLayout.sidebar || 25;
    useInboxStore.getState().wsSetSize("nav", newLayout.sidebar || 25);
  });

  // Stable layout shell: panels stay mounted across zen/sidebar/sidePanel toggles to
  // avoid remounting ConversationView and its Convex subscriptions (which flash a
  // "Loading conversation..." state). Visibility is driven imperatively.
  const sidebarPanelRef = usePanelRef();
  const sessionListPanelRef = usePanelRef();
  const sidebarHidden = !!hideSidebar || isZenMode || sidebarCollapsed || isMobile;

  // Animated collapse/expand: panels are flex-grow sized with no built-in
  // transition, so we enable one (globals.css `.sidebar-animating`) only for
  // the duration of a programmatic toggle — drag-resizes stay 1:1. The class is
  // toggled imperatively (not via React state) so it's in the DOM before
  // collapse()/expand() writes the new flex-grow in the same task — a state-
  // driven class would commit a render later and miss the transition. The
  // content is frozen at its expanded pixel width via --sidebar-frozen-w so
  // the panel slides over it instead of reflowing it while the width animates.
  const sidebarElRef = useRef<HTMLDivElement>(null);
  const sidebarAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The collapsed/expanded state we last drove the panel to. We compare against
  // this — not the library's isCollapsed() — so a toggle always acts, even if the
  // library's internal size and our store state ever drift apart.
  const sidebarAppliedRef = useRef<boolean | null>(null);
  // True while we're imperatively collapsing/expanding the panel. The library
  // emits a 0-size onResize during that transition; without this flag that event
  // is misread as a user drag-to-collapse and folds the nav slot,
  // instantly reverting an expand (the "toggle does nothing" bug).
  const sidebarProgrammaticRef = useRef(false);

  useWatchEffect(() => {
    const ref = sidebarPanelRef.current;
    const el = sidebarElRef.current;
    if (!ref || !el) return;
    if (sidebarAppliedRef.current === sidebarHidden) return;
    const firstSync = sidebarAppliedRef.current === null;
    sidebarAppliedRef.current = sidebarHidden;
    // On first mount the panel already renders at the right defaultSize — just
    // record the state and skip, so nothing animates or resizes on load.
    if (firstSync && ref.isCollapsed() === sidebarHidden) return;
    sidebarProgrammaticRef.current = true;
    // Freeze content at its current pixel width so text doesn't reflow while the
    // panel width animates (only meaningful when collapsing from a real width).
    const width = el.getBoundingClientRect().width;
    if (width) el.style.setProperty("--sidebar-frozen-w", `${width}px`);
    el.classList.add("sidebar-animating");
    if (sidebarAnimTimer.current) clearTimeout(sidebarAnimTimer.current);
    sidebarAnimTimer.current = setTimeout(() => {
      el.classList.remove("sidebar-animating");
      sidebarProgrammaticRef.current = false;
    }, 360);
    // Expand by resizing to the persisted width (always ≥ minSize) instead of the
    // library's expand(): its restored size can land below the collapse/min
    // midpoint and get clamped straight back to 0, making expand a silent no-op.
    if (sidebarHidden) ref.collapse();
    else ref.resize(`${layout.sidebar}%`);
  }, [sidebarHidden]);

  // An external width change (a workbench switch, another window's sync) lands
  // in the nav slot; apply it to the live panel. Our own drag already moved the
  // panel — its store echo is skipped so the gesture never fights itself.
  useWatchEffect(() => {
    const ref = sidebarPanelRef.current;
    if (!ref || sidebarHidden) return;
    if (navDragEchoRef.current === layout.sidebar) return;
    navDragEchoRef.current = layout.sidebar;
    sidebarProgrammaticRef.current = true;
    ref.resize(`${layout.sidebar}%`);
    setTimeout(() => { sidebarProgrammaticRef.current = false; }, 50);
  }, [layout.sidebar]);

  // Hover-peek: with a side panel collapsed, touching the screen edge slides the
  // full panel out as an overlay (state machine + markup in EdgePeek). Left edge
  // peeks the sidebar; right edge peeks the session list (rightPeekEnabled above).
  const peekEnabled = sidebarCollapsed && !hideSidebar && !isZenMode && !isMobile;

  // The context slot owns the rail's width. Its size field serves whichever
  // pane holds the edge — a percent for the session list, pixels for the
  // comment rail — so only a plausibly-percent value is read here.
  const ctxSize = s.workspace.context.size;
  const railSize = ctxSize !== undefined && ctxSize >= 5 && ctxSize <= 50 ? ctxSize : 30;
  const railDragEchoRef = useRef<number | null>(railSize);
  const handleRightLayoutChange = useDragGatedLayoutPersist((newLayout) => {
    const size = newLayout["session-list"];
    if (!size || size < 5 || !showSessionList) return;
    railDragEchoRef.current = size;
    useInboxStore.getState().wsSetSize("context", size);
  });

  useWatchEffect(() => {
    const ref = sessionListPanelRef.current;
    if (!ref) return;
    if (showSessionList) {
      // Resize (not expand): it both opens a collapsed panel and applies a
      // workbench-restored width; expand() can clamp back to 0 (see the
      // sidebar note above). Skip the echo of our own drag.
      if (ref.isCollapsed() || railDragEchoRef.current !== railSize) {
        railDragEchoRef.current = railSize;
        ref.resize(`${railSize}%`);
      }
    } else {
      if (!ref.isCollapsed()) ref.collapse();
    }
  }, [showSessionList, railSize]);

  // Guest/unauthenticated: minimal layout, no top header — branding lives in the
  // bottom bar. Always simple-view: anonymous share viewers get the calm reading
  // chrome without owning a simple_view pref (writing one could outlive the visit
  // and clobber a later sign-in's stamped preference).
  if (isGuest) {
    return (
      <div className="bg-sol-bg flex flex-col overflow-hidden simple-view" style={{ height: '100vh' }}>
        <div className="flex-1 min-h-0">
          <div className="h-full">{children}</div>
        </div>
      </div>
    );
  }

  // A detached tab window shows exactly its URL via React Router — no tab
  // shell, even though the shared tabs hydrate into its store too.
  const hasTabs = s.tabs.length > 0 && !isNonTabRoute(routerLocation.pathname) && !isDetachedTabWindow();
  const content = hasTabs ? <TabContent /> : children;

  // The trail sits above whatever surface is open — one bar for every page, so
  // no surface has to grow its own. It draws nothing on a bare list page.
  const pageBody = isFullWidthPage || hasTabs ? (
    <div className="h-full">{content}</div>
  ) : (
    <PageShell pathname={pathname ?? ""}>{content}</PageShell>
  );
  // THE STAGE: the page, full width. Splitting it is the tab's own layout
  // (components/stage, rendered inside TabContent), never a shell slot — the
  // stage's element structure is identical on every surface, so a tab switch
  // across surfaces never unmounts the page subtree.
  const pageContent = (
    <div className="h-full flex flex-col min-h-0">
      <BreadcrumbBar />
      <div className="flex-1 min-h-0">{pageBody}</div>
      {/* The triage verbs, one home under the composer. The bar gates itself
          to inbox session views, so it draws nothing elsewhere. Compact is a
          corner button with no layout height. Own boundary: a bar crash must
          cost the bar, never the stage. */}
      <ErrorBoundary name="TriageBar" level="inline">
        <TriageBar />
      </ErrorBoundary>
    </div>
  );

  // ONE right rail, and it is only ever the session list. A conversation
  // never renders inside it — selecting a session promotes it to the stage
  // (sessionListOnSelect → navigate), so columns cannot pile up. The Group is
  // always rendered; the rail Panel collapses to 0 when not in use.
  const rightArea = (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 h-full">
        <Group orientation="horizontal" className="h-full" defaultLayout={{ "right-content": showSessionList ? 100 - railSize : 100, "session-list": showSessionList ? railSize : 0 }} onLayoutChange={handleRightLayoutChange}>
          <Panel id="right-content" minSize={400}><div className="h-full">{pageContent}</div></Panel>
          <Separator className={`${separatorClass} ${showSessionList ? "" : "invisible"}`} />
          <Panel
            id="session-list"
            panelRef={sessionListPanelRef}
            minSize={200}
            maxSize="50%"
            defaultSize={showSessionList ? railSize : 0}
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
                  />
                </div>
              </ErrorBoundary>
            )}
          </Panel>
        </Group>
      </div>
    </div>
  );

  return (
    <div className={`bg-sol-bg flex flex-col overflow-hidden${s.clientState.ui?.simple_view ? " simple-view" : ""}`} style={{ height: zoomHeight }}>
      <ErrorBoundary name="DashboardSync" level="inline" fallback={null}>
        <DashboardSyncEffects />
      </ErrorBoundary>
      {/* Zen hides this header. On the desktop app each surface's own top row
          then stands in as the titlebar — drag region + traffic-light inset —
          via useTitlebarHead, so no strip is needed above the page. */}
      {/* Header spans full width */}
      <header ref={headerRef} className={`flex-shrink-0 border-b border-black/10 bg-sol-bg z-[100] ${desktopClass} ${isZenMode ? "hidden" : ""} relative`}>
        {typeof window !== "undefined" && window.location.hostname.includes("local.") && (
          <div className="absolute top-0 left-0 w-0 h-0 border-t-[20px] border-r-[20px] border-t-emerald-500 border-r-transparent z-30" />
        )}
        <div className="px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-3">
          {/* Left section: Sidebar toggle + nav */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <ShortcutTooltip label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"} action="sidebar.toggleLeft">
              <button
                onClick={(e) => { s.setNavCollapsed(!sidebarCollapsed); tipActions.whisper('sidebar.toggleLeft', e); }}
                className="hidden md:flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              >
                <PanelLeft className="w-[18px] h-[18px]" />
              </button>
            </ShortcutTooltip>
            {isDesktopApp && (
              <div className="flex items-center gap-0.5">
                <ShortcutTooltip label="Back">
                  <button
                    onClick={() => window.history.back()}
                    className="p-1.5 text-sol-text-muted hover:text-sol-text transition-colors rounded hover:bg-sol-bg-alt"
                    aria-label="Go back"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                </ShortcutTooltip>
                <ShortcutTooltip label="Forward">
                  <button
                    onClick={() => window.history.forward()}
                    className="p-1.5 text-sol-text-muted hover:text-sol-text transition-colors rounded hover:bg-sol-bg-alt"
                    aria-label="Go forward"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </ShortcutTooltip>
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
            <ErrorBoundary name="GlobalSearch" level="inline">
              <GlobalSearch />
            </ErrorBoundary>
          </div>

          <div className="hidden md:block flex-shrink-0 mx-1" style={{ width: 1, minWidth: 1, height: 20, backgroundColor: "var(--sol-text-dim)", opacity: 0.35 }} />

          {/* Right section: Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <ErrorBoundary name="AccountUsageChip" level="inline">
              <AccountUsageChip />
            </ErrorBoundary>
            <ErrorBoundary name="DaemonStatusChip" level="inline">
              <DaemonStatusChip />
            </ErrorBoundary>
            <ErrorBoundary name="SyncStatusChip" level="inline">
              <SyncStatusChip />
            </ErrorBoundary>
            <ActiveAgentsBadge isOnInboxPage={isOnInboxPage} />
            <ErrorBoundary name="AnchorChip" level="inline">
              <AnchorChip />
            </ErrorBoundary>
            <ShortcutTooltip label="New session" action="session.create">
              <button
                onClick={(e) => {
                  openCompose();
                  tipActions.whisper('session.create', e);
                }}
                className="hidden md:flex items-center justify-center w-7 h-7 rounded-full border border-sol-text-dim/20 bg-sol-text-dim/8 text-sol-text-dim/50 hover:bg-sol-text-dim/15 hover:text-sol-text-dim/70 hover:border-sol-text-dim/30 transition-colors"
              >
                <Plus className="w-[18px] h-[18px]" />
              </button>
            </ShortcutTooltip>
            <ThemeToggle />
            <ErrorBoundary name="NotificationBell" level="inline">
              <NotificationBell />
            </ErrorBoundary>
            <ErrorBoundary name="UserMenu" level="inline">
              <UserMenu />
            </ErrorBoundary>
            {showCommentsToggle && (
              <ShortcutTooltip label={commentRailOpen ? "Hide comments" : "Show comments"} action="sidebar.toggleComments">
                <button
                  onClick={(e) => { s.setCommentRailOpen(!commentRailOpen); tipActions.whisper('sidebar.toggleComments', e); }}
                  className={`flex items-center p-1.5 rounded-md transition-colors ${commentRailOpen ? "text-sol-cyan" : "text-sol-text-dim/60 hover:text-sol-text-muted"}`}
                >
                  <MessageSquare className="w-[18px] h-[18px]" />
                </button>
              </ShortcutTooltip>
            )}
            {!isMobile && (
              <ShortcutTooltip label="Toggle terminal" action="terminal.toggle">
                <button
                  onClick={(e) => { s.setDockOpen(s.workspace.dock.pane == null); tipActions.whisper('terminal.toggle', e); }}
                  className="hidden md:flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
                  aria-label="Toggle terminal panel"
                >
                  <SquareTerminal className="w-[18px] h-[18px]" />
                </button>
              </ShortcutTooltip>
            )}
            {/* Detached tab window only: merge this surface back into the
                main window as a tab (renders null everywhere else). */}
            <AttachTabButton />
            <ShortcutTooltip label="Toggle sessions panel" action="sidebar.toggleRight">
              <button
                onClick={(e) => { s.toggleSidePanel(); tipActions.whisper('sidebar.toggleRight', e); }}
                className="flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              >
                <PanelRight className="w-[18px] h-[18px]" />
              </button>
            </ShortcutTooltip>
          </div>
        </div>
      </header>

      <ErrorBoundary name="Banners" level="inline">
        <ConnectionBanner />
        <StorageHealthBanner />
        <DesktopAppBanner />
        <SetupPromptBanner />
        <NewSnippetsBanner />
        <CliOfflineBanner />
        <TmuxMissingBanner />
        <NotificationNudgeBanner />
        <DeviceSetupDialog />
      </ErrorBoundary>

      <ErrorBoundary name="TabBar" level="inline">
        <TabBar />
      </ErrorBoundary>

      {/* Content area with sidebar and main. Group is always mounted; sidebar Panel
          collapses imperatively so toggling zen/sidebar/mobile doesn't remount {rightArea}. */}
      <div className="flex-1 min-h-0 flex relative">
        {/* Collapsed-panel hover peeks: edge hotzone + sliding overlay. Scoped to
            this container so they start below the header/banners, not the viewport. */}
        <EdgePeek side="left" enabled={peekEnabled} width={280}>
          <ErrorBoundary name="SidebarPeek" level="panel">
            <Sidebar
              directoryFilter={directoryFilter}
              isMobileOpen={false}
              onMobileClose={noop}
            />
          </ErrorBoundary>
        </EdgePeek>
        <EdgePeek side="right" enabled={rightPeekEnabled} width={320}>
          <ErrorBoundary name="SessionListPeek" level="panel">
            <div className="w-full h-full border-l border-sol-border/30">
              <SessionListPanel
                onSessionSelect={sessionListOnSelect}
                activeSessionId={sessionListActiveId}
              />
            </div>
          </ErrorBoundary>
        </EdgePeek>
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
              elementRef={sidebarElRef}
              minSize={180}
              maxSize="50%"
              collapsible
              collapsedSize={0}
              defaultSize={sidebarHidden ? 0 : layout.sidebar}
              onResize={(size) => {
                // Persist a *user drag* down to 0 as a collapse. Ignore the 0-size
                // events the library emits while we're imperatively expanding —
                // those would otherwise re-fold the nav slot and instantly
                // revert the expand (the "toggle does nothing" bug).
                if (size.asPercentage === 0 && !sidebarHidden && !sidebarProgrammaticRef.current) {
                  s.setNavCollapsed(true);
                }
              }}
            >
              {!isMobile && (
                <div className="h-full bg-sol-bg-alt overflow-auto border-r border-sol-border/30">
                  <ErrorBoundary name="Sidebar" level="panel">
                    <Sidebar
                      directoryFilter={directoryFilter}
                      isMobileOpen={isMobileSidebarOpen}
                      onMobileClose={closeMobileSidebar}
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
        {/* The anchor slide-over: scoped to the content area so it starts
            below the header/banners/tab bar and covers the stage, not the
            chrome. */}
        <ErrorBoundary name="AnchorPanel" level="panel">
          <AnchorPanel />
        </ErrorBoundary>
      </div>

      {/* Integrated terminal, docked across the bottom (ctrl+`). Mounts lazily
          on first open, then stays mounted (hidden) so terminals survive
          close/reopen. Desktop-only surface. */}
      {!isMobile && (
        <ErrorBoundary name="TerminalPanel" level="panel">
          <TerminalDock />
        </ErrorBoundary>
      )}
      {!isMobile && (
        <ErrorBoundary name="VaultQuickSwitcher" level="panel">
          <VaultQuickSwitcherDock />
          <FilePathMenuHost />
        </ErrorBoundary>
      )}

      <ErrorBoundary name="SettingsModal" level="panel">
        <SettingsModal />
      </ErrorBoundary>

      {/* The wall of faces, over the main window. Mounted here rather than on a
          route because it is a gesture, not a place: you open it, hold somebody,
          and it goes away. It renders nothing and subscribes to nothing while
          shut. */}
      <ErrorBoundary name="PeopleWallModal" level="panel">
        <PeopleWallModal />
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
                onMobileClose={closeMobileSidebar}
              />
            </ErrorBoundary>
          </div>
        </>
      )}
      {/* Mobile session list overlay — single render point for SessionListPanel on small screens */}
      {showMobileSessionList && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => s.toggleSidePanel()} />
          <div className="fixed inset-y-0 right-0 z-50 w-[80vw] max-w-xs shadow-xl animate-slide-in-right">
            <ErrorBoundary name="SessionList" level="panel">
              <SessionListPanel
                onSessionSelect={sessionListOnSelect}
                activeSessionId={sessionListActiveId}
              />
            </ErrorBoundary>
          </div>
        </>
      )}
      <ErrorBoundary name="CommandPalette" level="inline">
        <CommandPalette />
      </ErrorBoundary>
      <ErrorBoundary name="TriageNux" level="inline">
        <TriageNuxGate />
      </ErrorBoundary>
      {/* The dock portals to <body>, so this wrapper is empty (and hidden)
          until the boundary trips. A dock crash used to degrade into the
          default inline fallback rendered here in normal flow — the bottom of
          the shell, effectively invisible — so the call window "just
          vanished" with no way back (Jason, 2026-08-24). The fallback is a
          floating chip where the dock lived: retry re-renders, hang up also
          frees the seat, and the ErrorBoundary toast still carries the trace. */}
      <div className="fixed bottom-20 right-4 z-[160] empty:hidden rounded-lg border border-sol-border bg-sol-bg-alt/95 shadow-xl">
        <ErrorBoundary
          name="Call window"
          fallback={({ retry }) => (
            <div className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="text-sol-red">The call window crashed</span>
              <button onClick={retry} className="text-sol-cyan hover:underline">
                retry
              </button>
              <button
                onClick={() => {
                  void leaveCall();
                  retry();
                }}
                className="text-sol-text-muted hover:text-sol-red hover:underline"
              >
                hang up
              </button>
            </div>
          )}
        >
          <CallDock />
        </ErrorBoundary>
      </div>
      {/* The huddle the people window (or a detached tab) is hosting. The dock
          above reads THIS window's call and correctly shows nothing, which
          without a word left the main window looking as though no call were
          running at all — and the first thing that invites is starting a second
          one. It sits where the dock would, and says only where to look. */}
      <div className="fixed bottom-20 right-4 z-[155] empty:hidden rounded-lg border border-sol-border bg-sol-bg-alt/95 px-3 py-2 shadow-xl">
        <ElsewhereCallPill />
      </div>
      {/* A recording in progress, wherever the person has wandered to. It
          portals to the body and renders nothing unless one is running. */}
      <RecordingPill />
      <GlobalCloseGuardDialog />
      {s.compose.open && (
        <div
          className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
          // Route the backdrop click through ComposeView's guarded close so a
          // click-away over a typed draft gets the keep/discard confirm instead
          // of silently dropping the draft.
          onClick={() => (composeCloseGuardRef.current ?? s.closeCompose)()}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ComposeView key={s.compose.nonce} initialQuery={s.compose.initialQuery} context={s.compose.context} onClose={s.closeCompose} closeGuardRef={composeCloseGuardRef} />
          </div>
        </div>
      )}
      <ErrorBoundary name="FindBar" level="inline">
        <FindBar />
      </ErrorBoundary>
      {switcherState.open && (
        <RecentSwitcher
          items={switcherState.items}
          selectedIndex={switcherState.selectedIndex}
        />
      )}
    </div>
  );
}

