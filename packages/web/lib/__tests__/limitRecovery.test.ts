import { describe, expect, test } from "bun:test";
import { limitRecoveryAction, limitRecoveryPhase, RESUMED_MATCH_MS } from "../limitRecovery";

const PARK = 1_790_671_650_000;

describe("limitRecoveryAction", () => {
  test("an auto-switch continue after the park names the account it continued on", () => {
    const at = PARK + 44_000;
    expect(limitRecoveryAction({
      parkedAt: PARK,
      lastAction: "continue",
      lastActionAt: at,
      decision: { kind: "continue", at, target_name: "claude8", from_email: "claude8@x.com" },
    })).toEqual({ kind: "continue", target: "claude8", by: "auto", at });
  });

  test("a switch without a matching decision falls back to the profile in the action", () => {
    const at = PARK + 30_000;
    expect(limitRecoveryAction({ parkedAt: PARK, lastAction: "switch:laurence", lastActionAt: at }))
      .toEqual({ kind: "switch", target: "laurence", by: "auto", at });
  });

  test("a manual recovery reads as the person's", () => {
    const at = PARK + 10_000;
    expect(limitRecoveryAction({
      parkedAt: PARK,
      lastAction: "manual",
      lastActionAt: at,
      decision: { kind: "switch", at, target_name: "laurence" },
    })).toEqual({ kind: "switch", target: "laurence", by: "you", at });
  });

  test("an action from before this park is not its recovery", () => {
    expect(limitRecoveryAction({ parkedAt: PARK, lastAction: "continue", lastActionAt: PARK - 60_000 })).toBeNull();
  });

  test("a click in this browser counts before the server records it", () => {
    expect(limitRecoveryAction({ parkedAt: PARK, localRequestAt: PARK + 5_000, localTarget: "laurence" }))
      .toEqual({ kind: "switch", target: "laurence", by: "you", at: PARK + 5_000 });
  });
});

describe("limitRecoveryPhase", () => {
  const action = { kind: "continue" as const, target: "claude8", by: "auto" as const, at: PARK + 44_000 };

  test("parked until something acts", () => {
    expect(limitRecoveryPhase({ live: true, parkedAt: PARK, action: null })).toEqual({ phase: "parked" });
  });

  test("recovering while the session restarts, resuming once the continue lands", () => {
    expect(limitRecoveryPhase({ live: true, parkedAt: PARK, action })).toEqual({ phase: "recovering", action, step: "moving" });
    expect(limitRecoveryPhase({ live: true, parkedAt: PARK, action, continueDelivered: true }))
      .toEqual({ phase: "recovering", action, step: "resuming" });
  });

  test("resumed once the session moved past the park", () => {
    expect(limitRecoveryPhase({ live: false, parkedAt: PARK, action })).toEqual({ phase: "resumed", action });
  });

  test("an old card does not claim a recovery long after it", () => {
    const late = { ...action, at: PARK + RESUMED_MATCH_MS + 1 };
    expect(limitRecoveryPhase({ live: false, parkedAt: PARK, action: late })).toEqual({ phase: "moved_on" });
  });
});
