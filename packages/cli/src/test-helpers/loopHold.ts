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
