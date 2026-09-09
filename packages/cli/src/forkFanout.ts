// How `cast fork` splits N directions between this thread and new branches.
//
// Two or more directions describe a fan-out the human wants to see side by
// side, and the session running the command is one of those threads: it takes
// the first direction and continues in place, so two directions cost two
// inbox cards, not three (two branches plus a parent whose only content is
// the roster). One direction is a spin-off: the branch takes it and this
// thread carries on with whatever it was doing. `allBranches` keeps every
// direction off this thread, for the cases where the human wants this session
// to stay a hub (or every direction on a cloud host).
export type ForkFanout = {
  // The direction this session continues with itself, if any.
  parentDirection?: string;
  // One new branch per entry, in the order given.
  branchDirections: string[];
};

export function planForkFanout(directions: string[], opts: { allBranches?: boolean } = {}): ForkFanout {
  if (opts.allBranches || directions.length < 2) {
    return { branchDirections: [...directions] };
  }
  const [parentDirection, ...branchDirections] = directions;
  return { parentDirection, branchDirections };
}
