"use client";
import { ReactNode, useState, useEffect, lazy, Suspense } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Group, Panel, Separator } from "react-resizable-panels";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { Button } from "./ui/button";
import { Logo } from "./Logo";

const InviteModal = lazy(() => import("./InviteModal").then(m => ({ default: m.InviteModal })));

interface DashboardLayoutProps {
  children: ReactNode;
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directories?: string[];
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
  hideSidebar?: boolean;
}

export function DashboardLayout({ children, filter, onFilterChange, directories, directoryFilter, onDirectoryFilterChange, hideSidebar }: DashboardLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarSize, setSidebarSize] = useState(18);

  useEffect(() => {
    const stored = localStorage.getItem("sidebarCollapsed");
    if (stored !== null) {
      setIsSidebarCollapsed(stored === "true");
    }
  }, []);

  const toggleSidebar = () => {
    const newValue = !isSidebarCollapsed;
    setIsSidebarCollapsed(newValue);
    localStorage.setItem("sidebarCollapsed", String(newValue));
  };

  useEffect(() => {
    if (hideSidebar) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
          return;
        }
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideSidebar, isSidebarCollapsed]);

  const showSidebar = !hideSidebar && !isSidebarCollapsed;
  const user = useQuery(api.users.getCurrentUser);
  const team = useQuery(
    api.teams.getTeam,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  const isAdmin = user?.role === "admin";

  return (
    <div className="h-screen bg-sol-bg flex flex-col overflow-hidden">
      {/* Header spans full width */}
      <header className="flex-shrink-0 border-b border-sol-border bg-sol-bg/95 backdrop-blur-sm z-20">
        <div className="px-2 sm:px-4 py-2 sm:py-3 flex items-center gap-1.5 sm:gap-3">
          {/* Left section: Logo + toggle */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Logo size="sm" showText={false} />
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
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {isSidebarCollapsed ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    )}
                  </svg>
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

          {/* Right section: Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            {isAdmin && (
              <div className="hidden md:block">
                <Suspense fallback={<Button variant="outline" size="sm" disabled>Invite</Button>}>
                  <InviteModal
                    trigger={
                      <Button variant="outline" size="sm">
                        Invite
                      </Button>
                    }
                  />
                </Suspense>
              </div>
            )}
            <ThemeToggle />
            <NotificationBell />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Content area with sidebar and main */}
      <div className="flex-1 min-h-0">
        <Group orientation="horizontal" id="dashboard-sidebar" style={{ height: '100%' }}>
          {showSidebar && (
            <>
              <Panel
                id="sidebar"
                defaultSize={18}
                minSize={5}
                maxSize={50}
                className="hidden md:flex"
                onResize={(size) => setSidebarSize(size)}
              >
                <Sidebar
                  filter={filter}
                  onFilterChange={onFilterChange}
                  directories={directories}
                  directoryFilter={directoryFilter}
                  onDirectoryFilterChange={onDirectoryFilterChange}
                  isMobileOpen={isMobileSidebarOpen}
                  onMobileClose={() => setIsMobileSidebarOpen(false)}
                  isNarrow={sidebarSize < 12}
                />
              </Panel>
              <Separator className="w-[2px] bg-sol-border/50 hover:bg-sol-cyan/60 active:bg-sol-cyan transition-colors hidden md:flex items-center justify-center cursor-col-resize" />
            </>
          )}
          <Panel id="main" style={{ overflow: 'auto' }}>
            <div className="h-full overflow-y-auto px-4 sm:px-6 lg:px-8 py-4">
              <div className="max-w-6xl mx-auto">
                {children}
              </div>
            </div>
          </Panel>
        </Group>
      </div>

      {/* Mobile sidebar overlay */}
      {isMobileSidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <Sidebar
            filter={filter}
            onFilterChange={onFilterChange}
            directories={directories}
            directoryFilter={directoryFilter}
            onDirectoryFilterChange={onDirectoryFilterChange}
            isMobileOpen={isMobileSidebarOpen}
            onMobileClose={() => setIsMobileSidebarOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
