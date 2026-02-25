"use client";
import { ReactNode, useState, useEffect, useCallback, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMutation } from "convex/react";
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
import { PanelLeftClose, PanelLeftOpen, PanelRightOpen, PanelRightClose, Plus } from "lucide-react";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { SetupPromptBanner } from "./SetupPromptBanner";
import { useNewSessionStore } from "../store/newSessionStore";
import { NewSessionModal } from "./ConversationList";
import { useInboxStore } from "../store/inboxStore";
import { desktopHeaderClass } from "../lib/desktop";

interface DashboardLayoutProps {
  children: ReactNode;
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
  hideSidebar?: boolean;
}

const LAYOUT_STORAGE_KEY = "dashboard-layout";
const DEFAULT_LAYOUT = { sidebar: 25, main: 75 };

const getInitialLayout = (): { sidebar: number; main: number } => {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return DEFAULT_LAYOUT;
    }
  }
  return DEFAULT_LAYOUT;
};

const getInitialCollapsed = () => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem("sidebarCollapsed") === "true";
};

const getInitialZenMode = () => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem("zenMode") === "true";
};

export function DashboardLayout({ children, filter, onFilterChange, directoryFilter, onDirectoryFilterChange, hideSidebar }: DashboardLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(getInitialCollapsed);
  const [isZenMode, setIsZenMode] = useState(getInitialZenMode);
  const [layout, setLayout] = useState(getInitialLayout);
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const diffPanelOpen = useDiffViewerStore((state) => state.diffPanelOpen);
  const toggleDiffPanel = useDiffViewerStore((state) => state.toggleDiffPanel);
  const openNewSession = useNewSessionStore((state) => state.open);
  const newSessionOpen = useNewSessionStore((state) => state.isOpen);
  const closeNewSession = useNewSessionStore((state) => state.close);
  const currentConvContext = useInboxStore((s) => s.currentConversation);
  const createQuickSession = useMutation(api.conversations.createQuickSession);
  const injectSession = useInboxStore((s) => s.injectSession);
  const replaceSessionId = useInboxStore((s) => s.replaceSessionId);
  const resolveTempId = useInboxStore((s) => s.resolveTempId);
  const creatingRef = useRef(false);
  const desktopClass = desktopHeaderClass();

  const isOnConversationPage = pathname?.includes("/conversation/") ?? false;
  const isOnCommitPage = pathname?.includes("/commit/") ?? false;
  const isOnPRPage = pathname?.includes("/pr/") ?? false;
  const isOnInboxPage = pathname === "/inbox" || (pathname?.startsWith("/inbox/") ?? false);
  const isFullWidthPage = isOnConversationPage || isOnCommitPage || isOnPRPage || isOnInboxPage;

  useEffect(() => {
    setMounted(true);
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const handleLayoutChange = (newLayout: { [key: string]: number }) => {
    const updated = { sidebar: newLayout.sidebar || 25, main: newLayout.main || 75 };
    setLayout(updated);
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(updated));
  };

  const toggleSidebar = () => {
    const newValue = !isSidebarCollapsed;
    setIsSidebarCollapsed(newValue);
    localStorage.setItem("sidebarCollapsed", String(newValue));
  };

  const handleQuickCreate = useCallback(() => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    const path = currentConvContext.projectPath || currentConvContext.gitRoot;
    const agentType = (currentConvContext.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const now = Date.now();
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const stubMeta = {
      _id: tempId, _creationTime: now, user_id: "", agent_type: agentType,
      session_id: "", project_path: path, git_root: currentConvContext.gitRoot || path,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [], user: null,
      child_conversations: [], child_conversation_map: {},
      has_more_above: false, oldest_timestamp: null, last_timestamp: null,
      fork_count: 0, forked_from_details: null, compaction_count: 0,
      fork_children: [], parent_conversation_id: null,
    };

    useInboxStore.getState().setConversationMeta(tempId, stubMeta);

    if (isOnInboxPage) {
      injectSession({
        _id: tempId,
        session_id: "",
        title: "New session",
        updated_at: now,
        project_path: path,
        git_root: currentConvContext.gitRoot || path,
        agent_type: agentType,
        message_count: 0,
        is_idle: true,
        has_pending: false,
        last_user_message: null,
      });
    } else {
      router.push(`/conversation/${tempId}?focus=1`);
    }

    createQuickSession({
      agent_type: agentType,
      project_path: path,
      git_root: currentConvContext.gitRoot || path,
    }).then((conversationId) => {
      const realId = conversationId as unknown as string;
      useInboxStore.getState().resolveTempId(tempId, realId);
      if (isOnInboxPage) {
        replaceSessionId(tempId, realId);
      } else {
        router.replace(`/conversation/${realId}?focus=1`);
      }
      creatingRef.current = false;
    }).catch(() => {
      creatingRef.current = false;
    });
  }, [createQuickSession, currentConvContext, router, isOnInboxPage, injectSession, replaceSessionId, resolveTempId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!hideSidebar && e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
          return;
        }
        e.preventDefault();
        toggleSidebar();
      }
      if (e.key === "." && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setIsZenMode((prev) => {
          const next = !prev;
          localStorage.setItem("zenMode", String(next));
          return next;
        });
      }
      if (e.key === "n" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (currentConvContext.projectPath || currentConvContext.gitRoot) {
          handleQuickCreate();
        } else {
          openNewSession({
            source: isOnInboxPage ? "inbox" : "sessions",
          });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideSidebar, isSidebarCollapsed, isOnInboxPage, currentConvContext, openNewSession, handleQuickCreate]);

  return (
    <div className="h-screen bg-sol-bg flex flex-col overflow-hidden">
      {/* Header spans full width */}
      <header className={`flex-shrink-0 border-b border-sol-border bg-sol-bg/95 backdrop-blur-sm z-[100] ${desktopClass} ${isZenMode ? "hidden" : ""}`}>
        <div className="px-2 sm:px-4 py-2 sm:py-3 flex items-center gap-1.5 sm:gap-3">
          {/* Left section: Logo + toggle */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Logo size="sm" showText={true} />
            {!hideSidebar && (
              <>
                <button
                  onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
                  className="md:hidden p-1.5 sm:p-2 text-sol-text hover:text-sol-yellow transition-colors"
                  aria-label="Toggle menu"
                >
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
                <button
                  onClick={toggleSidebar}
                  className="hidden md:block p-1.5 text-sol-text-dim hover:text-sol-text transition-colors"
                  aria-label={isSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                  title={isSidebarCollapsed ? "Show sidebar (s)" : "Hide sidebar (s)"}
                >
                  {isSidebarCollapsed ? (
                    <PanelLeftOpen className="w-5 h-5" />
                  ) : (
                    <PanelLeftClose className="w-5 h-5" />
                  )}
                </button>
              </>
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
            {mounted && isOnConversationPage && (
              <button
                onClick={toggleDiffPanel}
                className="hidden md:block p-1.5 text-sol-text-dim hover:text-sol-text transition-colors"
                aria-label={diffPanelOpen ? "Hide diff panel" : "Show diff panel"}
                title={diffPanelOpen ? "Hide diff panel (d)" : "Show diff panel (d)"}
              >
                {diffPanelOpen ? (
                  <PanelRightClose className="w-5 h-5" />
                ) : (
                  <PanelRightOpen className="w-5 h-5" />
                )}
              </button>
            )}
            <button
              onClick={() => {
                if (currentConvContext.projectPath || currentConvContext.gitRoot) {
                  handleQuickCreate();
                } else {
                  openNewSession({});
                }
              }}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 hover:border-sol-cyan/50 transition-all"
              title="New session (Ctrl+N)"
            >
              <Plus className="w-4 h-4" />
              New Session
            </button>
            <ThemeToggle />
            <NotificationBell />
            <UserMenu />
          </div>
        </div>
      </header>

      <SetupPromptBanner />

      {/* Content area with sidebar and main */}
      <div className="flex-1 min-h-0">
        {hideSidebar || isSidebarCollapsed || isZenMode || isMobile ? (
          isFullWidthPage ? (
            <div className="h-full">
              {children}
            </div>
          ) : (
            <div data-main-scroll className="h-full overflow-y-auto px-3 sm:px-6 lg:px-8 py-4">
              <div className="max-w-4xl mx-auto">
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
            <Panel id="sidebar" minSize={0}>
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
            <Separator className="w-px bg-sol-border hover:w-1.5 hover:bg-sol-cyan data-[resize-handle-active]:w-1.5 data-[resize-handle-active]:bg-sol-cyan cursor-col-resize transition-[width,background-color] duration-150" />
            <Panel id="main" minSize={0}>
              {isFullWidthPage ? (
                <div className="h-full">
                  {children}
                </div>
              ) : (
                <div data-main-scroll className="h-full overflow-y-auto px-4 sm:px-6 lg:px-8 py-4">
                  <div className="max-w-4xl mx-auto">
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
          <div className="md:hidden fixed inset-y-0 left-0 z-50 w-[85vw] max-w-xs">
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
