// `cast trigger add --precheck "<shell command>"`: the gate a scheduled or
// recurring trigger runs BEFORE it spends a session.
//
// A trigger that should act only when something changed ("has main moved?",
// "is the queue non-empty?") otherwise burns a whole agent run to discover
// that the answer is no. The precheck answers it in a shell command, read one
// of three ways (TriggerPrecheckMode): by its exit code, by whether its output
// changed since the last firing, or by the JSON verdict it prints. A firing it
// refuses is recorded as skipped and spends nothing.
//
// One vocabulary, three consumers: the CLI flag and the daemon's runner, the
// Convex mutation that records the skip, and the web surfaces that render it.

/** Wall clock a precheck gets before it is killed and treated as a failure. */
export const TRIGGER_PRECHECK_TIMEOUT_MS = 60_000;

/** Combined stdout+stderr kept on a skip row — enough to see why, not a log. */
export const TRIGGER_PRECHECK_OUTPUT_CHARS = 2_000;

/**
 * How a precheck's run is read.
 *   exit     exit 0 runs, anything else skips (the default, stored as absent).
 *   changes  runs when stdout differs from the previous firing's. The first
 *            firing records what it printed and skips; a non-zero exit skips
 *            and leaves the record alone.
 *   state    the command gets the previous state in CAST_PRECHECK_STATE (JSON,
 *            `null` at first) and prints `{"wake": bool, "state": any,
 *            "message": string}`. The state is kept for the next firing
 *            whether or not it wakes; the message goes into the run it wakes.
 */
export const TRIGGER_PRECHECK_MODES = ["exit", "changes", "state"] as const;
export type TriggerPrecheckMode = (typeof TRIGGER_PRECHECK_MODES)[number];

/** The env var a `state` precheck reads its previous state from. */
export const TRIGGER_PRECHECK_STATE_ENV = "CAST_PRECHECK_STATE";

/** Largest state a `state` precheck may keep, and the stdout read from any
 *  precheck: room for a cursor or a list of ids, not a database. */
export const TRIGGER_PRECHECK_STATE_CHARS = 16_000;

/** Longest message a precheck may hand its run. */
export const TRIGGER_PRECHECK_MESSAGE_CHARS = 4_000;

/** A firing that continues one its gate already woke: the retry of a failed
 *  run, or a run parked at a usage limit resuming. A `changes` or `state`
 *  gate kept its new state when it woke, so asking it again would answer
 *  "unchanged" and the work it found would never run: a continuing firing
 *  runs ungated and keeps the message it was woken with. */
export function triggerFiringContinues(task: { retry_count?: number | null; parked_run_session_uuid?: string | null }): boolean {
  return (task.retry_count ?? 0) > 0 || !!task.parked_run_session_uuid;
}

/** The mode a stored trigger runs its precheck in. */
export function triggerPrecheckMode(stored: string | null | undefined): TriggerPrecheckMode {
  return stored === "changes" || stored === "state" ? stored : "exit";
}

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
  /** Its stdout alone, up to TRIGGER_PRECHECK_STATE_CHARS, for the modes
   *  that read it; `stdoutTruncated` when it printed more. */
  stdout?: string;
  stdoutTruncated?: boolean;
}

/** One firing's answer: whether it runs, why not when it does not, the state
 *  to keep (absent: keep what is stored) and the message for the run. */
export interface TriggerPrecheckVerdict {
  wake: boolean;
  reason?: string;
  state?: string;
  message?: string;
}

/**
 * Read a precheck run in its mode. `previous` is the stored state: for
 * `changes`, the fingerprint of the last stdout (`fingerprint` makes one); for
 * `state`, the last state as JSON.
 */
export function judgeTriggerPrecheck(
  mode: TriggerPrecheckMode,
  result: TriggerPrecheckResult,
  previous: string | undefined,
  fingerprint: (stdout: string) => string,
): TriggerPrecheckVerdict {
  if (mode === "exit" || !triggerPrecheckPassed(result)) {
    return triggerPrecheckPassed(result) ? { wake: true } : { wake: false, reason: describeTriggerPrecheckFailure(result) };
  }
  const stdout = result.stdout ?? "";
  if (mode === "changes") {
    if (result.stdoutTruncated) return { wake: false, reason: `precheck printed more than ${TRIGGER_PRECHECK_STATE_CHARS} characters; a changes gate compares its whole output` };
    const state = fingerprint(stdout);
    if (previous === undefined) return { wake: false, reason: "precheck output recorded; the next change wakes it", state };
    if (state === previous) return { wake: false, reason: "precheck output unchanged" };
    const message = stdout.trim().slice(0, TRIGGER_PRECHECK_MESSAGE_CHARS);
    return { wake: true, state, ...(message ? { message } : {}) };
  }
  let verdict: any;
  try {
    verdict = JSON.parse(stdout);
  } catch {
    verdict = null;
  }
  if (!verdict || typeof verdict !== "object" || typeof verdict.wake !== "boolean") {
    return { wake: false, reason: 'precheck printed no {"wake": true|false, "state": ..., "message": ...} JSON' };
  }
  let state: string | undefined;
  if ("state" in verdict) {
    state = JSON.stringify(verdict.state ?? null);
    if (state.length > TRIGGER_PRECHECK_STATE_CHARS) return { wake: false, reason: `precheck state is over ${TRIGGER_PRECHECK_STATE_CHARS} characters; it was not kept` };
  }
  const message = typeof verdict.message === "string" && verdict.message.trim() ? verdict.message.trim().slice(0, TRIGGER_PRECHECK_MESSAGE_CHARS) : undefined;
  if (!verdict.wake) return { wake: false, reason: message ? `precheck: ${message}` : "precheck said not yet", ...(state !== undefined ? { state } : {}) };
  return { wake: true, ...(state !== undefined ? { state } : {}), ...(message ? { message } : {}) };
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

/** Why a trigger is firing right now. Three of the four come from its own
 *  schedule; `manual` is a person asking — `cast trigger run tr-42` or the web
 *  Run now button. */
export type TriggerFiringSource = "manual" | "scheduled" | "recurring" | "event";

/** The source of one firing, from the trigger's schedule and whatever the run
 *  request stamped on the row. A manual request outranks the schedule: the
 *  same recurring trigger fires as `recurring` on its cadence and as `manual`
 *  when someone presses Run now. */
export function triggerFiringSource(
  scheduleType: string | undefined,
  requestedSource?: string
): TriggerFiringSource {
  if (requestedSource === "manual") return "manual";
  if (scheduleType === "recurring") return "recurring";
  if (scheduleType === "event") return "event";
  return "scheduled";
}

/** Whether the --precheck gate applies to this firing.
 *
 *  Why (ct-49673): a person asking for a run IS the evidence the gate exists
 *  to find, so a manual firing never asks a shell command for permission — a
 *  silently skipped Run now looks like a broken button. An event firing
 *  already carries its evidence in the webhook that woke it. Only the
 *  schedule's own firings spend a session on a guess, so only they are gated. */
export function triggerPrecheckApplies(source: TriggerFiringSource): boolean {
  return source === "scheduled" || source === "recurring";
}
