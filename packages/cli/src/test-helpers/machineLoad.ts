import os from "node:os";

/** How many times slower than an idle machine wall-clock work runs here right
 *  now. Below two runnable threads per core it is 1; above that it is the run
 *  queue per core, because the scheduler queue, not the work, then sets how
 *  long anything takes. */
export function machineLoadFactor(): number {
  const perCpu = os.loadavg()[0] / Math.max(1, os.cpus().length);
  return perCpu <= 2 ? 1 : perCpu;
}

/** `baseMs` stretched for this machine's load, at most `maxFactor` times. A
 *  wall-clock bound in a test (a child process timeout, a fixture's wait, the
 *  test's own timeout) goes through this, so a loaded laptop slows the test
 *  down instead of failing it, and an idle one keeps the bound as written. */
export function loadScaledMs(baseMs: number, maxFactor = 8): number {
  return Math.round(baseMs * Math.min(maxFactor, machineLoadFactor()));
}
