import { describe, expect, test } from "bun:test";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { buildBoardColumn, foldLabel, type ColumnGroup } from "./boardColumn";

const el = (key: string, kind: string, box: [number, number, number, number], extra: Record<string, unknown> = {}) =>
  ({ key, kind, x: box[0], y: box[1], w: box[2], h: box[3], ...extra }) as unknown as ArtifactElement;

describe("buildBoardColumn", () => {
  test("top-level frames become cards in reading order, their contents below", () => {
    const cards = buildBoardColumn([
      el("f2", "frame", [0, 600, 500, 400], { ref: "ct-2" }),
      el("f1", "frame", [0, 0, 500, 400], { ref: "pri-1", title: "Budgets" }),
      el("s2", "sticky", [40, 200, 100, 100], { text: "later" }),
      el("s1", "sticky", [40, 60, 100, 100], { text: "first" }),
      el("s3", "sticky", [40, 700, 100, 100], { text: "other" }),
    ]);
    expect(cards.map((c) => c.key)).toEqual(["f1", "f2"]);
    const [a, b] = cards as ColumnGroup[];
    expect(a.ref).toBe("pri-1");
    expect(a.title).toBe("Budgets");
    expect(a.items.map((i) => i.key)).toEqual(["s1", "s2"]);
    expect(b.items.map((i) => i.key)).toEqual(["s3"]);
  });

  test("elements outside every frame go in a final Loose card; arrows and ink stay off the column", () => {
    const cards = buildBoardColumn([
      el("f1", "frame", [0, 0, 300, 300]),
      el("loose1", "sticky", [900, 50, 100, 100]),
      el("loose0", "card", [900, 0, 100, 40], { ref: "ct-9" }),
      el("arrow", "connector", [0, 0, 0, 0]),
      el("ink", "pen", [10, 10, 20, 20]),
    ]);
    expect(cards.map((c) => c.key)).toEqual(["f1", "loose"]);
    expect(cards[1].items.map((i) => i.key)).toEqual(["loose0", "loose1"]);
    expect((cards[0] as ColumnGroup).items).toEqual([]);
  });

  test("a folded frame inside a theme is a group holding its notes, counted the board's way", () => {
    // The pill sits inside the theme; the notes it holds keep their old
    // coordinates below it, outside the pill's box.
    const cards = buildBoardColumn([
      el("theme", "frame", [0, 0, 600, 400], { ref: "ct-5" }),
      el("summary", "sticky", [40, 40, 200, 80], { text: "To summarize: cap at 5k" }),
      el("filed", "card", [260, 40, 200, 60], { ref: "ct-6" }),
      el("notes", "frame", [40, 200, 260, 48], { title: "Working notes", collapsed: { w: 500, h: 400, holds: ["n1", "n2", "a1"] } }),
      el("n1", "sticky", [60, 260, 100, 100]),
      el("n2", "sticky", [200, 260, 100, 100]),
      el("a1", "connector", [0, 0, 0, 0]),
    ]);
    expect(cards).toHaveLength(1);
    const theme = cards[0] as ColumnGroup;
    expect(theme.items.map((i) => i.key)).toEqual(["summary", "filed", "notes"]);
    const notes = theme.items[2] as ColumnGroup;
    expect(notes.folded).toBe(true);
    expect(notes.count).toBe(2);
    expect(notes.items.map((i) => i.key)).toEqual(["n1", "n2"]);
    expect(foldLabel(notes, false)).toBe("Working notes (2)");
  });

  test("a folded top-level frame is a folded card; its notes open under it", () => {
    const cards = buildBoardColumn([
      el("theme", "frame", [0, 0, 260, 48], { ref: "pl-3", collapsed: { w: 600, h: 500, holds: ["s1", "inner", "s2"] } }),
      el("s1", "sticky", [40, 100, 100, 100]),
      el("inner", "frame", [200, 100, 300, 300]),
      el("s2", "sticky", [220, 150, 100, 100]),
    ]);
    const theme = cards[0] as ColumnGroup;
    expect(theme.folded).toBe(true);
    expect(theme.count).toBe(3);
    // Inside the fold, containment still holds: s2 sits in the inner frame.
    expect(theme.items.map((i) => i.key)).toEqual(["s1", "inner"]);
    expect((theme.items[1] as ColumnGroup).items.map((i) => i.key)).toEqual(["s2"]);
    expect(foldLabel(theme, true)).toBe("Working notes (3)");
  });

  test("a nested open frame takes its own contents, the smallest frame wins", () => {
    const cards = buildBoardColumn([
      el("outer", "frame", [0, 0, 800, 800]),
      el("inner", "frame", [100, 100, 300, 300]),
      el("inside", "sticky", [150, 150, 50, 50]),
      el("outside", "sticky", [500, 500, 50, 50]),
    ]);
    const outer = cards[0] as ColumnGroup;
    expect(outer.items.map((i) => i.key)).toEqual(["inner", "outside"]);
    expect((outer.items[0] as ColumnGroup).items.map((i) => i.key)).toEqual(["inside"]);
  });

  test("an empty board is no cards", () => {
    expect(buildBoardColumn([])).toEqual([]);
  });
});
