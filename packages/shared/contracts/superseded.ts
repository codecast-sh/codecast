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
  | "line_changed" // the gate it waits at, or the station that presents it, changed in the line's published graph
  | "problem_closed" // the run waits on a problem that closed
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
  line_changed: "line changed",
  problem_closed: "problem closed",
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
 * A problem's facts from its task row alone: `cause` is written only when a
 * finding reaches the task, `signal_count` is its live findings, and a
 * `last_seen` means one once stood on it.
 */
export function problemFactsOf(task: { status: string; cause?: { signal_count: number; last_seen: number } | null }, mergedInto?: string | null): ProblemFacts {
  const live = task.cause?.signal_count ?? 0;
  return { status: task.status, merged_into: mergedInto ?? null, live_findings: live, gone_findings: task.cause && task.cause.last_seen > 0 && live === 0 ? 1 : 0 };
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
  /** The version of the line that replaced the gate it waits at (gateOutdated), when one did; "" when it is unnamed. */
  line_changed?: string | null;
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
  if (r.problem) return r.problem;
  if (r.problem_status && isTerminalTaskStatus(r.problem_status)) return { why: "problem_closed" };
  if (r.station_gone) return { why: "station_gone" };
  if (r.line_changed != null) return { why: "line_changed", ...(r.line_changed ? { by: r.line_changed } : {}) };
  return null;
}

/** A station's hash as a graph records it (parser.graphNodeHashes). */
export type StationHash = { id: string; h: string };

export interface GateVersionFacts {
  /** The gate the run waits at. */
  gate: string;
  /** The station hashes the run was made with (its graph_nodes, else the version published when it started); null when unknown. */
  ran: readonly StationHash[] | null;
  /** The line's published graph: every station's hash, and each of a person's gates with the station that presents it (asker). */
  current: { nodes: readonly StationHash[]; gates: Readonly<Record<string, { asker?: string }>> } | null;
}

/**
 * Whether the line has moved past what a waiting gate was made by: the gate
 * is no longer a person's gate in the published graph, or the station that
 * presents it there (its asker) has a different hash than the run recorded (a
 * presenter the run's graph did not have counts: it was asked with no
 * presenting session). The gate's own wording, and any other station,
 * changing leaves it current. Unknown facts never hide anything.
 */
export function gateOutdated(f: GateVersionFacts): boolean {
  if (!f.current || !f.current.nodes.length) return false;
  const gate = f.current.gates[f.gate];
  if (!gate) return true;
  if (!f.ran || !f.ran.length) return false;
  const ran = new Map(f.ran.map((n) => [n.id, n.h]));
  const now = new Map(f.current.nodes.map((n) => [n.id, n.h]));
  return !!gate.asker && now.has(gate.asker) && ran.get(gate.asker) !== now.get(gate.asker);
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
 * its problem is (with their reason, so a row says what actually moved), when its run has left the gate it asks at, or when it
 * declares what it covers and none of the problem's live findings is among
 * them. A card that declares no coverage is never hidden by that last rule.
 */
export function supersededCard(c: CardFacts): Superseded {
  if (!c.waiting) return null;
  if (c.run) return c.run;
  if (c.problem) return c.problem;
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
