import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";

type AgentStatus = "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming";
type Session = FunctionReturnType<typeof api.managedSessions.listActiveSessions>[number];
type ClassifiedSession = Session & {
  isStale: boolean;
  isActive: boolean;
  isIdle: boolean;
  idleDuration: number;
  uptime: number;
  effectiveStatus: string;
};

const STATUS_STYLES: Record<AgentStatus, { bg: string; text: string; dot: string }> = {
  working:             { bg: "bg-sky-950/40",    text: "text-sky-400",     dot: "bg-sky-500 animate-pulse" },
  thinking:            { bg: "bg-violet-950/40", text: "text-violet-400",  dot: "bg-violet-500 animate-pulse" },
  compacting:          { bg: "bg-amber-950/40",  text: "text-amber-400",   dot: "bg-amber-500 animate-pulse" },
  starting:            { bg: "bg-teal-950/40",   text: "text-teal-400",    dot: "bg-teal-500 animate-pulse" },
  resuming:            { bg: "bg-teal-950/40",   text: "text-teal-400",    dot: "bg-teal-500 animate-pulse" },
  connected:           { bg: "bg-emerald-950/40",text: "text-emerald-400", dot: "bg-emerald-500" },
  idle:                { bg: "bg-zinc-800/40",   text: "text-zinc-400",    dot: "bg-zinc-500" },
  permission_blocked:  { bg: "bg-red-950/40",    text: "text-red-400",     dot: "bg-red-500" },
  stopped:             { bg: "bg-zinc-800/40",   text: "text-zinc-600",    dot: "bg-zinc-700" },
};

const STALE_THRESHOLD = 60 * 1000;

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function projectName(path?: string): string {
  if (!path) return "-";
  const parts = path.split("/");
  return parts[parts.length - 1] || parts[parts.length - 2] || path;
}

// ---- Session Metrics Chart ----

type MetricsRow = { cpu: number; memory: number; pid_count: number; collected_at: number };

function SessionMetricsChart({ sessionId }: { sessionId: string }) {
  const metrics = useQuery(api.managedSessions.getSessionMetrics, { session_id: sessionId });

  if (!metrics || metrics.length < 2) {
    return (
      <div className="px-4 py-4 text-center">
        <span className="text-[11px] font-mono text-zinc-600">
          {metrics === undefined ? "Loading metrics..." : "Collecting metrics..."}
        </span>
      </div>
    );
  }

  const W = 600;
  const H = 100;
  const PAD = { top: 8, right: 8, bottom: 8, left: 8 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const memMb = metrics.map((m: MetricsRow) => m.memory / (1024 * 1024));
  const memMax = Math.max(...memMb, 50);
  const cpuMax = Math.max(...metrics.map((m: MetricsRow) => m.cpu), 10);
  const tMin = metrics[0].collected_at;
  const tMax = metrics[metrics.length - 1].collected_at;
  const tRange = tMax - tMin || 1;

  const x = (t: number) => PAD.left + ((t - tMin) / tRange) * cw;
  const yMem = (v: number) => PAD.top + ch - (v / (memMax * 1.15)) * ch;
  const yCpu = (v: number) => PAD.top + ch - (v / (cpuMax * 1.15)) * ch;

  const memPoints = metrics.map((m: MetricsRow) => `${x(m.collected_at)},${yMem(m.memory / (1024 * 1024))}`).join(" ");
  const memAreaPoints = `${x(tMin)},${PAD.top + ch} ${memPoints} ${x(tMax)},${PAD.top + ch}`;
  const cpuPoints = metrics.map((m: MetricsRow) => `${x(m.collected_at)},${yCpu(m.cpu)}`).join(" ");

  const latest = metrics[metrics.length - 1];

  return (
    <div className="border-t border-zinc-800/60">
      <div className="px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-1 rounded-sm bg-sky-500/60" />
            <span className="text-zinc-500">Memory</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 rounded-sm bg-amber-500" />
            <span className="text-zinc-500">CPU</span>
          </span>
        </div>
        <span className="text-[10px] font-mono text-zinc-600">{metrics.length} samples</span>
      </div>
      <div className="px-4 pb-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 90 }} preserveAspectRatio="none">
          <polygon points={memAreaPoints} fill="rgba(56,189,248,0.12)" />
          <polyline points={memPoints} fill="none" stroke="rgba(56,189,248,0.5)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <polyline points={cpuPoints} fill="none" stroke="rgba(245,158,11,0.7)" strokeWidth="1.5" strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
          {metrics.map((m: MetricsRow, i: number) => (
            <circle key={i} cx={x(m.collected_at)} cy={yMem(m.memory / (1024 * 1024))} r="2" fill="rgba(56,189,248,0.7)" />
          ))}
        </svg>
      </div>
      <div className="px-4 py-2 border-t border-zinc-800/40 flex items-center gap-6 text-[11px] font-mono">
        <span className="text-zinc-500">
          Mem <span className="text-sky-400">{(latest.memory / (1024 * 1024)).toFixed(0)}MB</span>
        </span>
        <span className="text-zinc-500">
          CPU <span className="text-amber-400">{latest.cpu.toFixed(1)}%</span>
        </span>
        <span className="text-zinc-500">
          Procs <span className="text-zinc-300">{latest.pid_count}</span>
        </span>
      </div>
    </div>
  );
}

// ---- Aggregate Overview ----

function AggregateOverview({ sessions }: { sessions: ClassifiedSession[] }) {
  const aggregateMetrics = useQuery(api.managedSessions.getAggregateMetrics);

  const totals = useMemo(() => {
    let mem = 0, cpu = 0, procs = 0;
    for (const s of sessions) {
      mem += s.current_memory || 0;
      cpu += s.current_cpu || 0;
      procs += s.current_pid_count || 0;
    }
    return { mem, cpu, procs, count: sessions.length };
  }, [sessions]);

  if (totals.count === 0) return null;

  const hasChart = aggregateMetrics && aggregateMetrics.length >= 2;

  return (
    <div className="bg-zinc-900/60 rounded-lg border border-zinc-800/60 mb-4 overflow-hidden">
      {/* Stats row */}
      <div className="flex items-center gap-6 px-4 py-2.5 text-[11px] font-mono">
        <span className="text-zinc-500">
          <span className="text-zinc-300 text-sm">{totals.count}</span> sessions
        </span>
        {totals.mem > 0 && (
          <span className="text-zinc-500">
            <span className="text-sky-400 text-sm">{formatBytes(totals.mem)}</span> mem
          </span>
        )}
        {totals.cpu > 0 && (
          <span className="text-zinc-500">
            <span className="text-amber-400 text-sm">{totals.cpu.toFixed(1)}%</span> cpu
          </span>
        )}
        {totals.procs > 0 && (
          <span className="text-zinc-500">
            <span className="text-zinc-300 text-sm">{totals.procs}</span> procs
          </span>
        )}
        {hasChart && (
          <div className="ml-auto flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm bg-sky-500/60" />
              <span className="text-zinc-600">Memory</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 rounded-sm bg-amber-500" />
              <span className="text-zinc-600">CPU</span>
            </span>
          </div>
        )}
      </div>

      {/* Aggregate chart */}
      {hasChart && <AggregateChart metrics={aggregateMetrics} />}
    </div>
  );
}

type AggregatePoint = { collected_at: number; cpu: number; memory: number; pid_count: number };

function AggregateChart({ metrics }: { metrics: AggregatePoint[] }) {
  const W = 700;
  const H = 80;
  const PAD = { top: 4, right: 8, bottom: 4, left: 8 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const memMb = metrics.map((m) => m.memory / (1024 * 1024));
  const memMax = Math.max(...memMb, 100);
  const cpuMax = Math.max(...metrics.map((m) => m.cpu), 10);
  const tMin = metrics[0].collected_at;
  const tMax = metrics[metrics.length - 1].collected_at;
  const tRange = tMax - tMin || 1;

  const x = (t: number) => PAD.left + ((t - tMin) / tRange) * cw;
  const yMem = (v: number) => PAD.top + ch - (v / (memMax * 1.15)) * ch;
  const yCpu = (v: number) => PAD.top + ch - (v / (cpuMax * 1.15)) * ch;

  const memPoints = metrics.map((m) => `${x(m.collected_at)},${yMem(m.memory / (1024 * 1024))}`).join(" ");
  const memAreaPoints = `${x(tMin)},${PAD.top + ch} ${memPoints} ${x(tMax)},${PAD.top + ch}`;
  const cpuPoints = metrics.map((m) => `${x(m.collected_at)},${yCpu(m.cpu)}`).join(" ");

  return (
    <div className="px-4 pb-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 70 }} preserveAspectRatio="none">
        <polygon points={memAreaPoints} fill="rgba(56,189,248,0.10)" />
        <polyline points={memPoints} fill="none" stroke="rgba(56,189,248,0.45)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <polyline points={cpuPoints} fill="none" stroke="rgba(245,158,11,0.6)" strokeWidth="1.5" strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

// ---- Main View ----

function SessionsView() {
  const sessions = useQuery(api.managedSessions.listActiveSessions);
  const killSession = useMutation(api.conversations.killSession);
  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "active" | "idle" | "stale">("all");
  const [now, setNow] = useState(Date.now());
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  const classified = useMemo((): ClassifiedSession[] => {
    if (!sessions) return [];
    return sessions.map((s: Session) => {
      const isStale = now - s.last_heartbeat > STALE_THRESHOLD;
      const status = s.agent_status || "stopped";
      const isActive = !isStale && ["working", "thinking", "compacting", "starting", "resuming"].includes(status);
      const isIdle = !isStale && (status === "idle" || status === "connected" || status === "permission_blocked");
      const idleSince = s.agent_status_updated_at || s.last_heartbeat;
      const idleDuration = isIdle || isStale ? now - idleSince : 0;
      const uptime = now - s.started_at;

      return {
        ...s,
        isStale,
        isActive,
        isIdle,
        idleDuration,
        uptime,
        effectiveStatus: isStale ? "stale" : status,
      };
    }).sort((a: ClassifiedSession, b: ClassifiedSession) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.isIdle !== b.isIdle) return a.isIdle ? -1 : 1;
      return b.idleDuration - a.idleDuration;
    });
  }, [sessions, now]);

  const filtered = useMemo(() => {
    if (filter === "all") return classified;
    if (filter === "active") return classified.filter((s) => s.isActive);
    if (filter === "idle") return classified.filter((s) => s.isIdle);
    if (filter === "stale") return classified.filter((s) => s.isStale);
    return classified;
  }, [classified, filter]);

  const counts = useMemo(() => {
    const c = { active: 0, idle: 0, stale: 0, total: 0 };
    for (const s of classified) {
      c.total++;
      if (s.isActive) c.active++;
      else if (s.isIdle) c.idle++;
      else if (s.isStale) c.stale++;
    }
    return c;
  }, [classified]);

  const handleKill = useCallback(
    async (conversationId: string) => {
      setKilling((prev) => new Set(prev).add(conversationId));
      try {
        await killSession({ conversation_id: conversationId as any });
      } catch (e) {
        console.error("Failed to kill session:", e);
      } finally {
        setTimeout(() => {
          setKilling((prev) => {
            const next = new Set(prev);
            next.delete(conversationId);
            return next;
          });
        }, 2000);
      }
    },
    [killSession]
  );

  const handleKillAll = useCallback(
    async (sessions: typeof filtered) => {
      const killable = sessions.filter((s) => s.conversation_id && (s.isIdle || s.isStale));
      for (const s of killable) {
        if (s.conversation_id) {
          handleKill(s.conversation_id);
        }
      }
    },
    [handleKill]
  );

  if (sessions === undefined) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-zinc-500 font-mono text-sm">loading sessions...</div>
      </div>
    );
  }

  const filterButtons = [
    { value: "all" as const, label: "All", count: counts.total },
    { value: "active" as const, label: "Active", count: counts.active },
    { value: "idle" as const, label: "Idle", count: counts.idle },
    { value: "stale" as const, label: "Stale", count: counts.stale },
  ];

  const killableCount = filtered.filter((s) => s.conversation_id && (s.isIdle || s.isStale)).length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-[1200px] mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/inbox" className="text-zinc-500 hover:text-zinc-300 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-lg font-medium tracking-tight">Sessions</h1>
            <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono">
              <span><span className="text-sky-400">{counts.active}</span> active</span>
              <span className="text-zinc-700">|</span>
              <span><span className="text-zinc-400">{counts.idle}</span> idle</span>
              <span className="text-zinc-700">|</span>
              <span><span className={counts.stale > 0 ? "text-amber-400" : "text-zinc-600"}>{counts.stale}</span> stale</span>
            </div>
          </div>

          {killableCount > 0 && (filter === "idle" || filter === "stale") && (
            <button
              onClick={() => handleKillAll(filtered)}
              className="px-3 py-1.5 text-xs font-mono bg-red-950/40 text-red-400 border border-red-900/40 rounded-md hover:bg-red-950/60 hover:border-red-800/50 transition-colors"
            >
              Kill {killableCount} {filter}
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-4">
          <div className="flex rounded-md border border-zinc-800/60 overflow-hidden">
            {filterButtons.map(({ value, label, count }) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                  filter === value
                    ? "bg-zinc-800 text-zinc-200"
                    : "bg-zinc-900/40 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {label} <span className="text-zinc-600 ml-1">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Aggregate overview + chart */}
        <AggregateOverview sessions={filtered} />

        {/* Table */}
        {filtered.length === 0 ? (
          <div className="bg-zinc-900/40 rounded-lg border border-zinc-800/60 p-12 text-center">
            <div className="text-zinc-600 text-sm">
              {counts.total === 0 ? "No active sessions" : `No ${filter} sessions`}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
              {filtered.map((session) => {
                const statusKey = session.effectiveStatus as AgentStatus;
                const style = STATUS_STYLES[statusKey] || STATUS_STYLES.stopped;
                const isKilling = session.conversation_id ? killing.has(session.conversation_id) : false;
                const isExpanded = expandedSession === session.session_id;

                return (
                  <div
                    key={session._id}
                    className={`bg-zinc-900/60 rounded-lg border border-zinc-800/60 transition-colors ${
                      session.isStale ? "opacity-50" : ""
                    } ${isKilling ? "opacity-30" : "hover:bg-zinc-900/80"}`}
                  >
                    <div
                      className="px-4 py-3 cursor-pointer"
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest("a") || target.closest("button")) return;
                        setExpandedSession(isExpanded ? null : session.session_id);
                      }}
                    >
                      {/* Top row: title, status, idle, actions */}
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
                        <div className="flex-1 min-w-0">
                          {session.conversation_id ? (
                            <Link
                              href={`/conversation/${session.conversation_id}`}
                              className="text-sm text-zinc-200 hover:text-white truncate block transition-colors"
                            >
                              {session.conversation_title || session.tmux_session || session.session_id.slice(0, 12)}
                            </Link>
                          ) : (
                            <span className="text-sm text-zinc-400 truncate block">
                              {session.tmux_session || session.session_id.slice(0, 12)}
                            </span>
                          )}
                        </div>

                        {/* Status + idle */}
                        <span className={`text-xs font-mono shrink-0 ${style.text}`}>
                          {session.effectiveStatus}
                        </span>
                        {session.permission_mode && session.permission_mode !== "default" && (
                          <span className="text-[10px] text-zinc-600 font-mono shrink-0">
                            {session.permission_mode}
                          </span>
                        )}
                        {!session.isActive && (
                          <span className={`text-xs font-mono tabular-nums shrink-0 ${
                            session.idleDuration > 30 * 60 * 1000
                              ? "text-red-400"
                              : session.idleDuration > 10 * 60 * 1000
                                ? "text-amber-400"
                                : "text-zinc-500"
                          }`}>
                            {formatDuration(session.idleDuration)}
                          </span>
                        )}

                        {/* Kill button */}
                        {session.conversation_id && !isKilling && (
                          <button
                            onClick={() => handleKill(session.conversation_id!)}
                            className="px-2 py-1 text-[11px] font-mono text-zinc-600 hover:text-red-400 hover:bg-red-950/30 rounded transition-colors border border-transparent hover:border-red-900/40 shrink-0"
                            title="Kill this session"
                          >
                            kill
                          </button>
                        )}
                        {isKilling && (
                          <span className="text-[11px] font-mono text-zinc-600 shrink-0">killing...</span>
                        )}
                      </div>

                      {/* Headline */}
                      {session.headline && (
                        <div className="mt-1.5 ml-5 text-[12px] text-zinc-500 truncate">
                          {session.headline}
                        </div>
                      )}

                      {/* Metadata row */}
                      <div className="mt-1.5 ml-5 flex items-center gap-3 text-[11px] text-zinc-600 font-mono flex-wrap">
                        <span>{projectName(session.project_path)}</span>
                        {session.git_branch && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-zinc-500" title={session.git_branch}>
                              {session.git_branch.length > 30 ? session.git_branch.slice(0, 30) + "..." : session.git_branch}
                            </span>
                          </>
                        )}
                        {session.worktree_name && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-teal-600">wt:{session.worktree_name}</span>
                          </>
                        )}
                        {session.model && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span>{session.model}</span>
                          </>
                        )}
                        <span className="text-zinc-700">|</span>
                        <span>pid:{session.pid}</span>
                        {session.message_count != null && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span>{session.message_count} msgs</span>
                          </>
                        )}
                        <span className="text-zinc-700">|</span>
                        <span>up {formatDuration(session.uptime)}</span>
                        {session.is_subagent && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-violet-600">subagent</span>
                          </>
                        )}
                        {session.current_memory != null && session.current_memory > 0 && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-sky-500">{(session.current_memory / (1024 * 1024)).toFixed(0)}MB</span>
                          </>
                        )}
                        {session.current_cpu != null && session.current_cpu > 0 && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-amber-500">{session.current_cpu.toFixed(1)}%</span>
                          </>
                        )}
                        {session.current_pid_count != null && session.current_pid_count > 0 && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span>{session.current_pid_count} procs</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Expanded metrics chart */}
                    {isExpanded && (
                      <SessionMetricsChart sessionId={session.session_id} />
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SessionsPage() {
  return (
    <AuthGuard>
      <SessionsView />
    </AuthGuard>
  );
}
