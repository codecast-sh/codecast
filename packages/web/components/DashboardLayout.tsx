import { ReactNode, useState, useCallback, useRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useConvexSync } from "../hooks/useConvexSync";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
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
import { Logo } from "./Logo";
import { soundNewSession } from "../lib/sounds";
import { Plus } from "lucide-react";
import { SetupPromptBanner } from "./SetupPromptBanner";
import { DesktopAppBanner } from "./DesktopAppBanner";
import { CliOfflineBanner } from "./CliOfflineBanner";
import { TmuxMissingBanner } from "./TmuxMissingBanner";
import { ElectronUpdateBanner } from "./ElectronUpdateBanner";
import { NewSessionModal } from "./ConversationList";
import { useInboxStore } from "../store/inboxStore";
import { usePrefetch } from "../hooks/usePrefetch";
import { desktopHeaderClass, setupDesktopDrag } from "../lib/desktop";
import { isInboxRoute as isInboxRoutePath, isInboxSessionView } from "../lib/inboxRouting";

interface DashboardLayoutProps {
  children: ReactNode;
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
  hideSidebar?: boolean;
}

const DEFAULT_LAYOUT = { sidebar: 25, main: 75 };

export function DashboardLayout({ children, filter, onFilterChange, directoryFilter, onDirectoryFilterChange, hideSidebar }: DashboardLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const isZenMode = useInboxStore(s => s.clientState.ui?.zen_mode ?? false);
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
  const openNewSession = useInboxStore((state) => state.openNewSession);
  const newSessionOpen = useInboxStore((state) => state.newSession.isOpen);
  const closeNewSession = useInboxStore((state) => state.closeNewSession);
  const currentConvContext = useInboxStore((s) => s.currentConversation);
  const [desktopClass, setDesktopClass] = useState("");
  const headerRef = useRef<HTMLElement>(null);
  usePrefetch();

  const serverClientState = useQuery(api.client_state.get, {});
  const createQuickSession = useMutation(api.conversations.createQuickSession);
  useConvexSync(serverClientState, (data) => {
    useInboxStore.getState().syncClientState(data);
  });

  useMountEffect(() => {
    setDesktopClass(desktopHeaderClass());
    const timer = setTimeout(() => setDesktopClass(desktopHeaderClass()), 500);
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
  const isFullWidthPage = isOnConversationPage || isOnCommitPage || isOnPRPage || isOnInboxPage || isOnTasksPage || isOnWorkflowsPage || isOnPlansPage;

  useMountEffect(() => {
    setIsMobile(window.innerWidth < 768);
  });

  useEventListener("resize", () => {
    setIsMobile(window.innerWidth < 768);
  });

  const handleLayoutChange = (newLayout: { [key: string]: number }) => {
    updateLayout("dashboard", { sidebar: newLayout.sidebar || 25, main: newLayout.main || 75 });
  };

  const handleQuickCreate = useCallback(() => {
    soundNewSession();
    const path = directoryFilter || currentConvContext.projectPath || currentConvContext.gitRoot;
    const agentType = (currentConvContext.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();

    const store = useInboxStore.getState();
    store.setConversationMeta(sessionId, {
      _id: sessionId, _creationTime: now, user_id: "", agent_type: agentType,
      session_id: sessionId, project_path: path, git_root: currentConvContext.gitRoot || path,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [],
    });
    store.createSession({
      agent_type: agentType,
      project_path: path,
      git_root: currentConvContext.gitRoot || path,
      session_id: sessionId,
    });

    if (!isInboxRoute) {
      router.push(`/conversation/${sessionId}?focus=1`);
    }
  }, [currentConvContext, directoryFilter, router, isInboxRoute]);

  const handleQuickCreateIsolated = useCallback(async () => {
    const path = directoryFilter || currentConvContext.projectPath || currentConvContext.gitRoot;
    if (!path) {
      openNewSession({ source: isOnInboxPage ? "inbox" : "sessions" });
      return;
    }
    soundNewSession();
    const agentType = (currentConvContext.agentType || "claude_code") as "claude_code" | "codex" | "gemini";
    const conversationId = await createQuickSession({
      agent_type: agentType,
      project_path: path,
      git_root: currentConvContext.gitRoot || path,
      isolated: true,
    });
    if (isInboxRoute) {
      useInboxStore.getState().setCurrentSession(conversationId as string);
    } else {
      router.push(`/conversation/${conversationId}?focus=1`);
    }
  }, [currentConvContext, directoryFilter, router, isInboxRoute, createQuickSession, openNewSession]);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "." && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      updateUI({ zen_mode: !isZenMode });
    }
    if (e.key === "1" && e.metaKey && e.shiftKey && e.altKey) {
      e.preventDefault();
      router.push("/inbox");
    }
    if (e.key === "n" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const store = useInboxStore.getState();
      if (store.showMySessions) {
        store.setShowMySessions(false);
      }
      if (directoryFilter || currentConvContext.projectPath || currentConvContext.gitRoot) {
        handleQuickCreate();
      } else {
        openNewSession({
          source: isOnInboxPage ? "inbox" : "sessions",
        });
      }
    }
    if (e.key.toLowerCase() === "n" && e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey) {
      e.preventDefault();
      handleQuickCreateIsolated();
    }
  });

  return (
    <div className="h-screen bg-sol-bg flex flex-col overflow-hidden">
      {/* Header spans full width */}
      <header ref={headerRef} className={`flex-shrink-0 border-b border-black/10 bg-sol-bg z-[100] ${desktopClass} ${isZenMode ? "hidden" : ""} relative`}>
        {typeof window !== "undefined" && window.location.hostname.includes("local.") && (
          <div className="absolute top-0 left-0 w-0 h-0 border-t-[20px] border-r-[20px] border-t-emerald-500 border-r-transparent z-30" />
        )}
        <div className="px-2 sm:px-4 py-1.5 sm:py-3 flex items-center gap-1.5 sm:gap-3">
          {/* Left section: Logo + toggle */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Link href="/"><span className="hidden sm:contents"><Logo size="md" showText={true} /></span></Link>
            <Link href="/"><span className="sm:hidden"><Logo size="md" showText={false} /></span></Link>
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
              <GlobalSearch />
            </div>
          </div>

          {/* Team switcher and avatars */}
          <div className="hidden sm:flex items-center gap-2">
            <TeamSwitcher />
            <TeamAvatarBar />
          </div>

          {/* Right section: Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <button
              onClick={() => {
                if (directoryFilter || currentConvContext.projectPath || currentConvContext.gitRoot) {
                  handleQuickCreate();
                } else {
                  openNewSession({});
                }
              }}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 hover:border-sol-cyan/50 transition-all"
              title="New session (Ctrl+N)"
            >
              <Plus className="w-4 h-4" />
              New
            </button>
            <ThemeToggle />
            <NotificationBell />
            <UserMenu />
          </div>
        </div>
      </header>

      <ElectronUpdateBanner />
      <DesktopAppBanner />
      <SetupPromptBanner />
      <CliOfflineBanner />
      <TmuxMissingBanner />

      {/* Content area with sidebar and main */}
      <div className="flex-1 min-h-0">
        {hideSidebar || isZenMode || isMobile ? (
          isFullWidthPage ? (
            <div className="h-full">
              {children}
            </div>
          ) : (
            <div data-main-scroll className="h-full overflow-y-auto px-3 sm:px-6 lg:px-8 py-4">
              <div className="max-w-4xl mx-auto h-full">
                {children}
              </div>
            </div>
          )
        ) : (
          <Group
            orientation="horizontal"
            className="h-full"
            defaultLayout={layout}
            onLayoutChange={handleLayoutChange}
          >
            <Panel id="sidebar" minSize="0%" maxSize="50%">
              <div className="h-full bg-sol-bg-alt overflow-auto">
                <Sidebar
                  filter={filter}
                  onFilterChange={onFilterChange}
                  directoryFilter={directoryFilter}
                  onDirectoryFilterChange={onDirectoryFilterChange}
                  isMobileOpen={isMobileSidebarOpen}
                  onMobileClose={() => setIsMobileSidebarOpen(false)}
                />
              </div>
            </Panel>
            <Separator className="relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan" />
            <Panel id="main" minSize="30%">
              {isFullWidthPage ? (
                <div className="h-full">
                  {children}
                </div>
              ) : (
                <div data-main-scroll className="h-full overflow-y-auto px-4 sm:px-6 lg:px-8 py-4">
                  <div className="max-w-4xl mx-auto h-full">
                    {children}
                  </div>
                </div>
              )}
            </Panel>
          </Group>
        )}
      </div>

      {/* Mobile sidebar overlay */}
      {isMobileSidebarOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setIsMobileSidebarOpen(false)}
          />
          <div className="md:hidden fixed inset-y-0 left-0 z-50 w-[85vw] max-w-sm shadow-xl animate-slide-in-left">
            <Sidebar
              filter={filter}
              onFilterChange={onFilterChange}
              directoryFilter={directoryFilter}
              onDirectoryFilterChange={onDirectoryFilterChange}
              isMobileOpen={isMobileSidebarOpen}
              onMobileClose={() => setIsMobileSidebarOpen(false)}
            />
          </div>
        </>
      )}
      <CommandPalette />
      <NewSessionModal isOpen={newSessionOpen} onClose={closeNewSession} />
    </div>
  );
}
