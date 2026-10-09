// The line page (docs/architecture/the-line-end-to-end.md LE13): the whole
// factory as one flow, derived from store rows. Pure: no store, no React, so a
// test feeds rows and reads columns.
//
//   sense      signals by source, a 7 day sparkline each          (signals)
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
//
// A line belongs to a project (line-profile.md LP1): scopeLine narrows the
// rows to one project before buildLineFlow, and lineRollup counts every
// project's line for the "all projects" view. A project's declared finders
// (LP3, published onto the project row) join Sense, so a silent one shows.
import { LINE_SIGNAL_WINDOW_MS, type LineFinderDecl, type PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { priority as linePriority, type Severity } from "@codecast/convex/convex/lib/linePriority";
import { LINE_GOAL, NO_GOAL } from "@codecast/shared/contracts/goalsBrief";
import { DEFAULT_LINE_CARDS_CAP } from "@codecast/shared/contracts/orgCapacity";
import { CARD_GATE_NODE_ID, lineRunOutcome, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { isLiveRun, runLiveNode, type LineRun, type LiveNode } from "./taskLine";
import { isConvexId } from "./entityLinks";
import { runHref } from "./decisionLinks";
import { lineForkIndex, lineRunKind, type LineRunKind } from "./line/lineStations";
import { projectGraphs, type ProjectGraph } from "./line/lineGraphs";

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
  /** The key the finder files on; signals sharing it share a cause. */
  fingerprint?: string;
  /** The head of the finder's own words: what it saw, the quote (line-map.md LX7). */
  detail_md?: string;
  /** Where the source saw it, as specific as the finder had (LX7). */
  evidence_url?: string;
  observed_at: number;
  created_at: number;
  task_id: string;
  project_id?: string | null;
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
  /** Who the task is assigned to: the sweep admits an unassigned cause, or one assigned to its role. */
  assignee?: string | null;
  watch_until?: number | null;
  resolved_at?: number | null;
  project_id?: string | null;
};

export type LineFlowRun = LineRun & {
  workflow_slug?: string;
  /** The graph the run ran: its workflows row and the stations it recorded (lineGraphs). */
  workflow_id?: string;
  graph_nodes?: Array<{ id: string; h: string }>;
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

/** A finder a project's line profile declares (LP3). */
export type { LineFinderDecl };
/** A project row as the line reads it: its goal fields and its published profile. */
export type LineProject = GoalRow & {
  _id: string;
  project_path?: string;
  line_profile?: PublishedLineProfile | null;
};

/** idle: nothing has reached the station yet, or nothing waits for it, which
 *  is not trouble. starved: Sense when signals used to arrive and stopped, or
 *  In build while causes wait and nothing builds. clear: a downstream station
 *  with nothing in it, the good outcome. ask: cards wait on the viewer. */
export type StageKind = "running" | "ask" | "paused" | "starved" | "failing" | "idle" | "clear";
/** `run`: the run the state speaks about (the failed one), so its words can open its report. */
export type StageState = { kind: StageKind; since?: number | null; why: string; run?: string };

export type GoalChip = { ref: string; label: string; kind: "initiative" | "project" | "line" | "unknown" | "parked" | "ungrounded" };

export type SenseSource = {
  source: string;
  day: number;
  week: number;
  /** Signals per day over the last seven days, oldest first. */
  spark: number[];
  /** The newest signal in the window; null for a declared finder with none. */
  newest: LineSignal | null;
  kinds: string[];
  /** The declaration, when the profile names this source (LP3). */
  finder?: LineFinderDecl;
  /** Declared, and no signal in the last 24 hours. newest says since when. */
  silent: boolean;
  /** Filed signals although the profile, which declares finders, does not name it. */
  undeclared: boolean;
};

/** Whether the line may start its next cause, as the sweep decides it
 *  (convex orgLine admissionWait, LE6): the role that starts this project's
 *  line, its switch, and the answering person's card slots. `role: null`:
 *  no role looks after the project, so nothing starts on its own. */
export type LineAdmission = {
  role: { id: string; handle: string; paused: boolean } | null;
  /** Work filed under no project: no role admits it, so no line ever starts it. */
  noProject?: boolean;
  /** The line's start switch (learning-loop.md LL5; roleAutonomy.lineStartsOn):
   *  on, the line starts problems on its own up to `slots` at a time. */
  on: boolean;
  /** What the line would start in order, the sweep's own queue (orgLine.queue);
   *  null or absent until the server has said. */
  queued?: number | null;
  /** Open cards the answering person may hold across their lines (caps.cards). */
  slots: number;
  /** Cards they hold open now; null until the server has said. */
  busy: number | null;
  /** Hands the role has started today and may start a day; null until known. */
  hands: number | null;
  handsCap: number | null;
};

/** Why the line starts nothing while causes wait, in one sentence, and the
 *  two words a node mark has room for; null when it may start the next one.
 *  The order is the sweep's: the switch, the day's hands, then the slots. */
export type AdmissionHold = { why: string; short: string; long?: string };
export function admissionHold(a: LineAdmission): AdmissionHold | null {
  // `long` is the node's own sentence (its mark and Health), with the way out.
  if (a.noProject) return { why: "they belong to no project, so nothing works on them", short: "No project", long: "Nothing starts here on its own: these causes belong to no project. Move one into a project to have its line work on it" };
  if (!a.role) return { why: "no one is in charge of this project's line, so nothing starts on its own", short: "No one in charge" };
  const who = `@${a.role.handle}`;
  if (a.role.paused) return { why: `${who}, who runs this line, is paused, so nothing new starts`, short: "Paused" };
  if (!a.on) return { why: `${who} has automatic starting off, so nothing starts on its own`, short: "Starting off" };
  if (a.hands != null && a.handsCap != null && a.hands >= a.handsCap) return { why: `${who} used all ${a.handsCap} of today's sessions`, short: "Today's limit reached" };
  if (a.busy != null && a.busy >= a.slots) return { why: a.slots === 1 ? "the line works on one fix at a time, and one waits for your decision" : `the line works on ${a.slots} fixes at a time, and ${a.slots === 2 ? "both" : `all ${a.slots}`} wait for your decision`, short: `${a.slots} of ${a.slots} places taken` };
  return null;
}

/** LE5, LE6: a cause the sweep may admit, the test orgLine isReadyCause
 *  makes: ground marked it ready and named its goal, and nobody else holds it. */
export const readyForLine = (t: LineCauseTask) => t.readiness === "ready" && !!t.goal_ref?.trim() && !t.assignee;

/** The sweep looks every two minutes (orgLine.sweep): a ready cause still
 *  waiting this long with a slot free was not passed over by chance. */
export const ADMISSION_STALL_MS = 30 * 60_000;

/** Why nothing starts while admission is on and a slot is free (LE6, line-map.md
 *  LX3): none of the waiting causes is one the sweep takes, or the sweep is not
 *  starting the ones it should. `top` is the cause to start by hand. Null
 *  while the queue moves as it should. */
export function admissionStall(a: LineAdmission, ranked: CauseRow[], lastStart: number | null, now: number): (AdmissionHold & { top: CauseRow | null }) | null {
  if (!a.role || !ranked.length) return null;
  const waited = (t: LineCauseTask) => now - (t.cause?.first_seen ?? t.created_at);
  const ready = ranked.filter((r) => readyForLine(r.task));
  if (!ready.length) {
    if (!ranked.some((r) => waited(r.task) > ADMISSION_STALL_MS)) return null;
    const count = (pred: (t: LineCauseTask) => boolean) => ranked.filter((r) => pred(r.task)).length;
    const parts = [
      [count((t) => t.readiness === "needs_context"), "needs context from a person", "need context from a person"],
      [count((t) => !t.readiness), "is not grounded yet", "are not grounded yet"],
      [count((t) => t.readiness === "not_actionable"), "has nothing to change", "have nothing to change"],
      [count((t) => !!t.assignee), "is assigned to someone", "are assigned to someone"],
    ].filter(([n]) => (n as number) > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
    const n = ranked.length;
    const why = `none is ready to start${parts.length ? `: ${parts.join(", ")}` : ""}`;
    return { why, short: "None ready", long: `${n === 1 ? "The cause here is" : `None of the ${n} causes here is`} ready to start${parts.length ? `: ${parts.join(", ")}` : ""}. The line starts only causes its first step marked ready`, top: null };
  }
  // Ready since ground last touched it: a cause first seen days ago and
  // grounded a minute ago has not waited on the sweep yet.
  const readySince = Math.min(...ready.map((r) => r.task.updated_at ?? r.task.created_at));
  const since = Math.max(readySince, lastStart ?? 0);
  if (now - since <= ADMISSION_STALL_MS) return null;
  const age = ageShort(now - since);
  const free = a.busy != null ? a.slots - a.busy : null;
  const room = free == null ? "room for more" : `room for ${free} more`;
  const readyWords = `${ready.length} ${ready.length === 1 ? "cause" : "causes"} ready`;
  return {
    why: `nothing has started in ${age}, though there is ${room}`,
    short: `No start in ${age}`,
    long: `Starting is on, with ${room} and ${readyWords}, but nothing has started in ${age}. The check that starts the top one every two minutes is not running; start it by hand`,
    top: ready[0],
  };
}

export type CauseRow = { task: LineCauseTask; score: number; signals: number; goal: GoalChip };
/** The admission of work filed under no project: no role takes it in, so
 *  causes wait there until a person moves one into a project. */
export const NO_PROJECT_ADMISSION: LineAdmission = { role: null, noProject: true, on: false, slots: 0, busy: null, hands: null, handsCap: null };

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
  /** The shipped line, a project's customized copy, or null for another workflow. */
  line: LineRunKind | null;
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
  /** Of this week's ships, how many still sit in Watching: Closed lists a
   *  shipped cause only once its watch ends, so the page says where they are. */
  shippedInWatch: number;
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
  /** hold: why nothing starts while causes wait (the switch, the caps, or
   *  admitting nothing it should), the sentence every surface reads. `top`:
   *  the cause to start by hand when the sweep is not starting it. */
  causes: Column<CauseRow> & { parked: CauseRow[]; hold: (AdmissionHold & { top?: CauseRow | null }) | null };
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

/** LE12: the quiet watch end stamps resolved_at; a close after it is a later
 *  ship of a reopened cause. */
const resolvedQuietly = (t: LineCauseTask) => typeof t.resolved_at === "number" && t.resolved_at >= (t.closed_at ?? 0);

/** When a closed cause's watch ended quiet (LE12), or null: swept, it carries
 *  resolved_at; not swept yet, it still holds its past watch_until. The one
 *  rule /line, the map and a trace read "held" by. */
export function quietWatchEnd(t: LineCauseTask, now: number): number | null {
  if (!terminal(t.status) || inWatch(t, now)) return null;
  if (resolvedQuietly(t)) return t.resolved_at!;
  return typeof t.watch_until === "number" ? t.watch_until : null;
}

/** The goal a cause names (LE5): an initiative ref ("in-3" or
 *  "in-3:metric"), a project ref, "line" (a change to the line itself, which
 *  serves the line's own health), "none" (parked), or nothing yet. */
export function goalChip(ref: string | null | undefined, initiatives: GoalRow[], projects: GoalRow[]): GoalChip & { priority: "p0" | "p1" | "p2" | "p3" | "unranked" | null } {
  const raw = ref?.trim();
  if (!raw) return { ref: "", label: "not grounded", kind: "ungrounded", priority: null };
  if (raw === NO_GOAL) return { ref: raw, label: "no goal", kind: "parked", priority: null };
  if (raw === LINE_GOAL) return { ref: raw, label: "the line itself", kind: "line", priority: "unranked" };
  const [head, metric] = raw.split(":");
  const initiative = initiatives.find((i) => i.short_id === head);
  if (initiative) return { ref: raw, label: metric ? `${initiative.title} · ${metric}` : initiative.title, kind: "initiative", priority: initiative.priority ?? "unranked" };
  // A ground may name a project by its row id as well as its short id.
  const project = projects.find((p) => p.short_id === head || (p as { _id?: string })._id === head);
  if (project) return { ref: raw, label: project.title, kind: "project", priority: project.priority ?? "unranked" };
  // A ref this workspace cannot name is never shown as its key: a row id is
  // a project elsewhere, any other ref a goal this workspace does not hold.
  return { ref: raw, label: isConvexId(head) ? "a project in another workspace" : "a goal outside this workspace", kind: "unknown", priority: "unranked" };
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


/** Sources every line has without declaring them: a person filing by hand or
 *  through the map's composer (lineCause.ts), and the line's own lessons
 *  (line-map.md LX2: "one per declared finder, plus people and lessons"). */
const BUILT_IN_SOURCES = new Set(["person", "lesson"]);
/** A person or the line's lessons: filing here needs no finder. */
export const isBuiltInSource = (source: string) => BUILT_IN_SOURCES.has(source.toLowerCase());
/** A source that filed signals while the profile declares finders but not it. */
export const isUndeclaredSource = (source: string, finders: ReadonlyArray<{ source: string }>) =>
  finders.length > 0 && !BUILT_IN_SOURCES.has(source.toLowerCase()) && !finders.some((f) => f.source.toLowerCase() === source.toLowerCase());
export function buildLineFlow<D extends LineDecision>(input: {
  signals: LineSignal[];
  tasks: LineCauseTask[];
  runs: LineFlowRun[];
  decisions: D[];
  initiatives: GoalRow[];
  /** Goal chips read these; a row with an id also names its customized line. */
  projects: Array<GoalRow & { _id?: string }>;
  now: number;
  cardsCap?: number;
  /** The selected project's declared finders: each is a Sense row, silent or not. */
  finders?: LineFinderDecl[];
  /** When the profile declaring them last changed: a finder with nothing in the window that may be newer than the window is new, not silent. */
  findersSince?: number;
  /** The sweep's admission for this project's line, when the caller knows its role. */
  admission?: LineAdmission | null;
}): LineFlow<D> {
  const { now } = input;
  const cardsCap = input.cardsCap ?? DEFAULT_LINE_CARDS_CAP;
  const causes = input.tasks.filter(isCause);
  const causeById = new Map(causes.map((t) => [t._id, t]));
  const weekAgo = now - WEEK;
  const dayAgo = now - DAY;

  // ── sense ──
  const finders = input.finders ?? [];
  const finderBySource = new Map(finders.map((f) => [f.source.toLowerCase(), f]));
  const bySource = new Map<string, LineSignal[]>();
  for (const s of input.signals) {
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }
  const sources: SenseSource[] = [];
  for (const [source, list] of bySource) {
    const sorted = [...list].sort((a, b) => b.created_at - a.created_at);
    const spark = perDay(sorted.map((s) => s.created_at), now);
    let day = 0;
    let week = 0;
    for (const s of sorted) {
      if (s.created_at >= weekAgo) week++;
      if (s.created_at >= dayAgo) day++;
    }
    if (week === 0 && !finderBySource.has(source)) continue;
    sources.push({ source, day, week, spark, newest: sorted[0], kinds: [...new Set(sorted.map((s) => s.kind))], finder: finderBySource.get(source), silent: false, undeclared: false });
  }
  // A declared finder is a row even with nothing in the window: its silence is the news.
  const seen = new Set(sources.map((s) => s.source));
  for (const f of finders) {
    if (!seen.has(f.source)) sources.push({ source: f.source, day: 0, week: 0, spark: new Array(7).fill(0), newest: null, kinds: f.kind === "any" ? [] : f.kind, finder: f, silent: false, undeclared: false });
  }
  for (const s of sources) {
    const mayBeNew = !s.newest && input.findersSince != null && now - input.findersSince < LINE_SIGNAL_WINDOW_MS;
    s.silent = !!s.finder && s.day === 0 && !mayBeNew;
    s.undeclared = isUndeclaredSource(s.source, finders);
  }
  const newestAt = (s: SenseSource) => s.newest?.created_at ?? 0;
  sources.sort((a, b) => b.day - a.day || b.week - a.week || newestAt(b) - newestAt(a) || a.source.localeCompare(b.source));
  const daySignals = input.signals.filter((s) => s.created_at >= dayAgo);
  const lastSignal = input.signals.reduce<number | null>((m, s) => (m === null || s.created_at > m ? s.created_at : m), null);
  const started = input.signals.length > 0 || causes.length > 0;
  const silent = sources.filter((s) => s.silent).length;
  const senseState: StageState = daySignals.length > 0
    ? { kind: "running", since: lastSignal, why: silent ? `signals arriving, ${silent} of ${finders.length} finders silent` : "signals arriving" }
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
  const forks = lineForkIndex(input.projects.filter((p): p is GoalRow & { _id: string } => !!p._id));
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
    const line = lineRunKind(run, forks);
    buildItems.push({ run, node, since: node?.started_at ?? run.created_at, task, stalled: now - (run.updated_at ?? run.created_at) > DAY, step, line, ...runName(run, task, step) });
  }
  buildItems.sort((a, b) => Number(a.stalled) - Number(b.stalled) || a.since - b.since);
  const fresh = buildItems.filter((b) => !b.stalled);
  const stalled = buildItems.length - fresh.length;
  const stalledNote = stalled ? `, ${stalled} stalled` : "";
  const pausedRuns = fresh.filter((b) => b.run.status === "paused");
  const lastEnded = lineRuns
    .filter((r) => (r.status === "completed" || r.status === "failed") && r.updated_at >= weekAgo)
    .sort((a, b) => b.updated_at - a.updated_at)[0];

  // What the line did to each cause, from its runs' stations (LE12): the
  // latest end a run reached, so a cause shipped by the line counts as shipped
  // whatever its status says at this moment.
  const lineEnd = new Map<string, { kind: LineRunEnd; at: number }>();
  for (const r of lineRuns) {
    const end = lineRunOutcome(r.node_statuses);
    const prev = lineEnd.get(r.task_id!);
    if (end && (!prev || end.at >= prev.at)) lineEnd.set(r.task_id!, end);
  }

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
      const quiet = quietWatchEnd(t, now);
      const outcome: ClosedOutcome = t.status === "dropped" || lineEnd.get(t._id)?.kind === "dissolved" ? "dissolved" : quiet != null ? "resolved" : "shipped";
      const closedAt = outcome === "resolved" ? quiet! : at;
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
  // With the role known, its admission says why nothing starts (the switch,
  // the day's hands, the slots), the sweep's own order.
  const gateCards = awaitingItems.filter(isGateCard);
  const capped = gateCards.length >= cardsCap;
  const lastStart = lineRuns.reduce<number | null>((m, r) => (m === null || r.created_at > m ? r.created_at : m), null);
  const held = input.admission && ranked.length > 0 ? admissionHold(input.admission) : null;
  // With the line's start switch off, starting by hand is the other way in: the top ready cause is offered.
  const hold = input.admission && ranked.length > 0
    ? (held && !input.admission.on ? { ...held, top: ranked.find((r) => readyForLine(r.task)) ?? null } : held) ?? admissionStall(input.admission, ranked, lastStart, now)
    : null;
  const causesState: StageState = hold
    ? { kind: "paused", since: null, why: hold.why }
    : !input.admission && capped
      ? { kind: "paused", since: gateCards[cardsCap - 1]?.created_at ?? null, why: `queued behind ${gateCards.length} open cards` }
      : openRows.length > 0
        ? { kind: "running", why: input.admission ? `${ranked.length} queued; the next starts within two minutes` : `${ranked.length} queued` }
        : { kind: "idle", why: started ? "no open cause" : "opens on the first signal" };

  const buildState: StageState = lastEnded?.status === "failed"
    ? { kind: "failing", since: lastEnded.updated_at, why: lastEnded.fail_reason?.trim() || "last run failed", run: lastEnded._id }
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
  // A ship is a line run's ship record this week (its watch station ran),
  // whatever the cause's status is now: a reopened cause was still shipped.
  const shipped = causes
    .map((t) => ({ t, end: lineEnd.get(t._id) }))
    .filter((x) => x.end?.kind === "shipped" && x.end.at >= weekAgo)
    .map((x) => ({ t: x.t, at: x.end!.at }));
  const shippedThisWeek = shipped.map((x) => x.t);
  const runTokens = new Map<string, number>();
  for (const r of input.runs) if (r.task_id) runTokens.set(r.task_id, (runTokens.get(r.task_id) ?? 0) + (r.total_tokens ?? 0));
  const tokens = shippedThisWeek.reduce((sum, t) => sum + (runTokens.get(t._id) ?? 0), 0);
  const throughput: Throughput = {
    signalsIn: input.signals.filter((s) => s.created_at >= weekAgo).length,
    opened: causes.filter((t) => t.created_at >= weekAgo).length,
    dissolved: causes.filter((t) => t.status === "dropped" && (t.closed_at ?? 0) >= weekAgo).length,
    shipped: shippedThisWeek.length,
    shippedInWatch: shippedThisWeek.filter((t) => inWatch(t, now)).length,
    reopened: input.signals.filter((s) => s.reopened && s.created_at >= weekAgo).length,
    medianToShip: median(shipped.filter((x) => x.t.cause?.first_seen).map((x) => x.at - x.t.cause!.first_seen)),
    tokensPerShip: shippedThisWeek.length && tokens ? tokens / shippedThisWeek.length : null,
    daily: {
      signalsIn: perDay(input.signals.map((s) => s.created_at), now),
      opened: perDay(causes.map((t) => t.created_at), now),
      dissolved: perDay(causes.filter((t) => t.status === "dropped").map((t) => t.closed_at), now),
      shipped: perDay(shipped.map((x) => x.at), now),
      reopened: perDay(input.signals.filter((s) => s.reopened).map((s) => s.created_at), now),
    },
  };

  return {
    sense: { items: sources, count: daySignals.length, oldestAt: oldest(daySignals.map((s) => s.created_at)), state: senseState },
    causes: { items: ranked, parked, hold, count: openRows.length, oldestAt: oldest(openRows.map((r) => r.task.cause?.first_seen ?? r.task.created_at)), state: causesState },
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

/** A silent finder's silence in words, the same on the Line page and in line
 *  settings: how long since its last signal, or the whole window the line
 *  reads when it has filed nothing in it. */
export function silentText(src: Pick<SenseSource, "newest" | "silent">, now: number): string {
  // Nothing in the window: silent at least that long, unless the finder may be newer than it.
  if (src.newest) return `silent ${ageShort(now - src.newest.created_at)}`;
  return src.silent ? `silent ${ageShort(LINE_SIGNAL_WINDOW_MS)}+` : "nothing filed yet";
}

/** "3d", "5h", "12m": the largest unit, for a sentence. */
export function ageShort(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** station names the column a part points at, so the page can link it. */
/** href: a page the part opens instead (a failed run's report). */
/** `why`: the reason behind a part, said after it as its own quieter sentence ("149 causes wait to start." then why). */
export type HeadlinePart = { text: string; tone: "ask" | "warn" | "fail" | "live" | "calm" | "clear"; station?: "causes" | "build" | "awaiting" | "watching"; href?: string; why?: string };

/** One sentence from the flow's state, what needs the founder first: cards
 *  waiting on them, then what is building and what stalled or failed, then
 *  what waits to be admitted. Ends on the calm part when nothing waits. */
/** `scope` names the line the headline speaks for ("Agent Quality"), so an
 *  all-clear never reads as the whole workspace's while another project
 *  holds a card (line-map.md LX1). */
export function lineHeadline(flow: LineFlow, now: number, scope?: string | null): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const { awaiting, build, causes, watching } = flow;
  if (awaiting.count > 0) {
    parts.push({ text: `${plural(awaiting.count, "finished fix waits", "finished fixes wait")} for your decision${awaiting.oldestAt ? `, oldest ${ageShort(now - awaiting.oldestAt)}` : ""}`, tone: "ask", station: "awaiting" });
  }
  const fresh = build.items.filter((b) => !b.stalled).length;
  if (fresh > 0) parts.push({ text: `${plural(fresh, "cause", "causes")} being worked on`, tone: "live", station: "build" });
  const stalled = build.items.filter((b) => b.stalled);
  if (stalled.length > 0) {
    const silent = Math.max(...stalled.map((b) => now - (b.run.updated_at ?? b.run.created_at)));
    parts.push({ text: `${plural(stalled.length, "run", "runs")} silent for ${ageShort(silent)}`, tone: "warn" });
  }
  if (build.state.kind === "failing") parts.push({ text: `last run failed${build.state.since ? ` ${ageShort(now - build.state.since)} ago` : ""}`, tone: "fail", ...(build.state.run ? { href: runHref(build.state.run) } : {}) });
  // The count every surface shows for the queue: parked causes wait here too.
  if (causes.state.kind === "paused") parts.push({ text: `${plural(causes.count, "cause waits", "causes wait")} to start`, why: causes.state.why, tone: "warn", station: "causes" });
  else if (causes.items.length > 0) parts.push({ text: `${plural(causes.items.length, "cause waits", "causes wait")} to start`, tone: "live", station: "causes" });
  if (watching.count > 0) parts.push({ text: `${plural(watching.count, "shipped fix is", "shipped fixes are")} being watched`, tone: "calm", station: "watching" });
  if (!flow.started && parts.length === 0) return [{ text: "Nothing has reached the line yet", tone: "calm" }];
  const here = scope ? ` in ${scope}` : "";
  // An all-clear beside a warning reads as a contradiction: it is said only when nothing is wrong.
  if (awaiting.count === 0 && !parts.some((p) => p.tone === "warn" || p.tone === "fail")) parts.push({ text: parts.length ? `nothing needs you${here}` : scope ? "Quiet: nothing being worked on, nothing needs you" : "The line is quiet: nothing being worked on, nothing needs you", tone: "clear" });
  return parts;
}

// ── One project's line (line-profile.md LP1) ──

/** A line's key: a project id, NO_PROJECT for work filed under none, or ALL_PROJECTS. */
export const NO_PROJECT = "none";
export const ALL_PROJECTS = "all";

type LineRows<D extends LineDecision> = Pick<Parameters<typeof buildLineFlow<D>>[0], "signals" | "tasks" | "runs" | "decisions">;

/** The project a row belongs to: its own, else its cause's (a signal filed before signals carried one). */
const projectKey = (id: string | null | undefined) => id || NO_PROJECT;

/**
 * The rows of one project's line: its causes (and its other tasks, whose runs
 * count apart), the signals filed into it, the runs and cards on its tasks.
 */
export function scopeLine<D extends LineDecision, R extends LineRows<D>>(rows: R, key: string): R {
  if (key === ALL_PROJECTS) return rows;
  const taskKey = new Map(rows.tasks.map((t) => [t._id, projectKey(t.project_id)]));
  const mine = (taskId: string | null | undefined) => !!taskId && taskKey.get(taskId) === key;
  return {
    ...rows,
    tasks: rows.tasks.filter((t) => projectKey(t.project_id) === key),
    signals: rows.signals.filter((s) => (s.project_id ? s.project_id === key : mine(s.task_id) || (key === NO_PROJECT && !taskKey.has(s.task_id)))),
    runs: rows.runs.filter((r) => mine(r.task_id)),
    decisions: rows.decisions.filter((d) => mine(d.task_id)),
  };
}

/** Waiting causes no run has touched on any line: the part of the queue the
 *  per-line counts (lineGraphs `work`, which count causes their runs worked)
 *  leave out, said beside them so the numbers add up. */
export function causesNeverRun(flow: Pick<LineFlow, "causes">, runs: ReadonlyArray<{ task_id?: string | null }>): number {
  const ran = new Set(runs.map((r) => r.task_id).filter(Boolean));
  return [...waitingCauseIds(flow)].filter((id) => !ran.has(id)).length;
}

/** The queue's causes by task id: the set the headline's "N waiting" counts. */
export const waitingCauseIds = (flow: Pick<LineFlow, "causes">): Set<string> => new Set([...flow.causes.items, ...flow.causes.parked].map((r) => r.task._id));

/** One row of the "all projects" roll-up: counts only. */
export type RollupRow = {
  key: string;
  title: string;
  short_id?: string;
  signalsDay: number;
  causes: number;
  build: number;
  awaiting: number;
  watching: number;
  closed: number;
  finders: number;
  silent: number;
  /** Finder sources (not people or lessons) that filed here this week with no declared finder, busiest first. */
  undeclared: string[];
  /** Why nothing new starts, in words, when the queue is held (admission known), else null. */
  hold: string | null;
  /** Live runs that have said nothing for a day. */
  stalled: number;
  /** The latest run failed. */
  failing: boolean;
  /** The graphs its runs went through, busiest first (lineGraphs). */
  graphs: ProjectGraph[];
  /** Waiting causes no line has run yet (causesNeverRun). */
  neverRun: number;
  /** The hold is automatic starting switched off (the role's switch or codecast's own), which the Causes switch answers. */
  startingOff: boolean;
};

/**
 * Every line with anything on it, counted the way its own page counts:
 * projects holding a cause or a signal in the window, projects whose profile
 * declares finders, and the work filed under no project. Most open causes first.
 */
export function lineRollup<D extends LineDecision>(rows: LineRows<D>, projects: LineProject[], now: number, cardsCap?: number, admissions?: ReadonlyMap<string, LineAdmission>): RollupRow[] {
  const keys = new Set<string>();
  for (const t of rows.tasks) if (isCause(t)) keys.add(projectKey(t.project_id));
  const causeKey = new Map(rows.tasks.map((t) => [t._id, projectKey(t.project_id)]));
  for (const s of rows.signals) keys.add(s.project_id || causeKey.get(s.task_id) || NO_PROJECT);
  for (const p of projects) if (p.line_profile) keys.add(p._id);
  const byId = new Map(projects.map((p) => [p._id, p]));
  const out: RollupRow[] = [];
  for (const key of keys) {
    const project = byId.get(key);
    // A project the viewer cannot see (another workspace's) is not a line here.
    if (key !== NO_PROJECT && !project) continue;
    const scoped = scopeLine(rows, key);
    const admission = key === NO_PROJECT ? NO_PROJECT_ADMISSION : admissions?.get(key);
    const f = buildLineFlow({ ...scoped, initiatives: [], projects: [], now, cardsCap, finders: project?.line_profile?.finders, findersSince: project?.line_profile?.changed_at, admission });
    out.push({
      key,
      title: project?.title ?? "No project",
      short_id: project?.short_id,
      signalsDay: f.sense.count,
      causes: f.causes.count,
      build: f.build.count,
      awaiting: f.awaiting.count,
      watching: f.watching.count,
      closed: f.closed.count,
      finders: project?.line_profile?.finders.length ?? 0,
      silent: f.sense.items.filter((s) => s.silent).length,
      undeclared: f.sense.items.filter((s) => !s.finder && s.week > 0 && !isBuiltInSource(s.source)).sort((a, b) => b.week - a.week).map((s) => s.source),
      hold: f.causes.count > 0 && f.causes.state.kind === "paused" ? f.causes.state.why : null,
      stalled: f.build.items.filter((b) => b.stalled).length,
      failing: f.build.state.kind === "failing",
      graphs: projectGraphs(scoped.runs, scoped.signals, undefined, waitingCauseIds(f)),
      neverRun: causesNeverRun(f, scoped.runs),
      startingOff: f.causes.count > 0 && f.causes.state.kind === "paused" && !!admission?.role && !admission.role.paused && !admission.on,
    });
  }
  return out.sort((a, b) => Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT) || b.causes - a.causes || b.awaiting - a.awaiting || b.signalsDay - a.signalsDay || a.title.localeCompare(b.title));
}

/** Is `dir` the checkout `root`, or inside it? */
const within = (dir: string, root: string) => {
  const r = root.replace(/\/+$/, "");
  return dir === r || dir.startsWith(`${r}/`);
};

/**
 * The line /line opens on: the project of the repo the viewer is in (the one
 * its profile names as default, else the project whose path holds it), else
 * the line with the most open causes, else the roll-up.
 */
export function defaultLineKey(rollup: RollupRow[], projects: LineProject[], repoPath: string | null | undefined): string {
  const lines = new Set(rollup.map((r) => r.key));
  if (repoPath) {
    const byProfile = projects.find((p) => p.line_profile?.default && p.line_profile.root && within(repoPath, p.line_profile.root));
    if (byProfile) return byProfile._id;
    const byPath = projects
      .filter((p) => p.project_path && within(repoPath, p.project_path) && lines.has(p._id))
      .sort((a, b) => b.project_path!.length - a.project_path!.length)[0];
    if (byPath) return byPath._id;
  }
  const busiest = rollup.find((r) => r.key !== NO_PROJECT && r.causes > 0) ?? rollup.find((r) => r.causes > 0);
  return busiest?.key ?? rollup[0]?.key ?? ALL_PROJECTS;
}
