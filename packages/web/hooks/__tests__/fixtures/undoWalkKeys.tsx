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
const { ShortcutProvider, useShortcutAction, useShortcutContext } = await import("../../../shortcuts/ShortcutProvider");
const { useUndoWalk } = await import("../../useUndoWalk");
const { pushUndo, _resetUndoStacks } = await import("@platform/engine");
const undoTimeline = await import("../../../lib/undoTimelineOpen");
const { PEEK_DELAY_MS } = await import("../../../lib/undoWalk");

let thinking = 0;
let diffs = 0;

// A conversation page: its H toggles thinking blocks and its D the diff panel.
function Page() {
  useShortcutContext("conversation");
  useShortcutAction("conv.toggleThinking", () => { thinking += 1; });
  useShortcutAction("conv.toggleDiff", () => { diffs += 1; });
  useUndoWalk();
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
