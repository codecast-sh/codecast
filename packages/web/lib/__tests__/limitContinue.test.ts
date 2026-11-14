import { describe, expect, test } from "bun:test";
import { accountDisplayName } from "../limitContinue";

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
});
