import assert from "node:assert/strict";
import { afterAll, describe, it } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
// The rows the card scrolled into view, newest last.
const scrolled: string[] = [];
dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  const row = this.getAttribute("data-undo-row") ?? this.querySelector("[data-undo-row]")?.getAttribute("data-undo-row");
  if (row) scrolled.push(row);
};
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { UndoTimelineView } = await import("./UndoTimelineView");
const { undoHistoryFixture, undoTimelineRows } = await import("../../lib/undoHistory");
const { createKeydownHandler, ShortcutDispatcher } = await import("@platform/keys");
const { shortcutCatalog } = await import("../../shortcuts/registry");
const { KEY_OWNERSHIP } = await import("../../shortcuts/keyOwnership");

const NOW = new Date(2026, 9, 3, 12).getTime();
const fx = undoHistoryFixture(NOW);
// One dropped entry whose cause has left the history, so every state paints.
const orphan = { id: "fx-orphan", label: "Pinned “Old idea”", ts: NOW - 30_000, status: "dropped" as const, droppedBy: "gone", mode: "generic" as const };
const model = undoTimelineRows({ ...fx.snapshot, items: [orphan, ...fx.snapshot.items] }, fx.state, NOW);

type Call = [string, ...unknown[]];
const calls: Call[] = [];
const handlers = {
  onUndoTo: (id: string) => calls.push(["undoTo", id]),
  onRedoTo: (id: string) => calls.push(["redoTo", id]),
  onOpen: (visit: { title: string }) => calls.push(["open", visit.title]),
  onOpenOrg: () => calls.push(["org"]),
  onClose: () => calls.push(["close"]),
};

let root = createRoot(document.getElementById("root")!);
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const mount = async (node: React.ReactNode) => {
  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  calls.length = 0;
  await act(async () => root.render(node as never));
};
const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    q("[cmdk-root]")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};
const selected = () => q('[cmdk-item][data-selected="true"]')?.getAttribute("data-undo-row");

afterAll(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  restoreGlobals();
});
describe("scratch", () => {
  it("fold remount drops focus", async () => {
    const base = model.rows.find((r: any) => r.id === "fx-file")!;
    const doneRow = { ...base, state: "done", detail: "", act: { kind: "back" } };
    const undoneRow = { ...base, state: "undone", detail: "undone just now" };
    const m1 = { ...model, rows: model.rows.map((r: any) => r.id === "fx-file" ? doneRow : r) };
    const m2 = { ...model, rows: model.rows.map((r: any) => r.id === "fx-file" ? undoneRow : r) };
    await mount(<UndoTimelineView model={m1 as any} mode="interactive" {...handlers} />);
    const fold = q('[data-undo-row="fx-file"] [data-undo-fold]')!;
    fold.focus();
    console.log("focused fold", document.activeElement === fold);
    await act(async () => root.render(<UndoTimelineView model={m2 as any} mode="interactive" {...handlers} />));
    console.log("active", document.activeElement?.tagName, "in card", !!q('[role=dialog]')?.contains(document.activeElement));
    calls.length = 0;
    const kd = createKeydownHandler ? null : null;
    await act(async () => { document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    console.log("calls", JSON.stringify(calls), "mounted", !!q('[role=dialog]'));
  });
});
