/** How much getting a decision answered matters, as the asking agent judged it: 1 (little rides on it) to 5 (a lot
 *  is stuck or at stake until it is answered). The queue and the Decisions list order by it inside the blocking
 *  tiers, then by age (sd-3584). A row the agent left unscored counts as the middle, so it neither sinks nor jumps. */
export const IMPACT_MIN = 1;
export const IMPACT_MAX = 5;
export const IMPACT_UNSCORED = 3;

/** Why a proposed impact is unusable, or null when it is a whole number on the scale. */
export function invalidImpact(impact: unknown): string | null {
  if (impact === undefined) return null;
  return typeof impact === "number" && Number.isInteger(impact) && impact >= IMPACT_MIN && impact <= IMPACT_MAX
    ? null
    : `impact is a whole number from ${IMPACT_MIN} to ${IMPACT_MAX}`;
}

/** The impact a list sorts by: the agent's score, else the middle of the scale. */
export function impactOf(row: { impact?: number | null }): number {
  return typeof row.impact === "number" ? row.impact : IMPACT_UNSCORED;
}

/** Higher impact first; equal impact compares as 0 so the caller's next key decides. */
export function byImpact(a: { impact?: number | null }, b: { impact?: number | null }): number {
  return impactOf(b) - impactOf(a);
}
