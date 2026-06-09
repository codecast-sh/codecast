import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
// Reuse the inbox's canonical state predicates so /sessions and /inbox never
// disagree about what "needs input" / "idle" means.
import {
  isSessionWaitingForInput,
  isSessionEffectivelyIdle,
  isSessionDismissed,
  type InboxSession,
} from "../../store/inboxStore";

type Session = FunctionReturnType<typeof api.managedSessions.listActiveSessions>[number];
// Cleanup-oriented buckets, computed from liveness + sleep-aware idle — NOT from
// the agent's self-reported status (which says nothing about whether the OS
// process exists, and conflates "done" with "frozen").
type Bucket = "active" | "idle" | "dead";
// The agent's relationship to YOU — a separate axis from process liveness above.
// "needs input" = blocked on you (open poll / permission); "working" = busy;
// "idle" = at rest. Pinned/dismissed are orthogonal flags layered on top.
type WorkState = "needs_input" | "working" | "idle";
type ClassifiedSession = Session & {
  isAlive: boolean;
  bucket: Bucket;
  awakeIdleMs: number;
  uptime: number;
  // Wall-clock timestamp of the last real activity, and ms elapsed since.
  lastActiveAt: number;
  lastActiveMs: number;
  // Triage state, joined from listInboxSessions (the same data the inbox uses).
  pinned: boolean;
  dismissed: boolean;
  needsInput: boolean;
  workState: WorkState | null;
};

const BUCKET_STYLES: Record<Bucket, { label: string; text: string; dot: string }> = {
  active: { label: "active",       text: "text-sky-400",   dot: "bg-sky-500" },
  idle:   { label: "idle · kill?", text: "text-amber-400", dot: "bg-amber-500" },
  dead:   { label: "dead",         text: "text-zinc-600",  dot: "bg-zinc-700" },
};

const WORK_STATE_STYLES: Record<WorkState, { label: string; cls: string }> = {
  needs_input: { label: "needs input", cls: "text-rose-300 bg-rose-950/40 border-rose-900/50" },
  working:     { label: "working",     cls: "text-emerald-300 bg-emerald-950/30 border-emerald-900/40" },
  idle:        { label: "idle",        cls: "text-zinc-400 bg-zinc-800/50 border-zinc-700/40" },
};

// Daemon statuses that mean "actively doing work" — used only as a fallback for
// rows with no inbox join (the inbox predicates are authoritative when present).
const ACTIVE_AGENT_STATUSES = new Set(["working", "thinking", "compacting", "connected", "starting", "resuming"]);

type TriageFilter = "all" | "needs_input" | "working" | "pinned" | "dismissed";

// A session is alive if its daemon heartbeat is fresh. This is the SAME signal
// the rest of the codebase uses (HEARTBEAT_ALIVE_MS in conversations.ts, plans.ts,
// pendingMessages.ts, …): the heartbeat refreshes every ~45s while a process tree
// exists. We deliberately do NOT key liveness off last_metrics_at — reportMetrics
// throttles that write to once per 5min, so a live session would otherwise flip to
// "dead" for most of every 5-minute window.
const HEARTBEAT_ALIVE_MS = 90 * 1000;
// Awake-idle time (sleep excluded) after which a live session is safe to kill.
const KILLABLE_IDLE_MS = 2 * 60 * 60 * 1000;

type SortKey = "lastActive" | "uptime" | "messages" | "memory" | "cpu" | "name";
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "lastActive", label: "Last active" },
  { value: "uptime",     label: "Uptime" },
  { value: "messages",   label: "Messages" },
  { value: "memory",     label: "Memory" },
  { value: "cpu",        label: "CPU" },
  { value: "name",       label: "Name" },
];

function sortValue(s: ClassifiedSession, key: SortKey): number | string {
  switch (key) {
    case "uptime":   return s.uptime;
    case "messages": return s.message_count ?? 0;
    // Resource sorts only rank live processes — a dead row's last value is a
    // stale pre-death reading, so sink it to 0 (same gate as the row display).
    case "memory":   return s.isAlive ? s.current_memory ?? 0 : 0;
    case "cpu":      return s.isAlive ? s.current_cpu ?? 0 : 0;
    case "name":     return (s.conversation_title || s.tmux_session || s.session_id).toLowerCase();
    case "lastActive":
    default:         return s.lastActiveAt;
  }
}

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
    // Only live sessions contribute — dead rows carry stale pre-death metrics.
    for (const s of sessions) {
      if (!s.isAlive) continue;
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
          <span
            className="text-zinc-500"
            title="Sum of each live session's process-tree CPU%. 100% = one full core, so the total can exceed 100% across cores."
          >
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
  // Triage state (pinned / needs-input / working / dismissed) lives on the
  // conversation and is computed by listInboxSessions; we join it in by id
  // rather than recompute the (message-read-heavy) logic here.
  const inboxData = useQuery(api.conversations.listInboxSessions, { show_all: true });
  const convCommand = useInboxStore((s) => s.convCommand);
  const pruneSession = useMutation(api.managedSessions.unregisterManagedSession);
  // Local-first: patchConversation mutates conversations[id] synchronously and
  // rides applyPatches to Convex (inbox_pinned_at/inbox_dismissed_at aren't in
  // the server's immutable set), so pin/dismiss reflect instantly here and in
  // the inbox without a round-trip.
  const patchConversation = useInboxStore((s) => s.patchConversation);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | Bucket>("all");
  const [triageFilter, setTriageFilter] = useState<TriageFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("lastActive");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [now, setNow] = useState(Date.now());
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  // Two-step confirm for the bulk kill (destructive, fleet-wide).
  const [bulkConfirm, setBulkConfirm] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  // Reset the kill-all confirm whenever the visible set changes, so a pending
  // confirm can't apply to a different list than the one the user was looking at.
  useEffect(() => { setBulkConfirm(false); }, [filter, triageFilter]);

  const inboxById = useMemo(() => {
    const m = new Map<string, InboxSession>();
    for (const s of inboxData?.sessions ?? []) m.set(String(s._id), s as InboxSession);
    return m;
  }, [inboxData]);

  const classified = useMemo((): ClassifiedSession[] => {
    if (!sessions) return [];
    return sessions.map((s: Session) => {
      const isAlive = now - s.last_heartbeat < HEARTBEAT_ALIVE_MS;
      const awakeIdleMs = s.awake_idle_ms ?? 0;
      const bucket: Bucket = !isAlive ? "dead" : awakeIdleMs >= KILLABLE_IDLE_MS ? "idle" : "active";
      // "Last active" = the most recent moment anything happened. conversation
      // updated_at tracks real activity; fall back to the heartbeat for
      // conversation-less (tmux-only) rows, then to start time.
      const lastActiveAt = s.conversation_updated_at ?? s.last_heartbeat ?? s.started_at;

      const inbox = s.conversation_id ? inboxById.get(String(s.conversation_id)) : undefined;
      const pinned = !!inbox?.is_pinned;
      const dismissed = inbox ? isSessionDismissed(inbox) : false;
      let needsInput = false;
      let workState: WorkState | null = null;
      if (inbox) {
        // Authoritative: reuse the inbox's own predicates verbatim.
        needsInput = isSessionWaitingForInput(inbox);
        workState = needsInput ? "needs_input" : isSessionEffectivelyIdle(inbox) ? "idle" : "working";
      } else if (s.agent_status) {
        // Fallback for rows with no inbox join (tmux-only / not in recent set).
        needsInput = s.agent_status === "permission_blocked";
        workState = needsInput ? "needs_input" : ACTIVE_AGENT_STATUSES.has(s.agent_status) ? "working" : "idle";
      }

      return {
        ...s, isAlive, bucket, awakeIdleMs, uptime: now - s.started_at, lastActiveAt,
        lastActiveMs: now - lastActiveAt, pinned, dismissed, needsInput, workState,
      };
    });
  }, [sessions, now, inboxById]);

  const filtered = useMemo(() => {
    let rows = filter === "all" ? classified : classified.filter((s) => s.bucket === filter);
    if (triageFilter !== "all") {
      rows = rows.filter((s) =>
        triageFilter === "pinned" ? s.pinned
        : triageFilter === "dismissed" ? s.dismissed
        : triageFilter === "needs_input" ? s.needsInput
        : /* working */ s.workState === "working"
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable secondary order so equal keys don't shuffle on every tick.
      return a.session_id < b.session_id ? -1 : 1;
    });
  }, [classified, filter, triageFilter, sortKey, sortDir]);

  const counts = useMemo(() => {
    const c = { active: 0, idle: 0, dead: 0, total: 0 };
    for (const s of classified) { c.total++; c[s.bucket]++; }
    return c;
  }, [classified]);

  // Triage counts overlap (a row can be both pinned and needs-input) — these are
  // "how many match this state", not mutually-exclusive buckets.
  const triageCounts = useMemo(() => {
    const c = { needs_input: 0, working: 0, pinned: 0, dismissed: 0 };
    for (const s of classified) {
      if (s.needsInput) c.needs_input++;
      if (s.workState === "working") c.working++;
      if (s.pinned) c.pinned++;
      if (s.dismissed) c.dismissed++;
    }
    return c;
  }, [classified]);

  const markBusy = useCallback((sessionId: string) => {
    setBusy((prev) => new Set(prev).add(sessionId));
    setTimeout(() => setBusy((prev) => {
      const next = new Set(prev); next.delete(sessionId); return next;
    }), 2000);
  }, []);

  const handleKill = useCallback(
    (s: ClassifiedSession) => {
      if (!s.conversation_id) return;
      markBusy(s.session_id);
      convCommand(s.conversation_id, "killSession");
    },
    [convCommand, markBusy]
  );

  // Prune removes the stale DB row for a dead session. It does not touch any
  // process (there isn't one) — if a live session is misjudged, its next metrics
  // report simply re-registers it.
  const handlePrune = useCallback(
    async (s: ClassifiedSession) => {
      markBusy(s.session_id);
      try {
        await pruneSession({ session_id: s.session_id });
      } catch (e) {
        console.error("Failed to prune session:", e);
      }
    },
    [pruneSession, markBusy]
  );

  const handleBulk = useCallback(
    async (rows: ClassifiedSession[]) => {
      for (const s of rows) {
        // Prefer a real kill for anything with a conversation — even "dead" rows,
        // whose tmux session + shell often still linger on the machine. killSession
        // reaps the tmux + full process tree (daemon side) AND hides the row. Only
        // conversation-less rows fall back to a plain DB prune.
        if (s.conversation_id) handleKill(s);
        else handlePrune(s);
      }
    },
    [handleKill, handlePrune]
  );

  // Pin/unpin and dismiss/restore write straight to the conversation via the same
  // mutations the inbox uses, so state stays consistent across both surfaces.
  const handleTogglePin = useCallback(
    (s: ClassifiedSession) => {
      if (!s.conversation_id) return;
      markBusy(s.session_id);
      patchConversation(s.conversation_id, { inbox_pinned_at: s.pinned ? null : Date.now() });
    },
    [patchConversation, markBusy]
  );

  const handleToggleDismiss = useCallback(
    (s: ClassifiedSession) => {
      if (!s.conversation_id) return;
      markBusy(s.session_id);
      patchConversation(s.conversation_id, { inbox_dismissed_at: s.dismissed ? null : Date.now() });
    },
    [patchConversation, markBusy]
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
    { value: "idle" as const, label: "Idle 2h+", count: counts.idle },
    { value: "dead" as const, label: "Dead", count: counts.dead },
  ];

  // Kill-all acts on the ENTIRE current view — whatever liveness/triage filters
  // are applied. Conversation rows get a real kill (tmux + tree); the rest prune.
  const bulkRows = filtered;
  const bulkKillCount = bulkRows.filter((s) => s.conversation_id).length;
  const bulkPruneCount = bulkRows.length - bulkKillCount;

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
              <span><span className={counts.idle > 0 ? "text-amber-400" : "text-zinc-600"}>{counts.idle}</span> idle 2h+</span>
              <span className="text-zinc-700">|</span>
              <span><span className="text-zinc-600">{counts.dead}</span> dead</span>
            </div>
          </div>

          {bulkRows.length > 0 && (
            bulkConfirm ? (
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className="text-red-300">
                  Kill {bulkKillCount}{bulkPruneCount > 0 ? ` · prune ${bulkPruneCount}` : ""}? Terminates tmux + claude.
                </span>
                <button
                  onClick={() => { handleBulk(bulkRows); setBulkConfirm(false); }}
                  className="px-3 py-1.5 bg-red-600/90 text-white border border-red-500 rounded-md hover:bg-red-600 transition-colors"
                >
                  Confirm kill
                </button>
                <button
                  onClick={() => setBulkConfirm(false)}
                  className="px-2 py-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setBulkConfirm(true)}
                className="px-3 py-1.5 text-xs font-mono bg-red-950/40 text-red-400 border border-red-900/40 rounded-md hover:bg-red-950/60 hover:border-red-800/50 transition-colors"
                title="Kill every session in the current view (terminates tmux + claude + child processes)"
              >
                Kill all {bulkRows.length}
              </button>
            )
          )}
        </div>

        {/* Filters + sort */}
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

          <div className="ml-auto flex items-center gap-1.5 text-xs font-mono">
            <span className="text-zinc-600">sort</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-zinc-900/60 border border-zinc-800/60 rounded-md px-2 py-1.5 text-zinc-300 hover:text-zinc-100 focus:outline-none focus:border-zinc-700 cursor-pointer"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              className="px-2 py-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded-md text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
              title={sortDir === "asc" ? "Ascending — oldest / smallest first" : "Descending — newest / largest first"}
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>

        {/* Triage filter — the agent's relationship to you (orthogonal to the
            process-liveness filter above). */}
        <div className="flex items-center gap-2 mb-4 -mt-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 font-mono w-12 shrink-0">state</span>
          <div className="flex rounded-md border border-zinc-800/60 overflow-hidden">
            {([
              { value: "all", label: "All", count: counts.total },
              { value: "needs_input", label: "Needs input", count: triageCounts.needs_input },
              { value: "working", label: "Working", count: triageCounts.working },
              { value: "pinned", label: "Pinned", count: triageCounts.pinned },
              { value: "dismissed", label: "Dismissed", count: triageCounts.dismissed },
            ] as { value: TriageFilter; label: string; count: number }[]).map(({ value, label, count }) => (
              <button
                key={value}
                onClick={() => setTriageFilter(value)}
                className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                  triageFilter === value
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
              {counts.total === 0 ? "No active sessions" : "No sessions match these filters"}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
              {filtered.map((session) => {
                const style = BUCKET_STYLES[session.bucket];
                const isBusy = busy.has(session.session_id);
                const isExpanded = expandedSession === session.session_id;

                return (
                  <div
                    key={session._id}
                    className={`bg-zinc-900/60 rounded-lg border transition-colors ${
                      session.pinned ? "border-amber-800/40" : "border-zinc-800/60"
                    } ${
                      session.bucket === "dead" || session.dismissed ? "opacity-50" : ""
                    } ${isBusy ? "opacity-30" : "hover:bg-zinc-900/80"}`}
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

                        {/* Prominent: time since last active. Works for every
                            bucket — for dead rows it reads as "last seen". */}
                        <span
                          className="shrink-0 flex items-baseline gap-1 font-mono tabular-nums"
                          title={`last active ${new Date(session.lastActiveAt).toLocaleString()}`}
                        >
                          <span className="text-sm text-zinc-100">{formatDuration(session.lastActiveMs)}</span>
                          <span className="text-[10px] text-zinc-500">ago</span>
                        </span>

                        {/* Pinned marker */}
                        {session.pinned && (
                          <span className="text-amber-400 text-xs shrink-0" title="pinned">★</span>
                        )}

                        {/* Triage state — the agent's relationship to you. Loud
                            for the actionable states; idle stays quiet. */}
                        {session.dismissed ? (
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-zinc-700/50 text-zinc-500 bg-zinc-800/40 shrink-0" title="dismissed from inbox">
                            dismissed
                          </span>
                        ) : (session.workState === "needs_input" || session.workState === "working") && (
                          <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${WORK_STATE_STYLES[session.workState].cls}`}>
                            {WORK_STATE_STYLES[session.workState].label}
                          </span>
                        )}

                        {/* Liveness bucket (is the process alive) */}
                        <span className={`text-xs font-mono shrink-0 ${style.text}`}>
                          {style.label}
                        </span>
                        {session.bucket === "idle" && (
                          <span className="text-xs font-mono tabular-nums shrink-0 text-amber-400" title="idle while awake (sleep excluded)">
                            idle {formatDuration(session.awakeIdleMs)}
                          </span>
                        )}

                        {/* Actions */}
                        {!isBusy && session.conversation_id && (
                          <>
                            <button
                              onClick={() => handleTogglePin(session)}
                              className={`px-2 py-1 text-[11px] font-mono rounded transition-colors border border-transparent shrink-0 ${
                                session.pinned
                                  ? "text-amber-400 hover:bg-amber-950/30 hover:border-amber-900/40"
                                  : "text-zinc-600 hover:text-amber-400 hover:bg-amber-950/20 hover:border-amber-900/30"
                              }`}
                              title={session.pinned ? "Unpin" : "Pin to top of inbox"}
                            >
                              {session.pinned ? "unpin" : "pin"}
                            </button>
                            <button
                              onClick={() => handleToggleDismiss(session)}
                              className={`px-2 py-1 text-[11px] font-mono rounded transition-colors border border-transparent shrink-0 ${
                                session.dismissed
                                  ? "text-zinc-500 hover:text-emerald-400 hover:bg-emerald-950/20 hover:border-emerald-900/30"
                                  : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50 hover:border-zinc-700/60"
                              }`}
                              title={session.dismissed ? "Restore to inbox" : "Dismiss from inbox"}
                            >
                              {session.dismissed ? "restore" : "dismiss"}
                            </button>
                          </>
                        )}

                        {/* Action: kill a live session, prune a dead row */}
                        {!isBusy && session.bucket === "dead" ? (
                          <button
                            onClick={() => handlePrune(session)}
                            className="px-2 py-1 text-[11px] font-mono text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50 rounded transition-colors border border-transparent hover:border-zinc-700/60 shrink-0"
                            title="Remove this stale row (no live process to kill)"
                          >
                            prune
                          </button>
                        ) : !isBusy && session.conversation_id ? (
                          <button
                            onClick={() => handleKill(session)}
                            className="px-2 py-1 text-[11px] font-mono text-zinc-600 hover:text-red-400 hover:bg-red-950/30 rounded transition-colors border border-transparent hover:border-red-900/40 shrink-0"
                            title="Kill this session"
                          >
                            kill
                          </button>
                        ) : null}
                        {isBusy && (
                          <span className="text-[11px] font-mono text-zinc-600 shrink-0">working…</span>
                        )}
                      </div>

                      {/* What this session is: insight headline, else the last
                          message so every row stays identifiable. */}
                      {(session.headline || session.last_message_preview) && (
                        <div className="mt-1.5 ml-5 text-[12px] text-zinc-500 truncate">
                          {!session.headline && session.last_message_role && (
                            <span className="text-zinc-600">{session.last_message_role}: </span>
                          )}
                          {session.headline || session.last_message_preview}
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
                        <span>pid:{session.agent_pid ?? session.pid}</span>
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
                        {/* Resource metrics reflect a live process tree — suppress for
                            dead rows where the numbers are stale pre-death values. */}
                        {session.isAlive && session.current_memory != null && session.current_memory > 0 && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-sky-500">{(session.current_memory / (1024 * 1024)).toFixed(0)}MB</span>
                          </>
                        )}
                        {session.isAlive && session.current_cpu != null && session.current_cpu > 0 && (
                          <>
                            <span className="text-zinc-700">|</span>
                            <span className="text-amber-500">{session.current_cpu.toFixed(1)}%</span>
                          </>
                        )}
                        {session.isAlive && session.current_pid_count != null && session.current_pid_count > 0 && (
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
