// A step's work as its page lists it (line-journeys.md LJ8.6): one row per
// visit of a problem to the step, filed under exactly one of Waiting,
// Failed or Passed. The three counts are the page's only filters and each is
// the number of rows it opens, so the Line table and the Map read the same
// counts. Failed rows are grouped by cause, the cause in plain words. Also the
// words a row is read in: an outcome key a person never typed ("red",
// "mechanism") reads as what happened, and a report's fields read under names
// a person uses, with machine paths left out. Pure.
import { decisionSaid, decisionsByCase, tallyKey, type LineStep, type StepDecision, type StepKind } from "./lineModel";
import { DECISION_STATE_WORDS } from "./decisionOutcome";
import { LANDING_STATIONS, NEVER_STARTED_CAUSE, NOT_LANDED, gateInfra, handoffOfWords, neverStartedWords, spendCap, spendCapWords as capWords, stationCatalogWords } from "./runReport";
import { checkName, scriptChecks } from "./scriptReport";
import { blockerCause } from "./blocker";

export const STEP_SHOWS = ["waiting", "failed", "passed"] as const;
export type StepShow = (typeof STEP_SHOWS)[number];
export const isStepShow = (v: string | null | undefined): v is StepShow => !!v && (STEP_SHOWS as readonly string[]).includes(v);

/** How one row stands: `stopped` is a run that finished here with no next step and needs a person's yes; `replaced` one a newer run took over. */
/** `review` is a station that handed its work off for a person's review: a wait, never a failure, whatever the gate said. */
/** `unlanded` is an approved fix nothing merged, at the landing step that left it: waiting on a person to merge it. */
export type WorkState = "waiting" | "running" | "stopped" | "review" | "unlanded" | "failed" | "passed" | "replaced";
/** A wait For you lists, placed at the one step that holds it (stepTable needSteps): its kind, and the step. */
export type NeedPlace = { step: string; kind: string };
/** What a run that handed its work off for review waits on: the station's own "Needs …" sentence, and the gate still red. */
export type ReviewWait = { ask: string | null; gate: string | null };
export type WorkCause = { key: string; label: string; /** The cause whole, when the heading had to shorten it. */ whole?: string;
  /** The station pinned itself blocked: what blocks it, in its own words (runReport FailCause.blocked). */ blocked?: string;
  /** The run kept nothing that says why (no output, no words): a count to open, never a reason to read. */ thin?: boolean };
export type WorkRow = {
  /** The problem's id, else the run's. */
  key: string;
  /** The newest visit of this problem at the step. */
  d: StepDecision;
  /** Earlier visits of the same problem, newest first. */
  earlier: StepDecision[];
  state: WorkState;
  /** Why it failed, for a failed row. */
  cause: WorkCause | null;
  /** Older visits of the same problem that failed for the same cause: one row says them all ("failed 2 times"). */
  again?: StepDecision[];
  /** Its problem has closed since (done or dropped): a failure with nothing to start again. */
  problemClosed?: boolean;
  /** A newer run of its problem came after it, or the problem stands elsewhere now (`now`, Problems' own words): a
   *  failure with nothing to start again here. */
  movedOn?: boolean;
  now?: string;
  /** What a `review` row waits on. */
  review?: ReviewWait;
  /** The For you wait this row is (needSteps): its act is For you's own. */
  ask?: NeedPlace;
  /** A failed row whose station pinned itself blocked: what blocks it, whole. */
  blocked?: string;
};
/** Runs that stopped at their limit together: one stall (a machine, a runner, a budget), not that many failures. */
export type Stall = { n: number; from: number; to: number; machines: number; /** Of `n`, the sessions that never ran a turn. */ empty: number };
export type FailGroup = WorkCause & { rows: WorkRow[]; stall?: Stall | null };
export type StepWork = {
  waiting: WorkRow[];
  failed: FailGroup[];
  passed: WorkRow[];
  /** Left waiting or running when a newer run took the problem up: listed last, in no count. */
  replaced: WorkRow[];
  /** Failed visits of problems closed since (dropped or done): nothing to start again, so listed last, folded, in no count. */
  closed: WorkRow[];
  /** Failed visits of runs a newer run of the same problem came after: that run is where the problem stands, so these are
   *  listed last, folded, in no count. */
  movedOn: WorkRow[];
  counts: Record<StepShow, number>;
};

export type StepWorkInput = {
  /** Runs that finished at this step with no next step (lineModel run outcome tone "waiting" on a failed run): a need, never a failure. */
  stopped?: ReadonlySet<string>;
  /** Why a run failed, by run id, when its run row says (runReport failCause, only for a run that failed at this step). */
  causes?: ReadonlyMap<string, WorkCause>;
  /** Problems closed since (closedProblems): their failures are history, not work. */
  closed?: ReadonlySet<string>;
  /** How each run that hit its time limit here ended (runFactsByStep): when, on which machine, whether its session ever ran a turn. */
  ends?: ReadonlyMap<string, RunEnd>;
  /** Each problem's newest run, by problem id (newestRuns): a failure in any older run is no longer where it stands. */
  newest?: ReadonlyMap<string, string>;
  /** Runs whose station here handed its work off for review (runReport failCause `review:`): waiting on a person. */
  review?: ReadonlyMap<string, ReviewWait>;
  /** Runs that stopped here only because a later check sent this station back: filed at that check, passed here. */
  cleared?: ReadonlySet<string>;
  /** Where each problem stands on Problems, by id: its phrase there, and for one listed under Failed the steps its cause
   *  names. A failure here counts under Failed only when Problems files it at this step, so the two read one number;
   *  else it sits with the moved-on ones, saying where it stands ("Found nothing to change", "Failed at Ask you"). */
  standing?: ReadonlyMap<string, Standing>;
  /** What waits on a person, by run (stepTable needSteps): each For you item is a Waiting row at exactly one step, the
   *  newest visit of its run there, whatever the visit's own status says. */
  asks?: ReadonlyMap<string, NeedPlace>;
};
export type Standing = { now: string; failedAt?: ReadonlyArray<string> };
export type RunEnd = { at: number; device: string | null; empty: boolean };

/** The problems that are closed (done or dropped), by id: a step's failure of one is history, with nothing to start again. */
export function closedProblems(tasks: Iterable<{ _id: string; status?: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) if (t.status === "done" || t.status === "dropped") out.add(String(t._id));
  return out;
}

/** Each problem's newest run, by problem id: the run that says where it stands now. */
export function newestRuns(runs: Iterable<{ id: string; caseId: string | null; at: number }>): Map<string, string> {
  const at = new Map<string, number>();
  const out = new Map<string, string>();
  for (const r of runs) if (r.caseId && r.at > (at.get(r.caseId) ?? -Infinity)) { at.set(r.caseId, r.at); out.set(r.caseId, r.id); }
  return out;
}

/** A visit that stopped on a spend cap, in a line: whose budget and how full, and when it runs again as a clock time. */
export function spendCapWords(d: Pick<StepDecision, "reasoning" | "decided" | "at" | "durationMs">, clock: (t: number) => string): string | null {
  const text = [d.reasoning, d.decided.words].filter(Boolean).join("\n");
  const c = spendCap(text, d.at != null ? d.at + (d.durationMs ?? 0) : null);
  return c ? capWords(c, clock) : null;
}

const REF = /\b[a-z]{1,4}-\d+\b/g;
const HAS_REF = /\b[a-z]{1,4}-\d+\b/;
/** A cause as a class of failure, never one problem's sentence: "ct-59231 has no findings: nothing to work from" reads
 *  "No findings: nothing to work from", and every problem it stopped groups under it (the ids are on the rows). */
export function causeClass(c: WorkCause): WorkCause {
  const strip = (t: string) => {
    const m = /^[a-z]{1,4}-\d+\s+(?:(has|have)\s+|(?:is|was|were)\s+)?([\s\S]*)$/.exec(t);
    return m ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : t;
  };
  const label = strip(c.label);
  if (label === c.label && !HAS_REF.test(c.key)) return c;
  return { ...c, key: c.key.replace(REF, "#").replace(/^(\w+:)#\s*(?:has|have|is|was|were)?\s*/, "$1"), label, ...(c.whole ? { whole: strip(c.whole) } : {}) };
}

const BARE_FAIL = /^(fail|failed|failure|cut off)$/i;
/** A ref leads a sentence as it is written ("ct-59231 has no findings"), never capitalized. */
const LEADING_REF = /^[a-z]{1,4}-\d/;
const sentence = (t: string) => { const s = t.replace(/\s+/g, " ").trim(); return s && !LEADING_REF.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

/** Why an eval run failed, from the result it printed: the layer that could not run, the gate suite's exit, the gate
 *  cases that failed. Null when the result names none. */
export function evalFailWords(result: Record<string, unknown> | null | undefined): string | null {
  const gate = (result?.gate ?? null) as { note?: unknown } | null;
  const infra = gateInfra(result);
  if (infra) return sentence(infra);
  const failed = Array.isArray(result?.gates_failed) ? (result!.gates_failed as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  const exit = failed.map((f) => /^gate: the suite exited (\d+)/.exec(f)).find(Boolean);
  if (exit) return `The gate suite exited ${exit[1]}`;
  if (failed.length) return `Gate cases failed: ${failed.slice(0, 2).join(", ")}${failed.length > 2 ? ` and ${failed.length - 2} more` : ""}`;
  const note = typeof gate?.note === "string" ? gate.note.trim() : "";
  return note && note !== "red" ? sentence(note.replace(/^infra:\s*/, "")) : null;
}

/** Why a failed visit failed: the run's own reason when it failed here, else what the step printed or said, else what
 *  the visit's shape shows (an agent's session that never started, a script that left no output), else none recorded. */
export function failCauseOf(d: StepDecision, causes?: ReadonlyMap<string, WorkCause>, kind?: StepKind): WorkCause {
  const own = d.decided.outcome;
  // The line's own label for a step that failed ("Could not write a test for the problem") is no reason: it claims what nobody said.
  const stepId = d.id.slice(d.runId.length + 1);
  const words = stationCatalogWords(stepId, d.decided.words?.trim()) ? undefined : d.decided.words?.trim();
  const run = causes?.get(d.runId);
  // A station that handed the problem back ended there, by its own act: a time limit that closed its session after is not why.
  const handoff = handoffOfWords(d.decided.words);
  if (handoff) return handoff === "blocked" ? { key: "handoff:blocked", label: "Handed back blocked: needs a person" } : { key: "handoff:context", label: "Handed back asking for context" };
  // A station that never got going failed for that, whether or not its run said so (a run that went on past it says nothing).
  if (neverStartedWords(d.decided.words)) return { key: `nosession:${stepId}`, label: NEVER_STARTED_CAUSE };
  // A timeout, a loop, a red check: the run's own reason says what happened. A dead end ("Prove gave no result") only
  // says the run stopped; the step's own words for the way it failed ("Could not write a test for the problem") say why.
  // A station that pinned itself blocked said what blocks it: that, whole, is why (a bug in a file it runs is one cause
  // for every run it blocks, cleared by that fix and never by its instructions).
  if (run?.blocked) { const b = blockerCause(stepId, run.blocked); return { key: b.key, label: b.label, blocked: run.blocked }; }
  if (run && !run.key.startsWith("deadend")) return { key: run.key, label: sentence(run.label) };
  // A check runner names what failed: "touched tests failed" groups every visit those checks stopped.
  const red = scriptChecks(d.decided.result)?.rows.filter((r) => !r.ok).map((r) => checkName(r.name)) ?? [];
  if (red.length) return { key: `checks:${red.join(",").toLowerCase()}`, label: sentence(`${red.join(", ")} failed`) };
  const evalWhy = evalFailWords(d.decided.result);
  if (evalWhy) return { key: `eval:${evalWhy.toLowerCase()}`, label: evalWhy };
  if (words && !BARE_FAIL.test(words)) return { key: `said:${words.toLowerCase()}`, label: sentence(plainOutcome(words)) };
  const said = words ? decisionSaid(d).replace(/[.…]+$/, "").trim() : concludedText(d.reasoning)?.split("\n")[0].replace(/[.…]+$/, "").trim();
  if (said && !BARE_FAIL.test(said) && said.length <= 120) return { key: `said:${said.toLowerCase()}`, label: sentence(said) };
  if (run) return { key: run.key, label: sentence(run.label) };
  if (own && !BARE_FAIL.test(own)) return { key: `out:${own.toLowerCase()}`, label: sentence(plainOutcome(own)) };
  // An agent's step that failed with no session behind it never got one: the runner could not start it.
  if (kind === "agent" && !d.received.sessionId) return { key: `nosession:${stepId}`, label: NEVER_STARTED_CAUSE };
  // A script that failed and printed nothing the line kept: what it is for says what failed ("Checks failed"), never why.
  const meant = d.decided.words?.trim();
  if (kind === "script") return { key: `noout:${stepId}`, label: `${meant && !BARE_FAIL.test(meant) ? meant : "Exited with an error"}, output not kept`, thin: true };
  return { key: "none", label: "No reason recorded", thin: true };
}

/** The state a For you wait puts its row in. */
const ASK_STATE: Record<string, WorkState> = { review: "review", unlanded: "unlanded", stopped: "stopped", fixed: "stopped" };

/** A landing step's visit that put nothing in place ("Not merged: merge off", "Not shipped: …"): never a pass, whatever
 *  its exit code said. */
const notLanded = (d: StepDecision): boolean => LANDING_STATIONS.has(d.id.slice(d.runId.length + 1)) && NOT_LANDED.test(d.decided.words);

function stateOf(d: StepDecision, input: StepWorkInput): WorkState {
  const { stopped } = input;
  if (d.superseded) return "replaced";
  if (tallyKey(d) !== "failed" && d.status !== "live" && d.status !== "waiting" && notLanded(d)) return "failed";
  if (tallyKey(d) === "failed" && input.review?.has(d.runId)) return "review";
  if (tallyKey(d) === "failed" && input.cleared?.has(d.runId)) return "passed";
  // A check that sent a finished station back is where its run failed, though the check itself ran to the end.
  if (d.status !== "waiting" && d.status !== "live" && input.causes?.get(d.runId)?.key.startsWith("sentback:")) return "failed";
  if (d.status === "waiting") return "waiting";
  if (d.status === "live") return d.answer?.state === "waiting" ? "waiting" : "running";
  // At a person's step only an answer is an answer: a lapsed or withdrawn decision is "No answer", whatever the run did next.
  if (d.answer) return d.answer.state === "answered" ? "passed" : d.answer.state === "waiting" ? "waiting" : "failed";
  if (stopped?.has(d.runId)) return "stopped";
  return tallyKey(d) === "failed" ? "failed" : "passed";
}

/** Problems lists the visit's problem anywhere but under a failure at this step. */
const elsewhere = (st: Standing | undefined, d: StepDecision): boolean => !!st && !st.failedAt?.includes(d.id.slice(d.runId.length + 1));

/** The step's rows under its three counts. */
export function stepWork(step: Pick<LineStep, "decisions"> & Partial<Pick<LineStep, "kind">>, input: StepWorkInput = {}): StepWork {
  const waiting: WorkRow[] = [];
  const passed: WorkRow[] = [];
  const replaced: WorkRow[] = [];
  const closed: WorkRow[] = [];
  const movedOn: WorkRow[] = [];
  const groups = new Map<string, FailGroup>();
  // A run's newest visit here: the one a wait For you lists is placed on.
  const newestOfRun = new Map<string, StepDecision>();
  for (const d of step.decisions) { const had = newestOfRun.get(d.runId); if (!had || (d.at ?? 0) > (had.at ?? 0)) newestOfRun.set(d.runId, d); }
  // One row per visit: a step that failed a problem twice and then passed it failed twice, and both failures say why.
  for (const g of decisionsByCase(step.decisions)) for (const d of [g.latest, ...g.earlier]) {
    const state = stateOf(d, input);
    // A problem's older visits name it by run; its newest by the problem, so a link to the problem opens that row.
    const row: WorkRow = { key: d === g.latest ? g.key : `run:${d.runId}`, d, earlier: d === g.latest ? g.earlier : [], state, cause: null };
    // A wait For you lists is this step's, on its run's newest visit here: Waiting, whatever the visit, a newer run or the
    // problem's status says, so every item For you shows is waiting on exactly one step.
    const ask = input.asks?.get(d.runId);
    if (ask && ask.step === d.id.slice(d.runId.length + 1) && newestOfRun.get(d.runId) === d) {
      row.ask = ask;
      row.state = d.status === "waiting" || d.status === "live" ? (state === "running" ? "waiting" : state) : ASK_STATE[ask.kind] ?? "waiting";
      if (row.state === "review") row.review = input.review?.get(d.runId) ?? { ask: null, gate: null };
      waiting.push(row);
      continue;
    }
    // A newer run of the problem came after this visit: where the problem stands is that run.
    const overtaken = d !== g.latest || (!!d.caseId && !!input.newest?.has(d.caseId) && input.newest.get(d.caseId) !== d.runId);
    if (state === "replaced") replaced.push(row);
    // A handoff or a finished step's yes that an older run asked for, of a problem a newer run has taken up since,
    // waits on nobody now: the yes would start a run beside the one already going on.
    else if ((state === "review" || state === "stopped") && overtaken) { row.state = "replaced"; const st = d.caseId ? input.standing?.get(d.caseId) : undefined; if (st) row.now = st.now; replaced.push(row); }
    else if (state === "review") { row.review = input.review!.get(d.runId)!; waiting.push(row); }
    else if (state === "waiting" || state === "running" || state === "stopped") waiting.push(row);
    else if (state === "passed") passed.push(row);
    else {
      row.cause = d.answer ? { key: `answer:${d.answer.state}`, label: DECISION_STATE_WORDS[d.answer.state] } : causeClass(failCauseOf(d, input.causes, step.kind));
      // What blocks the station is the run's, whichever words head its group: starting again meets it until it clears.
      const blocked = input.causes?.get(d.runId)?.blocked;
      if (blocked) row.blocked = blocked;
      if (d.caseId && input.closed?.has(d.caseId)) { row.problemClosed = true; closed.push(row); continue; }
      const head = causeHead(row.cause.label);
      if (head && head !== row.cause.label) row.cause = { ...row.cause, label: head, whole: row.cause.label };
      const had = groups.get(row.cause.key);
      // A problem that failed the same way twice is one row that says so, never two rows of one title.
      const same = had && d.caseId ? had.rows.find((x) => x.d.caseId === d.caseId) : undefined;
      if (same) (same.again ??= []).push(d);
      // A newer run of the problem came after this one: where it stands is that run, wherever it is now.
      else if (d.caseId && input.newest?.has(d.caseId) && input.newest.get(d.caseId) !== d.runId) { row.movedOn = true; movedOn.push(row); }
      else if (d.caseId && elsewhere(input.standing?.get(d.caseId), d)) { row.movedOn = true; row.now = input.standing!.get(d.caseId)!.now; movedOn.push(row); }
      else if (had) had.rows.push(row);
      else groups.set(row.cause.key, { ...row.cause, rows: [row] });
    }
  }
  // What a person can act on leads: a wait on them, then a stop, then what is only running. Oldest wait first.
  const rank: Record<string, number> = { waiting: 0, review: 0, unlanded: 0, stopped: 1, running: 2 };
  waiting.sort((a, b) => rank[a.state] - rank[b.state] || (a.d.at ?? 0) - (b.d.at ?? 0));
  if (input.ends) for (const g of groups.values()) g.stall = stallOf(g.rows.flatMap((r) => [r.d, ...(r.again ?? [])]), input.ends);
  // Most first; a cause nobody recorded never leads a tie, so the table's top cause is one a person can act on.
  const failed = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || Number(!!a.thin) - Number(!!b.thin) || a.label.localeCompare(b.label));
  return { waiting, failed, passed, replaced, closed, movedOn, counts: { waiting: waiting.length, failed: failed.reduce((n, g) => n + g.rows.length, 0), passed: passed.length } };
}

/** How far apart visits can end and still read as one stall: a runner that stops taking work stops it for hours. */
const STALL_SPAN = 6 * 3600_000;

/** The densest window of visits that hit their time limit within STALL_SPAN of each other, when it holds at least three
 *  and at least half of them: those ended together, so one thing stopped them (a machine, a runner, a budget). */
export function stallOf(visits: ReadonlyArray<Pick<StepDecision, "runId">>, ends: ReadonlyMap<string, RunEnd>): Stall | null {
  const at = visits.map((v) => ends.get(v.runId)).filter((e): e is RunEnd => !!e).sort((a, b) => a.at - b.at);
  let best: RunEnd[] = [];
  for (let i = 0, j = 0; j < at.length; j++) {
    while (at[j].at - at[i].at > STALL_SPAN) i++;
    if (j - i + 1 > best.length) best = at.slice(i, j + 1);
  }
  if (best.length < 3 || best.length * 2 < visits.length) return null;
  return { n: best.length, from: best[0].at, to: best[best.length - 1].at, machines: new Set(best.map((e) => e.device ?? "")).size, empty: best.filter((e) => e.empty).length };
}

/** The filter a step opens on when the address names none: what waits on the viewer there (a person's step's decisions,
 *  any step's finished-work yes), else everything. However a person reached the step (its node on the Map, its name in
 *  the table, the count's badge), what they can answer is open first. */
export function defaultShow(kind: StepKind, counts: Record<StepShow, number>, onYou = 0): StepShow | null {
  return (kind === "person" && counts.waiting > 0) || onYou > 0 ? "waiting" : null;
}

/** A count's name in the address, by the step's kind: a person's step says what its page says ("noanswer", "answered"),
 *  so a link reads the way the count it opens does. */
const SHOW_PARAM: Partial<Record<StepKind, Partial<Record<StepShow, string>>>> = { person: { failed: "noanswer", passed: "answered" } };
const SHOW_OF_PARAM: Record<string, StepShow> = { noanswer: "failed", answered: "passed" };
export const showParam = (kind: StepKind, show: StepShow): string => SHOW_PARAM[kind]?.[show] ?? show;
/** The filter an address names, under either name. */
export const readShow = (v: string | null | undefined): StepShow | null => (isStepShow(v) ? v : (v && SHOW_OF_PARAM[v]) || null);

/** The three counts' names by the step's kind: a person answers, an agent or a script passes. */
export function showLabels(kind: StepKind): Record<StepShow, string> {
  if (kind === "person") return { waiting: "Waiting", failed: "No answer", passed: "Answered" };
  return { waiting: "Waiting", failed: "Failed", passed: "Passed" };
}

/** Outcome keys the line's files use, as a person says them (LJ11). */
const PLAIN: Record<string, string> = {
  red: "reproduced: its test fails without the fix", green: "passes its test", mechanism: "cause found", dissolved: "turned out not to be a problem",
  "handed on": "passed on", open: "still a problem", refined: "problem restated", proposed: "fix proposed", built: "fix built",
  approved: "review approved", changes: "review asked for changes", "not reproduced": "could not reproduce it", infeasible: "cannot be tested",
  "judge defect": "the judge was wrong", "wrong cause": "cause was wrong", superseded: "replaced by a newer run", "cut off": "failed",
  "strategy fails": "the approach did not work",
};

/** An outcome as a person reads it: "red" (a proof that reproduced the problem) is "reproduced: its test fails without the fix", "not_reproduced" is "could not reproduce it". */
export function plainOutcome(key: string | null | undefined): string {
  const k = (key ?? "").replace(/_/g, " ").trim();
  return PLAIN[k.toLowerCase()] ?? k;
}

/** A handoff's "Outcome: <key>" line: its head, then the key. */
const OUTCOME_LINE = /^(\W*Outcome\W*:\W*)([a-z]+(?:_[a-z]+)*)\b/im;

/** The outcome key a handoff opens with ("Outcome: strategy_fails." is "strategy_fails"); null when it names none. */
export const handoffOutcome = (md: string | null | undefined): string | null => OUTCOME_LINE.exec(md ?? "")?.[2] ?? null;

/** A handoff's own "Outcome: strategy_fails." line in a person's words ("Outcome: the approach did not work."); the rest of the report as written. */
export const outcomeLineInWords = (md: string): string =>
  md.replace(OUTCOME_LINE, (m, head: string, key: string) => head + plainOutcome(key));

/** A report field's name as a person says it; null for a field that is the line's own bookkeeping. */
const FIELD_NAMES: Record<string, string | null> = {
  rung: "Test level", level: "Test level", check: "Command", command: "Command", cmd: "Command", red: "Test output", green: "Test output",
  output: "Test output", evidence: "Why", why: "Why", reason: "Why", detail: "Why", kind: "Why", into: "Folded into", residue: "Left over",
  files: "Files", statement: "Found", mechanism: "Cause", headline: "Change", dir: null, cwd: null, worktree: null, path: null, branch: "Branch",
  outcome: null, summary: null, session_id: null, run_id: null, task_id: null, scoped: null, select: "Tests chosen",
  // A check script's list of checks and its log folder: read as checks (checkRows); the folder is on the machine that ran it.
  steps: null, logs: null, ok: null,
};

/** A path on the machine that ran the step: nothing a reader can open. */
const MACHINE_PATH = /(?:^|[\s"'=(])(?:\/(?:Users|home|private|tmp|var|opt|root|mnt|srv|workspace)\/[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/g;

/** Text without the machine's own paths: a file under the checkout keeps its repo path, a bare temp path goes. */
export function withoutMachinePaths(text: string): string {
  return text.replace(MACHINE_PATH, (m) => {
    const lead = /^[\s"'=(]/.test(m) ? m[0] : "";
    const path = lead ? m.slice(1) : m;
    // Inside a checkout or worktree, the part after it is the repo path a person knows.
    const repo = path.match(/\/(?:src|worktrees?|checkouts?|repos?)\/[^/]+\/(.+)$/)?.[1];
    return repo ? `${lead}${repo}` : lead;
  }).replace(/[ \t]{2,}/g, " ").trim();
}

function fieldText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.values(x).map(fieldText).filter(Boolean).join(" · ") : fieldText(x))).filter(Boolean).join("\n");
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k.replace(/_/g, " ")}: ${fieldText(x)}`).join("; ");
}

export type ReportRow = { name: string; value: string; /** Printed text (a command, a test's output): shown in the fixed-width face. */ mono: boolean };

const MONO = new Set(["Command", "Test output", "Files", "Branch"]);

/** What a step reported, as rows a person reads: named in plain words, whole, machine paths and bookkeeping left out. */
export function reportRows(result: Record<string, unknown> | null | undefined): ReportRow[] {
  const out: ReportRow[] = [];
  for (const [k, v] of Object.entries(result ?? {})) {
    const known = k.toLowerCase() in FIELD_NAMES;
    const name = known ? FIELD_NAMES[k.toLowerCase()] : sentence(k.replace(/_/g, " "));
    // A yes or no under a key that names printed text ("red: false") says nothing a reader can use.
    if (!name || typeof v === "boolean" || v === "" || v == null || (Array.isArray(v) && !v.length)) continue;
    let value = withoutMachinePaths(fieldText(v));
    if (k === "kind") value = plainOutcome(value);
    if (k === "into" && /^[0-9a-f]{7,40}$/i.test(value)) continue;
    if (k === "residue" && value === "0") continue;
    if (!value) continue;
    const had = out.find((r) => r.name === name);
    if (had) had.value = `${had.value}\n${value}`;
    else out.push({ name, value, mono: MONO.has(name) });
  }
  return out;
}

/** A failure cause as a heading reads it: its first line, without machine paths, short enough to scan (the row shows it whole). */
export function causeHead(label: string): string {
  // A tool's printout leads with what passed ("✓ backend: 0 errors"): the heading is its first line that names a failure.
  const lines = label.split(/\n|(?=✓)|(?<=\))\s+(?=\.{0,2}\/)/).map((l) => l.trim()).filter((l) => l && !/^\d+$/.test(l));
  const bad = lines.length > 1 && lines[0].startsWith("✓") ? lines.find((l) => !l.startsWith("✓") && /\berror\b|✗|\bfail(?:ed|s)?\b/i.test(l)) : undefined;
  const first = withoutMachinePaths(bad ?? lines[0] ?? "").replace(/\s+/g, " ").trim();
  if (first.length <= 120) return first;
  // A tool's error ends its sentence before the runtime's own trailer ("…selection.ts'. Bun v1.3.2"): stop there, whole.
  const end = [...first.slice(0, 200).matchAll(/[.!?]['")]?(?=\s+[A-Z])/g)].map((m) => m.index! + m[0].length).filter((i) => i >= 40).pop();
  return end ? first.slice(0, end) : `${first.slice(0, 119).trimEnd()}…`;
}

/** A step's own words without the JSON block it reported beside them, and without machine paths. */
export function concludedText(reasoning: string | null | undefined): string | null {
  const t = withoutMachinePaths((reasoning ?? "").replace(/```(?:json)?[ \t]*\n[\s\S]*?\n[ \t]*```/g, "").replace(/\n{3,}/g, "\n\n").trim());
  if (!t || /^[{[]/.test(t)) return null;
  return t;
}

/** The decision a session presented for one waiting visit: the pending card of that run at that step, the newest when several. */
export function visitDecision<C extends { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number }>(
  cards: Iterable<C>, runId: string, stepId: string, status: "pending" | "any" = "pending",
): C | null {
  let best: C | null = null;
  for (const c of cards) {
    if (c.workflow_run_id !== runId || (status === "pending" && c.status !== "pending")) continue;
    // A card that names its gate must name this one; an older card with no gate belongs to its run's one person step.
    if (c.gate_node_id && c.gate_node_id !== stepId) continue;
    if (!best || (c.created_at ?? 0) > (best.created_at ?? 0)) best = c;
  }
  return best;
}
