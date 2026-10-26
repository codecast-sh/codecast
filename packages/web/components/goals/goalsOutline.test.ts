import { describe, expect, it } from "bun:test";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { byListOrder } from "../../lib/initiatives";
import { canPlace, indentMove, insertAfterWrites, outdentMove, reorderedProjects, reorderWrites } from "./goalsOutline";

const goal = (id: string, extra: Partial<InitiativeRow> = {}): InitiativeRow => ({
  _id: id, short_id: id, title: id, status: "active", project_ids: [], health: "none", workspace: "team:t", user_id: "u", created_at: 1, updated_at: 1, ...extra,
});

describe("reorderWrites", () => {
  const sibs = [goal("a"), goal("b"), goal("c")];
  it("puts the moved goal before the named one and numbers every sibling", () => {
    expect(reorderWrites(sibs, "c", "a")).toEqual([{ id: "c", position: 1000 }, { id: "a", position: 2000 }, { id: "b", position: 3000 }]);
  });
  it("moves last for null and writes only what changed", () => {
    const placed = [goal("a", { position: 1000 }), goal("b", { position: 2000 }), goal("c", { position: 3000 })];
    expect(reorderWrites(placed, "a", null)).toEqual([{ id: "b", position: 1000 }, { id: "c", position: 2000 }, { id: "a", position: 3000 }]);
    expect(reorderWrites(placed, "b", "c")).toEqual([]);
  });
  it("reads back in the order it wrote", () => {
    const writes = new Map(reorderWrites(sibs, "c", "b").map((w) => [w.id, w.position]));
    const rows = sibs.map((s) => ({ ...s, position: writes.get(s._id) ?? s.position }));
    expect([...rows].sort(byListOrder).map((r) => r._id)).toEqual(["a", "c", "b"]);
  });
});

describe("insertAfterWrites", () => {
  it("slots a new goal right after the named one", () => {
    const w = insertAfterWrites([goal("a"), goal("b")], "new", "a");
    expect(w.find((x) => x.id === "new")?.position).toBe(2000);
    expect(w.find((x) => x.id === "b")?.position).toBe(3000);
  });
});

describe("the one level of nesting", () => {
  const top = goal("top");
  const child = goal("child", { parent_initiative_id: "top" });
  const other = goal("other");
  const all = [top, child, other];
  it("refuses a goal under a child, under itself, or a parent under anything", () => {
    expect(canPlace(all, other, child)).toBe(false);
    expect(canPlace(all, other, other)).toBe(false);
    expect(canPlace(all, top, other)).toBe(false);
    expect(canPlace(all, other, top)).toBe(true);
    expect(canPlace(all, child, null)).toBe(true);
  });
  it("Tab nests under the goal above, last among its goals", () => {
    expect(indentMove(all, [top, other], other)).toEqual({ parent: "top", position: [{ id: "child", position: 1000 }, { id: "other", position: 2000 }] });
    expect(indentMove(all, [top, other], top)).toBeNull();
  });
  it("Shift+Tab lifts a goal out to right after its parent", () => {
    const move = outdentMove(all, [top, other], child);
    expect(move?.parent).toBeNull();
    expect(move?.position.map((w) => w.id)).toEqual(["top", "child", "other"]);
    expect(outdentMove(all, [top, other], top)).toBeNull();
  });
});

describe("byListOrder", () => {
  it("keeps ended goals last whatever their position", () => {
    const rows = [goal("done", { status: "completed", position: 1 }), goal("b", { position: 2000 }), goal("a", { position: 1000 }), goal("loose")];
    expect([...rows].sort(byListOrder).map((r) => r._id)).toEqual(["a", "b", "loose", "done"]);
  });
});

describe("reorderedProjects", () => {
  it("moves a project before another, or last", () => {
    expect(reorderedProjects(["p1", "p2", "p3"], "p3", "p1")).toEqual(["p3", "p1", "p2"]);
    expect(reorderedProjects(["p1", "p2"], "p1", null)).toEqual(["p2", "p1"]);
    expect(reorderedProjects(["p1"], "p9", "p1")).toEqual(["p9", "p1"]);
  });
});
