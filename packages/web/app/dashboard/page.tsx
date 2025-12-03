"use client";

import { AuthGuard } from "../../components/AuthGuard";
import { LogoutButton } from "../../components/LogoutButton";

export default function DashboardPage() {
  return (
    <AuthGuard>
      <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur">
          <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <h1 className="text-xl font-semibold text-white tracking-tight">
              code-chat-sync
            </h1>
            <LogoutButton />
          </div>
        </header>

        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="text-center py-16">
            <h2 className="text-2xl font-medium text-white mb-2">
              No conversations synced yet
            </h2>
            <p className="text-slate-400">
              Make sure the daemon is running: code-chat-sync status
            </p>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
