import { ReactNode, useState, useCallback, useRef, useLayoutEffect } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useConvexSync } from "../hooks/useConvexSync";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
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
import { Plus, PanelLeft, PanelRight } from "lucide-react";
import { SetupPromptBanner } from "./SetupPromptBanner";
import { DesktopAppBanner } from "./DesktopAppBanner";
import { CliOfflineBanner } from "./CliOfflineBanner";
import { TmuxMissingBanner } from "./TmuxMissingBanner";
import { FindBar } from "./FindBar";
import { KeyboardShortcutsPanel, ShortcutsToggleButton } from "./KeyboardShortcutsHelp";
import { CreatePalette } from "./CreatePalette";
import { useInboxStore } from "../store/inboxStore";
import { useShortcutAction, useShortcutContext, useGlobalShortcutActions } from "../shortcuts";
import { usePrefetch } from "../hooks/usePrefetch";
import { desktopHeaderClass, setupDesktopDrag, isElectron } from "../lib/desktop";
import { CollapsedSessionRail, SessionListPanel, ConversationColumn } from "./GlobalSessionPanel";
import { useSyncInboxSessions } from "../hooks/useSyncInboxSessions";
import { isInboxRoute as isInboxRoutePath, isInboxSessionView } from "../lib/inboxRouting";
import { useSessionSwitcher } from "../hooks/useSessionSwitcher";
import { SessionSwitcher } from "./SessionSwitcher";

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

export function DashboardLayout(props: DashboardLayoutProps) {
  return <DashboardLayoutInner {...props} />;
}

function DashboardLayoutInner({ children, filter, onFilterChange, directoryFilter, onDirectoryFilterChange, hideSidebar }: DashboardLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const isZenMode = useInboxStore(s => s.clientState.ui?.zen_mode ?? false);
  const sidebarCollapsed = useInboxStore(s => s.clientState.ui?.sidebar_collapsed ?? false);
  const rawLayout = useInboxStore(s => s.clientState.layouts?.dashboard ?? DEFAULT_LAYOUT);
  const layout = {
    sidebar: Math.max(10, Math.min(50, rawLayout.sidebar ?? 25)),
    main: Math.max(30, Math.min(90, rawLayout.main ?? 75)),
  };
  const updateUI = useInboxStore(s => s.updateClientUI);
  const updateLayout = useInboxStore(s => s.updateClientLayout);
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const openComposePalette = useInboxStore((state) => state.openComposePalette);
  const [desktopClass, setDesktopClass] = useState("");
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  const [zoomHeight, setZoomHeight] = useState("100vh");
  const zoomRef = useRef(1);
  const headerRef = useRef<HTMLElement>(null);
  const prevWasInboxRef = useRef(false);
  usePrefetch();
  useSyncInboxSessions();

  const serverClientState = useQuery(api.client_state.get, {});
  const createQuickSession = useMutation(api.conversations.createQuickSession);
  useConvexSync(serverClientState, (data) => {
    useInboxStore.getState().syncClientState(data);
  });

  useMountEffect(() => {
    setDesktopClass(desktopHeaderClass());
    setIsDesktopApp(isElectron());
    const timer = setTimeout(() => { setDesktopClass(desktopHeaderClass()); setIsDesktopApp(isElectron()); }, 500);
    return () => clearTimeout(timer);
  });

  useWatchEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    return setupDesktopDrag(header);
  }, [desktopClass]);

  const isOnConversationPage = pathname?.includes("/conversation/") ?? false;
  const isOnCommitPage = pathname?.includes("/commit/") ?? false;
  const isOnPRPage = pathname?.includes("/pr/") ?? false;
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isInboxRoute = isInboxRoutePath(pathname);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);
  const isOnTasksPage = pathname === "/tasks" || (pathname?.startsWith("/tasks/") ?? false);
  const isOnWorkflowsPage = pathname === "/workflows" || (pathname?.startsWith("/workflows/") ?? false);
  const isOnPlansPage = pathname === "/plans" || (pathname?.startsWith("/plans/") ?? false);
  const isOnDocsPage = pathname === "/docs" || (pathname?.startsWith("/docs/") ?? false);
  const isFullWidthPage = isOnConversationPage || isOnCommitPage || isOnPRPage || isOnInboxPage || isOnTasksPage || isOnWorkflowsPage || isOnPlansPage || isOnDocsPage;

  const sidePanelOpen = useInboxStore(s => s.sidePanelOpen);
  const sidePanelSessionId = useInboxStore(s => s.sidePanelSessionId);
  const toggleSidePanel = useInboxStore(s => s.toggleSidePanel);
  const selectPanelSession = useInboxStore(s => s.selectPanelSession);
  const showCollapsedRail = !sidePanelOpen && !isOnInboxPage && !isMobile && !isZenMode;
  const showSessionList = sidePanelOpen && !isOnInboxPage && !isMobile && !isZenMode;
  const showConversationColumn = sidePanelOpen && !!sidePanelSessionId && !isOnInboxPage && !isMobile;

  const sidebarPanelRef = usePanelRef();
  const sessionListPanelRef = usePanelRef();
  const conversationPanelRef = usePanelRef();
  const shouldCollapseSidebar = hideSidebar || isZenMode || sidebarCollapsed || isMobile;

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
        store.selectPanelSession(current);
      } else {
        store.clearSidePanelSession();
      }
    }
  }, [isOnInboxPage]);

  useLayoutEffect(() => {
    if (shouldCollapseSidebar) sidebarPanelRef.current?.collapse();
    else sidebarPanelRef.current?.expand();
  }, [shouldCollapseSidebar]);

  useLayoutEffect(() => {
    if (!showSessionList) sessionListPanelRef.current?.collapse();
    else sessionListPanelRef.current?.expand();
  }, [showSessionList]);

  useLayoutEffect(() => {
    if (!showConversationColumn) conversationPanelRef.current?.collapse();
    else conversationPanelRef.current?.expand();
  }, [showConversationColumn]);

  const handleQuickCreate = useCallback(() => {
    soundNewSession();
    const store = useInboxStore.getState();
    if (store.showMySessions) store.setShowMySessions(false);
    const ctx = store.currentConversation;
    const path = directoryFilter || ctx.projectPath || ctx.gitRoot;
    if (!path) return;
    const agentType = ctx.agentType || "claude_code";
    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();
    store.setConversationMeta(sessionId, {
      _id: sessionId, _creationTime: now, user_id: "", agent_type: agentType,
      session_id: sessionId, project_path: path, git_root: path,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [],
    });
    store.createSession({
      agent_type: agentType,
      project_path: path,
      git_root: path,
      session_id: sessionId,
    });
    store.setCurrentSession(sessionId);
    if (!isInboxRoute) {
      store.openSidePanel(sessionId);
    }
  }, [directoryFilter, isInboxRoute]);

  const handleQuickCreateIsolated = useCallback(async () => {
    const ctx = useInboxStore.getState().currentConversation;
    const path = directoryFilter || ctx.projectPath || ctx.gitRoot;
    if (!path) {
      openComposePalette();
      return;
    }
    soundNewSession();
    const agentType = (ctx.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const conversationId = await createQuickSession({
      agent_type: agentType,
      project_path: path,
      git_root: ctx.gitRoot || path,
      isolated: true,
    });
    if (isInboxRoute) {
      useInboxStore.getState().setCurrentSession(conversationId as string);
    } else {
      router.push(`/conversation/${conversationId}?focus=1`);
    }
  }, [directoryFilter, router, isInboxRoute, createQuickSession, openComposePalette]);

  useGlobalShortcutActions();
  useShortcutContext('desktop', isDesktopApp);
  const switcherState = useSessionSwitcher();

  useShortcutAction('session.create', useCallback(() => {
    handleQuickCreate();
  }, [handleQuickCreate]));

  useShortcutAction('session.createIsolated', useCallback(() => {
    handleQuickCreateIsolated();
  }, [handleQuickCreateIsolated]));

  useShortcutAction('zoom.in', useCallback(() => {
    const r = Math.round(Math.min(zoomRef.current + 0.1, 2) * 10) / 10;
    zoomRef.current = r;
    document.documentElement.style.zoom = String(r);
    setZoomHeight(`calc(100vh / ${r})`);
  }, []));

  useShortcutAction('zoom.out', useCallback(() => {
    const r = Math.round(Math.max(zoomRef.current - 0.1, 0.5) * 10) / 10;
    zoomRef.current = r;
    document.documentElement.style.zoom = String(r);
    setZoomHeight(`calc(100vh / ${r})`);
  }, []));

  useShortcutAction('zoom.reset', useCallback(() => {
    zoomRef.current = 1;
    document.documentElement.style.zoom = '1';
    setZoomHeight('100vh');
  }, []));

  const handleLayoutChange = (newLayout: { [key: string]: number }) => {
    if ((newLayout.sidebar ?? 0) < 1) return;
    updateLayout("dashboard", { sidebar: newLayout.sidebar || 25, main: newLayout.main || 75 });
  };

  const handleSidebarResize = useCallback(({ inPixels }: { asPercentage: number; inPixels: number }) => {
    if (inPixels === 0 && !sidebarCollapsed) updateUI({ sidebar_collapsed: true });
    else if (inPixels > 0 && sidebarCollapsed) updateUI({ sidebar_collapsed: false });
  }, [sidebarCollapsed, updateUI]);

  const safeChildren = <ErrorBoundary name="PageContent" level="inline">{children}</ErrorBoundary>;

  const pageContent = isFullWidthPage ? (
    <div className="h-full">{safeChildren}</div>
  ) : (
    <div data-main-scroll className="h-full overflow-y-auto px-3 sm:px-6 lg:px-8 py-4">
      <div className="max-w-4xl mx-auto h-full">{safeChildren}</div>
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
              onClick={() => updateUI({ sidebar_collapsed: !sidebarCollapsed })}
              className="hidden md:flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
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

          {/* Right section: Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <button
              onClick={() => {
                const ctx = useInboxStore.getState().currentConversation;
                if (directoryFilter || ctx.projectPath || ctx.gitRoot) {
                  handleQuickCreate();
                } else {
                  openComposePalette();
                }
              }}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 hover:border-sol-cyan/50 transition-all"
              title="New session (Ctrl+N)"
            >
              <Plus className="w-4 h-4" />
              New
            </button>
            <ShortcutsToggleButton />
            <ThemeToggle />
            <ErrorBoundary name="NotificationBell" level="inline">
              <NotificationBell />
            </ErrorBoundary>
            <ErrorBoundary name="UserMenu" level="inline">
              <UserMenu />
            </ErrorBoundary>
            <button
              onClick={toggleSidePanel}
              className={`hidden md:flex items-center p-1.5 rounded-md transition-colors ${
                sidePanelOpen
                  ? "text-sol-cyan"
                  : "text-sol-text-dim/60 hover:text-sol-text-muted"
              }`}
              title="Toggle sessions panel"
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

      {/* Content area with sidebar and main — single stable panel tree */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <Group orientation="horizontal" className="h-full" defaultLayout={layout} onLayoutChange={handleLayoutChange}>
            <Panel id="sidebar" panelRef={sidebarPanelRef} minSize={180} maxSize="50%" collapsible collapsedSize={0} onResize={handleSidebarResize}>
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
            <Separator className={`${separatorClass} ${shouldCollapseSidebar ? '!w-0 !opacity-0' : ''}`} disabled={shouldCollapseSidebar} />
            <Panel id="main" minSize={400}>
              <Group orientation="horizontal" className="h-full" defaultLayout={{ "right-content": 70, "session-list": 30 }}>
                <Panel id="right-content" minSize={400}>
                  <div className="h-full">
                    <Group orientation="horizontal" className="h-full" defaultLayout={{ "main-content": 60, "conversation-column": 40 }}>
                      <Panel id="main-content" minSize="20%">{pageContent}</Panel>
                      <Separator className={`${separatorClass} ${!showConversationColumn ? '!w-0 !opacity-0' : ''}`} disabled={!showConversationColumn} />
                      <Panel id="conversation-column" panelRef={conversationPanelRef} minSize="20%" maxSize="70%" defaultSize="40%" collapsible collapsedSize={0}>
                        <ErrorBoundary name="ConversationColumn" level="panel"><ConversationColumn /></ErrorBoundary>
                      </Panel>
                    </Group>
                  </div>
                </Panel>
                <Separator className={`${separatorClass} ${!showSessionList ? '!w-0 !opacity-0' : ''}`} disabled={!showSessionList} />
                <Panel id="session-list" panelRef={sessionListPanelRef} minSize={200} maxSize="50%" defaultSize="30%" collapsible collapsedSize={0}>
                  {showSessionList && (
                    <ErrorBoundary name="SessionList" level="panel">
                      <div className="w-full h-full border-l border-sol-border/30">
                        <SessionListPanel
                          onSessionSelect={selectPanelSession}
                          activeSessionId={sidePanelSessionId}
                          onCollapse={toggleSidePanel}
                        />
                      </div>
                    </ErrorBoundary>
                  )}
                </Panel>
              </Group>
            </Panel>
          </Group>
        </div>
        {showCollapsedRail && <ErrorBoundary name="SessionRail" level="inline"><CollapsedSessionRail /></ErrorBoundary>}
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
