import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { MessageFeed } from "../../components/MessageFeed";

export default function FeedPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");

  return (
    <AuthGuard>
      <DashboardLayout
        filter={filter}
        onFilterChange={setFilter}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-sol-text">Message Feed</h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilter("my")}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  filter === "my"
                    ? "bg-sol-blue/20 text-sol-blue border border-sol-blue/30"
                    : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
                }`}
              >
                My Messages
              </button>
              <button
                onClick={() => setFilter("team")}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  filter === "team"
                    ? "bg-sol-violet/20 text-sol-violet border border-sol-violet/30"
                    : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
                }`}
              >
                Team
              </button>
            </div>
          </div>
          <p className="text-sol-text-muted text-sm">
            All messages across your sessions in chronological order.
          </p>
          <MessageFeed filter={filter} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
