// A goal's hover card is the object card every kind shares: a plain click
// opens the goal's page, Cmd or Ctrl opens a new tab,
// Enter does what a plain click does, a pill's own opener runs first, a
// name inside the summary keeps its click, and opening by click or by Enter
// closes the hover card the body sits in.
// Run: bun test components/initiatives/GoalHoverContent.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import { closeDomWindow } from "../../test-helpers/domGlobals";

test("the goal card opens like every object card", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const h = React.createElement;
  const log: string[] = [];
  (dom.window as any).open = (url: string) => { log.push(`tab:${url}`); return null; };
  (globalThis as any).window.open = (dom.window as any).open;
  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push: (u: string) => log.push(`push:${u}`), replace: () => {} }) }));
  const realSummary = { ...(await import("../org/lines/ObjectSummary")) };
  mock.module("../org/lines/ObjectSummary", () => ({ ...realSummary, GoalSummary: ({ goal }: any) => h("div", null, goal.title, h("a", { href: "/org/in-9", "data-inner": true, onClick: (e: any) => { e.preventDefault(); log.push("inner"); } }, "Parent")) }));

  const { createRoot } = await import("react-dom/client");
  const { GoalHoverContent } = await import("./GoalHoverContent");
  const goal = { _id: "goal1", short_id: "in-1", title: "Grow" } as any;
  const root = createRoot(document.getElementById("root")!);
  const card = () => document.querySelector<HTMLElement>("[data-initiative-hover='in-1']")!;
  const click = (el: Element, init: MouseEventInit = {}) => React.act(async () => { el.dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })); });
  const enter = (init: KeyboardEventInit = {}) => React.act(async () => { card().dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })); });

  // The goal's page, by click and by Enter; a new tab on Cmd.
  await React.act(async () => root.render(h(GoalHoverContent, { goal })));
  assert.equal(card().getAttribute("data-object-card"), "initiative");
  // The whole card is the click target; it says what a click does to assistive tech, with no foot.
  assert.equal(card().getAttribute("aria-label"), "Open goal");
  assert.doesNotMatch(card().textContent!, /Open goal/);
  await click(card());
  await enter();
  await click(card(), { metaKey: true });
  await enter({ ctrlKey: true });
  await click(document.querySelector("[data-inner]")!);
  assert.deepEqual(log, ["push:/goals/in-1", "push:/goals/in-1", "tab:/goals/in-1", "tab:/goals/in-1", "inner"]);

  // A pill's opener runs first; what it leaves undone, the card does.
  log.length = 0;
  await React.act(async () => root.render(h(GoalHoverContent, { goal, onOpen: () => log.push("pill") })));
  await click(card());
  await click(card(), { ctrlKey: true });
  assert.deepEqual(log, ["pill", "push:/goals/in-1", "pill", "tab:/goals/in-1"]);
  log.length = 0;
  await React.act(async () => root.render(h(GoalHoverContent, { goal, onOpen: (e: any) => { e.preventDefault(); log.push("pill opened it"); } })));
  await click(card());
  assert.deepEqual(log, ["pill opened it"]);

  // Inside a hover card, opening by click or by Enter closes the card.
  log.length = 0;
  const { HoverCardClose } = await import("../../lib/hoverCardsOff");
  await React.act(async () => root.render(h(HoverCardClose.Provider, { value: () => log.push("closed") }, h(GoalHoverContent, { goal }))));
  await click(card());
  await enter();
  assert.deepEqual(log, ["closed", "push:/goals/in-1", "closed", "push:/goals/in-1"]);

  await React.act(async () => root.unmount());
  // bun keeps a module mock for every later file in the run: hand the real modules back.
  mock.module("../org/lines/ObjectSummary", () => realSummary);
  mock.module("next/navigation", () => realNav);
  closeDomWindow(dom);
});
