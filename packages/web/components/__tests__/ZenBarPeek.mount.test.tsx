// Zen draws no control of its own: resting the pointer on the window's top
// edge slides the top bar down, and leaving the bar slides it away, unless one
// of the bar's own menus is open.
import { afterAll, expect, test } from "bun:test";
import { act, useRef } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { ZenTopEdge } from "../ZenBarPeek";
import { useZenBarPeek } from "../../hooks/useZenBarPeek";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Shell({ zen, menuOpen }: { zen: boolean; menuOpen: boolean }) {
  const bar = useRef<HTMLElement>(null);
  const peek = useZenBarPeek(zen, bar);
  return (
    <div>
      <header ref={bar} data-open={peek.open ? "yes" : "no"} onMouseEnter={peek.onBarEnter} onMouseLeave={peek.onBarLeave}>
        <button aria-expanded={menuOpen}>Workspace</button>
      </header>
      <main>page</main>
      {zen && <ZenTopEdge onEnter={peek.onEdgeEnter} onLeave={peek.onEdgeLeave} />}
    </div>
  );
}

async function mount(opts: { zen?: boolean; menuOpen?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (o: { zen?: boolean; menuOpen?: boolean }) =>
    act(async () => { root.render(<Shell zen={o.zen ?? true} menuOpen={o.menuOpen ?? false} />); });
  await render(opts);
  const q = (sel: string) => container.querySelector(sel) as HTMLElement;
  // React derives enter/leave inside a root from the mouseout of the element
  // the pointer left (relatedTarget: where it went), so a move is one mouseout.
  const move = (from: HTMLElement, to: HTMLElement, buttons = 0) =>
    act(() => { from.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, buttons, relatedTarget: to })); });
  return {
    render,
    edge: () => q("[data-zen-top-edge]"),
    bar: () => q("header"),
    page: () => q("main"),
    isOpen: () => q("header").dataset.open === "yes",
    move,
    cleanup: () => { root.unmount(); container.remove(); },
  };
}

test("resting on the top edge slides the bar down; leaving it slides it away", async () => {
  const p = await mount();
  await p.move(p.page(), p.edge());
  expect(p.isOpen()).toBe(false);
  await act(() => wait(350));
  expect(p.isOpen()).toBe(true);
  await p.move(p.edge(), p.bar());
  expect(p.isOpen()).toBe(true);
  await p.move(p.bar(), p.page());
  expect(p.isOpen()).toBe(false);
  p.cleanup();
});

test("passing over the edge, or reaching it mid-drag, opens nothing", async () => {
  const p = await mount();
  await p.move(p.page(), p.edge());
  await act(() => wait(100));
  await p.move(p.edge(), p.page());
  await act(() => wait(350));
  expect(p.isOpen()).toBe(false);
  await p.move(p.page(), p.edge(), 1);
  await act(() => wait(350));
  expect(p.isOpen()).toBe(false);
  p.cleanup();
});

test("a menu opened from the bar keeps it down until the menu closes", async () => {
  const p = await mount();
  await p.move(p.page(), p.edge());
  await act(() => wait(350));
  await p.move(p.edge(), p.bar());
  await p.render({ menuOpen: true });
  await p.move(p.bar(), p.page());
  await act(() => wait(400));
  expect(p.isOpen()).toBe(true);
  await p.render({ menuOpen: false });
  await act(() => wait(400));
  expect(p.isOpen()).toBe(false);
  p.cleanup();
});

test("leaving zen drops the edge and the peek", async () => {
  const p = await mount();
  await p.move(p.page(), p.edge());
  await act(() => wait(350));
  expect(p.isOpen()).toBe(true);
  await p.render({ zen: false });
  expect(p.edge()).toBeNull();
  expect(p.isOpen()).toBe(false);
  p.cleanup();
});
