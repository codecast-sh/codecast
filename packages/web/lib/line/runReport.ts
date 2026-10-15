// One run as a report (docs/architecture/the-line-end-to-end.md LE16, the
// line model LM7): what the run did and what is true now, the path it took in
// the line's phases with each station's result in one line, and, across runs,
// what each version of the line delivered (LE14, keyed by graph_hash). The run
// page, the task page's Line block, the /line rows and the project's Line tab
// all read it, so a run is told the same way everywhere. Pure: no store, no
// React.
import { CARD_GATE_NODE_ID, isLineRun, passedUnansweredCard, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { threadStateHeadline, threadStateResult } from "@codecast/shared/contracts";
import { choiceWords, closedAtStep, isLiveRun, runEnd } from "@codecast/shared/contracts/causeHistory";
import { LINE_PHASES, phaseOfStation, type LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import { runNodeLine, runNodeRows, scriptLine, type RunNodeRow } from "../workflowRun";
import { SHIPPED_LINE } from "./shippedLine.generated";

// ── the shape a report reads ─────────────────────────────────────────────────

export type ReportNode = { node_id: string; status: string; outcome?: string; label?: string; session_id?: string; session?: { _id: string; title?: string; state?: string; state_status?: string; result?: string; message_count?: number; killed?: boolean; is_active?: boolean; updated_at?: number; handoff?: { status: string; note?: string } } | null; started_at?: number; completed_at?: number; result_preview?: string; activity?: string };

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
  card_billed_usd?: number;
  card_list_usd?: number;
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
  stamp: "Record the problem",
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
export const stepLabel = (n: { id: string; label?: string | null }): string => PLAIN_NAMES[n.id] || n.label?.trim() || idWords(n.id);

/** A step id no graph labels, read as words: "refine_rejected" reads "Refine rejected". */
export const idWords = (id: string): string => { const w = id.replace(/_/g, " ").trim(); return w ? w[0].toUpperCase() + w.slice(1) : id; };

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

/** The stations that ask a person (the plan gate, a builder's question, the card gate). */
const GATES = new Set(["plan_gate", "ask", CARD_GATE_NODE_ID]);

export { isLiveRun };
/** The run's last gate was taken back or dismissed without an answer: "withdrawn" or "dismissed", else null. */
export const closedGate = (run: Pick<ReportRun, "gate_decision_status" | "gate_answer">): "withdrawn" | "dismissed" | null =>
  !run.gate_answer && (run.gate_decision_status === "withdrawn" || run.gate_decision_status === "dismissed") ? run.gate_decision_status : null;
/** The runner itself was stopped (a signal), so the station it was at never gave its verdict. */
const RUNNER_STOP = /\brunner was stopped \((SIG[A-Z]+)\)(?: at (\S+))?/;
const interrupted = (run: Pick<ReportRun, "status" | "fail_reason">) => run.status === "failed" && RUNNER_STOP.test(run.fail_reason ?? "");

// ── a station's result, in one line ──────────────────────────────────────────

/** Words the line puts on a station that said nothing of its own ("Could not write a test for the problem"): a label for the step, never a claim about what one run did. */
export const stationCatalogWords = (stepId: string, words: string | null | undefined): boolean => {
  const w = WORDS[stepId];
  return !!w && !!words && (words === w.done || words === w.failed || words === w.live);
};

const WORDS: Record<string, { done: string; failed?: string; live?: string }> = {
  ground: { done: "Tied the problem to a goal and rated it", live: "Grounding the problem" },
  park: { done: "Parked: not ready to build" },
  plan: { done: "Wrote the plan", live: "Writing the plan" },
  analyze: { done: "Read the problem and its reports", live: "Reading the problem" },
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
  drop: { done: "Closed the problem" },
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
  "investigate:mechanism": "Found why it happens",
  "investigate:failed": "Could not find why it happens",
  "investigate:judge_defect": "The judge was wrong, not the agent",
  "refine:refined": "Rebuilt the problem around why it happens",
  "refine:wrong_cause": "The explanation did not fit the problem",
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
export const OWNED_WORDS = "Another task already owns this problem; closed here";

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
export const shippedUnapproved = (run: Pick<ReportRun, "node_statuses" | "gate_node_id" | "gate_decision_status" | "gate_answer">): boolean => passedUnansweredCard(run.node_statuses, run);

/** How long the card waited before it timed out with no answer, on a run that went on past it; null otherwise. */
export function cardTimeoutMs(run: Pick<ReportRun, "node_statuses">): number | null {
  if (!shippedUnapproved(run)) return null;
  const gate = run.node_statuses?.find((x) => x.node_id === CARD_GATE_NODE_ID);
  return gate?.started_at != null && gate.completed_at != null ? Math.max(0, gate.completed_at - gate.started_at) : null;
}

/** Why a run past an unanswered card did not ship, in a few words, in the decision's own word: "decision withdrawn unanswered after 3h 12m". */
export function cardTimeoutWords(run: Pick<ReportRun, "node_statuses">): string | null {
  if (!shippedUnapproved(run)) return null;
  const ms = cardTimeoutMs(run);
  return ms != null ? `decision withdrawn unanswered after ${took(ms)}` : "decision withdrawn unanswered";
}

/** The default branch a landing step said the fix's branch is behind ("line: codecast/line-ct-58259 is behind
 *  origin/main; rebase it first" reads "main"), or null when it refused for no such reason. */
export function behindBase(text: string | null | undefined): string | null {
  return /\S+ is behind (?:origin\/)?(\S+?)[;,.\s]/.exec(`${text ?? ""} `)?.[1] ?? null;
}

/** What a landing step did, from its own output, the one wording every place reads (a run's Ship row, a decision's
 *  "Then"): "Ship refused, branch behind main", "Ship ran, not merged (merge step off)". Null when it printed nothing
 *  it can be read by: it may never have run. */
export function landWords(n: { node_id: string; status: string; result_preview?: string | null }): string | null {
  const t = n.result_preview ?? "";
  const step = n.node_id === "merge" ? "Merge" : "Ship";
  const behind = behindBase(t);
  if (behind) return `${step} refused, branch behind ${behind}`;
  if (mergeOffIn(t)) return `${step} ran, not merged (merge step off)`;
  if (/\bmerged\b[^\n]*\b(?:at|into)\b/i.test(t) && !/not merged/i.test(t)) return `${step} ran and merged`;
  return null;
}

/** Whether a landing step printed that it merged nothing because the line's merge step is off. */
export const mergeOffIn = (text: string | null | undefined): boolean => /not merged:\s*merge is off/i.test(text ?? "");
/** A ship that ran and merged nothing, the line's merge step off: the fix waits on its branch for a person to merge it. */
export const NOT_MERGED_OFF = "Not merged: merge off";
/** A landing row's words for a change that did not land (not shipped, not landed, not merged): never a pass. */
export const NOT_LANDED = /^Not (?:shipped|landed|merged)\b/;

/** What a landing step did after a decision nobody answered. Nothing approved it, so the words say it ran with no yes
 *  before what it did (ct-59561 Run 5: the card was withdrawn, and Ship ran 20s later and refused). Runners before
 *  the unanswered-gate fix took the gate's Ship edge on a failed gate. */
export function landWithoutYesWords(n: { node_id: string; status: string; result_preview?: string | null }): string {
  const step = n.node_id === "merge" ? "Merge" : "Ship";
  const t = n.result_preview ?? "";
  const behind = behindBase(t);
  const did = behind ? `, refused: branch behind ${behind}`
    : mergeOffIn(t) ? ", nothing merged (merge step off)"
    : landWords(n) ? " and merged"
    : n.status === "failed" ? " and failed" : ", nothing merged";
  return `${step} ran with no yes${did}`;
}

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
export type StationEnd = { kind: "handoff" | "never_started" | "timed_out" | "killed" | "went_quiet"; step: string; stop: (station: string) => string };

const HANDOFF_WORDS: Record<string, { step: string; stop: string }> = {
  needs_context: { step: "Handed off needs_context: stopped to ask for context", stop: "stopped to ask for context (a needs_context handoff)" },
  blocked: { step: "Handed off blocked: stopped until a person unblocks it", stop: "stopped blocked (a blocked handoff)" },
};
const TIMED_OUT = /^hand \S+ killed after (\d+)\s*m(?:in)?(?: at (\S+))?/;

/** The line's stations that run as an agent's session: one with no session and no hand behind it never started. */
const AGENT_STATIONS = new Set(SHIPPED_LINE.nodes.filter((n) => n.backend === "session").map((n) => n.id));
/** One name for a station that never got going, whichever way it shows (no session opened, or one that never ran a turn). */
export const NEVER_STARTED_CAUSE = "Its session never started";
/** A station's own words when it never got going (stationEnd's never_started), as its visit records them. */
export const neverStartedWords = (words: string | null | undefined): boolean => !!words && /^Never started: (?:no session was opened|its session never ran a turn|queued, then killed)/.test(words);

/** A station that stopped on a spend cap (it pinned blocked because its replays were refused for budget): who owns the
 *  money and how full it is, and when it reruns, read from its own words. Null for any other stop. */
export type SpendCap = { wallet: string | null; spent: string | null; cap: string | null; window: string | null; rerunAt: number | null };
export function spendCap(text: string | null | undefined, at: number | null = null): SpendCap | null {
  const t = text ?? "";
  if (!/\b(?:budget|spend(?:ing)? cap|wallet)\b/i.test(t) || !/\b(?:refused|red|cap|exhausted|exceeded|over)\b/i.test(t)) return null;
  const wallet = t.match(/[`"']?([\w-]+)[`"']?\s+budget wallet/i)?.[1] ?? null;
  const money = t.match(/(\$[\d,.]+)\s+of\s+(?:its\s+)?(\$[\d,.]+)(?:\s+(\d+\s*[hd]))?/i);
  // "fires at about 20:30 UTC": the next such clock time after the stop.
  const clock = t.match(/\b(\d{1,2}):(\d{2})\s*UTC\b/i);
  let rerunAt: number | null = null;
  if (clock && at) {
    const d = new Date(at);
    d.setUTCHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() < at) d.setUTCDate(d.getUTCDate() + 1);
    rerunAt = d.getTime();
  }
  return { wallet, spent: money?.[1] ?? null, cap: money?.[2] ?? null, window: money?.[3]?.replace(/\s+/g, "") ?? null, rerunAt };
}

const localClock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** A spend cap in a line: whose budget and how full, then when it runs again as a clock time (never a trigger's id). */
export function spendCapWords(c: SpendCap, clock: (t: number) => string = localClock): string {
  const spend = `${c.wallet ? `${c.wallet} spend` : "Spend"}${c.spent && c.cap ? ` at ${c.spent} of its ${c.cap}${c.window ? ` ${c.window}` : ""} limit` : " used up"}`;
  return `${spend}${c.rerunAt ? `; runs again about ${clock(c.rerunAt)}` : ""}`;
}

/** An edge the runner takes only when its station failed ("outcome = failure"): a station that went on along any other
 *  edge handed on. */
const FAILURE_ROUTE = /\boutcome\s*=\s*failure\b/;
const SUCCESS_NEXT = new Map<string, string[]>();
for (const e of SHIPPED_LINE.edges as ReadonlyArray<{ from: string; to: string; condition?: string }>) {
  if (!FAILURE_ROUTE.test(e.condition ?? "")) SUCCESS_NEXT.set(e.from, [...(SUCCESS_NEXT.get(e.from) ?? []), e.to]);
}
type SettleableRun = { status?: string; fail_reason?: string; current_node_id?: string; node_statuses?: ReadonlyArray<{ node_id: string; status: string; started_at?: number; session?: unknown; session_id?: string }> };
const settled = new WeakMap<object, unknown>();
/** A run as it went, whatever a stale report wrote over it. A station whose next station on its success path started
 *  after it started handed on: the run went on from it, so it passed, even when a report that came later marks it
 *  failed (a second runner of the same run timing out its own empty hand, ct-57972). Its empty session is that other
 *  runner's, so it goes, and so does a `fail_reason` that names it. The run's status stays: nothing in the row says a
 *  runner is still on it, so a failed run failed at the furthest station it reached (one left running reads as
 *  interrupted). Memoized per row, so readers keyed by the row stay stable. */
export function settledRun<R extends SettleableRun>(run: R): R {
  const hit = settled.get(run);
  if (hit) return hit as R;
  const nodes = run.node_statuses ?? [];
  const startOf = new Map(nodes.map((n) => [n.node_id, n.started_at]));
  // A person's step that was answered records failed with its answer as the outcome: read by its answer, never here.
  const handedOn = new Set(nodes.filter((n) => n.status === "failed" && n.started_at != null && !GATES.has(n.node_id)
    && (SUCCESS_NEXT.get(n.node_id) ?? []).some((to) => (startOf.get(to) ?? -Infinity) > n.started_at!)).map((n) => n.node_id));
  let out = run;
  if (handedOn.size) {
    const stale = [...handedOn].some((id) => new RegExp(`\\bat ${id}\\b`).test(run.fail_reason ?? ""));
    const furthest = [...nodes].filter((n) => n.started_at != null && n.node_id !== "exit").sort((a, b) => b.started_at! - a.started_at!)[0]?.node_id;
    out = {
      ...run,
      node_statuses: nodes.map((n) => {
        if (!handedOn.has(n.node_id)) return n;
        const s = n.session as { message_count?: number } | null | undefined;
        const empty = !s || !s.message_count;
        return { ...n, status: "completed", ...(empty ? { session: null, session_id: undefined } : {}) };
      }),
      ...(stale ? { fail_reason: undefined } : {}),
      // The run stands at the furthest station it reached, never at the one it went on from.
      ...(run.current_node_id && handedOn.has(run.current_node_id) && furthest ? { current_node_id: furthest } : {}),
    };
  }
  settled.set(run, out);
  return out;
}

/** The spend cap a run stopped on at a step, read from that station's own pin, with the time it stopped. */
export function runSpendCap(run: Pick<ReportRun, "node_statuses" | "updated_at">, stepId: string | null | undefined): SpendCap | null {
  const node = stepId ? run.node_statuses?.find((n) => n.node_id === stepId) : undefined;
  return node ? spendCap(node.result_preview ?? node.session?.state, node.completed_at ?? run.updated_at ?? null) : null;
}

/** A step's result when the run ended while it was under way: it never finished, so it neither passed nor decided. */
export const INTERRUPTED_WORDS = "Interrupted before it finished";

/** The handoff a station's words name ("Handed off blocked: …"), when its session ended by handing the problem back. */
export const handoffOfWords = (words: string | null | undefined): string | null =>
  Object.entries(HANDOFF_WORDS).find(([, w]) => w.step === words)?.[0] ?? null;

export function stationEnd(row: Pick<RunNodeRow, "id" | "session" | "status"> & Partial<Pick<RunNodeRow, "session_id" | "completed_at">>, run: Pick<ReportRun, "fail_reason">): StationEnd | null {
  const s = row.session as ReportNode["session"];
  const handoff = s?.handoff && HANDOFF_WORDS[s.handoff.status];
  if (handoff) return { kind: "handoff", step: handoff.step, stop: (st) => `${st} ${handoff.stop}` };
  const timeout = run.fail_reason?.trim().match(TIMED_OUT);
  // A session that holds no message at its limit never ran a turn: it never started, it did not run long.
  if (timeout && timeout[2] === row.id && s?.message_count === 0) return { kind: "never_started", step: `Never ran a turn: its session sat empty until the ${timeout[1]}m limit`, stop: (st) => `${st}'s session never ran a turn` };
  if (timeout && timeout[2] === row.id) return { kind: "timed_out", step: `Ran out of time after ${timeout[1]}m and was killed`, stop: (st) => `${st}'s session ran out of time` };
  // The runner retires a station that finished: a kill speaks only for one the run stopped at.
  if (row.status !== "failed") return null;
  if (s?.killed && !s.message_count) return { kind: "never_started", step: "Never started: queued, then killed before it began", stop: (st) => `${st} never started (it was queued, then killed)` };
  if (s?.killed && !s.state) return { kind: "killed", step: "Killed before it reported", stop: (st) => `${st}'s session was killed before it reported` };
  // An agent's station with no session and no hand's id: the runner never opened one. (A wide feed can hand back a bare
  // node whose session it did not attach; its hand's id still says one ran.)
  if (!s && !row.session_id && AGENT_STATIONS.has(row.id)) return { kind: "never_started", step: "Never started: no session was opened", stop: (st) => `${st} never started: no session was opened for it` };
  if (s && s.message_count === 0 && !s.state) return { kind: "never_started", step: "Never started: its session never ran a turn", stop: (st) => `${st}'s session never ran a turn` };
  // A session that ran, then went quiet with nothing pinned and no report: the engine took the end of its turn for the
  // station's end (often it paused to wait on its own background work). Whether it went on working after says which.
  const quiet = run.fail_reason?.trim().match(/^no outgoing edge from (\S+)/);
  if (quiet?.[1] === row.id && s && (s.message_count ?? 0) > 0 && !s.state && !s.result?.trim() && !s.handoff) {
    const after = s.updated_at && row.completed_at ? Math.round((s.updated_at - row.completed_at) / 60_000) : 0;
    const on = s.is_active ? "; its session is still working" : after >= 1 ? `; its session kept working ${after}m after` : "";
    return { kind: "went_quiet", step: `Went quiet without a report, and the line took that as its end${on}`, stop: (st) => `${st}'s session went quiet without a report and the line took that as its end${on}` };
  }
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
  ground: "Ties the problem to a goal and rates its risk",
  park: "Holds a problem that is not ready to build",
  plan: "Writes a plan for a large change",
  plan_gate: "Read the plan before anything is built, then decide",
  analyze: "Reads the problem and its reports",
  prove: "Writes a test that shows the problem",
  prove_line: "Names the recorded runs where the line itself did what the problem describes",
  red: "Runs the test before the change, to see it fail; for a change to the line, checks the named runs against the records",
  dissolve: "Closes the problem when it does not reproduce",
  unproven: "Stops when the problem could be neither shown nor ruled out",
  implement: "Builds the change",
  implement_line: "Builds a change to the line itself",
  ask: "A person answers the builder's question, or drops the problem",
  reopen: "Sends the change back to build with the person's note",
  stopped: "Stops when the planner or the builder cannot go on, and leaves the problem open with why",
  verify: "Runs the project's checks",
  green: "Runs the test with the change, to see it pass",
  eval: "Runs the evals before and after the change",
  unscored: "Stops when the evals cannot score the change",
  review: "Reviews the diff against the problem",
  rejected: "Stops when the reviewer rejects the change, and leaves the problem open with the note",
  card_draft: "Gathers the facts you decide on: the change, its proof and its cost",
  card_write: "Writes that summary in plain words",
  card: "Checks the summary is complete before it reaches you",
  [CARD_GATE_NODE_ID]: "Read the finished change and its proof, then decide: ship it, revise it or drop it",
  drop: "Closes the problem without a change",
  rebase: "Puts the branch on the default branch and checks it again",
  ship: "Lands the change the project's way",
  merge: "Merges the branch",
  watch: "Watches for the problem to come back",
};
export const stationWords = (id: string): string | null => DOES[id] ?? null;

/** Steps that only assemble the card: a run that passed them says so in the
 *  folded line, and the phase reads by its answer. */
const ROUTINE = new Set(["card_draft", "card_write", "card"]);

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
    return { id: row.id, label: stepLabel(row), state: "noted", result: UNAPPROVED_STEP, note: cardTimeoutWords(run) ?? "decision withdrawn unanswered", at: row.completed_at ?? row.started_at };
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
    : state === "noted" && cutOff ? INTERRUPTED_WORDS
    // A ship that never ran because the card was taken back is no failure of the ship.
    // A ship that ran and refused says what it did, in the words the decision's "Then" reads (landWords).
    : row.id === "ship" && row.status === "failed" && closed ? (row.result_preview ? landWithoutYesWords({ node_id: row.id, status: row.status, result_preview: row.result_preview }) : `Skipped: the decision was ${closed}`)
    : row.id === "review" && task?.review_verdict && state !== "live"
      ? REVIEW_WORDS[task.review_verdict.verdict] ?? "Reviewed"
      : (report?.asked ? report.line : null) ?? end?.step ?? reportedWords(row, report) ?? own ?? (state === "failed" ? words?.failed ?? "Failed" : state === "live" ? words?.live ?? "Running" : state === "waiting" ? "Waiting" : words?.done ?? "Done");
  const sid = row.session?._id ?? row.session?.session_id ?? row.session_id;
  // A ship that exited clean and merged nothing (the line's merge step is off) did not land: what it printed decides,
  // never its exit code.
  const landing = row.id === "ship" || row.id === "merge";
  const unmerged = landing && state === "done" && mergeOffIn(row.result_preview);
  // A landing refused because main moved past the branch: said in four words, never its raw output.
  const behind = landing && state === "failed" ? behindBase(row.result_preview) : null;
  return {
    id: row.id,
    label: stepLabel(row),
    state: unmerged ? "noted" : state,
    result: unmerged ? NOT_MERGED_OFF : behind ? `Not merged: branch behind ${behind}` : result,
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
  if (unapproved) return { ...base, state: "noted", result: `Not shipped: ${unapproved.note ?? "decision withdrawn unanswered"}, nothing was approved` };
  const failed = steps.find((s) => s.state === "failed");
  if (failed) return { ...base, state: "failed", result: NOT_LANDED.test(failed.result) ? failed.result : `Not landed: ${lowerFirst(failed.result)}`, ...(failed.note ? { note: failed.note } : {}), ...link(failed) };
  const live = steps.find((s) => s.state === "live" || s.state === "waiting");
  if (live) return { ...base, state: live.state, result: live.state === "live" ? "Landing the change" : live.result, ...link(live) };
  const merge = by("merge");
  if (merge?.state === "noted" && merge.result.startsWith("Landed by hand")) return { ...base, state: "done", result: merge.result, ...(merge.note ? { note: merge.note } : {}), ...link(merge) };
  const noted = steps.find((s) => s.state === "noted");
  if (noted) return { ...base, state: "noted", result: NOT_LANDED.test(noted.result) ? noted.result : `Not landed: ${lowerFirst(noted.result)}`, ...(noted.note ? { note: noted.note } : {}), ...link(noted) };
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
    const ms = cardTimeoutMs(run);
    const waited = ms != null ? ` after ${took(ms)}` : "";
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
/** A run ended on purpose: its problem closed, merged or was dropped, or its fix was set aside (fail_reason "Stopped: …").
 *  An end with its reason, never a failure to retry. */
export const stoppedOnPurpose = (run: Pick<ReportRun, "status" | "fail_reason">) => run.status === "failed" && /^Stopped:/.test(run.fail_reason?.trim() ?? "");

export function runOutcome(run: ReportRun, task?: ReportTask | null, now = Date.now(), brief = false): RunOutcome {
  const ended = runEnd(run);
  const end = ended?.kind ?? null;
  const at = labelOf(run, run.current_node_id);
  if (stoppedOnPurpose(run)) return { tone: "closed", end, text: `${run.fail_reason!.trim().replace(/\.$/, "")}.` };
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
  // A station that finished with nowhere to go waits on a person's review: not a failure (stopWords says what to do).
  if (run.status === "failed" && end !== "shipped") return { tone: closedGate(run) || interrupted(run) ? "closed" : finishedAtDeadEnd(run) ? "waiting" : "failed", end, text: stopWords(run, at) };
  if (end === "shipped") {
    const watch = task?.watch_until ?? null;
    // A merge the line could not do, on a cause that is done, landed by hand.
    const byHand = nodeOf(run, "merge")?.status === "failed" && task?.status === "done";
    // A row leads with its own day, so its sentence leaves the day out.
    const shipped = brief ? (byHand ? "Shipped by hand" : "Shipped") : byHand ? `Shipped by hand ${shortDay(ended!.at)} after the line could not merge it` : `Shipped ${shortDay(ended!.at)}`;
    // LM3: a watch that reopens moves the cause to open; any other status
    // after a ship is a later run's or a person's, and this run still shipped.
    // A graph that keeps its cause open through the watch (AgentWatch) is still watching, not reopened.
    if (task && (task.status === "open" || task.status === "backlog") && !(watch && watch > now)) return { tone: "failed", end, text: brief ? `${shipped}, then reopened.` : `${shipped}, then reopened: the problem came back during the watch.` };
    if (brief) return { tone: "shipped", end, text: `${shipped}.` };
    if (watch && watch > now) return { tone: "shipped", end, text: `${shipped}. ${WATCH_WORDS} until ${shortDay(watch)}.` };
    return { tone: "shipped", end, text: task?.resolved_at ? `${shipped}. The watch ended quiet.` : `${shipped}.` };
  }
  if (end === "dropped") return { tone: "closed", end, text: nodeOf(run, CARD_GATE_NODE_ID) ? "Dropped at your decision." : "Dropped at the plan." };
  // On the line, Dissolve is its own station; another graph closes at a named step (below).
  if (end === "dissolved" && isLineRun(run.node_statuses)) return { tone: "closed", end, text: "Closed without a change: the problem did not reproduce." };
  if (end === "parked") return { tone: "calm", end, text: `Parked: the problem is not ready to build.${task?.readiness_note ? ` ${task.readiness_note.trim().replace(/\.?$/, ".")}` : ""}` };
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

/** Why a run failed, as a short label a list can group on: the station it stopped at and what happened there, in a
 *  few words ("typecheck red 3 times, Build stopped retrying", "Verify: typecheck red", "Out of time, 3h"). `key` is the same
 *  for every run that stopped the same way at the same station (and the same red check); `raw` is the engine's own
 *  words, for a tooltip. `check` is the red check that drove it, when a script's output names one. */
export type FailCause = { key: string; step: string | null; label: string; raw: string; check?: RunCheck | null;
  /** This run's own words for the cause, when they say more than the heading its group shares (`label`). */ detail?: string;
  /** Killed at a time limit before its session ran a turn: the limit's minutes. The cause is never starting, not the limit. */ satEmpty?: number; /** What a step that finished at a dead end advised next, from its routing JSON (StepAdvice). */ advice?: StepAdvice | null;
  /** A station that handed its work off for review: what it says the review needs, and the gate that was still red. */
  review?: { ask: string | null; gate: string | null };
  /** A station that pinned itself blocked where the run stopped: what it says blocks it, in its own words, whole (its
   *  pin's first paragraph). Starting the run again meets the same block until that changes. */
  blocked?: string };

/** What a step advises for the work it just did, from its routing JSON's `next` (prove.md): go on, wait for more cases,
 *  or have someone review it first (`by` names who). `why` is its one line for wait or review. */
export type StepAdvice = { act: "go" | "wait" | "review"; by: string | null; why: string | null };

const ADVICE_ACTS: ReadonlySet<string> = new Set(["go", "wait", "review"]);
/** A node's advice, read off whichever of its records carries the routing JSON. */
export function stepAdvice(n: ReportNode | undefined): StepAdvice | null {
  for (const text of n ? [n.result_preview, n.session?.result, n.session?.state] : []) {
    const json = text ? headJson(text) : null;
    const act = typeof json?.next === "string" ? json.next.trim().toLowerCase() : "";
    if (!ADVICE_ACTS.has(act)) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { act: act as StepAdvice["act"], by: act === "review" ? str(json!.by) : null, why: act === "go" ? null : str(json!.why) };
  }
  return null;
}

const spanWords = (min: number) => (min < 60 ? `${min}m` : `${Math.round((min / 60) * 10) / 10}h`);

/** The red check a run's newest failing script printed: its checks that failed, the source files its errors name, the
 *  files the run's own build said it changed, and whether every failing file lies outside that change (the base was
 *  already red). `empty`: the script failed and printed nothing. */
/** `tests`: the failing tests the check printed ("opsApi > refuses under the test runner"), first ones first. */
export type RunCheck = { step: string; label: string; failed: string[]; files: string[]; preExisting: boolean; empty: boolean; tests: string[] };

/** The failing tests a runner printed ("(fail) opsApi > refuses … [0.51ms]"), once each. */
export const failedTests = (text: string): string[] => [...new Set([...text.matchAll(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/gm)].map((m) => m[1].trim()))];

const ERROR_FILE = /([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|njk|swift|kt))\(\d+,\d+\):\s*error/g;
/** A failing test's stack line names its file: "at <anonymous> (/w/tests/unit/opsCallCards.test.ts:97:68)". */
const STACK_FILE = /\bat\s[^\n]*?\(([\w./-]+\.(?:tsx?|jsx?|mjs|cjs)):\d+:\d+\)/g;
const base = (f: string) => f.replace(/\/\*$/, "").split("/").pop() ?? f;

/** A node's printed words: what the runner recorded, else its session's own result or pinned report. */
const nodeText = (n: ReportNode) => n.result_preview || n.session?.result || n.session?.state || "";

/** A JSON object at the head of a printed output (its first line, or the whole text), else null. */
function headJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) {
    const fence = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/.exec(t)?.[1];
    if (!fence) return null;
    try { const v = JSON.parse(fence); return v && typeof v === "object" ? v : null; } catch { return null; }
  }
  for (const body of [t, t.split("\n")[0]]) {
    try { const v = JSON.parse(body); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* not whole */ }
  }
  return null;
}

export function runCheck(run: Pick<ReportRun, "node_statuses">): RunCheck | null {
  const nodes = run.node_statuses ?? [];
  // The files the run's build changed: any station's report that lists `files`.
  const changed = new Set<string>();
  for (const n of nodes) {
    for (const text of [n.result_preview, n.session?.result, n.session?.state]) {
      const files = text ? headJson(text)?.files : null;
      if (Array.isArray(files)) for (const f of files) if (typeof f === "string") changed.add(base(f));
    }
  }
  for (const n of [...nodes].reverse()) {
    // A check is a script's: an agent's station (a session, a hand's id, or one of the line's agent stations) never is.
    if (n.status !== "failed" || n.session || n.session_id || AGENT_STATIONS.has(n.node_id)) continue;
    const text = nodeText(n);
    const json = headJson(text);
    const steps = Array.isArray(json?.steps) ? (json!.steps as Array<{ name?: string; ok?: boolean }>) : null;
    const failed = steps ? steps.filter((x) => x && x.ok === false && x.name).map((x) => x.name!.replace(/\s*\(.*$/, "")) : [];
    if (!text.trim() || failed.length || json?.ok === false) {
      const files = [...new Set([...text.matchAll(ERROR_FILE), ...text.matchAll(STACK_FILE)].map((m) => base(m[1])))];
      return {
        step: n.node_id, label: labelOf(run as ReportRun, n.node_id), failed, files,
        preExisting: files.length > 0 && changed.size > 0 && files.every((f) => !changed.has(f)),
        empty: !text.trim(),
        tests: failedTests(text),
      };
    }
  }
  return null;
}

/** A station's printed words in one short line: its first line that is not JSON, else its JSON's summary. */
function gistOf(text: string): string | null {
  const json = headJson(text);
  const fromJson = json && typeof json.summary === "string" ? json.summary : json && typeof json.statement === "string" ? json.statement : null;
  const line = fromJson ?? text.replace(/```json[ \t]*\n[\s\S]*?\n[ \t]*```/g, "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l && !l.startsWith("{"));
  if (!line) return null;
  const first = line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line;
  return first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

/** A check in words: "typecheck red"; one that failed and printed nothing in the words its step's row says ("Evals
 *  failed", as the run page reads it), so a reader and the run never name one failure two ways. */
const emptyFail = (c: RunCheck) => { const w = WORDS[c.step]?.failed; return w && w.startsWith(c.label) ? w : `${c.label} failed`; };
export const checkWords = (c: RunCheck) => (c.tests.length ? `${testName(c)} red` : c.failed.length ? `${c.failed.join(", ")} red` : c.empty ? emptyFail(c) : `${c.label} red`);

/** A check under its station's name, said once: "Verify: typecheck red", but "Decide gave no result" (never "Decide: Decide ..."). */
const checkAt = (c: RunCheck) => { const w = checkWords(c); return w.startsWith(c.label) ? w : `${c.label}: ${w}`; };
/** A station id that reached a label unnamed ("proposal_gate") reads as words. */
const plainIds = (t: string) => t.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (id, at: number) => { const w = id.replace(/_/g, " "); return at === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w; });

/** The failing test a check names, by its suite ("opsApi"), "+N" for the rest; else the failed step or the files. */
export function testName(c: RunCheck): string {
  const suites = [...new Set(c.tests.map((t) => t.split(" > ")[0].trim()))];
  if (suites.length) return suites.length > 1 ? `${suites[0]} +${suites.length - 1}` : suites[0];
  return c.failed[0] ?? c.files[0] ?? c.label;
}

export function failCause(run: Pick<ReportRun, "fail_reason" | "current_node_id"> & Partial<Pick<ReportRun, "node_statuses">>): FailCause {
  const raw = run.fail_reason?.trim() ?? "";
  const at = run.current_node_id ?? null;
  const check = run.node_statuses ? runCheck(run) : null;
  // The check that drove it, by its step and what it said: "Verify gave no result" and "Eval gave no result" are two causes.
  const ck = check ? `:${check.step}:${check.failed.join(",") || (check.empty ? "empty" : "red")}` : "";
  const out = (kind: string, step: string | null, label: string): FailCause => ({ key: `${kind}:${step ?? ""}${ck}`, step, label: plainIds(label), raw, check });
  const label = (id: string) => labelOf(run as ReportRun, id);
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^no outgoing edge from (\S+)(?:.*?\boutcome (\w+))?/))) {
    // The one test of whether the station finished (finishedAtDeadEnd): a handoff, a kill or a failed node is a failure
    // even when the engine's words carry no outcome.
    const failed = !finishedAtDeadEnd(run as ReportRun);
    // A station that never got going failed for that, whatever else the run shows: no session ran, so nothing it did is a reason.
    const dead = run.node_statuses?.find((n) => n.node_id === m![1]);
    const end = dead ? stationEnd({ id: m[1], status: dead.status as RunNodeRow["status"], session: dead.session as RunNodeRow["session"], session_id: dead.session_id, completed_at: dead.completed_at }, run) : null;
    if (end?.kind === "never_started") return { key: `nosession:${m[1]}`, step: m[1], label: NEVER_STARTED_CAUSE, raw, check };
    // Its session went quiet before reporting: the runner's reading of a turn's end, never the station's instructions.
    if (end?.kind === "went_quiet") return { key: `quiet:${m[1]}`, step: m[1], label: `${label(m[1])}'s session went quiet without a report`, raw, check };
    if (failed && check) return out("deadend-failed", m[1], checkAt(check));
    // The station's own first words say what it ended on ("Build: refusing, the proposal names no file").
    // Its words are in whichever record holds prose: a session's `result` is often only its routing JSON, its pinned
    // report the sentence a person reads.
    const node = run.node_statuses?.find((n) => n.node_id === m![1]);
    const said = node ? [node.result_preview, node.session?.result, node.session?.state].reduce<string | null>((g, t) => g ?? (t ? gistOf(t) : null), null) : null;
    // A station that pinned itself blocked or waiting, or reported no miss, says so in its own word, never "failed".
    const short = failed ? unfinishedWords(node?.session as ReportNode["session"]) ?? "failed" : null;
    // A station that stopped short because a spend limit refused its work (it pinned "every rep refused, the wallet is
    // over its cap" and went to sleep until the cap rolls off) stopped for money, not for anything about the problem or a
    // person: one heading with every other spend-cap stop, never "<step> waiting".
    if (short && short !== "failed" && runSpendCap(run as ReportRun, m[1])) return { key: `budget:${m[1]}`, step: m[1], label: "Stopped by a spend limit", raw, check };
    const blocked = short === "blocked" ? pinnedReason(node?.session as ReportNode["session"]) : null;
    // Its own word is part of the cause: "Prove blocked" and "Prove found no miss" are two headings, never one "Prove stopped".
    const kind = short && short !== "failed" ? `deadend-failed-${short.replace(/\s+/g, "-")}` : "deadend-failed";
    if (said) return failed ? { ...out(kind, m[1], `${label(m[1])} ${short}: ${said}`), ...(blocked ? { blocked } : {}) } : { ...out("deadend", m[1], `${label(m[1])}: ${said}`), advice: stepAdvice(node) };
    // It said nothing at all: no report, so nothing for a person to say yes to (`deadend-silent`, never a need).
    return out(failed ? "deadend-failed-noreport" : "deadend-silent", m[1], `${label(m[1])} ended without a report`);
  }
  if ((m = raw.match(/^max_visits=(\d+) exceeded on (\S+)/))) {
    const looped = loopEnd(run, m[2], check);
    if (looped) return { ...looped, raw, check };
    // A loop a red check drove reads by the check: "typecheck red 3 times, Build stopped retrying".
    // Red only in files the change never touched: the fix was killed by someone else's test, said so by name.
    if (check?.preExisting) return out(`looped${m[1]}`, m[2], `killed: ${testName(check)} (not in diff) red ×${m[1]}`);
    return out(`looped${m[1]}`, m[2], check ? `${checkWords(check)} ${m[1]} times, ${label(m[2])} stopped retrying` : `${label(m[2])} went round ${m[1]} times and stopped`);
  }
  // Timeouts group by station, whatever each run's limit was; the label names the time when the group's runs agree.
  if ((m = raw.match(TIMED_OUT))) {
    // A session that holds no message at its limit never ran a turn: it never started working, it did not run long.
    const step = m[2] ?? at;
    const empty = (run.node_statuses?.find((n) => n.node_id === step)?.session as ReportNode["session"])?.message_count === 0;
    // A limit is the cause whatever an earlier check printed: the key carries no check, so one stall is one heading.
    // One that sat empty never started: it shares the heading of every other way a session never got going.
    if (empty) return { key: `nosession:${step ?? ""}`, step, label: NEVER_STARTED_CAUSE, detail: `Never started: its session sat empty until the ${spanWords(Number(m[1]))} limit`, satEmpty: Number(m[1]), raw, check };
    return { key: `killed:${step ?? ""}`, step, label: `Out of time, ${spanWords(Number(m[1]))}`, raw, check };
  }
  if ((m = raw.match(/^gate (dismissed|withdrawn)$/))) return out(`gate-${m[1]}`, at, `Card ${m[1]}`);
  if ((m = raw.match(/^(\S+) is waiting on a person$/))) {
    // The engine says "waiting on a person" for any station that pinned blocked; its own pin says what it waits on. A
    // spend cap waits on time, not on anyone.
    const node = run.node_statuses?.find((n) => n.node_id === m![1]);
    if (runSpendCap(run as ReportRun, m[1])) return { key: `budget:${m[1]}`, step: m[1], label: "Stopped by a spend limit", raw, check };
    return out("asks", m[1], "Waiting on a person");
  }
  if ((m = raw.match(RUNNER_STOP))) return out(`runner-${m[1]}`, m[2] ?? at, m[1] === "SIGINT" ? "Stopped by hand" : "Runner shut down");
  if (check) return out("check", check.step, checkAt(check));
  if (!raw) return out("unknown", at, "Failed");
  const short = raw.replace(/\s*\(.*$/, "");
  return out(`other:${short.toLowerCase()}`, at, short.length > 40 ? `${short.slice(0, 39)}…` : short);
}

/** A loop's end read by the looped station's own last word, before the engine's count (null: read it by the count).
 *  - It handed the work off for review: the run waits on a person's review, whatever the gate said
 *    (`review:<step>`, never a failure; `ask` is the builder's own "Needs …" sentence).
 *  - It finished (its pin says done, a prover's miss reproduced) and a script that routes back to it sent it round:
 *    that script is where the run failed (`sentback:<script>`), filed at the script, never at the station.
 *  - The red check names a fault of the line's machine (an eval layer that could not run): `infra:<step>`.
 *  None of these is fixed in the station's instructions. */
function loopEnd(run: Partial<Pick<ReportRun, "node_statuses">>, stepId: string, check: RunCheck | null): Omit<FailCause, "raw" | "check"> | null {
  const nodes = run.node_statuses ?? [];
  const s = nodes.find((n) => n.node_id === stepId)?.session as ReportNode["session"];
  const settled = s?.state_status === "done" && !unfinishedWords(s);
  const name = (id: string) => labelOf(run as ReportRun, id);
  if (settled && s?.handoff?.status === "done") {
    return { key: `review:${stepId}`, step: stepId, label: "Handed off for review", review: { ask: reviewAsk(s.handoff.note ?? "") ?? (s.state?.split("\n")[0].trim() || null), gate: check ? checkAt(check) : null } };
  }
  const infra = [...nodes].reverse().map((n) => (n.status === "failed" ? machineFault(nodeText(n)) : null)).find(Boolean);
  if (infra) return { key: `infra:${stepId}`, step: stepId, label: `Line machine: ${infra}` };
  if (!settled || check) return null;
  // The script that sends this station back (an edge from a command into it) and printed why.
  const back = SHIPPED_LINE.edges.filter((e) => e.to === stepId && !AGENT_STATIONS.has(e.from)).map((e) => nodes.find((n) => n.node_id === e.from)).find((n) => n && n.status === "completed" && nodeText(n).trim());
  if (!back) return null;
  const json = headJson(nodeText(back));
  const why = typeof json?.why === "string" && json.why.trim() ? json.why.trim() : gistOf(nodeText(back));
  return { key: `sentback:${back.node_id}`, step: back.node_id, label: `${name(back.node_id)} sent ${name(stepId)} back${why ? `: ${why}` : ""}` };
}

/** A check's printed fault of the line's own machine, in its first clause ("layer 3 cannot run: L3_DATABASE_URL is not
 *  set"): an eval gate that could not run says so in `gate.infra`. */
function machineFault(text: string): string | null {
  return gateInfra(headJson(text));
}

/** The line's own machine fault a check printed in its result (`gate.infra`), in its first clause without asides:
 *  "layer 3 cannot run: L3_DATABASE_URL is not set (layer 3 needs a loopback Postgres); the eval command…" reads
 *  "layer 3 cannot run: L3_DATABASE_URL is not set". Null when the result names none. */
export function gateInfra(result: Record<string, unknown> | null | undefined): string | null {
  const gate = result?.gate as { infra?: unknown } | null | undefined;
  const t = typeof gate?.infra === "string" ? gate.infra.replace(/\s*\([^)]*\)/g, "").split(/;\s/)[0].trim() : "";
  return t || null;
}

/** What a handoff says it waits on, in its own sentence ("Needs an engineer's safety review before merge, because …");
 *  null when it names none. */
export function reviewAsk(note: string): string | null {
  const m = /(?:^|\n|\.\s+)((?:Needs|Side|Waiting on)\b[^\n]*)/.exec(note);
  const t = m?.[1].replace(/^Side:\s*/, "").trim() ?? "";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

/** What a station's pin says, whole, as a reason: its first paragraph without the routing JSON or machine detail. */
export function pinnedReason(s: ReportNode["session"] | null | undefined): string | null {
  const para = stationReport(s)?.prose?.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
  return para ? plainIds(para) : null;
}

/** How a station's own report says it did not finish ("blocked", "found no miss"); null when it reads done or pinned
 *  nothing. A pinned status other than done is the station's own word that it stopped short. */
export function unfinishedWords(s: ReportNode["session"] | null | undefined): string | null {
  const status = s?.state ? s.state_status : undefined;
  if (status && status !== "done") return status === "blocked" ? "blocked" : status === "working" ? "still working" : "waiting";
  return stationReport(s)?.result?.reproduced === false ? "found no miss" : null;
}

/** A run that stopped because its graph had no route after a station that finished its work: nothing failed, the
 *  station's result waits for a person to review it. The engine's end marks the last node failed, so the station's
 *  own outcome decides; a report with no outcome reads by the node. A handoff, a start that never came or a kill
 *  (stationEnd) is not a finish. */
export function finishedAtDeadEnd(run: ReportRun): boolean {
  const m = run.fail_reason?.trim().match(/^no outgoing edge from (\S+)(?:.*?\boutcome (\w+))?/);
  if (!m) return false;
  const node = nodeOf(run, m[1]);
  if (node && stationEnd({ id: m[1], status: node.status as RunNodeRow["status"], session: node.session as RunNodeRow["session"], session_id: node.session_id, completed_at: node.completed_at }, run)) return false;
  // The engine can close a station at a turn end before its session pins its report; the session's own last word
  // decides: one that says it is blocked or waiting, or that the miss did not reproduce, has nothing to go on with.
  if (unfinishedWords(node?.session as ReportNode["session"])) return false;
  return m[2] ? !/^fail/.test(m[2]) : node?.status !== "failed";
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
    const end = node ? stationEnd({ id: m[1], status: node.status as RunNodeRow["status"], session: node.session as RunNodeRow["session"], session_id: node.session_id, completed_at: node.completed_at }, run) : null;
    if (end) return `Stopped at ${st}: ${end.stop(st)}${end.kind === "handoff" ? ", and the line had no route for that" : ""}.`;
    // What the person can do next, never the engine's gap (LL6): the graph is fixed where it lacks the route.
    // Finished with nothing said: there is nothing to review, only to start again.
    if (finishedAtDeadEnd(run) && failCause(run).key.startsWith("deadend-silent")) return `Stopped at ${st}: ${st} ended without a report; start again or close the problem.`;
    if (failCause(run).key.startsWith("budget:")) { const held = runSpendCap(run, m[1]); return `Stopped at ${st}: a spend limit refused its work${held ? ` (${spendCapWords(held)})` : ""}.`; }
    // A station that pinned itself blocked said what blocks it: that is why the run stopped, never "it failed".
    const blocked = failCause(run).blocked;
    if (blocked) return `Stopped at ${st}: ${st} is blocked: ${blocked.replace(/[.…]+$/, "")}.`;
    return finishedAtDeadEnd(run)
      ? `Stopped at ${st}: ${st} finished; review it or close the problem.`
      : `Stopped at ${st}: ${st} failed; see what it tried, or close the problem.`;
  }
  const end = loopEnd(run, why.match(/^max_visits=\d+ exceeded on (\S+)/)?.[1] ?? "", null);
  if (end?.review) return `Stopped at ${labelOf(run, end.step ?? undefined)}: it handed its work off for review${end.review.ask ? ` (${end.review.ask.replace(/\.$/, "")})` : ""}.`;
  if (end) return `Stopped: ${end.label}.`;
  const looped = loopedStation(run);
  if (looped) return `Stopped: ${labelOf(run, looped.node)} looped ${TIMES[looped.times] ?? `${looped.times} times`}.`;
  if ((m = why.match(TIMED_OUT))) return `Stopped: ${labelOf(run, m[2] ?? run.current_node_id)}'s session ran out of time.`;
  if ((m = why.match(/^gate (dismissed|withdrawn)$/))) return run.gate_node_id === CARD_GATE_NODE_ID || run.current_node_id === CARD_GATE_NODE_ID ? `Stopped: the decision was ${m[1]}.` : `Stopped: the question was ${m[1]}.`;
  if ((m = why.match(/^(\S+) is waiting on a person$/))) {
    const cap = runSpendCap(run, m[1]);
    if (cap) return `Stopped at ${labelOf(run, m[1])}: a spend limit refused its work (${spendCapWords(cap)}).`;
    return `Stopped at ${labelOf(run, m[1])}: it asked a question and waits on a person's answer.`;
  }
  if ((m = why.match(RUNNER_STOP))) return m[1] === "SIGINT" ? `Stopped by hand during ${labelOf(run, m[2] ?? run.current_node_id)}.` : `Stopped: the runner was shut down during ${labelOf(run, m[2] ?? run.current_node_id)}.`;
  return `Stopped at ${at}: ${why}.`;
}

/** Why a run failed at one step, as its page says it: what happened there, never the engine's log line ("hand jx747zj
 *  killed after 30m at build" reads "Ran out of time: stopped at its 30 min limit"). A station that handed the problem
 *  back first says that, since the handoff is how it ended and the time limit only closed its session. */
export function stepFailWords(run: ReportRun, stepId: string): string {
  const timeout = run.fail_reason?.trim().match(TIMED_OUT);
  if (timeout && (!timeout[2] || timeout[2] === stepId)) {
    const node = nodeOf(run, stepId);
    const handoff = (node?.session as ReportNode["session"])?.handoff?.status;
    const limit = `${timeout[1]} min`;
    if ((node?.session as ReportNode["session"])?.message_count === 0) return `Its session never ran a turn: it sat empty until the ${limit} limit closed it.`;
    return handoff && HANDOFF_WORDS[handoff] ? `It handed the problem back ${handoff === "blocked" ? "blocked" : "asking for context"}, then its session was closed at the ${limit} time limit.` : `Ran out of time: stopped at its ${limit} limit.`;
  }
  return stopWords(run).replace(/^Stopped at [^:]+: /, "").replace(/^Stopped: /, "").replace(/^\w/, (c) => c.toUpperCase());
}

/** A problem's newest run in one sentence for its page, said the way its
 *  header says the rest ("Last run Oct 7 stopped at Dissolve after 30
 *  minutes."): no session ids, no step fractions (learning-loop.md LL6). */
export function lastRunWords(run: ReportRun): string {
  const day = shortDay(run.updated_at || run.created_at);
  const timeout = run.fail_reason?.trim().match(TIMED_OUT);
  if (timeout) return `Last run ${day} stopped at ${labelOf(run, timeout[2] ?? run.current_node_id)} after ${timeout[1]} minutes.`;
  if (isLiveRun(run)) return `Running since ${shortDay(run.created_at)}, now at ${labelOf(run, run.current_node_id)}.`;
  if (run.status === "completed") return `Last run ${day} finished.`;
  const why = stopWords(run);
  return `Last run ${day}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
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

export type LineVersion = { hash: string; first: number; last: number; runs: number; shipped: number; revised: number; dropped: number; stopped: number; reopened: number; billedUsd: number | null; listUsd: number | null; live: number; nodes: ReportRun["graph_nodes"] | null; change: string };

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
    const v = out.get(hash) ?? { hash, first: r.created_at, last: r.created_at, runs: 0, shipped: 0, revised: 0, dropped: 0, stopped: 0, reopened: 0, billedUsd: null, listUsd: null, live: 0, nodes: null, change: "" };
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
    if (typeof r.card_billed_usd === "number") {
      v.billedUsd = (v.billedUsd ?? 0) + r.card_billed_usd;
      v.listUsd = (v.listUsd ?? 0) + (r.card_list_usd ?? 0);
    }
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

// ── where a cause is (LM3) ───────────────────────────────────────────────────

/**
 * Where a cause is, in one sentence (the-line-model.md LM3's "also shown"):
 * the newest run speaks while it runs; otherwise the task status the line
 * wrote, with the watch day after a ship and "reopened" when a signal came
 * back during the watch. `stopped` is the state word for why the cause's
 * project starts nothing on its own (lineFlow autoStartWord), when it does.
 */
export function causeWhere(task: ReportTask, latest: ReportRun | null, reopened: boolean, now = Date.now(), stopped?: string | null, close?: CauseClose | null): RunOutcome {
  // An open cause whose line starts nothing is not in a queue that moves: say why, never "waiting its turn".
  // One a run already closed says that close first, so the page and the Timeline tell one story (learning-loop.md LL6).
  const lead = close ? closeLead(close) : null;
  const waiting: RunOutcome = stopped
    ? lead
      ? { tone: "waiting", end: null, text: `${lead} ${upperFirst(stopped)}.` }
      : { tone: "waiting", end: null, text: upperFirst(stopped) }
    : { tone: "calm", end: null, text: lead ? `${lead} Waiting its turn.` : "Waiting its turn." };
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
    return reopened ? { tone: "failed", end: "shipped", text: `Shipped ${shortDay(shipped.at)}, then reopened: the problem came back during the watch.` } : runOutcome(latest, task, now);
  }
  if ((task.status === "open" || task.status === "backlog") && reopened) return { tone: "failed", end: null, text: "Reopened: the problem came back during the watch." };
  if (latest) {
    const said = runOutcome(latest, task, now);
    // A run that went on past its unanswered card built a change nobody approved: that, not the queue, is where the cause is.
    if (shippedUnapproved(latest)) return said;
    if (task.status === "open" || task.status === "backlog") return said.end === "parked" ? said : waiting;
    return said;
  }
  if (task.status === "done") return { tone: "shipped", end: null, text: "Done." };
  if (task.status === "open" || task.status === "backlog") return waiting;
  return { tone: "calm", end: null, text: task.status === "in_review" ? "In review." : "In progress." };
}

/** A cause's newest close without a change (a dissolve or a drop) on any graph,
 *  and whether the problem came back after it: what the Timeline marks "Came back". */
export type CauseClose = { kind: "dissolved" | "dropped"; step: string; at: number; cameBack: boolean };

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function closeLead(c: CauseClose): string {
  const verb = c.kind === "dissolved" ? "dissolved" : "dropped";
  const step = c.step.replace(/_/g, " ").replace(/^\w/, (x) => x.toUpperCase());
  return c.cameBack ? `Came back after it was ${verb} at ${step} on ${shortDay(c.at)}.` : `${upperFirst(verb)} at ${step} on ${shortDay(c.at)}.`;
}

/** The newest close from a cause's runs (any graph), when no ship came after
 *  it; `lastSeen` is the cause's newest report, so a report after the close
 *  means it came back. */
export function newestClose(runs: ReadonlyArray<ReportRun>, lastSeen: number | null | undefined): CauseClose | null {
  let best: { kind: string; at: number; node: string } | null = null;
  for (const r of runs) {
    const e = runEnd(r);
    if (e && (e.kind === "dissolved" || e.kind === "dropped" || e.kind === "shipped") && (!best || e.at > best.at)) best = e;
  }
  if (!best || best.kind === "shipped") return null;
  return { kind: best.kind as CauseClose["kind"], step: closedAtStep(best.node), at: best.at, cameBack: !!lastSeen && lastSeen > best.at };
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
