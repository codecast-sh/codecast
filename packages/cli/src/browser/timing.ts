/**
 * Phase timings for `cast browser`, on stderr, when CAST_BROWSER_TIMING=1.
 *
 * Wall-clock numbers on a shared machine mix three unrelated costs: the
 * binary starting, the CLI reaching the browser, and the browser doing the
 * work. Attributing a slow command to the wrong one leads to optimizing the
 * wrong thing, so each phase reports its own delta and the offset from process
 * start (`process.uptime()`, which counts from exec, before any of our code).
 */

export const TIMING_ENV = "CAST_BROWSER_TIMING";

const enabled = process.env[TIMING_ENV] === "1";
let last = process.uptime() * 1000;

/** Record the end of a phase. No-op unless enabled. */
export function mark(label: string): void {
  if (!enabled) return;
  const now = process.uptime() * 1000;
  process.stderr.write(`[timing] ${label.padEnd(18)} +${(now - last).toFixed(0).padStart(5)}ms  @${now.toFixed(0)}ms\n`);
  last = now;
}
