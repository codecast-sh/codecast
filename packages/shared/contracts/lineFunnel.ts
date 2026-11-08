// The line's volume over a window (the Flows page's Volume view): the signals
// that came in, the problems opened from them, the runs started on those
// problems, how far each run got through the live flow's stations, and what
// then merged, went live and closed clean after its watch. Between steps, the
// drop-off by why: closed at a station, dropped, failed, cancelled, standing at
// a station now, waiting on a person. The hourly flow map rollup (convex
// flowMap.ts) reads one item per problem, folds the windows and carries a
// capped list of the items behind each number, so the chart opens every count
// with no query of its own. Pure.
import { quietWatchEnd } from "./flowMap";
import { segmentTopOf } from "./flowPool";
import { clearsBar, type FlowBar } from "./linePriority";
import { endedFailing, mergeLeft, runEnd, type AnsweredGate, type LineRunStations } from "./lineRunEnd";

export const DAY = 86_400_000;
/** The windows the chart switches between, in days. The longest bounds what the rollup reads. */
export const FUNNEL_WINDOWS = [7, 30] as const;
export const FUNNEL_DAYS = 30;
/** Items kept per (step, why) bucket, newest first: enough to open, small enough to ride the flow map. */
export const FUNNEL_ITEM_CAP = 40;

/** Why a problem stopped at a step: its run closed it there (already fixed, not needed), a person dropped it, its run
 *  failed or was cancelled, it stands there now, it waits on a person's card, it is ready and over the flow's bar
 *  with no run yet (unstarted), it is held back (not ready, or under the bar), it is under watch, or it came back after
 *  it shipped. */
export type FunnelReason = "closed" | "dropped" | "failed" | "cancelled" | "here" | "waiting" | "unstarted" | "held" | "watching" | "regressed" | "other";
/** Display order: what ended first, what still moves after. */
export const FUNNEL_REASONS: readonly FunnelReason[] = ["closed", "dropped", "failed", "cancelled", "regressed", "other", "here", "waiting", "unstarted", "held", "watching"];

/** A station step of the funnel: one or more graph nodes a run passes as one (a fan-out and its branches, Push with
 *  Merge and Ready to land). */
export type FunnelStation = { key: string; label: string; ids: string[] };

/** One problem, as far as it got: `level` indexes funnelSteps (0 opened, 1 run started, then the stations, then
 *  merged, live, clean); `why` is why it went no further, null once it closed clean. */
export type FunnelItem = {
  task: string;
  ref: string | null;
  title: string;
  run: string | null;
  /** When the problem was opened. */
  at: number;
  level: number;
  why: FunnelReason | null;
  /** The station its run stands at now, or the last it reached once it ended. */
  node: string | null;
  /** Its run's status, or null with no run. */
  status: string | null;
};

export type FunnelStep = { key: string; label: string; n: number; drops: Partial<Record<FunnelReason, number>> };
export type FunnelWindow = { days: number; signals: number; sources: Array<{ key: string; n: number }>; steps: FunnelStep[] };
export type FlowFunnel = {
  /** The moment the windows end (the rollup's pass). */
  at: number;
  windows: FunnelWindow[];
  /** The items behind the numbers, at most FUNNEL_ITEM_CAP per (level, why), newest first. */
  items: FunnelItem[];
};

// ── the stations ────────────────────────────────────────────────────────────

type GraphNode = { id: string; label?: string; type?: string };
type GraphEdge = { from: string; to: string };

const WORK = new Set(["agent", "human", "prompt"]);
/** Where a change goes in: pushed, merged, or left ready for a person to land. */
const LANDING = /^(?:push|merge|ready_to_land|land|rebase)$/;
/** The order a landing step names its stations in: where the line lands it first, a person's hand last. */
const LANDING_NAMES = ["merge", "land", "rebase", "ready_to_land"];
const DEPLOYING = /^(?:deploy|wait_for_live)$/;

/**
 * The live flow's station steps, in graph order (breadth first from the start, by edge order): every station an
 * agent or a person works at, a fan-out standing for its branches; the landing stations as one step; then deploy and
 * watch. The scripts between (bind, queue, the close stations) are no step: a run passes them on its way.
 */
export function funnelStations(nodes: ReadonlyArray<GraphNode>, edges: ReadonlyArray<GraphEdge>): FunnelStation[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  // A fan-out's branches and its join belong to it.
  const owner = new Map<string, string>();
  for (const n of nodes) {
    if (n.type !== "parallel_fanout") continue;
    const stack = [...(out.get(n.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (owner.has(id) || id === n.id) continue;
      owner.set(id, n.id);
      if (byId.get(id)?.type === "parallel_fanin") continue;
      stack.push(...(out.get(id) ?? []));
    }
  }
  const start = nodes.find((n) => n.type === "start") ?? nodes[0];
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    queue.push(...(out.get(id) ?? []));
  }
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);

  const steps: FunnelStation[] = [];
  let landing: FunnelStation | null = null;
  for (const id of order) {
    const n = byId.get(id);
    if (!n || owner.has(id)) continue;
    const label = n.label || id;
    if (LANDING.test(id)) {
      if (!landing) steps.push((landing = { key: "land", label: "", ids: [] }));
      landing.ids.push(id);
      continue;
    }
    if (WORK.has(n.type ?? "") || n.type === "parallel_fanout" || DEPLOYING.test(id) || id === "watch") {
      steps.push({ key: id, label, ids: [id, ...[...owner].filter(([, o]) => o === id).map(([c]) => c)] });
    }
  }
  if (landing) {
    // Named by where the change lands (Merge, Ready to land); a push alone names it Push.
    const names = LANDING_NAMES.filter((id) => landing!.ids.includes(id)).map((id) => byId.get(id)?.label || id);
    landing.label = names.length ? names.join(" or ") : byId.get(landing.ids[0])?.label || "Push";
  }
  return steps;
}

/** Every step of the funnel after the signals, with the index FunnelItem.level counts. */
export function funnelSteps(stations: ReadonlyArray<FunnelStation>): Array<{ key: string; label: string }> {
  return [
    { key: "problems", label: "Problems opened" },
    { key: "runs", label: "Runs started" },
    ...stations.map((s) => ({ key: s.key, label: s.label })),
    { key: "merged", label: "Merged" },
    { key: "live", label: "Live in production" },
    { key: "clean", label: "Closed clean" },
  ];
}

// ── one problem ─────────────────────────────────────────────────────────────

export type FunnelTask = Parameters<typeof clearsBar>[0] & {
  _id: string;
  short_id?: string | null;
  title: string;
  status: string;
  created_at: number;
  readiness?: string | null;
  waiting_since?: number | null;
  watch_until?: number | null;
  resolved_at?: number | null;
  closed_at?: number | null;
  cause?: { merged_into?: unknown; named?: { name: string } | null; scored?: { score: number } | null; signal_count?: number } | null;
};
export type FunnelRun = { _id: string; status: string; current_node_id?: string | null } & LineRunStations & AnsweredGate;

const LIVE = new Set(["pending", "running", "paused"]);
const TITLE_MAX = 140;

/**
 * How far a problem got and why it went no further, from its task and its newest run: the furthest station the run
 * visited (or one after it, since a station is reached once anything past it is), merged when it shipped (runEnd)
 * with the change on the default branch (not mergeLeft), live when its deploy station completed, clean when its task
 * closed done and its watch ended quiet (flowMap.quietWatchEnd). Null for a problem merged into another (it counts there).
 */
export function funnelItem(o: {
  task: FunnelTask;
  run: FunnelRun | null | undefined;
  stations: ReadonlyArray<FunnelStation>;
  /** Station labels by node id, for where the run stands. */
  labels: ReadonlyMap<string, string>;
  /** Its run waits on a person (paused at a card, a blocking decision names it). */
  waiting?: boolean;
  /** The live flow's bar: a ready problem with no run under it is held back, over it not started. */
  bar?: Pick<FlowBar, "score" | "findings"> | null;
  now: number;
}): FunnelItem | null {
  const { task, run, stations, now } = o;
  if (task.cause?.merged_into) return null;
  const levelOf = new Map<string, number>();
  stations.forEach((s, i) => { for (const id of s.ids) levelOf.set(id, 2 + i); });
  const stationLevel = (id: string) => levelOf.get(id) ?? levelOf.get(segmentTopOf(id));
  const merged = 2 + stations.length;
  const nodes = run?.node_statuses ?? [];

  let level = 0;
  if (run) {
    level = 1;
    const visited = [...nodes.filter((n) => n.status !== "pending").map((n) => n.node_id), ...(run.current_node_id ? [run.current_node_id] : [])];
    for (const id of visited) level = Math.max(level, stationLevel(id) ?? 0);
    const end = runEnd(run);
    if (end?.kind === "shipped" && !mergeLeft(run)) {
      level = merged;
      const deploy = stations.findIndex((s) => DEPLOYING.test(s.key));
      // A run whose own graph has no deploy station (an older flow's) is live once it ships.
      const hasDeploy = deploy >= 0 && (!run.graph_nodes?.length || run.graph_nodes.some((n) => stationLevel(n.id) === 2 + deploy));
      const deployed = !hasDeploy || nodes.some((n) => n.status === "completed" && stationLevel(n.node_id) === 2 + deploy);
      if (deployed) {
        level = merged + 1;
        if (task.status === "done" && quietWatchEnd(task, now) != null) level = merged + 2;
      }
    }
  }
  const live = !!run && LIVE.has(run.status);
  const waiting = live && (run!.status === "paused" || !!o.waiting || !!task.waiting_since);
  const why = level === merged + 2 ? null : reasonOf({ task, run, level, merged, live, waiting, bar: o.bar, now });

  // Where it stands: the station it is at, else the last it reached before its exit.
  const at = live ? run!.current_node_id : [...nodes].filter((n) => n.status !== "pending" && n.node_id !== "exit").sort((a, b) => (a.completed_at ?? a.started_at ?? 0) - (b.completed_at ?? b.started_at ?? 0)).pop()?.node_id;
  const node = at ? o.labels.get(at) ?? o.labels.get(segmentTopOf(at)) ?? words(at) : null;
  const name = task.cause?.named?.name ?? task.title;
  return {
    task: task._id, ref: task.short_id ?? null, title: name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name,
    run: run?._id ?? null, at: task.created_at, level, why, node, status: run?.status ?? null,
  };
}

function reasonOf(o: { task: FunnelTask; run: FunnelRun | null | undefined; level: number; merged: number; live: boolean; waiting: boolean; bar?: Pick<FlowBar, "score" | "findings"> | null; now: number }): FunnelReason {
  const { task, run } = o;
  if (!run) return task.status === "dropped" ? "dropped" : task.status === "done" ? "closed" : task.readiness === "ready" && clearsBar(task, o.bar) ? "unstarted" : "held";
  if (o.live) return o.waiting ? "waiting" : "here";
  const end = runEnd(run);
  if (end?.kind === "dissolved") return "closed";
  if (end?.kind === "dropped") return "dropped";
  if (run.status === "cancelled") return "cancelled";
  // Shipped: under watch, or back after it shipped.
  if (o.level > o.merged || (o.level === o.merged && end?.kind === "shipped")) {
    if (typeof task.watch_until === "number" && task.watch_until > o.now) return "watching";
    return task.status === "done" ? "other" : "regressed";
  }
  // Pushed, with the merge left to a person.
  if (mergeLeft(run) || task.waiting_since) return "waiting";
  if (run.status === "failed" || endedFailing(run) || stoppedAt(run)) return "failed";
  if (task.status === "dropped") return "dropped";
  if (task.status === "done") return "closed";
  if (end?.kind === "parked") return "held";
  return "other";
}

/** A run that ended through its graph's stop station (onefix's Stopped: the run gave up). */
const stoppedAt = (run: FunnelRun) => (run.node_statuses ?? []).some((n) => n.node_id === "stopped" && n.status === "completed");

const words = (id: string) => {
  const own = id.split("__").pop() || id;
  const w = own.replace(/[_-]+/g, " ").trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : id;
};

// ── the windows ─────────────────────────────────────────────────────────────

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * The windows and the capped items, from one item per problem opened in FUNNEL_DAYS and each source's findings per
 * UTC day. A window of n days holds the problems opened in its last n×24 hours and the findings of its last n UTC days.
 */
export function foldFunnel(o: {
  items: ReadonlyArray<FunnelItem>;
  stations: ReadonlyArray<FunnelStation>;
  sources: ReadonlyArray<{ key: string; days: ReadonlyArray<{ day: string; n: number }> }>;
  now: number;
}): FlowFunnel {
  const steps = funnelSteps(o.stations);
  const windows = FUNNEL_WINDOWS.map((days): FunnelWindow => {
    const since = o.now - days * DAY;
    const items = o.items.filter((x) => x.at >= since);
    const keys = new Set(Array.from({ length: days }, (_, i) => dayKey(o.now - i * DAY)));
    const sources = o.sources
      .map((s) => ({ key: s.key, n: s.days.reduce((t, d) => t + (keys.has(d.day) ? d.n : 0), 0) }))
      .filter((s) => s.n > 0)
      .sort((a, b) => b.n - a.n);
    return {
      days,
      signals: sources.reduce((t, s) => t + s.n, 0),
      sources,
      steps: steps.map((s, i) => {
        const drops: Partial<Record<FunnelReason, number>> = {};
        for (const x of items) if (x.level === i && x.why) drops[x.why] = (drops[x.why] ?? 0) + 1;
        return { ...s, n: items.filter((x) => x.level >= i).length, drops };
      }),
    };
  });
  const kept = new Map<string, number>();
  const items = [...o.items].sort((a, b) => b.at - a.at).filter((x) => {
    const k = `${x.level}|${x.why ?? ""}`;
    const n = kept.get(k) ?? 0;
    kept.set(k, n + 1);
    return n < FUNNEL_ITEM_CAP;
  });
  return { at: o.now, windows, items };
}

/** The items behind a number in a window: everyone who reached `level` (a step's count), or, with `why`, those who
 *  stopped there for that reason (a drop). At most what the rollup kept. */
export function funnelItemsOf(f: FlowFunnel, days: number, level: number, why?: FunnelReason): FunnelItem[] {
  const since = f.at - days * DAY;
  return f.items.filter((x) => x.at >= since && (why ? x.level === level && x.why === why : x.level >= level));
}
