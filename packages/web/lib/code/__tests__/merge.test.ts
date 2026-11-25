import { describe, expect, it } from "bun:test";
import * as kit from "@codemirror/merge";
import { lineChanges, lineDiff, threeWayMerge } from "../merge";

const L = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");

function applyChanges(text: string, changes: { from: number; to?: number; insert?: string }[]): string {
  let out = text;
  for (const c of [...changes].reverse()) out = out.slice(0, c.from) + (c.insert ?? "") + out.slice(c.to ?? c.from);
  return out;
}

describe("lineDiff", () => {
  it("covers whole lines", () => {
    expect(lineDiff(kit, L("one", "two", "three"), L("one", "TWO", "three"))).toEqual([{ fromA: 4, toA: 8, fromB: 4, toB: 8 }]);
  });

  it("produces edits that turn a into b, one per hunk", () => {
    const a = L("a", "b", "c", "d", "e", "f");
    const b = L("a", "B", "c", "d", "e2", "e3", "f", "g");
    const changes = lineChanges(kit, a, b) as { from: number; to: number; insert: string }[];
    expect(changes.length).toBe(3);
    expect(applyChanges(a, changes)).toBe(b);
  });

  it("returns nothing for equal text", () => {
    expect(lineDiff(kit, "x\n", "x\n")).toEqual([]);
  });
});

describe("threeWayMerge", () => {
  const base = L("import a", "", "function one() {", "  return 1;", "}", "", "function two() {", "  return 2;", "}");

  it("takes changes only one side made, from both sides", () => {
    const disk = base.replace("return 1;", "return 10;");
    const mine = base.replace("return 2;", "return 20;");
    expect(threeWayMerge(kit, base, disk, mine)).toEqual({
      text: base.replace("return 1;", "return 10;").replace("return 2;", "return 20;"),
      conflicts: 0,
    });
  });

  it("takes an identical change once", () => {
    const both = base.replace("import a", "import b");
    expect(threeWayMerge(kit, base, both, both)).toEqual({ text: both, conflicts: 0 });
  });

  it("keeps mine where both changed the same lines differently, and counts it", () => {
    const disk = base.replace("return 1;", "return 'disk';");
    const mine = base.replace("return 1;", "return 'mine';").replace("import a", "import z");
    expect(threeWayMerge(kit, base, disk, mine)).toEqual({ text: mine, conflicts: 1 });
  });

  it("merges an append on one side with an edit elsewhere on the other", () => {
    const disk = base + L("", "function three() {}");
    const mine = base.replace("import a", "import a, b");
    expect(threeWayMerge(kit, base, disk, mine)).toEqual({ text: mine + L("", "function three() {}"), conflicts: 0 });
  });

  it("treats edits on adjacent lines as a conflict, as git does", () => {
    const disk = base.replace("function one() {", "function uno() {");
    const mine = base.replace("  return 1;", "  return 11;");
    expect(threeWayMerge(kit, base, disk, mine).conflicts).toBe(1);
  });

  it("short-circuits when a side did not move", () => {
    const moved = base.replace("two", "dos");
    expect(threeWayMerge(kit, base, base, moved)).toEqual({ text: moved, conflicts: 0 });
    expect(threeWayMerge(kit, base, moved, base)).toEqual({ text: moved, conflicts: 0 });
  });
});
