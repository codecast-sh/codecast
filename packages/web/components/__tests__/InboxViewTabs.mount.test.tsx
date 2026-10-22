import { afterAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { InboxViewMode } from "../../store/inboxStore";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { InboxViewTabs } = await import("../InboxViewTabs");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function mount() {
  const changes: InboxViewMode[] = [];
  function Fixture() {
    const [value, setValue] = useState<InboxViewMode>("grouped");
    return <InboxViewTabs value={value} onChange={(next) => { changes.push(next); setValue(next); }} modes={["grouped", "recent", "time", "bucket", "project", "trigger"]} />;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")!;
  return { container, root, changes, tabs, selected, render: () => act(async () => root.render(<Fixture />)) };
}

test("every grouping it is given is a tab, in order, and a click switches to it", async () => {
  const m = mount();
  await m.render();
  expect(m.tabs().map((t) => t.dataset.viewTab)).toEqual(["grouped", "recent", "time", "bucket", "project", "trigger"]);
  expect(m.selected().dataset.viewTab).toBe("grouped");
  await act(async () => m.tabs()[4].click());
  expect(m.changes).toEqual(["project"]);
  expect(m.selected().dataset.viewTab).toBe("project");
  expect(m.selected().tabIndex).toBe(0);
  expect(m.tabs().filter((t) => t.tabIndex === 0).length).toBe(1);
  m.root.unmount();
});

test("arrow keys, Home and End move the grouping and wrap", async () => {
  const m = mount();
  await m.render();
  const key = (k: string) => act(async () => {
    m.selected().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await key("ArrowLeft");
  expect(m.selected().dataset.viewTab).toBe("trigger");
  expect(document.activeElement).toBe(m.selected());
  await key("ArrowRight");
  await key("ArrowRight");
  expect(m.selected().dataset.viewTab).toBe("recent");
  await key("End");
  expect(m.selected().dataset.viewTab).toBe("trigger");
  await key("Home");
  expect(m.changes).toEqual(["trigger", "grouped", "recent", "trigger", "grouped"]);
  m.root.unmount();
});

test("only the current tab is named; the others are icons named on hover", async () => {
  const m = mount();
  await m.render();
  expect(m.tabs().map((t) => t.textContent)).toEqual(["Status", "", "", "", "", ""]);
  expect(m.tabs()[3].getAttribute("aria-label")).toBe("By label");
  await act(async () => m.tabs()[3].click());
  expect(m.tabs().map((t) => t.textContent)).toEqual(["", "", "", "Label", "", ""]);
  m.root.unmount();
});
