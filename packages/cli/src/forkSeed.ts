// Seed bodies for `cast fork "<direction>" ...` branches.
//
// A branch inherits the parent's full history up to the fork point. When the
// parent was planning a fan-out ("I will launch N forks..."), that plan
// dominates the branch's transcript — and a branch that is later restarted
// re-reads it and resumes AS the orchestrator, launching a duplicate fleet
// (observed live: colliding fleets, sessions "standing down" each other).
//
// The seed is the last message in the branch's transcript, so it is where the
// correction belongs: the fan-out is complete, every other direction is owned,
// this branch owns exactly one. Restarts re-read the same transcript, so the
// contract holds across resumes. Deliberately NO sibling roster: branches are
// independent, and handing each one the others' ids invites the coordination
// traffic this exists to prevent.

/** The seed body for branch `index` of a fan-out over `directions`. */
export function buildForkSeedBody(index: number, directions: string[]): string {
  const own = directions[index];
  if (directions.length === 1) {
    return (
      `This conversation is a fork — an independent branch of the parent, with one direction:\n\n` +
      `${own}\n\n` +
      `The parent thread continues separately. Work only this branch's direction.`
    );
  }

  return (
    `You are one branch of a fork fan-out: the parent conversation split into ${directions.length} independent parallel branches here, one per direction. ` +
    `The fan-out is complete — every other direction is already owned by its own branch. ` +
    `If the history above plans to launch forks or act as an orchestrator, that plan already ran and produced these branches. Never run it again, including after a restart or resume.\n\n` +
    `Your direction — the only work this branch owns:\n\n` +
    `${own}\n\n` +
    `Work only this direction and report to the human in this thread. Do not fork, spawn, or coordinate with the other branches.`
  );
}
