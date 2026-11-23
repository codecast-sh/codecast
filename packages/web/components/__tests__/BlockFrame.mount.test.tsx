// A rich block is capped from its first paint. It once mounted at full height
// and folded only after its ResizeObserver answered, so a tall table swung its
// transcript row by thousands of px on every mount and the virtualized list
// chased each swing with a scroll jump.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { BlockFrame } from "../BlockFrame";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
let report: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) { report = cb; }
  observe() {}
  disconnect() {}
}
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  ResizeObserver: FakeResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("a block is capped before its height is known, and Show all lifts the cap", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<BlockFrame title="Table"><div data-body>rows</div></BlockFrame>);
  });
  const body = host.querySelector("[data-body]") as HTMLElement;
  const clip = body.parentElement as HTMLElement;
  // No observer report yet: the cap is already on, with no control drawn.
  expect(clip.style.maxHeight).toBe("620px");
  expect(host.textContent).not.toContain("Show all");

  // The content turns out taller than the cap.
  Object.defineProperty(body, "offsetHeight", { configurable: true, value: 2500 });
  await act(async () => { report?.(); });
  expect(clip.style.maxHeight).toBe("620px");
  const showAll = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Show all"))!;
  expect(showAll).toBeTruthy();

  await act(async () => { showAll.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  expect(clip.style.maxHeight).toBe("");
  expect(host.textContent).toContain("Collapse");
  await act(async () => { root.unmount(); });
});
