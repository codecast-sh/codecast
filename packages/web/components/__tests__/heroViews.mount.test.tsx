// The views split out for the marketing hero (heroFly/ARCHITECTURE.md section
// 3 items 8 to 10) take their writes as props. Clicking them with those props
// set calls the prop and leaves the store alone, which is what lets the hero
// mount them over fixtures.

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Command } from "cmdk";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { KanbanCard } from "../tasks/TaskRow";
import { DocRow } from "../docs/DocRow";
import { PaletteSessionRow, PaletteSearchResultRow } from "../PaletteRows";
import { DecisionCompactCardView } from "../decisions/DecisionCompactCard";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// cmdk scrolls the selected item into view; jsdom has no layout.
dom.window.Element.prototype.scrollIntoView = () => {};
// react-dom/client decides at load whether a DOM exists, so it loads after
// the globals above.
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  void convex.close();
  closeDomWindow(dom);
  restoreGlobals();
});

const NOW = Date.now();
const convex = new ConvexReactClient("https://example.convex.cloud");

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<ConvexProvider client={convex}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>); });
  return { container, unmount: () => act(() => root.unmount()) };
}

const click = (el: Element | null) => act(() => { el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });

test("KanbanCard hands the assignee click to onAssign", async () => {
  const before = useInboxStore.getState().palette;
  const calls: number[] = [];
  const task = { _id: "hero-t1", short_id: "ct-hero1", title: "Retry webhooks", task_type: "task", status: "open", priority: "high", source: "human", created_at: NOW, updated_at: NOW, assignee_info: { name: "Ada Lovelace" } };
  const { container, unmount } = await mount(<KanbanCard task={task} onFilterLabel={() => {}} onClick={() => {}} onContextMenu={() => {}} onAssign={() => calls.push(1)} />);
  await click(container.querySelector('button[aria-label="Change assignee: Ada Lovelace"]'));
  expect(calls).toEqual([1]);
  expect(useInboxStore.getState().palette).toBe(before);
  await unmount();
});

test("DocRow hands the star click to onStar", async () => {
  const before = useInboxStore.getState().docs;
  const calls: [string, boolean][] = [];
  const doc = { _id: "hero-d1", title: "Retry design", doc_type: "design", source: "human", created_at: NOW, updated_at: NOW } as any;
  const { container, unmount } = await mount(<DocRow doc={doc} onStar={(d, starred) => calls.push([d._id, starred])} />);
  await click(container.querySelector('button[aria-label="Star document"]'));
  expect(calls).toEqual([["hero-d1", true]]);
  expect(useInboxStore.getState().docs).toBe(before);
  await unmount();
});

test("palette rows draw inside cmdk and select through onSelect", async () => {
  const picked: string[] = [];
  const { container, unmount } = await mount(
    <Command>
      <Command.List>
        <PaletteSessionRow conv={{ _id: "hero-c1", title: "Fix the auth race", project_path: "/src/api", updated_at: NOW - 5 * 60_000 }} bucket={{ name: "Launch" }} onSelect={() => picked.push("recent")} />
        <PaletteSearchResultRow result={{ conversationId: "hero-c2", title: "Deploy script", updatedAt: NOW, isOwn: true, matches: [{ content: "rotate the token" }] }} onSelect={() => picked.push("search")} />
      </Command.List>
    </Command>,
  );
  const items = [...container.querySelectorAll("[cmdk-item]")];
  expect(items.map((i) => i.getAttribute("data-palette-id"))).toEqual(["hero-c1", "hero-c2"]);
  expect(items[0].textContent).toContain("Launch");
  expect(items[0].textContent).toContain("5m ago");
  expect(items[1].textContent).toContain("rotate the token");
  await click(items[0]);
  await click(items[1]);
  expect(picked).toEqual(["recent", "search"]);
  await unmount();
});

test("DecisionCompactCardView answers through onAnswer", async () => {
  const answers: unknown[] = [];
  const decision = {
    _id: "hero-dec1", conversation_id: "hero-c1", session_id: "s1", session_title: "Webhook retry rewrite",
    question: "Flag or everyone?", options: [{ label: "Behind a flag" }, { label: "Everyone" }],
    blocking: true, status: "pending", created_at: NOW - 60_000,
  } as any;
  const { container, unmount } = await mount(<DecisionCompactCardView decision={decision} now={NOW} onAnswer={(i) => answers.push(i)} onDismiss={() => {}} />);
  expect(container.textContent).toContain("Webhook retry rewrite");
  const option = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Everyone"));
  await click(option!);
  expect(answers).toEqual([{ index: 1 }]);
  await unmount();
});
