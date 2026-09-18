import { describe, expect, it } from "bun:test";
import { groupsWithItems, visibleGroups } from "../listGroups";

const g = (key: string, depth: number | undefined, items: string[] = ["x"]) => ({ key, label: key, depth, items });

// founder > growth > ads, founder > platform, then sam on his own.
const tree = [g("founder", 0), g("growth", 1), g("ads", 2), g("platform", 1), g("sam", undefined)];
const keys = (rows: { group: { key: string } }[]) => rows.map((r) => r.group.key);

describe("visibleGroups", () => {
  it("shows every group when none is collapsed", () => {
    expect(keys(visibleGroups(tree, new Set()))).toEqual(["founder", "growth", "ads", "platform", "sam"]);
  });

  it("hides everything nested under a collapsed group and keeps its header", () => {
    const rows = visibleGroups(tree, new Set(["founder"]));
    expect(keys(rows)).toEqual(["founder", "sam"]);
    expect(rows[0].collapsed).toBe(true);
  });

  it("hides only a collapsed group's own branch, not the group beside it", () => {
    expect(keys(visibleGroups(tree, new Set(["growth"])))).toEqual(["founder", "growth", "platform", "sam"]);
  });

  it("treats groups with no depth as a flat list, as every other page passes them", () => {
    const flat = [g("a", undefined), g("b", undefined)];
    expect(keys(visibleGroups(flat, new Set(["a"])))).toEqual(["a", "b"]);
  });
});

describe("groupsWithItems", () => {
  it("drops a group a search emptied", () => {
    expect(groupsWithItems([g("a", 0, []), g("b", 0)]).map((x) => x.key)).toEqual(["b"]);
  });

  it("keeps an empty group that still has a match nested under it", () => {
    const searched = [g("founder", 0, []), g("growth", 1, []), g("ads", 2), g("platform", 1, []), g("sam", 0, [])];
    expect(groupsWithItems(searched).map((x) => x.key)).toEqual(["founder", "growth", "ads"]);
  });
});
