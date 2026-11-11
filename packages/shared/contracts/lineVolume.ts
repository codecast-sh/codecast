// The Volume page's three readings beside the funnel (lineFunnel.ts), each
// folded by the hourly flow map rollup (convex flowMap.ts) so the page reads
// one row and no query of its own:
//   backlog   every open problem, whatever its age, by where it stands now and
//             why it is not moving (backlogStand), with a capped list behind
//             each count;
//   days      per UTC day of the window, problems opened, runs started,
//             changes landed and problems closed clean, from every problem's
//             own timestamps (flowEvents), so a run started today on a
//             problem from August counts today;
//   coverage  per source and kind, what arrived each day against what was
//             read: a conversation moment judged or failed or still waiting,
//             a recording read for issues.
// Pure.
import { quietWatchEnd, utcDayKey, windowDays } from "./flowMap";
import { segmentTopOf } from "./flowPool";
import { clearsBar, type FlowBar } from "./linePriority";
import { endedFailing, mergeLeft, runEnd } from "./lineRunEnd";
import { FUNNEL_DAYS, type FunnelRun, type FunnelTask } from "./lineFunnel";

/** Where an open problem stands. Before a run: no project to own it, a project with no lead, a source the flow does not
 *  take, not marked ready, no goal named, under the flow's bar, or eligible and waiting for a free hand. With a live
 *  run: at a station, waiting on a person, ready to land, or stalled (no move in STALLED_MS). After its run ended with
 *  the problem still open: failed, under watch, in a person's hands (in progress with no run), or ended some other way
 *  (other: a close station that left the problem open, a run that stopped after triage). */
export type BacklogStand =
  | "noproject" | "nolead" | "offsource" | "notready" | "nogoal" | "underbar" | "eligible"
  | "running" | "waiting" | "land" | "stalled" | "failed" | "watching" | "inhand" | "other";
/** Display order: what keeps a problem from starting, then what moves, then what stopped. */
export const BACKLOG_STANDS: readonly BacklogStand[] = ["noproject", "nolead", "offsource", "notready", "nogoal", "underbar", "eligible", "running", "waiting", "land", "stalled", "failed", "watching", "inhand", "other"];
/** The stands that mean nothing will move the problem until a person changes something. */
export const BACKLOG_BLOCKED: ReadonlySet<BacklogStand> = new Set(["noproject", "nolead", "offsource", "stalled", "failed"]);
/** Items kept per stand, newest first. */
export const BACKLOG_ITEM_CAP = 25;
const STALLED_MS = 8 * 3_600_000;
/** The stations whose completion puts a change on the default branch (a push alone does not). */
const LANDED = /^(?:merge|land|ship|shipped)$/;
/** The landing stations where a waiting run holds a change for a person to land (a rebase that asks is a question). */
const READY_TO_LAND = /^(?:push|merge|ready_to_land|land)$/;
const LIVE = new Set(["pending", "running", "paused"]);
const OPEN = new Set(["open", "in_progress", "in_review"]);
const TITLE_MAX = 140;

export type BacklogItem = {
  task: string;
  ref: string | null;
  title: string;
  run: string | null;
  /** When the problem was opened. */
  at: number;
  stand: BacklogStand;
  /** The station its run stands at, or the last one it reached. */
  node: string | null;
  status: string | null;
  project: string | null;
};

export type FlowDay = { day: string; opened: number; ran: number; landed: number; clean: number };

export type FlowBacklog = {
  at: number;
  total: number;
  /** Largest first. */
  stands: Array<{ stand: BacklogStand; n: number }>;
  /** Per project and stand, largest first (null: no project). */
  projects: Array<{ project: string | null; stand: BacklogStand; n: number }>;
  /** Per stand, the station its runs stand at or last reached, largest first. */
  stations: Array<{ stand: BacklogStand; node: string; n: number }>;
  items: BacklogItem[];
  /** FUNNEL_DAYS days, oldest first. */
  days: FlowDay[];
};

type Run = FunnelRun & { updated_at?: number; created_at?: number };
type Task = FunnelTask & { project_id?: string | null; updated_at?: number };

/** Where one open problem stands (BacklogStand). */
export function backlogStand(o: {
  task: Task;
  run: Run | null | undefined;
  waiting?: boolean;
  bar?: Pick<FlowBar, "score" | "findings"> | null;
  /** An active role owns it (orgLine.lineOwnerOf). Unknown counts as yes. */
  owned?: boolean;
  /** The flow takes its source. Unknown counts as yes. */
  sourceTaken?: boolean;
  now: number;
}): BacklogStand {
  const { task, run, now } = o;
  if (run && LIVE.has(run.status)) {
    const at = run.current_node_id ?? "";
    // Waiting at a landing station is a change ready for a person to land; working there (a rebase, a merge) still runs.
    if (run.status === "paused" || o.waiting || task.waiting_since) return READY_TO_LAND.test(at) || READY_TO_LAND.test(segmentTopOf(at)) ? "land" : "waiting";
    return now - (run.updated_at ?? run.created_at ?? now) > STALLED_MS ? "stalled" : "running";
  }
  if (run) {
    if (mergeLeft(run)) return "land";
    if (typeof task.watch_until === "number" && task.watch_until > now) return "watching";
    if (task.waiting_since) return "waiting";
    if (run.status === "failed" || run.status === "cancelled" || endedFailing(run)) return "failed";
    return "other";
  }
  if (task.status !== "open") return "inhand";
  if (o.owned === false) return task.project_id ? "nolead" : "noproject";
  if (o.sourceTaken === false) return "offsource";
  if (task.readiness !== "ready") return "notready";
  if (!task.goal_ref?.trim()) return "nogoal";
  if (!clearsBar(task, o.bar)) return "underbar";
  return "eligible";
}

/** One open problem as the backlog lists it; null for one that is closed or merged into another. */
export function backlogItem(o: Parameters<typeof backlogStand>[0] & { labels: ReadonlyMap<string, string> }): BacklogItem | null {
  const { task, run } = o;
  if (task.cause?.merged_into || !OPEN.has(task.status)) return null;
  const live = !!run && LIVE.has(run.status);
  const at = live ? run!.current_node_id : [...(run?.node_statuses ?? [])].filter((n) => n.status !== "pending" && n.node_id !== "exit").sort((a, b) => (a.completed_at ?? a.started_at ?? 0) - (b.completed_at ?? b.started_at ?? 0)).pop()?.node_id;
  const name = task.cause?.named?.name?.trim() || task.title;
  return {
    task: task._id, ref: task.short_id ?? null, title: name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name,
    run: run?._id ?? null, at: task.created_at, stand: backlogStand(o),
    node: at ? o.labels.get(at) ?? o.labels.get(segmentTopOf(at)) ?? at : null,
    status: run?.status ?? null, project: task.project_id ? String(task.project_id) : null,
  };
}

/** When a problem was opened, its run started, its change landed (a landing station completed, never a merge left
 *  to a person, never a push alone) and it closed clean (its watch ended quiet). Merged problems count in the one they joined. */
export type FlowEvents = { opened: number; ran?: number; landed?: number; clean?: number };
export function flowEvents(task: Task, run: Run | null | undefined, now: number): FlowEvents | null {
  if (task.cause?.merged_into) return null;
  const out: FlowEvents = { opened: task.created_at };
  if (!run) return out;
  if (run.created_at) out.ran = run.created_at;
  if (mergeLeft(run)) return out;
  const landedAt = Math.max(0, ...(run.node_statuses ?? []).filter((n) => n.status === "completed" && LANDED.test(n.node_id)).map((n) => n.completed_at ?? n.started_at ?? 0));
  const end = runEnd(run);
  const landed = landedAt || (end?.kind === "shipped" ? end.at : 0);
  if (!landed) return out;
  out.landed = landed;
  const clean = task.status === "done" ? quietWatchEnd(task, now) : null;
  if (clean != null) out.clean = clean;
  return out;
}

/** The window's days from every problem's events. */
export function foldDays(events: ReadonlyArray<FlowEvents>, now: number, days = FUNNEL_DAYS): FlowDay[] {
  const keys = windowDays(now, days);
  const by = new Map(keys.map((day) => [day, { day, opened: 0, ran: 0, landed: 0, clean: 0 }]));
  const add = (at: number | undefined, k: "opened" | "ran" | "landed" | "clean") => { if (at != null && at <= now) { const d = by.get(utcDayKey(at)); if (d) d[k]++; } };
  for (const e of events) { add(e.opened, "opened"); add(e.ran, "ran"); add(e.landed, "landed"); add(e.clean, "clean"); }
  return keys.map((k) => by.get(k)!);
}

/** The backlog from one item per open problem and every problem's events. */
export function foldBacklog(o: { items: ReadonlyArray<BacklogItem>; events: ReadonlyArray<FlowEvents>; now: number }): FlowBacklog {
  const count = <K extends string>(keyOf: (x: BacklogItem) => K | null) => {
    const m = new Map<K, number>();
    for (const x of o.items) { const k = keyOf(x); if (k != null) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const kept = new Map<BacklogStand, number>();
  const items = [...o.items].sort((a, b) => b.at - a.at).filter((x) => {
    const n = kept.get(x.stand) ?? 0;
    kept.set(x.stand, n + 1);
    return n < BACKLOG_ITEM_CAP;
  });
  return {
    at: o.now,
    total: o.items.length,
    stands: count((x) => x.stand).map(([stand, n]) => ({ stand, n })),
    projects: count((x) => `${x.project ?? ""}\u0000${x.stand}`).map(([k, n]) => {
      const [project, stand] = k.split("\u0000");
      return { project: project || null, stand: stand as BacklogStand, n };
    }),
    stations: count((x) => (x.node ? `${x.stand}\u0000${x.node}` : null)).map(([k, n]) => {
      const [stand, node] = k.split("\u0000");
      return { stand: stand as BacklogStand, node, n };
    }),
    items,
    days: foldDays(o.events, o.now),
  };
}

/** The items behind a backlog count: one stand, or one stand in one project. At most what the rollup kept. */
export function backlogItemsOf(b: FlowBacklog, stand: BacklogStand, project?: string | null): BacklogItem[] {
  return b.items.filter((x) => x.stand === stand && (project === undefined || x.project === project));
}

// ── coverage ────────────────────────────────────────────────────────────────

/** One day of a source's arrivals against what read them. A moment: arrived = judged + failed + waiting (not judged
 *  yet), read = extracted. A recording: read = its stream read for issues; judged = read by a judge (a replay moment). */
export type CoverageDay = { day: string; arrived: number; read: number; judged: number; failed: number; waiting: number };
/** Per event source and kind: a moment kind ("conversation", "call", "replay"), or "recording" for the source's replays. */
export type SourceCoverage = { source_id: string; kind: string; days: CoverageDay[] };
export const RECORDING = "recording";

/** One moment's day and state, from its row and its newest judge run's status. */
export function momentCoverage(m: { created_at: number; status: string; judged_at?: number | null }, judged: string | null | undefined): { day: string } & Omit<CoverageDay, "day"> {
  const failed = m.status === "failed" || judged === "failed";
  const ok = !failed && !!m.judged_at;
  return { day: utcDayKey(m.created_at), arrived: 1, read: m.status === "ready" ? 1 : 0, judged: ok ? 1 : 0, failed: failed ? 1 : 0, waiting: !failed && !ok ? 1 : 0 };
}

/** One recording's day and whether its stream was read (imported, summarized or assembled). */
export function recordingCoverage(r: { started_at: number; imported_at?: number | null; shape?: unknown; timeline_at?: number | null }): { day: string } & Omit<CoverageDay, "day"> {
  const read = r.imported_at != null || r.shape != null || r.timeline_at != null ? 1 : 0;
  return { day: utcDayKey(r.started_at), arrived: 1, read, judged: 0, failed: 0, waiting: 0 };
}

/**
 * The coverage row: this pass's counts for days from `from` on, the older days of `prev` kept, every day outside the
 * window dropped. A late read of an older day is not seen until a full recount (a row with no coverage yet).
 */
export function foldCoverage(o: {
  prev?: ReadonlyArray<SourceCoverage> | null;
  from: number;
  now: number;
  rows: ReadonlyArray<{ source_id: string; kind: string } & CoverageDay>;
}): SourceCoverage[] {
  const window = new Set(windowDays(o.now, FUNNEL_DAYS));
  const fromDay = utcDayKey(o.from);
  const by = new Map<string, { source_id: string; kind: string; days: Map<string, CoverageDay> }>();
  const row = (source_id: string, kind: string) => {
    const k = `${source_id}\u0000${kind}`;
    return by.get(k) ?? by.set(k, { source_id, kind, days: new Map() }).get(k)!;
  };
  for (const p of o.prev ?? []) for (const d of p.days) if (d.day < fromDay && window.has(d.day)) row(p.source_id, p.kind).days.set(d.day, d);
  for (const x of o.rows) {
    if (!window.has(x.day) || x.day < fromDay) continue;
    const r = row(x.source_id, x.kind);
    const d = r.days.get(x.day) ?? { day: x.day, arrived: 0, read: 0, judged: 0, failed: 0, waiting: 0 };
    r.days.set(x.day, { day: x.day, arrived: d.arrived + x.arrived, read: d.read + x.read, judged: d.judged + x.judged, failed: d.failed + x.failed, waiting: d.waiting + x.waiting });
  }
  return [...by.values()].map((r) => ({ source_id: r.source_id, kind: r.kind, days: [...r.days.values()].sort((a, b) => a.day.localeCompare(b.day)) }));
}

/** A coverage row's totals over its last `days` days (1: today). */
export function coverageTotals(c: Pick<SourceCoverage, "days">, now: number, days: number): Omit<CoverageDay, "day"> {
  const keys = new Set(windowDays(now, days));
  const t = { arrived: 0, read: 0, judged: 0, failed: 0, waiting: 0 };
  for (const d of c.days) if (keys.has(d.day)) { t.arrived += d.arrived; t.read += d.read; t.judged += d.judged; t.failed += d.failed; t.waiting += d.waiting; }
  return t;
}
