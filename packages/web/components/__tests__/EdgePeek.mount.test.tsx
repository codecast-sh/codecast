import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { EdgePeek } from "../EdgePeek";

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

async function mountPeek() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<EdgePeek side="right" enabled>list</EdgePeek>);
  });
  const [edge, panel] = [...container.children] as HTMLElement[];
  const isOpen = () => panel.className.includes("translate-x-0");
  // React derives enter/leave from mouseover/mouseout with a relatedTarget.
  const enter = (buttons = 0) =>
    act(() => {
      edge.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, buttons, relatedTarget: document.body }));
    });
  const leave = () =>
    act(() => {
      edge.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
  const cleanup = () => {
    root.unmount();
    container.remove();
  };
  return { isOpen, enter, leave, cleanup };
}

test("resting on the edge slides the panel out", async () => {
  const p = await mountPeek();
  await p.enter();
  expect(p.isOpen()).toBe(false);
  await act(() => wait(350));
  expect(p.isOpen()).toBe(true);
  p.cleanup();
});

test("passing over the edge opens nothing", async () => {
  const p = await mountPeek();
  await p.enter();
  await act(() => wait(80));
  await p.leave();
  await act(() => wait(350));
  expect(p.isOpen()).toBe(false);
  p.cleanup();
});

test("a drag that runs into the edge opens nothing", async () => {
  const p = await mountPeek();
  await p.enter(1);
  await act(() => wait(350));
  expect(p.isOpen()).toBe(false);
  p.cleanup();
});
