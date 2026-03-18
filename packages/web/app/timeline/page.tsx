import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TimelineFeed } from "../../components/TimelineFeed";

function SyncButton() {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ repos_synced: number; total_commits: number } | null>(null);
  const syncAll = useAction(api.commits.syncAllMyRepositories);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const res = await syncAll({ per_page: 30 });
      setResult(res);
      setTimeout(() => setResult(null), 5000);
    } catch (e: any) {
      console.error("Sync failed:", e);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {result && (
        <span className="text-xs text-sol-green">
          Synced {result.total_commits} commits from {result.repos_synced} repos
        </span>
      )}
      <button
        onClick={handleSync}
        disabled={syncing}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-sol-violet/20 hover:bg-sol-violet/30 text-sol-violet border border-sol-violet/30 rounded-lg transition-colors disabled:opacity-50"
      >
        <svg
          className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        {syncing ? "Syncing..." : "Sync GitHub"}
      </button>
    </div>
  );
}

export default function TimelinePage() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [dateRange, setDateRange] = useState<{ start?: number; end?: number }>({});

  return (
    <AuthGuard>
      <DashboardLayout
        filter={filter}
        onFilterChange={setFilter}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-sol-text">Timeline</h1>
            <SyncButton />
          </div>
          <TimelineFeed filter={filter} dateRange={dateRange} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
