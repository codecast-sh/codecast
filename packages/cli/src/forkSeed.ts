// Seed bodies for `cast fork "<direction>" ...` branches.
//
// A branch inherits the parent's full history up to the fork point. When the
// parent was planning a fan-out ("I will launch N forks..."), that plan
// dominates the branch's transcript — and a branch that is later restarted
// re-reads it and resumes AS the orchestrator, launching a duplicate fleet
// (observed live: colliding fleets, sessions "standing down" each other).
//
// The seed is the last message in the branch's transcript, so it is where the
// correction belongs: name the branch's one direction, list the siblings that
// already own every other direction, and state that the fan-out is complete.
// Restarts re-read the same transcript, so the contract holds across resumes.

export interface ForkBranchRef {
  short_id: string;
  direction: string;
}

/** First non-empty line of a direction, trimmed to fit a sibling roster row. */
export function previewDirection(direction: string, max = 120): string {
  const first = direction.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * The seed body for branch `index` of a fan-out. `roster` is every branch of
 * this `cast fork` invocation, in creation order — which is why branches are
 * created first and seeded after: each seed names the full sibling roster.
 */
export function buildForkSeedBody(index: number, roster: ForkBranchRef[]): string {
  const own = roster[index];
  if (roster.length === 1) {
    return (
      `This conversation is a fork — an independent branch of the parent, with one direction:\n\n` +
      `${own.direction}\n\n` +
      `The parent thread continues separately. Work only this branch's direction.`
    );
  }

  const siblings = roster
    .filter((_, i) => i !== index)
    .map((b) => `- ${b.short_id} — ${previewDirection(b.direction)}`)
    .join("\n");

  return (
    `You are one branch of a fork fan-out: the parent conversation split into ${roster.length} parallel branches here, one per direction. ` +
    `The fan-out is complete — every other direction is owned by a live sibling branch. ` +
    `If the history above plans to launch forks or act as an orchestrator, that plan already ran and produced these branches. Never run it again, including after a restart or resume.\n\n` +
    `Your direction — the only work this branch owns:\n\n` +
    `${own.direction}\n\n` +
    `Sibling branches, each already seeded with its own direction:\n${siblings}\n\n` +
    `Work only your direction. Do not fork, spawn, or coordinate siblings.`
  );
}
