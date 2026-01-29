"use client";

import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { AuthGuard } from "../../../components/AuthGuard";

type LogLevel = "debug" | "info" | "warn" | "error";

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function LogLevelBadge({ level }: { level: LogLevel }) {
  const colors = {
    debug: "bg-gray-600 text-gray-100",
    info: "bg-blue-600 text-blue-100",
    warn: "bg-yellow-600 text-yellow-100",
    error: "bg-red-600 text-red-100",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono ${colors[level]}`}>
      {level.toUpperCase()}
    </span>
  );
}

function AdminDaemonLogs() {
  const [selectedUserId, setSelectedUserId] = useState<Id<"users"> | undefined>();
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [timeFilter, setTimeFilter] = useState<"1h" | "24h" | "7d" | "all">("24h");
  const [searchQuery, setSearchQuery] = useState("");

  const sinceTimestamp = useMemo(() => {
    const now = Date.now();
    switch (timeFilter) {
      case "1h":
        return now - 60 * 60 * 1000;
      case "24h":
        return now - 24 * 60 * 60 * 1000;
      case "7d":
        return now - 7 * 24 * 60 * 60 * 1000;
      default:
        return undefined;
    }
  }, [timeFilter]);

  const users = useQuery(api.daemonLogs.adminGetUsers);
  const logsResult = useQuery(api.daemonLogs.adminList, {
    limit: 500,
    level: levelFilter === "all" ? undefined : levelFilter,
    userId: selectedUserId,
    since: sinceTimestamp,
  });
  const stats = useQuery(api.daemonLogs.adminGetStats);

  const filteredLogs = useMemo(() => {
    if (!logsResult?.logs) return [];
    if (!searchQuery.trim()) return logsResult.logs;
    const q = searchQuery.toLowerCase();
    return logsResult.logs.filter(
      (log) =>
        log.message.toLowerCase().includes(q) ||
        log.metadata?.error_code?.toLowerCase().includes(q) ||
        log.metadata?.session_id?.toLowerCase().includes(q)
    );
  }, [logsResult?.logs, searchQuery]);

  const userMap = useMemo(() => {
    const map = new Map<string, { email?: string; name?: string }>();
    if (logsResult?.users) {
      for (const u of logsResult.users) {
        if (u) map.set(u._id, { email: u.email, name: u.name });
      }
    }
    return map;
  }, [logsResult?.users]);

  if (!logsResult?.isAdmin) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-500 mb-2">Access Denied</h1>
          <p className="text-gray-400">You do not have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Daemon Logs</h1>
            <p className="text-gray-400 mt-1">Monitor daemon errors and warnings across all users</p>
          </div>
          <div className="text-sm text-gray-500">
            {filteredLogs.length} logs shown
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <div className="text-xs text-gray-500 uppercase mb-1">Last Hour</div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{stats.lastHour.total}</span>
                <span className="text-xs text-gray-500">{stats.lastHour.uniqueUsers} users</span>
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                {stats.lastHour.error > 0 && (
                  <span className="text-red-400">{stats.lastHour.error} err</span>
                )}
                {stats.lastHour.warn > 0 && (
                  <span className="text-yellow-400">{stats.lastHour.warn} warn</span>
                )}
              </div>
            </div>
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <div className="text-xs text-gray-500 uppercase mb-1">Last 24h</div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{stats.lastDay.total}</span>
                <span className="text-xs text-gray-500">{stats.lastDay.uniqueUsers} users</span>
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                {stats.lastDay.error > 0 && (
                  <span className="text-red-400">{stats.lastDay.error} err</span>
                )}
                {stats.lastDay.warn > 0 && (
                  <span className="text-yellow-400">{stats.lastDay.warn} warn</span>
                )}
              </div>
            </div>
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <div className="text-xs text-gray-500 uppercase mb-1">Last 7d</div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{stats.lastWeek.total}</span>
                <span className="text-xs text-gray-500">{stats.lastWeek.uniqueUsers} users</span>
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                {stats.lastWeek.error > 0 && (
                  <span className="text-red-400">{stats.lastWeek.error} err</span>
                )}
                {stats.lastWeek.warn > 0 && (
                  <span className="text-yellow-400">{stats.lastWeek.warn} warn</span>
                )}
              </div>
            </div>
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <div className="text-xs text-gray-500 uppercase mb-1">Top Errors</div>
              {stats.topErrors.length === 0 ? (
                <div className="text-xs text-gray-600">No errors</div>
              ) : (
                <div className="space-y-1 mt-1">
                  {stats.topErrors.slice(0, 3).map((err, i) => (
                    <div key={i} className="text-xs text-gray-400 truncate" title={err.message}>
                      <span className="text-red-400 font-mono mr-1">{err.count}x</span>
                      {err.message.slice(0, 40)}...
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
          <div className="lg:col-span-1 bg-gray-900 rounded-lg p-4 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase mb-3">Users</h2>
            <div className="space-y-1">
              <button
                onClick={() => setSelectedUserId(undefined)}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  !selectedUserId
                    ? "bg-blue-600 text-white"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                All Users
              </button>
              {users?.map((user) =>
                user ? (
                  <button
                    key={user._id}
                    onClick={() => setSelectedUserId(user._id as Id<"users">)}
                    className={`w-full text-left px-3 py-2 rounded text-sm ${
                      selectedUserId === user._id
                        ? "bg-blue-600 text-white"
                        : "text-gray-300 hover:bg-gray-800"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate">{user.email || user.name || "Unknown"}</span>
                      <div className="flex gap-1 ml-2">
                        {user.errorCount > 0 && (
                          <span className="px-1.5 py-0.5 bg-red-600/30 text-red-400 rounded text-xs">
                            {user.errorCount}
                          </span>
                        )}
                        {user.warnCount > 0 && (
                          <span className="px-1.5 py-0.5 bg-yellow-600/30 text-yellow-400 rounded text-xs">
                            {user.warnCount}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {formatRelativeTime(user.lastLog)}
                    </div>
                  </button>
                ) : null
              )}
            </div>
          </div>

          <div className="lg:col-span-3">
            <div className="bg-gray-900 rounded-lg border border-gray-800 mb-4">
              <div className="p-4 border-b border-gray-800 flex flex-wrap gap-4 items-center">
                <input
                  type="text"
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 min-w-[200px] px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <select
                  value={levelFilter}
                  onChange={(e) => setLevelFilter(e.target.value as LogLevel | "all")}
                  className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="all">All Levels</option>
                  <option value="error">Errors Only</option>
                  <option value="warn">Warnings Only</option>
                  <option value="info">Info Only</option>
                  <option value="debug">Debug Only</option>
                </select>
                <select
                  value={timeFilter}
                  onChange={(e) => setTimeFilter(e.target.value as "1h" | "24h" | "7d" | "all")}
                  className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="1h">Last Hour</option>
                  <option value="24h">Last 24 Hours</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="all">All Time</option>
                </select>
              </div>

              <div className="divide-y divide-gray-800 max-h-[70vh] overflow-y-auto">
                {filteredLogs.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    No logs found matching your filters
                  </div>
                ) : (
                  filteredLogs.map((log) => {
                    const user = userMap.get(log.user_id);
                    return (
                      <div key={log._id} className="p-4 hover:bg-gray-800/50">
                        <div className="flex items-start gap-3">
                          <LogLevelBadge level={log.level} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs text-gray-500">
                                {formatTimestamp(log.timestamp)}
                              </span>
                              <span className="text-xs text-gray-600">|</span>
                              <span className="text-xs text-blue-400 truncate">
                                {user?.email || user?.name || log.user_id}
                              </span>
                              {log.daemon_version && (
                                <>
                                  <span className="text-xs text-gray-600">|</span>
                                  <span className="text-xs text-gray-500">
                                    v{log.daemon_version}
                                  </span>
                                </>
                              )}
                              {log.platform && (
                                <>
                                  <span className="text-xs text-gray-600">|</span>
                                  <span className="text-xs text-gray-500">{log.platform}</span>
                                </>
                              )}
                            </div>
                            <pre className="text-sm text-gray-200 whitespace-pre-wrap break-words font-mono">
                              {log.message}
                            </pre>
                            {log.metadata?.error_code && (
                              <div className="mt-2 text-xs text-red-400">
                                Error: {log.metadata.error_code}
                              </div>
                            )}
                            {log.metadata?.session_id && (
                              <div className="mt-1 text-xs text-gray-500">
                                Session: {log.metadata.session_id}
                              </div>
                            )}
                            {log.metadata?.stack && (
                              <details className="mt-2">
                                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">
                                  Stack trace
                                </summary>
                                <pre className="mt-2 p-2 bg-gray-900 rounded text-xs text-gray-400 overflow-x-auto">
                                  {log.metadata.stack}
                                </pre>
                              </details>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminDaemonLogsPage() {
  return (
    <AuthGuard>
      <AdminDaemonLogs />
    </AuthGuard>
  );
}
