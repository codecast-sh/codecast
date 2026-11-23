// The ways from the panel above the composer to the whole decision. A person
// pressed the folded dock's question and the pinned state's "answer the card…"
// line and reached nothing: the row only unfolded the dock, and the line was
// plain text. Each press here must open the sheet; only the chevron folds.
// Run: bun test components/conversation/__tests__/decisionOpenPaths.mount.test.tsx
import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ModernDecisionDock } = await import("../ModernDecisionDock");
const { ThreadStatePanelView } = await import("../../ThreadStatePanel");
const { registerDecisionOpener, useDecisionOpener } = await import("../../../lib/decisionOpenRegistry");

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
};

describe("the docked decision opens from its question", () => {
  const base = { question: "Widen the line?", options: [{ label: "Yes", index: 0 }], held: () => false, onAnswer: () => {}, text: "", onText: () => {}, answerable: true };

  test("folded: the question opens the decision, the chevron unfolds it", () => {
    const calls: string[] = [];
    const { host, unmount } = mount(<ModernDecisionDock {...base} collapsed onOpen={() => calls.push("open")} onCollapsed={(v) => calls.push(`fold:${v}`)} />);
    click(host.querySelector("[data-decision-collapsed-question]"));
    expect(calls).toEqual(["open"]);
    click(host.querySelector("[data-decision-collapse]"));
    expect(calls).toEqual(["open", "fold:false"]);
    unmount();
  });

  test("open: the question opens the decision, as Open does", () => {
    const calls: string[] = [];
    const { host, unmount } = mount(<ModernDecisionDock {...base} onOpen={() => calls.push("open")} onCollapsed={() => calls.push("fold")} />);
    click(host.querySelector("[data-decision-question-open]"));
    click(host.querySelector("[data-decision-open]"));
    expect(calls).toEqual(["open", "open"]);
    unmount();
  });
});

describe("the pinned state's You line opens the docked decision", () => {
  const state = "Waiting on Alex: widen the line?\nYou: answer the card on widening the line\nDone: copy fix live";
  const panel = (onOpenDecision?: () => void) => (
    <ThreadStatePanelView conversationId="c1" threadState={state} threadStateAt={Date.now()} threadStateMsgCount={10} threadStateStatus="blocked" messageCount={10} now={Date.now()} collapsed={false} prStatus={null} onToggle={() => {}} onOpenDecision={onOpenDecision} />
  );

  test("with a decision docked, the line and its Open button open it, once per press", () => {
    let opened = 0;
    const { host, unmount } = mount(panel(() => { opened++; }));
    const open = host.querySelector("[data-state-open-decision]");
    expect(open).not.toBeNull();
    click(open);
    expect(opened).toBe(1);
    click(open!.parentElement!.querySelector("span"));
    expect(opened).toBe(2);
    unmount();
  });

  test("with none docked, the line stays plain text", () => {
    const { host, unmount } = mount(panel(undefined));
    expect(host.querySelector("[data-state-open-decision]")).toBeNull();
    expect(host.textContent).toContain("answer the card on widening the line");
    unmount();
  });

  test("the registry hands the panel the docked card's opener while it is mounted", () => {
    let seen: (() => void) | null = null;
    function Probe() { seen = useDecisionOpener("c1"); return null; }
    const { unmount } = mount(<Probe />);
    expect(seen).toBeNull();
    const open = () => {};
    let off!: () => void;
    act(() => { off = registerDecisionOpener("c1", open); });
    expect(seen).toBe(open);
    act(() => off());
    expect(seen).toBeNull();
    unmount();
  });
});
