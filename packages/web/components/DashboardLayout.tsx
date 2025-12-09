"use client";
import { ReactNode } from "react";
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
  const user = useQuery(api.users.getCurrentUser);
  const team = useQuery(
    api.teams.getTeam,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg">
      <header className="border-b border-sol-border bg-sol-bg-alt/50 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <h1 className="text-xl font-semibold text-sol-text tracking-tight whitespace-nowrap">
            codecast
          </h1>
          <GlobalSearch />
          <InviteModal
            trigger={
              <Button variant="outline" size="sm">
                Invite
              </Button>
            }
          />
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <div className="flex">
        <Sidebar
          filter={filter}
          onFilterChange={onFilterChange}
          directories={directories}
          directoryFilter={directoryFilter}
          onDirectoryFilterChange={onDirectoryFilterChange}
        />
        <main className="flex-1 min-w-0 max-w-5xl mx-auto px-4 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
