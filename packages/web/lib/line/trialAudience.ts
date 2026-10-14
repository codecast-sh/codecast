// Who a trial card waits on. A trial card is the trial owner's practice
// answer, listed for anyone who opens the line, unless a role owns it: a judge
// fix belongs to the role the trial names for its route (convex
// lineTrial.audienceOf), and waits only on the person that role's line ends
// at. Such a card is in their For you and in nobody else's.

type AudienceCard = { audience?: { asked: ReadonlyArray<string> } | null };

export function trialCardIsFor(card: AudienceCard, viewer: string | null | undefined): boolean {
  if (!card.audience) return true;
  return !!viewer && card.audience.asked.includes(viewer);
}
