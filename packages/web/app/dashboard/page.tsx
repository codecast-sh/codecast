"use client";

import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { LogoutButton } from "../../components/LogoutButton";
import { ConversationList } from "../../components/ConversationList";

export default function DashboardPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");

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
          <div className="flex gap-4 mb-6">
            <button
              onClick={() => setFilter("my")}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                filter === "my"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              My Conversations
            </button>
            <button
              onClick={() => setFilter("team")}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                filter === "team"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              Team
            </button>
          </div>

          <ConversationList filter={filter} />
        </div>
      </main>
    </AuthGuard>
  );
}
