"use client";

import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationList } from "../../components/ConversationList";

export default function DashboardPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");

  return (
    <AuthGuard>
      <DashboardLayout>
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
      </DashboardLayout>
    </AuthGuard>
  );
}
