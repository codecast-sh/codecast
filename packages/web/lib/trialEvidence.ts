// A trial card read against its problem's evidence now (convex
// lineTrial.problemEvidence), not the count frozen when the card was built.
// When a re-judge or a merge leaves the problem with no findings, nothing is
// behind the change: the card says so and recommends Drop, naming where the
// evidence went. /trial's list and pane and the problem page read it here.
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import type { TrialCardRow, TrialEvidence } from "../hooks/useSyncTrial";

/** Whether the problem behind a card has no findings left. Unknown (an older backend) is not gone. */
export const evidenceGone = (e: TrialEvidence | null | undefined): boolean => !!e && e.findings === 0;

/** Where the evidence went, in a few words: "moved to ct-59425" or "none held when judged again". */
export function goneWhere(e: TrialEvidence): string {
  if (e.moved_to.length) return `moved to ${e.moved_to.join(", ")}`;
  return e.withdrawn ? "none held when judged again" : "no findings";
}

/** The card as a person should read it now: with its evidence gone, Drop is recommended and says why. */
export function cardAsRead(c: Pick<TrialCardRow, "card" | "evidence">): ChangeCard | undefined {
  const card = c.card;
  if (!card || !c.evidence || !evidenceGone(c.evidence)) return card;
  const why = c.evidence.moved_to.length
    ? `No conversation is behind this problem now: its evidence is now on ${c.evidence.moved_to.join(", ")}, so there is nothing here for this change to fix.`
    : "No conversation is behind this problem now: its findings were judged again and none held, so there is nothing here for this change to fix.";
  return { ...card, recommend: { verdict: "drop", why }, ask: undefined };
}
