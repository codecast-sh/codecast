// The flow map (the Flows page's Signals and Flows stages): every source of a
// team's problems, where its problems go, and where they stand. One shape for
// the server's flowMap.forTeam and the web page that draws it, and the pure
// readings both share: a problem's outcome, a source's state and its normal
// day. Pure.

export const FLOW_MAP_DAYS = 14;
/** How far back a source's problems count toward its outcomes. */
export const FLOW_MAP_OUTCOME_DAYS = 30;
/** How far back a problem that ran off the live flow counts as an escape. */
export const FLOW_MAP_ESCAPE_DAYS = 7;
export const DAY_MS = 86_400_000;
/** A live run unchanged this long is stalled: 99.5% of a healthy station's runs finish inside 7.7h (Union, Oct 2026).
 *  A run waiting on a person (FlowMapStep.waiting) is never stalled. */
export const STALLED_MS = 8 * 3_600_000;

export type FlowMapGroup = "conversations" | "people" | "product" | "pipeline";
export type FlowMapState = "flowing" | "quiet" | "stopped";
export type FlowMapOutcome = "queued" | "notReady" | "running" | "waiting" | "shipped" | "closed" | "failed" | "parked";
export type FlowMapOutcomes = Record<FlowMapOutcome, number> & { total: number };

/** A lane: one flow of the live flow's family (the spine, a variant, the judge flow). */
export type FlowMapLane = {
  /** The flow's slug. */
  key: string;
  label: string;
  workflowId: string;
  kind: "spine" | "variant" | "judge";
  /** The source keys it takes (its graph's serves=). */
  sources: string[];
  /** Its stations in graph order, with the live runs standing at each. */
  steps: FlowMapStep[];
};

/** A station and the live runs standing at it: waiting on a person (paused at a card, named by a pending blocking
 *  decision, or its task holding a wait), else running, of those stalled when unchanged for STALLED_MS. */
export type FlowMapStep = { id: string; label: string; running: number; stalled: number; waiting: number };

/** One source of a team's problems: a finding source, or an event source's kind that files none. */
export type FlowMapSource = {
  /** A signals.source ("judge:agent-review", "sdk:union-errors"), or "<provider>:<name>:<transition>" for an event
   *  source's kind its promote list leaves out ("sdk:union-errors:job_failed", "posthog:union-posthog:metric_alert"). */
  key: string;
  label: string;
  /** What notices the problem, in one line. */
  what: string;
  group: FlowMapGroup;
  state: FlowMapState;
  lastAt: number | null;
  /** The last 24 hours. */
  today: number;
  /** A normal day: the median of the days in the window that had any. */
  normal: number;
  /** FLOW_MAP_DAYS daily counts, oldest first; the last is today (UTC). */
  days: number[];
  /** A lane key, "off" (its problems run outside the live flow) or "unfiled" (it files no problems). */
  route: string;
  /** Problems from it that ran a flow outside the live flow's family in FLOW_MAP_ESCAPE_DAYS. */
  escapes: number;
  /** Problems it opened in FLOW_MAP_OUTCOME_DAYS, by where they stand now. */
  outcomes: FlowMapOutcomes;
  /** Open event groups (or watches in alert) that never became a problem. */
  unfiled: number;
  /** What the row opens. */
  opens: { eventSourceId?: string; judgeIds?: string[]; finderId?: string; metricWatchIds?: string[] };
};

export type FlowMap = {
  workspace: string;
  /** When the rollup behind the counts was written; null before its first pass. */
  rolledAt: number | null;
  liveFlow: {
    id: string;
    workflowId: string;
    label: string;
    on: boolean;
    hold: { why: string; until: number; by: string; at: number } | null;
    /** Hands per day; null for no cap. */
    cap: number | null;
    handsToday: number;
    running: number;
    stalled: number;
    queued: number;
    finishedToday: number;
  } | null;
  lanes: FlowMapLane[];
  /** The workspace's live problem runs on flows outside the family (a person's plain line), by the station they stand at. */
  off: { running: number; stalled: number; steps: FlowMapStep[] };
  sources: FlowMapSource[];
  header: {
    problemsOpen: number;
    problemsScored: number;
    /** Blocking decisions on the team's runs: the viewer's, and everyone else's. */
    decisionsForYou: number;
    decisionsForTeam: number;
    watching: number;
    regressed: number;
  };
};

export const emptyOutcomes = (): FlowMapOutcomes => ({ queued: 0, notReady: 0, running: 0, waiting: 0, shipped: 0, closed: 0, failed: 0, parked: 0, total: 0 });

// ── a problem's outcome ─────────────────────────────────────────────────────

type RunNode = { node_id: string; status: string };
export type OutcomeTask = { status: string; readiness?: string | null; workflow_run_id?: string | null; waiting_since?: number | null; cause?: { merged_into?: unknown } | null };
export type OutcomeRun = { status: string; node_statuses?: ReadonlyArray<RunNode> } | null | undefined;

/** The end station a run completed last, in any graph (causeHistory.runEnd's reading, without the card check). */
function runEndKind(run: OutcomeRun): "shipped" | "closed" | "parked" | null {
  let end: "shipped" | "closed" | "parked" | null = null;
  for (const n of run?.node_statuses ?? []) {
    if (n.status !== "completed") continue;
    const id = n.node_id;
    if (id === "watch") end = "shipped";
    else if (id === "drop" || id === "dissolve" || /^(?:dissolved|released)_at_\w+$/.test(id)) end = "closed";
    else if (/^park(?:_|$)/.test(id)) end = "parked";
  }
  return end;
}

const failedAt = (run: OutcomeRun) => (run?.node_statuses ?? []).some((n) => n.node_id.startsWith("failed_at_") && n.status === "completed");

/** Where a problem stands, from its task and its newest run; null for one merged into another problem (it counts there). */
export function problemOutcome(task: OutcomeTask, run: OutcomeRun): FlowMapOutcome | null {
  if (task.cause?.merged_into) return null;
  if (run && (run.status === "running" || run.status === "pending")) return "running";
  if ((run && run.status === "paused") || task.waiting_since) return "waiting";
  const end = runEndKind(run);
  if (end === "shipped") return "shipped";
  if (task.status === "dropped" || task.status === "done") return "closed";
  if (run && (run.status === "failed" || failedAt(run))) return "failed";
  if (end) return end;
  if (task.status === "in_review") return "waiting";
  if (task.status === "in_progress") return "running";
  if (!task.workflow_run_id) return task.readiness === "ready" ? "queued" : "notReady";
  return "failed";
}

// ── a source's day and state ────────────────────────────────────────────────

export const utcDayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The FLOW_MAP_DAYS day keys ending today, oldest first. */
export function windowDays(now: number, n = FLOW_MAP_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => utcDayKey(now - (n - 1 - i) * DAY_MS));
}

/** A normal day: the median of the days that had any, so a source that reports in batches is measured by its batches. */
export function normalDay(days: ReadonlyArray<number>): number {
  const active = days.filter((d) => d > 0).sort((a, b) => a - b);
  if (!active.length) return 0;
  const mid = active.length >> 1;
  return active.length % 2 ? active[mid] : Math.round((active[mid - 1] + active[mid]) / 2);
}

/**
 * Flowing, quiet or stopped. Quiet: nothing for longer than twice its usual
 * gap between active days, and at least a day. Stopped: nothing in the whole
 * window, or its event source says it is erroring or paused.
 */
export function sourceState(o: { lastAt: number | null; days: ReadonlyArray<number>; now: number; broken?: boolean }): FlowMapState {
  if (o.broken || !o.lastAt || o.now - o.lastAt > o.days.length * DAY_MS) return "stopped";
  const active = o.days.flatMap((d, i) => (d > 0 ? [i] : []));
  const gaps = active.slice(1).map((d, i) => d - active[i]).sort((a, b) => a - b);
  // The lower median: a source that came daily and then in one long gap is judged by its daily rhythm.
  const usual = gaps.length ? gaps[(gaps.length - 1) >> 1] : 1;
  return o.now - o.lastAt > Math.max(1, 2 * usual) * DAY_MS ? "quiet" : "flowing";
}
