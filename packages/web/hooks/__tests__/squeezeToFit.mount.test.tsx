import { afterAll, expect, test } from "bun:test";
import { act, useRef } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// The squeeze hook mounted across a rename. Level 5's title floor widens a
// short title, so shedding is not monotonic: with the rename closed, level 4
// fits, 5 overflows and 6 fits. The rename box's own floor lifts the row to 6;
// once the rename ends, the next pass must land on 4, not stay at 6 with the
// status, facts and Ship hidden.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
let resized: (() => void) | null = null;
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} },
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// jsdom lays nothing out: the row's content width is a function of its level
// and of whether the rename box is in it.
const ROW_WIDTH = 500;
const contentWidth = (level: number, renaming: boolean) =>
  renaming ? 900 - level * 70 : ({ 4: 480, 5: 560 } as Record<number, number>)[level] ?? 800 - level * 70;
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => ROW_WIDTH });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", {
  configurable: true,
  get(this: HTMLElement) {
    const level = this.getAttribute("data-squeeze")?.split(" ").length ?? 0;
    return contentWidth(level, !!this.querySelector("input"));
  },
});

const { createRoot } = await import("react-dom/client");
const { useSqueezeToFit } = await import("../useSqueezeToFit");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function Row({ renaming }: { renaming: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useSqueezeToFit(ref, 7);
  return <div ref={ref} data-row>{renaming ? <input /> : <h1>Title</h1>}</div>;
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 5)));

test("the header comes back below the widening level once a rename ends", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Row renaming />));
  const row = host.querySelector("[data-row]")!;
  expect(row.getAttribute("data-squeeze")).toBe("1 2 3 4 5 6");

  await act(async () => root.render(<Row renaming={false} />));
  await flush();
  expect(row.getAttribute("data-squeeze")).toBe("1 2 3 4");
  expect(resized).not.toBeNull();
  await act(async () => root.unmount());
});
