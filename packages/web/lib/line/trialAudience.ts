// Who a trial card waits on. A trial decision is the trial owner's practice
// answer, listed for anyone who opens the line, unless a role owns it: a judge
// fix belongs to the role the trial names for its route (convex
// sessionDecisions.routeFor), and is asked only of the person that role's line
// ends at. Such a card waits in their For you and in nobody else's.

type AudienceCard = { decision?: { asked?: ReadonlyArray<string>; for_role?: unknown } | null };

export function trialCardIsFor(card: AudienceCard, viewer: string | null | undefined): boolean {
  const d = card.decision;
  if (!d?.for_role) return true;
  return !!viewer && (d.asked ?? []).includes(viewer);
}
