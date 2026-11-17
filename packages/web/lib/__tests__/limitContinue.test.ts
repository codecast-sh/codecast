import { describe, expect, test } from "bun:test";
import { accountDisplayName, describeDecision, describeLastAction } from "@codecast/shared/contracts";
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
