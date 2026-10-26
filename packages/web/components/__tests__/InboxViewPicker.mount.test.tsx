import { afterAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { InboxViewMode } from "../../store/inboxStore";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  HTMLElement: w.HTMLElement,
  HTMLButtonElement: w.HTMLButtonElement,
  Element: w.Element,
  Node: w.Node,
  Event: w.Event,
  CustomEvent: w.CustomEvent,
  MouseEvent: w.MouseEvent,
  PointerEvent: w.PointerEvent ?? w.MouseEvent,
  KeyboardEvent: w.KeyboardEvent,
  FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  DOMRect: w.DOMRect,
  requestAnimationFrame: w.requestAnimationFrame,
  cancelAnimationFrame: w.cancelAnimationFrame,
  getComputedStyle: w.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { InboxViewPicker } = await import("../InboxViewPicker");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function mount() {
  const changes: InboxViewMode[] = [];
  function Fixture() {
    const [value, setValue] = useState<InboxViewMode>("grouped");
    return <InboxViewPicker value={value} onChange={(next) => { changes.push(next); setValue(next); }} modes={["grouped", "recent", "time", "bucket", "project", "trigger"]} />;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const trigger = () => container.querySelector<HTMLButtonElement>("[data-inbox-view-picker]")!;
  const options = () => [...document.querySelectorAll<HTMLElement>("[data-view-option]")];
  const open = () => act(async () => {
    trigger().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return { root, changes, trigger, options, open, render: () => act(async () => root.render(<Fixture />)) };
}

test("the trigger names the current grouping and lists every grouping it is given, in order", async () => {
  const m = mount();
  await m.render();
  expect(m.trigger().textContent).toBe("Status");
  expect(m.options().length).toBe(0);
  await m.open();
  expect(m.options().map((o) => o.dataset.viewOption)).toEqual(["grouped", "recent", "time", "bucket", "project", "trigger"]);
  m.root.unmount();
});

test("picking a grouping switches to it and renames the trigger", async () => {
  const m = mount();
  await m.render();
  await m.open();
  await act(async () => m.options()[4].click());
  expect(m.changes).toEqual(["project"]);
  expect(m.trigger().textContent).toBe("Project");
  expect(m.trigger().getAttribute("aria-label")).toBe("Grouped by project");
  m.root.unmount();
});
