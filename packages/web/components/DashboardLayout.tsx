"use client";
import { ReactNode, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";
import { InviteModal } from "./InviteModal";
import { Button } from "./ui/button";

interface DashboardLayoutProps {
  children: ReactNode;
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directories?: string[];
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
}

export function DashboardLayout({ children, filter, onFilterChange, directories, directoryFilter, onDirectoryFilterChange }: DashboardLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const user = useQuery(api.users.getCurrentUser);
  const team = useQuery(
    api.teams.getTeam,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  const isAdmin = user?.role === "admin";

  return (
    <div className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg">
      <header className="border-b border-sol-border bg-sol-bg-alt/50 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-2 sm:px-4 py-2 sm:py-3 flex items-center gap-1.5 sm:gap-3">
          <button
            onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
            className="md:hidden p-1.5 sm:p-2 text-sol-text hover:text-sol-yellow transition-colors flex-shrink-0"
            aria-label="Toggle menu"
          >
            <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-base sm:text-lg md:text-xl font-semibold text-sol-text tracking-tight whitespace-nowrap flex-shrink-0">
            codecast
          </h1>
          <div className="hidden sm:block flex-1 min-w-0">
            <GlobalSearch />
          </div>
          {isAdmin && (
            <div className="hidden md:block flex-shrink-0">
              <InviteModal
                trigger={
                  <Button variant="outline" size="sm">
                    Invite
                  </Button>
                }
              />
            </div>
          )}
          <div className="flex-shrink-0">
            <ThemeToggle />
          </div>
          <div className="flex-shrink-0">
            <UserMenu />
          </div>
        </div>
      </header>
      <div className="flex">
        <Sidebar
          filter={filter}
          onFilterChange={onFilterChange}
          directories={directories}
          directoryFilter={directoryFilter}
          onDirectoryFilterChange={onDirectoryFilterChange}
          isMobileOpen={isMobileSidebarOpen}
          onMobileClose={() => setIsMobileSidebarOpen(false)}
        />
        <main className="flex-1 min-w-0 max-w-5xl mx-auto px-2 sm:px-3 md:px-4 py-3 sm:py-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
