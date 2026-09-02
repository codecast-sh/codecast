// A counting semaphore: `run` holds one of `limit` slots for the length of
// `fn`, and callers past the limit wait in arrival order. Bounds work that
// fans out from one tick (image uploads, transcript primes) so a burst of N
// requests never means N buffers in flight.

export type Semaphore = {
  run<T>(fn: () => Promise<T>): Promise<T>;
};

export function countingSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < limit) {
        active++;
        resolve();
      } else {
        waiters.push(() => {
          active++;
          resolve();
        });
      }
    });
  const release = (): void => {
    active--;
    waiters.shift()?.();
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return { run };
}
