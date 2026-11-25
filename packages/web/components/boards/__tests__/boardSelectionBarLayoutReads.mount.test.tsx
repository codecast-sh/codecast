// ct-101372: the board froze for ~half a second (482 ms frame, 185 ms of it
// forced layout inside React's scheduler) during a run of presses. BoardView
// hands the selection bar a fresh `onAction` closure on every render (each
// press sets `pressing` twice), so the bar's memo never holds, and the bar's
// dependency-less layout effect reads `offsetWidth` after every commit: one
// synchronous layout of the whole board per board render. A re-render whose
// selection and pane width did not change has nothing new to measure, so it
// must read no layout.
import { afterAll, expect, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/" });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
  localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true, MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// Count every layout read the bar could make.
let layoutReads: string[] = [];
const proto = dom.window.HTMLElement.prototype as any;
for (const name of ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight"]) {
  Object.defineProperty(proto, name, { configurable: true, get() { layoutReads.push(name); return 320; } });
}
const realRect = dom.window.Element.prototype.getBoundingClientRect;
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) { layoutReads.push("getBoundingClientRect"); return realRect.call(this); };

const { createRoot } = await import("react-dom/client");
const { BoardSelectionBar } = await import("../BoardSelectionBar");

const selected = [{ key: "s1", kind: "sticky", x: 0, y: 0, w: 200, h: 200, text: "One" }] as any[];
const at = { x: 400, y: 200, below: false };

test("re-rendering the selection bar with the same selection and pane width reads no layout", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  // What BoardView renders: the same selection, position and pane width, with a new runBar closure each render.
  const render = () => root.render(<BoardSelectionBar selected={selected} at={at} paneWidth={1200} canMakeTasks pageLive={false} onAction={() => {}} />);
  await act(async () => { render(); });
  expect(host.querySelector(".board-bar")).not.toBeNull();

  layoutReads = [];
  // Ten presses on the board: each one re-renders BoardView (pressing true, then false).
  for (let i = 0; i < 20; i++) await act(async () => { render(); });
  const reads = layoutReads;
  await act(async () => { root.unmount(); });

  expect({ layoutReadsOver20UnchangedRenders: reads.length, reads: [...new Set(reads)] }).toEqual({ layoutReadsOver20UnchangedRenders: 0, reads: [] });
});
