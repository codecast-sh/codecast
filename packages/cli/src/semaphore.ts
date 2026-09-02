// A counting semaphore: `run` holds one of `limit` slots for the length of
// `fn`, and callers past the limit wait in arrival order. Bounds work that
// fans out from one tick (image uploads, transcript primes) so a burst of N
// requests never means N buffers in flight. A `front` caller waits ahead of
// the queue instead: a live request must not sit behind a fleet replay.

export type Semaphore = {
  run<T>(fn: () => Promise<T>, opts?: { front?: boolean }): Promise<T>;
};

export function countingSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (front: boolean): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < limit) {
        active++;
        resolve();
        return;
      }
      const grant = () => {
        active++;
        resolve();
      };
      if (front) waiters.unshift(grant);
      else waiters.push(grant);
    });
  const release = (): void => {
    active--;
    waiters.shift()?.();
  };
  const run = async <T>(fn: () => Promise<T>, opts?: { front?: boolean }): Promise<T> => {
    await acquire(opts?.front === true);
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return { run };
}
