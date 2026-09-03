import os from "node:os";

// A timer probe that reports the longest stretch the event loop was held
// while an async job ran. A timer that fires late by more than its interval
// means nothing else could run in between; the largest such gap is the
// longest single hold. Shared by the priming and ingest timing tests.
export async function measureLoopHold<T>(
  fn: () => Promise<T>,
  tickMs = 5,
): Promise<{ result: T; maxGapMs: number; ticks: number }> {
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last - tickMs);
    last = now;
    ticks++;
  }, tickMs);
  try {
    const result = await fn();
    return { result, maxGapMs, ticks };
  } finally {
    clearInterval(timer);
  }
}

// The bar the plan sets for the daemon: the loop never blocks past one second.
export const LOOP_HOLD_SLO_MS = 1_000;

/** The gap a test may tolerate on this machine. A 5ms timer on a loaded box
 *  fires late by hundreds of ms with nothing on the loop at all, because the
 *  scheduler queue, not the work, sets the latency. Below two runnable
 *  threads per core the caller's bound stands; above it the bound grows with
 *  the queue and stops at the SLO, so a loaded laptop still proves the work
 *  never held the loop past what the daemon promises. */
export function loopHoldBoundMs(baseMs: number): number {
  const perCpu = os.loadavg()[0] / Math.max(1, os.cpus().length);
  if (perCpu <= 2) return baseMs;
  return Math.min(LOOP_HOLD_SLO_MS, Math.round(baseMs * perCpu));
}
