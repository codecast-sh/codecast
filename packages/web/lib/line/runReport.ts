// One run as a report (docs/architecture/the-line-end-to-end.md LE16, the
// line model LM7): what the run did and what is true now, the path it took in
// the line's phases with each station's result in one line, and, across runs,
// what each version of the line delivered (LE14, keyed by graph_hash). The run
// page, the task page's Line block, the /line rows and the project's Line tab
// all read it, so a run is told the same way everywhere. Pure: no store, no
// React.
import { CARD_GATE_NODE_ID, isLineRun, passedUnansweredCard, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { threadStateHeadline, threadStateResult } from "@codecast/shared/contracts";
import { choiceWords, isLiveRun, runEnd } from "@codecast/shared/contracts/causeHistory";
import { LINE_PHASES, phaseOfStation, type LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import { runNodeLine, runNodeRows, scriptLine, type RunNodeRow } from "../workflowRun";
import { SHIPPED_LINE } from "./shippedLine.generated";

// ── the shape a report reads ─────────────────────────────────────────────────

export type ReportNode = { node_id: string; status: string; outcome?: string; label?: string; session_id?: string; session?: { _id: string; title?: string; state?: string; state_status?: string; result?: string; message_count?: number; killed?: boolean; handoff?: { status: string; note?: string } } | null; started_at?: number; completed_at?: number; result_preview?: string; activity?: string };

/** A run row as the store holds it (workflow_runs.enrichRun). */
export type ReportRun = {
  _id: string;
  status: string;
  task_id?: string;
  task_short_id?: string;
  current_node_id?: string;
  current_node_label?: string;
  workflow_name?: string;
  /** "workflow" for a Workflow tool run, reported from its session's snapshot: no line stations, no named ends. */
  run_kind?: string;
  /** The phases a Workflow tool run declared. */
  phases?: Array<{ title: string; detail?: string }>;
  node_statuses?: ReportNode[];
  gate_node_id?: string;
  gate_choices?: Array<{ key: string; label: string; target?: string }>;
  gate_response?: string;
  gate_answer?: string;
  gate_decision_short_id?: string;
  gate_decision_status?: string;
  card_cost_usd?: number;
  graph_hash?: string;
  /** Each station's own hash in that graph (runner graphNodeHashes), so two versions say which stations changed. */
  graph_nodes?: Array<{ id: string; h: string }>;
  fail_reason?: string;
  total_tokens?: number;
  created_at: number;
  updated_at: number;
};

/** What a report knows about the cause the run worked on. */
export type ReportTask = { short_id?: string; status: string; watch_until?: number | null; resolved_at?: number | null; readiness_note?: string | null; review_verdict?: { verdict: string } | null };

// ── phases ───────────────────────────────────────────────────────────────────

export type { LinePhaseKey };

/** The line's stations in the six phases a person reads (LE16). Every station
 *  of line.cast sits in exactly one; a project's copy keeps the station ids. */
/** Plain names for steps whose graph label is shop talk ("Red", "Card",
 *  "Shared text"). Every surface (the map, a trace, a run report) names a
 *  step by its plain word; the graph file's own label is the subtitle a
 *  station's panel gives it, so a reader can still find it in the .cast file. */
const PLAIN_NAMES: Record<string, string> = {
  ground: "Check against goals",
  shared: "Prepare the shared text",
  stamp: "Record the cause",
  red: "Confirm the test fails",
  green: "Recheck the test passes",
  card_draft: "Gather the facts",
  card_write: "Write the summary",
  card: "Check the summary",
  park_proposal: "Save the plan",
  park_built: "Save the fix",
  approve_carried: "Use an earlier approval",
  revise_proposal: "Revise the plan",
  revise_build: "Revise the fix",
  eval_scope: "Pick the evals",
  ask: "Ask you",
};

/** The name a step shows everywhere: its plain word, else its graph's own label. */
export const stepLabel = (n: { id: string; label?: string | null }): string => PLAIN_NAMES[n.id] || n.label?.trim() || n.id;

/** The graph file's own label when the step shows a different, plain word, else null. */
export const fileStepLabel = (id: string, label?: string | null): string | null => {
  const plain = PLAIN_NAMES[id];
  const own = label?.trim();
  return plain && own && own.toLowerCase() !== plain.toLowerCase() ? own : null;
};

/** A graph's edge words with its shop talk swapped for plain words
 *  ("card refused" reads "report refused", "still red" "still failing"). */
export const plainStepWords = (text: string): string => text
  .replace(/^no miss shown$/i, "the test didn't fail first, so retry")
  .replace(/^go already given$/i, "you already approved it")
  .replace(/\bcard(s?)\b/gi, "report$1").replace(/\bstill red\b/gi, "still failing");

export { LINE_PHASES, phaseOfStation };

const GATES = new Set(["plan_gate", "ask", CARD_GATE_NODE_ID]);
/** A station that asks a person (the plan gate, a builder's question, the card gate). */
export const isGateNode = (id: string | null | undefined) => !!id && GATES.has(id);

export { isLiveRun };
/** The run's last gate was taken back or dismissed without an answer: "withdrawn" or "dismissed", else null. */
export const closedGate = (run: Pick<ReportRun, "gate_decision_status" | "gate_answer">): "withdrawn" | "dismissed" | null =>
  !run.gate_answer && (run.gate_decision_status === "withdrawn" || run.gate_decision_status === "dismissed") ? run.gate_decision_status : null;
/** The runner itself was stopped (a signal), so the station it was at never gave its verdict. */
const RUNNER_STOP = /\brunner was stopped \((SIG[A-Z]+)\)(?: at (\S+))?/;
const interrupted = (run: Pick<ReportRun, "status" | "fail_reason">) => run.status === "failed" && RUNNER_STOP.test(run.fail_reason ?? "");

// ── a station's result, in one line ──────────────────────────────────────────

const WORDS: Record<string, { done: string; failed?: string; live?: string }> = {
  ground: { done: "Tied the cause to a goal and rated it", live: "Grounding the cause" },
  park: { done: "Parked: not ready to build" },
  plan: { done: "Wrote the plan", live: "Writing the plan" },
  analyze: { done: "Read the cause and its signals", live: "Reading the cause" },
  prove: { done: "Wrote a test that shows the problem", failed: "Could not write a test for the problem", live: "Writing a test for the problem" },
  prove_line: { done: "Named the recorded runs that show the problem", failed: "Could not show the problem on recorded runs", live: "Finding the runs that show the problem" },
  red: { done: "The test failed before the change, as it should", failed: "The test did not show the problem" },
  dissolve: { done: "Closed: the problem did not reproduce" },
  implement: { done: "Built the change", failed: "Build stopped", live: "Building the change" },
  implement_line: { done: "Built the change to the line", failed: "Build stopped", live: "Building the change to the line" },
  reopen: { done: "Sent back to build with the note" },
  verify: { done: "Checks passed", failed: "Checks failed", live: "Running the checks" },
  green: { done: "The test passes with the change", failed: "The test still fails" },
  eval: { done: "Evals passed", failed: "Evals failed", live: "Running the evals" },
  unscored: { done: "The evals could not score the change" },
  review: { done: "Review approved", failed: "Review stopped", live: "Reviewing the diff" },
  card_draft: { done: "Gathered the facts for your decision" },
  card_write: { done: "Wrote the summary you decide on", live: "Writing the summary you decide on" },
  card: { done: "Card ready", failed: "Card refused" },
  drop: { done: "Closed the cause" },
  rebase: { done: "Put the change on the default branch", failed: "Could not rebase", live: "Rebasing onto the default branch" },
  ship: { done: "Landed the change", failed: "Not shipped", live: "Shipping" },
  merge: { done: "Merged", failed: "Merge refused" },
  watch: { done: "Started the watch" },
};

/** Words for an outcome a station reported, by station; a bare outcome
 *  means the same at any station. A station's meaning comes from what it
 *  reported, never from its id: on a line where every run passes Dissolve,
 *  most runs pass it on rather than close. */
const REPORTED: Record<string, string> = {
  "dissolve:open": "Passed it on: the problem needs its own fix",
  dissolved: "Closed: no fix needed",
  "investigate:mechanism": "Named the cause",
  "investigate:failed": "Could not find the cause",
  "investigate:judge_defect": "The judge was wrong, not the agent",
  "refine:refined": "Rebuilt the issue around the cause",
  "refine:wrong_cause": "The cause did not fit the issue",
  "prove:red": "Proved the problem: its check fails before the change",
  "prove:not_reproduced": "Could not reproduce the problem",
};

/** What a station's session reported (`cast state`): the structured result it
 *  pinned (`result`, its `outcome`), its own first sentence, the prose around
 *  the result (its reasoning), and whether it asked a person. */
export type StationReport = { outcome: string | null; result: Record<string, unknown> | null; line: string | null; prose: string | null; asked: boolean };

export function stationReport(s: ReportNode["session"] | null | undefined): StationReport | null {
  if (!s?.state) return null;
  let result: Record<string, unknown> | null = null;
  try {
    const json = s.result ?? threadStateResult(s.state);
    const parsed = json ? JSON.parse(json) : null;
    result = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    result = null;
  }
  const outcome = typeof result?.outcome === "string" ? result.outcome : null;
  const prose = s.state.replace(/```json[ \t]*\n[\s\S]*?\n[ \t]*```/g, "").trim() || null;
  return { outcome, result, line: threadStateHeadline(s.state) || null, prose, asked: s.state_status === "blocked" };
}

const reportOf = (row: RunNodeRow) => stationReport(row.session as ReportNode["session"]);

/** The end a run takes when another task already owns its cause, and the step that found the owner. */
const OWNED_END = "dissolved_at_stamp";
export const OWNED_WORDS = "Another task already owns this cause; closed here";

/** Whether `stationId` is the step that found another task owns the cause
 *  (its own failure routes to OWNED_END), and the owner when the step or the
 *  end printed its ref. */
function ownedElsewhere(run: Pick<ReportRun, "node_statuses">, stationId: string): { ref: string | null } | null {
  const nodes = run.node_statuses ?? [];
  const end = nodes.find((n) => n.node_id === OWNED_END && n.status === "completed");
  if (!end || `dissolved_at_${stationId}` !== OWNED_END) return null;
  const own = nodes.find((n) => n.node_id === stationId);
  if (own?.status !== "failed") return null;
  const said = [own.result_preview, own.activity, end.result_preview, end.activity].filter(Boolean).join(" ");
  return { ref: said.match(/\bct-\d+\b/)?.[0] ?? null };
}

/** A run that went on past a card nobody answered and still ran its ship
 *  steps: nothing approved what they did. An approval carried from an
 *  earlier proposal let the build start; it never answers the card. */
export const shippedUnapproved = (run: Pick<ReportRun, "node_statuses">): boolean => passedUnansweredCard(run.node_statuses);

/** What a run that went on past an unanswered card did, in one sentence. */
export const UNAPPROVED_WORDS = "Not shipped: the run went on past a card nobody answered, so nothing was approved. The card has to be asked again.";

/** The station's own words: a question it asked, else its outcome's words, else its first sentence. */
function reportedWords(row: RunNodeRow, report: ReturnType<typeof reportOf>): string | null {
  if (!report) return null;
  if (report.asked) return report.line;
  return (report.outcome && (REPORTED[`${row.id}:${report.outcome}`] ?? REPORTED[report.outcome])) || report.line;
}

/** What happened to a station's session when it did not report a result the
 *  line routes on: it handed off blocked or needs_context, it never started
 *  (killed before its first message), it ran out of time, or it was killed.
 *  `step` is the station's own line; `stop` finishes "Stopped at <station>: ". */
export type StationEnd = { kind: "handoff" | "never_started" | "timed_out" | "killed"; step: string; stop: (station: string) => string };

const HANDOFF_WORDS: Record<string, { step: string; stop: string }> = {
  needs_context: { step: "Handed off needs_context: stopped to ask for context", stop: "stopped to ask for context (a needs_context handoff)" },
  blocked: { step: "Handed off blocked: stopped until a person unblocks it", stop: "stopped blocked (a blocked handoff)" },
};
const TIMED_OUT = /^hand \S+ killed after (\d+)\s*m(?:in)?(?: at (\S+))?/;

export function stationEnd(row: Pick<RunNodeRow, "id" | "session" | "status">, run: Pick<ReportRun, "fail_reason">): StationEnd | null {
  const s = row.session as ReportNode["session"];
  const handoff = s?.handoff && HANDOFF_WORDS[s.handoff.status];
  if (handoff) return { kind: "handoff", step: handoff.step, stop: (st) => `${st} ${handoff.stop}` };
  const timeout = run.fail_reason?.trim().match(TIMED_OUT);
  if (timeout && timeout[2] === row.id) return { kind: "timed_out", step: `Ran out of time after ${timeout[1]}m and was killed`, stop: (st) => `${st}'s session ran out of time` };
  // The runner retires a station that finished: a kill speaks only for one the run stopped at.
  if (row.status !== "failed") return null;
  if (s?.killed && !s.message_count) return { kind: "never_started", step: "Never started: queued, then killed before it began", stop: (st) => `${st} never started (it was queued, then killed)` };
  if (s?.killed && !s.state) return { kind: "killed", step: "Killed before it reported", stop: (st) => `${st}'s session was killed before it reported` };
  return null;
}

/** Script stations whose output is read into one sentence, never shown raw.
 *  Ship is not one: its last line is the project's own word on what landed. */
const READ_SCRIPTS = new Set(["park", "red", "dissolve", "verify", "green", "eval", "unscored", "reopen", "drop", "rebase", "watch", "card_draft", "card"]);

/** Plain words for what a script station's text said when it printed no JSON
 *  result: runs from before the stations printed one, and the CLI's own
 *  "nothing to run" when a project names no command. */
const SAID: ReadonlyArray<[station: string, said: RegExp, words: string]> = [
  ["verify", /no verify command configured|nothing to run/i, "No checks ran: the project names no check command"],
  ["green", /a line cause with no rerunnable check/i, "No check to rerun: the problem shows on recorded runs only"],
  ["eval", /no eval command/i, "No evals ran: the project names no eval command"],
  ["eval", /no surface's sources differ/i, "No evals ran: the change touches no eval surface"],
];

/** A script station's result in one sentence: its JSON `why`, else what its
 *  text said in plain words; undefined leaves the station's words for how it ended. */
function scriptSentence(row: RunNodeRow): string | undefined {
  const raw = runNodeLine(row)?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    const why = scriptLine(raw);
    return why && why !== raw ? sentence(why) : undefined;
  }
  return SAID.find(([id, re]) => id === row.id && re.test(raw))?.[2];
}

/** Sentence case, unless it opens on a file or a name that keeps its own case ("repro.sh fails"). */
const sentence = (text: string) => (/^[^\s]*[./_]/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1));

/** What each station does, for the Line tab's list of them; a run's path
 *  says what the station did (WORDS). */
const DOES: Record<string, string> = {
  ground: "Ties the cause to a goal and rates its risk",
  park: "Holds a cause that is not ready to build",
  plan: "Writes a plan for a large change",
  plan_gate: "You read the plan before anything is built, then decide",
  analyze: "Reads the cause and its signals",
  prove: "Writes a test that shows the problem",
  prove_line: "Names the recorded runs where the line itself did what the cause describes",
  red: "Runs the test before the change, to see it fail; for a change to the line, checks the named runs against the records",
  dissolve: "Closes the cause when the problem does not reproduce",
  implement: "Builds the change",
  implement_line: "Builds a change to the line itself",
  ask: "A person answers the builder's question, or drops the cause",
  reopen: "Sends the change back to build with the person's note",
  verify: "Runs the project's checks",
  green: "Runs the test with the change, to see it pass",
  eval: "Runs the evals before and after the change",
  unscored: "Stops when the evals cannot score the change",
  review: "Reviews the diff against the cause",
  card_draft: "Gathers the facts you decide on: the change, its proof and its cost",
  card_write: "Writes that summary in plain words",
  card: "Checks the summary is complete before it reaches you",
  [CARD_GATE_NODE_ID]: "You read the finished change and its proof, then decide: ship it, revise it or drop it",
  drop: "Closes the cause without a change",
  rebase: "Puts the branch on the default branch and checks it again",
  ship: "Lands the change the project's way",
  merge: "Merges the branch",
  watch: "Watches for the problem to come back",
};
export const stationWords = (id: string): string | null => DOES[id] ?? null;

/** The stations every cause passes through on its way to ship. The rest are
 *  branches (park, plan, dissolve, ask, reopen, unscored, drop) or routine steps
 *  (the card's assembly), which the Line tab folds under their phase. */
const MAIN_PATH = new Set(["ground", "analyze", "prove", "red", "implement", "verify", "green", "eval", "review", CARD_GATE_NODE_ID, "rebase", "ship", "merge", "watch"]);
export const isMainStation = (id: string) => MAIN_PATH.has(id);

/** Steps that only assemble the card: a run that passed them says so in the
 *  folded line, and the phase reads by its answer. */
const ROUTINE = new Set(["card_draft", "card_write", "card"]);
export const isRoutineStation = (id: string) => ROUTINE.has(id);

const REVIEW_WORDS: Record<string, string> = { approve: "Review approved", changes: "Review asked for changes", reject: "Review rejected the change" };

/** "[S] Ship :: Land the change" → "Ship". */
export { choiceWords };

/** The words of the option a gate was answered with: the decision's own
 *  option (enrichRun) for the run's last gate, else the run's key mirror. */
export function gateAnswer(run: Pick<ReportRun, "gate_answer" | "gate_choices" | "gate_node_id">, node: { node_id: string; outcome?: string }, response?: string): string | null {
  if (run.gate_answer && run.gate_node_id === node.node_id) return choiceWords(run.gate_answer);
  const key = (node.outcome ?? response ?? "").trim().toUpperCase();
  const hit = key ? run.gate_choices?.find((c) => c.key.toUpperCase() === key) : undefined;
  return hit ? choiceWords(hit.label) : null;
}

/** "noted": a step that did not do its part but did not stop the run either
 *  (the merge left to a person), drawn neutral rather than as a failure. */
export type StepState = "done" | "failed" | "live" | "waiting" | "noted";
/** Every step is named by its station; `note` says why when the result
 *  needs it (a merge left to a person); `href` is where the result leads:
 *  the session that did the step, or the task when a person finished it. */
export type ReportStep = { id: string; label: string; state: StepState; result: string; note?: string; href?: string; hrefTitle?: string; at?: number };

/** `answeredBy` names who answered the run's last gate ("Ashot Petrosian"). */
export type PathOpts = { answeredBy?: string | null };

/** A gate's answer, naming what an approval covered ("Ashot Petrosian approved building this fix"). */
function answeredWords(gateId: string, answer: string, who: string | null | undefined): string {
  const scope = approvalScope(gateId, answer);
  if (scope) return who ? `${who} ${scope[0].toLowerCase()}${scope.slice(1)}` : scope;
  return who ? `${who} answered ${answer}` : `Answered ${answer}`;
}

/** A landing station a run took past a card nobody answered. */
const UNAPPROVED_STEP = "Ran without an approval, so it is not a ship";

function stepOf(row: RunNodeRow, run: ReportRun, task?: ReportTask | null, opts: PathOpts = {}): ReportStep {
  const gate = GATES.has(row.id);
  // The merge step never fails a run (line.cast): a refused merge leaves the
  // change to a person, and the task's blocker comment says what is left.
  if (row.id === "merge" && row.status === "failed") {
    const landed = task?.status === "done";
    const ref = task?.short_id ?? run.task_short_id;
    const at = row.completed_at ?? row.started_at;
    return {
      id: row.id,
      label: stepLabel(row),
      state: "noted",
      result: landed ? `Landed by hand${at ? ` ${shortDay(at)}` : ""}` : "Left to a person to land",
      note: "the line could not merge it",
      ...(ref ? { href: `/tasks/${ref}`, hrefTitle: "The task's comments say why the merge was left and what is left to land" } : {}),
      at: row.completed_at ?? row.started_at,
    };
  }
  // A cause another task already owns: the step that found the owner did
  // its job, and the run closes here (AgentWatch's stamp, then its
  // dissolved_at_stamp end). Said once, on the step, with the owner when its output names it.
  // Ship steps a run took past an unanswered card did what nobody approved: noted, never "Merged".
  if ((row.id === "ship" || row.id === "merge" || row.id === "watch") && row.status === "completed" && shippedUnapproved(run)) {
    return { id: row.id, label: stepLabel(row), state: "noted", result: UNAPPROVED_STEP, note: "the card before it was never answered", at: row.completed_at ?? row.started_at };
  }
  const owned = ownedElsewhere(run, row.id);
  if (owned) return { id: row.id, label: stepLabel(row), state: "done", result: OWNED_WORDS, ...(owned.ref ? { href: `/line/trace/${owned.ref}`, hrefTitle: `Trace ${owned.ref}, the task that owns it` } : {}), at: row.completed_at ?? row.started_at };
  // A proposal's gate (AgentWatch) approved building the fix: said so, never as a bare "Done".
  if (!gate && row.status === "completed") {
    const scope = approvalScope(row.id, row.outcome);
    if (scope) return { id: row.id, label: stepLabel(row), state: "done", result: scope, at: row.completed_at ?? row.started_at };
  }
  const answer = gate ? gateAnswer(run, { node_id: row.id, outcome: row.outcome }, run.gate_node_id === row.id ? run.gate_response : undefined) : null;
  const closed = closedGate(run);
  // A run that has ended has no step under way: a step it left mid-way was cut
  // off, and the station it was cut off at was interrupted, not judged.
  const cutOff = !isLiveRun(run) && (row.status === "running" || (row.current && row.status === "pending") || (row.id === run.current_node_id && interrupted(run)));
  // A gate the runner closed with the answer's key is answered, not failed;
  // one whose question was taken back asked as designed and reads neutral.
  // A station that reported and was then failed only because the line had no
  // edge for its report did its job: the run's outcome says where it stopped.
  const report = gate || row.status === "running" ? null : reportOf(row);
  const strandedReport = !!report && !report.asked && row.status === "failed" && new RegExp(`^no outgoing edge from ${row.id}\\b`).test(run.fail_reason ?? "");
  const state: StepState = strandedReport ? "done"
    : gate && answer ? "done"
    : gate && (closed || cutOff) && run.gate_node_id === row.id ? "noted"
    : cutOff || (row.id === "ship" && row.status === "failed" && closed) ? "noted"
    : row.current && run.status === "paused" ? "waiting"
    : row.status === "running" || row.current ? "live"
    : row.status === "failed" ? "failed" : "done";
  const words = WORDS[row.id];
  // A line's script station reads as one sentence, never its raw output.
  const own = READ_SCRIPTS.has(row.id) && isLineRun(run.node_statuses) ? scriptSentence(row) : scriptLine(runNodeLine(row));
  // What happened to the station when it reported nothing the line routes on.
  const end = gate || row.status === "running" ? null : stationEnd(row, run);
  // The card's own decision names the gate it answered.
  const decision = gate && run.gate_node_id === row.id ? run.gate_decision_short_id : undefined;
  const result = gate
    ? (answer ? answeredWords(row.id, answer, decision ? opts.answeredBy : null) : state === "waiting" ? "Waiting for an answer" : closed && run.gate_node_id === row.id
      // A card taken back while the run went on: nobody approved what followed.
      ? row.id === CARD_GATE_NODE_ID && shippedUnapproved(run) ? `Card ${closed} with no answer; the run went on without an approval` : `Asked; the ${row.id === CARD_GATE_NODE_ID ? "card" : "question"} was ${closed}`
      : "Asked")
    : state === "noted" && cutOff ? "Interrupted before it finished"
    // A ship that never ran because the card was taken back is no failure of the ship.
    : row.id === "ship" && row.status === "failed" && closed ? `Skipped: the decision was ${closed}`
    : row.id === "review" && task?.review_verdict && state !== "live"
      ? REVIEW_WORDS[task.review_verdict.verdict] ?? "Reviewed"
      : (report?.asked ? report.line : null) ?? end?.step ?? reportedWords(row, report) ?? own ?? (state === "failed" ? words?.failed ?? "Failed" : state === "live" ? words?.live ?? "Running" : state === "waiting" ? "Waiting" : words?.done ?? "Done");
  const sid = row.session?._id ?? row.session?.session_id ?? row.session_id;
  return {
    id: row.id,
    label: stepLabel(row),
    state,
    result,
    ...(sid ? { href: `/conversation/${row.session?._id ?? sid}`, hrefTitle: row.session?.title ? `Open the session: ${row.session.title}` : "Open the session that did this" }
      : decision ? { href: `/decisions/${decision}`, hrefTitle: "Open the decision" } : {}),
    at: row.completed_at ?? row.started_at,
  };
}

export { scriptLine };

/** `steps` are what a reader reads; `routine` are steps that passed and only
 *  assembled something (the card), folded with `folded`, the stations not reached. */
export type ReportPhase = { key: LinePhaseKey | "steps"; label: string; steps: ReportStep[]; routine: ReportStep[]; folded: Array<{ id: string; label: string }>; state: StepState | "skipped" };

const isHidden = (r: RunNodeRow) => r.id === "start" || r.id === "exit" || r.type === "start" || r.type === "exit";
const reached = (r: RunNodeRow) => r.status !== "pending" || r.current;

/**
 * The path a run took (LE16): for a line run, the six phases with the
 * stations it reached, each with its one line result and the session that did
 * it; the stations it did not reach fold under each phase. Another workflow's
 * run is one group of its steps. `workflow` is the run's stored graph; a line
 * run without one reads the shipped line's.
 */
export function runPath(run: ReportRun, workflow?: { nodes?: Array<{ id: string; label?: string; type?: string }> } | null, task?: ReportTask | null, opts: PathOpts = {}): ReportPhase[] {
  const line = isLineRun(run.node_statuses);
  const rows = runNodeRows(run, workflow ?? (line ? SHIPPED_LINE : null)).filter((r) => !isHidden(r));
  if (!line) {
    const steps = foldLanding(rows.filter(reached).map((r) => stepOf(r, run, task, opts)), labelOf(run, "ship"));
    return [{ key: "steps", label: "Steps", steps, routine: [], folded: rows.filter((r) => !reached(r)).map((r) => ({ id: r.id, label: r.label })), state: phaseState(steps) }];
  }
  const byPhase = new Map<string, RunNodeRow[]>();
  for (const r of rows) {
    const key = phaseOfStation(r.id) ?? "build";
    byPhase.set(key, [...(byPhase.get(key) ?? []), r]);
  }
  return LINE_PHASES.map((p) => {
    const own = byPhase.get(p.key) ?? [];
    const all = foldLanding(own.filter(reached).sort((a, b) => (a.started_at ?? Infinity) - (b.started_at ?? Infinity)).map((r) => stepOf(r, run, task, opts)), labelOf(run, "ship"));
    const isRoutine = (s: ReportStep) => ROUTINE.has(s.id) && s.state === "done";
    const steps = all.filter((s) => !isRoutine(s));
    return { key: p.key, label: p.label, steps, routine: all.filter(isRoutine), folded: own.filter((r) => !reached(r)).map((r) => ({ id: r.id, label: r.label })), state: all.length ? phaseState(all) : "skipped" };
  });
}

/** The stations that put a built change in place: one fact, whether it landed. */
export const LANDING_STATIONS: ReadonlySet<string> = new Set(["rebase", "ship", "merge", "watch"]);
const lowerFirst = (t: string) => {
  const u = t.replace(/^Skipped: /, "");
  return /^[A-Z][a-z]/.test(u) ? `${u[0].toLowerCase()}${u.slice(1)}` : u;
};

/** The landing stations a run reached, read as one row that says plainly
 *  whether the change landed. A merge left to a person did not land; a ship
 *  past a card nobody answered did not land; a merge done by hand did. */
export function landingStep(steps: ReadonlyArray<ReportStep>, label: string): ReportStep {
  const by = (id: string) => steps.find((s) => s.id === id);
  const last = steps[steps.length - 1];
  const base = { id: "ship", label, at: last?.at };
  const link = (s?: ReportStep) => (s?.href ? { href: s.href, ...(s.hrefTitle ? { hrefTitle: s.hrefTitle } : {}) } : {});
  const unapproved = steps.find((s) => s.result === UNAPPROVED_STEP);
  if (unapproved) return { ...base, state: "noted", result: "Not landed: it ran without an approval, since nobody answered the card before it" };
  const failed = steps.find((s) => s.state === "failed");
  if (failed) return { ...base, state: "failed", result: `Not landed: ${lowerFirst(failed.result)}`, ...(failed.note ? { note: failed.note } : {}), ...link(failed) };
  const live = steps.find((s) => s.state === "live" || s.state === "waiting");
  if (live) return { ...base, state: live.state, result: live.state === "live" ? "Landing the change" : live.result, ...link(live) };
  const merge = by("merge");
  if (merge?.state === "noted" && merge.result.startsWith("Landed by hand")) return { ...base, state: "done", result: merge.result, ...(merge.note ? { note: merge.note } : {}), ...link(merge) };
  const noted = steps.find((s) => s.state === "noted");
  if (noted) return { ...base, state: "noted", result: `Not landed: ${lowerFirst(noted.result)}`, ...(noted.note ? { note: noted.note } : {}), ...link(noted) };
  return { ...base, state: "done", result: "Landed", ...(by("watch") ? { note: lowerFirst(WATCH_WORDS) } : {}), ...link(merge ?? by("ship")) };
}

/** `steps` with the landing stations folded into one row where the first of them stood. */
function foldLanding(steps: ReportStep[], label: string): ReportStep[] {
  const landing = steps.filter((s) => LANDING_STATIONS.has(s.id));
  if (!landing.length) return steps;
  const at = steps.indexOf(landing[0]);
  const rest = steps.filter((s) => !LANDING_STATIONS.has(s.id));
  return [...rest.slice(0, at), landingStep(landing, label), ...rest.slice(at)];
}

function phaseState(steps: ReportStep[]): StepState {
  steps = steps.filter((s) => s.state !== "noted");
  if (steps.length === 0) return "done";
  if (steps.some((s) => s.state === "waiting")) return "waiting";
  if (steps.some((s) => s.state === "live")) return "live";
  // A phase that recovered (checks failed, then passed) reads by its last word.
  const last = steps[steps.length - 1];
  return last?.state === "failed" ? "failed" : "done";
}

// ── the outcome, first ───────────────────────────────────────────────────────

/** "40m", "2h 5m", "3d 4h", "under a minute": how long a step took, two units at most. */
export function took(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** What an approval at a gate covered, in words ("Approved building this
 *  fix"), so an approval of a proposal never reads as approving a ship.
 *  Null for an answer that approved nothing. */
export function approvalScope(gateNodeId: string | null | undefined, answer: string | null | undefined): string | null {
  const word = (answer ?? "").replace(/^\[[^\]]*\]\s*/, "").trim().toLowerCase();
  if (!gateNodeId || !word) return null;
  if (gateNodeId === CARD_GATE_NODE_ID) return word === "ship" || word.startsWith("ship ") ? "Approved shipping this fix" : null;
  if (!/^(approve|yes|go|build)\b/.test(word)) return null;
  if (gateNodeId === "plan_gate") return "Approved the plan";
  if (/proposal/.test(gateNodeId)) return "Approved building this fix";
  return null;
}

/** A decision closed without an answer, in plain words for its page's
 *  banner: what happened to it first, then what that means for the work.
 *  A card whose run stopped waiting and went on says the fix is built and
 *  not shipped, and that it can be asked again. */
export function closedDecisionWords(status: "withdrawn" | "dismissed", run: Pick<ReportRun, "node_statuses"> | null | undefined): { headline: string; detail: string; askAgain: boolean } {
  if (run && shippedUnapproved(run)) {
    const gate = run.node_statuses?.find((x) => x.node_id === CARD_GATE_NODE_ID);
    const waited = gate?.started_at != null && gate.completed_at != null ? ` after ${took(gate.completed_at - gate.started_at)}` : "";
    return {
      headline: `Withdrawn: the run stopped waiting${waited}; it was never answered`,
      detail: "The run went on without an approval, so the fix is built but not shipped. Ask again to get a new card for it.",
      askAgain: true,
    };
  }
  return status === "dismissed"
    ? { headline: "Dismissed without an answer", detail: "Nobody needs to answer it now.", askAgain: false }
    : { headline: "Withdrawn before anyone answered it", detail: "Nobody needs to answer it now.", askAgain: false };
}

/** "Oct 12": the day a watch ends. */
export const shortDay = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A run whose card was answered Ship, before its ship step starts. */
export const APPROVED_WORDS = "Approved: waiting for the ship step to start.";

/** The watch after a ship, in a reader's words. */
export const WATCH_WORDS = "Watching for the problem to come back";

/** stuck: waiting past the point where waiting is normal (an approved run nobody drives). */
export type OutcomeTone = "shipped" | "closed" | "live" | "waiting" | "stuck" | "failed" | "calm";
export type RunOutcome = { tone: OutcomeTone; end: LineRunEnd | null; text: string };

const nodeOf = (run: ReportRun, id: string) => run.node_statuses?.find((n) => n.node_id === id);
const ran = (run: ReportRun, id: string) => nodeOf(run, id)?.status === "completed";
const labelOf = (run: ReportRun, id?: string) => (id ? stepLabel({ id, label: run.node_statuses?.find((n) => n.node_id === id)?.label ?? SHIPPED_LINE.nodes.find((n) => n.id === id)?.label ?? (id === run.current_node_id ? run.current_node_label : null) ?? id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) }) : "the start");

/** How a run ended, in any graph (shared with the server's cause history). */
export { runEnd };

/**
 * What the run did and what is true now, in one sentence (LE16). A shipped
 * run says the day it shipped and where its watch stands, read from the
 * cause: watching until a day, the watch ended quiet, or its signal came
 * back. `brief` is a row's version: what the run did, without the watch the
 * cause's own line already says.
 */
export function runOutcome(run: ReportRun, task?: ReportTask | null, now = Date.now(), brief = false): RunOutcome {
  const ended = runEnd(run);
  const end = ended?.kind ?? null;
  const at = labelOf(run, run.current_node_id);
  if (run.status === "pending") return { tone: "calm", end, text: "Queued to start." };
  if (run.status === "paused") {
    const gate = run.gate_node_id ?? run.current_node_id;
    return { tone: "waiting", end, text: gate === CARD_GATE_NODE_ID ? "Waiting for your decision." : gate === "plan_gate" ? "Waiting for an answer on the plan." : gate === "ask" ? "Waiting for an answer to the builder's question." : `Waiting for an answer at ${at}.` };
  }
  // Ship answered and the runner has not moved on: approved, waiting on the ship step, not working.
  if (run.status === "running" && run.current_node_id === CARD_GATE_NODE_ID && run.gate_answer && /^ship$/i.test(choiceWords(run.gate_answer))) return { tone: "waiting", end, text: APPROVED_WORDS };
  if (run.status === "running") return { tone: "live", end, text: `Working: at ${at}.` };
  // A Workflow tool run has no end of its own to name: its last agent is just the last to finish.
  if (run.run_kind === "workflow" && run.status === "completed") {
    const phases = run.phases?.length ?? 0;
    return { tone: "shipped", end, text: phases > 1 ? `Finished all ${phases} phases.` : "Finished." };
  }
  // A run whose question was taken back, or that was stopped by hand, finished as asked: grey, not red.
  // A run that merged and started its watch shipped, whatever its runner did after.
  if (shippedUnapproved(run)) return { tone: "failed", end, text: UNAPPROVED_WORDS };
  if (run.status === "failed" && end !== "shipped") return { tone: closedGate(run) || interrupted(run) ? "closed" : "failed", end, text: stopWords(run, at) };
  if (end === "shipped") {
    const watch = task?.watch_until ?? null;
    // A merge the line could not do, on a cause that is done, landed by hand.
    const byHand = nodeOf(run, "merge")?.status === "failed" && task?.status === "done";
    // A row leads with its own day, so its sentence leaves the day out.
    const shipped = brief ? (byHand ? "Shipped by hand" : "Shipped") : byHand ? `Shipped by hand ${shortDay(ended!.at)} after the line could not merge it` : `Shipped ${shortDay(ended!.at)}`;
    // LM3: a watch that reopens moves the cause to open; any other status
    // after a ship is a later run's or a person's, and this run still shipped.
    // A graph that keeps its cause open through the watch (AgentWatch) is still watching, not reopened.
    if (task && (task.status === "open" || task.status === "backlog") && !(watch && watch > now)) return { tone: "failed", end, text: brief ? `${shipped}, then reopened.` : `${shipped}, then reopened: its signal came back during the watch.` };
    if (brief) return { tone: "shipped", end, text: `${shipped}.` };
    if (watch && watch > now) return { tone: "shipped", end, text: `${shipped}. ${WATCH_WORDS} until ${shortDay(watch)}.` };
    return { tone: "shipped", end, text: task?.resolved_at ? `${shipped}. The watch ended quiet.` : `${shipped}.` };
  }
  if (end === "dropped") return { tone: "closed", end, text: nodeOf(run, CARD_GATE_NODE_ID) ? "Dropped at your decision." : "Dropped at the plan." };
  if (end === "dissolved") return { tone: "closed", end, text: "Closed without a change: the problem did not reproduce." };
  if (end === "parked") return { tone: "calm", end, text: `Parked: the cause is not ready to build.${task?.readiness_note ? ` ${task.readiness_note.trim().replace(/\.?$/, ".")}` : ""}` };
  if (ran(run, "unscored")) return { tone: "failed", end, text: "Stopped: the evals could not score the change." };
  // A card taken back without an answer ends the run as asked, not as a failure.
  const closed = closedGate(run);
  if (closed && run.gate_node_id === CARD_GATE_NODE_ID) return { tone: "closed", end, text: `Stopped: the decision was ${closed}.` };
  if (nodeOf(run, "ship")?.status === "failed") return { tone: "failed", end, text: "Not shipped: the ship step failed." };
  if (task?.review_verdict?.verdict === "reject" && ran(run, "review")) return { tone: "closed", end, text: "Review rejected the change." };
  // Another graph's own end step (AgentWatch's failed_at_build,
  // dissolved_at_prove, refine_rejected) says where and how the run ended.
  const reached = (run.node_statuses ?? []).filter((n) => n.node_id !== "exit" && n.node_id !== "start" && n.status === "completed");
  const id = run.current_node_id && run.current_node_id !== "exit" ? run.current_node_id : reached[reached.length - 1]?.node_id ?? "";
  const escalatedAt = /^escalated_at_(\w+)$/.exec(id)?.[1];
  if (escalatedAt) return { tone: "waiting", end, text: `Handed to a person at ${labelOf(run, escalatedAt)}.` };
  const failedAt = /^failed_at_(\w+)$/.exec(id)?.[1];
  if (failedAt) return { tone: "failed", end, text: `Stopped: ${labelOf(run, failedAt)} failed.` };
  if (id === OWNED_END) return { tone: "closed", end, text: `${OWNED_WORDS}.` };
  const closedAt = /^(?:dissolved|released)_at_(\w+)$/.exec(id)?.[1];
  if (closedAt) return { tone: "closed", end, text: `Closed without a change at ${labelOf(run, closedAt)}.` };
  if (id) return { tone: "calm", end, text: `Ended at ${labelOf(run, id)}.` };
  return { tone: "calm", end, text: "Finished." };
}

const TIMES = ["", "once", "twice", "three times", "four times", "five times"];

/** The station a run stopped for looping, and how many times it ran: the
 *  engine's "max_visits=3 exceeded on implement". Null for any other stop. */
export function loopedStation(run: Pick<ReportRun, "fail_reason">): { node: string; times: number } | null {
  const m = run.fail_reason?.trim().match(/^max_visits=(\d+) exceeded on (\S+)/);
  return m ? { node: m[2], times: Number(m[1]) } : null;
}

/** Why a run stopped, in words: the engine's reasons ("no outgoing edge from
 *  prove (…)", "max_visits=2 exceeded on prove", "hand jx79xc0 killed after
 *  30m at prove") read as what happened, with the station's own name. */
export function stopWords(run: ReportRun, at = labelOf(run, run.current_node_id)): string {
  const why = run.fail_reason?.trim().replace(/\.$/, "") ?? "";
  let m: RegExpMatchArray | null;
  if (!why) return `Stopped at ${at}.`;
  if (/^stopped\b/i.test(why)) return `${why}.`;
  if ((m = why.match(/^no outgoing edge from (\S+)(?:.*?\boutcome (\w+))?/))) {
    const st = labelOf(run, m[1]);
    // The engine's words name the missing edge; a reader needs what the station
    // did or what happened to it: a handoff, a start that never came, a kill.
    const node = nodeOf(run, m[1]);
    const end = node ? stationEnd({ id: m[1], status: node.status as RunNodeRow["status"], session: node.session as RunNodeRow["session"] }, run) : null;
    if (end) return `Stopped at ${st}: ${end.stop(st)}${end.kind === "handoff" ? ", and the line had no route for that" : ""}.`;
    // The run's end marks its last node failed, so the station's own outcome
    // decides; a report with no outcome reads by the node.
    const failed = m[2] ? /^fail/.test(m[2]) : node?.status === "failed";
    return failed
      ? `Stopped at ${st}: ${st} failed outright, and the line has no route for that yet.`
      : `Stopped at ${st}: ${st} finished, and the line has no route for that result yet.`;
  }
  const looped = loopedStation(run);
  if (looped) return `Stopped: ${labelOf(run, looped.node)} looped ${TIMES[looped.times] ?? `${looped.times} times`}.`;
  if ((m = why.match(TIMED_OUT))) return `Stopped: ${labelOf(run, m[2] ?? run.current_node_id)}'s session ran out of time.`;
  if ((m = why.match(/^gate (dismissed|withdrawn)$/))) return run.gate_node_id === CARD_GATE_NODE_ID || run.current_node_id === CARD_GATE_NODE_ID ? `Stopped: the decision was ${m[1]}.` : `Stopped: the question was ${m[1]}.`;
  if ((m = why.match(/^(\S+) is waiting on a person$/))) return `Stopped at ${labelOf(run, m[1])}: it asked a question and waits on a person's answer.`;
  if ((m = why.match(RUNNER_STOP))) return m[1] === "SIGINT" ? `Stopped by hand during ${labelOf(run, m[2] ?? run.current_node_id)}.` : `Stopped: the runner was shut down during ${labelOf(run, m[2] ?? run.current_node_id)}.`;
  return `Stopped at ${at}: ${why}.`;
}

// ── the runs on a cause ──────────────────────────────────────────────────────

export type CauseRunEntry = { run: ReportRun; superseded: boolean };

/**
 * The runs on a cause, newest first, each its own row: a run that stopped and
 * was followed by a later one is superseded (drawn muted, red kept for the
 * cause's state now), and says where it stopped and why. `newest` is the
 * cause's newest run time when `runs` leaves the newest out.
 */
export function causeRunEntries(runs: ReadonlyArray<ReportRun>, newest = runs[0]?.created_at ?? 0): CauseRunEntry[] {
  return runs.map((r) => ({ run: r, superseded: r.status === "failed" && r.created_at < newest }));
}

// ── versions: what each graph delivered (LE14) ───────────────────────────────

export type LineVersion = { hash: string; first: number; last: number; runs: number; shipped: number; revised: number; dropped: number; stopped: number; reopened: number; costUsd: number | null; live: number; nodes: ReportRun["graph_nodes"] | null; change: string };

const stationName = (id: string) => stepLabel({ id, label: SHIPPED_LINE.nodes.find((n) => n.id === id)?.label });
const names = (ids: string[]) => (ids.length > 2 ? `${ids.length} stations` : ids.map(stationName).join(" and "));

/** What one version changed from the one before it, in words: "Prove
 *  edited", "Eval added, Unscored removed". Read from each station's hash. */
export function versionChange(nodes: ReportRun["graph_nodes"] | null, prev: ReportRun["graph_nodes"] | null | undefined): string {
  if (prev === undefined) return "First recorded version";
  if (!nodes?.length || !prev?.length) return "Edited; which stations was not recorded yet";
  const was = new Map(prev.map((n) => [n.id, n.h]));
  const now = new Map(nodes.map((n) => [n.id, n.h]));
  const edited = nodes.filter((n) => was.has(n.id) && was.get(n.id) !== n.h).map((n) => n.id);
  const added = nodes.filter((n) => !was.has(n.id)).map((n) => n.id);
  const removed = prev.filter((n) => !now.has(n.id)).map((n) => n.id);
  const parts = [edited.length ? `${names(edited)} edited` : "", added.length ? `${names(added)} added` : "", removed.length ? `${names(removed)} removed` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Line settings edited";
}

/**
 * One row per graph the project's line ran, newest first: its runs, how many
 * shipped, were sent back to revise, were dropped, stopped before an answer,
 * and whose cause reopened in watch after it shipped, what its cards say it
 * cost, and what it changed from the version before. A run that recorded no
 * hash (before LE14) groups as "unrecorded".
 */
export function lineVersions(runs: ReadonlyArray<ReportRun>, reopenedAt: (taskId: string) => number[]): LineVersion[] {
  const out = new Map<string, LineVersion>();
  for (const r of runs) {
    if (!isLineRun(r.node_statuses)) continue;
    const hash = r.graph_hash || "unrecorded";
    const v = out.get(hash) ?? { hash, first: r.created_at, last: r.created_at, runs: 0, shipped: 0, revised: 0, dropped: 0, stopped: 0, reopened: 0, costUsd: null, live: 0, nodes: null, change: "" };
    v.runs++;
    v.first = Math.min(v.first, r.created_at);
    v.last = Math.max(v.last, r.created_at);
    if (!v.nodes && r.graph_nodes?.length) v.nodes = r.graph_nodes;
    const end = runEnd(r);
    if (end?.kind === "shipped") {
      v.shipped++;
      if (r.task_id && reopenedAt(r.task_id).some((t) => t > end.at)) v.reopened++;
    }
    if (end?.kind === "dropped") v.dropped++;
    if (ran(r, "reopen")) v.revised++;
    if (r.status === "failed" && end?.kind !== "shipped" && end?.kind !== "dropped") v.stopped++;
    if (r.status === "running" || r.status === "paused" || r.status === "pending") v.live++;
    if (typeof r.card_cost_usd === "number") v.costUsd = (v.costUsd ?? 0) + r.card_cost_usd;
    out.set(hash, v);
  }
  // Each recorded version against the one that ran before it.
  const recorded = [...out.values()].filter((v) => v.hash !== "unrecorded").sort((a, b) => a.first - b.first);
  recorded.forEach((v, i) => { v.change = versionChange(v.nodes, i === 0 ? undefined : recorded[i - 1].nodes); });
  const unrecorded = out.get("unrecorded");
  if (unrecorded) unrecorded.change = "Runs from before versions were recorded";
  return [...out.values()].sort((a, b) => b.last - a.last);
}

/** lineVersions over one project's scoped rows: a shipped cause counts as
 *  reopened when a signal marked reopened reached it after the ship. */
export function projectLineVersions(rows: { runs: ReadonlyArray<unknown>; signals: ReadonlyArray<{ task_id?: string | null; reopened?: boolean | null; created_at: number }> }): LineVersion[] {
  const by = new Map<string, number[]>();
  for (const s of rows.signals) if (s.reopened && s.task_id) by.set(s.task_id, [...(by.get(s.task_id) ?? []), s.created_at]);
  return lineVersions(rows.runs as ReadonlyArray<ReportRun>, (taskId) => by.get(taskId) ?? []);
}

/** One version in a station's own history (line-map.md LX3): when the station first ran as it is, and what that version delivered. */
export type StationVersion = { hash: string; first: number; last: number; runs: number; shipped: number; stopped: number; change: "first" | "edited" | "added" | "removed" };

/**
 * The versions of the line in which one station changed, newest first: the
 * first recorded version, then each version whose hash for this station
 * differs from the version that ran before it. Versions that changed only
 * other stations are left out; a station's row reads as "this text ran from
 * here on". Versions with no per-station hashes cannot say, and are skipped.
 */
export function stationHistory(versions: ReadonlyArray<LineVersion>, stationId: string): StationVersion[] {
  const recorded = versions.filter((v) => v.hash !== "unrecorded" && v.nodes?.length).sort((a, b) => a.first - b.first);
  const out: StationVersion[] = [];
  let prev: string | null | undefined;
  for (const v of recorded) {
    const h = v.nodes!.find((n) => n.id === stationId)?.h ?? null;
    const change = prev === undefined ? (h ? "first" : null) : h === prev ? null : !h ? "removed" : !prev ? "added" : "edited";
    if (change) out.push({ hash: v.hash, first: v.first, last: v.last, runs: v.runs, shipped: v.shipped, stopped: v.stopped, change });
    else if (out.length && h) {
      // The same text ran on in a version that changed another station: its runs count here too.
      const cur = out[out.length - 1];
      cur.last = Math.max(cur.last, v.last);
      cur.runs += v.runs;
      cur.shipped += v.shipped;
      cur.stopped += v.stopped;
    }
    prev = h;
  }
  return out.reverse();
}

// ── where a cause is (LM3) ───────────────────────────────────────────────────

/**
 * Where a cause is, in one sentence (the-line-model.md LM3's "also shown"):
 * the newest run speaks while it runs; otherwise the task status the line
 * wrote, with the watch day after a ship and "reopened" when a signal came
 * back during the watch.
 */
export function causeWhere(task: ReportTask, latest: ReportRun | null, reopened: boolean, now = Date.now()): RunOutcome {
  const live = latest && isLiveRun(latest);
  if (live) return runOutcome(latest, task, now);
  if (task.status === "dropped") return { tone: "closed", end: "dropped", text: "Dropped." };
  if (task.status === "done" && task.watch_until && task.watch_until > now) {
    const at = latest ? runEnd(latest) : null;
    if (latest && at?.kind === "shipped") return runOutcome(latest, task, now);
    return { tone: "shipped", end: "shipped", text: `Shipped. ${WATCH_WORDS} until ${shortDay(task.watch_until)}.` };
  }
  // A run that shipped is told by its ship, whatever the task's status says: never "waiting" after a merge.
  const shipped = latest ? runEnd(latest) : null;
  if (latest && shipped?.kind === "shipped") {
    return reopened ? { tone: "failed", end: "shipped", text: `Shipped ${shortDay(shipped.at)}, then reopened: its signal came back during the watch.` } : runOutcome(latest, task, now);
  }
  if ((task.status === "open" || task.status === "backlog") && reopened) return { tone: "failed", end: null, text: "Reopened: its signal came back during the watch." };
  if (latest) {
    const said = runOutcome(latest, task, now);
    // A run that went on past its unanswered card built a change nobody approved: that, not the queue, is where the cause is.
    if (shippedUnapproved(latest)) return said;
    if (task.status === "open" || task.status === "backlog") return said.end === "parked" ? said : { tone: "calm", end: null, text: "Waiting to be admitted." };
    return said;
  }
  if (task.status === "done") return { tone: "shipped", end: null, text: "Done." };
  if (task.status === "open" || task.status === "backlog") return { tone: "calm", end: null, text: "Waiting to be admitted." };
  return { tone: "calm", end: null, text: task.status === "in_review" ? "In review." : "In progress." };
}

// ── the card, by what it decided ─────────────────────────────────────────────

/** A card named by what it decided, never by its key: "Ship: the insight
 *  prompt now lists only steps the session shows finishing", or what it still
 *  waits on. The name is the card's own headline, else the first sentence of
 *  its change; without a card the answer stands alone. */
export function cardName(answer: string | null | undefined, card: { headline?: string | null; change?: string | null } | null | undefined, waiting: boolean): string {
  const title = (card?.headline?.trim() || card?.change?.trim().split(/(?<=[.!?])\s/)[0] || "").replace(/[.!?]$/, "");
  if (answer) return title ? `${answer}: ${title}` : `Answered ${answer}`;
  if (waiting) return title ? `Waiting for an answer: ${title}` : "Waiting for an answer";
  return title || "The decision";
}
