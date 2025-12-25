"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TimelineFeed } from "../../components/TimelineFeed";

function SyncButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [repos, setRepos] = useState<Array<{ full_name: string; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getRepos = useAction(api.commits.getMyRepositories);
  const syncCommits = useAction(api.commits.syncMyRepositoryCommits);

  const loadRepos = async () => {
    setError(null);
    try {
      const result = await getRepos({});
      setRepos(result);
    } catch (e: any) {
      setError(e.message || "Failed to load repositories");
    }
  };

  const handleSync = async (repo: string) => {
    setSyncing(repo);
    setError(null);
    try {
      const result = await syncCommits({ repository: repo, per_page: 50 });
      alert(`Synced ${result.synced} commits from ${repo}`);
    } catch (e: any) {
      setError(e.message || "Failed to sync");
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen && !repos) {
            loadRepos();
          }
        }}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-sol-violet/20 hover:bg-sol-violet/30 text-sol-violet border border-sol-violet/30 rounded-lg transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Sync GitHub
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-sol-border rounded-xl shadow-lg z-50 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-sol-text">Sync Commits</h3>
            <button onClick={() => setIsOpen(false)} className="text-sol-text-muted hover:text-sol-text">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {error && (
            <div className="text-sm text-sol-red bg-sol-red/10 border border-sol-red/20 rounded-lg p-2 mb-3">
              {error}
            </div>
          )}

          {!repos ? (
            <div className="text-sm text-sol-text-muted text-center py-4">Loading repositories...</div>
          ) : repos.length === 0 ? (
            <div className="text-sm text-sol-text-muted text-center py-4">No repositories found. Make sure your GitHub account is connected.</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {repos.map((repo) => (
                <button
                  key={repo.full_name}
                  onClick={() => handleSync(repo.full_name)}
                  disabled={syncing !== null}
                  className="w-full flex items-center justify-between p-2 text-sm bg-sol-bg-alt/30 hover:bg-sol-bg-alt/50 rounded-lg transition-colors disabled:opacity-50"
                >
                  <span className="font-mono text-sol-text truncate">{repo.name}</span>
                  {syncing === repo.full_name ? (
                    <span className="text-sol-text-muted">Syncing...</span>
                  ) : (
                    <svg className="w-4 h-4 text-sol-violet" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
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
        directories={[]}
        directoryFilter={null}
        onDirectoryFilterChange={() => {}}
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
