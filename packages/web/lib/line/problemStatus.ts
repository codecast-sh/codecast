// Where a problem stands, as the Problems page files it (line-journeys.md
// LJ8.2): ten statuses that partition the problems, so the chips sum to All
// and each chip's count is the rows it opens. The first match wins, in the
// order of PRECEDENCE; the phrase is the row's one statement of state. Pure:
// the caller hands in what the store knows about each problem (its need, its
// failure, its task row), so the reading of a need has one home (lineNeeds).
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import type { LineCauseTask } from "../lineFlow";
import type { CauseHistory } from "./causeHistory";
import type { LineIssue } from "./lineModel";
import { notStartedWhy, problemBand, problemNow, type BandInput, type BandNeed, type BandNote, type BandTask, type NotStartedFacts } from "./problemPage";
import { neverShipped } from "./timeline";

export type StatusKey = "you" | "others" | "newask" | "failed" | "running" | "notstarted" | "approved" | "merged" | "shipped" | "closed";

/** The chips' order, and the table's groups: what a person can move first, then what is moving, then what is done. */
export const STATUS_ORDER: ReadonlyArray<StatusKey> = ["you", "others", "newask", "failed", "running", "notstarted", "approved", "merged", "shipped", "closed"];

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
  closed: "Closed",
};

export const isStatusKey = (v: string | null | undefined): v is StatusKey => !!v && (STATUS_ORDER as readonly string[]).includes(v);

/** What waits on a person about a problem (lineNeeds' kinds), and whether the viewer holds it. */
export type ProblemNeed = { kind: "decision" | "question" | "confirm" | "reask" | "lapsed" | "stopped"; mine: boolean; /** For a stopped run: the step it stopped at, in words. */ step?: string | null };

/** What the store knows about one problem besides its history. */
export type ProblemFacts = {
  need?: ProblemNeed | null;
  /** Its newest run failed at a step: the cause's key (runReport failCause), the cause in words, the step in words. */
  failed?: { key: string; label: string; step: string | null } | null;
  /** A live run that has said nothing past its threshold, and since when. */
  silent?: { since: number } | null;
  /** The stage its live run is in. */
  stage?: LinePhaseKey | null;
  task?: Pick<LineCauseTask, "status" | "workflow_run_id" | "readiness" | "goal_ref" | "assignee" | "closed_at" | "cause"> & { readiness_note?: string | null } | null;
  /** The problem's notes (task comments), oldest first: an escalation's reason and a park's record read here. */
  notes?: ReadonlyArray<BandNote>;
  /** Grounding parked it until more findings come (lineInbox waitsForFindings): no answer unblocks it. */
  awaitsFindings?: boolean;
  /** Its project's line is on: a ready problem is queued, not merely ready. */
  lineOn?: boolean | null;
  assigneeName?: string | null;
};

export type ProblemStand = {
  status: StatusKey;
  /** The Status column's words. */
  phrase: string;
  /** Failed: the cause it groups under, in plain words. */
  cause?: { key: string; label: string };
  /** In production: no finding since the fix reached it. */
  quiet?: boolean;
  /** Not started: the sweep would start it (the rest are blocked, and the phrase says why). */
  ready?: boolean;
};

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

/** One problem's status and phrase, read off the same band its page draws (problemPage problemBand / problemNow), so a
 *  row and its page never disagree. The list hands in what it knows without the run's visits: its need, its failure or
 *  silence, its live stage, its task and notes. */
export function problemStand(issue: Pick<LineIssue, "history" | "status"> & Partial<Pick<LineIssue, "ask" | "findings" | "dissolvedWhy">>, f: ProblemFacts, now: number): ProblemStand {
  const h = issue.history;
  const why = notStartedWhy({ task: (f.task ?? null) as NotStartedFacts["task"], lineOn: f.lineOn ?? null, awaitsFindings: f.awaitsFindings, cameBack: h.cameBack || h.regressed, assigneeName: f.assigneeName });
  const need = f.need ?? null;
  const asked = need && (need.kind === "decision" || need.kind === "question" || need.kind === "confirm");
  const row: BandInput["row"] = f.failed ? { kind: "failed", at: null, detail: f.failed.label, fail: { key: f.failed.key, label: f.failed.label, step: f.failed.step } as NonNullable<BandInput["row"]>["fail"] }
    : f.silent ? { kind: "stalled", at: f.silent.since, detail: null } : null;
  const band = problemBand({
    issue: { ask: null, findings: 0, dissolvedWhy: null, ...issue } as LineIssue, history: h, run: null,
    // A need someone else holds is a decision open elsewhere: the band reads it as waiting on someone else.
    need: need && (need.mine || !asked) ? { kind: need.kind, since: null, fail: need.step ? { step: need.step } as BandNeed["fail"] : null } : null,
    decision: need && !need.mine && asked ? { ref: "", since: null, mine: false } : null,
    row, task: (f.task ?? null) as BandTask | null, lineOn: f.lineOn ?? null, stage: f.stage ?? null, notStarted: why, notes: f.notes, now,
  });
  const { status, phrase } = problemNow(band);
  if (band.kind === "failed") {
    const key = f.failed?.key ?? `failed-at:${band.step.toLowerCase()}`;
    return { status, phrase, cause: { key, label: f.failed?.label ?? `${band.step} gave up` } };
  }
  if (band.kind === "stalled") return { status, phrase, cause: { key: "silent", label: "No progress" } };
  if (band.kind === "escalated") return { status, phrase, cause: { key: `escalated:${band.step.toLowerCase()}`, label: `${band.step} handed it back` } };
  if (band.kind === "production") return { status, phrase, quiet: band.since === 0 };
  if (band.kind === "notstarted") return { status, phrase, ready: why.ready };
  if (band.kind === "parked" || band.kind === "morefindings") return { status, phrase, ready: false };
  return { status, phrase };
}
