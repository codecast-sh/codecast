// The held undo walk driven through the real shortcut dispatcher
// (hooks/useUndoWalk.mount.test.ts spawns this file in its own process: the
// dispatcher's capture listener is installed when @platform/keys first loads,
// so the DOM has to exist before anything imports it).
//
// jsdom's user agent names the platform (darwin, linux) but never "Mac", so
// the catalog resolves its non-mac chords and the walk modifier is Control.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, Event: dom.window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { restore(); closeDomWindow(dom); });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ShortcutProvider, useShortcutAction, useShortcutContext, useShortcuts } = await import("../../../shortcuts/ShortcutProvider");
const { useUndoWalk } = await import("../../useUndoWalk");
const { pushUndo, _resetUndoStacks } = await import("@platform/engine");
const undoTimeline = await import("../../../lib/undoTimelineOpen");
const { PEEK_DELAY_MS } = await import("../../../lib/undoWalk");

let thinking = 0;
let diffs = 0;
let dispatch: (action: "ui.undo" | "ui.redo") => boolean;

// A conversation page: its H toggles thinking blocks and its D the diff panel.
function Page() {
  useShortcutContext("conversation");
  useShortcutAction("conv.toggleThinking", () => { thinking += 1; });
  useShortcutAction("conv.toggleDiff", () => { diffs += 1; });
  useUndoWalk();
  dispatch = useShortcuts().dispatchAction;
  return null;
}

let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  _resetUndoStacks();
  thinking = 0;
  diffs = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<ShortcutProvider><Page /></ShortcutProvider>));
});
afterEach(async () => {
  await act(async () => { undoTimeline.close(); });
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

function key(type: "keydown" | "keyup", k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const code = /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : k;
  act(() => { document.body.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, ...mods })); });
}
const press = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => key("keydown", k, mods);
const holdControl = () => key("keydown", "Control", { ctrlKey: true });
const releaseControl = () => key("keyup", "Control");
const undoable = (label: string) => pushUndo({ label, undo: () => {}, redo: () => {} });
const card = () => (undoTimeline.isOpen() ? undoTimeline.getMode() : "closed");

/** Two held undos: the second inside the delay opens the peek at once. */
function walkIntoPeek() {
  undoable("first");
  undoable("second");
  holdControl();
  press("z", { ctrlKey: true });
  press("z", { ctrlKey: true });
  expect(card()).toBe("peek");
}

test("H during the fade pins the card and leaves the page's H alone", () => {
  walkIntoPeek();
  releaseControl();
  press("h");
  expect(card()).toBe("interactive");
  expect(thinking).toBe(0);
});

test("Ctrl+H pins the card while the modifier is held", () => {
  walkIntoPeek();
  press("h", { ctrlKey: true });
  expect(card()).toBe("interactive");
  expect(thinking).toBe(0);
});

// The composer is autofocused on a conversation page, and the walk opens from
// it while it is empty. A pin key there is never typing: the context lives
// only while the card shows, so the key pins and the field gets no letter.
function inEmptyComposer() {
  const field = document.body.appendChild(document.createElement("textarea"));
  field.focus();
  const send = (type: "keydown" | "keyup", k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
    const code = /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : k;
    const event = new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, ...mods });
    act(() => { field.dispatchEvent(event); });
    return event;
  };
  undoable("first");
  undoable("second");
  send("keydown", "Control", { ctrlKey: true });
  send("keydown", "z", { ctrlKey: true });
  send("keydown", "z", { ctrlKey: true });
  expect(card()).toBe("peek");
  return send;
}

test("H during the fade pins the card from a focused empty composer", () => {
  const send = inEmptyComposer();
  send("keyup", "Control");
  const typed = send("keydown", "h");
  expect(card()).toBe("interactive");
  expect(typed.defaultPrevented).toBe(true);
  expect(thinking).toBe(0);
});

test("Ctrl+H pins the card from a focused empty composer", () => {
  const send = inEmptyComposer();
  const typed = send("keydown", "h", { ctrlKey: true });
  expect(card()).toBe("interactive");
  expect(typed.defaultPrevented).toBe(true);
});

test("with no walk, H is the page's again", () => {
  walkIntoPeek();
  releaseControl();
  press("h");
  act(() => { undoTimeline.close(); });
  press("h");
  expect(thinking).toBe(1);
});

test("a shortcut the page handles ends the walk and still reaches the page", () => {
  walkIntoPeek();
  releaseControl();
  press("d");
  expect(diffs).toBe(1);
  expect(card()).toBe("closed");
});

test("a key no shortcut handles ends the walk", () => {
  walkIntoPeek();
  releaseControl();
  press("q");
  expect(card()).toBe("closed");
});

test("a press that moved nothing does not arm the peek", async () => {
  // A conflict: the entry is dropped and a notice shows, but nothing came back.
  pushUndo({ label: "taken back elsewhere", undo: () => ({ ok: false, reason: "conflict" }), redo: () => {} });
  holdControl();
  press("z", { ctrlKey: true });
  // A confirm entry: the press only names it.
  pushUndo({ label: "big change", confirm: true, undo: () => {}, redo: () => {} });
  press("z", { ctrlKey: true });
  await act(() => new Promise((r) => setTimeout(r, PEEK_DELAY_MS + 50)));
  expect(card()).toBe("closed");
  releaseControl();
});

test("a press that took something back arms the peek after the delay", async () => {
  undoable("only");
  holdControl();
  press("z", { ctrlKey: true });
  expect(card()).toBe("closed");
  await act(() => new Promise((r) => setTimeout(r, PEEK_DELAY_MS + 50)));
  expect(card()).toBe("peek");
  releaseControl();
});

// The desktop Edit menu takes ⌘Z before the page and hands it back through
// onAppEditCommand. It must decline wherever the dispatcher declines the key.
test("the desktop Edit menu's undo passes the dispatcher's focus guards", async () => {
  let edit: ((dir: "undo" | "redo") => void) | undefined;
  (window as any).__CODECAST_ELECTRON__ = { onAppEditCommand: (cb: typeof edit) => { edit = cb; return () => {}; } };
  try {
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<ShortcutProvider><Page /></ShortcutProvider>));
    let undone = 0;
    pushUndo({ label: "a", undo: () => { undone += 1; }, redo: () => {} });

    const region = document.body.appendChild(document.createElement("div"));
    region.setAttribute("data-owns-keys", "");
    const inner = region.appendChild(document.createElement("button"));
    inner.focus();
    act(() => edit!("undo"));
    expect(undone).toBe(0);

    const terminal = document.body.appendChild(document.createElement("div"));
    terminal.setAttribute("data-terminal-panel", "");
    terminal.appendChild(document.createElement("button")).focus();
    act(() => edit!("undo"));
    expect(undone).toBe(0);

    (document.activeElement as HTMLElement).blur();
    act(() => edit!("undo"));
    expect(undone).toBe(1);
  } finally {
    delete (window as any).__CODECAST_ELECTRON__;
  }
});

// The palette's Undo and Redo rows dispatch the action by name while focus is
// still in the palette input the user just typed the query into. That input's
// edit is newer than the entry, but it is no history of the step's: a named
// step always runs. The same chord pressed in that field still defers to it.
test("a named undo or redo from a just-edited field steps; the chord there defers to the field", async () => {
  let undone = 0;
  let redone = 0;
  pushUndo({ label: "a", undo: () => { undone += 1; }, redo: () => { redone += 1; } });
  await act(() => new Promise((r) => setTimeout(r, 5)));
  const input = document.body.appendChild(document.createElement("input"));
  input.focus();
  const typed = () => act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  typed();
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true })); });
  expect(undone).toBe(0);
  expect(document.activeElement).toBe(input);
  act(() => { dispatch("ui.undo"); });
  expect(undone).toBe(1);
  await act(() => new Promise((r) => setTimeout(r, 5)));
  typed();
  act(() => { dispatch("ui.redo"); });
  expect(redone).toBe(1);
});

// The field keeps a chord only while the browser has something to take back
// in it. Once its own edits are undone (no input answers the press), the
// press reaches the app, and so does every later one.
test("a chord the field declines reaches the app once the field's history is spent", async () => {
  let undone = 0;
  pushUndo({ label: "a", undo: () => { undone += 1; }, redo: () => {} });
  pushUndo({ label: "b", undo: () => { undone += 1; }, redo: () => {} });
  await act(() => new Promise((r) => setTimeout(r, 5)));
  const input = document.body.appendChild(document.createElement("textarea"));
  input.focus();
  const typed = () => act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  const chord = () => act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true })); });
  const tick = () => act(() => new Promise((r) => setTimeout(r, 5)));
  typed();
  typed();
  // The browser's own undo answers with an input: the field keeps the press.
  chord();
  typed();
  await tick();
  expect(undone).toBe(0);
  // Nothing answers: the field is spent and the app takes the press.
  chord();
  await tick();
  expect(undone).toBe(1);
  chord();
  expect(undone).toBe(2);
});
