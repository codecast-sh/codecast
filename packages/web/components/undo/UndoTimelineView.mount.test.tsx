import assert from "node:assert/strict";
import { afterAll, describe, it } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
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

describe("UndoTimelineView", () => {
  it("is a labelled, non-modal dialog with the KeyCap header", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    const dialog = q('[role="dialog"]')!;
    assert.equal(dialog.getAttribute("aria-label"), "Undo history");
    assert.equal(dialog.hasAttribute("aria-modal"), false);
    const subline = q("[data-undo-subline]")!;
    assert.match(subline.textContent!, /This window · .* reaches the last 5 minutes/);
    assert.ok(subline.querySelector("kbd"), "the key renders as a KeyCap");
    // The reach comes from the model's window, not a literal.
    await mount(<UndoTimelineView model={{ ...model, windowMs: 2 * 60_000 }} mode="interactive" {...handlers} />);
    assert.match(q("[data-undo-subline]")!.textContent!, /reaches the last 2 minutes/);
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    assert.ok(q("[data-undo-legend]")!.querySelectorAll("kbd").length >= 5);
  });

  it("paints every row state, with the set-aside branch under its cause and the start row last", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    const states = new Set(all("[data-undo-row]").map((e) => e.getAttribute("data-state")));
    assert.deepEqual([...states].sort(), ["conflict", "done", "dropped", "external", "partial", "refused", "undone"]);
    assert.match(q('[data-undo-row="fx-defer"] [data-undo-set-aside]')!.textContent!, /2 undone steps set aside when you deferred/);
    assert.ok(q('[data-undo-row="fx-defer"] [data-undo-set-aside]')!.className.includes("line-through"));
    assert.equal(q('[data-undo-row="fx-defer"] [data-undo-detail]')!.textContent, "can undo for 40s more");
    assert.equal(q('[data-undo-row="fx-file"] [data-undo-detail]')!.textContent, "2 rows changed since, left as they are");
    assert.equal(q('[data-undo-row="fx-conflict"] [data-undo-act]'), null);
    assert.ok(q("[data-undo-now]"));
    assert.ok(q("[data-undo-start]"));
    assert.equal(all('[data-undo-row][data-above-head]').map((e) => e.getAttribute("data-undo-row")).join(","), "fx-orphan,fx-pin,fx-file");
  });

  it("Enter walks back to the selected row, and forward from above the head", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    assert.equal(selected(), "fx-status");
    await press("Enter");
    assert.deepEqual(calls, [["undoTo", "fx-status"]]);
    await press("ArrowDown");
    await press("ArrowDown");
    assert.equal(selected(), "fx-defer");
    await press("Enter");
    assert.deepEqual(calls.at(-1), ["undoTo", "fx-defer"]);
    await press("Home");
    await press("ArrowDown");
    await press("ArrowDown");
    assert.equal(selected(), "fx-file");
    await press("Enter");
    assert.deepEqual(calls.at(-1), ["redoTo", "fx-file"]);
    // An inert row does nothing.
    await press("End");
    assert.equal(selected(), "fx-manual");
    const before = calls.length;
    await press("Enter");
    assert.equal(calls.length, before);
  });

  it("the row's button carries the walk and its count", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    const back = q<HTMLButtonElement>('[data-undo-row="fx-old"] [data-undo-act="back"]')!;
    assert.match(back.textContent!, /Back 3/);
    await act(async () => back.click());
    assert.deepEqual(calls, [["undoTo", "fx-old"]]);
    assert.match(q('[data-undo-row="fx-pin"] [data-undo-act="forward"]')!.textContent!, /Forward to here/);
  });

  it("line two's button stays out of flow until hover or selection; the live title truncates apart from the label", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    // Out of flow (display none), not merely transparent, so the detail gets the full width.
    const idle = q('[data-undo-row="fx-defer"] [data-undo-act]')!;
    assert.ok(idle.classList.contains("hidden"));
    assert.ok(idle.classList.contains("group-hover:inline-flex") && idle.classList.contains("group-data-[selected=true]:inline-flex"));
    assert.equal(idle.classList.contains("opacity-0"), false);
    // The title link is not inside the label's truncating span.
    const link = q('[data-undo-row="fx-status"] [data-undo-open]')!;
    assert.equal(link.textContent, "Undo history timeline");
    assert.equal(link.closest("[data-undo-label]"), null);
    // A group names several objects: no single title speaks for it.
    assert.equal(q('[data-undo-row="fx-file"] [data-undo-open]'), null);
  });

  it("the org row offers the org record, by button and by O", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    const org = q<HTMLButtonElement>('[data-undo-row="fx-org"] [data-undo-act="org"]')!;
    assert.match(org.textContent!, /Open in org record/);
    await act(async () => org.click());
    assert.deepEqual(calls, [["org"]]);
    await press("ArrowDown");
    assert.equal(selected(), "fx-org");
    await press("o");
    assert.deepEqual(calls.at(-1), ["org"]);
  });

  it("→ folds a group open, O opens the row's object, Esc closes", async () => {
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
    await press("ArrowUp");
    assert.equal(selected(), "fx-file");
    await press("ArrowRight");
    assert.equal(all('[data-undo-row="fx-file"] [data-undo-child]').length, 3);
    assert.equal(all('[data-undo-row="fx-file"] [data-undo-child]').filter((e) => /left as it is/.test(e.textContent!)).length, 2);
    await press(" ");
    assert.equal(q("[data-undo-fold-rows]"), null);
    await press("ArrowDown");
    await press("o");
    assert.deepEqual(calls.at(-1), ["open", "Undo history timeline"]);
    await press("Escape");
    assert.deepEqual(calls.at(-1), ["close"]);
  });

  it("Esc closes the focused card even when a page behind binds Escape past the input guard", async () => {
    // The app's real dispatcher: a capture-phase window listener with the real
    // catalog and ownership rules, a conversation with a selected message and
    // /changes with a story open, each ready to claim Escape.
    const dispatcher = new ShortcutDispatcher<import("../../shortcuts/registry").ShortcutAction>();
    const behind: string[] = [];
    dispatcher.setContext("conversation", true);
    dispatcher.setContext("changes", true);
    dispatcher.register("msg.clearSelection", () => { behind.push("clearSelection"); });
    dispatcher.register("changes.escape", () => { behind.push("changes.escape"); return true; });
    const listener = createKeydownHandler(shortcutCatalog, dispatcher, KEY_OWNERSHIP);
    window.addEventListener("keydown", listener, true);
    try {
      await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} />);
      assert.ok(q('[data-undo-timeline="interactive"]')!.contains(document.activeElement), "the card holds focus");
      await press("Escape");
      assert.deepEqual(behind, []);
      assert.deepEqual(calls.at(-1), ["close"]);
      // Outside the card the page's Escape still works.
      document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      assert.deepEqual(behind, ["clearSelection"]);
    } finally {
      window.removeEventListener("keydown", listener, true);
    }
  });

  it("hands chords to onKey first", async () => {
    const seen: string[] = [];
    await mount(<UndoTimelineView model={model} mode="interactive" {...handlers} onKey={(e) => { if (e.key === "z" && e.metaKey) { seen.push("undo"); e.preventDefault(); return true; } return false; }} />);
    await press("z", { metaKey: true });
    assert.deepEqual(seen, ["undo"]);
    assert.deepEqual(calls, []);
  });

  it("a peek shows the head with a few rows either side and no key legend", async () => {
    await mount(<UndoTimelineView model={model} mode="peek" {...handlers} />);
    const rows = all("[data-undo-row]").map((e) => e.getAttribute("data-undo-row"));
    const at = rows.indexOf("fx-status");
    assert.ok(at !== -1 && at <= 3);
    // The head plus four below it.
    assert.deepEqual(rows.slice(at + 1), ["fx-org", "fx-defer", "fx-conflict", "fx-refused"]);
    assert.equal(q("[data-undo-legend]"), null);
    assert.equal(q('[data-undo-timeline="peek"]')!.contains(document.activeElement), false);
  });

  it("says what collects here when nothing has", async () => {
    await mount(<UndoTimelineView model={{ rows: [], headIndex: 0, headId: null, windowMs: 300_000 }} mode="interactive" {...handlers} />);
    assert.equal(q("[data-undo-empty]")!.textContent, "Nothing to take back yet. Changes you make in this window collect here, newest first, each with a way back.");
    assert.equal(q("[data-undo-row]"), null);
  });
});
