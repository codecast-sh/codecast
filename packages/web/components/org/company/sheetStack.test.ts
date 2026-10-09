// An object's ref and its address (essence spec §3.2).
// Run: bun test components/org/company/sheetStack.test.ts
import { describe, expect, test } from "bun:test";
import { orgPageKind, orgRefOfPath, sameSheet, sheetId, sheetOfPath, sheetPath, type SheetRef } from "./sheetStack";

const goal: SheetRef = { kind: "initiative", ref: "in-2" };
const project: SheetRef = { kind: "project", ref: "pj-k3x9" };
const role: SheetRef = { kind: "role", ref: "or-7" };
const person: SheetRef = { kind: "person", ref: "samvit" };

describe("the address", () => {
  test("names the object, or the canvas", () => {
    expect(sheetOfPath("/org")).toBeNull();
    expect(sheetOfPath("/org/in-2")).toEqual(goal);
    expect(sheetOfPath("/org/pj-k3x9")).toEqual(project);
    expect(sheetOfPath("/org/or-7")).toEqual(role);
    expect(sheetOfPath("/org/@samvit")).toEqual(person);
    expect(sheetOfPath("/org/%40samvit")).toEqual(person);
    expect(sheetOfPath("/org/workspace")).toBeNull();
  });
  test("names the object under a read view, and nothing for the view alone", () => {
    expect(sheetOfPath("/org/goals")).toBeNull();
    expect(sheetOfPath("/org/projects")).toBeNull();
    expect(sheetOfPath("/org/goals/in-2")).toEqual(goal);
    expect(sheetOfPath("/org/projects/pj-k3x9")).toEqual(project);
    // Only the two views take a second segment.
    expect(sheetOfPath("/org/in-2/pj-k3x9")).toBeNull();
  });
  test("keeps the screen's query", () => {
    expect(sheetPath(goal, "proposal=op-3")).toBe("/org/in-2?proposal=op-3");
    expect(sheetPath(null, "?preview=1")).toBe("/org?preview=1");
    expect(sheetPath(person)).toBe("/org/@samvit");
    expect(sheetPath(null)).toBe("/org");
  });
});

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

describe("identity", () => {
  test("refs compare without case or the person's @", () => {
    expect(sameSheet({ kind: "person", ref: "@Samvit" }, person)).toBe(true);
    expect(sameSheet(goal, { kind: "project", ref: "in-2" })).toBe(false);
  });
  test("a renamed ref keeps the identity it was opened under", () => {
    expect(sheetId(goal)).toBe("initiative:in-2");
    expect(sheetId({ ...goal, id: "initiative:in_abc_123" })).toBe("initiative:in_abc_123");
  });
});
