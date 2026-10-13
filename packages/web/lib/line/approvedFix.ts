// An approved fix that never landed (line-journeys.md LJ8.1, "Approved, not
// merged"). A person answered Ship, the run went on past its ship step, and
// nothing merged or deployed it. The line's merge step is off, so the fix sits
// on its branch (or its pull request) until a person opens or merges it; the
// line may already have marked the problem done. That is work waiting on
// someone, so it is a need (For you) and Problems counts it under Waiting on you. Pure.
import type { HistoryAttempt } from "./causeHistory";
import type { LineIssue } from "./lineModel";

export type UnlandedFix = { runId: string; at: number | null; ref: string | null; answeredBy: string | null };

/** The newest run's approved fix when nothing merged or deployed it; null otherwise. `isTrial`: a trial records an
 *  answer and ships nothing. */
export function unlandedFix(issue: Pick<LineIssue, "status" | "history">, opts: { isTrial?: (runId: string) => boolean } = {}): UnlandedFix | null {
  const h = issue.history;
  if (issue.status === "dropped" || h.regressed || h.cameBack) return null;
  const last: HistoryAttempt | undefined = h.attempts[h.attempts.length - 1];
  if (!last || last.live || last.ended !== "shipped" || last.unapproved || last.merge) return null;
  if (opts.isTrial?.(last.runId)) return null;
  // Anything merged or deployed is past this: the problem's band reads it as merged or in production.
  if (h.ships.some((s) => s.merge || s.deploys.length) || h.attempts.some((a) => a.merge && !a.live)) return null;
  return { runId: last.runId, at: last.card?.answeredAt ?? last.end, ref: last.card?.ref ?? null, answeredBy: last.card?.answeredBy ?? null };
}
