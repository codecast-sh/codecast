// One run as a report (docs/architecture/the-line-end-to-end.md LE16, the
// line model LM7): what the run did and what is true now, the path it took in
// the line's phases with each station's result in one line, and, across runs,
// what each version of the line delivered (LE14, keyed by graph_hash). The run
// page, the task page's Line block, the /line rows and the project's Line tab
// all read it, so a run is told the same way everywhere. Pure: no store, no
// React.
import { CARD_GATE_NODE_ID, isLineRun, lineRunOutcome, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { runNodeLine, runNodeRows, type RunNodeRow } from "../workflowRun";
import { SHIPPED_LINE } from "./shippedLine.generated";

// ── the shape a report reads ─────────────────────────────────────────────────

export type ReportNode = { node_id: string; status: string; outcome?: string; label?: string; session_id?: string; session?: { _id: string; title?: string } | null; started_at?: number; completed_at?: number; result_preview?: string; activity?: string };

/** A run row as the store holds it (workflow_runs.enrichRun). */
export type ReportRun = {
  _id: string;
  status: string;
  task_id?: string;
  current_node_id?: string;
  current_node_label?: string;
  workflow_name?: string;
  node_statuses?: ReportNode[];
  gate_node_id?: string;
  gate_choices?: Array<{ key: string; label: string; target?: string }>;
  gate_response?: string;
  gate_answer?: string;
  gate_decision_short_id?: string;
  gate_decision_status?: string;
  card_cost_usd?: number;
  graph_hash?: string;
  fail_reason?: string;
  total_tokens?: number;
  created_at: number;
  updated_at: number;
};

/** What a report knows about the cause the run worked on. */
export type ReportTask = { short_id?: string; status: string; watch_until?: number | null; resolved_at?: number | null; readiness_note?: string | null; review_verdict?: { verdict: string } | null };

// ── phases ───────────────────────────────────────────────────────────────────

export type LinePhaseKey = "understand" | "prove" | "build" | "check" | "decide" | "ship";

/** The line's stations in the six phases a person reads (LE16). Every station
 *  of line.cast sits in exactly one; a project's copy keeps the station ids. */
export const LINE_PHASES: ReadonlyArray<{ key: LinePhaseKey; label: string; stations: readonly string[] }> = [
  { key: "understand", label: "Understand", stations: ["ground", "park", "plan", "plan_gate", "analyze"] },
  { key: "prove", label: "Prove", stations: ["prove", "red", "dissolve"] },
  { key: "build", label: "Build", stations: ["implement", "reopen"] },
  { key: "check", label: "Check", stations: ["verify", "green", "eval", "unscored", "review"] },
  { key: "decide", label: "Decide", stations: ["card_draft", "card_write", "card", "decide", "drop"] },
  { key: "ship", label: "Ship", stations: ["ship", "merge", "watch"] },
];

const PHASE_OF = new Map(LINE_PHASES.flatMap((p) => p.stations.map((s) => [s, p.key] as const)));
export const phaseOfStation = (id: string): LinePhaseKey | null => PHASE_OF.get(id) ?? null;

const GATES = new Set(["plan_gate", CARD_GATE_NODE_ID]);

// ── a station's result, in one line ──────────────────────────────────────────

const WORDS: Record<string, { done: string; failed?: string; live?: string }> = {
  ground: { done: "Tied the cause to a goal and rated it", live: "Grounding the cause" },
  park: { done: "Parked: not ready to build" },
  plan: { done: "Wrote the plan", live: "Writing the plan" },
  analyze: { done: "Read the cause and its signals", live: "Reading the cause" },
  prove: { done: "Looked for the miss", failed: "Could not look for the miss", live: "Looking for the miss" },
  red: { done: "Showed the miss failing on the base", failed: "No miss shown" },
  dissolve: { done: "Closed: the miss did not reproduce" },
  implement: { done: "Built the change", failed: "Build stopped", live: "Building the change" },
  reopen: { done: "Sent back to build with the note" },
  verify: { done: "Checks passed", failed: "Checks failed", live: "Running the checks" },
  green: { done: "The miss passes now", failed: "Still red" },
  eval: { done: "Evals passed", failed: "Evals failed", live: "Running the evals" },
  unscored: { done: "The evals could not score the change" },
  review: { done: "Review approved", failed: "Review stopped", live: "Reviewing the diff" },
  card_draft: { done: "Assembled the card" },
  card_write: { done: "Wrote the card", live: "Writing the card" },
  card: { done: "Card ready", failed: "Card refused" },
  drop: { done: "Closed the cause" },
  ship: { done: "Landed the change", failed: "Not shipped", live: "Shipping" },
  merge: { done: "Merged", failed: "Merge refused" },
  watch: { done: "Started the watch" },
};

const REVIEW_WORDS: Record<string, string> = { approve: "Review approved", changes: "Review asked for changes", reject: "Review rejected the change" };

/** "[S] Ship :: Land the change" → "Ship". */
export const choiceWords = (label: string) => label.replace(/^\[[^\]]*\]\s*/, "").split("::")[0].trim() || label;

/** The words of the option a gate was answered with: the decision's own
 *  option (enrichRun) for the run's last gate, else the run's key mirror. */
export function gateAnswer(run: Pick<ReportRun, "gate_answer" | "gate_choices" | "gate_node_id">, node: { node_id: string; outcome?: string }, response?: string): string | null {
  if (run.gate_answer && run.gate_node_id === node.node_id) return choiceWords(run.gate_answer);
  const key = (node.outcome ?? response ?? "").trim().toUpperCase();
  const hit = key ? run.gate_choices?.find((c) => c.key.toUpperCase() === key) : undefined;
  return hit ? choiceWords(hit.label) : null;
}

export type StepState = "done" | "failed" | "live" | "waiting";
export type ReportStep = { id: string; label: string; state: StepState; result: string; session?: { href: string; title?: string }; at?: number };

function stepOf(row: RunNodeRow, run: ReportRun, task?: ReportTask | null): ReportStep {
  const gate = GATES.has(row.id);
  const answer = gate ? gateAnswer(run, { node_id: row.id, outcome: row.outcome }, run.gate_node_id === row.id ? run.gate_response : undefined) : null;
  // A gate the runner closed with the answer's key is answered, not failed.
  const state: StepState = gate && answer ? "done"
    : row.current && run.status === "paused" ? "waiting"
    : row.status === "running" || row.current ? "live"
    : row.status === "failed" ? "failed" : "done";
  const words = WORDS[row.id];
  const own = runNodeLine(row);
  const result = gate
    ? (answer ? `Answered ${answer}` : state === "waiting" ? "Waiting for an answer" : "Asked")
    : row.id === "review" && task?.review_verdict && state !== "live"
      ? REVIEW_WORDS[task.review_verdict.verdict] ?? "Reviewed"
      : own ?? (state === "failed" ? words?.failed ?? "Failed" : state === "live" ? words?.live ?? "Running" : state === "waiting" ? "Waiting" : words?.done ?? "Done");
  const sid = row.session?._id ?? row.session?.session_id ?? row.session_id;
  return {
    id: row.id,
    label: row.label,
    state,
    result,
    ...(sid ? { session: { href: `/conversation/${row.session?._id ?? sid}`, title: row.session?.title } } : {}),
    at: row.completed_at ?? row.started_at,
  };
}

export type ReportPhase = { key: LinePhaseKey | "steps"; label: string; steps: ReportStep[]; folded: Array<{ id: string; label: string }>; state: StepState | "skipped" };

const isHidden = (r: RunNodeRow) => r.id === "start" || r.id === "exit" || r.type === "start" || r.type === "exit";
const reached = (r: RunNodeRow) => r.status !== "pending" || r.current;

/**
 * The path a run took (LE16): for a line run, the six phases with the
 * stations it reached, each with its one line result and the session that did
 * it; the stations it did not reach fold under each phase. Another workflow's
 * run is one group of its steps. `workflow` is the run's stored graph; a line
 * run without one reads the shipped line's.
 */
export function runPath(run: ReportRun, workflow?: { nodes?: Array<{ id: string; label?: string; type?: string }> } | null, task?: ReportTask | null): ReportPhase[] {
  const line = isLineRun(run.node_statuses);
  const rows = runNodeRows(run, workflow ?? (line ? SHIPPED_LINE : null)).filter((r) => !isHidden(r));
  if (!line) {
    const steps = rows.filter(reached).map((r) => stepOf(r, run, task));
    return [{ key: "steps", label: "Steps", steps, folded: rows.filter((r) => !reached(r)).map((r) => ({ id: r.id, label: r.label })), state: phaseState(steps) }];
  }
  const byPhase = new Map<string, RunNodeRow[]>();
  for (const r of rows) {
    const key = phaseOfStation(r.id) ?? "build";
    byPhase.set(key, [...(byPhase.get(key) ?? []), r]);
  }
  return LINE_PHASES.map((p) => {
    const own = byPhase.get(p.key) ?? [];
    const steps = own.filter(reached).sort((a, b) => (a.started_at ?? Infinity) - (b.started_at ?? Infinity)).map((r) => stepOf(r, run, task));
    return { key: p.key, label: p.label, steps, folded: own.filter((r) => !reached(r)).map((r) => ({ id: r.id, label: r.label })), state: steps.length ? phaseState(steps) : "skipped" };
  });
}

function phaseState(steps: ReportStep[]): StepState {
  if (steps.some((s) => s.state === "waiting")) return "waiting";
  if (steps.some((s) => s.state === "live")) return "live";
  // A phase that recovered (checks failed, then passed) reads by its last word.
  const last = steps[steps.length - 1];
  return last?.state === "failed" ? "failed" : "done";
}

// ── the outcome, first ───────────────────────────────────────────────────────

/** "Oct 12": the day a watch ends. */
export const shortDay = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export type OutcomeTone = "shipped" | "closed" | "live" | "waiting" | "failed" | "calm";
export type RunOutcome = { tone: OutcomeTone; end: LineRunEnd | null; text: string };

const nodeOf = (run: ReportRun, id: string) => run.node_statuses?.find((n) => n.node_id === id);
const ran = (run: ReportRun, id: string) => nodeOf(run, id)?.status === "completed";
const labelOf = (run: ReportRun, id?: string) => (id ? run.node_statuses?.find((n) => n.node_id === id)?.label ?? SHIPPED_LINE.nodes.find((n) => n.id === id)?.label ?? run.current_node_label ?? id : "the start");

/**
 * What the run did and what is true now, in one sentence (LE16). A shipped
 * run says where its watch stands, read from the cause: watching until a day,
 * the watch ended quiet, or its signal came back.
 */
export function runOutcome(run: ReportRun, task?: ReportTask | null, now = Date.now()): RunOutcome {
  const end = lineRunOutcome(run.node_statuses as any)?.kind ?? null;
  const at = labelOf(run, run.current_node_id);
  if (run.status === "pending") return { tone: "calm", end, text: "Queued to start." };
  if (run.status === "paused") {
    const gate = run.gate_node_id ?? run.current_node_id;
    return { tone: "waiting", end, text: gate === CARD_GATE_NODE_ID ? "Waiting for an answer on the card." : gate === "plan_gate" ? "Waiting for an answer on the plan." : `Waiting for an answer at ${at}.` };
  }
  if (run.status === "running") return { tone: "live", end, text: `Working: at ${at}.` };
  if (run.status === "failed") {
    const why = run.fail_reason?.trim().replace(/\.$/, "");
    if (why && /^stopped\b/i.test(why)) return { tone: "failed", end, text: `${why}.` };
    return { tone: "failed", end, text: why ? `Stopped at ${at}: ${why}.` : `Stopped at ${at}.` };
  }
  if (end === "shipped") {
    const watch = task?.watch_until ?? null;
    // LM3: a watch that reopens moves the cause to open; any other status
    // after a ship is a later run's or a person's, and this run still shipped.
    if (task && (task.status === "open" || task.status === "backlog")) return { tone: "failed", end, text: "Shipped, then reopened: its signal came back during the watch." };
    if (watch && watch > now) return { tone: "shipped", end, text: `Shipped. Watching${task?.short_id ? ` ${task.short_id}` : ""} until ${shortDay(watch)}.` };
    return { tone: "shipped", end, text: task?.resolved_at ? "Shipped. The watch ended quiet." : "Shipped." };
  }
  if (end === "dropped") return { tone: "closed", end, text: nodeOf(run, CARD_GATE_NODE_ID) ? "Dropped at the card." : "Dropped at the plan." };
  if (end === "dissolved") return { tone: "closed", end, text: "Closed without a change: the miss did not reproduce." };
  if (end === "parked") return { tone: "calm", end, text: `Parked: the cause is not ready to build.${task?.readiness_note ? ` ${task.readiness_note.trim().replace(/\.?$/, ".")}` : ""}` };
  if (ran(run, "unscored")) return { tone: "failed", end, text: "Stopped: the evals could not score the change." };
  if (nodeOf(run, "ship")?.status === "failed") return { tone: "failed", end, text: "Not shipped: the ship step failed." };
  if (task?.review_verdict?.verdict === "reject" && ran(run, "review")) return { tone: "closed", end, text: "Review rejected the change." };
  return { tone: "calm", end, text: "Finished." };
}

// ── versions: what each graph delivered (LE14) ───────────────────────────────

export type LineVersion = { hash: string; first: number; last: number; runs: number; shipped: number; revised: number; dropped: number; reopened: number; costUsd: number | null; live: number };

/**
 * One row per graph the project's line ran, newest first: its runs, how many
 * shipped, were sent back to revise, were dropped, and whose cause reopened in
 * watch after it shipped, and what its cards say it cost. A run that recorded
 * no hash (before LE14) groups as "unrecorded".
 */
export function lineVersions(runs: ReadonlyArray<ReportRun>, reopenedAt: (taskId: string) => number[]): LineVersion[] {
  const out = new Map<string, LineVersion>();
  for (const r of runs) {
    if (!isLineRun(r.node_statuses)) continue;
    const hash = r.graph_hash || "unrecorded";
    const v = out.get(hash) ?? { hash, first: r.created_at, last: r.created_at, runs: 0, shipped: 0, revised: 0, dropped: 0, reopened: 0, costUsd: null, live: 0 };
    v.runs++;
    v.first = Math.min(v.first, r.created_at);
    v.last = Math.max(v.last, r.created_at);
    const end = lineRunOutcome(r.node_statuses as any);
    if (end?.kind === "shipped") {
      v.shipped++;
      if (r.task_id && reopenedAt(r.task_id).some((t) => t > end.at)) v.reopened++;
    }
    if (end?.kind === "dropped") v.dropped++;
    if (ran(r, "reopen")) v.revised++;
    if (r.status === "running" || r.status === "paused" || r.status === "pending") v.live++;
    if (typeof r.card_cost_usd === "number") v.costUsd = (v.costUsd ?? 0) + r.card_cost_usd;
    out.set(hash, v);
  }
  return [...out.values()].sort((a, b) => b.last - a.last);
}

// ── where a cause is (LM3) ───────────────────────────────────────────────────

/**
 * Where a cause is, in one sentence (the-line-model.md LM3's "also shown"):
 * the newest run speaks while it runs; otherwise the task status the line
 * wrote, with the watch day after a ship and "reopened" when a signal came
 * back during the watch.
 */
export function causeWhere(task: ReportTask, latest: ReportRun | null, reopened: boolean, now = Date.now()): RunOutcome {
  const live = latest && (latest.status === "running" || latest.status === "paused" || latest.status === "pending");
  if (live) return runOutcome(latest, task, now);
  if (task.status === "dropped") return { tone: "closed", end: "dropped", text: "Dropped." };
  if (task.status === "done" && task.watch_until && task.watch_until > now) return { tone: "shipped", end: "shipped", text: `Shipped. Watching until ${shortDay(task.watch_until)}.` };
  if ((task.status === "open" || task.status === "backlog") && reopened) return { tone: "failed", end: null, text: "Reopened: its signal came back during the watch." };
  if (latest) {
    const said = runOutcome(latest, task, now);
    if (task.status === "open" || task.status === "backlog") return said.end === "parked" ? said : { tone: "calm", end: null, text: "Waiting to be admitted." };
    return said;
  }
  if (task.status === "done") return { tone: "shipped", end: null, text: "Done." };
  if (task.status === "open" || task.status === "backlog") return { tone: "calm", end: null, text: "Waiting to be admitted." };
  return { tone: "calm", end: null, text: task.status === "in_review" ? "In review." : "In progress." };
}
