// The rule that keeps a native browser pane from painting over the app.
//
// jsdom does no layout, so every rect here is supplied: the module takes a
// `rectOf` for exactly that reason, and the selector logic is what these tests
// are about.
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  collectOverlays,
  overlayHidesPane,
  MODAL_SELECTORS,
  FLOATING_SELECTORS,
  type Rect,
} from "../nativeOverlayGuard";

const PANE: Rect = { left: 400, top: 32, right: 900, bottom: 700 };
const OVER_PANE: Rect = { left: 500, top: 100, right: 700, bottom: 300 };
const BESIDE_PANE: Rect = { left: 0, top: 0, right: 100, bottom: 100 };

function dom(html: string) {
  const d = new JSDOM(`<body>${html}</body>`);
  return d.window.document.body;
}

/** Measure by a `data-rect="l,t,r,b"` attribute the test writes. */
function rectOf(el: Element): Rect {
  const [left, top, right, bottom] = (el.getAttribute("data-rect") ?? "0,0,0,0")
    .split(",")
    .map(Number);
  return { left, top, right, bottom };
}

describe("what counts as an overlay", () => {
  test("a dialog anywhere hides every pane", () => {
    const body = dom(`<div role="dialog" data-rect="0,0,10,10"></div>`);
    const hits = collectOverlays(body, rectOf);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("modal");
    // It does not have to touch the pane: a modal owns the app, including the
    // keyboard, and a focused native view would eat every key it gets.
    expect(overlayHidesPane(PANE, hits)).toBe(true);
  });

  test("the stage's drag veil and pick layer hide the pane", () => {
    for (const cls of ["stage-drop-veil", "stage-pick"]) {
      const body = dom(`<div class="${cls} absolute inset-0" data-rect="0,0,1200,800"></div>`);
      expect(overlayHidesPane(PANE, collectOverlays(body, rectOf))).toBe(true);
    }
  });

  test("a menu hides the pane only where it lands", () => {
    const over = dom(
      `<div data-radix-popper-content-wrapper data-rect="${Object.values(OVER_PANE).join(",")}"></div>`,
    );
    const beside = dom(
      `<div data-radix-popper-content-wrapper data-rect="${Object.values(BESIDE_PANE).join(",")}"></div>`,
    );
    expect(overlayHidesPane(PANE, collectOverlays(over, rectOf))).toBe(true);
    expect(overlayHidesPane(PANE, collectOverlays(beside, rectOf))).toBe(false);
  });

  test("a toast in the corner leaves a pane on the other side alone", () => {
    const body = dom(`<li data-sonner-toast data-rect="1000,700,1190,780"></li>`);
    expect(overlayHidesPane(PANE, collectOverlays(body, rectOf))).toBe(false);
    // …and hides one it actually covers.
    expect(overlayHidesPane({ left: 950, top: 600, right: 1200, bottom: 800 }, collectOverlays(body, rectOf))).toBe(true);
  });

  test("a popper on its way out does not hold the page hidden", () => {
    const body = dom(
      `<div data-radix-popper-content-wrapper data-state="closed" data-rect="500,100,700,300"></div>`,
    );
    expect(collectOverlays(body, rectOf)).toHaveLength(0);
  });

  test("an overlay with no area is not an overlay", () => {
    // Sonner's region, a menu wrapper before it is positioned: present in the
    // DOM, drawing nothing.
    const body = dom(`<div role="menu" data-rect="0,0,0,0"></div>`);
    expect(collectOverlays(body, rectOf)).toHaveLength(0);
  });

  test("nothing up means nothing hidden", () => {
    const body = dom(`<main><p>a page</p></main>`);
    expect(overlayHidesPane(PANE, collectOverlays(body, rectOf))).toBe(false);
  });

  test("anything can opt in by saying so on its own element", () => {
    const body = dom(`<div data-native-overlay data-rect="0,0,5,5"></div>`);
    expect(overlayHidesPane(PANE, collectOverlays(body, rectOf))).toBe(true);
  });

  test("the two lists stay disjoint", () => {
    // A selector in both would make a floating thing black out every pane —
    // the exact over-hiding this split exists to avoid.
    const overlap = MODAL_SELECTORS.filter((s) => FLOATING_SELECTORS.includes(s));
    expect(overlap).toEqual([]);
  });
});

describe("edges of the rect test", () => {
  test("touching edges do not count as covering", () => {
    const touching: Rect = { left: 900, top: 32, right: 1000, bottom: 700 };
    expect(overlayHidesPane(PANE, [{ kind: "floating", selector: "x", rect: touching }])).toBe(false);
  });

  test("one pixel of overlap counts", () => {
    const sliver: Rect = { left: 899, top: 32, right: 1000, bottom: 700 };
    expect(overlayHidesPane(PANE, [{ kind: "floating", selector: "x", rect: sliver }])).toBe(true);
  });
});
