// Where a problem stands, as the Problems page files it (line-journeys.md
// LJ8.2): nine statuses that partition the problems, so the chips sum to All
// and each chip's count is the rows it opens. The first match wins, in the
// order of PRECEDENCE; the phrase is the row's one statement of state. Pure:
// the caller hands in what the store knows about each problem (its need, its
// failure, its task row), so the reading of a need has one home (lineNeeds).
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import type { LineCauseTask } from "../lineFlow";
import { startableCause } from "../lineFlow";
import type { CauseHistory } from "./causeHistory";
import { waitsForFindings } from "./lineInbox";
import type { LineIssue } from "./lineModel";
import { neverShipped } from "./timeline";

export type StatusKey = "you" | "others" | "newask" | "failed" | "running" | "notstarted" | "merged" | "shipped" | "closed";

/** The chips' order, and the table's groups: what a person can move first, then what is moving, then what is done. */
export const STATUS_ORDER: ReadonlyArray<StatusKey> = ["you", "others", "newask", "failed", "running", "notstarted", "merged", "shipped", "closed"];

export const STATUS_LABELS: Record<StatusKey, string> = {
  you: "Waiting on you",
  others: "Someone else",
  newask: "Needs a new ask",
  failed: "Failed",
  running: "Running",
  notstarted: "Not started",
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
  task?: Pick<LineCauseTask, "status" | "workflow_run_id" | "readiness" | "readiness_note" | "goal_ref" | "assignee" | "closed_at" | "cause"> | null;
  /** Its project's line is on: a ready problem is queued, not merely ready. */
  lineOn?: boolean;
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

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const RUNNING_WORDS: Record<LinePhaseKey, string> = { understand: "Investigating", prove: "Proving", build: "Building", check: "Verifying", decide: "Presenting", ship: "Shipping" };

const CLOSED = new Set(["dropped", "closed", "cancelled", "canceled", "wontfix", "done"]);

/** How long a run has been silent, in a status phrase's words: "2h", "3d". */
function silentWords(ms: number): string {
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

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

/** Why a problem nothing is working on has not started, and whether the sweep would start it. */
function notStarted(f: ProblemFacts): { phrase: string; ready: boolean } {
  const t = f.task;
  if (!t) return { phrase: f.lineOn ? "Queued" : "Ready", ready: true };
  const blocked = (phrase: string) => ({ phrase, ready: false });
  if (t.readiness === "needs_context" && waitsForFindings(t.readiness_note)) return blocked(`Waiting for more findings (has ${t.cause?.signal_count ?? 0})`);
  if (t.status === "in_review") return blocked("In review");
  if (t.status !== "open") return blocked("Not open");
  if (t.workflow_run_id) return blocked("Held by an earlier run");
  if (t.readiness === "needs_context") return blocked("Needs a fact");
  if (!t.readiness) return blocked("Not grounded yet");
  if (t.readiness === "not_actionable") return blocked("Nothing to change");
  if (t.assignee) return blocked(f.assigneeName ? `Assigned to ${f.assigneeName}` : "Assigned to someone");
  if (t.readiness === "ready" && !t.goal_ref?.trim()) return blocked("Needs a goal");
  if (!startableCause(t as LineCauseTask)) return blocked("Blocked");
  return { phrase: f.lineOn ? "Queued" : "Ready", ready: true };
}

/** One problem's status and phrase. Every problem gets exactly one status: the first that matches, in this order. */
export function problemStand(issue: Pick<LineIssue, "history" | "status">, f: ProblemFacts, now: number): ProblemStand {
  const h = issue.history;
  const last = h.attempts[h.attempts.length - 1];
  const need = f.need ?? null;
  const parked = last?.ended === "parked";
  // 1. A need the viewer holds and can answer in place.
  if (need?.mine && (need.kind === "decision" || need.kind === "question" || need.kind === "confirm")) {
    return { status: "you", phrase: need.kind === "decision" ? "Fix to decide" : need.kind === "confirm" ? "New: is this real?" : parked ? "Needs a fact from you" : "Question for you" };
  }
  // 2. The same, held by someone else: a decision open on its newest run that is not in the viewer's queue.
  const card = last?.card;
  const openCard = !!card && !card.answer && (card.status === "pending" || card.status === "waiting");
  if ((need && !need.mine && (need.kind === "decision" || need.kind === "question" || need.kind === "confirm")) || (!need && openCard && !last?.unapproved)) {
    return { status: "others", phrase: "Waiting on someone else" };
  }
  // 3. Something that needs asking again before anyone can answer it.
  if (need) {
    return { status: "newask", phrase: need.kind === "lapsed" ? "Asked, no answer" : need.kind === "stopped" ? `Stopped at ${need.step ?? "a step"}: needs your yes` : "Needs a new ask" };
  }
  // 4. The newest run failed at a step, or a live run has gone silent.
  if (f.failed) return { status: "failed", phrase: f.failed.step ? `Failed at ${f.failed.step}` : "Failed", cause: { key: f.failed.key, label: f.failed.label } };
  if (f.silent) return { status: "failed", phrase: `No progress for ${silentWords(now - f.silent.since)}`, cause: { key: "silent", label: "No progress" } };
  // 5. A live run. One paused for an answer nobody was asked is a new ask, never "running".
  if (last?.live) {
    if (last.outcome.tone === "waiting") return { status: "newask", phrase: "Needs a new ask" };
    return { status: "running", phrase: f.stage ? RUNNING_WORDS[f.stage] : "Running" };
  }
  // 6, 7. A fix went out: in production when a deploy carried it, else merged.
  const fix = fixOut(h);
  if (fix?.inProduction) {
    if (fix.since > 0) return { status: "shipped", phrase: `In production, ${fix.since} since`, quiet: false };
    return { status: "shipped", phrase: fix.watchEnd ? `In production, watching until ${day(fix.watchEnd)}` : `In production, quiet since ${day(fix.at)}`, quiet: true };
  }
  if (fix) return { status: "merged", phrase: !fix.merged ? `Shipped ${day(fix.at)}, no merge recorded` : fix.deploysKnown ? "Merged, not in production" : `Merged ${day(fix.at)}` };
  // 8. Closed without a fix, and it stayed closed.
  const close = h.closes[h.closes.length - 1];
  if (!h.cameBack && !h.regressed && (close || CLOSED.has(issue.status))) {
    const at = close?.at ?? f.task?.closed_at ?? null;
    return { status: "closed", phrase: at ? `Closed ${day(at)}` : "Closed" };
  }
  // 9. Nothing is working on it.
  return { status: "notstarted", ...notStarted(f) };
}
