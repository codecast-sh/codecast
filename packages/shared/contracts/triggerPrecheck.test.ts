import { describe, expect, test } from "bun:test";
import {
  describeTriggerPrecheckFailure,
  triggerFiringSource,
  triggerPrecheckApplies,
  triggerPrecheckPassed,
  type TriggerFiringSource,
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
