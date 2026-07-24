import { test, expect, describe } from "bun:test";
import { getQuoteUnits, quoteUnitAt } from "./quoteUnits";

// getQuoteUnits / quoteUnitAt only read tagName, children, parentElement and
// hasAttribute, so we can exercise the real list-expansion + walk-up logic with
// plain fake nodes — no DOM environment required. (unitTop needs
// getBoundingClientRect; verified live.)
type FakeEl = {
  tagName: string;
  children: FakeEl[];
  parentElement: FakeEl | null;
  innerText?: string;
  hasAttribute: (name: string) => boolean;
};
function el(tagName: string, children: FakeEl[] = []): FakeEl {
  const node: FakeEl = { tagName, children, parentElement: null, hasAttribute: () => false };
  children.forEach((c) => (c.parentElement = node));
  return node;
}
const units = (content: FakeEl) => getQuoteUnits(content as any);

describe("getQuoteUnits", () => {
  test("non-list blocks are each one unit", () => {
    const p1 = el("P");
    const h = el("H2");
    const pre = el("PRE");
    const content = el("DIV", [p1, h, pre]);
    expect(units(content)).toEqual([p1, h, pre] as any);
  });

  test("a list is expanded into one unit per <li>", () => {
    const a = el("LI");
    const b = el("LI");
    const c = el("LI");
    const content = el("DIV", [el("OL", [a, b, c])]);
    expect(units(content)).toEqual([a, b, c] as any);
  });

  test("list items interleave with surrounding blocks in document order", () => {
    const intro = el("P");
    const i1 = el("LI");
    const i2 = el("LI");
    const outro = el("P");
    const content = el("DIV", [intro, el("UL", [i1, i2]), outro]);
    expect(units(content)).toEqual([intro, i1, i2, outro] as any);
  });

  test("only the list's direct <li> children expand; a nested list stays inside its parent item", () => {
    const nestedItem = el("LI");
    const parentItem = el("LI", [el("P"), el("UL", [nestedItem])]);
    const content = el("DIV", [el("OL", [parentItem])]);
    // top-level expansion only — the parent <li> is the unit, nested item is not separate
    expect(units(content)).toEqual([parentItem] as any);
  });

  test("an empty list falls back to the list element itself (never zero units for it)", () => {
    const ol = el("OL", []);
    const content = el("DIV", [ol]);
    expect(units(content)).toEqual([ol] as any);
  });
});

describe("quoteUnitAt", () => {
  test("resolves a node inside a list item to that item's index", () => {
    const i0 = el("LI");
    const i1text = el("SPAN");
    const i1 = el("LI", [el("P", [i1text])]);
    const content = el("DIV", [el("P"), el("OL", [i0, i1])]);
    // units: [P(0), i0(1), i1(2)] — a span deep inside i1 resolves to index 2
    expect(quoteUnitAt(content as any, i1text as any)?.index).toBe(2);
  });

  test("resolves a node inside a paragraph to that paragraph's index", () => {
    const inline = el("CODE");
    const p = el("P", [inline]);
    const content = el("DIV", [p, el("UL", [el("LI")])]);
    expect(quoteUnitAt(content as any, inline as any)?.index).toBe(0);
  });

  test("returns null for a target outside the content column", () => {
    const stray = el("P");
    const content = el("DIV", [el("P")]);
    expect(quoteUnitAt(content as any, stray as any)).toBeNull();
  });
});
