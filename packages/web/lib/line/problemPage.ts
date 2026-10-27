// What one problem's page holds (line-journeys.md LJ8.3), derived once and
// pure: the act band's state (every problem has exactly one), the one line
// that states it beside the stage track, the runs as Work rows, and a
// finding's own text and where it leads. The components only draw this.
import { underBarWords, type UnderBar } from "./flowBar";
import { type CauseHistory, type HistoryAttempt } from "./causeHistory";
import { unlandedFix } from "./approvedFix";
import type { InboxRow } from "./lineInbox";
import { askParts, fixedOnMain, waitsForFindings } from "./lineInbox";
import { repeatedFindings, restsOnNothing, subjectWords } from "./findingEvidence";
import type { LineIssue, LineRunModel } from "./lineModel";
import type { LineFault } from "./lineFaults";
import { stoppedAsk, type LineNeed, type NeedKind } from "./lineNeeds";
import { STAGE_DOING, STAGE_WORDS, firstFailedVisit, type StageOf } from "./stageTrack";
import { findingTitle } from "./loopSteps";
import { closeOf, closeSentence } from "./scriptReport";
import { shortDay, stepLabel } from "./runReport";
import type { StatusKey } from "./problemStatus";
import { attemptVerdict, problemState, shownWatches } from "./timeline";
import { startableCause, type LineCauseTask } from "../lineFlow";
import { decisionOutcome } from "./decisionOutcome";
import { wouldLabel } from "./fixDecision";
import { guessPhase, type LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import { ASK_LINE } from "@codecast/shared/contracts/personAsk";
import { NO_GOAL } from "@codecast/shared/contracts/goalsBrief";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";

export const dayWords = shortDay;
export const dayTimeWords = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A span in a person's units: "42m", "2h", "3d". */
export function spanShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h * 10) / 10}`.replace(/\.0$/, "") + "h";
  return `${Math.round(h / 24)}d`;
}

/** A stored note that was cut at its cap ends mid-word: read it to its last full sentence (LJ3 rule 8). */
export function wholeSentences(text: string | null | undefined, cap = 500): string {
  const raw = text ?? "";
  const t = raw.trim();
  // Measured before trimming: a cut that landed on a space leaves one character fewer once trimmed.
  if (raw.length < cap && !/…$/.test(t)) return t;
  if (/[.?!]["')\]]?$/.test(t)) return t;
  const cut = t.replace(/…$/, "");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  // One long sentence cut short keeps its ellipsis: without it the cut reads as the sentence's real end.
  return end > 40 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** A problem's title as every page heads it (its page, its runs), cut at a whole sentence. A judge's "Not met:" stays:
 *  it is what makes an expectation's words name a miss. */
export const problemTitle = (title: string): string => wholeSentences(title.replace(/^not met:\s*/i, "Not met: "), 200);

/** What a question asks for, beyond yes or no (LJ6.2): the parts it names in a list ("(duration, who sees it, whether it
 *  hides the cause from review)"), and whether it asks for any content at all ("what snoozing should do"). A question
 *  that asks for content cannot be answered by a bare yes: the answer is required, one field per named part. */
export function askShape(question: string): { required: boolean; parts: string[] } {
  const q = question.replace(/\s+/g, " ").trim();
  const list = [...q.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(/\s*,\s*|\s*;\s*|,?\s+(?:and|or)\s+(?=[a-z]+\b)/i).map((x) => x.trim()).filter(Boolean)).find((xs) => xs.length >= 2 && xs.length <= 6 && xs.every((x) => x.split(" ").length <= 9 && !/^(so|e\.g|i\.e)\b/i.test(x)));
  const parts = (list ?? []).map((x) => x.replace(/^(?:and|or)\s+/i, "").replace(/[.?]$/, "")).map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  // Asking "what"/"how"/"which" (outside a "whether" clause) asks for content.
  const content = /\b(?:what|how|which|who|when|where)\b/i.test(q.replace(/\([^()]*\)/g, "").replace(/\bwhether\b[^,.;]*/gi, ""));
  return { required: parts.length > 0 || content, parts };
}

// ── the act band ─────────────────────────────────────────────────────────────

export type BandTask = {
  status: string; readiness?: string | null; readiness_note?: string | null; goal_ref?: unknown; assignee?: string | null; workflow_run_id?: string | null;
  assignee_info?: { name?: string | null } | null; closed_at?: number | null; updated_at?: number | null; project_id?: string | null;
  /** Where it came from and its description: a problem a finder opened on a finding that says nothing (findingEvidence). */
  source?: string | null; description?: string | null;
};

/** What waits on a person about the problem (lineNeeds needOfCase), as far as the band reads it. */
export type BandNeed = Pick<LineNeed, "kind" | "since" | "fail"> & Partial<Pick<LineNeed, "why" | "trial" | "publishes">> & { runId?: string | null; /** A stopped run's yes in one line, when the caller read it already. */ ask?: string | null };

export type ProblemBand =
  /** Something waits on a person: the one reader (WaitingItem) shows it and holds its act. */
  | { kind: "need"; need: NeedKind; since: number | null; /** For a stopped run: the step it ended at. For a lapsed fix: when it was asked. */ step: string | null; askedAt: number | null; /** A lapsed fix's card was taken back unanswered. */ withdrawn?: boolean; /** A stopped run's yes in one line (lineNeeds stoppedAsk): "Prove finished: go on to Build?". */ ask?: string | null; /** A reask: why no answer can land (lineNeeds why). */ why?: string | null;
      /** A trial run's decision (lineNeeds isPractice): an answer is recorded and ships nothing. */ trial?: boolean }
  /** A fix decision open on the problem that is not in the viewer's own queue: read and answerable all the same. */
  | { kind: "decision"; ref: string; since: number | null; /** Asked of the viewer; null while who was asked is not read yet. */ mine: boolean | null }
  /** A question the problem holds on that the needs do not carry (a project outside the filter): the Ask block. */
  | { kind: "ask"; question: string; note: string; required: boolean; /** Opened on a finding that says nothing: nothing to ask, a person closes it. */ unsupported?: boolean }
  | { kind: "failed"; /** A spend limit refused the work of the step: nothing about the problem stopped it. */ cap?: boolean; /** A fix an earlier run built and put to a decision nobody answered (builtUnanswered): it lands from here. */ built?: { runId: string; ref: string | null } | null; step: string; reason: string | null; output: string | null; after: number | null; node: string | null; runId: string | null; at: number | null; /** The step finished and said nothing: no report, so nothing to approve (runReport `deadend-silent`). */ silent?: boolean; /** The step's own word for why it stopped short, never a failure of its work: "blocked", "waiting", "found no miss" (runReport unfinishedWords). */ stop?: string | null; /** With no step on record (NO_STEP): how the run's own record says it ended ("Stopped: the evals could not score the change."), else null for a run that recorded nothing. */ ended?: string | null }
  | { kind: "stalled"; stage: string; step: string | null; node: string | null; silentMs: number; last: string | null; runId: string | null }
  | { kind: "running"; stage: string; doing: string; step: string; ms: number; runId: string | null; /** The live step's session, when it has one. */ sessionId?: string | null }
  | { kind: "merged"; mergedAt: number; link: string | null; sha: string | null; recorded: "known" | "none" | "unread"; /** The project's newest recorded production deploy, when any is. */ lastDeploy: { at: number; url: string | null } | null }
  | { kind: "production"; mergedAt: number | null; link: string | null; sha: string | null; liveAt: number; target: string | null; deployUrl: string | null; deployRef: string | null; watchEnd: number | null; watch: "watching" | "quiet" | "reopened" | null; since: number; sinceOff: number;
      /** The line's own runs that failed on the fault this problem is about after it went live (lineFaults): it is not quiet. */
      faults: LineFault[] }
  /** Approved and the run went on to ship, but no merge is recorded: the fix sits on its branch. `mergeOff`: the ship
   *  step said the line's merge step is off (null when it said nothing about it). `change`: what the fix changes. */
  | { kind: "approved"; at: number | null; ref: string | null; /** Who answered Ship, by name, when a person did. */ by: string | null; mergeOff: boolean | null; change: HistoryAttempt["diff"]; runId: string;
      /** The landing step refused the branch because this default branch moved past it ("main"): the run picks up at
       *  Rebase to land it (convex landAgainCore). Null when nothing refused it so. */
      behind: string | null;
      /** Whether customers have it: the project's deploys as recorded, and the newest one, so "No" says since when. */
      recorded: "known" | "none" | "unread"; lastDeploy: { at: number; url: string | null } | null;
      /** An earlier run of this problem merged a different fix: a finding that names that merge is about it, not this one. */
      earlier: { n: number; sha: string; at: number; prUrl: string | null } | null }
  /** The newest run handed the problem back at a step with no card or question to answer (AgentWatch's
   *  escalated_at_refine): what it refused, in its own words, and the count behind it when it gave one. */
  | { kind: "escalated"; step: string; at: number | null; why: string | null; rejects: { n: number; of: number } | null; runId: string }
  /** The newest run parked the problem before building: why, from the park record (the task's readiness and its note).
   *  `fixedSha`: the note says main already carries the fix. `noGoal`: grounding found it ready but serving no goal, so
   *  every run parks it again until a goal covers it (the graph's ground -> park edge). `times`: the runs in a row, newest
   *  back, that ended parked. */
  | { kind: "parked"; at: number | null; why: string | null; readiness: string | null; fixedSha: string | null; noGoal: boolean; times: number; runId: string }
  /** The newest run ended with its fix decision unanswered (decisionOutcome withdrawn or lapsed) and nothing shipped:
   *  the decision as it was asked, and the acts that still move the problem (drop it, or a new run that asks again).
   *  `withdrawn`: the card itself was taken back; `askedAt`: when it was asked; `at`: when it stopped being answerable. */
  | { kind: "unanswered"; ref: string | null; withdrawn: boolean; askedAt: number | null; at: number | null; recommend: string | null; built: boolean; runId: string }
  /** A trial run's fix decision was answered: recorded, and nothing shipped (a trial never merges). `verb`: the option
   *  chosen ("Ship"). */
  | { kind: "trial"; verb: string; at: number | null; ref: string | null; change: HistoryAttempt["diff"]; runId: string }
  /** The task sits in review and nothing else on record says more. `holder`: the person it is assigned to, when one is;
   *  `answer`: what a person last chose on the newest run's card, when they did. */
  | { kind: "review"; since: number | null; holder: string | null; age: number | null; answer: string | null; runId: string | null }
  | { kind: "morefindings"; has: number; needs: string | null }
  /** Its newest run closed it without a fix (not a problem, or dropped), and findings kept arriving after: the close is
   *  in doubt. `since`: findings after the close; `off`: how many of them cite another expectation than the problem's
   *  (about something else, when the page has read them; 0 otherwise). */
  | { kind: "returned"; at: number; how: "not a problem" | "dropped"; since: number; off: number; runId: string | null }
  | { kind: "closed"; at: number | null; how: string | null; why: string | null }
  /** `restart`: its last run ended and the task still points at it, so the sweep will not start it: only a start by hand. */
  | { kind: "notstarted"; lineOn: boolean | null; reason: string | null; restart: boolean; /** Grounding found nothing to change: its note, whole (the one act is a person's close). */ nothing?: string | null };

/** A note on the problem (its task comments): the escalation and park records read their reason here. */
export type BandNote = { author?: string; text: string; created_at: number };

export type BandInput = {
  issue: LineIssue;
  /** The problem's history as the page reads it (off-topic comebacks taken out). */
  history: CauseHistory;
  /** Its newest run on the process drawn. */
  run: LineRunModel | null;
  need: BandNeed | null;
  /** An open fix decision on the problem (fixDecision openFixDecisionFor), whoever holds it. */
  decision: { ref: string; since: number | null; mine: boolean | null } | null;
  /** Its row among the failed and silent runs (lineInbox), when it has one. */
  row: Pick<InboxRow, "kind" | "at" | "detail" | "fail"> | null;
  task: BandTask | null;
  lineOn: boolean | null;
  /** What a ready one says in place of "Queued" while its trial's dispatcher holds it (NotStartedFacts idle). */
  idle?: string | null;
  /** The newest run is a trial's (useLineWorkspace trialRuns): an answer at its card is recorded and ships nothing. */
  trial?: boolean;
  /** The name of the person the problem is assigned to, when it is. */
  holderName?: string | null;
  /** The name of the person who answered the newest run's card, read off the decision itself. */
  approver?: string | null;
  /** Findings after the newest fix that cite another expectation than the problem's. */
  offTopic?: number;
  /** What the newest run's ship (or merge) step printed, whole: why a fix approved to ship did not merge. */
  shipOutput?: string | null;
  /** The problem's notes, oldest first: where an escalated run said why it handed the problem back. */
  notes?: ReadonlyArray<BandNote>;
  /** The stage a live run is in, when the caller knows it without the run's visits (the Problems list). */
  stage?: LinePhaseKey | null;
  /** The step the newest run's trace says failed, in words, when the caller has no visits (the Problems list). */
  failedStep?: string | null;
  /** Why it has not started, when the caller already read it (notStartedWhy). */
  notStarted?: { phrase: string; ready: boolean } | null;
  stageOf?: StageOf;
  now: number;
};

const stageKey = (node: string | null | undefined, label: string | undefined, stageOf?: StageOf): LinePhaseKey => (node ? stageOf?.(node, label) ?? guessPhase(node, label) : "understand");

/** A step's own last words, when it said any: never an outcome word standing in for them. */
const visitSaid = (v: { decided: { words: string }; why: string | null } | null | undefined): string | null => {
  const t = (v?.why ?? v?.decided.words ?? "").trim();
  return t && !/^(failed|done|running|waiting|success|failure)$/i.test(t) ? t : null;
};

/** What the newest landing step (ship or merge) of a run printed, whole; null when it has none. */
export const landingOutput = (nodes: ReadonlyArray<{ node_id: string; result_preview?: string | null }> | null | undefined): string | null =>
  [...(nodes ?? [])].reverse().find((n) => n.node_id === "ship" || n.node_id === "merge")?.result_preview ?? null;

/** The newest landing attempt (ship or merge) an earlier run of a problem made that failed, while a newer run asks to
 *  ship again (ct-59561: Run 5's ship refused a branch behind main and exited 1; Run 6 presents Ship again). `n` is the
 *  run's number among the problem's runs, oldest first, as Work numbers them; `said` what the step printed first, the
 *  refusal in its own words. Null when the newest run is itself past landing, or no earlier landing failed. */
export function lastShipFailure(runs: ReadonlyArray<{ _id: string; created_at?: number | null; node_statuses?: ReadonlyArray<{ node_id: string; status?: string; completed_at?: number; started_at?: number; result_preview?: string | null }> | null }>): { runId: string; n: number; at: number | null; said: string | null; behind: boolean } | null {
  const ordered = [...runs].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  const newest = ordered[ordered.length - 1];
  const landing = (r: (typeof ordered)[number]) => [...(r.node_statuses ?? [])].reverse().find((n) => n.node_id === "ship" || n.node_id === "merge");
  if (!newest || landing(newest)) return null;
  for (let i = ordered.length - 2; i >= 0; i--) {
    const step = landing(ordered[i]);
    if (!step) continue;
    if (step.status !== "failed") return null;
    const said = (step.result_preview ?? "").split("\n").map((l) => l.trim()).find((l) => l && !/^ok\b/i.test(l)) ?? null;
    return { runId: ordered[i]._id, n: i + 1, at: step.completed_at ?? step.started_at ?? null, said: said?.replace(/^line:\s*/i, "") ?? null, behind: /\bbehind\b/i.test(step.result_preview ?? "") };
  }
  return null;
}

/** Each problem's newest run, by when it was made: its trace and its landing output are read off this one. */
export function newestRuns<R extends { task_id?: string | null; created_at?: number | null }>(runs: ReadonlyArray<R>): Map<string, R> {
  const out = new Map<string, R>();
  for (const r of runs) if (r.task_id && (out.get(r.task_id)?.created_at ?? -1) < (r.created_at ?? 0)) out.set(r.task_id, r);
  return out;
}

/** Whether a ship step said it did not merge because the line's merge step is off ("not merged: merge is off for this
 *  line ..."): true, false when it gave another reason, null when it said nothing about merging. */
export function mergeStepOff(text: string | null | undefined): boolean | null {
  const m = (text ?? "").match(/not merged:\s*([^\n]+)/i);
  return m ? /merge is off/i.test(m[1]) : null;
}

export type NotStartedFacts = {
  task: (BandTask & { workflow_run_id?: string | null; cause?: { signal_count?: number } | null }) | null;
  lineOn?: boolean | null;
  /** What a ready one says in place of "Queued" while something past the switch holds it (a trial's dispatcher held). */
  idle?: string | null;
  /** Grounding parked it until more findings come. */
  awaitsFindings?: boolean;
  /** Its live flow's bar holds it (underBarOf): it waits for another finding. */
  underBar?: UnderBar | null;
  /** It came back after a close. */
  cameBack?: boolean;
  assigneeName?: string | null;
  /** The problem's runs, when the caller has its history: an earlier run holds it only while that run is live. */
  attempts?: ReadonlyArray<Pick<HistoryAttempt, "runId" | "n" | "live">>;
};

/** Why a problem nothing is working on has not started, and whether the sweep would start it (LJ11): the one reading the
 *  Problems row and the problem's page share. A ready one reads "Queued" where its line is on, else says what is missing. */
export function notStartedWhy(f: NotStartedFacts): { phrase: string; ready: boolean; byHand?: boolean; /** Waits for another finding: under its flow's bar. */ waits?: boolean } {
  const t = f.task;
  const blocked = (phrase: string) => ({ phrase, ready: false });
  // A trial's dispatcher that holds (its runs used, its spend cap) starts none of them: held, never ready.
  const idle = f.lineOn ? (f.idle ? blocked(f.idle) : { phrase: "Queued", ready: true }) : { phrase: f.lineOn === false ? "Ready: flow off" : "Ready: no flow set up", ready: true };
  if (!t) return idle;
  if (f.awaitsFindings) return blocked(`Waiting for more findings (has ${t.cause?.signal_count ?? 0})`);
  if (t.status === "in_progress") return blocked("In progress outside a flow");
  if (t.status !== "open") return blocked(f.cameBack ? "Returned after it was closed" : "Not open");
  // A run holds it only while that run is live, and then it is named.
  const held = t.workflow_run_id ? f.attempts?.find((a) => a.runId === t.workflow_run_id) : undefined;
  if (held?.live) return blocked(`Held by Run ${held.n}`);
  if (t.workflow_run_id && !f.attempts) return blocked("Held by an earlier run");
  // What holds it, before which run last touched it: a run that parked it at grounding left the reason on the task.
  if (t.readiness === "needs_context") return blocked("Needs a fact");
  if (!t.readiness) return blocked("Not grounded yet");
  if (t.readiness === "not_actionable") return blocked("Found nothing to change");
  if (t.assignee) return blocked(`Assigned to ${f.assigneeName ?? t.assignee_info?.name ?? "someone"}`);
  if (t.readiness === "ready" && !(typeof t.goal_ref === "string" ? t.goal_ref.trim() : t.goal_ref)) return blocked("Needs a goal");
  if (f.underBar && !t.workflow_run_id) return { phrase: underBarWords(f.underBar), ready: false, waits: true };
  // Ready, but the task still points at a run that ended: the sweep passes it by, so it starts only by hand.
  if (t.workflow_run_id) return { ...blocked(held ? `Run ${held.n} ended: start by hand` : "Last run ended: start by hand"), byHand: true };
  if (!startableCause(t as unknown as LineCauseTask)) return blocked("Blocked");
  return idle;
}

/** A cause grounding tied to no goal ("none", or none recorded): ground parks it whenever it runs. */
export const servesNoGoal = (goal: unknown): boolean => { const g = typeof goal === "string" ? goal.trim() : goal; return !g || g === NO_GOAL; };

/** A run that handed the problem back at a step: "Handed to a person at Refine." (runReport runOutcome). */
const handedAt = (a: Pick<HistoryAttempt, "live" | "outcome"> | null): string | null =>
  a && !a.live ? /^Handed to a person at (.+?)\.?$/.exec(a.outcome.text)?.[1] ?? null : null;

/** What the step that handed a problem back said, from the problem's notes: the newest one after the run started that
 *  opens with the step's name ("Refine refused: ..."), and the count it gave of findings rejecting the cause. */
export function escalationWhy(step: string, start: number, notes: ReadonlyArray<BandNote>): { why: string | null; rejects: { n: number; of: number } | null } {
  const word = step.split(/\s+/)[0].toLowerCase();
  const note = [...notes].reverse().find((c) => c.created_at >= start && c.text.trim().toLowerCase().startsWith(word));
  const why = note ? wholeSentences(note.text.trim().split("\n")[0], 400) : null;
  const m = why?.match(/\b(\d+) of (\d+)\b[^.]*?\breject/i);
  return { why, rejects: m ? { n: Number(m[1]), of: Number(m[2]) } : null };
}

/** The commit a park note says main already carries the fix in (lineInbox fixedOnMain, whose row asks to close it). */
export { fixedOnMain };

/** A failed band's step when neither the run's visits, its failure row nor its trace names one. */
export const NO_STEP = "a step";

/** An approved fix that has not merged: who said yes and when, what it changes, and whether customers have it. */
function approvedBand(i: BandInput, last: HistoryAttempt, before: HistoryAttempt | null, behind: string | null): Extract<ProblemBand, { kind: "approved" }> {
  const h = i.history;
  return {
    kind: "approved", at: last.card?.answeredAt ?? last.end, ref: last.card?.ref ?? null, by: i.approver ?? null, mergeOff: mergeStepOff(i.shipOutput), change: last.diff, runId: last.runId,
    recorded: h.coverage.state, lastDeploy: lastDeployOf(h), behind,
    earlier: before?.merge ? { n: before.n, sha: before.merge.sha, at: before.merge.at, prUrl: before.merge.prUrl } : null,
  };
}

/** The line's own failures on this problem's fault after a moment (its fix going live). */
const faultsAfter = (issue: Pick<LineIssue, "lineFaults">, at: number): LineFault[] => (issue.lineFaults ?? []).filter((f) => f.at > at);

/** The one state a problem's page is in. First match wins, in the order a person can act (LJ8.2's precedence). */
export function problemBand(i: BandInput): ProblemBand {
  const { issue, history: h, run, row, task, now } = i;
  const last = h.attempts[h.attempts.length - 1] ?? null;
  // A need raised by an earlier run of this problem is over once a newer run has moved on (ct-57509: Run 2's stop at
  // Prove, after Run 3 was approved).
  // A fix main already carries is the park band's own, which names the commit and holds Close as fixed.
  const need = (i.need?.runId && last && i.need.runId !== last.runId && h.attempts.some((a) => a.runId === i.need!.runId)) || i.need?.kind === "fixed" ? null : i.need;
  const state = problemState(h, issue.status);
  const terminal = issue.status === "done" || issue.status === "dropped";
  if (need) {
    const stopped = need.kind === "stopped" || need.kind === "review" ? run?.visits.find((x) => x.node === need.fail?.step)?.label ?? need.fail?.step ?? null : null;
    const lapsed = need.kind === "lapsed";
    return { kind: "need", need: need.kind, since: need.since, step: stopped, askedAt: lapsed ? last?.end ?? last?.start ?? need.since : null, withdrawn: lapsed && last?.card?.status === "withdrawn", ask: need.kind === "stopped" ? stoppedAsk(need.fail)?.line ?? need.ask ?? null : need.kind === "duplicate" ? need.ask ?? null : null, why: need.kind === "reask" ? need.why ?? null : null, ...(need.trial && need.kind === "decision" && !need.publishes ? { trial: true } : {}) };
  }
  if (i.decision) return { kind: "decision", ref: i.decision.ref, since: i.decision.since, mine: i.decision.mine };
  // A card open on the newest run that nobody's queue carries here: someone else holds it.
  const card = last?.card;
  if (last?.live && card?.ref && !card.answer && (card.status === "pending" || card.status === "waiting") && !last.unapproved) return { kind: "decision", ref: card.ref, since: last?.end ?? last?.start ?? null, mine: false };
  // Opened on a finding that says nothing, and nothing has run on it since: there is nothing to ask about it. The one
  // act is a person's close (the ask block reads "No supporting finding"); it is never put to anyone as a question.
  if (task?.status === "open" && task.readiness !== "ready" && !last && restsOnNothing({ source: task.source, title: issue.title, description: task.description })) {
    return { kind: "ask", question: "", note: "", required: false, unsupported: true };
  }
  if (issue.ask && !waitsForFindings(issue.ask)) {
    const note = wholeSentences(issue.ask);
    const q = askParts(note).question;
    return { kind: "ask", question: q, note, required: issue.findings > 1 || /\?$/.test(q) || / or /.test(q) };
  }

  if (last?.live || run?.live) {
    const v = run?.visits[run.visits.length - 1] ?? null;
    const key = v || run ? stageKey(v?.node ?? run?.at_node, v?.label, i.stageOf) : i.stage ?? null;
    const stage = key ? STAGE_WORDS[key] : "Running";
    if (row?.kind === "stalled") return { kind: "stalled", stage, step: v?.label ?? row.detail ?? null, node: v?.node ?? null, silentMs: Math.max(0, now - (row.at ?? run?.updatedAt ?? now)), last: visitSaid(v), runId: run?.id ?? null };
    // Paused for an answer nobody was asked: nothing runs and nothing can be answered here; it needs asking again.
    if (last?.live && last.outcome.tone === "waiting" && (!run || run.status === "paused")) return { kind: "need", need: "reask", since: null, step: null, askedAt: null };
    return { kind: "running", stage, doing: key ? STAGE_DOING[key] : "Running", step: v?.label ?? stage, ms: Math.max(0, now - (last?.start ?? run?.at ?? now)), runId: run?.id ?? null, sessionId: v?.sessionId ?? null };
  }

  // The newest run ended at its fix decision. How that decision stands is decisionOutcome's one reading (the Decide step
  // and a run row read the same): answered in a trial, it is recorded and ships nothing; unanswered, nothing holds the
  // problem and the acts are to drop it or ask again. A fix that shipped past it is the lapsed need's, or a ship's.
  if (!terminal && last) {
    const ended = endedAtDecision(last, i.trial, run);
    if (ended) return ended;
  }

  // A person answered Ship and the landing step refused only because the default branch moved past the branch: the fix
  // is approved and waits to land, never a failure to start over (ct-58259). Its act is Rebase and land.
  // Approved and not landed is approvedFix's one rule, which For you's group and the Problems chip read too.
  const unlanded = unlandedFix({ status: issue.status, history: h }, { shipOutput: i.shipOutput, isTrial: () => !!i.trial });
  const before = last ? [...h.attempts].reverse().find((a) => a.runId !== last.runId && !!a.merge) ?? null : null;
  if (unlanded?.behind && last) return approvedBand(i, last, before, unlanded.behind);

  if (!terminal && (row?.kind === "failed" || (last && !last.ended && last.outcome.tone === "failed"))) {
    const v = firstFailedVisit(run);
    return {
      // The step: the run's own visit, else the failure row, else the outcome a graph's failure end wrote ("Stopped: Build failed.").
      kind: "failed", step: v?.label ?? (row?.fail?.step ? run?.visits.find((x) => x.node === row.fail!.step)?.label ?? stepLabel({ id: row.fail.step }) : null) ?? i.failedStep ?? (last ? /^Stopped: (.+) failed\.$/.exec(last.outcome.text)?.[1] : null) ?? NO_STEP, reason: row?.fail?.label ?? row?.detail ?? null, output: visitSaid(v),
      after: v?.durationMs ?? null, node: v?.node ?? null, runId: run?.id ?? last?.runId ?? null, at: row?.at ?? last?.end ?? null,
      silent: !!row?.fail?.key.startsWith("deadend-silent"),
      stop: row?.fail?.key.startsWith("budget:") ? "stopped by a spend limit" : row?.fail?.key.startsWith("deadend-failed") ? /^[^:]*? (blocked|waiting|still working|found no miss): /.exec(row.fail.label)?.[1] ?? null : null,
      ended: last?.outcome.text?.trim() || null,
      ...(row?.fail?.key.startsWith("budget:") ? { cap: true } : {}),
      built: builtUnanswered(h),
    };
  }

  // The newest run handed the problem back with nothing to answer (no card, no question): what it refused, and the acts
  // that move it (start again; moving findings out, on each finding). Never "waiting on you": nothing here can be answered.
  const handed = !terminal ? handedAt(last) : null;
  if (handed && last) {
    const { why, rejects } = escalationWhy(handed, last.start, i.notes ?? []);
    return { kind: "escalated", step: handed, at: last.end, why, rejects, runId: last.runId };
  }
  // The newest run parked it before building, and nothing has moved it since: the park record says why. Ground parks a
  // ready one that serves no goal too, and does again on every run until a goal covers it: never "start by hand".
  const noGoal = task?.readiness === "ready" && servesNoGoal(task.goal_ref);
  if (!terminal && last?.ended === "parked" && task && (task.readiness !== "ready" || noGoal)) {
    let times = 0;
    for (let k = h.attempts.length - 1; k >= 0 && h.attempts[k].ended === "parked"; k--) times++;
    return { kind: "parked", at: last.end, why: task.readiness_note?.trim() || null, readiness: task.readiness ?? null, fixedSha: fixedOnMain(task.readiness_note), noGoal, times, runId: last.runId };
  }

  // A fix that merged: in production when a deploy carried it, else merged and waiting on a deploy codecast does not make.
  // The merge is read off the recorded ship, else off the run itself (a run whose merge landed with no ship step recorded).
  const ship = [...h.ships].reverse().find((s) => s.merge || s.deploys.length) ?? null;
  const merged = [...h.attempts].reverse().find((a) => a.merge && !a.live) ?? null;
  const merge = ship?.merge ?? merged?.merge ?? null;
  const reopenedSince = h.regressed || h.cameBack;
  if ((ship || merge) && issue.status !== "dropped") {
    if (ship?.deploys.length) {
      const d = ship.deploys[0];
      const watch = shownWatches(h).find((w) => w.runId === ship.runId) ?? null;
      const back = h.regressions.find((r) => r.afterRunId === ship.runId);
      return { kind: "production", mergedAt: merge?.at ?? null, link: merge?.prUrl ?? null, sha: merge?.sha || null, liveAt: d.at, target: d.target, deployUrl: d.url, deployRef: d.ref ?? null, watchEnd: watch?.end ?? null, watch: watch && watch.state !== "unknown" ? watch.state : null, since: back?.count ?? 0, sinceOff: i.offTopic ?? 0, faults: faultsAfter(issue, d.at) };
    }
    if (merge && !reopenedSince) return { kind: "merged", mergedAt: merge.at, link: merge.prUrl, sha: merge.sha || null, recorded: h.coverage.state, lastDeploy: lastDeployOf(h) };
  }
  // The run reached its ship step with an answer, and nothing merged: say so, with the step's own reason.
  if (unlanded && last) return approvedBand(i, last, before, null);

  if (issue.ask && waitsForFindings(issue.ask)) return { kind: "morefindings", has: issue.findings, needs: wholeSentences(issue.ask) || null };
  // Closed without a fix, and findings kept coming: one state on the list and the page, whatever the findings are about
  // (the page says how many are about something else). Read off the findings themselves, never off the comeback
  // windows the page trims, so both read the same.
  const returned = closedThenFound(h);
  if (returned) return { kind: "returned", ...returned, off: Math.min(returned.since, i.offTopic ?? 0) };
  // Closed, unless a finding came back after the close: then it is open work again (notStartedWhy says so).
  if ((state === "closed" || state === "folded" || state === "held" || terminal) && !h.cameBack && !h.regressed) {
    const close = h.closes[h.closes.length - 1] ?? null;
    const how = close?.kind === "dissolved" ? dissolvedOutcome(h.attempts.find((a) => a.runId === close.runId)?.argued ?? null).words : close?.kind === "dropped" || issue.status === "dropped" ? "Dropped" : close?.kind === "shipped" ? "Fixed" : null;
    return { kind: "closed", at: task?.closed_at ?? close?.at ?? null, how, why: issue.dissolvedWhy ?? close?.fold?.words ?? null };
  }
  if (issue.status === "in_review" || task?.status === "in_review") {
    const since = last?.end ?? task?.updated_at ?? null;
    const holder = task?.assignee ? i.holderName ?? task.assignee_info?.name ?? null : null;
    return { kind: "review", since, holder, age: since != null ? Math.max(0, now - since) : null, answer: last?.card?.answer ?? null, runId: last?.runId ?? null };
  }
  const why = i.notStarted ?? notStartedWhy({ task, lineOn: i.lineOn, idle: i.idle, cameBack: h.cameBack || h.regressed, attempts: h.attempts });
  const restart = !!task?.workflow_run_id && !h.attempts.some((a) => a.live);
  const nothing = task?.readiness === "not_actionable" ? task.readiness_note?.trim() || "" : null;
  return { kind: "notstarted", lineOn: i.lineOn, reason: why.ready && !i.idle ? null : why.phrase, restart, nothing };
}

/** A fix an earlier run of the problem built and put to its decision, which nobody answered (withdrawn or lapsed), with
 *  nothing merged since and no run live: it is saved on its branch, so it lands from the problem (the press is the yes
 *  nobody gave) rather than a new run proving the problem from the start again (ct-57836: Run 2's card was withdrawn
 *  when Ship broke, then Runs 3 and 4 re-proved it). Null otherwise. */
export function builtUnanswered(h: Pick<CauseHistory, "attempts">): { runId: string; ref: string | null } | null {
  if (h.attempts.some((a) => a.live)) return null;
  for (let k = h.attempts.length - 1; k >= 0; k--) {
    const a = h.attempts[k];
    if (a.merge || a.card?.answer) return null;
    if (a.card && (a.diff || a.built)) return { runId: a.runId, ref: a.card.ref ?? null };
  }
  return null;
}

/** The newest close of a problem when it was not a fix (dissolved as not a problem, or dropped), nothing ran after it,
 *  and findings arrived after it: when, how, and how many. Null otherwise (a close folded into another problem expects
 *  more findings). */
export function closedThenFound(h: Pick<CauseHistory, "closes" | "attempts" | "occurrences">): { at: number; how: "not a problem" | "dropped"; since: number; runId: string | null } | null {
  const close = h.closes[h.closes.length - 1];
  if (!close || close.kind === "shipped" || (close.fold && close.fold.liveAt == null)) return null;
  if (h.attempts.some((a) => a.live || (a.runId !== close.runId && a.start > close.at))) return null;
  const since = h.occurrences.filter((o) => o.at > close.at).length;
  return since ? { at: close.at, how: close.kind === "dissolved" ? "not a problem" : "dropped", since, runId: close.runId ?? null } : null;
}

/** The findings after a close, grouped by what each says is wrong (its title, past a judge's "Not met:"), most first. A
 *  finding moves out with every finding of the problem under its source key, so each group names one finding per key
 *  (`signals`) and how many leave in all (`moving`). */
export function sinceCloseGroups(rows: ReadonlyArray<{ _id: string; title?: string | null; detail_md?: string; fingerprint?: string | null; observed_at?: number; created_at: number }>, at: number): Array<{ says: string; n: number; signals: string[]; moving: number }> {
  const byKey = new Map<string, number>();
  for (const r of rows) if (r.fingerprint) byKey.set(r.fingerprint, (byKey.get(r.fingerprint) ?? 0) + 1);
  const groups = new Map<string, { says: string; n: number; keys: Map<string, string> }>();
  const repeats = repeatedFindings(rows.map((r) => ({ ...r, title: r.title ?? "", source: "", subject: null, detail_md: (r as { detail_md?: string }).detail_md })));
  const repeatIds = new Set([...repeats].map((r) => r._id));
  for (const r of rows) {
    if ((r.observed_at || r.created_at) <= at || repeatIds.has(r._id)) continue;
    const says = (r.title ?? "").replace(/^Not met:\s*/i, "").trim() || "A finding with no title";
    const g = groups.get(says) ?? groups.set(says, { says, n: 0, keys: new Map() }).get(says)!;
    g.n++;
    const key = r.fingerprint || `id:${r._id}`;
    if (!g.keys.has(key)) g.keys.set(key, r._id);
  }
  return [...groups.values()].map((g) => ({
    says: g.says, n: g.n, signals: [...g.keys.values()],
    moving: [...g.keys.keys()].reduce((n, k) => n + (k.startsWith("id:") ? 1 : byKey.get(k) ?? 1), 0),
  })).sort((a, b) => b.n - a.n || a.says.localeCompare(b.says));
}

/** A run that ended at its fix decision, as decisionOutcome reads it (the Decide step and a run row read the same):
 *  answered in a trial, recorded and nothing shipped; unanswered (withdrawn or lapsed), the decision and the acts that
 *  still move the problem. Null for a run that is live, merged, shipped past it or never asked. The problem's band reads
 *  its newest run this way, and a run's page reads its own. */
/** `run`: the attempt's run, when drawn: the decision was asked when its person step started, not when the run ended. */
export function endedAtDecision(a: HistoryAttempt, trial?: boolean, run?: Pick<LineRunModel, "id" | "visits"> | null): Extract<ProblemBand, { kind: "trial" | "unanswered" }> | null {
  const c = a.card;
  if (a.live || !c || a.merge || a.ended === "shipped" || a.unapproved) return null;
  const o = decisionOutcome({ status: c.status, answer: c.answer, short_id: c.ref, resolved_at: c.answeredAt }, { status: "ended" }, { trial });
  if (o.state === "answered" && o.trial && o.verb) return { kind: "trial", verb: o.verb, at: c.answeredAt ?? a.end, ref: c.ref, change: a.diff, runId: a.runId };
  if ((o.state === "withdrawn" || o.state === "lapsed") && c.status !== "answered") {
    const person = run?.id === a.runId ? [...run.visits].reverse().find((v) => v.kind === "person" && !v.inferred) : undefined;
    return { kind: "unanswered", ref: c.ref, withdrawn: c.status === "withdrawn", askedAt: person?.startedAt ?? person?.at ?? a.end ?? a.start, at: c.answeredAt ?? a.end, recommend: c.recommend?.verdict ?? null, built: !!(a.diff || a.built), runId: a.runId };
  }
  return null;
}

/** The one statement of the problem's state, beside the stage track (LJ6.4). Nothing else on the page repeats it. */
export function bandLine(b: ProblemBand): { text: string; tone: "you" | "bad" | "warn" | "live" | "ok" | "none" } {
  switch (b.kind) {
    case "need":
      if (b.need === "decision") return { text: `Fix to decide${b.since ? `, since ${dayWords(b.since)}` : ""}`, tone: "you" };
      if (b.need === "question") return { text: "Holds on an open question", tone: "warn" };
      if (b.need === "confirm") return { text: "New, not confirmed", tone: "warn" };
      // A card taken back unanswered is "Withdrawn", the word the decision itself and For you use.
      if (b.need === "lapsed") return { text: unansweredWords(b.withdrawn ?? false, b.askedAt), tone: "warn" };
      if (b.need === "stopped") return { text: b.ask ?? `Stopped${b.step ? ` at ${b.step}` : ""}: go on?`, tone: "warn" };
      if (b.need === "review") return { text: "Built, not presented", tone: "warn" };
      if (b.need === "assigned") return { text: "Assigned to you", tone: "none" };
      if (b.need === "duplicate") return { text: b.ask ?? "Same as another problem", tone: "none" };
      // Why a new ask is needed, never the group's own name: the card it holds can take no answer.
      if (b.why) return { text: /removed/.test(b.why) ? "Card's step was removed" : "Card has no session to answer", tone: "warn" };
      return { text: "Paused, nothing asked", tone: "warn" };
    // The decision's holder is not on its row yet (LJ9 item 12).
    case "decision":
      if (b.mine) return { text: `Fix to decide${b.since ? `, since ${dayWords(b.since)}` : ""}`, tone: "you" };
      return b.mine === false ? { text: "Waiting on someone else", tone: "none" } : { text: "Waiting on an answer", tone: "none" };
    case "ask": return b.unsupported ? { text: "No supporting finding", tone: "warn" } : { text: b.required ? "Holds on an open question" : "New, not confirmed", tone: "warn" };
    case "failed": return { text: b.silent ? `${b.step} ended without a report` : b.stop ? `${b.stop.charAt(0).toUpperCase()}${b.stop.slice(1)} at ${b.step}` : b.step === NO_STEP ? (b.ended ? b.ended.replace(/\.$/, "") : "Failed before any step ran") : `Failed at ${b.step}`, tone: b.stop ? "warn" : "bad" };
    case "stalled": return { text: `No progress for ${spanShort(b.silentMs)}${b.step ? ` at ${b.step}` : ""}`, tone: "bad" };
    case "running": return { text: b.doing, tone: "live" };
    case "merged": return { text: b.recorded === "known" ? `Merged ${dayWords(b.mergedAt)}, not in production` : `Merged ${dayWords(b.mergedAt)}`, tone: b.recorded === "known" ? "warn" : "ok" };
    case "production": {
      // The line failing on the very fault the fix was for is the problem happening again, finding or not.
      const runs = b.faults.length ? `the line failed on it ${b.faults.length}x` : "";
      const tail = b.since > 0 ? `, ${b.since} since${runs ? `, ${runs}` : ""}` : runs ? `, ${runs} since` : b.watch === "watching" && b.watchEnd ? `, watching until ${dayWords(b.watchEnd)}` : ", quiet";
      return { text: `In production ${dayWords(b.liveAt)}${tail}`, tone: b.since > 0 || runs ? "bad" : "ok" };
    }
    case "approved": return { text: `Approved${b.at ? ` ${dayWords(b.at)}` : ""}, ${b.behind ? `could not land: behind ${b.behind}` : "not merged"}`, tone: "warn" };
    case "escalated": return { text: `Escalated at ${b.step}${b.rejects ? `: ${b.rejects.n} of ${b.rejects.of} findings reject the cause` : ""}`, tone: "warn" };
    case "parked":
      if (b.fixedSha) return { text: `Already fixed on main (${b.fixedSha.slice(0, 7)})`, tone: "ok" };
      return { text: `Parked${b.times > 1 ? ` ${b.times}x` : ""}: ${b.noGoal ? "serves no goal" : b.readiness === "not_actionable" ? "nothing to change" : b.readiness === "needs_context" ? "needs a fact" : "not ready"}`, tone: "none" };
    case "unanswered": return { text: unansweredWords(b.withdrawn, b.withdrawn ? b.at : b.askedAt), tone: "warn" };
    case "trial": return { text: `Trial: you ${wouldLabel(b.verb).replace(/^W/, "w")}`, tone: "ok" };
    // In review is someone's only when a person holds it: named, with how long. Otherwise the run ended and nobody holds
    // it: what was last answered, else that nothing was asked.
    case "review":
      if (b.holder) return { text: `In review · ${b.holder}${b.age != null ? ` · ${spanShort(b.age)}` : ""}`, tone: "none" };
      return { text: b.answer ? `You answered ${b.answer}${b.since ? ` ${dayWords(b.since)}` : ""}, nothing since` : `Run ended${b.since ? ` ${dayWords(b.since)}` : ""}, nothing asked`, tone: "warn" };
    case "morefindings": return { text: `Waiting for more findings (has ${b.has})`, tone: "none" };
    case "returned": return { text: `Closed ${dayWords(b.at)} as ${b.how}, ${b.since} ${b.since === 1 ? "finding" : "findings"} since`, tone: "warn" };
    case "closed": return { text: `Closed${b.at ? ` ${dayWords(b.at)}` : ""}`, tone: "none" };
    case "notstarted": return { text: b.reason ?? (b.lineOn ? "Queued" : b.lineOn === false ? "Ready: flow off" : "Ready: no flow set up"), tone: "none" };
  }
}

/** The newest commit a finding names as merged ("gate fix merged 9e85377773"), when it came after `after` and is not
 *  the fix's own merge: a reader would take it for this fix landing (ct-57509: the commit was ct-58282's eval gate
 *  fix, and ct-57509's own change still sat on its branch). */
export function citedMerge(rows: ReadonlyArray<{ title?: string | null; detail_md?: string | null; observed_at?: number; created_at: number }>, after: number | null, own: string | null): { sha: string; at: number } | null {
  let best: { sha: string; at: number } | null = null;
  for (const r of rows) {
    const at = r.observed_at || r.created_at;
    if (after != null && at < after) continue;
    const m = /\bmerged\s+(?:as\s+|in\s+)?`?([0-9a-f]{7,40})\b/i.exec(`${r.title ?? ""}
${r.detail_md ?? ""}`);
    if (!m || (own && (own.startsWith(m[1]) || m[1].startsWith(own)))) continue;
    if (!best || at > best.at) best = { sha: m[1], at };
  }
  return best;
}

/** How many times its usual length a live run has run, when it is past three times: it is overrunning, and the band
 *  offers to open its session and to stop it. Null while it is within reach of its usual time, or no usual is known. */
export function overrun(ms: number, usual: number | null): number | null {
  if (!usual || usual <= 0) return null;
  const x = ms / usual;
  return x >= 3 ? Math.floor(x) : null;
}

/** The review a run's stop goes through (the shared confirm flow): what ends, what it had spent in time, and the way back. */
export function stopRunLedger(o: { problem: string; step: string; ms: number; usual: number | null }): SwitchLedger {
  return {
    name: "Stop the run", subject: o.problem, shift: null,
    figures: [{ value: spanShort(o.ms), label: "running", tone: "warn" }, ...(o.usual ? [{ value: spanShort(o.usual), label: "usual" }] : [])],
    rows: [{ k: "At", v: o.step }, { k: "Ends", v: "Now, as cancelled" }, { k: "Way back", v: "Start again on this page" }],
    confirm: "Stop the run", keep: "Keep running",
  };
}

/** The review of "Rebase and land" (convex landAgainCore): the approved fix's branch goes onto the default branch as the
 *  remote has it, the project's check runs on that, and Ship lands it; a conflict or a red check goes back to the
 *  builder. Words a person can check against the band: which branch, onto what, who approved it. */
export function rebaseLandLedger(o: { problem: string; branch: string | null; base: string; approved: string; change: HistoryAttempt["diff"] }): SwitchLedger {
  return {
    name: "Rebase and land", subject: o.problem, shift: ["Approved", "Landed"],
    figures: o.change && o.change.files > 0 ? [
      { value: String(o.change.files), label: o.change.files === 1 ? "file" : "files" },
      { value: `+${o.change.added}`, label: "added" },
      { value: `−${o.change.removed}`, label: "removed" },
    ] : [],
    rows: [
      ...(o.branch ? [{ k: "Branch", v: `${o.branch} → ${o.base}` }] : []),
      { k: "Approved", v: o.approved },
      { k: "First", v: `Rebase onto ${o.base}, run the check` },
      { k: "Then", v: "Ship lands it" },
      { k: "If it conflicts", v: "Back to the builder", tone: "warn" as const },
      { k: "Runs on", v: "The machine that built it" },
    ],
    confirm: "Rebase and land", keep: "Not now",
  };
}

/** A fix decision nobody answered, in the decision's own word: "Fix withdrawn Oct 12, unanswered". */
export const unansweredWords = (withdrawn: boolean, at: number | null): string => `Fix ${withdrawn ? "withdrawn" : "asked"}${at ? ` ${dayWords(at)}` : ""}, unanswered`;

/** Where a problem stands, as one status the Problems list files it under and one phrase every surface says: the
 *  problem's page reads the same band (LJ8.2, LJ8.3). `you` only when something on the page can be answered. */
export function problemNow(b: ProblemBand): { status: StatusKey; phrase: string } {
  const phrase = bandLine(b).text;
  const status: StatusKey = (() => {
    switch (b.kind) {
      // A trial's practice answer is filed with the trial, never with what waits on the viewer to change the product.
      // Only the end decision waits on the viewer (lineNeeds COUNTED). The rest holds the problem where it is: a fact
      // it waits on, a person holding it or a twin to merge is not started, a run that ended short needs a new one.
      case "need": return b.trial ? "trial" : b.need === "decision" ? "you" : b.need === "question" || b.need === "confirm" || b.need === "assigned" || b.need === "duplicate" ? "notstarted" : "newask";
      case "decision": return b.mine ? "you" : "others";
      // A problem that rests on no finding asks nobody: a person closes it (Needs a new ask).
      case "ask": return b.unsupported ? "newask" : "notstarted";
      case "failed": case "stalled": case "escalated": return "failed";
      case "running": return "running";
      case "approved": return "approved";
      // A trial records an answer and ships nothing: never counted with the real fixes waiting on a merge.
      case "trial": return "trial";
      case "unanswered": return "newask";
      case "merged": return "merged";
      case "production": return "shipped";
      case "closed": return "closed";
      // The close is in doubt and nothing is asked: a person reopens it, moves the findings out, or closes it again.
      case "returned": return "newask";
      case "review": return b.holder ? "others" : "newask";
      // Main already carries its fix: the line closes it (park.sh); one parked before that is closed from its row.
      case "parked": return b.fixedSha ? "newask" : "notstarted";
      case "morefindings": return "waiting";
      // Grounding found nothing to change: it ended, nothing will start it, and closing it is a person's act no answer reaches.
      case "notstarted": return b.nothing != null ? "newask" : "notstarted";
    }
  })();
  return { status, phrase };
}

// ── work: one row per run ────────────────────────────────────────────────────

export type WorkRow = {
  runId: string; n: number; start: number; durationMs: number | null; live: boolean;
  /** It stalled after a finished step and a later run took over: that run, the step, and whether the later run did it again. */
  replaced?: { by: string; step: string; redone: boolean | null } | null;
  /** A live run paused at a person's step: when that step started waiting. */
  waitingSince: number | null;
  /** What the run proposed, in its own headline; else what it found. */
  headline: string;
  outcome: string; tone: "ok" | "bad" | "warn" | "live" | "you" | "none";
  found: string | null;
  change: { files: number; added: number; removed: number; pr: string | null; branch: string | null; sha: string | null; /** The merged commit on its host, when the merge names its repository. */ commitUrl: string | null } | null;
  /** The run's own red and green steps: it failed before the change, it passes after. */
  proof: { before: boolean; after: boolean } | null;
  /** Who answered what, and when; null when nobody was asked. */
  answer: { ref: string | null; words: string; at: number | null } | null;
  /** The run is in the process drawn, so its page opens. */
  opens: boolean;
  /** The findings it worked were moved to this problem after it ran: its work is that problem's. */
  movedTo: string | null;
  /** It closed because another problem owns the fix or is the same problem (dissolvedOutcome): that problem's ref. */
  owner: string | null;
};

const OUTCOME: Record<string, string> = { "not shipped": "Asked you, no answer", running: "Running", "waiting on you": "Waiting on you", stuck: "No progress" };

/** How a run that closed without a change ended, by what its close argued (HistoryAttempt.argued): the fix is another
 *  problem's ("Already being fixed in ct-57467"), it was fixed already, it is the same problem as another, the judge was
 *  wrong, or none of those ("Turned out not to be a problem"). `ref` is the problem it names, to open. */
export function dissolvedOutcome(argued: HistoryAttempt["argued"]): { words: string; ref: string | null } {
  const c = argued ? closeOf(argued.kind, argued.into) : null;
  const said = c && closeSentence(c);
  return said ? { words: said, ref: /^ct-\d+$/.test(c.into ?? "") ? c.into : null } : { words: "Turned out not to be a problem", ref: null };
}
/** Verdicts that claim a fix went out: their words come from the run's own merge and deploy facts, never the verdict alone. */
const FIX_OUT = new Set(["deployed", "merged", "merged, not deployed", "shipped", "shipped, not deployed"]);

/** What a run's fix came to, read off the facts the band reads (its merge record, its ship's deploys), so a run row and
 *  the band never disagree: a fix with no merge record is "Approved <day>, not merged" whatever the verdict says. */
export function fixOutcome(a: HistoryAttempt, h: Pick<CauseHistory, "ships" | "coverage">, verdict = attemptVerdict(a, h).word): { words: string; tone: "ok" | "warn" } {
  const ship = h.ships.find((s) => s.runId === a.runId);
  const merge = a.merge ?? ship?.merge ?? null;
  if (ship?.deploys.length) return { words: "In production", tone: a.unapproved ? "warn" : "ok" };
  if (!merge) { const at = a.card?.answeredAt ?? a.end; return { words: `Approved${at ? ` ${dayWords(at)}` : ""}, not merged`, tone: "warn" }; }
  return /not deployed/.test(verdict) ? { words: "Merged, not in production", tone: "warn" } : { words: "Merged", tone: a.unapproved ? "warn" : "ok" };
}

function runProof(run: LineRunModel | null): WorkRow["proof"] {
  if (!run) return null;
  const red = run.visits.find((v) => v.node === "red");
  const green = [...run.visits].reverse().find((v) => v.node === "green");
  const before = !!red && red.status === "done" && red.decided.result?.red !== false;
  const after = !!green && green.status === "done";
  return before || after ? { before, after } : null;
}

/** A move of findings out of this problem, from its notes: the line's "Moved 1 signal (key) to ct-N: ..." and its tally
 *  ("Out: 2 to ct-N, 1 to ct-M (new)"). `keys`: the moved findings' keys, when the note names them. */
export type MovedOut = { to: string; at: number; keys: string[] };

export function movedOut(notes: ReadonlyArray<BandNote>): MovedOut[] {
  const out: MovedOut[] = [];
  for (const c of notes) {
    if (c.author && c.author !== "line") continue;
    const one = /^Moved \d+ (?:signals?|reports?|findings?) \(([^)]*)\) to (ct-\d+)/i.exec(c.text.trim());
    if (one) { out.push({ to: one[2], at: c.created_at, keys: one[1].split(/,\s*/).filter(Boolean) }); continue; }
    const tally = /^Out: (.+)$/m.exec(c.text)?.[1];
    for (const m of tally?.matchAll(/\d+ to (ct-\d+)/g) ?? []) out.push({ to: m[1], at: c.created_at, keys: [] });
  }
  return out;
}

const said = (t: string) => t.toLowerCase().replace(/[\s.…]+$/g, "").replace(/\s+/g, " ");

/** Two lines that say the same words, a closing period or case aside: a statement that only repeats its heading. */
export const saysSame = (a: string, b: string) => said(a) === said(b);

/** Whether the statement under a problem's name says anything the page does not already say: not when it is the name
 *  again, nor when the problem's only finding, drawn whole just below, holds it word for word (a problem filed from one
 *  report reads its description from that report). */
export function statementAdds(statement: string, heading: string, findings: ReadonlyArray<Pick<FindingLike, "detail_md">>): boolean {
  if (saysSame(statement, heading)) return false;
  const st = said(statement);
  return !(findings.length === 1 && st.length > 0 && said(findings[0].detail_md ?? "").includes(st.replace(/…$/, "")));
}

/** The problem a run's work went to, when the findings it worked were moved there after it started: its own words name
 *  that problem (they open with its title) or one of the moved findings' keys. */
export function runMovedTo(a: Pick<HistoryAttempt, "start" | "found" | "proposed" | "built" | "card">, moves: ReadonlyArray<MovedOut>, titleOf: (ref: string) => string | null): string | null {
  const text = said([a.card?.headline, a.proposed, a.found, a.built].filter(Boolean).join(" \n "));
  if (!text) return null;
  for (const m of moves) {
    if (m.at < a.start) continue;
    const title = titleOf(m.to);
    const head = title ? said(title) : "";
    if (head.length >= 24 && text.includes(head)) return m.to;
    if (m.keys.some((k) => { const id = /([0-9a-f]{8})[0-9a-f-]*$/i.exec(k)?.[1]; return !!id && text.includes(id.toLowerCase()); })) return m.to;
  }
  return null;
}

/** An agent's report as a person reads it: no "[the broker · matching layer] Done:" bookkeeping in front, and no
 *  internal cause ids ("C120") a reader cannot open: "Proved C120: on 89 of 154 calls" reads "Proved: on 89 of 154 calls",
 *  "I proved cause C116." reads "I proved the cause.". */
export function personWords(text: string): string {
  return text
    .replace(/^\s*\[[^\]\n]{1,80}\]\s*/, "")
    .replace(/^(?:done|finished|complete)\s*[:.-]\s*/i, "")
    .replace(/\b(?:the\s+)?cause\s+C\d{2,5}\b/g, "the cause")
    .replace(/\s+(?:for|of|on|in)\s+C\d{2,5}\b/g, "")
    .replace(/\s*\(?\bC\d{2,5}\b\)?/g, "")
    .replace(/\s+([:;,.])/g, "$1")
    .replace(/^\s*[:;,]\s*/, "")
    .replace(/^./, (c) => c.toUpperCase());
}

export function workRows(h: CauseHistory, runs: ReadonlyArray<LineRunModel>, opts: {
  /** A run whose work went to another problem: that problem's ref. */
  movedTo?: (a: HistoryAttempt) => string | null;
  /** The newest run parked the problem: the band's words for it. */
  parked?: string | null;
  /** A trial's run: an answer at its card is recorded and ships nothing. */
  trial?: (runId: string) => boolean;
  /** A run whose builder handed its work off for review (runReport failCause `review:<step>`, the band's own reading):
   *  the step it handed off at, in words. Such a run waits on a person's review; it did not fail. */
  review?: (runId: string) => string | null;
  /** A run that stopped after a step finished with nothing next on its line (lineNeeds stoppedAsk): that step (label and
   *  node) and the stage a go-on would have taken it to. It did its step; it did not fail there. */
  stalled?: (runId: string) => { step: string; node: string | null; next: string | null } | null;
} = {}): WorkRow[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const newest = h.attempts[h.attempts.length - 1]?.runId ?? null;
  return [...h.attempts].reverse().map((a) => {
    const after = h.attempts[h.attempts.indexOf(a) + 1] ?? null;
    const run = byId.get(a.runId) ?? null;
    const v = attemptVerdict(a, h);
    const failed = firstFailedVisit(run);
    const lastStep = run?.visits[run.visits.length - 1]?.label ?? null;
    const card = a.card;
    const fixOut = FIX_OUT.has(v.word) ? fixOutcome(a, h, v.word) : null;
    const dissolved = v.word === "dissolved" ? dissolvedOutcome(a.argued) : null;
    let outcome = fixOut?.words ?? dissolved?.words ?? OUTCOME[v.word] ?? v.word.charAt(0).toUpperCase() + v.word.slice(1);
    // A run paused at a person's step is not running: it waits on an answer, and the band above holds it.
    const paused = a.live && !!run && (run.status === "paused" || run.visits[run.visits.length - 1]?.status === "waiting");
    if (paused) outcome = "Waiting on an answer";
    else if (v.word === "failed") outcome = `Failed at ${failed?.label ?? lastStep ?? "a step"}`;
    else if (v.word === "dropped") outcome = card?.answer ? "Dropped by you" : "Dropped";
    else if (/^stopped/.test(v.word)) outcome = `Stopped at ${lastStep ?? "a step"}`;
    else if (v.word === "not shipped" && card?.status === "withdrawn") outcome = "Withdrawn, no answer";
    else if (a.ended === "parked") outcome = (a.runId === newest && opts.parked) || "Parked";
    // Its fix decision nobody answered: the band's own words, one word for it everywhere (withdrawn, never "stopped at Ship").
    const unanswered = !paused ? endedAtDecision(a, opts.trial?.(a.runId)) : null;
    if (unanswered?.kind === "unanswered") outcome = unansweredWords(unanswered.withdrawn, unanswered.withdrawn ? unanswered.at : unanswered.askedAt);
    // A trial's answered card ends the run where the trial graph records the answer ("Would ship"): say what was chosen.
    const trialAnswer = !a.live && card?.answer && opts.trial?.(a.runId) ? `Trial: you ${wouldLabel(card.answer).replace(/^W/, "w")}` : null;
    if (trialAnswer) outcome = trialAnswer;
    const handed = handedAt(a);
    if (handed) outcome = `Escalated at ${handed}`;
    const reviewAt = !paused && v.word === "failed" ? opts.review?.(a.runId) ?? null : null;
    if (reviewAt) outcome = `Handed off for review at ${reviewAt}`;
    // Its step finished and the line had nothing next: "Proved, stalled before Build". A later run took the problem over:
    // whether it kept that step's work or did the step again (ct-57445: Run 3 proved again from scratch).
    const stall = !paused && !a.live ? opts.stalled?.(a.runId) ?? null : null;
    if (stall) {
      const redone = after && stall.node ? !!byId.get(after.runId)?.visits.some((x) => x.node === stall.node) : null;
      outcome = `${stepDone(stall.step)}, stalled before ${stall.next ?? "the next step"}${after ? ` · replaced by Run ${after.n}${redone == null ? "" : redone ? ` (${stall.step} redone)` : ` (${stall.step} kept)`}` : ""}`;
    }
    const replaced = stall && after ? { by: after.runId, step: stall.step, redone: after && stall.node ? !!byId.get(after.runId)?.visits.some((x) => x.node === stall.node) : null } : null;
    const movedTo = opts.movedTo?.(a) ?? null;
    if (movedTo) outcome = `Moved to ${movedTo}`;
    // Only a live pause is the person's turn: an escalation or a park asks nothing that can be answered.
    const tone: WorkRow["tone"] = movedTo || a.ended === "parked" ? "none" : stall ? "warn" : trialAnswer ? "ok" : handed || reviewAt || unanswered?.kind === "unanswered" ? "warn" : paused || v.tone === "person" ? "you" : fixOut ? fixOut.tone : v.tone === "closed" ? "none" : v.tone;
    const ship = h.ships.find((s) => s.runId === a.runId);
    const merge = a.merge ?? ship?.merge ?? null;
    return {
      runId: a.runId, n: a.n, start: a.start, durationMs: a.end != null ? a.end - a.start : null, live: a.live, movedTo,
      waitingSince: paused ? (() => { const w = run?.visits[run.visits.length - 1]; return w?.startedAt ?? w?.at ?? null; })() : null,
      headline: personWords(card?.headline ?? a.proposed ?? a.found ?? a.outcome.text), outcome, tone,
      found: a.found ? personWords(a.found) : null,
      change: a.diff || merge ? { files: a.diff?.files ?? 0, added: a.diff?.added ?? 0, removed: a.diff?.removed ?? 0, pr: a.diff?.pr ?? merge?.prUrl ?? null, branch: merge?.branch || null, sha: merge?.sha || null, commitUrl: merge?.repository && merge.sha ? `https://github.com/${merge.repository}/commit/${merge.sha}` : null } : null,
      proof: runProof(run),
      answer: card ? { ref: card.ref, words: (card.answer && opts.trial?.(a.runId) ? `${wouldLabel(card.answer)} · trial` : card.answer) ?? (a.unapproved ? "No answer" : card.status === "pending" || card.status === "waiting" ? "Waiting on an answer" : card.status.charAt(0).toUpperCase() + card.status.slice(1)), at: card.answeredAt } : null,
      opens: !!run,
      owner: !movedTo ? dissolved?.ref ?? null : null,
      replaced,
    };
  });
}

/** A step done, as a run row says it: "Proved", "Built"; a step with no such word is "<Step> finished". */
const DONE_WORDS: Record<string, string> = { Investigate: "Investigated", Analyze: "Analyzed", Ground: "Grounded", Plan: "Planned", Prove: "Proved", Build: "Built", Implement: "Built", Verify: "Verified", Review: "Reviewed" };
export const stepDone = (step: string): string => DONE_WORDS[step] ?? `${step} finished`;

// ── findings ─────────────────────────────────────────────────────────────────

/** Findings a run split off to a problem of their own that was then merged back into this one (ct-59338's sg-2635 went
 *  to ct-59666 and came back): by finding id, the problem it came back from. A problem split off one finding is titled
 *  with that finding's own words, which is how it is matched; a problem whose description only quotes a finding was a
 *  problem of its own (ct-59533). */
export function cameBack(signals: ReadonlyArray<{ _id: string; title: string }>, merged: ReadonlyArray<{ ref: string; title: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const key = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
  for (const m of merged) {
    const title = key(m.title);
    const hits = signals.filter((s) => { const t = key(s.title); return t.length > 20 && t === title; });
    // One finding is the split; a problem whose words many findings share was a problem of its own, merged in.
    if (hits.length === 1 && !out.has(hits[0]._id)) out.set(hits[0]._id, m.ref);
  }
  return out;
}

export type FindingLike = { title: string; detail_md?: string | null; evidence_url?: string | null; source: string; subject?: string | null };

/** Lines a finder writes for its own bookkeeping, which tell a reader nothing about what happened. */
const BOOKKEEPING = [/^breaks expectation\b/i, /^\d+ findings? in this\b/i, /^\d+ escalations? and difficulty notes? under this fingerprint\b/i, /^prompts?: /i, /^\d+ expert edits? and rejections? of\b/i];

/** `from`: where a quote was said, as its finder's own label named it ("What they wrote in Slack (data):" -> "In Slack"). */
export type FindingBlock = { kind: "text" | "quote" | "code"; text: string; from?: string };

/** The lines an escalation's filer writes around the agent's reason (Union's escalation source): the row says who and
 *  what was asked, so these say nothing a reader needs. */
const ESCALATION_LINES = [/^Ask: /, /^This one: /, /^Lane: /, /^The agent's reason\b/i];

/** A finding an escalation source filed: a person was asked to act on a contact. `ask`: the act ("Call", "Fix the
 *  record", "Decide"); `about`: what it is about; `contact`: who, from the agent's reason; `after`: what woke the agent,
 *  when it was something other than its own schedule. */
export type EscalationFinding = { ask: string; about: string; contact: string | null; after: string | null };

const WOKE: Record<string, string> = { call_attempt_failed: "after a failed call", inbound_email: "after their email", inbound_sms: "after their text", inbound_call: "after their call" };

export function escalationFinding(s: Pick<FindingLike, "detail_md" | "source" | "subject">): EscalationFinding | null {
  const d = s.detail_md ?? "";
  const ask = ASK_LINE.exec(d);
  if (!ask || (!/escalation/i.test(s.source) && !/^This one: a escalation\b|^This one: an escalation\b/m.test(d))) return null;
  const reason = /```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(d)?.[1]?.trim() ?? "";
  // The contact the agent names first: "Steffen Trabert (SVP ...)", "Caitlin Jones has reached ...".
  const contact = /^([A-Z][\p{L}'’-]+(?:\s+(?:[A-Z][\p{L}'’-]+|de|van|von|da|del)){1,3})(?=[\s(,.:;'’])/u.exec(reason)?.[1] ?? null;
  const woke = /woken by `?([a-z_]+)`?/.exec(d)?.[1] ?? s.subject ?? null;
  return { ask: ask[1].trim(), about: ask[2].trim(), contact, after: woke ? WOKE[woke] ?? null : null };
}

/** An escalation finding's row: who, the ask, and what woke it. "Caitlin Jones · Call: email ceiling and no text thread". */
export function escalationWords(e: EscalationFinding): string {
  const about = e.about.charAt(0).toUpperCase() + e.about.slice(1);
  return [e.contact, `${e.ask}: ${about}`, e.after].filter(Boolean).join(" · ");
}

/** The problem's heading in full: a stored title cut at its cap ("…means nothing to t…") reads from the expectation its
 *  findings restate whole, else to its last full sentence, else to its last whole word with an ellipsis. */
/** What a problem says, whole, under its name: its title when the title is whole; for one stored cut at its cap, the
 *  report it was filed from (the task's description past its "Opened by", "About" and "Where it was seen" lines), to its
 *  last whole sentence; else problemHeading. Never a title cut mid-word. */
export function problemStatement(title: string, description: string | null | undefined, findings: ReadonlyArray<Pick<FindingLike, "detail_md">>): string {
  const heading = problemHeading(title, findings);
  if (!/…$/.test(heading)) return heading;
  const body = (description ?? "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(?:opened by|about:|where it was seen:)/i.test(p));
  return body ? wholeSentences(body, 600) : heading;
}

export function problemHeading(title: string, findings: ReadonlyArray<Pick<FindingLike, "detail_md">>): string {
  // A judge's "Not met:" stays in front of the expectation's words: the heading names a miss, never a goal.
  const lead = /^not met:\s*/i.test(title) ? "Not met: " : "";
  const t = findingTitle({ title }).trim();
  const cut = /…$/.test(t) || t.length >= 199;
  if (!cut) return lead + t;
  const stem = said(t).slice(0, 120);
  for (const f of findings) {
    const bold = /^\s*\*\*([^*]+)\*\*/.exec(f.detail_md ?? "")?.[1]?.trim();
    if (bold && said(bold).startsWith(stem)) return lead + bold;
  }
  const whole = wholeSentences(t, 200);
  if (/[.?!]$/.test(whole)) return lead + whole;
  return `${lead}${t.replace(/…$/, "").replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")}…`;
}

/** A judge's labels for the messages of the conversation it read ("M2", "B-M1"): they point into a transcript the
 *  reader does not have beside them, so they are left out. "(M2, M3, M5)" goes whole; "(B-M1, a reply about the
 *  drafts)" keeps its words; "mail signed Reese (M4)" reads "mail signed Reese". */
const MSG_REF = String.raw`(?:[A-Z]{1,2}-)?M\d{1,3}(?:[-\u2013]M?\d{1,3})?`;
const MSG_REFS_ONLY = new RegExp(String.raw`\s*\(\s*${MSG_REF}(?:\s*(?:,|and|&)\s*${MSG_REF})*\s*\)`, "g");
const MSG_REFS_LEAD = new RegExp(String.raw`\(\s*${MSG_REF}(?:\s*,\s*${MSG_REF})*\s*[,;:]\s*`, "g");
export function dropMessageRefs(text: string): string {
  return text.replace(MSG_REFS_ONLY, "").replace(MSG_REFS_LEAD, "(");
}

/** A quote that carries no claim a finding could rest on: a pleasantry ("Good speaking today.") or a sign-off block
 *  ("Reese\nSenior Associate, Union Agency"). A judge sometimes picks one as its evidence; shown as "Quoted from the
 *  conversation" it reads as proof of nothing, and the finding's own words already name who sent what. A line that
 *  names its sender in a sentence ("it's Jamie from Union") or a From header ("Morgan Lee <m@x.com>") is kept. */
const PLEASANTRY = /^(?:hi|hello|hey|thanks|thank you|many thanks|good (?:speaking|talking|chatting|to (?:speak|talk|chat|meet))|great (?:speaking|talking|chatting|to (?:speak|talk|chat|meet))|nice (?:speaking|talking|chatting|meeting|to (?:speak|talk|chat|meet))|lovely (?:speaking|talking|chatting)|best|cheers|regards|kind regards|warm regards|best regards|talk soon|speak soon|looking forward)\b[^\n]{0,40}$/i;
const SIGN_NAME = /^[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2},?$/;
const SIGN_LINE = /@|^\+?[\d ().-]{7,}$|https?:\/\/|\b(?:associate|manager|director|partner|founder|lead|head|specialist|coordinator|advisor|adviser|consultant|officer|agency|team|inc\.?|llc|ltd)\b/i;
export function quoteCarriesNoClaim(q: string): boolean {
  const lines = q.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && PLEASANTRY.test(lines[0]) && !/\d/.test(lines[0])) return true;
  return lines.length >= 2 && lines.length <= 4 && SIGN_NAME.test(lines[0]) && !/[<@]/.test(lines[0]) && lines.slice(1).every((l) => SIGN_LINE.test(l) && l.length <= 60);
}

/** A finding's own words in full, as blocks: paragraphs, what it quotes, and raw output. The restated title, the
 *  severity tag and the finder's bookkeeping lines are left out. */
export function findingBlocks(s: FindingLike, expectation?: string | null): FindingBlock[] {
  const title = s.title.replace(/^not met:\s*/i, "").toLowerCase().replace(/[.\s…]+$/, "");
  // The expectation a finding breaks, as its finder restates it in a bold opening line: the page heads with it, so a
  // finding never says it again. Matched on its opening words, since a stored title is often cut short of the sentence.
  const heads = [title, said(expectation ?? "")].filter((t) => t.length >= 24).map((t) => t.slice(0, 120));
  const restates = (t: string) => heads.some((h) => said(t).startsWith(h));
  const escalation = !!escalationFinding(s);
  const out: FindingBlock[] = [];
  const parts = (s.detail_md ?? "").split(/(```[\s\S]*?(?:```|$))/);
  for (const part of parts) {
    if (part.startsWith("```")) {
      const code = part.replace(/^```[^\n]*\n?/, "").replace(/```\s*$/, "").trim();
      // A fenced block that holds a person's or an agent's own words (an escalation's reason; "The expert's why (data,
      // their words):") is a quote, not output, and the label that introduced it says nothing once it reads as one.
      const voiced = out.at(-1)?.kind === "text" && /\btheir words\)?:\s*$/i.test(out.at(-1)!.text);
      if (voiced) out.pop();
      if (code) out.push({ kind: escalation || voiced ? "quote" : "code", text: code });
      continue;
    }
    for (const raw of part.split(/\n\s*\n/)) {
      const para = raw.trim();
      if (!para) continue;
      if (/^>/.test(para)) {
        const q = para.split("\n").map((l) => l.replace(/^\s*>\s?/, "")).join("\n").trim();
        if (q && !quoteCarriesNoClaim(q)) out.push({ kind: "quote", text: q });
        continue;
      }
      // A label line and the quote it introduces, with no blank line between ("What they wrote in Slack (data):\n> …"):
      // the quote is a quote, captioned by where it was said, and the label says nothing more.
      const labelled = para.match(/^([^\n>]{3,80}):\s*\n((?:\s*>.*(?:\n|$))+)$/);
      if (labelled) {
        const q = labelled[2].split("\n").map((l) => l.replace(/^\s*>\s?/, "")).join("\n").trim();
        const where = labelled[1].match(/\b(?:in|on|from|by)\s+(Slack|email|the call|a call|the conversation|[A-Z][\w.]+)\b/);
        if (q) out.push({ kind: "quote", text: q, ...(where ? { from: `${where[0].split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase())} ${where[1]}` } : {}) });
        continue;
      }
      let text = para.replace(/\*\*|__/g, "").replace(/`([^`]+)`/g, "$1").replace(/\s*\(severity \d+\/10[^)]*\)/i, "").trim();
      // A paragraph that only restates the title says nothing new.
      if (text.toLowerCase().replace(/[.\s]+$/, "") === title) continue;
      if (text.toLowerCase().startsWith(title) && text.length - title.length < 4) continue;
      if (/^\*\*/.test(para) && restates(text)) continue;
      text = text.split("\n").filter((l) => !BOOKKEEPING.some((re) => re.test(l.trim())) && !(escalation && ESCALATION_LINES.some((re) => re.test(l.trim())))).join("\n").trim();
      if (text) out.push({ kind: "text", text: dropMessageRefs(text) });
    }
  }
  // A finder's appended excerpt ("What they wrote in Slack (data):") shows only when it is the message the finding is
  // about. One that shares next to nothing with the finding's own words is another message from the same thread
  // (ct-58682 quoted a thread's "how are you doing on your goals" under a finding about replies lost in an outage);
  // the finding's own evidence stands without it.
  const own = out.some((b) => b.kind === "text") ? subjectWords([s.title, ...out.filter((b) => b.kind === "text").map((b) => b.text)].join("\n")) : null;
  return own ? out.filter((b) => b.kind !== "quote" || !b.from || quoteIsAbout(b.text, own)) : out;
}

/** A quote shares the finding's subject: two of its subject words, or a quarter of them, are the finding's own. */
function quoteIsAbout(quote: string, own: ReadonlySet<string>): boolean {
  const q = subjectWords(quote);
  if (!q.size) return true;
  const shared = [...q].filter((w) => own.has(w)).length;
  return shared >= 2 || shared / q.size >= 0.25;
}

/** What each finding's row leads with, under a heading that already says `title`. A judge's finding with a moment
 *  leads with its own title (the moment shows the rest). Any other whose title the heading already says, or that shares
 *  its title with another finding here (an expectation's words, one per conversation), leads with its own first
 *  paragraph, so no row repeats the heading and rows tell their conversations apart. null keeps the finding's title. */
export function findingLeads<T extends FindingLike & { moment?: unknown }>(rows: ReadonlyArray<T>, title: string): (s: T) => string | null {
  const sameTitle = rows.length > 1 && new Set(rows.map((s) => findingTitle(s))).size < rows.length;
  const heading = said(title);
  return (s) => {
    if (s.moment) return null;
    const own = said(findingTitle(s));
    const restates = own === heading || heading.startsWith(own.slice(0, 80));
    if (!sameTitle && !restates) return null;
    const b = findingBlocks(s, title);
    return (b.find((x) => x.kind === "text") ?? b.find((x) => x.kind === "quote"))?.text ?? "";
  };
}

// Capitalized words that name no one: sentence openers, the product, the finder, months and days.
const NOT_NAMES = new Set("A An And As At But By For From Has Have He How If In Is It Its No Not Of On Or She So The Then There They This To Was Were What When Where Whether Which Who Why With Union AgentWatch Slack Comms Monday Tuesday Wednesday Thursday Friday Saturday Sunday Jan Feb Mar Apr May Jun Jul Aug Sep Sept Oct Nov Dec January February March April June July August September October November December".split(" "));

/** The people and things an ask names: its capitalized words, less words that name no one. */
export const namesIn = (text: string): Set<string> => new Set([...text.matchAll(/\b[A-Z][a-z]{2,}\b/g)].map((m) => m[0]).filter((w) => !NOT_NAMES.has(w)));

/**
 * The findings a question is about (LJ6.2 "What this asks about"): those whose words name the most of the people the
 * question and its reason name ("Akash dealt with Quinn but ... signed Riley" -> Akash's finding). Empty when the ask
 * names no one or every finding names them alike, so a question about the whole problem points at none. At most two.
 */
export function askedAbout<T extends FindingLike>(ask: string, rows: ReadonlyArray<T>): T[] {
  const names = namesIn(ask);
  if (!names.size || rows.length < 2) return [];
  const scored = rows.map((s) => {
    const own = namesIn(`${s.title}\n${s.detail_md ?? ""}`);
    return { s, n: [...names].filter((w) => own.has(w)).length };
  });
  const top = Math.max(...scored.map((x) => x.n));
  const best = scored.filter((x) => x.n === top);
  if (top === 0 || best.length === rows.length) return [];
  return best.slice(0, 2).map((x) => x.s);
}

/** A finding an event source filed for an error group (ingest promotionSignal): which group, what happened to it, and
 *  the counts its text carries. Its body is the group itself (stack, samples), read in place, never the filer's text. */
export type EventFinding = { group: string; transition: string; count: number | null; release: string | null; culprit: string | null };

export function eventFinding(s: Pick<FindingLike, "detail_md" | "subject">): EventFinding | null {
  const d = s.detail_md ?? "";
  const head = d.match(/^([a-z ]+?) in \S+, group (eg-\d+) \(/i);
  const group = (s.subject && /^eg-\d+$/i.test(s.subject) ? s.subject : null) ?? head?.[2] ?? null;
  if (!group || !head) return null;
  const seen = d.match(/Seen (\d+) times?(?:, last in ([^\n]+?))?\.?$/m);
  const culprit = d.match(/^Culprit: (.+)$/m)?.[1]?.trim() ?? null;
  const word = head[1].trim();
  return { group, transition: word.charAt(0).toUpperCase() + word.slice(1), count: seen ? Number(seen[1]) : null, release: seen?.[2]?.trim() ?? null, culprit };
}

/** An event finding's row: what happened, where, how often. "Regressed in e2e@1.3.0 · 7 times". */
export function eventFindingWords(e: EventFinding): string {
  return [`${e.transition}${e.release ? ` in ${e.release}` : ""}`, e.count != null ? `${e.count} ${e.count === 1 ? "time" : "times"}` : null].filter(Boolean).join(" · ");
}

/** Where a finding's evidence link goes, named for its target (LJ6.3). */
export function evidenceLinkWords(url: string): string {
  let u: URL | null = null;
  try { u = new URL(url); } catch { return "Open the evidence"; }
  if (/slack\.com$/.test(u.hostname)) return "Open in Slack";
  if (/agent-runs/.test(u.pathname)) return "Open the agent run in Union";
  if (/agent-watch/.test(u.pathname)) return u.searchParams.get("finding") ? "Open the finding in Union" : "Open the cluster in Union";
  if (/\/desk\/decisions\//.test(u.pathname)) return "Open the draft in Union";
  if (/\/worker\/task\//.test(u.pathname)) return "Open the task in Union";
  if (/unionmatching\.com$/.test(u.hostname)) return "Open in Union";
  if (/github\.com$/.test(u.hostname)) return "Open on GitHub";
  return `Open on ${u.hostname.replace(/^www\./, "")}`;
}

/** The project's newest recorded production deploy: what "In production: No" is measured against. */
/** The project's newest recorded production deploy, whatever it carried (a deploy that carried this problem's fix
 *  would have made it live); the history's own deploys are only those that did. */
function lastDeployOf(h: Pick<CauseHistory, "deploys" | "coverage">): { at: number; url: string | null } | null {
  const d = [...h.deploys].sort((a, b) => b.at - a.at)[0];
  const own = d ? { at: d.at, url: d.url ?? null } : null;
  const last = h.coverage.last ?? null;
  return !own ? last : !last || own.at >= last.at ? own : last;
}

/** The app an evidence link opens, as its words name it ("Union", "Slack", "GitHub"); null when they name none. */
export const evidenceApp = (url: string | null | undefined): string | null => (url ? evidenceLinkWords(url).match(/\b(?:in|on) (.+)$/)?.[1] ?? null : null);

const CUT_END = /…\s*$/;
/** Where an opened finding's words end, when they end cut. The feed carries a finding's head cut with "…"; opened, its
 *  whole is read from the server: `loading` until it arrives, `failed` when it cannot be read (the head is all there is),
 *  `sender` when the whole itself ends cut (the app that filed it clipped it to `at` characters, its "…" counted), null when whole. */
export type FindingCut = { kind: "loading" } | { kind: "failed" } | { kind: "sender"; at: number } | null;
export function findingCut(feed: string | null | undefined, whole: { data: unknown; error: boolean }): FindingCut {
  if (!CUT_END.test(feed ?? "")) return null;
  if (typeof whole.data === "string") return CUT_END.test(whole.data) ? { kind: "sender", at: whole.data.trimEnd().length } : null;
  return whole.error || whole.data === null ? { kind: "failed" } : { kind: "loading" };
}

/** A cut finding's own line, said beside the link to the whole: "Cut by Union at 1,500 characters". */
export function findingCutWords(cut: NonNullable<FindingCut>, url: string | null | undefined): string {
  if (cut.kind !== "sender") return cut.kind === "loading" ? "Reading the rest" : "Cut here: the rest did not load";
  return `Cut by ${evidenceApp(url) ?? "its sender"} at ${cut.at.toLocaleString("en-US")} characters`;
}

/**
 * Findings that are a person's ask, not evidence of this problem: an escalation (an agent asking someone to act, often
 * by a date) the attach judge filed here by word overlap (ct-58847, a company-need classifier problem, held four asks
 * about deliveries, call cards and consent). They sit apart on the page with moving them out as the main act. A
 * problem whose findings are all escalations is about escalations, so nothing is set apart.
 */
export function misfiledAsks<S extends Pick<FindingLike, "detail_md" | "source" | "subject">>(signals: ReadonlyArray<S>): Set<S> {
  const asks = signals.filter((s) => escalationFinding(s));
  return asks.length && asks.length < signals.length ? new Set(asks) : new Set();
}
