// `cast trigger add --precheck "<shell command>"`: the gate a scheduled or
// recurring trigger runs BEFORE it spends a session.
//
// A trigger that should act only when something changed ("has main moved?",
// "is the queue non-empty?") otherwise burns a whole agent run to discover
// that the answer is no. The precheck answers it in a shell command: exit 0
// means run, anything else means record the run as skipped and spend nothing.
//
// One vocabulary, three consumers: the CLI flag and the daemon's runner, the
// Convex mutation that records the skip, and the web surfaces that render it.

/** Wall clock a precheck gets before it is killed and treated as a failure. */
export const TRIGGER_PRECHECK_TIMEOUT_MS = 60_000;

/** Combined stdout+stderr kept on a skip row — enough to see why, not a log. */
export const TRIGGER_PRECHECK_OUTPUT_CHARS = 2_000;

/** What a precheck run produced. `exitCode` is absent when the command timed
 *  out or never started, which is why `timedOut`/`error` are separate. */
export interface TriggerPrecheckResult {
  command: string;
  exitCode?: number;
  timedOut: boolean;
  durationMs: number;
  /** Tail of stdout+stderr, capped at TRIGGER_PRECHECK_OUTPUT_CHARS. */
  output?: string;
  /** Set when the command could not run at all (bad cwd, spawn refused). */
  error?: string;
}

/** Exit 0 and nothing else. A timeout, a spawn failure and a non-zero exit all
 *  fail closed: the trigger did not prove there was work to do. */
export function triggerPrecheckPassed(result: TriggerPrecheckResult): boolean {
  return !result.timedOut && !result.error && result.exitCode === 0;
}

/** One line naming why a run was skipped — the reason stored on the trigger
 *  row and shown by `cast trigger log` and the trigger detail page. */
export function describeTriggerPrecheckFailure(result: TriggerPrecheckResult): string {
  if (result.timedOut) {
    return `precheck timed out after ${Math.round(result.durationMs / 1000)}s`;
  }
  if (result.error) return `precheck could not run: ${result.error}`;
  return `precheck exited ${result.exitCode ?? "with no status"}`;
}
