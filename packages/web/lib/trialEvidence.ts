// A trial card read against its problem's evidence now (convex
// lineTrial.problemEvidence), not the count frozen when the card was built.
// When a re-judge or a merge leaves the problem with no findings, nothing is
// behind the change: the card says so and recommends Drop, naming where the
// evidence went. /trial's list and pane and the problem page read it here.
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import type { TrialCardRow, TrialEvidence, TrialWithdrawn } from "../hooks/useSyncTrial";

/** Whether the problem behind a card has no findings left. Unknown (an older backend) is not gone. */
export const evidenceGone = (e: TrialEvidence | null | undefined): boolean => !!e && e.findings === 0;

/** How one finding left its problem, in a few words: "judged again: not a defect", "moved to ct-59517". */
export function fateWords(g: TrialWithdrawn): string {
  if (g.to) return `moved to ${g.to}`;
  if (g.fate === "rejudged") return "judged again: not a defect";
  if (g.fate === "duplicate") return "a copy of a finding on a closed problem";
  if (g.fate === "found_wrong") return "found wrong by the fix run's proof";
  return "withdrawn";
}

/** Where the evidence went, in a few words: "moved to ct-59425" or "none held when judged again". */
export function goneWhere(e: TrialEvidence): string {
  if (e.moved_to.length) return `moved to ${e.moved_to.join(", ")}`;
  const fates = new Set((e.gone ?? []).map((g) => g.fate));
  if (fates.size === 1 && fates.has("found_wrong")) return "found wrong by the fix run's proof";
  if (fates.size === 1 && fates.has("duplicate")) return "copies of findings on closed problems";
  if (fates.has("rejudged") || e.withdrawn) return "none held when judged again";
  return "no findings";
}

/**
 * The card as a person should read it now: with its evidence gone, Drop is
 * recommended for that reason alone (`recommend.source` "evidence"), so a
 * surface says the why and not the checks the author's verdict rested on.
 */
export function cardAsRead(c: Pick<TrialCardRow, "card" | "evidence">): ChangeCard | undefined {
  const card = c.card;
  if (!card || !c.evidence || !evidenceGone(c.evidence)) return card;
  const why = c.evidence.moved_to.length
    ? `no conversation is behind this problem now; its findings sit on ${c.evidence.moved_to.join(", ")}.`
    : `no conversation is behind this problem now; ${goneWhere(c.evidence)}.`;
  return { ...card, recommend: { verdict: "drop", why: why.charAt(0).toUpperCase() + why.slice(1), source: "evidence" }, ask: undefined };
}
