import { describe, expect, test } from "bun:test";
import { unseenTabs } from "./tabActivity";
import type { SheetModel } from "./sheetCore";

const model = (writes: Record<string, { rev: number; at: number } | undefined>): SheetModel =>
  ({ tabs: [], conds: [], tables: [], byId: new Map(Object.entries(writes).map(([id, w]) => [id, { agentWrite: w && { ...w, by: "s:x" } } as any])) }) as SheetModel;

describe("unseenTabs", () => {
  test("flags agent writes on other tabs made after the page opened, until the tab is shown", () => {
    const seen = new Map<string, number>();
    expect([...unseenTabs(model({ a: { rev: 1, at: 50 }, b: { rev: 2, at: 50 } }), "a", seen, 100)]).toEqual([]);
    expect([...unseenTabs(model({ a: { rev: 1, at: 50 }, b: { rev: 5, at: 150 } }), "a", seen, 100)]).toEqual(["b"]);
    // Showing b marks it seen; going back to a leaves it clear.
    expect([...unseenTabs(model({ a: { rev: 1, at: 50 }, b: { rev: 5, at: 150 } }), "b", seen, 100)]).toEqual([]);
    expect([...unseenTabs(model({ a: { rev: 1, at: 50 }, b: { rev: 5, at: 150 } }), "a", seen, 100)]).toEqual([]);
    expect([...unseenTabs(model({ a: { rev: 1, at: 50 }, b: { rev: 7, at: 160 } }), "a", seen, 100)]).toEqual(["b"]);
  });
});
