"use client";
import { ReactNode } from "react";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";

interface DashboardLayoutProps {
  children: ReactNode;
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-white tracking-tight">
            codecast
          </h1>
          <UserMenu />
        </div>
      </header>
      <div className="flex">
        <Sidebar />
        <main className="flex-1 max-w-5xl mx-auto px-4 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
