// How a stored path reads as an org object's address (essence spec §3.2).
// Run: bun test components/org/company/sheetStack.test.ts
import { describe, expect, test } from "bun:test";
import { orgPageKind, orgRefOfPath } from "./sheetStack";

describe("reading a stored path", () => {
  test("splits the read view from the raw ref", () => {
    expect(orgRefOfPath("/org")).toEqual({});
    expect(orgRefOfPath("/org?proposal=op-3")).toEqual({});
    expect(orgRefOfPath("/org/goals")).toEqual({ view: "goals", ref: undefined });
    expect(orgRefOfPath("/org/goals/in-7")).toEqual({ view: "goals", ref: "in-7" });
    expect(orgRefOfPath("/org/projects/pj-1?x=1")).toEqual({ view: "projects", ref: "pj-1" });
    expect(orgRefOfPath("/org/in_abc_123")).toEqual({ ref: "in_abc_123" });
    expect(orgRefOfPath("/org/in-2/pj-k3x9")).toEqual({});
    expect(orgRefOfPath("/orgx/in-2")).toBeNull();
    expect(orgRefOfPath("/tasks/ct-1")).toBeNull();
  });
  test("names goal and project pages, old addresses included", () => {
    for (const p of ["/org/goals", "/org/goals/in-7", "/org/in-7", "/goals/in-7", "/initiatives", "/roadmap"]) expect(orgPageKind(p)).toBe("goal");
    for (const p of ["/org/projects", "/org/projects/pj-1", "/org/pj-1", "/projects", "/projects/pj-1/ct-2"]) expect(orgPageKind(p)).toBe("project");
    for (const p of ["/org", "/org/or-7", "/org/@samvit", "/team", "/tasks"]) expect(orgPageKind(p)).toBeNull();
  });
});
