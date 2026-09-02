// The decision half of a team-gated snippet reconcile: given what the machine
// last applied and what the server now says, which snippets to install or
// disable, and what to record afterwards. Pure, so it is testable without a
// daemon; the caller runs the installs.
//
// Only CHANGES act. A slug the server reports the same as last time is left
// alone even if the local flag disagrees, so a human's hand disable sticks
// until the team flips the feature again. A machine with nothing recorded
// treats every reported slug as a change, which is what brings a fleet that
// installed a snippet before its flag existed into line on its first beat.

export type GatedSnippetPlan = {
  /** Snippets to act on, in report order. */
  actions: Array<{ slug: string; enable: boolean }>;
  /** What to record as applied once every action succeeded. A failed action's
   *  slug should be dropped from this by the caller so the next beat retries. */
  next: Record<string, boolean>;
};

/**
 * `isEnabled` answers whether the machine currently has `slug` on, or
 * `undefined` for a slug it does not know. An unknown slug is recorded in
 * `next` but never acted on: the server may report features this binary does
 * not ship yet.
 */
export function planGatedSnippets(
  prev: Record<string, boolean> | undefined,
  avail: Record<string, boolean>,
  isEnabled: (slug: string) => boolean | undefined,
): GatedSnippetPlan {
  const before = prev ?? {};
  const next: Record<string, boolean> = { ...before };
  const actions: GatedSnippetPlan["actions"] = [];
  for (const slug of Object.keys(avail)) {
    const want = avail[slug] === true;
    if (before[slug] === want) continue;
    next[slug] = want;
    const enabled = isEnabled(slug);
    if (enabled === undefined) continue;
    if (want !== enabled) actions.push({ slug, enable: want });
  }
  return { actions, next };
}
