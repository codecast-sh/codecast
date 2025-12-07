"use client";
import { ReactNode } from "react";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";

interface DashboardLayoutProps {
  children: ReactNode;
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
}

export function DashboardLayout({ children, filter, onFilterChange }: DashboardLayoutProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 light:from-slate-100 light:via-white light:to-slate-100">
      <header className="border-b border-slate-700 light:border-slate-200 bg-slate-800/50 light:bg-white/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center">
          <h1 className="text-xl font-semibold text-white light:text-slate-900 tracking-tight whitespace-nowrap">
            codecast
          </h1>
          <GlobalSearch />
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <div className="flex">
        <Sidebar filter={filter} onFilterChange={onFilterChange} />
        <main className="flex-1 min-w-0 max-w-5xl mx-auto px-4 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
