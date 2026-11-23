import { describe, expect, test } from "bun:test";
import { accountDisplayName, describeDecision, describeLastAction, standingLabel } from "@codecast/shared/contracts";
import { limitContinueTarget } from "../limitContinue";
import { limitRecoveryAction } from "../limitRecovery";

const profiles = [
  { name: "pool-mike-2", email: "mike@apetrosian.com" },
  { name: "work", email: "peter@apetrosian.com" },
  { name: "nameless" },
];

describe("accountDisplayName", () => {
  test("a pool profile reads as its email, never its pool- id", () => {
    expect(accountDisplayName(profiles, "pool-mike-2")).toBe("mike@apetrosian.com");
  });
  test("an email key resolves to itself, case-insensitively", () => {
    expect(accountDisplayName(profiles, "Peter@apetrosian.com")).toBe("peter@apetrosian.com");
  });
  test("a profile with no email falls back to its name; an unknown key shows as given", () => {
    expect(accountDisplayName(profiles, "nameless")).toBe("nameless");
    expect(accountDisplayName(profiles, "someone@x.org")).toBe("someone@x.org");
    expect(accountDisplayName(profiles, undefined)).toBeUndefined();
  });
  test("a pool id this machine has not saved still drops its pool- prefix", () => {
    expect(accountDisplayName(profiles, "pool-claude3-2")).toBe("claude3-2");
  });
});

describe("recovery copy never shows a pool- id", () => {
  test("the recovery card's target is the switch decision's email", () => {
    const action = limitRecoveryAction({
      parkedAt: 1000, lastAction: "switch:pool-mike-2", lastActionAt: 2000,
      decision: { kind: "switch", at: 2000, target_name: "pool-mike-2", target_email: "mike@apetrosian.com" },
    });
    expect(action?.target).toBe("mike@apetrosian.com");
  });
  test("describeDecision names the email", () => {
    expect(describeDecision({ kind: "switch", at: 1, target_name: "pool-mike-2", target_email: "mike@apetrosian.com" })).toContain("switched to mike@apetrosian.com");
    expect(describeDecision({ kind: "switch", at: 1, target_name: "pool-claude3-2" })).not.toContain("pool-");
  });
  test("a last action resolves its profile id", () => {
    expect(describeLastAction("switch:pool-mike-2", profiles)).toBe("switched to mike@apetrosian.com");
  });
});

describe("the Continue-on pick counts the session's own model", () => {
  const now = Date.UTC(2026, 10, 12, 12);
  const later = now + 3 * 86_400_000;
  const usage = (week: number, fable: number) => ({
    fetched_at: now - 60_000,
    weekly: { percent: week, resets_at: later },
    weekly_scoped: { label: "Fable", percent: fable, resets_at: later },
  });
  const device = {
    active_email: "ashot@example.com",
    profiles: [
      { name: "default", email: "ashot@example.com", usage: usage(40, 10) },
      { name: "pool-peter", email: "peter@example.com", usage: usage(30, 0) },
      { name: "pool-cameron", email: "cameron@example.com", usage: usage(72, 100) },
      { name: "pool-riley", email: "riley@example.com", usage: usage(89, 20) },
    ],
  };

  test("an opus session ignores the Fable week, and never goes back to the account it was parked on", () => {
    const { best, models } = limitContinueTarget(device, now, true, undefined, { model: "claude-opus-5-5", pinned: "pool-peter" });
    expect(best?.name).toBe("pool-cameron");
    expect(standingLabel(best!.usage, now, models)).toBe("72% used");
  });

  test("a Fable session parked on its 5h window skips accounts whose Fable week is spent", () => {
    const { best, models } = limitContinueTarget(device, now, true, undefined, { model: "claude-fable-5-2", pinned: "pool-peter" });
    expect(best?.name).toBe("pool-riley");
    expect(standingLabel(best!.usage, now, models)).toBe("89% used");
  });
});
