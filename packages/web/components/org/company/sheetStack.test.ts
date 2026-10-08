// The sheet stack's rules (cohesive build spec D3, D4, D5).
// Run: bun test components/org/company/sheetStack.test.ts
import { describe, expect, test } from "bun:test";
import { popSheet, pushSheet, renameSheet, sameSheet, sheetId, sheetOfPath, sheetPath, sheetWidth, stackForAddress, type SheetRef } from "./sheetStack";

const goal: SheetRef = { kind: "initiative", ref: "in-2" };
const project: SheetRef = { kind: "project", ref: "pj-k3x9" };
const role: SheetRef = { kind: "role", ref: "or-7" };
const person: SheetRef = { kind: "person", ref: "samvit" };

describe("the address", () => {
  test("names the top sheet, or the company", () => {
    expect(sheetOfPath("/org")).toBeNull();
    expect(sheetOfPath("/org/in-2")).toEqual(goal);
    expect(sheetOfPath("/org/pj-k3x9")).toEqual(project);
    expect(sheetOfPath("/org/or-7")).toEqual(role);
    expect(sheetOfPath("/org/@samvit")).toEqual(person);
    expect(sheetOfPath("/org/%40samvit")).toEqual(person);
    expect(sheetOfPath("/org/workspace")).toBeNull();
  });
  test("keeps the screen's query", () => {
    expect(sheetPath(goal, "lens=goals")).toBe("/org/in-2?lens=goals");
    expect(sheetPath(null, "?lens=people")).toBe("/org?lens=people");
    expect(sheetPath(person)).toBe("/org/@samvit");
    expect(sheetPath(null)).toBe("/org");
  });
});

describe("push and pop", () => {
  test("a push lands on top; the same top stays", () => {
    expect(pushSheet([goal], project)).toEqual([goal, project]);
    expect(pushSheet([goal, project], project)).toEqual([goal, project]);
  });
  test("an object further down is returned to, never stacked twice", () => {
    expect(pushSheet([goal, project, role], goal)).toEqual([goal]);
  });
  test("refs compare without case or the person's @", () => {
    expect(sameSheet({ kind: "person", ref: "@Samvit" }, person)).toBe(true);
    expect(sameSheet(goal, { kind: "project", ref: "in-2" })).toBe(false);
  });
  test("a pop steps back, then empties", () => {
    expect(popSheet([goal, project])).toEqual([goal]);
    expect(popSheet([goal])).toEqual([]);
    expect(popSheet([])).toEqual([]);
  });
});

describe("the stack follows the address", () => {
  test("an in-screen open keeps the steps under it", () => {
    expect(stackForAddress([goal], project, true)).toEqual([goal, project]);
  });
  test("an arrival by address starts over", () => {
    expect(stackForAddress([goal, project], role, false)).toEqual([role]);
  });
  test("the company closes every sheet", () => {
    expect(stackForAddress([goal, project], null, true)).toEqual([]);
  });
  test("the same top keeps the stack, however it came", () => {
    expect(stackForAddress([goal, project], project, false)).toEqual([goal, project]);
  });
  test("a stub's key is renamed in place, and the sheet keeps its identity through it", () => {
    const stub: SheetRef = { kind: "initiative", ref: "in_abc_123" };
    const renamed = renameSheet([project, stub], stub, goal);
    expect(renamed).toEqual([project, { ...goal, id: "initiative:in_abc_123" }]);
    expect(sheetId(renamed[1])).toBe(sheetId(stub));
    expect(sameSheet(renamed[1], goal)).toBe(true);
    // A second rename keeps the first identity.
    expect(sheetId(renameSheet(renamed, goal, { kind: "initiative", ref: "in-9" })[1])).toBe("initiative:in_abc_123");
  });
});

describe("the sheet's width (D3)", () => {
  test("takes 560px where the pane has room", () => {
    expect(sheetWidth(1000)).toEqual({ width: 560, covers: false });
  });
  test("shrinks to leave 260px of the lens", () => {
    expect(sheetWidth(760)).toEqual({ width: 500, covers: false });
    expect(sheetWidth(700)).toEqual({ width: 440, covers: false });
  });
  test("never under 400px; a pane under 660px is covered", () => {
    expect(sheetWidth(660)).toEqual({ width: 400, covers: false });
    expect(sheetWidth(659)).toEqual({ width: 659, covers: true });
    expect(sheetWidth(380)).toEqual({ width: 380, covers: true });
    // The document needs 360px beside a sheet to be read; under that it is covered whole.
    expect(sheetWidth(720, 360)).toEqual({ width: 720, covers: true });
    expect(sheetWidth(920, 360)).toEqual({ width: 560, covers: false });
  });
});
