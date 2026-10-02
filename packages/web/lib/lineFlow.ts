// The line page (docs/architecture/the-line-end-to-end.md LE13): the whole
// factory as one flow, derived from store rows. Pure: no store, no React, so a
// test feeds rows and reads columns.
//
//   sense      signals by source, a 24h sparkline each           (signals)
//   causes     open causes ranked by computed priority (LE5)      (tasks with `cause`)
//   in build   live runs on a cause, by their current node      (workflowRuns)
//              (other live runs only count, as "not from the line")
//   awaiting   the viewer's pending gate decisions on runs        (sessionDecisions)
//   watching   shipped causes inside their watch (LE12)          (tasks.watch_until)
//   closed     causes closed this week: shipped, dissolved, or
//              resolved (a watch that ended quiet, tasks.resolved_at) (tasks)
//
// A cause sits in exactly one of causes, in build, awaiting, watching or
// closed: a live run moves it to build, a pending decision on it to awaiting.
import { priority as linePriority, type Severity } from "@codecast/convex/convex/lib/linePriority";
import { NO_GOAL } from "@codecast/shared/contracts/goalsBrief";
import { DEFAULT_LINE_CARDS_CAP } from "@codecast/shared/contracts/orgCapacity";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { isLiveRun, runLiveNode, type LineRun, type LiveNode } from "./taskLine";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export type LineSignal = {
  _id: string;
  short_id?: string;
  source: string;
  kind: string;
  title: string;
  subject?: string;
  evidence_url?: string;
  observed_at: number;
  created_at: number;
  task_id: string;
  attach?: string;
  reopened?: boolean;
};

export type LineCauseTask = {
  _id: string;
  short_id?: string;
  title: string;
  status: string;
  priority?: string | null;
  created_at: number;
  updated_at?: number;
  closed_at?: number;
  workflow_run_id?: string | null;
  cause?: { signal_count: number; first_seen: number; last_seen: number; fingerprints: string[] } | null;
  goal_ref?: string | null;
  category?: string | null;
  risk?: string | null;
  readiness?: string | null;
  readiness_note?: string | null;
  watch_until?: number | null;
  resolved_at?: number | null;
};

export type LineFlowRun = LineRun & {
  workflow_slug?: string;
  task_short_id?: string;
  task_title?: string;
  fail_reason?: string;
  goal_override?: string;
  gate_decision_status?: string;
  total_tokens?: number;
  phases?: Array<{ title: string }>;
  created_at: number;
  updated_at: number;
};

export type LineDecision = {
  _id: string;
  status: string;
  blocking?: boolean;
  task_id?: string;
  workflow_run_id?: string;
  gate_node_id?: string;
  created_at?: number;
  holder?: { kind: string; id: string };
};

export type GoalRow = { short_id?: string; title: string; priority?: "p0" | "p1" | "p2" | "p3" };

/** idle: nothing has reached the station yet, or nothing waits for it, which
 *  is not trouble. starved: Sense when signals used to arrive and stopped, or
 *  In build while causes wait and nothing builds. clear: a downstream station
 *  with nothing in it, the good outcome. ask: cards wait on the viewer. */
export type StageKind = "running" | "ask" | "paused" | "starved" | "failing" | "idle" | "clear";
export type StageState = { kind: StageKind; since?: number | null; why: string };

export type GoalChip = { ref: string; label: string; kind: "initiative" | "project" | "unknown" | "parked" | "ungrounded" };

export type SenseSource = {
  source: string;
  day: number;
  week: number;
  /** Signals per hour over the last 24 hours, oldest first. */
  spark: number[];
  newest: LineSignal;
  kinds: string[];
};

export type CauseRow = { task: LineCauseTask; score: number; signals: number; goal: GoalChip };
/** stalled: live by status but silent for a day; it holds no hand that is working. */
export type BuildRow = {
  run: LineFlowRun;
  node: LiveNode | null;
  since: number;
  task?: LineCauseTask;
  stalled: boolean;
  /** What the run is called: never a bare "workflow". */
  name: string;
  /** The workflow it runs, when that adds to the name. */
  workflow: string | null;
  /** The step it is at (the node label), null when the run names none. */
  step: string | null;
};
export type WatchRow = { task: LineCauseTask; until: number; daysLeft: number };
export type ClosedOutcome = "shipped" | "dissolved" | "resolved";
export type ClosedRow = { task: LineCauseTask; outcome: ClosedOutcome; at: number };

export type Column<T> = { items: T[]; count: number; oldestAt: number | null; state: StageState };

export type Throughput = {
  signalsIn: number;
  opened: number;
  dissolved: number;
  shipped: number;
  reopened: number;
  /** Median ms from a shipped cause's first signal to its close; null with none shipped. */
  medianToShip: number | null;
  /** Mean run tokens per shipped cause; null with none shipped. */
  tokensPerShip: number | null;
  /** Per day over the last seven days, oldest first, for each count. */
  daily: Record<"signalsIn" | "opened" | "dissolved" | "shipped" | "reopened", number[]>;
};

/** How many items entered each station this week: the count on the rail
 *  that leads into it. */
export type Moved = { causes: number; build: number; awaiting: number; watching: number; closed: number };

export type LineFlow<D extends LineDecision = LineDecision> = {
  sense: Column<SenseSource>;
  causes: Column<CauseRow> & { parked: CauseRow[] };
  /** otherRuns: live runs whose task is not a cause; the page counts them
   *  apart so In build never claims work the line did not start. */
  build: Column<BuildRow> & { otherRuns: number };
  awaiting: Column<D>;
  watching: Column<WatchRow>;
  closed: Column<ClosedRow>;
  throughput: Throughput;
  moved: Moved;
  /** Anything has ever reached the line: a signal in the window or any cause.
   *  Until then every station is idle and the page teaches instead. */
  started: boolean;
};

// Workflow names that say nothing about the run (dynamic workflows all carry
// the first one).
const GENERIC_WORKFLOW = new Set(["workflow", "routine", "run"]);

/** "eval-rehaul-wave1" reads as "eval rehaul wave1"; prose stays as it is. */
export function humanizeSlug(s: string): string {
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(s) ? s.replace(/[-_]+/g, " ") : s;
}

const firstLine = (s: string | undefined | null, max = 90): string | null => {
  const line = s?.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The step a run is at: its current node's label, else the phase of the
 *  agent a dynamic workflow is running. */
function runStep(run: LineFlowRun, node: LiveNode | null): string | null {
  if (node?.label && node.label !== node.id) return node.label;
  const live = (run.node_statuses as Array<{ status: string; phase?: string; label?: string }> | undefined)?.find((n) => n.status === "running");
  return live?.phase ?? node?.label ?? null;
}

/** A run's name: its task, its goal, its first phase, its workflow when that
 *  is a real name, and only then its step and a short id. */
export function runName(run: LineFlowRun, task?: { title: string }, step?: string | null): { name: string; workflow: string | null } {
  const wf = run.workflow_name?.trim();
  const workflow = wf && !GENERIC_WORKFLOW.has(wf.toLowerCase()) ? humanizeSlug(wf) : null;
  const name = task?.title
    ?? run.task_title
    ?? firstLine(run.goal_override)
    ?? firstLine(run.phases?.[0]?.title)
    ?? workflow
    ?? `${step ?? "run"} · ${run._id.slice(-5)}`;
  return { name, workflow: workflow && workflow !== name ? workflow : null };
}

export const isCause = (t: { cause?: unknown }) => !!t.cause;
const terminal = (status: string) => status === "done" || status === "dropped";
const inWatch = (t: LineCauseTask, now: number) => typeof t.watch_until === "number" && t.watch_until > now;

/** A pending blocking decision on a run: what Awaiting you lists. */
export function isLineCard(d: LineDecision): boolean {
  return d.status === "pending" && !!d.blocking && !!d.workflow_run_id;
}

/** LE6/LE11: a card at the decide gate, the only kind admission counts. */
export const isGateCard = (d: LineDecision) => isLineCard(d) && d.gate_node_id === CARD_GATE_NODE_ID;

/** LE12: the quiet close stamps resolved_at. It closed the cause itself when
 *  closed_at matches it (the cause never shipped); a close after it is a later
 *  ship of a reopened cause. */
const resolvedQuietly = (t: LineCauseTask) => typeof t.resolved_at === "number" && t.resolved_at >= (t.closed_at ?? 0);
const closedByQuietWatch = (t: LineCauseTask) => resolvedQuietly(t) && t.closed_at === t.resolved_at;

/** The goal a cause names (LE5): an initiative ref ("in-3" or
 *  "in-3:metric"), a project ref, "none" (parked), or nothing yet. */
export function goalChip(ref: string | null | undefined, initiatives: GoalRow[], projects: GoalRow[]): GoalChip & { priority: "p0" | "p1" | "p2" | "p3" | "unranked" | null } {
  const raw = ref?.trim();
  if (!raw) return { ref: "", label: "not grounded", kind: "ungrounded", priority: null };
  if (raw === NO_GOAL) return { ref: raw, label: "no goal", kind: "parked", priority: null };
  const [head, metric] = raw.split(":");
  const initiative = initiatives.find((i) => i.short_id === head);
  if (initiative) return { ref: raw, label: metric ? `${initiative.title} · ${metric}` : initiative.title, kind: "initiative", priority: initiative.priority ?? "unranked" };
  const project = projects.find((p) => p.short_id === head);
  if (project) return { ref: raw, label: project.title, kind: "project", priority: project.priority ?? "unranked" };
  return { ref: raw, label: raw, kind: "unknown", priority: "unranked" };
}

const SEVERITIES = new Set(["urgent", "high", "medium", "low", "none"]);
const severityOf = (p: string | null | undefined): Severity => (p && SEVERITIES.has(p) ? (p as Severity) : "none");

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Counts per day over the seven days ending now, oldest first. */
function perDay(times: Array<number | null | undefined>, now: number): number[] {
  const days = new Array(7).fill(0);
  for (const t of times) {
    if (typeof t !== "number" || t > now || t < now - WEEK) continue;
    days[Math.min(6, Math.floor((t - (now - WEEK)) / DAY))]++;
  }
  return days;
}

const oldest = (times: Array<number | null | undefined>): number | null => {
  let min: number | null = null;
  for (const t of times) if (typeof t === "number" && (min === null || t < min)) min = t;
  return min;
};

export function buildLineFlow<D extends LineDecision>(input: {
  signals: LineSignal[];
  tasks: LineCauseTask[];
  runs: LineFlowRun[];
  decisions: D[];
  initiatives: GoalRow[];
  projects: GoalRow[];
  now: number;
  cardsCap?: number;
}): LineFlow<D> {
  const { now } = input;
  const cardsCap = input.cardsCap ?? DEFAULT_LINE_CARDS_CAP;
  const causes = input.tasks.filter(isCause);
  const causeById = new Map(causes.map((t) => [t._id, t]));
  const weekAgo = now - WEEK;
  const dayAgo = now - DAY;

  // ── sense ──
  const bySource = new Map<string, LineSignal[]>();
  for (const s of input.signals) {
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }
  const sources: SenseSource[] = [];
  for (const [source, list] of bySource) {
    const sorted = [...list].sort((a, b) => b.created_at - a.created_at);
    const spark = new Array(24).fill(0);
    let day = 0;
    let week = 0;
    for (const s of sorted) {
      if (s.created_at >= weekAgo) week++;
      if (s.created_at >= dayAgo) {
        day++;
        spark[Math.min(23, Math.floor((s.created_at - dayAgo) / HOUR))]++;
      }
    }
    if (week === 0) continue;
    sources.push({ source, day, week, spark, newest: sorted[0], kinds: [...new Set(sorted.map((s) => s.kind))] });
  }
  sources.sort((a, b) => b.day - a.day || b.week - a.week || b.newest.created_at - a.newest.created_at);
  const daySignals = input.signals.filter((s) => s.created_at >= dayAgo);
  const lastSignal = input.signals.reduce<number | null>((m, s) => (m === null || s.created_at > m ? s.created_at : m), null);
  const started = input.signals.length > 0 || causes.length > 0;
  const senseState: StageState = daySignals.length > 0
    ? { kind: "running", since: lastSignal, why: "signals arriving" }
    : started
      ? { kind: "starved", since: lastSignal, why: "no signal in 24h" }
      : { kind: "idle", why: "waiting for the first signal" };

  // ── awaiting you: the viewer's line cards ──
  const awaitingItems = input.decisions
    .filter(isLineCard)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  const awaitingTasks = new Set(awaitingItems.map((d) => d.task_id).filter(Boolean) as string[]);

  // ── in build: live runs not waiting on a person ──
  const buildItems: BuildRow[] = [];
  const buildTasks = new Set<string>();
  let otherRuns = 0;
  const lineRuns = input.runs.filter((r) => !!r.task_id && causeById.has(r.task_id));
  for (const run of input.runs) {
    if (!isLiveRun(run) && run.status !== "pending") continue;
    const task = run.task_id ? causeById.get(run.task_id) : undefined;
    if (!task) { otherRuns++; continue; }
    const atGate = run.status === "paused" && !!run.gate_decision_id && (run.gate_decision_status ?? "pending") === "pending";
    buildTasks.add(task._id);
    if (atGate) continue;
    const node = runLiveNode(run);
    const step = runStep(run, node);
    buildItems.push({ run, node, since: node?.started_at ?? run.created_at, task, stalled: now - (run.updated_at ?? run.created_at) > DAY, step, ...runName(run, task, step) });
  }
  buildItems.sort((a, b) => Number(a.stalled) - Number(b.stalled) || a.since - b.since);
  const fresh = buildItems.filter((b) => !b.stalled);
  const stalled = buildItems.length - fresh.length;
  const stalledNote = stalled ? `, ${stalled} stalled` : "";
  const pausedRuns = fresh.filter((b) => b.run.status === "paused");
  const lastEnded = lineRuns
    .filter((r) => (r.status === "completed" || r.status === "failed") && r.updated_at >= weekAgo)
    .sort((a, b) => b.updated_at - a.updated_at)[0];

  // ── watching, closed ──
  const watchItems: WatchRow[] = [];
  const closedItems: ClosedRow[] = [];
  const openRows: CauseRow[] = [];
  for (const t of causes) {
    if (inWatch(t, now)) {
      watchItems.push({ task: t, until: t.watch_until!, daysLeft: Math.max(0, Math.ceil((t.watch_until! - now) / DAY)) });
      continue;
    }
    if (terminal(t.status)) {
      const at = t.closed_at ?? t.updated_at ?? 0;
      // A watch that ended quiet is resolved (LE12): swept, it carries
      // resolved_at; not yet swept, it still holds its past watch_until.
      const resolved = resolvedQuietly(t) || typeof t.watch_until === "number";
      const outcome: ClosedOutcome = t.status === "dropped" ? "dissolved" : resolved ? "resolved" : "shipped";
      const closedAt = outcome === "resolved" ? (t.resolved_at ?? t.watch_until ?? at) : at;
      if (closedAt >= weekAgo) closedItems.push({ task: t, outcome, at: closedAt });
      continue;
    }
    if (buildTasks.has(t._id) || awaitingTasks.has(t._id)) continue;
    const goal = goalChip(t.goal_ref, input.initiatives, input.projects);
    const signals = t.cause?.signal_count ?? 0;
    openRows.push({ task: t, signals, goal, score: linePriority(goal.priority, severityOf(t.priority), signals) });
  }
  watchItems.sort((a, b) => a.until - b.until);
  closedItems.sort((a, b) => b.at - a.at);
  openRows.sort((a, b) => b.score - a.score || (b.task.cause?.last_seen ?? 0) - (a.task.cause?.last_seen ?? 0));
  const ranked = openRows.filter((r) => r.goal.kind !== "parked");
  const parked = openRows.filter((r) => r.goal.kind === "parked");

  // LE6: admission waits while the viewer holds cardsCap open cards at the
  // decide gate (other blocking asks on a run do not hold a slot). Since
  // when: the moment the cap filled, the cap-th oldest card.
  const gateCards = awaitingItems.filter(isGateCard);
  const capped = gateCards.length >= cardsCap;
  const causesState: StageState = capped
    ? { kind: "paused", since: gateCards[cardsCap - 1]?.created_at ?? null, why: `queued behind ${gateCards.length} open cards` }
    : openRows.length > 0
      ? { kind: "running", why: `${ranked.length} ready to admit` }
      : { kind: "idle", why: started ? "no open cause" : "opens on the first signal" };

  const buildState: StageState = lastEnded?.status === "failed"
    ? { kind: "failing", since: lastEnded.updated_at, why: lastEnded.fail_reason?.trim() || "last run failed" }
    : pausedRuns.length > 0
      ? { kind: "paused", since: pausedRuns[0].run.updated_at, why: `${pausedRuns.length} run${pausedRuns.length === 1 ? "" : "s"} paused${stalledNote}` }
      : fresh.length > 0
        ? { kind: "running", why: `${fresh.length} building${stalledNote}` }
        : ranked.length
          ? { kind: "starved", since: lastEnded?.updated_at ?? null, why: `causes wait, nothing building${stalledNote}` }
          : { kind: "idle", since: lastEnded?.updated_at ?? null, why: `nothing to build${stalledNote}` };

  const awaitingState: StageState = awaitingItems.length > 0
    ? { kind: "ask", since: awaitingItems[0].created_at ?? null, why: "waiting on you" }
    : { kind: "clear", why: "nothing to answer" };
  const watchState: StageState = watchItems.length > 0 ? { kind: "running", why: "counting signals" } : { kind: "clear", why: "nothing in watch" };
  const closedState: StageState = closedItems.length > 0 ? { kind: "running", why: "this week" } : { kind: "clear", why: "nothing closed this week" };

  // ── throughput, this week ──
  // A ship is a done close this week that the quiet watch close did not make.
  const shippedThisWeek = causes.filter((t) => t.status === "done" && (t.closed_at ?? 0) >= weekAgo && !closedByQuietWatch(t));
  const runTokens = new Map<string, number>();
  for (const r of input.runs) if (r.task_id) runTokens.set(r.task_id, (runTokens.get(r.task_id) ?? 0) + (r.total_tokens ?? 0));
  const tokens = shippedThisWeek.reduce((sum, t) => sum + (runTokens.get(t._id) ?? 0), 0);
  const throughput: Throughput = {
    signalsIn: input.signals.filter((s) => s.created_at >= weekAgo).length,
    opened: causes.filter((t) => t.created_at >= weekAgo).length,
    dissolved: causes.filter((t) => t.status === "dropped" && (t.closed_at ?? 0) >= weekAgo).length,
    shipped: shippedThisWeek.length,
    reopened: input.signals.filter((s) => s.reopened && s.created_at >= weekAgo).length,
    medianToShip: median(shippedThisWeek.filter((t) => t.cause?.first_seen).map((t) => (t.closed_at ?? 0) - t.cause!.first_seen)),
    tokensPerShip: shippedThisWeek.length && tokens ? tokens / shippedThisWeek.length : null,
    daily: {
      signalsIn: perDay(input.signals.map((s) => s.created_at), now),
      opened: perDay(causes.map((t) => t.created_at), now),
      dissolved: perDay(causes.filter((t) => t.status === "dropped").map((t) => t.closed_at), now),
      shipped: perDay(shippedThisWeek.map((t) => t.closed_at), now),
      reopened: perDay(input.signals.filter((s) => s.reopened).map((s) => s.created_at), now),
    },
  };

  return {
    sense: { items: sources, count: daySignals.length, oldestAt: oldest(daySignals.map((s) => s.created_at)), state: senseState },
    causes: { items: ranked, parked, count: openRows.length, oldestAt: oldest(openRows.map((r) => r.task.cause?.first_seen ?? r.task.created_at)), state: causesState },
    build: { items: buildItems, otherRuns, count: buildItems.length, oldestAt: oldest(buildItems.map((b) => b.since)), state: buildState },
    awaiting: { items: awaitingItems, count: awaitingItems.length, oldestAt: oldest(awaitingItems.map((d) => d.created_at)), state: awaitingState },
    watching: { items: watchItems, count: watchItems.length, oldestAt: oldest(watchItems.map((w) => w.task.closed_at)), state: watchState },
    closed: { items: closedItems, count: closedItems.length, oldestAt: oldest(closedItems.map((c) => c.at)), state: closedState },
    throughput,
    started,
    moved: {
      causes: throughput.opened,
      build: lineRuns.filter((r) => r.created_at >= weekAgo).length,
      awaiting: input.decisions.filter((d) => !!d.blocking && !!d.workflow_run_id && (d.created_at ?? 0) >= weekAgo).length,
      watching: throughput.shipped,
      closed: closedItems.length,
    },
  };
}

/** "3d", "5h", "12m": the largest unit, for a sentence. */
export function ageShort(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export type HeadlinePart = { text: string; tone: "ask" | "warn" | "fail" | "live" | "calm" };

/** One sentence from the flow's state, what needs the founder first: cards
 *  waiting on them, then what is building and what stalled or failed, then
 *  what waits to be admitted. Ends on the calm part when nothing waits. */
export function lineHeadline(flow: LineFlow, now: number): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const { awaiting, build, causes, watching } = flow;
  if (awaiting.count > 0) {
    parts.push({ text: `${plural(awaiting.count, "card waits", "cards wait")} on you${awaiting.oldestAt ? `, oldest ${ageShort(now - awaiting.oldestAt)}` : ""}`, tone: "ask" });
  }
  const fresh = build.items.filter((b) => !b.stalled).length;
  if (fresh > 0) parts.push({ text: `${fresh} building`, tone: "live" });
  const stalled = build.items.filter((b) => b.stalled);
  if (stalled.length > 0) {
    const silent = Math.max(...stalled.map((b) => now - (b.run.updated_at ?? b.run.created_at)));
    parts.push({ text: `${stalled.length} stalled ${ageShort(silent)}`, tone: "warn" });
  }
  if (build.state.kind === "failing") parts.push({ text: `last run failed${build.state.since ? ` ${ageShort(now - build.state.since)} ago` : ""}`, tone: "fail" });
  if (causes.state.kind === "paused") parts.push({ text: `admission paused, ${causes.state.why}`, tone: "warn" });
  else if (causes.items.length > 0) parts.push({ text: `${plural(causes.items.length, "cause", "causes")} ready to admit`, tone: "calm" });
  if (watching.count > 0) parts.push({ text: `${watching.count} in watch`, tone: "calm" });
  if (!flow.started && parts.length === 0) return [{ text: "Nothing has reached the line yet", tone: "calm" }];
  if (awaiting.count === 0) parts.push({ text: parts.length ? "nothing waiting on you" : "The line is quiet: nothing building, nothing waiting on you", tone: "calm" });
  return parts;
}

/** A block of In build rows: a step holding two or more runs gets a labelled
 *  group; runs alone at their step sit in an unlabelled block and carry the
 *  step as a chip. order is the row's keyboard index across blocks. */
export type BuildBlock = { label: string | null; stalled: boolean; rows: Array<BuildRow & { order: number; chip: string | null }> };

export function groupBuild(items: BuildRow[]): BuildBlock[] {
  const labelOf = (b: BuildRow) => (b.stalled ? "stalled, silent a day" : b.step ?? (b.run.status === "pending" ? "starting" : null));
  const counts = new Map<string, number>();
  for (const b of items) { const l = labelOf(b); if (l) counts.set(l, (counts.get(l) ?? 0) + 1); }
  const blocks: BuildBlock[] = [];
  const byLabel = new Map<string, BuildBlock>();
  for (const b of items) {
    const l = labelOf(b);
    const grouped = !!l && (counts.get(l) ?? 0) >= 2;
    if (grouped) {
      let block = byLabel.get(l!);
      if (!block) { block = { label: l, stalled: b.stalled, rows: [] }; byLabel.set(l!, block); blocks.push(block); }
      block.rows.push({ ...b, order: 0, chip: null });
      continue;
    }
    const last = blocks[blocks.length - 1];
    const block = last && last.label === null ? last : (blocks.push({ label: null, stalled: false, rows: [] }), blocks[blocks.length - 1]);
    block.rows.push({ ...b, order: 0, chip: l });
  }
  let order = 0;
  for (const block of blocks) for (const r of block.rows) r.order = order++;
  return blocks;
}
