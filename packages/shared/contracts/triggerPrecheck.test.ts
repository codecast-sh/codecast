import { describe, expect, test } from "bun:test";
import {
  describeTriggerPrecheckFailure,
  triggerFiringSource,
  triggerPrecheckApplies,
  triggerPrecheckPassed,
  judgeTriggerPrecheck,
  triggerPrecheckMode,
  TRIGGER_PRECHECK_STATE_CHARS,
  type TriggerFiringSource,
  type TriggerPrecheckResult,
} from "./triggerPrecheck";

// Who asked for this firing, and does the --precheck gate get a say?
// The gate exists to stop a schedule spending a session on a guess. A person
// pressing Run now is not a guess, so it must never answer them with silence.
describe("trigger firing source", () => {
  test("a manual request outranks whatever the schedule says", () => {
    expect(triggerFiringSource("once", "manual")).toBe("manual");
    expect(triggerFiringSource("recurring", "manual")).toBe("manual");
    expect(triggerFiringSource("event", "manual")).toBe("manual");
  });

  test("with no request, the schedule names the source", () => {
    expect(triggerFiringSource("once")).toBe("scheduled");
    expect(triggerFiringSource("recurring")).toBe("recurring");
    expect(triggerFiringSource("event")).toBe("event");
    // An unset schedule_type is a one-shot, same as `once`.
    expect(triggerFiringSource(undefined)).toBe("scheduled");
  });

  test("only a value of exactly \"manual\" counts as a request", () => {
    expect(triggerFiringSource("recurring", "")).toBe("recurring");
    expect(triggerFiringSource("recurring", "scheduled")).toBe("recurring");
  });
});

describe("which firings the precheck gates", () => {
  test("the schedule's own firings are gated", () => {
    expect(triggerPrecheckApplies("scheduled")).toBe(true);
    expect(triggerPrecheckApplies("recurring")).toBe(true);
  });

  test("a manual firing bypasses the gate — the person asking is the evidence", () => {
    expect(triggerPrecheckApplies("manual")).toBe(false);
  });

  test("an event firing bypasses the gate — the webhook is the evidence", () => {
    expect(triggerPrecheckApplies("event")).toBe(false);
  });

  test("every source is decided, none falls through", () => {
    const sources: TriggerFiringSource[] = ["manual", "scheduled", "recurring", "event"];
    for (const source of sources) expect(typeof triggerPrecheckApplies(source)).toBe("boolean");
  });
});

// The gate fails closed: only a clean exit 0 proves there is work to do.
describe("precheck outcome", () => {
  const base = { command: "make check", timedOut: false, durationMs: 12 };

  test("exit 0 passes; everything else does not", () => {
    expect(triggerPrecheckPassed({ ...base, exitCode: 0 })).toBe(true);
    expect(triggerPrecheckPassed({ ...base, exitCode: 1 })).toBe(false);
    expect(triggerPrecheckPassed({ ...base, timedOut: true, durationMs: 60_000 })).toBe(false);
    expect(triggerPrecheckPassed({ ...base, error: "spawn failed" })).toBe(false);
  });

  test("the reason names what went wrong", () => {
    expect(describeTriggerPrecheckFailure({ ...base, exitCode: 3 })).toBe("precheck exited 3");
    expect(describeTriggerPrecheckFailure({ ...base, timedOut: true, durationMs: 60_000 })).toBe(
      "precheck timed out after 60s"
    );
    expect(describeTriggerPrecheckFailure({ ...base, error: "bad cwd" })).toBe(
      "precheck could not run: bad cwd"
    );
  });
});

describe("judging a precheck by its mode", () => {
  const ran = (stdout: string, exitCode = 0, extra: Partial<TriggerPrecheckResult> = {}): TriggerPrecheckResult => ({ command: "x", exitCode, timedOut: false, durationMs: 1, stdout, ...extra });
  const fp = (s: string) => `fp:${s}`;

  test("exit mode is the gate as it was: exit 0 runs, anything else skips", () => {
    expect(judgeTriggerPrecheck("exit", ran("", 0), undefined, fp)).toEqual({ wake: true });
    expect(judgeTriggerPrecheck("exit", ran("", 2), undefined, fp)).toEqual({ wake: false, reason: "precheck exited 2" });
    expect(triggerPrecheckMode(undefined)).toBe("exit");
    expect(triggerPrecheckMode("bogus")).toBe("exit");
  });

  test("changes mode records a baseline, skips the same output and wakes on a different one with it as the message", () => {
    expect(judgeTriggerPrecheck("changes", ran("a\n"), undefined, fp)).toEqual({ wake: false, reason: "precheck output recorded; the next change wakes it", state: "fp:a\n" });
    expect(judgeTriggerPrecheck("changes", ran("a\n"), "fp:a\n", fp)).toEqual({ wake: false, reason: "precheck output unchanged" });
    expect(judgeTriggerPrecheck("changes", ran("a\nb\n"), "fp:a\n", fp)).toEqual({ wake: true, state: "fp:a\nb\n", message: "a\nb" });
    // A failed command says nothing about change, and keeps the record.
    expect(judgeTriggerPrecheck("changes", ran("b", 1), "fp:a\n", fp)).toEqual({ wake: false, reason: "precheck exited 1" });
    expect(judgeTriggerPrecheck("changes", ran("x", 0, { stdoutTruncated: true }), "fp:a", fp).wake).toBe(false);
  });

  test("state mode reads the verdict, keeps the state either way and carries the message", () => {
    expect(judgeTriggerPrecheck("state", ran('{"wake":false,"state":{"n":1}}'), "null", fp)).toEqual({ wake: false, reason: "precheck said not yet", state: '{"n":1}' });
    expect(judgeTriggerPrecheck("state", ran('{"wake":true,"state":2,"message":" go "}'), "1", fp)).toEqual({ wake: true, state: "2", message: "go" });
    // No state in the verdict keeps the stored one.
    expect(judgeTriggerPrecheck("state", ran('{"wake":true}'), "1", fp)).toEqual({ wake: true });
    expect(judgeTriggerPrecheck("state", ran("not json"), "1", fp).reason).toContain("printed no");
    expect(judgeTriggerPrecheck("state", ran(JSON.stringify({ wake: true, state: "x".repeat(TRIGGER_PRECHECK_STATE_CHARS) })), "1", fp).wake).toBe(false);
  });
});
