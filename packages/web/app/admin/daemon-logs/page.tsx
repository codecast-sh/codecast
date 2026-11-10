export const dynamic = "force-dynamic";

import { useState, useMemo, useCallback, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { AuthGuard } from "../../../components/AuthGuard";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";

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
  error: { bg: "bg-sol-red/10", text: "text-sol-red", dot: "bg-sol-red" },
  warn: { bg: "bg-sol-amber/10", text: "text-sol-amber", dot: "bg-sol-amber" },
  info: { bg: "bg-sol-blue/10", text: "text-sol-blue", dot: "bg-sol-blue" },
  debug: { bg: "bg-sol-bg-highlight", text: "text-sol-text-muted", dot: "bg-sol-text-dim" },
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
  // Restart and Force update act on someone else's daemon: the press asks once, in place.
  const [arming, setArming] = useState<Command | null>(null);

  const handleSend = useCallback(
    async (command: Command) => {
      setSending(command);
      try {
        await sendCommand({ user_id: userId, command });
      } catch (e) {
        toast.error(`${command} did not go out: ${e instanceof Error ? e.message : String(e)}`);
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
    <div className="bg-sol-bg-alt rounded-lg border border-sol-border overflow-hidden">
      <div className="px-4 py-3 border-b border-sol-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono uppercase tracking-wider text-sol-text-muted">
            Remote Control
          </span>
          <span className="text-xs text-sol-text-dim">/</span>
          <span className="text-sm text-sol-text-secondary">{userName}</span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            isOnline
              ? "bg-sol-green/10 text-sol-green border border-sol-green/30"
              : "bg-sol-bg-highlight text-sol-text-muted border border-sol-border"
          }`}
        >
          {isOnline ? "connected" : "offline"}
        </span>
      </div>

      <div className="p-4">
        {arming && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-sol-red/30 bg-sol-red/10 px-3 py-2 text-xs" role="group" aria-label={`${arming} ${userName}'s daemon?`}>
            <span className="min-w-0 flex-1 truncate text-sol-text" title={userName}>
              {arming === "restart" ? "Restart" : "Force update"} {userName}&apos;s daemon?
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setArming(null)} autoFocus>Keep it running</Button>
            <Button type="button" variant="red" size="xs" onClick={() => { const cmd = arming; setArming(null); void handleSend(cmd); }}>
              {arming === "restart" ? "Restart" : "Force update"}
            </Button>
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
          {commandButtons.map(({ cmd, label, desc, destructive }) => (
            <button
              type="button"
              key={cmd}
              onClick={() => (destructive ? setArming(cmd) : handleSend(cmd))}
              disabled={sending !== null}
              className={`group relative px-3 py-2.5 rounded-md text-left transition-all ${
                destructive
                  ? "bg-sol-bg-highlight hover:bg-sol-red/10 border border-sol-border hover:border-sol-red/40"
                  : "bg-sol-bg-highlight hover:bg-sol-bg-highlight border border-sol-border hover:border-sol-text-dim"
              } ${sending === cmd ? "opacity-60" : ""} disabled:cursor-not-allowed`}
            >
              <div
                className={`text-sm font-medium ${
                  destructive ? "text-sol-text-secondary group-hover:text-sol-red" : "text-sol-text-secondary"
                }`}
              >
                {sending === cmd ? "..." : label}
              </div>
              <div className="text-meta text-sol-text-muted mt-0.5">{desc}</div>
            </button>
          ))}
        </div>
      </div>

      {recentCommands.length > 0 && (
        <div className="border-t border-sol-border">
          <div className="px-4 py-2 flex items-center justify-between">
            <span className="text-mark font-mono uppercase tracking-wider text-sol-text-dim">
              Command History
            </span>
            <span className="text-meta text-sol-text-dim">{recentCommands.length} recent</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {recentCommands.map((cmd) => {
              const isPending = !cmd.executed_at;
              const hasError = !!cmd.error;
              const isExpanded = expandedCmd === cmd._id;

              return (
                <div
                  key={cmd._id}
                  className={`px-4 py-2 border-t border-sol-border cursor-pointer transition-colors ${
                    isExpanded ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight"
                  }`}
                  onClick={() => setExpandedCmd(isExpanded ? null : cmd._id)}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        isPending
                          ? "bg-sol-amber animate-pulse"
                          : hasError
                            ? "bg-sol-red"
                            : "bg-sol-green"
                      }`}
                    />
                    <span className="text-xs font-mono text-sol-text-secondary w-24">
                      {cmd.command}
                    </span>
                    <span className="text-meta text-sol-text-dim flex-1">
                      {formatRelativeTime(cmd.created_at)}
                    </span>
                    {isPending && (
                      <span className="text-meta text-sol-amber">waiting...</span>
                    )}
                    {cmd.executed_at && !hasError && (
                      <span className="text-meta text-sol-text-dim">
                        {Math.round((cmd.executed_at - cmd.created_at) / 1000)}s
                      </span>
                    )}
                    {hasError && (
                      <span className="text-meta text-sol-red">failed</span>
                    )}
                  </div>
                  {isExpanded && (cmd.result || cmd.error) && (
                    <pre className="mt-2 ml-[18px] p-3 bg-sol-bg rounded text-meta leading-relaxed font-mono text-sol-text-muted whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
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

const PRESENCE_MS = 10 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

type AdminUser = NonNullable<FunctionReturnType<typeof api.daemonLogs.adminGetUsers>[number]>;

function lastSeenOf(user: { last_heartbeat?: number; lastLog?: number }): number {
  return Math.max(user.last_heartbeat ?? 0, user.lastLog ?? 0);
}

function isOnline(user: { last_heartbeat?: number; lastLog?: number }): boolean {
  return Date.now() - lastSeenOf(user) < PRESENCE_MS;
}

function labelOf(user: { email?: string; name?: string } | null | undefined): string {
  return user?.email || user?.name || "Unknown";
}

// Hold the last answer while a query re-runs on new args, so a filter change
// keeps the page (and its scroll) instead of blanking it.
function useHeld<T>(value: T | undefined): T | undefined {
  const held = useRef(value);
  if (value !== undefined) held.current = value;
  return held.current;
}

// An email whose local part truncates while the domain stays readable.
function EmailLabel({ text, className = "" }: { text: string; className?: string }) {
  const at = text.lastIndexOf("@");
  if (at <= 0) return <span className={`truncate ${className}`} title={text}>{text}</span>;
  return (
    <span className={`flex min-w-0 ${className}`} title={text}>
      <span className="truncate">{text.slice(0, at)}</span>
      <span className="shrink-0 opacity-60">{text.slice(at)}</span>
    </span>
  );
}

function CountBadge({ n, tone }: { n: number; tone: "error" | "warn" }) {
  if (n <= 0) return null;
  const cls = tone === "error"
    ? "bg-sol-red/10 text-sol-red border-sol-red/30"
    : "bg-sol-amber/10 text-sol-amber border-sol-amber/30";
  return <span className={`px-1.5 rounded text-meta leading-4 font-mono border tabular-nums ${cls}`}>{n}</span>;
}

function UserListItem({
  user,
  isSelected,
  onClick,
}: {
  user: AdminUser;
  isSelected: boolean;
  onClick: () => void;
}) {
  const lastSeen = lastSeenOf(user);
  const online = isOnline(user);
  const stale = !online && Date.now() - lastSeen > STALE_MS;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-2 rounded-md transition-colors border ${
        isSelected
          ? "bg-sol-blue/10 border-sol-blue/30 text-sol-text"
          : "text-sol-text-secondary hover:bg-sol-bg-highlight border-transparent"
      }`}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            online ? "bg-sol-green" : stale ? "bg-sol-text-dim/40" : "bg-sol-text-muted"
          }`}
        />
        <EmailLabel text={labelOf(user)} className="flex-1" />
      </div>
      <div className="ml-3.5 mt-0.5 flex items-center gap-1.5 text-meta text-sol-text-dim">
        <span className={`tabular-nums ${online ? "text-sol-text-muted" : stale ? "text-sol-text-dim" : "text-sol-amber"}`}>
          {lastSeen ? formatRelativeTime(lastSeen) : "never"}
        </span>
        {user.cli_version && <span>· <span className="modern:font-mono">v{user.cli_version}</span></span>}
        {user.cli_platform && <span>· {user.cli_platform}</span>}
        <span className="ml-auto flex gap-1">
          <CountBadge n={user.errorCount} tone="error" />
          <CountBadge n={user.warnCount} tone="warn" />
        </span>
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
      <div className="bg-sol-bg-alt rounded-lg border border-sol-border px-4 py-6 text-center">
        <span className="text-meta font-mono text-sol-text-dim">Collecting metrics...</span>
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
    <div className="bg-sol-bg-alt rounded-lg border border-sol-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-sol-border flex items-center justify-between">
        <span className="text-mark font-mono uppercase tracking-wider text-sol-text-dim">
          System Metrics
        </span>
        <div className="flex items-center gap-4 text-meta">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-1 rounded-sm bg-sol-blue/60" />
            <span className="text-sol-text-muted">RSS</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 rounded-sm bg-sol-amber" />
            <span className="text-sol-text-muted">FDs</span>
          </span>
        </div>
      </div>
      <div className="px-4 py-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }} preserveAspectRatio="none">
          <polygon points={rssAreaPoints} fill="var(--sol-blue)" fillOpacity={0.12} />
          <polyline points={rssPoints} fill="none" stroke="var(--sol-blue)" strokeOpacity={0.5} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <polyline points={fdPoints} fill="none" stroke="var(--sol-amber)" strokeOpacity={0.7} strokeWidth="1.5" strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
          {showRssWarn && (
            <line
              x1={PAD.left} y1={yRss(RSS_WARN)}
              x2={PAD.left + cw} y2={yRss(RSS_WARN)}
              stroke="var(--sol-red)" strokeOpacity={0.4} strokeWidth="1" strokeDasharray="6 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {showFdWarn && (
            <line
              x1={PAD.left} y1={yFd(FD_WARN)}
              x2={PAD.left + cw} y2={yFd(FD_WARN)}
              stroke="var(--sol-red)" strokeOpacity={0.3} strokeWidth="1" strokeDasharray="6 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {metrics.map((m, i) => (
            <circle key={i} cx={x(m.timestamp)} cy={yRss(m.rss_mb)} r="2" fill="var(--sol-blue)" fillOpacity={0.7} />
          ))}
        </svg>
      </div>
      <div className="px-4 py-2.5 border-t border-sol-border flex items-center gap-6 text-meta font-mono">
        <span className="text-sol-text-muted">
          RSS <span className={`${latest.rss_mb >= RSS_WARN ? "text-sol-red" : "text-sol-blue"}`}>{latest.rss_mb}MB</span>
        </span>
        <span className="text-sol-text-muted">
          Heap <span className="text-sol-text-secondary">{latest.heap_mb}/{latest.heap_max_mb}MB</span>
        </span>
        <span className="text-sol-text-muted">
          FDs <span className={`${latest.fds >= FD_WARN ? "text-sol-red" : "text-sol-amber"}`}>{latest.fds}</span>
        </span>
        <span className="text-sol-text-muted">
          Uptime <span className="text-sol-text-secondary">{latest.uptime_min >= 60 ? `${Math.round(latest.uptime_min / 60)}h` : `${latest.uptime_min}m`}</span>
        </span>
      </div>
    </div>
  );
}

type LogRow = FunctionReturnType<typeof api.daemonLogs.adminList>["logs"][number];
type LogGroup = { log: LogRow; count: number; oldest: number };

// Daemons repeat themselves (reconciliation, health lines). Fold a run of the
// same user saying the same thing into one row with a count.
function foldRepeats(logs: LogRow[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const log of logs) {
    const last = groups[groups.length - 1];
    if (last && last.log.user_id === log.user_id && last.log.level === log.level && last.log.message === log.message) {
      last.count++;
      last.oldest = log.timestamp;
    } else {
      groups.push({ log, count: 1, oldest: log.timestamp });
    }
  }
  return groups;
}

const TIME_WINDOWS = { "1h": 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000 } as const;
type TimeFilter = keyof typeof TIME_WINDOWS | "all";

const LEVEL_BUTTONS = [
  { value: "all", label: "All" },
  { value: "error", label: "Err" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
] as const;

const TIME_BUTTONS: { value: TimeFilter; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "all", label: "all" },
];

// Past this many pixels from the top the list stops taking new rows, so what
// you are reading never moves under you.
const PAUSE_SCROLL_PX = 24;

function SegmentedButtons<T extends string>({
  options,
  value,
  onChange,
  activeClass,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  activeClass?: (v: T) => string | undefined;
}) {
  return (
    <div className="flex rounded-md border border-sol-border overflow-hidden shrink-0">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1.5 text-meta font-mono transition-colors ${
            value === o.value
              ? activeClass?.(o.value) ?? "bg-sol-bg-highlight text-sol-text"
              : "bg-sol-bg-alt text-sol-text-muted hover:text-sol-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-3 pb-1 text-mark font-mono uppercase tracking-wider text-sol-text-dim">{children}</div>
  );
}

function AdminDaemonLogs() {
  const [selectedUserId, setSelectedUserId] = useState<Id<"users"> | undefined>();
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("24h");
  const [searchQuery, setSearchQuery] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [showCommands, setShowCommands] = useState(true);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sinceTimestamp = useMemo(
    () => (timeFilter === "all" ? undefined : Date.now() - TIME_WINDOWS[timeFilter]),
    [timeFilter],
  );

  const users = useHeld(useQuery(api.daemonLogs.adminGetUsers));
  const logsResult = useHeld(useQuery(api.daemonLogs.adminList, {
    limit: 500,
    level: levelFilter === "all" ? undefined : levelFilter,
    userId: selectedUserId,
    since: sinceTimestamp,
  }));
  const stats = useHeld(useQuery(api.daemonLogs.adminGetStats));

  // A new view of the logs starts at the newest line.
  const toTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setPausedAt(null);
  }, []);
  const selectUser = (id: Id<"users"> | undefined) => { setSelectedUserId(id); toTop(); };

  const filteredLogs = useMemo(() => {
    if (!logsResult?.logs) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return logsResult.logs;
    return logsResult.logs.filter(
      (log) =>
        log.message.toLowerCase().includes(q) ||
        log.metadata?.error_code?.toLowerCase().includes(q) ||
        log.metadata?.session_id?.toLowerCase().includes(q)
    );
  }, [logsResult?.logs, searchQuery]);

  const visibleLogs = useMemo(
    () => (pausedAt === null ? filteredLogs : filteredLogs.filter((l) => l._creationTime <= pausedAt)),
    [filteredLogs, pausedAt],
  );
  const groups = useMemo(() => foldRepeats(visibleLogs), [visibleLogs]);
  const newCount = filteredLogs.length - visibleLogs.length;

  const onLogScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const away = el.scrollTop > PAUSE_SCROLL_PX;
    if (away && pausedAt === null) {
      setPausedAt(visibleLogs.reduce((m, l) => Math.max(m, l._creationTime), 0));
    } else if (!away && pausedAt !== null) {
      setPausedAt(null);
    }
  };

  const userMap = useMemo(() => {
    const map = new Map<string, { email?: string; name?: string }>();
    for (const u of logsResult?.users ?? []) if (u) map.set(u._id, u);
    return map;
  }, [logsResult?.users]);

  const selectedUser = useMemo(
    () => (selectedUserId ? users?.find((u) => u?._id === selectedUserId) ?? null : null),
    [selectedUserId, users],
  );

  // Online people alphabetically, everyone else by when they were last seen.
  // Neither order moves on a heartbeat, so the list holds still under you.
  const { online, offline } = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    const all = (users ?? []).filter((u): u is AdminUser => !!u && (!q || labelOf(u).toLowerCase().includes(q)));
    return {
      online: all.filter(isOnline).sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
      offline: all.filter((u) => !isOnline(u)).sort((a, b) => lastSeenOf(b) - lastSeenOf(a)),
    };
  }, [users, userQuery]);
  const totalUsers = (users ?? []).filter(Boolean).length;
  const onlineTotal = (users ?? []).filter((u) => u && isOnline(u)).length;

  if (logsResult === undefined) {
    return (
      <div className="h-screen bg-sol-bg text-sol-text flex items-center justify-center">
        <div className="text-sol-text-muted font-mono text-sm">loading...</div>
      </div>
    );
  }

  if (!logsResult.isAdmin) {
    return (
      <div className="h-screen bg-sol-bg text-sol-text flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-medium text-sol-red mb-2">Access Denied</h1>
          <p className="text-sol-text-muted text-sm">This page is for Codecast staff.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-sol-bg text-sol-text overflow-hidden">
      <div className="w-full max-w-[1600px] mx-auto px-6 pt-5 pb-4 shrink-0">
        {/* Header */}
        <div className="flex items-center gap-4 mb-4">
          <h1 className="text-lg font-medium tracking-tight">Daemon Admin</h1>
          <div className="flex items-center gap-3 text-xs text-sol-text-muted tabular-nums">
            <span>
              <span className="text-sol-green">{onlineTotal}</span>/{totalUsers} online
            </span>
            <span className="text-sol-text-dim">|</span>
            <span>{filteredLogs.length} logs</span>
          </div>
        </div>

        {/* Stats row: a window card applies that window */}
        {stats && (
          <div className="grid grid-cols-[1fr_1fr_1fr_1.6fr] gap-3">
            {([
              { label: "1h", data: stats.lastHour },
              { label: "24h", data: stats.lastDay },
              { label: "7d", data: stats.lastWeek },
            ] as const).map(({ label, data }) => {
              const floor = stats.sampledSince !== null && Date.now() - TIME_WINDOWS[label] < stats.sampledSince;
              return (
                <button
                  key={label}
                  onClick={() => { setTimeFilter(label); toTop(); }}
                  className={`text-left rounded-lg px-4 py-3 border transition-colors ${
                    timeFilter === label
                      ? "bg-sol-bg-highlight border-sol-border"
                      : "bg-sol-bg-alt border-sol-border hover:border-sol-text-dim"
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-mark font-mono uppercase tracking-wider text-sol-text-dim">{label}</span>
                    <span className="text-meta text-sol-text-dim">{data.uniqueUsers} users</span>
                  </div>
                  <div
                    className="text-2xl font-light text-sol-text mt-1 tabular-nums"
                    title={floor ? `At least this many: the count reads the newest ${data.total.toLocaleString()} rows` : undefined}
                  >
                    {data.total.toLocaleString()}{floor && <span className="text-sol-text-dim">+</span>}
                  </div>
                  <div className="flex gap-3 mt-1 text-meta tabular-nums">
                    {data.error > 0 && <span className="text-sol-red">{data.error.toLocaleString()} err</span>}
                    {data.warn > 0 && <span className="text-sol-amber">{data.warn.toLocaleString()} warn</span>}
                    {data.error === 0 && data.warn === 0 && <span className="text-sol-text-dim">clean</span>}
                  </div>
                </button>
              );
            })}
            <div className="bg-sol-bg-alt rounded-lg px-4 py-3 border border-sol-border min-w-0">
              <span className="text-mark font-mono uppercase tracking-wider text-sol-text-dim">Top Errors</span>
              {stats.topErrors.length === 0 ? (
                <div className="text-meta text-sol-text-dim mt-2">No errors</div>
              ) : (
                <div className="mt-1.5">
                  {stats.topErrors.slice(0, 3).map((err) => (
                    <button
                      key={err.message}
                      onClick={() => { setSearchQuery(err.message.split(/<path>|<id>|\bN\b/)[0].trim()); toTop(); }}
                      className="w-full flex gap-1.5 text-left text-meta text-sol-text-muted hover:text-sol-text py-0.5"
                      title={err.message}
                    >
                      <span className="text-sol-red font-mono tabular-nums shrink-0">{err.count}x</span>
                      <span className="truncate">{err.message}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Main grid: each column scrolls on its own inside the viewport */}
      <div className="flex-1 min-h-0 w-full max-w-[1600px] mx-auto px-6 pb-6 grid grid-cols-[minmax(13rem,320px)_minmax(0,1fr)] gap-4">
        {/* Users */}
        <div className="flex flex-col min-h-0 bg-sol-bg-alt rounded-lg border border-sol-border overflow-hidden">
          <div className="px-2 py-2 border-b border-sol-border shrink-0">
            <input
              type="text"
              placeholder={`Filter ${totalUsers} users...`}
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-sol-bg border border-sol-border rounded text-[12px] text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan font-mono"
            />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-1.5 [overflow-anchor:none]">
            <button
              onClick={() => selectUser(undefined)}
              className={`w-full text-left px-2.5 py-2 rounded-md text-[13px] transition-colors border ${
                !selectedUserId
                  ? "bg-sol-blue/10 border-sol-blue/30 text-sol-text"
                  : "text-sol-text-muted hover:bg-sol-bg-highlight border-transparent"
              }`}
            >
              All users
            </button>
            {online.length > 0 && <SectionLabel>Online · {online.length}</SectionLabel>}
            {online.map((user) => (
              <UserListItem key={user._id} user={user} isSelected={selectedUserId === user._id} onClick={() => selectUser(user._id as Id<"users">)} />
            ))}
            {offline.length > 0 && <SectionLabel>Offline · {offline.length}</SectionLabel>}
            {offline.map((user) => (
              <UserListItem key={user._id} user={user} isSelected={selectedUserId === user._id} onClick={() => selectUser(user._id as Id<"users">)} />
            ))}
            {online.length + offline.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-sol-text-dim">No users match</div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="flex flex-col min-h-0 gap-3">
          {selectedUser && (
            <div className={`grid gap-3 shrink-0 ${showCommands ? "grid-cols-2" : "grid-cols-1"}`}>
              {showCommands && (
                <CommandPanel
                  userId={selectedUserId!}
                  userName={labelOf(selectedUser)}
                  isOnline={isOnline(selectedUser)}
                />
              )}
              <MetricsChart logs={filteredLogs} />
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0">
            <input
              type="text"
              placeholder="Search logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearchQuery(""); }}
              className="flex-1 min-w-0 px-3 py-1.5 bg-sol-bg-alt border border-sol-border rounded-md text-[13px] text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan font-mono"
            />
            <SegmentedButtons
              options={LEVEL_BUTTONS}
              value={levelFilter}
              onChange={(v) => { setLevelFilter(v); toTop(); }}
              activeClass={(v) => v === "error" ? "bg-sol-red/10 text-sol-red" : v === "warn" ? "bg-sol-amber/10 text-sol-amber" : undefined}
            />
            <SegmentedButtons options={TIME_BUTTONS} value={timeFilter} onChange={(v) => { setTimeFilter(v); toTop(); }} />
            {selectedUserId && (
              <button
                onClick={() => setShowCommands(!showCommands)}
                className={`px-2.5 py-1.5 text-meta font-mono rounded-md border transition-colors shrink-0 ${
                  showCommands
                    ? "bg-sol-blue/10 text-sol-blue border-sol-blue/30"
                    : "bg-sol-bg-alt text-sol-text-muted border-sol-border hover:text-sol-text"
                }`}
                title="Toggle remote commands panel"
              >
                RPC
              </button>
            )}
          </div>

          <div className="relative flex-1 min-h-0 bg-sol-bg-alt rounded-lg border border-sol-border overflow-hidden">
            {newCount > 0 && (
              <Button variant="blue" size="xs" onClick={toTop} className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full font-mono">
                {newCount} new · jump to latest
              </Button>
            )}
            <div
              ref={scrollRef}
              onScroll={onLogScroll}
              className="h-full overflow-y-auto divide-y divide-sol-border/60 [overflow-anchor:none]"
            >
              {groups.length === 0 ? (
                <div className="p-12 text-center text-sol-text-dim text-sm">No logs matching filters</div>
              ) : (
                groups.map(({ log, count, oldest }) => {
                  const user = userMap.get(log.user_id);
                  const style = LEVEL_STYLES[log.level as LogLevel] || LEVEL_STYLES.debug;
                  const isToday = new Date(log.timestamp).toDateString() === new Date().toDateString();
                  const when = (ts: number) => `${isToday ? "" : `${formatDate(ts)} `}${formatTimestamp(ts)}`;

                  return (
                    <div
                      key={log._id}
                      className={`px-4 py-2.5 hover:bg-sol-bg-highlight transition-colors ${log.level === "error" ? "bg-sol-red/5" : ""}`}
                    >
                      <div className="flex items-start gap-2.5">
                        <LogLevelDot level={log.level as LogLevel} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-meta text-sol-text-muted mb-0.5 min-w-0">
                            {!selectedUserId && (
                              <button
                                onClick={() => selectUser(log.user_id)}
                                className="text-sol-text-muted font-medium hover:text-sol-blue min-w-0 max-w-[45%]"
                              >
                                <EmailLabel text={labelOf(user)} />
                              </button>
                            )}
                            <span className="text-sol-text-dim tabular-nums shrink-0">
                              {count > 1 ? `${when(oldest)} – ${formatTimestamp(log.timestamp)}` : when(log.timestamp)}
                            </span>
                            {log.daemon_version && <span className="text-sol-text-dim shrink-0">v{log.daemon_version}</span>}
                            {count > 1 && (
                              <span className="px-1.5 rounded bg-sol-bg-highlight text-sol-text-muted font-mono tabular-nums shrink-0">×{count}</span>
                            )}
                          </div>
                          <pre className="text-[13px] text-sol-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                            {log.message}
                          </pre>
                          {log.metadata?.error_code && (
                            <span className={`inline-block mt-1 text-meta font-mono px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>
                              {log.metadata.error_code}
                            </span>
                          )}
                          {log.metadata?.session_id && (
                            <div className="mt-0.5 text-meta text-sol-text-dim font-mono">
                              session: {log.metadata.session_id.slice(0, 12)}...
                            </div>
                          )}
                          {log.metadata?.stack && (
                            <details className="mt-1.5">
                              <summary className="text-meta text-sol-text-dim cursor-pointer hover:text-sol-text font-mono">
                                stack trace
                              </summary>
                              <pre className="mt-1.5 p-2.5 bg-sol-bg rounded text-meta text-sol-text-muted overflow-x-auto font-mono leading-relaxed">
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
  );
}

export default function AdminDaemonLogsPage() {
  return (
    <AuthGuard>
      <AdminDaemonLogs />
    </AuthGuard>
  );
}
