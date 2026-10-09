// The panel's addresses (essence spec §3.2): one thing open at a time, named
// by the path or by `?session=` / `?proposal=`.
// Run: bun test components/org/panelTarget.test.ts
import { describe, expect, test } from "bun:test";
import { orgAddressOf, orgObjectPath, panelHref, panelKey, panelOfAddress, panelRefOf } from "./panelTarget";

describe("the view and the ref an address names", () => {
  test("the canvas, an object on it, a view, an object under a view", () => {
    expect(orgAddressOf({})).toEqual({ view: "canvas", ref: null });
    expect(orgAddressOf({ id: "in-2" })).toEqual({ view: "canvas", ref: "in-2" });
    expect(orgAddressOf({ id: "goals" })).toEqual({ view: "goals", ref: null });
    expect(orgAddressOf({ id: "projects" })).toEqual({ view: "projects", ref: null });
    expect(orgAddressOf({ view: "projects", id: "pj-k3x9" })).toEqual({ view: "projects", ref: "pj-k3x9" });
    expect(orgAddressOf({ id: "%40samvit" })).toEqual({ view: "canvas", ref: "@samvit" });
  });
});

describe("the address that opens a panel", () => {
  test("an object's path under its view, the person's @ kept", () => {
    expect(orgObjectPath("canvas", "initiative", "in-2")).toBe("/org/in-2");
    expect(orgObjectPath("goals", "initiative", "in-2")).toBe("/org/goals/in-2");
    expect(orgObjectPath("projects", "person", "samvit")).toBe("/org/projects/@samvit");
  });
  test("one thing at a time: a session or a proposal drops the object and every other panel parameter", () => {
    expect(panelHref("canvas", { kind: "session", id: "c1" }, "proposal=op-3&focus=2")).toBe("/org?session=c1");
    expect(panelHref("goals", { kind: "proposal", id: "OP-3", seq: 2 })).toBe("/org/goals?proposal=op-3&focus=2");
    expect(panelHref("canvas", { kind: "project", ref: "pj-k3x9", intent: "pick-lead" }, "session=c1")).toBe("/org/pj-k3x9");
  });
  test("closing goes to the view itself; the dev preview survives every move", () => {
    expect(panelHref("canvas", null, "session=c1&preview=1")).toBe("/org?preview=1");
    expect(panelHref("projects", null)).toBe("/org/projects");
    expect(panelHref("canvas", { kind: "initiative", ref: "in-2" }, "preview=1")).toBe("/org/in-2?preview=1");
  });
});

describe("the panel an address holds", () => {
  const goal = { kind: "initiative" as const, ref: "in-2" };
  test("session over proposal over the object", () => {
    expect(panelOfAddress(goal, { session: "c1", proposal: "op-3", focus: null })).toEqual({ kind: "session", id: "c1" });
    expect(panelOfAddress(goal, { session: null, proposal: "op-3", focus: 4 })).toEqual({ kind: "proposal", id: "op-3", seq: 4 });
    expect(panelOfAddress(goal, { session: null, proposal: null, focus: null })).toBe(goal);
    expect(panelOfAddress(null, { session: null, proposal: null, focus: null })).toBeNull();
  });
  test("one key per thing, and the older open(kind, ref) reads as a target", () => {
    expect(panelKey({ kind: "person", ref: "@Samvit" })).toBe("person:samvit");
    expect(panelKey({ kind: "proposal", id: "OP-3" })).toBe("proposal:op-3");
    expect(panelKey({ kind: "session", id: "c1" })).toBe("session:c1");
    expect(panelRefOf("role", "or-7")).toEqual({ kind: "role", ref: "or-7" });
    expect(panelRefOf({ kind: "session", id: "c1" })).toEqual({ kind: "session", id: "c1" });
    expect(panelRefOf("role")).toBeNull();
  });
});
