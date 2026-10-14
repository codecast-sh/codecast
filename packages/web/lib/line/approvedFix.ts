// An approved fix that never landed (line-journeys.md LJ8.1, "Approved, not
// merged"): the one rule every place reads, so the problem's band, its
// Problems chip and For you's group always hold the same problems. A person
// answered Ship and nothing merged or deployed it: either the run went on past
// its ship step with the merge step off (the fix sits on its branch or pull
// request; the line may already have marked the problem done), or the landing
// step refused because the default branch moved past the branch (`behind`, its
// act is Rebase and land). That is work waiting on someone. Pure.
import type { HistoryAttempt } from "./causeHistory";
import type { LineIssue } from "./lineModel";
import { behindBase } from "./runReport";

export type UnlandedFix = {
  runId: string; at: number | null; ref: string | null; answeredBy: string | null;
  /** The landing refused because the branch is behind this base ("main"): it lands by a rebase. Null when it was never refused. */
  behind: string | null;
};

/** The newest run's approved fix when nothing merged or deployed it; null otherwise. `shipOutput`: what the newest
 *  run's landing step printed (problemPage landingOutput). `isTrial`: a trial records an answer and ships nothing. */
export function unlandedFix(issue: Pick<LineIssue, "status" | "history">, opts: { isTrial?: (runId: string) => boolean; shipOutput?: string | null } = {}): UnlandedFix | null {
  const h = issue.history;
  const last: HistoryAttempt | undefined = h.attempts[h.attempts.length - 1];
  // A merged attempt is landed, whoever merged it (a fix merged by hand through its pull request included).
  if (!last || last.live || last.merge || opts.isTrial?.(last.runId)) return null;
  const fix = { runId: last.runId, at: last.card?.answeredAt ?? last.end, ref: last.card?.ref ?? null, answeredBy: last.card?.answeredBy ?? null };
  // Answered Ship and refused only for being behind: approved, waiting to land (ct-58259), never a failure.
  const terminal = issue.status === "done" || issue.status === "dropped";
  const behind = !terminal && last.card?.status === "answered" && /^ship\b/i.test(last.card.answer ?? "") ? behindBase(opts.shipOutput) : null;
  if (behind) return { ...fix, behind };
  if (issue.status === "dropped" || h.regressed) return null;
  if (last.ended !== "shipped" || last.unapproved) return null;
  // Anything merged or deployed is past this: the problem's band reads it as merged or in production.
  if (h.ships.some((s) => s.merge || s.deploys.length) || h.attempts.some((a) => a.merge && !a.live)) return null;
  return { ...fix, behind: null };
}
