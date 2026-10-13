// What a line iteration leaves behind (docs/architecture/line-versions.md LV1).
//
// Every artifact of a line is current or superseded: a later fact has
// replaced it (newer work on the same thing, or the thing it was made for is
// gone). One pure predicate per kind decides it from facts the record already
// holds, so the server and every client hide the same things by default. A
// superseded artifact still opens from its own link; nothing is deleted.
// Finished work (a shipped run, an answered card, a closed problem) is
// history, not superseded: history surfaces show every attempt.
import { isTerminalTaskStatus } from "../tasks/statuses";

export type SupersededWhy =
  | "merged" // the problem was folded into another
  | "emptied" // the problem held findings and none is live now
  | "newer_run" // a later run works the same problem
  | "station_gone" // the run waits at a station its line no longer has
  | "problem_closed" // the run waits on a problem that closed
  | "problem_superseded" // the run or card is for a problem that is superseded
  | "run_superseded" // the card's run is superseded
  | "run_moved_on" // the card's run left the gate it asks at
  | "evidence_moved" // none of the problem's live findings is one the card covers
  | "withdrawn" // the finding no longer stands as evidence
  | "judge_unpublished"; // the finding's judge is no longer published

/** Why an artifact is superseded, and the short id of what replaced it when one did. */
export type Superseded = { why: SupersededWhy; by?: string } | null;

/** Words for a reason, short enough for a row: "replaced by a newer run". */
export const SUPERSEDED_WORDS: Record<SupersededWhy, string> = {
  merged: "merged",
  emptied: "its findings moved",
  newer_run: "a newer run",
  station_gone: "station removed",
  problem_closed: "problem closed",
  problem_superseded: "problem replaced",
  run_superseded: "run replaced",
  run_moved_on: "run moved on",
  evidence_moved: "its findings moved",
  withdrawn: "withdrawn",
  judge_unpublished: "judge retired",
};


export interface ProblemFacts {
  status: string;
  /** The problem it was folded into (`cause.merged_into`, followed to the one that stands). */
  merged_into?: string | null;
  /** Findings that stand on it now. */
  live_findings: number;
  /** Findings that once stood on it and were withdrawn or moved off. Zero for a problem that never held any. */
  gone_findings: number;
}

/**
 * A problem is superseded when it was merged into another, or when it is open,
 * held findings, and none is live now. A problem that never held a finding (a
 * cause a person filed, one grounded from a request) is current.
 */
export function supersededProblem(p: ProblemFacts): Superseded {
  if (p.merged_into) return { why: "merged", by: p.merged_into };
  if (!isTerminalTaskStatus(p.status) && p.live_findings === 0 && p.gone_findings > 0) return { why: "emptied" };
  return null;
}

export interface RunFacts {
  status: string;
  /** The newest other run on the same problem that started after this one, when there is one. */
  newer_run?: string | null;
  /** The run stands at a station its line's current graph does not have. */
  station_gone: boolean;
  /** The problem's status, when the run works one. */
  problem_status?: string | null;
  problem?: Superseded;
}

const LIVE_RUN = new Set(["pending", "running", "paused"]);

/**
 * A live run is superseded when a later run works the same problem, when it
 * waits at a station its line no longer has, or when its problem closed or
 * was superseded. A finished run is history, never superseded: the problem's
 * attempts show every run, whatever came after.
 */
export function supersededRun(r: RunFacts): Superseded {
  if (!LIVE_RUN.has(r.status)) return null;
  if (r.newer_run) return { why: "newer_run", by: r.newer_run };
  if (r.problem) return { why: "problem_superseded", ...(r.problem.by ? { by: r.problem.by } : {}) };
  if (r.problem_status && isTerminalTaskStatus(r.problem_status)) return { why: "problem_closed" };
  if (r.station_gone) return { why: "station_gone" };
  return null;
}

export interface CardFacts {
  /** Whether the card still waits on an answer. An answered or closed card is history. */
  waiting: boolean;
  run?: Superseded;
  /** The run stands at the gate the card asks at. */
  run_at_gate: boolean;
  problem?: Superseded;
  /** Conversations the card covers that are among the problem's live findings, when the card declares what it covers (`reach.covers`); null when it declares nothing. */
  covered?: number | null;
  /** The problem's live findings now. */
  live_findings: number;
}

/**
 * A waiting card (or the decision that asks it) is superseded when its run or
 * its problem is, when its run has left the gate it asks at, or when it
 * declares what it covers and none of the problem's live findings is among
 * them. A card that declares no coverage is never hidden by that last rule.
 */
export function supersededCard(c: CardFacts): Superseded {
  if (!c.waiting) return null;
  if (c.run) return { why: "run_superseded", ...(c.run.by ? { by: c.run.by } : {}) };
  if (c.problem) return { why: "problem_superseded", ...(c.problem.by ? { by: c.problem.by } : {}) };
  if (!c.run_at_gate) return { why: "run_moved_on" };
  if (c.covered != null && c.covered === 0 && c.live_findings > 0) return { why: "evidence_moved" };
  return null;
}

export interface FindingFacts {
  retired?: unknown;
  merged_into?: string | null;
  case_of?: unknown;
  judge_review?: unknown;
  /** The finding's judge is no longer published (`judges.removed_at`). */
  judge_removed?: boolean;
}

/**
 * A finding is superseded when it no longer stands as evidence (withdrawn,
 * merged into another, a case against its judge, ruled wrong) or its judge is
 * no longer published. One filed by an older version of a published judge is
 * current: that judge's new version reads its moment again and settles it.
 */
export function supersededFinding(f: FindingFacts): Superseded {
  if (f.merged_into) return { why: "merged", by: f.merged_into };
  if (f.retired || f.case_of || f.judge_review) return { why: "withdrawn" };
  if (f.judge_removed) return { why: "judge_unpublished" };
  return null;
}

/** Keep the current rows, or every row when the reader asked for history too. */
export function currentOnly<T extends { superseded?: Superseded }>(rows: readonly T[], all = false): T[] {
  return all ? [...rows] : rows.filter((r) => !r.superseded);
}
