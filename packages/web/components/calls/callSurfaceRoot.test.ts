import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { isSurfaceChromeTarget } from "./CallSurfaceRoot";

// The floating dock puts pop-out / expand / unpin on the same row you drag
// the card by. A click on those must not start a drag.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const doc = dom.window.document;

describe("isSurfaceChromeTarget", () => {
  test("a header button is chrome, including a click on the icon inside it", () => {
    const btn = doc.createElement("button");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    btn.appendChild(svg);
    expect(isSurfaceChromeTarget(btn)).toBe(true);
    expect(isSurfaceChromeTarget(svg)).toBe(true);
  });

  test("the title text is a drag, not chrome", () => {
    const title = doc.createElement("span");
    title.textContent = "Cam";
    expect(isSurfaceChromeTarget(title)).toBe(false);
  });

  test("nothing, or a node without closest, is not chrome", () => {
    expect(isSurfaceChromeTarget(null)).toBe(false);
    expect(isSurfaceChromeTarget({} as EventTarget)).toBe(false);
  });
});
