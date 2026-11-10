import { HibernatedMarker } from "../../components/HibernatedMarker";
import { useHibernationCommands } from "../../hooks/useHibernationCommands";
import { fleetBucket, hibernationCandidate, hibernationResultCounts } from "../../lib/hibernation";
import { sessionCommandOutcome } from "@codecast/shared/contracts";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { SwitchReview, type SwitchLedger } from "../../components/consequential/ConsequentialSwitch";
import { killSessionsLedger } from "../../components/consequential/ledgers";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { useTriggerKillNotice } from "../../hooks/useTriggerKillNotice";
import { useAggregateMetrics, useManagedSessions } from "../../hooks/useSyncManagedSessions";
import { AuthGuard } from "../../components/AuthGuard";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
// Reuse the inbox's canonical state predicates so /sessions and /inbox never
// disagree about what "needs input" / "idle" means.
import {
  classifySession,
  type InboxSession,
} from "../../store/inboxStore";
import { deriveTriageFlags } from "./triageFlags";
import { ACTIVE_AGENT_STATUSES, HEARTBEAT_ALIVE_MS } from "@codecast/shared/contracts";
import { PageFrame, PageHeader } from "../../components/ui/page-header";
import { SessionsLegacyHeader } from "./SessionsLegacyHeader";
import { Button } from "../../components/ui/button";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { ModernSessionsRow } from "./ModernSessionRow";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { sessionStructuralSig } from "../../store/inboxStore";

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Parking the view's idle sessions: what is asked, and what the daemon still decides. */
function hibernateLedger(n: number): SwitchLedger {
  return {
    name: `Hibernate ${count(n, "session")}`,
    subject: "Idle in this view",
    shift: ["Running", "Parked"],
    figures: [{ value: String(n), label: "park" }],
    rows: [
      { k: "Sessions", v: count(n, "idle session") },
      { k: "Checked", v: "Daemon skips unsafe ones" },
    ],
    confirm: `Hibernate ${n}`,
    keep: "Keep running",
  };
}

type Session = FunctionReturnType<typeof api.managedSessions.listActiveSessions>[number];
// Cleanup-oriented buckets, computed from liveness + sleep-aware idle — NOT from
// the agent's self-reported status (which says nothing about whether the OS
// process exists, and conflates "done" with "frozen").
type Bucket = "active" | "idle" | "dead" | "hibernated";
// The agent's relationship to YOU — a separate axis from process liveness above.
// "needs input" = blocked on you (open poll / permission); "working" = busy;
// "idle" = at rest. Pinned/dismissed are orthogonal flags layered on top.
type WorkState = "needs_input" | "done" | "working" | "dormant" | "idle";
type ClassifiedSession = Session & {
  has_pending: boolean;
  awaiting_input: boolean;
  pending_api_error: boolean;
  session_error?: string;
  isAlive: boolean;
  bucket: Bucket;
  awakeIdleMs: number;
  uptime: number;
  // Wall-clock timestamp of the last real activity, and ms elapsed since.
  lastActiveAt: number;
  lastActiveMs: number;
  // Triage state, joined from listInboxSessions (the same data the inbox uses).
  pinned: boolean;
  // Out of the active inbox for ANY reason — stashed, dismissed, or killed
  // (the server hides a killed row from listInboxSessions unless it is pinned,
  // so all three belong to the same "not in the inbox" axis). `killed` narrows
  // to the destructive flavor, read from the row's own is_killed — projected
  // off inbox_killed_at, the retired marker every kill surface writes, and NOT
  // from inbox_dismissed_at, which the killSession mutation behind this page's
  // own kill button never sets. It comes off the ROW because the inbox join
  // structurally cannot carry it for an unpinned killed session (see
  // deriveTriageFlags).
  dismissed: boolean;
  killed: boolean;
  needsInput: boolean;
  workState: WorkState | null;
};

const BUCKET_STYLES: Record<Bucket, { label: string; text: string; dot: string }> = {
  hibernated: { label: "hibernated", text: "text-sol-blue", dot: "bg-sol-blue" },
  active: { label: "active",       text: "text-sol-blue",   dot: "bg-sol-blue" },
  idle:   { label: "idle · kill?", text: "text-sol-yellow", dot: "bg-sol-yellow" },
  dead:   { label: "dead",         text: "text-sol-text-dim",  dot: "bg-sol-border" },
};

const WORK_STATE_STYLES: Record<WorkState, { label: string; cls: string }> = {
  needs_input: { label: "needs you", cls: "text-sol-yellow bg-sol-yellow/15 border-sol-yellow/30" },
  done:        { label: "done",        cls: "text-sol-cyan bg-sol-cyan/10 border-sol-cyan/30" },
  working:     { label: "working",     cls: "text-sol-green bg-sol-green/10 border-sol-green/30" },
  dormant:     { label: "dormant",     cls: "text-sol-blue bg-sol-blue/10 border-sol-blue/30" },
  idle:        { label: "idle",        cls: "text-sol-text-muted bg-sol-bg-highlight/50 border-sol-border/40" },
};

type TriageFilter = "all" | "needs_input" | "working" | "pinned" | "dismissed";

// A session is alive if its daemon heartbeat is fresh — the shared
// HEARTBEAT_ALIVE_MS, derived from the write cadence it measures, never a local
// copy. We deliberately do NOT key liveness off last_metrics_at: reportMetrics
// throttles that write to once per 5min, so a live session would otherwise flip
// to "dead" for most of every 5-minute window.
const triageSig = (s: InboxSession) => `${sessionStructuralSig(s)}|${!!s.has_pending}|${!!s.awaiting_input}|${!!s.pending_api_error}|${s.session_error ?? ""}|${!!s.is_pinned}`;

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
        <span className="text-meta font-mono text-sol-text-dim">
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
    <div className="border-t border-sol-border/60">
      <div className="px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-4 text-meta">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-1 rounded-sm bg-sol-blue/60" />
            <span className="text-sol-text-muted">Memory</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 rounded-sm bg-sol-yellow" />
            <span className="text-sol-text-muted">CPU</span>
          </span>
        </div>
        <span className="text-meta font-mono text-sol-text-dim">{metrics.length} samples</span>
      </div>
      <div className="px-4 pb-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 90 }} preserveAspectRatio="none">
          <polygon points={memAreaPoints} fill="color-mix(in srgb, var(--sol-blue) 12%, transparent)" />
          <polyline points={memPoints} fill="none" stroke="color-mix(in srgb, var(--sol-blue) 50%, transparent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <polyline points={cpuPoints} fill="none" stroke="color-mix(in srgb, var(--sol-yellow) 70%, transparent)" strokeWidth="1.5" strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
          {metrics.map((m: MetricsRow, i: number) => (
            <circle key={i} cx={x(m.collected_at)} cy={yMem(m.memory / (1024 * 1024))} r="2" fill="color-mix(in srgb, var(--sol-blue) 70%, transparent)" />
          ))}
        </svg>
      </div>
      <div className="px-4 py-2 border-t border-sol-border/40 flex items-center gap-6 text-meta font-mono">
        <span className="text-sol-text-muted">
          Mem <span className="text-sol-blue">{(latest.memory / (1024 * 1024)).toFixed(0)}MB</span>
        </span>
        <span className="text-sol-text-muted">
          CPU <span className="text-sol-yellow">{latest.cpu.toFixed(1)}%</span>
        </span>
        <span className="text-sol-text-muted">
          Procs <span className="text-sol-text-secondary">{latest.pid_count}</span>
        </span>
      </div>
    </div>
  );
}

// ---- Aggregate Overview ----

function AggregateOverview({ sessions }: { sessions: ClassifiedSession[] }) {
  // Store-fed (hooks/useSyncManagedSessions): the chart paints from the
  // cached samples and the feeder replaces them as the server recomputes.
  const { metrics: aggregateMetrics } = useAggregateMetrics();

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
    <div className="bg-sol-bg-alt/60 rounded-lg border border-sol-border/60 mb-4 overflow-hidden">
      {/* Stats row */}
      <div className="flex items-center gap-6 px-4 py-2.5 text-meta font-mono">
        <span className="text-sol-text-muted">
          <span className="text-sol-text-secondary text-sm">{totals.count}</span> sessions
        </span>
        {totals.mem > 0 && (
          <span className="text-sol-text-muted">
            <span className="text-sol-blue text-sm">{formatBytes(totals.mem)}</span> mem
          </span>
        )}
        {totals.cpu > 0 && (
          <span
            className="text-sol-text-muted"
            title="Sum of each live session's process-tree CPU%. 100% = one full core, so the total can exceed 100% across cores."
          >
            <span className="text-sol-yellow text-sm">{totals.cpu.toFixed(1)}%</span> cpu
          </span>
        )}
        {totals.procs > 0 && (
          <span className="text-sol-text-muted">
            <span className="text-sol-text-secondary text-sm">{totals.procs}</span> procs
          </span>
        )}
        {hasChart && (
          <div className="ml-auto flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm bg-sol-blue/60" />
              <span className="text-sol-text-dim">Memory</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 rounded-sm bg-sol-yellow" />
              <span className="text-sol-text-dim">CPU</span>
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
        <polygon points={memAreaPoints} fill="color-mix(in srgb, var(--sol-blue) 10%, transparent)" />
        <polyline points={memPoints} fill="none" stroke="color-mix(in srgb, var(--sol-blue) 45%, transparent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <polyline points={cpuPoints} fill="none" stroke="color-mix(in srgb, var(--sol-yellow) 60%, transparent)" strokeWidth="1.5" strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

// ---- Main View ----

export function SessionsView() {
  const { commands, request: requestHibernate, error: parkResultError } = useHibernationCommands();
  const viewerId = useInboxStore(s => s.currentUser?._id);
  const [parkConfirm, setParkConfirm] = useState(false);
  const [parkRequests, setParkRequests] = useState<string[]>([]);
  // Store-fed (hooks/useSyncManagedSessions): the fleet table paints from the
  // cached rows synchronously; "loading" shows only for a genuinely cold cache.
  const { sessions: managedRows, ready: managedReady } = useManagedSessions();
  const sessions = managedReady || managedRows.length > 0 ? managedRows : undefined;
  // Triage state (pinned / needs-input / working / dismissed) lives on the
  // conversation row — the inbox's own synced sessions collection, joined by
  // id, so no second listInboxSessions subscription duplicates the sync.
  const inboxRows = useCollectionRows<InboxSession>("sessions", { sig: triageSig });
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
  // The shared coarse clock (one timer, deferred while typing) drives the ages.
  const now = useCoarseNow(15_000);
  const modern = useIsModernStyle();
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  // The bulk kill's review (destructive, fleet-wide) is open.
  const [bulkConfirm, setBulkConfirm] = useState(false);

  // Reset the kill-all confirm whenever the visible set changes, so a pending
  // confirm can't apply to a different list than the one the user was looking at.
  useEffect(() => { setBulkConfirm(false); setParkConfirm(false); }, [filter, triageFilter]);

  const inboxById = useMemo(() => {
    const m = new Map<string, InboxSession>();
    for (const row of inboxRows) m.set(row._id, row);
    return m;
  }, [inboxRows]);

  const classified = useMemo((): ClassifiedSession[] => {
    if (!sessions) return [];
    return sessions.map((s: Session) => {
      const isAlive = s.agent_status !== "hibernated" && now - s.last_heartbeat < HEARTBEAT_ALIVE_MS;
      const awakeIdleMs = s.awake_idle_ms ?? 0;
      const bucket = fleetBucket(s, now);
      // "Last active" = the most recent moment anything happened. conversation
      // updated_at tracks real activity; fall back to the heartbeat for
      // conversation-less (tmux-only) rows, then to start time.
      const lastActiveAt = s.conversation_updated_at ?? s.last_heartbeat ?? s.started_at;

      const inbox = s.conversation_id ? inboxById.get(String(s.conversation_id)) : undefined;
      const pinned = !!inbox?.is_pinned;
      const { killed, dismissed } = deriveTriageFlags(inbox, s.is_killed);
      let needsInput = false;
      let workState: WorkState | null = null;
      if (inbox) {
        // Authoritative: reuse the inbox's own predicates verbatim. A settled
        // row's `rest` verdict picks needs_input / done / dormant, exactly as
        // the inbox sections do.
        const c = classifySession(inbox, now);
        needsInput = c.waiting && c.rest === "needs_input";
        workState = c.waiting ? c.rest : c.idle ? "idle" : "working";
      } else if (s.agent_status) {
        // Fallback for rows with no inbox join (tmux-only / not in recent set).
        needsInput = s.agent_status === "permission_blocked";
        workState = needsInput ? "needs_input" : s.agent_status === "hibernated" ? "dormant" : ACTIVE_AGENT_STATUSES.has(s.agent_status) ? "working" : "idle";
      }

      return {
        ...s, has_pending: !!inbox?.has_pending, awaiting_input: !!inbox?.awaiting_input, pending_api_error: !!inbox?.pending_api_error, session_error: inbox?.session_error, isAlive, bucket, awakeIdleMs, uptime: now - s.started_at, lastActiveAt,
        lastActiveMs: now - lastActiveAt, pinned, dismissed, killed, needsInput, workState,
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
    const c = { active: 0, idle: 0, dead: 0, hibernated: 0, total: 0 };
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

  // A kill here is the same gesture as everywhere else: the store's kill
  // action paints the hide, records one undo entry with its Undo toast and
  // says which triggers died with it (useTriggerKillNotice).
  const { killWithNotice, killManyWithNotice } = useTriggerKillNotice();
  const handleKill = useCallback(
    (s: ClassifiedSession) => {
      if (!s.conversation_id) return;
      markBusy(s.session_id);
      killWithNotice(s.conversation_id);
    },
    [killWithNotice, markBusy]
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
      // Prefer a real kill for anything with a conversation — even "dead" rows,
      // whose tmux session + shell often still linger on the machine. The kill
      // reaps the tmux + full process tree (daemon side) AND hides the row, as
      // one gesture and one undo for the whole confirm. Only conversation-less
      // rows fall back to a plain DB prune.
      const kills = rows.filter((s) => s.conversation_id);
      for (const s of kills) markBusy(s.session_id);
      killManyWithNotice(kills.map((s) => s.conversation_id!));
      for (const s of rows) if (!s.conversation_id) handlePrune(s);
    },
    [killManyWithNotice, handlePrune, markBusy]
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
      // Restore clears the retired marker too, or a row killed by a path that
      // stamps inbox_killed_at without inbox_dismissed_at (the killSession
      // mutation, behind `cast` and older clients) would keep its "restore"
      // button forever while shouldShowInInbox went on hiding it. Nulling all
      // three is what `cast undismiss` does, and it is the un-kill SHAPE the
      // dispatch rail requires before it will honor a kill-clear (dispatch.ts).
      patchConversation(s.conversation_id, s.dismissed
        ? { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null }
        : { inbox_stashed_at: Date.now() });
    },
    [patchConversation, markBusy]
  );

  if (sessions === undefined) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-sol-bg text-sol-text flex items-center justify-center">
        <div className="text-sol-text-muted font-mono text-sm">loading sessions...</div>
      </div>
    );
  }

  const filterButtons = [
    { value: "all" as const, label: "All", count: counts.total },
    { value: "active" as const, label: "Active", count: counts.active },
    { value: "idle" as const, label: "Idle 2h+", count: counts.idle },
    { value: "hibernated" as const, label: "Hibernated", count: counts.hibernated },
    { value: "dead" as const, label: "Dead", count: counts.dead },
  ];

  // Kill-all acts on the ENTIRE current view — whatever liveness/triage filters
  // are applied. Conversation rows get a real kill (tmux + tree); the rest prune.
  const bulkRows = filtered;
  const parkCandidates = filtered.filter(row => hibernationCandidate(row, viewerId, now) &&
    !commands.some(c => c.conversation_id === row.conversation_id && !c.executed_at)).slice(0, Math.max(0, 100 - commands.filter(c => !c.executed_at).length));
  const parkResults = commands.filter(c => parkRequests.includes(c._id));
  const parkCounts = hibernationResultCounts(parkResults);
  const bulkKillCount = bulkRows.filter((s) => s.conversation_id).length;
  const bulkPruneCount = bulkRows.length - bulkKillCount;
  // The shared kill review, plus the stale rows the same press prunes.
  const bulkKillBase = killSessionsLedger({
    total: bulkKillCount,
    working: bulkRows.filter((s) => s.conversation_id && s.workState === "working").map((s) => s.conversation_title || s.tmux_session || s.session_id.slice(0, 12)),
  });
  const bulkKillLedger: SwitchLedger = bulkKillCount === 0
    ? { name: `Prune ${count(bulkPruneCount, "stale row")}`, subject: "No process left to kill", shift: null, figures: [{ value: String(bulkPruneCount), label: "prune" }], rows: [{ k: "Pruned", v: count(bulkPruneCount, "stale row") }], confirm: `Prune ${bulkPruneCount}`, keep: "Keep them" }
    : bulkPruneCount > 0
      ? { ...bulkKillBase, rows: [...bulkKillBase.rows, { k: "Pruned", v: count(bulkPruneCount, "stale row") }] }
      : bulkKillBase;

  // The two presses' reviews, open or not, drawn by whichever header is up.
  const reviews = {
    park: parkConfirm && parkCandidates.length > 0 && (
      <SwitchReview
        ledger={hibernateLedger(parkCandidates.length)}
        onClose={() => setParkConfirm(false)}
        onConfirm={() => {
          setParkRequests(parkCandidates.map(row => requestHibernate(String(row.conversation_id), row.session_id, row.owner_device_id!)));
          setParkConfirm(false);
        }}
      />
    ),
    kill: bulkConfirm && bulkRows.length > 0 && (
      <SwitchReview
        ledger={bulkKillLedger}
        onClose={() => setBulkConfirm(false)}
        onConfirm={() => { handleBulk(bulkRows); setBulkConfirm(false); }}
      />
    ),
  };
  const park = () => setParkConfirm(true);
  const kill = () => setBulkConfirm(true);
  // Modern: the liveness split (active, idle, hibernated, dead) is on the
  // filter buttons under the header; the header says the total.
  const header = (
    <PageHeader
      legacy={<SessionsLegacyHeader counts={counts} parkCount={parkCandidates.length} onPark={park} killCount={bulkRows.length} onKill={kill} reviews={reviews} />}
      title="Sessions"
      count={counts.total}
      crumbs={<Link href="/inbox" className="hover:text-sol-text">Inbox</Link>}
      actions={<>
        <Button asChild variant="ghost" size="sm" title="CPU, memory and processes per machine and session"><Link href="/resources">Resources</Link></Button>
        <Button variant="outline" size="sm" disabled={!parkCandidates.length} onClick={park} aria-haspopup="dialog" title="Request parking for your idle sessions in this view; the daemon checks safety again">Hibernate idle ({parkCandidates.length})</Button>
        {reviews.park}
        {bulkRows.length > 0 && (
          <Button variant="red" size="sm" onClick={kill} aria-haspopup="dialog" title="Kill every session in the current view (terminates tmux + claude + child processes)">
            Kill all {bulkRows.length}
          </Button>
        )}
        {reviews.kill}
      </>}
    />
  );

  return (
    <PageFrame
      header={header}
      legacyScroll="h-full min-h-0 overflow-y-auto bg-sol-bg text-sol-text"
      legacyColumn="max-w-[1200px] mx-auto px-6 py-6"
      column="max-w-[1200px] mx-auto px-4 py-6 sm:px-6 text-sol-text"
    >
        {parkRequests.length > 0 && <div role="status" className="mb-4 rounded border border-sol-border p-3 text-xs text-sol-text-dim">
          {parkCounts.pending} parking requested · {parkCounts.succeeded} hibernated · {parkCounts.skipped} skipped · {parkCounts.failed} failed
          {parkResultError && parkCounts.pending > 0 && <div className="mt-1">Command results unavailable; parking is not confirmed.</div>}
          {parkResults.filter(c => ["skipped", "failed"].includes(sessionCommandOutcome(c).state)).map(c => <div key={c._id} className="mt-1">{classified.find(s => s.conversation_id === c.conversation_id)?.conversation_title ?? c.conversation_id}: {sessionCommandOutcome(c).message}</div>)}
        </div>}

        {/* Filters + sort */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="flex flex-wrap rounded-md border border-sol-border/60 overflow-hidden">
            {filterButtons.map(({ value, label, count }) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                  filter === value
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "bg-sol-bg-alt/40 text-sol-text-muted hover:text-sol-text-secondary"
                }`}
              >
                {label} <span className="text-sol-text-dim ml-1">{count}</span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1.5 text-xs font-mono">
            <span className="text-sol-text-dim">sort</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-sol-bg-alt/60 border border-sol-border/60 rounded-md px-2 py-1.5 text-sol-text-secondary hover:text-sol-text focus:outline-none focus:border-sol-border cursor-pointer"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              className="px-2 py-1.5 bg-sol-bg-alt/60 border border-sol-border/60 rounded-md text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors"
              title={sortDir === "asc" ? "Ascending — oldest / smallest first" : "Descending — newest / largest first"}
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>

        {/* Triage filter — the agent's relationship to you (orthogonal to the
            process-liveness filter above). */}
        <div className="flex flex-wrap items-center gap-2 mb-4 -mt-1">
          <span className="text-mark uppercase tracking-wider text-sol-text-dim font-mono w-12 shrink-0">state</span>
          <div className="flex flex-wrap rounded-md border border-sol-border/60 overflow-hidden">
            {([
              { value: "all", label: "All", count: counts.total },
              { value: "needs_input", label: "Needs you", count: triageCounts.needs_input },
              { value: "working", label: "Working", count: triageCounts.working },
              { value: "pinned", label: "Pinned", count: triageCounts.pinned },
              { value: "dismissed", label: "Dismissed", count: triageCounts.dismissed },
            ] as { value: TriageFilter; label: string; count: number }[]).map(({ value, label, count }) => (
              <button
                key={value}
                onClick={() => setTriageFilter(value)}
                className={`px-3 py-1.5 text-xs font-mono transition-colors ${
                  triageFilter === value
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "bg-sol-bg-alt/40 text-sol-text-muted hover:text-sol-text-secondary"
                }`}
              >
                {label} <span className="text-sol-text-dim ml-1">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Aggregate overview + chart */}
        <AggregateOverview sessions={filtered} />

        {/* Table */}
        {filtered.length === 0 ? (
          <div className="bg-sol-bg-alt/40 rounded-lg border border-sol-border/60 p-12 text-center">
            <div className="text-sol-text-dim text-sm">
              {counts.total === 0 ? "No active sessions" : "No sessions match these filters"}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
              {filtered.map((session) => {
                const style = BUCKET_STYLES[session.bucket];
                const isBusy = busy.has(session.session_id);
                const isExpanded = expandedSession === session.session_id;
                if (modern) return <ModernSessionsRow key={session._id} row={session} inbox={session.conversation_id ? inboxById.get(String(session.conversation_id)) : undefined} now={now} busy={isBusy} expanded={isExpanded} parking={commands.some(c => c.conversation_id === session.conversation_id && !c.executed_at)}
                  onToggleExpand={() => setExpandedSession(isExpanded ? null : session.session_id)} onPin={() => handleTogglePin(session)} onStash={() => handleToggleDismiss(session)} onKill={() => handleKill(session)} onPrune={() => handlePrune(session)}><SessionMetricsChart sessionId={session.session_id} /></ModernSessionsRow>;

                return (
                  <div
                    key={session._id}
                    className={`bg-sol-bg-alt/60 rounded-lg border transition-colors ${
                      session.pinned ? "border-sol-yellow/30" : "border-sol-border/60"
                    } ${
                      session.bucket === "dead" || session.dismissed ? "opacity-50" : ""
                    } ${isBusy ? "opacity-30" : "hover:bg-sol-bg-alt/80"}`}
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
                      <div className="flex flex-wrap items-center gap-3">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
                        <div className="min-w-0 basis-[calc(100%-2rem)] sm:basis-0 sm:flex-1">
                          {session.conversation_id ? (
                            <Link
                              href={`/conversation/${session.conversation_id}`}
                              className="text-sm text-sol-text hover:text-white truncate block transition-colors"
                            >
                              {session.conversation_title || session.tmux_session || session.session_id.slice(0, 12)}
                            </Link>
                          ) : (
                            <span className="text-sm text-sol-text-muted truncate block">
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
                          <span className="text-sm text-sol-text">{formatDuration(session.lastActiveMs)}</span>
                          <span className="text-meta text-sol-text-muted">ago</span>
                        </span>

                        <HibernatedMarker status={session.agent_status} />
                        {commands.some(c => c.conversation_id === session.conversation_id && !c.executed_at) && <span className="text-meta text-sol-blue">parking requested</span>}

                        {/* Pinned marker */}
                        {session.pinned && (
                          <span className="text-sol-yellow text-xs shrink-0" title="pinned">★</span>
                        )}

                        {/* Triage state — the agent's relationship to you. Loud
                            for the actionable states; idle stays quiet. */}
                        {session.dismissed ? (
                          <span className="text-meta font-mono px-1.5 py-0.5 rounded border border-sol-border/50 text-sol-text-muted bg-sol-bg-highlight/40 shrink-0" title={session.killed ? "killed (hidden from inbox, agent torn down)" : "stashed (hidden from inbox, agent alive)"}>
                            {session.killed ? "killed" : "stashed"}
                          </span>
                        ) : (session.workState === "needs_input" || session.workState === "working") && (
                          <span className={`text-meta font-mono px-1.5 py-0.5 rounded border shrink-0 ${WORK_STATE_STYLES[session.workState].cls}`}>
                            {WORK_STATE_STYLES[session.workState].label}
                          </span>
                        )}

                        {/* Liveness bucket (is the process alive) */}
                        <span className={`text-xs font-mono shrink-0 ${style.text}`}>
                          {style.label}
                        </span>
                        {session.bucket === "idle" && (
                          <span className="text-xs font-mono tabular-nums shrink-0 text-sol-yellow" title="idle while awake (sleep excluded)">
                            idle {formatDuration(session.awakeIdleMs)}
                          </span>
                        )}

                        {/* Actions */}
                        {!isBusy && session.conversation_id && (
                          <>
                            <button
                              onClick={() => handleTogglePin(session)}
                              className={`px-2 py-1 text-meta rounded transition-colors border border-transparent shrink-0 ${
                                session.pinned
                                  ? "text-sol-yellow hover:bg-sol-yellow/10 hover:border-sol-yellow/30"
                                  : "text-sol-text-dim hover:text-sol-yellow hover:bg-sol-yellow/10 hover:border-sol-yellow/30"
                              }`}
                              title={session.pinned ? "Unpin" : "Pin to top of inbox"}
                            >
                              {session.pinned ? "Unpin" : "Pin"}
                            </button>
                            <button
                              onClick={() => handleToggleDismiss(session)}
                              className={`px-2 py-1 text-meta rounded transition-colors border border-transparent shrink-0 ${
                                session.dismissed
                                  ? "text-sol-text-muted hover:text-sol-green hover:bg-sol-green/10 hover:border-sol-green/30"
                                  : "text-sol-text-dim hover:text-sol-text-secondary hover:bg-sol-bg-highlight/50 hover:border-sol-border/60"
                              }`}
                              title={session.dismissed ? "Restore to inbox" : "Stash from inbox (keeps agent running)"}
                            >
                              {session.dismissed ? "Restore" : "Stash"}
                            </button>
                          </>
                        )}

                        {/* Action: kill a live session, prune a dead row */}
                        {!isBusy && session.bucket === "dead" ? (
                          <button
                            onClick={() => handlePrune(session)}
                            className="px-2 py-1 text-meta text-sol-text-dim hover:text-sol-text-secondary hover:bg-sol-bg-highlight/50 rounded transition-colors border border-transparent hover:border-sol-border/60 shrink-0"
                            title="Remove this stale row (no live process to kill)"
                          >
                            Prune
                          </button>
                        ) : !isBusy && session.conversation_id ? (
                          <button
                            onClick={() => handleKill(session)}
                            className="px-2 py-1 text-meta text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10 rounded transition-colors border border-transparent hover:border-sol-red/30 shrink-0"
                            title="Kill this session"
                          >
                            Kill
                          </button>
                        ) : null}
                        {isBusy && (
                          <span className="text-meta font-mono text-sol-text-dim shrink-0">working…</span>
                        )}
                      </div>

                      {/* What this session is: insight headline, else the last
                          message so every row stays identifiable. */}
                      {(session.headline || session.last_message_preview) && (
                        <div className="mt-1.5 ml-5 text-[12px] text-sol-text-muted truncate">
                          {!session.headline && session.last_message_role && (
                            <span className="text-sol-text-dim">{session.last_message_role}: </span>
                          )}
                          {session.headline || session.last_message_preview}
                        </div>
                      )}

                      {/* Metadata row */}
                      <div className="mt-1.5 ml-5 flex items-center gap-3 text-meta text-sol-text-dim font-mono flex-wrap">
                        <span>{projectName(session.project_path)}</span>
                        {session.git_branch && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span className="text-sol-text-muted truncate max-w-[16rem]" title={session.git_branch}>
                              {session.git_branch}
                            </span>
                          </>
                        )}
                        {session.worktree_name && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span className="text-sol-cyan">wt:{session.worktree_name}</span>
                          </>
                        )}
                        {session.model && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span>{session.model}</span>
                          </>
                        )}
                        <span className="text-sol-border">|</span>
                        <span>pid:{session.agent_pid ?? session.pid}</span>
                        {session.message_count != null && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span>{session.message_count} msgs</span>
                          </>
                        )}
                        <span className="text-sol-border">|</span>
                        <span>up {formatDuration(session.uptime)}</span>
                        {session.is_subagent && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span className="text-sol-violet">subagent</span>
                          </>
                        )}
                        {/* Resource metrics reflect a live process tree — suppress for
                            dead rows where the numbers are stale pre-death values. */}
                        {session.isAlive && session.current_memory != null && session.current_memory > 0 && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span className="text-sol-blue">{(session.current_memory / (1024 * 1024)).toFixed(0)}MB</span>
                          </>
                        )}
                        {session.isAlive && session.current_cpu != null && session.current_cpu > 0 && (
                          <>
                            <span className="text-sol-border">|</span>
                            <span className="text-sol-yellow">{session.current_cpu.toFixed(1)}%</span>
                          </>
                        )}
                        {session.isAlive && session.current_pid_count != null && session.current_pid_count > 0 && (
                          <>
                            <span className="text-sol-border">|</span>
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
    </PageFrame>
  );
}

export default function SessionsPage() {
  return (
    <AuthGuard>
      <SessionsView />
    </AuthGuard>
  );
}
