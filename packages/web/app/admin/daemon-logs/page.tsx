export const dynamic = "force-dynamic";

import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { AuthGuard } from "../../../components/AuthGuard";
import Link from "next/link";

type LogLevel = "debug" | "info" | "warn" | "error";
type Command = "status" | "restart" | "force_update" | "version";

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const LEVEL_STYLES: Record<LogLevel, { bg: string; text: string; dot: string }> = {
  error: { bg: "bg-red-950/60", text: "text-red-400", dot: "bg-red-500" },
  warn: { bg: "bg-amber-950/40", text: "text-amber-400", dot: "bg-amber-500" },
  info: { bg: "bg-sky-950/30", text: "text-sky-400", dot: "bg-sky-500" },
  debug: { bg: "bg-zinc-800/40", text: "text-zinc-500", dot: "bg-zinc-600" },
};

function LogLevelDot({ level }: { level: LogLevel }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 mt-[7px] ${LEVEL_STYLES[level].dot}`}
      title={level.toUpperCase()}
    />
  );
}

function CommandPanel({
  userId,
  userName,
  isOnline,
}: {
  userId: Id<"users">;
  userName: string;
  isOnline: boolean;
}) {
  const sendCommand = useMutation(api.users.sendDaemonCommand);
  const commands = useQuery(api.users.getPendingCommands, { user_id: userId });
  const [sending, setSending] = useState<Command | null>(null);
  const [expandedCmd, setExpandedCmd] = useState<string | null>(null);

  const handleSend = useCallback(
    async (command: Command) => {
      setSending(command);
      try {
        await sendCommand({ user_id: userId, command });
      } catch (e) {
        console.error("Failed to send command:", e);
      } finally {
        setTimeout(() => setSending(null), 500);
      }
    },
    [sendCommand, userId]
  );

  const recentCommands = useMemo(() => {
    if (!commands) return [];
    return commands.slice(0, 20);
  }, [commands]);

  const commandButtons: { cmd: Command; label: string; desc: string; destructive?: boolean }[] = [
    { cmd: "status", label: "Status", desc: "Health check" },
    { cmd: "version", label: "Version", desc: "Get version" },
    { cmd: "restart", label: "Restart", desc: "Restart daemon", destructive: true },
    { cmd: "force_update", label: "Force Update", desc: "Update + restart", destructive: true },
  ];

  return (
    <div className="bg-zinc-900/80 rounded-lg border border-zinc-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono uppercase tracking-wider text-zinc-500">
            Remote Control
          </span>
          <span className="text-xs text-zinc-600">/</span>
          <span className="text-sm text-zinc-300">{userName}</span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            isOnline
              ? "bg-emerald-950/50 text-emerald-400 border border-emerald-800/50"
              : "bg-zinc-800 text-zinc-500 border border-zinc-700"
          }`}
        >
          {isOnline ? "connected" : "offline"}
        </span>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-4 gap-2">
          {commandButtons.map(({ cmd, label, desc, destructive }) => (
            <button
              key={cmd}
              onClick={() => handleSend(cmd)}
              disabled={sending !== null}
              className={`group relative px-3 py-2.5 rounded-md text-left transition-all ${
                destructive
                  ? "bg-zinc-800/60 hover:bg-red-950/40 border border-zinc-700/50 hover:border-red-800/50"
                  : "bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700/50 hover:border-zinc-600"
              } ${sending === cmd ? "opacity-60" : ""} disabled:cursor-not-allowed`}
            >
              <div
                className={`text-sm font-medium ${
                  destructive ? "text-zinc-300 group-hover:text-red-300" : "text-zinc-300"
                }`}
              >
                {sending === cmd ? "..." : label}
              </div>
              <div className="text-[11px] text-zinc-500 mt-0.5">{desc}</div>
            </button>
          ))}
        </div>
      </div>

      {recentCommands.length > 0 && (
        <div className="border-t border-zinc-800">
          <div className="px-4 py-2 flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">
              Command History
            </span>
            <span className="text-[11px] text-zinc-600">{recentCommands.length} recent</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {recentCommands.map((cmd) => {
              const isPending = !cmd.executed_at;
              const hasError = !!cmd.error;
              const isExpanded = expandedCmd === cmd._id;

              return (
                <div
                  key={cmd._id}
                  className={`px-4 py-2 border-t border-zinc-800/50 cursor-pointer transition-colors ${
                    isExpanded ? "bg-zinc-800/40" : "hover:bg-zinc-800/20"
                  }`}
                  onClick={() => setExpandedCmd(isExpanded ? null : cmd._id)}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        isPending
                          ? "bg-amber-500 animate-pulse"
                          : hasError
                            ? "bg-red-500"
                            : "bg-emerald-500"
                      }`}
                    />
                    <span className="text-xs font-mono text-zinc-300 w-24">
                      {cmd.command}
                    </span>
                    <span className="text-[11px] text-zinc-600 flex-1">
                      {formatRelativeTime(cmd.created_at)}
                    </span>
                    {isPending && (
                      <span className="text-[11px] text-amber-500/80">waiting...</span>
                    )}
                    {cmd.executed_at && !hasError && (
                      <span className="text-[11px] text-zinc-600">
                        {Math.round((cmd.executed_at - cmd.created_at) / 1000)}s
                      </span>
                    )}
                    {hasError && (
                      <span className="text-[11px] text-red-400">failed</span>
                    )}
                  </div>
                  {isExpanded && (cmd.result || cmd.error) && (
                    <pre className="mt-2 ml-[18px] p-3 bg-zinc-950 rounded text-[11px] leading-relaxed font-mono text-zinc-400 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto border border-zinc-800/50">
                      {(() => {
                        const raw = cmd.error || cmd.result || "";
                        try {
                          return JSON.stringify(JSON.parse(raw), null, 2);
                        } catch {
                          return raw;
                        }
                      })()}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UserListItem({
  user,
  isSelected,
  onClick,
}: {
  user: any;
  isSelected: boolean;
  onClick: () => void;
}) {
  const lastSeen = user.last_heartbeat ?? user.lastLog;
  const isOnline = Date.now() - lastSeen < 10 * 60 * 1000;
  const isStale = !isOnline && Date.now() - lastSeen > 24 * 60 * 60 * 1000;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-all ${
        isSelected
          ? "bg-sky-950/50 border border-sky-800/40 text-white"
          : "text-zinc-300 hover:bg-zinc-800/60 border border-transparent"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            isOnline ? "bg-emerald-500" : isStale ? "bg-zinc-700" : "bg-zinc-600"
          }`}
        />
        <span className="truncate flex-1 min-w-0">
          {user.email || user.name || "Unknown"}
        </span>
        <div className="flex gap-1 shrink-0">
          {user.errorCount > 0 && (
            <span className="px-1.5 py-0.5 bg-red-950/50 text-red-400 rounded text-[11px] font-mono border border-red-900/30">
              {user.errorCount}
            </span>
          )}
          {user.warnCount > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-950/50 text-amber-400 rounded text-[11px] font-mono border border-amber-900/30">
              {user.warnCount}
            </span>
          )}
        </div>
      </div>
      <div className="ml-[18px] mt-1 flex items-center gap-2">
        <span
          className={`text-[11px] ${
            isStale ? "text-red-400/70" : isOnline ? "text-zinc-500" : "text-amber-500/70"
          }`}
        >
          {formatRelativeTime(lastSeen)}
        </span>
        {user.cli_version && (
          <>
            <span className="text-zinc-700 text-[11px]">|</span>
            <span className="text-[11px] text-zinc-600">
              v{user.cli_version}
            </span>
          </>
        )}
        {user.cli_platform && (
          <>
            <span className="text-zinc-700 text-[11px]">|</span>
            <span className="text-[11px] text-zinc-600">{user.cli_platform}</span>
          </>
        )}
      </div>
    </button>
  );
}

interface HealthMetric {
  timestamp: number;
  rss_mb: number;
  heap_mb: number;
  heap_max_mb: number;
  fds: number;
  uptime_min: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
}

const HEALTH_RE = /rss=(\d+)MB heap=(\d+)\/(\d+)MB fds=(\d+) cpu=(\d+)\+(\d+)ms uptime=(\d+)min/;

function parseHealthMetrics(logs: { message: string; timestamp: number }[]): HealthMetric[] {
  const metrics: HealthMetric[] = [];
  for (const log of logs) {
    const m = HEALTH_RE.exec(log.message);
    if (m) {
      metrics.push({
        timestamp: log.timestamp,
        rss_mb: parseInt(m[1]),
        heap_mb: parseInt(m[2]),
        heap_max_mb: parseInt(m[3]),
        fds: parseInt(m[4]),
        cpu_user_ms: parseInt(m[5]),
        cpu_system_ms: parseInt(m[6]),
        uptime_min: parseInt(m[7]),
      });
    }
  }
  return metrics.sort((a, b) => a.timestamp - b.timestamp);
}

const FD_WARN = 5000;
const RSS_WARN = 1500;

function MetricsChart({ logs }: { logs: { message: string; timestamp: number }[] }) {
  const metrics = useMemo(() => parseHealthMetrics(logs), [logs]);

  if (metrics.length < 2) {
    return (
      <div className="bg-zinc-900/60 rounded-lg border border-zinc-800/60 px-4 py-6 text-center">
        <span className="text-[11px] font-mono text-zinc-600">Collecting metrics...</span>
      </div>
    );
  }

  const latest = metrics[metrics.length - 1];
  const W = 600;
  const H = 100;
  const PAD = { top: 8, right: 8, bottom: 8, left: 8 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const rssMax = Math.max(...metrics.map((m) => m.rss_mb), RSS_WARN * 0.5);
  const fdMax = Math.max(...metrics.map((m) => m.fds), FD_WARN * 0.5);
  const tMin = metrics[0].timestamp;
  const tMax = metrics[metrics.length - 1].timestamp;
  const tRange = tMax - tMin || 1;

  const showRssWarn = rssMax >= RSS_WARN * 0.8;
  const showFdWarn = fdMax >= FD_WARN * 0.8;

  const x = (t: number) => PAD.left + ((t - tMin) / tRange) * cw;
  const yRss = (v: number) => PAD.top + ch - (v / (rssMax * 1.15)) * ch;
  const yFd = (v: number) => PAD.top + ch - (v / (fdMax * 1.15)) * ch;

  const rssPoints = metrics.map((m) => `${x(m.timestamp)},${yRss(m.rss_mb)}`).join(" ");
  const rssAreaPoints = `${x(tMin)},${PAD.top + ch} ${rssPoints} ${x(tMax)},${PAD.top + ch}`;
  const fdPoints = metrics.map((m) => `${x(m.timestamp)},${yFd(m.fds)}`).join(" ");

  return (
    <div className="bg-zinc-900/60 rounded-lg border border-zinc-800/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800/60 flex items-center justify-between">
        <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">
          System Metrics
        </span>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-1 rounded-sm bg-sky-500/60" />
            <span className="text-zinc-500">RSS</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 rounded-sm bg-amber-500" />
            <span className="text-zinc-500">FDs</span>
          </span>
        </div>
      </div>
      <div className="px-4 py-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }} preserveAspectRatio="none">
          <polygon points={rssAreaPoints} fill="rgba(56,189,248,0.12)" />
          <polyline points={rssPoints} fill="none" stroke="rgba(56,189,248,0.5)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <polyline points={fdPoints} fill="none" stroke="rgba(245,158,11,0.7)" strokeWidth="1.5" strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
          {showRssWarn && (
            <line
              x1={PAD.left} y1={yRss(RSS_WARN)}
              x2={PAD.left + cw} y2={yRss(RSS_WARN)}
              stroke="rgba(239,68,68,0.4)" strokeWidth="1" strokeDasharray="6 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {showFdWarn && (
            <line
              x1={PAD.left} y1={yFd(FD_WARN)}
              x2={PAD.left + cw} y2={yFd(FD_WARN)}
              stroke="rgba(239,68,68,0.3)" strokeWidth="1" strokeDasharray="6 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {metrics.map((m, i) => (
            <circle key={i} cx={x(m.timestamp)} cy={yRss(m.rss_mb)} r="2" fill="rgba(56,189,248,0.7)" />
          ))}
        </svg>
      </div>
      <div className="px-4 py-2.5 border-t border-zinc-800/60 flex items-center gap-6 text-[11px] font-mono">
        <span className="text-zinc-500">
          RSS <span className={`${latest.rss_mb >= RSS_WARN ? "text-red-400" : "text-sky-400"}`}>{latest.rss_mb}MB</span>
        </span>
        <span className="text-zinc-500">
          Heap <span className="text-zinc-300">{latest.heap_mb}/{latest.heap_max_mb}MB</span>
        </span>
        <span className="text-zinc-500">
          FDs <span className={`${latest.fds >= FD_WARN ? "text-red-400" : "text-amber-400"}`}>{latest.fds}</span>
        </span>
        <span className="text-zinc-500">
          Uptime <span className="text-zinc-300">{latest.uptime_min >= 60 ? `${Math.round(latest.uptime_min / 60)}h` : `${latest.uptime_min}m`}</span>
        </span>
      </div>
    </div>
  );
}

function AdminDaemonLogs() {
  const [selectedUserId, setSelectedUserId] = useState<Id<"users"> | undefined>();
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [timeFilter, setTimeFilter] = useState<"1h" | "24h" | "7d" | "all">("24h");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCommands, setShowCommands] = useState(true);

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

  const selectedUser = useMemo(() => {
    if (!selectedUserId || !users) return null;
    return users.find((u) => u?._id === selectedUserId) ?? null;
  }, [selectedUserId, users]);

  const userStatus = useMemo(() => {
    if (!users) return { online: 0, total: 0 };
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000;
    let online = 0;
    for (const user of users) {
      if (!user) continue;
      const lastSeen = user.last_heartbeat ?? user.lastLog;
      if (now - lastSeen < staleThreshold) online++;
    }
    return { online, total: users.filter(Boolean).length };
  }, [users]);

  if (logsResult === undefined) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-zinc-500 font-mono text-sm">loading...</div>
      </div>
    );
  }

  if (!logsResult.isAdmin) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-medium text-red-400 mb-2">Access Denied</h1>
          <p className="text-zinc-500 text-sm">You do not have permission to view this page.</p>
        </div>
      </div>
    );
  }

  const timeButtons = [
    { value: "1h", label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "all", label: "all" },
  ] as const;

  const levelButtons = [
    { value: "all", label: "All" },
    { value: "error", label: "Err" },
    { value: "warn", label: "Warn" },
    { value: "info", label: "Info" },
    { value: "debug", label: "Debug" },
  ] as const;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/inbox" className="text-zinc-500 hover:text-zinc-300 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-lg font-medium tracking-tight">Daemon Admin</h1>
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span>
                <span className="text-emerald-500">{userStatus.online}</span>/{userStatus.total}{" "}
                online
              </span>
              <span className="text-zinc-700">|</span>
              <span>{filteredLogs.length} logs</span>
            </div>
          </div>
        </div>

        {/* Stats row */}
        {stats && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: "1h", data: stats.lastHour },
              { label: "24h", data: stats.lastDay },
              { label: "7d", data: stats.lastWeek },
            ].map(({ label, data }) => (
              <div
                key={label}
                className="bg-zinc-900/60 rounded-lg px-4 py-3 border border-zinc-800/60"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">
                    {label}
                  </span>
                  <span className="text-[11px] text-zinc-600">{data.uniqueUsers} users</span>
                </div>
                <div className="text-2xl font-light text-zinc-200 mt-1 tabular-nums">
                  {data.total.toLocaleString()}
                </div>
                <div className="flex gap-3 mt-1.5 text-[11px]">
                  {data.error > 0 && <span className="text-red-400">{data.error} err</span>}
                  {data.warn > 0 && <span className="text-amber-400">{data.warn} warn</span>}
                  {data.error === 0 && data.warn === 0 && (
                    <span className="text-zinc-600">clean</span>
                  )}
                </div>
              </div>
            ))}
            <div className="bg-zinc-900/60 rounded-lg px-4 py-3 border border-zinc-800/60">
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">
                Top Errors
              </span>
              {stats.topErrors.length === 0 ? (
                <div className="text-[11px] text-zinc-600 mt-2">No errors</div>
              ) : (
                <div className="space-y-1.5 mt-2">
                  {stats.topErrors.slice(0, 3).map((err, i) => (
                    <div
                      key={i}
                      className="text-[11px] text-zinc-500 truncate"
                      title={err.message}
                    >
                      <span className="text-red-400/80 font-mono mr-1.5">{err.count}x</span>
                      {err.message.slice(0, 50)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-[260px_1fr] gap-4">
          {/* Sidebar */}
          <div className="space-y-3">
            {/* User list */}
            <div className="bg-zinc-900/60 rounded-lg border border-zinc-800/60 overflow-hidden">
              <div className="px-3 py-2.5 border-b border-zinc-800/60">
                <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">
                  Users
                </span>
              </div>
              <div className="p-1.5 space-y-0.5 max-h-[calc(100vh-380px)] overflow-y-auto">
                <button
                  onClick={() => setSelectedUserId(undefined)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-all ${
                    !selectedUserId
                      ? "bg-sky-950/50 border border-sky-800/40 text-white"
                      : "text-zinc-400 hover:bg-zinc-800/60 border border-transparent"
                  }`}
                >
                  All Users
                </button>
                {users?.map((user) =>
                  user ? (
                    <UserListItem
                      key={user._id}
                      user={user}
                      isSelected={selectedUserId === user._id}
                      onClick={() => setSelectedUserId(user._id as Id<"users">)}
                    />
                  ) : null
                )}
              </div>
            </div>
          </div>

          {/* Main content */}
          <div className="space-y-4">
            {/* Command panel - shown when a specific user is selected */}
            {selectedUser && showCommands && (
              <CommandPanel
                userId={selectedUserId!}
                userName={selectedUser.email || selectedUser.name || "Unknown"}
                isOnline={
                  Date.now() - ((selectedUser as any).last_heartbeat ?? 0) < 10 * 60 * 1000
                }
              />
            )}

            {/* Metrics chart - shown when a specific user is selected */}
            {selectedUser && (
              <MetricsChart logs={filteredLogs} />
            )}

            {/* Filters + Toggle */}
            <div className="flex items-center gap-3">
              {/* Search */}
              <div className="flex-1 relative">
                <input
                  type="text"
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-800/60 rounded-md text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 font-mono"
                />
              </div>

              {/* Level filter */}
              <div className="flex rounded-md border border-zinc-800/60 overflow-hidden">
                {levelButtons.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setLevelFilter(value)}
                    className={`px-2.5 py-2 text-[11px] font-mono transition-colors ${
                      levelFilter === value
                        ? value === "error"
                          ? "bg-red-950/50 text-red-400"
                          : value === "warn"
                            ? "bg-amber-950/50 text-amber-400"
                            : "bg-zinc-800 text-zinc-200"
                        : "bg-zinc-900/40 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Time filter */}
              <div className="flex rounded-md border border-zinc-800/60 overflow-hidden">
                {timeButtons.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setTimeFilter(value)}
                    className={`px-2.5 py-2 text-[11px] font-mono transition-colors ${
                      timeFilter === value
                        ? "bg-zinc-800 text-zinc-200"
                        : "bg-zinc-900/40 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Toggle commands panel */}
              {selectedUserId && (
                <button
                  onClick={() => setShowCommands(!showCommands)}
                  className={`px-2.5 py-2 text-[11px] font-mono rounded-md border transition-colors ${
                    showCommands
                      ? "bg-sky-950/40 text-sky-400 border-sky-800/40"
                      : "bg-zinc-900/40 text-zinc-500 border-zinc-800/60 hover:text-zinc-300"
                  }`}
                  title="Toggle remote commands panel"
                >
                  RPC
                </button>
              )}
            </div>

            {/* Logs */}
            <div className="bg-zinc-900/40 rounded-lg border border-zinc-800/60 overflow-hidden">
              <div className="max-h-[calc(100vh-420px)] overflow-y-auto divide-y divide-zinc-800/40">
                {filteredLogs.length === 0 ? (
                  <div className="p-12 text-center text-zinc-600 text-sm">
                    No logs matching filters
                  </div>
                ) : (
                  filteredLogs.map((log) => {
                    const user = userMap.get(log.user_id);
                    const style = LEVEL_STYLES[log.level as LogLevel] || LEVEL_STYLES.debug;
                    const isToday =
                      new Date(log.timestamp).toDateString() === new Date().toDateString();

                    return (
                      <div
                        key={log._id}
                        className={`px-4 py-2.5 hover:bg-zinc-800/30 transition-colors ${
                          log.level === "error" ? "bg-red-950/10" : ""
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <LogLevelDot level={log.level as LogLevel} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-0.5">
                              <span className="text-zinc-400 font-medium">
                                {user?.email?.split("@")[0] || "?"}
                              </span>
                              <span className="text-zinc-700">
                                {!isToday && `${formatDate(log.timestamp)} `}
                                {formatTimestamp(log.timestamp)}
                              </span>
                              {log.daemon_version && (
                                <span className="text-zinc-700">v{log.daemon_version}</span>
                              )}
                            </div>
                            <pre className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words font-mono leading-relaxed">
                              {log.message}
                            </pre>
                            {log.metadata?.error_code && (
                              <span
                                className={`inline-block mt-1 text-[11px] font-mono px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}
                              >
                                {log.metadata.error_code}
                              </span>
                            )}
                            {log.metadata?.session_id && (
                              <div className="mt-0.5 text-[11px] text-zinc-600 font-mono">
                                session: {log.metadata.session_id.slice(0, 12)}...
                              </div>
                            )}
                            {log.metadata?.stack && (
                              <details className="mt-1.5">
                                <summary className="text-[11px] text-zinc-600 cursor-pointer hover:text-zinc-400 font-mono">
                                  stack trace
                                </summary>
                                <pre className="mt-1.5 p-2.5 bg-zinc-950 rounded text-[11px] text-zinc-500 overflow-x-auto font-mono border border-zinc-800/50 leading-relaxed">
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
