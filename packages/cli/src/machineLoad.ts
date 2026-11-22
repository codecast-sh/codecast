import os from "node:os";

/** How many times slower than an idle machine wall-clock work runs here right
 *  now. Below two runnable threads per core it is 1; above that it is the run
 *  queue per core, because the scheduler queue, not the work, then sets how
 *  long anything takes. */
export function machineLoadFactor(loadPerCpu = os.loadavg()[0] / Math.max(1, os.cpus().length)): number {
  return loadPerCpu <= 2 ? 1 : loadPerCpu;
}

/** `baseMs` stretched for this machine's load, at most `maxFactor` times: a
 *  loaded machine slows what is bounded by it instead of failing it, and an
 *  idle one keeps the bound as written. Tests bound their waits with it
 *  (test-helpers/pollUntil.ts), and the runner a hand's quiet time (runner.ts). */
export function loadScaledMs(baseMs: number, maxFactor = 8, factor = machineLoadFactor()): number {
  return Math.round(baseMs * Math.min(maxFactor, factor));
}
