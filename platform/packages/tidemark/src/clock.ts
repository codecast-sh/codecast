/** The read clock. Hosts that replay or simulate pass their own. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to. */
export interface FixedClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function fixedClock(start: number): FixedClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
