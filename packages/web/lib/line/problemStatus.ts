// Where a problem stands, as the Problems page files it (line-journeys.md
// LJ8.2): eleven statuses that partition the problems, so the chips sum to All
// and each chip's count is the rows it opens. The first match wins, in the
// order of PRECEDENCE; the phrase is the row's one statement of state. Pure:
// the caller hands in what the store knows about each problem (its need, its
// failure, its task row), so the reading of a need has one home (lineNeeds).
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import { ageShort, type LineCauseTask } from "../lineFlow";
import type { CauseHistory } from "./causeHistory";
import type { LineIssue } from "./lineModel";
import type { NeedKind } from "./lineNeeds";
import { NO_STEP, dayWords, notStartedWhy, problemBand, problemNow, type BandInput, type BandNeed, type BandNote, type BandTask, type NotStartedFacts } from "./problemPage";
import { neverShipped } from "./timeline";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { handoffOutcome, plainOutcome } from "./stepWork";

export type StatusKey = "you" | "others" | "newask" | "failed" | "running" | "notstarted" | "approved" | "merged" | "shipped" | "trial" | "closed";

/** The chips' order, and the table's groups: what a person can move first, then what is moving, then what is done. */
export const STATUS_ORDER: ReadonlyArray<StatusKey> = ["you", "others", "newask", "failed", "running", "notstarted", "approved", "merged", "shipped", "trial", "closed"];

export const STATUS_LABELS: Record<StatusKey, string> = {
  you: "Waiting on you",
  others: "Someone else",
  newask: "Needs a new ask",
  failed: "Failed",
  running: "Running",
  notstarted: "Not started",
  approved: "Approved, not merged",
  merged: "Merged",
  shipped: "In production",
  trial: "Trial",
  closed: "Closed",
};

export const isStatusKey = (v: string | null | undefined): v is StatusKey => !!v && (STATUS_ORDER as readonly string[]).includes(v);

/** What waits on a person about a problem (lineNeeds' kinds), and whether the viewer holds it. */
export type ProblemNeed = { kind: NeedKind; mine: boolean; /** A reask: why no answer can land. */ why?: string | null; /** For a stopped run: the step it stopped at, in words, and its yes in one line (lineNeeds stoppedAsk). */ step?: string | null; ask?: string | null; /** The run that raised it. */ runId?: string | null; /** A trial's practice decision (lineNeeds isPractice). */ trial?: boolean };

/** What the store knows about one problem besides its history. */
export type ProblemFacts = {
  need?: ProblemNeed | null;
  /** Its newest run failed at a step: the cause's key (runReport failCause), the cause in words, the step in words, and
   *  the line steps it names by id (the step it stopped at and the check that drove it), which a problem about that step
   *  of the line itself (lineStepsOf) can hold. */
  failed?: { key: string; label: string; step: string | null; steps?: ReadonlyArray<string> } | null;
  /** A live run that has said nothing past its threshold, and since when. */
  silent?: { since: number } | null;
  /** The stage its live run is in. */
  stage?: LinePhaseKey | null;
  task?: Pick<LineCauseTask, "status" | "workflow_run_id" | "readiness" | "goal_ref" | "assignee" | "closed_at" | "cause"> & { readiness_note?: string | null } | null;
  /** The problem's notes (task comments), oldest first: an escalation's reason and a park's record read here. */
  notes?: ReadonlyArray<BandNote>;
  /** Grounding parked it until more findings come (lineInbox waitsForFindings): no answer unblocks it. */
  awaitsFindings?: boolean;
  /** The handle of the role whose area holds its project (the lead its line runs as): a fact grounding needs is asked of
   *  that role, never of the viewer. Null when no role holds the project. */
  lead?: string | null;
  /** Its project's line is on: a ready problem is queued, not merely ready. */
  lineOn?: boolean | null;
  /** What a ready one says in place of "Queued" while its trial's dispatcher holds it. */
  idle?: string | null;
  assigneeName?: string | null;
  /** Its newest run is a trial's: an answer at its card is recorded and ships nothing. */
  trial?: boolean;
  /** The step its newest run's trace says failed, in words, when no failure row names one, and by id. */
  failedStep?: string | null;
  failedNode?: string | null;
  /** The problem's newest handoff (the task's verification evidence): a station that gave up opens it with its outcome
   *  ("Outcome: strategy_fails."). */
  handoff?: string | null;
  /** It is a problem with the line itself, about these steps by id (problemTable lineStepsOf): while it is open, runs
   *  that failed at one of them wait on its fix. */
  aboutSteps?: ReadonlyArray<string>;
  /** What its newest run's landing step printed (problemPage landingOutput): a refusal for being behind is an approved fix. */
  shipOutput?: string | null;
  /** Its newest run is paused at a person's step (a plan to approve, a fix to decide, a builder's question): the
   *  step's id and since when. The question is open whoever holds it, so the problem is never "paused, nothing asked". */
  gate?: { node: string; since: number | null; /** Whose queue the question sits in, by name; null when not known. */ holder?: string | null } | null;
};

export type ProblemStand = {
  status: StatusKey;
  /** The Status column's words. */
  phrase: string;
  /** Failed: the cause it groups under, in plain words, and the line steps it names by id. */
  cause?: { key: string; label: string; steps?: ReadonlyArray<string> };
  /** In production: no finding since the fix reached it. */
  quiet?: boolean;
  /** Not started: the sweep would start it (the rest are blocked, and the phrase says why). */
  ready?: boolean;
  /** Its act, there on its row. Needs a new ask: `ask` starts a run that asks again; `reopen` reopens a close that
   *  findings kept coming after; `fixed` closes one whose fix main already carries; `close` closes one grounding or a parked run found nothing to change in; `noevidence` closes one opened
   *  on a finding that says nothing, as the reader does ("Close: no evidence"). Not started: `start` starts
   *  one whose last run ended (the sweep passes it by), through the paced review. Approved, not merged: `merge` lands
   *  the fix (its pull request, opened or merged, through Ship's review). `nogoal`: closes one grounding parks every run
   *  for serving no goal. `mergeinto`: a twin folded under its older problem merges into it (problemTable foldTwins).
   *  `opengate`: a question its newest run holds open for someone else, opened where it can still be answered.
   *  `shipbuilt`: Failed, with a fix an earlier run built and nobody answered (problemPage builtUnanswered): it lands. */
  act?: "ask" | "reopen" | "close" | "fixed" | "noevidence" | "start" | "merge" | "nogoal" | "mergeinto" | "opengate" | "shipbuilt";
  /** `opengate`: the person's step its run waits at, by id. */
  gate?: string;
};

/** What a person's step a run waits at asks for, as a row says it: "Plan to approve". */
export const gateWords = (node: string): string => (node === "plan_gate" ? "Plan to approve" : node === "ask" ? "Builder's question" : node === CARD_GATE_NODE_ID ? "Fix to decide" : "Question to answer");
/** The act that opens it: "Open the plan". */
export const gateOpenWords = (node: string): string => (node === "plan_gate" ? "Open the plan" : node === "ask" ? "Open the question" : node === CARD_GATE_NODE_ID ? "Open the fix" : "Open the question");

/**
 * The fix a problem's newest close shipped, when it did ship one: whether a production deploy carried it, the
 * findings since, and its watch. Null when the newest close was not a fix, or the run only went on past a decision
 * nobody answered (timeline neverShipped): that is a lapsed ask, not a fix.
 */
export function fixOut(h: CauseHistory): { inProduction: boolean; at: number; since: number; watchEnd: number | null; merged: boolean; deploysKnown: boolean } | null {
  const close = h.closes[h.closes.length - 1];
  if (close?.kind !== "shipped") return null;
  const ship = h.ships.find((s) => s.runId === close.runId);
  const attempt = h.attempts.find((a) => a.runId === close.runId);
  if (neverShipped(attempt, ship)) return null;
  const inProduction = !!ship?.deploys.length;
  const watch = h.watches.find((w) => w.runId === close.runId);
  return {
    inProduction,
    at: ship?.deploys[0]?.at ?? ship?.merge?.at ?? attempt?.merge?.at ?? ship?.at ?? close.at,
    since: h.regressions.filter((r) => r.afterRunId === close.runId).reduce((n, r) => n + r.count, 0),
    watchEnd: watch?.state === "watching" ? watch.end : null,
    merged: !!(ship?.merge || attempt?.merge),
    deploysKnown: h.coverage.state === "known",
  };
}

/** The line steps a failure names, when any: what a problem with that step of the line holds. */
const stepsOf = (f: ProblemFacts): { steps?: ReadonlyArray<string> } => {
  const steps = f.failed?.steps ?? (f.failedNode ? [f.failedNode] : []);
  return steps.length ? { steps } : {};
};

/** One problem's status and phrase, read off the same band its page draws (problemPage problemBand / problemNow), so a
 *  row and its page never disagree. The list hands in what it knows without the run's visits: its need, its failure or
 *  silence, its live stage, its task and notes. */
export function problemStand(issue: Pick<LineIssue, "history" | "status"> & Partial<Pick<LineIssue, "ask" | "findings" | "dissolvedWhy" | "lineFaults">>, f: ProblemFacts, now: number): ProblemStand {
  const h = issue.history;
  const why = notStartedWhy({ task: (f.task ?? null) as NotStartedFacts["task"], lineOn: f.lineOn ?? null, idle: f.idle, awaitsFindings: f.awaitsFindings, cameBack: h.cameBack || h.regressed, assigneeName: f.assigneeName, attempts: h.attempts });
  // An approved fix nothing merged is the approved band's own (its act lands it), never a need the band reads.
  const need = f.need?.kind === "unlanded" ? null : f.need ?? null;
  const asked = need && (need.kind === "decision" || need.kind === "question" || need.kind === "confirm");
  // The newest run waits at a person's step that nobody's queue here carries: someone else holds the question, and it
  // can still be answered from the problem's page. Read before the run's paused state, which only says nothing moves.
  const gate = !need && !f.trial && f.gate ? f.gate : null;
  const row: BandInput["row"] = f.failed ? { kind: "failed", at: null, detail: f.failed.label, fail: { key: f.failed.key, label: f.failed.label, step: f.failed.step } as NonNullable<BandInput["row"]>["fail"] }
    : f.silent ? { kind: "stalled", at: f.silent.since, detail: null } : null;
  const band = problemBand({
    issue: { ask: null, findings: 0, dissolvedWhy: null, ...issue } as LineIssue, history: h, run: null,
    // A need someone else holds is a decision open elsewhere: the band reads it as waiting on someone else.
    need: need && (need.mine || !asked) ? { kind: need.kind, since: null, fail: need.step ? { step: need.step } as BandNeed["fail"] : null, runId: need.runId ?? null, ask: need.ask ?? null, why: need.why ?? null, trial: !!need.trial } : null,
    decision: (need && !need.mine && asked) || gate ? { ref: "", since: gate?.since ?? null, mine: false } : null,
    row, failedStep: f.failedStep ?? null, task: (f.task ?? null) as BandTask | null, lineOn: f.lineOn ?? null, idle: f.idle, trial: f.trial, holderName: f.assigneeName, stage: f.stage ?? null, notStarted: why, notes: f.notes, now, shipOutput: f.shipOutput ?? null,
  });
  const { status, phrase } = problemNow(band);
  // A fact grounding needs (a question, or whether a new problem is real) is the project's lead role's to answer, in
  // that role's queue: Someone else, named, never the viewer's.
  if (f.lead && !f.trial && (band.kind === "need" ? band.need === "question" || band.need === "confirm" : band.kind === "ask" && !band.unsupported)) return { status: "others", phrase: `${phrase} · @${f.lead}` };
  if (gate && band.kind === "decision") return { status, phrase: [gateWords(gate.node), gate.holder ?? f.assigneeName].filter(Boolean).join(" · "), act: "opengate", gate: gate.node };
  if (band.kind === "failed") {
    // No failure row names a cause: the station's own handoff, when it opens with an outcome, is the cause
    // ("The approach did not work at Build"), never "<step> failed".
    const said = !f.failed ? handoffCause(f.handoff, band.step) : null;
    // A fix an earlier run built waits on the answer nobody gave: landing it is the act, never proving it again.
    const ship = band.built ? { act: "shipbuilt" as const } : {};
    if (said) return { status, phrase, cause: { ...said, ...stepsOf(f) }, ...ship };
    const key = f.failed?.key ?? `failed-at:${band.step.toLowerCase()}`;
    // A failure whose step nothing recorded is one plain heading, never "a step gave up".
    return { status, phrase, cause: { key, label: f.failed?.label ?? (band.step === NO_STEP ? "Stopped without a reason recorded" : `${band.step} failed`), ...stepsOf(f) }, ...ship };
  }
  if (band.kind === "stalled") return { status, phrase, cause: { key: "silent", label: "No progress" } };
  if (band.kind === "escalated") return { status, phrase, cause: { key: `escalated:${band.step.toLowerCase()}`, label: `${band.step} handed it back` } };
  // The line itself kept failing on the very fault the fix was for (lineFaults): the fix did not hold. It leaves In
  // production for Needs a new ask, beside closes findings came back after, and is reopened from its row.
  if (band.kind === "production" && band.faults.length) {
    const f = band.faults[0];
    return { status: "newask", phrase: `Fix didn't hold: ${f.stepLabel} failed on it ${band.faults.length === 1 ? "once" : `${band.faults.length}x`} since ${dayWords(band.liveAt)}`, act: "reopen" };
  }
  if (band.kind === "production") return { status, phrase, quiet: band.since === 0 };
  if (band.kind === "notstarted" && band.nothing != null) return { status, phrase, act: "close" };
  if (band.kind === "notstarted") return { status, phrase, ready: why.ready, ...(why.byHand ? { act: "start" as const } : {}) };
  if (band.kind === "parked" && band.fixedSha) return { status, phrase, ready: false, act: "fixed" };
  // A run paused with nothing asked is still live: a new run is refused while it holds the problem, so it has no act here.
  if (status === "newask") return { status, phrase, ...(band.kind === "need" && band.need === "reask" && !band.why ? {} : { act: band.kind === "returned" ? "reopen" as const : band.kind === "ask" ? "noevidence" as const : "ask" as const }) };
  if (band.kind === "parked" && !band.fixedSha && band.readiness === "not_actionable") return { status, phrase, ready: false, act: "close" };
  // Parked for serving no goal: every run parks it again, so its act is closing it (or a goal, which its page links).
  if (band.kind === "parked" && band.noGoal && !band.fixedSha) return { status, phrase, ready: false, act: "nogoal" };
  if ((band.kind === "parked" && !band.fixedSha) || band.kind === "morefindings") return { status, phrase, ready: false };
  // Approved and not merged (approvedFix, the rule For you's group of the same name reads): one chip holds every one,
  // its age saying how long it has sat. One the landing refused (behind main) is landed again from its page.
  if (band.kind === "approved") return { status, phrase: band.behind ? phrase : `Approved${band.at ? ` ${dayWords(band.at)} (${ageShort(now - band.at)})` : ""}, not merged`, ...(band.behind ? {} : { act: "merge" as const }) };
  return { status, phrase };
}

/** A failure's cause from the station's handoff: its outcome in a person's words at the step ("The approach did not
 *  work at Build"), or for a bare "failed", what it gave up on, in its own first sentence ("Gave up at Propose: the red
 *  check is still red"). Null when the handoff names no outcome. */
export function handoffCause(handoff: string | null | undefined, step: string): { key: string; label: string } | null {
  const outcome = handoffOutcome(handoff);
  if (!outcome) return null;
  const at = step === NO_STEP ? "" : ` at ${step}`;
  if (outcome !== "failed") {
    const words = plainOutcome(outcome);
    return { key: `outcome:${outcome}:${step.toLowerCase()}`, label: `${words.charAt(0).toUpperCase()}${words.slice(1)}${at}` };
  }
  // The sentence after its outcome line, its last clause when it turns on a "but": what it could not get past.
  const rest = (handoff ?? "").replace(/^[\s\S]*?Outcome\W*:\W*failed\.?\s*/i, "");
  const first = /^[^\n]*?[.!?](?=\s|$)/.exec(rest)?.[0] ?? rest.split("\n")[0];
  const why = (/,\s*but\s+(.+)$/i.exec(first)?.[1] ?? first).replace(/[.!?]+$/, "").trim();
  const short = why.length > 80 ? `${why.slice(0, why.lastIndexOf(" ", 80))}…` : why;
  return { key: `outcome:failed:${step.toLowerCase()}`, label: `Gave up${at}${short ? `: ${short}` : ""}` };
}
