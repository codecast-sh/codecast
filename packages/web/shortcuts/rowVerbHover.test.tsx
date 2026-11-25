import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

// 2026-11-23: a hovered child row's Close tooltip advertised ⌃⇧⌫, the user
// pressed it, and the focused lead closed instead (with ~30 children). Row
// verbs now follow the last input: after a pointer move over a row they act on
// the hovered row or on nothing, never the focused card; after another
// shortcut or typing they act on the focused card. Either way a verb never acts
// on one row while another shows its hover toolbar.

const dom = new JSDOM(`<!doctype html><div id="root"></div>
<div id="list">
  <div data-row-verbs="lead"><span id="lead-title">Infrastructure lead</span>
    <div data-row-verbs="child"><button id="child-close">x</button></div>
  </div>
  <div id="gap">between rows</div>
  <div data-row-verbs="other"><span id="other-title">Other</span></div>
  <div data-session-id="decision"><span id="decision-title">A decision row draws no toolbar</span></div>
</div>
<div id="transcript">a conversation</div>
<main data-cc-conversation>
  <header><span id="pane-title">the conversation's title row</span></header>
  <div data-sv-feed>
    <p id="pane-body">the open conversation's transcript</p>
    <div role="link" tabindex="0"><span id="notif-card">a child's completion card (TaskNotificationLine)</span></div>
    <button><span id="sender-badge">a sender badge</span></button>
  </div>
</main>
<div id="outside">elsewhere</div>
<textarea id="composer"></textarea>`, { url: "https://local.codecast.sh/inbox" });
const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "IS_REACT_ACT_ENVIRONMENT"];
const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
for (const k of keys) {
  Object.defineProperty(globalThis, k, { value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[k], configurable: true, writable: true });
}

const calls: string[] = [];
const realTriage = { ...(await import("../components/triage/useTriageActions")) };
const stubTriage = {
  hide: (id: string, mode: string, _s?: string, _o?: unknown, advance = true) => { calls.push(`${mode}:${id}:${advance}`); },
  park: (id: string, verb: string, _s?: string, advance = true) => { calls.push(`${verb}:${id}:${advance}`); },
  pin: (id: string) => { calls.push(`pin:${id}`); },
  label: (id: string) => { calls.push(`label:${id}`); },
  closeOverlayIfCurrent: () => false,
};
mock.module("../components/triage/useTriageActions", () => ({ ...realTriage, useTriageActions: () => stubTriage }));
let pathname = "/inbox";
// The no-target hint is a toast; record it, keep the rest of sonner.
const hints: unknown[] = [];
const realSonner = { ...(await import("sonner")) };
const recordingToast = Object.assign((message: unknown, opts?: { id?: string }) => {
  if (opts?.id === "row-verb-hint") hints.push(message);
  return "";
}, realSonner.toast);
mock.module("sonner", () => ({ ...realSonner, toast: recordingToast }));
mock.module("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => ({ get: () => null }),
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ShortcutProvider, useShortcuts } = await import("./ShortcutProvider");
const { useGlobalShortcutActions } = await import("./actions");
const { MenuTarget, ROW_VERB_ACTIONS, _resetRowVerbHintForTests, hoverTargetId, noteKeyboardNavigation, rowVerbIds, targetMode, useMenuTarget } = await import("../lib/hoverTarget");
const { _resetUndoStacks, getUndoHistory } = await import("@platform/engine");
const { performUndo } = await import("../store/undoStack");
const { useInboxStore } = await import("../store/inboxStore");
const { declareViewNav } = await import("../store/viewNav");

let dispatch!: ReturnType<typeof useShortcuts>["dispatchAction"];
function Host() {
  useGlobalShortcutActions();
  dispatch = useShortcuts().dispatchAction;
  return null;
}
const root = createRoot(document.getElementById("root")!);
await act(async () => { root.render(<MemoryRouter initialEntries={["/inbox"]}><ShortcutProvider><Host /></ShortcutProvider></MemoryRouter>); });

// jsdom keeps no hover state: the element under the pointer stands in for the
// browser's :hover (which is what draws a row's toolbar).
let underPointer: Element | null = null;
const realMatches = dom.window.Element.prototype.matches;
dom.window.Element.prototype.matches = function (this: Element, selector: string) {
  if (selector === ":hover") return !!underPointer && this.contains(underPointer);
  return realMatches.call(this, selector);
};
const realQueryAll = dom.window.Document.prototype.querySelectorAll;
dom.window.Document.prototype.querySelectorAll = function (this: Document, selector: string) {
  if (!selector.endsWith(":hover")) return realQueryAll.call(this, selector);
  return [...realQueryAll.call(this, selector.slice(0, -":hover".length))].filter((el) => el.matches(":hover")) as any;
};

// A real key press, through the shortcut dispatcher.
function press(key: string, code: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
  document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));
}
const pressNext = () => press("j", "KeyJ", { ctrlKey: true });
const pressClose = () => press("Backspace", "Backspace", { ctrlKey: true, shiftKey: true });

let x = 0;
function moveOver(id: string) {
  x += 1;
  underPointer = document.getElementById(id)!;
  underPointer.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, screenX: x, screenY: 1 }));
}
// Content moves under a still pointer: the hover moves, the screen position
// does not.
function slideUnder(id: string) {
  underPointer = document.getElementById(id)!;
  underPointer.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, screenX: x, screenY: 1 }));
}

// The view-motion guard reverts an undeclared write to currentSessionId.
function focusLead() {
  declareViewNav("gesture");
  useInboxStore.setState({ currentSessionId: "lead" } as any);
}

beforeEach(() => {
  calls.length = 0;
  moveOver("outside");
  noteKeyboardNavigation();
  focusLead();
});

afterAll(async () => {
  await act(async () => { root.unmount(); });
  closeDomWindow(dom);
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});

test("hovering a child row then session.close closes the child only", () => {
  moveOver("child-close");
  expect(hoverTargetId()).toBe("child");
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
});

test("the innermost row wins: hovering the lead's own area targets the lead", () => {
  moveOver("lead-title");
  dispatch("session.stash");
  expect(calls).toEqual(["stash:lead:true"]);
});

test("every row verb follows the hover", () => {
  // A verb that takes the row out forgets it, so each press follows a move.
  for (const a of ["session.stash", "session.stashHide", "session.deferAdvance", "session.dormantAdvance", "session.pin", "session.moveToBucket"]) {
    moveOver("child-close");
    dispatch(a);
  }
  expect(calls).toEqual(["stash:child:false", "stash:child:false", "defer:child:false", "dormant:child:false", "pin:child", "label:child"]);
});

test("keyboard navigation after hover targets the focused card once the pointer is off the rows", () => {
  moveOver("child-close");
  pressNext();
  focusLead();
  expect(targetMode()).toBe("keyboard");
  slideUnder("outside");
  pressClose();
  expect(calls).toEqual(["close:lead:true"]);
});

test("keyboard navigation with the pointer still on another row's toolbar: the chord does nothing", () => {
  moveOver("child-close");
  pressNext();
  focusLead();
  expect(targetMode()).toBe("keyboard");
  pressClose();
  expect(calls).toEqual([]);
});

test("keyboard mode with the pointer resting on the focused card itself closes it", () => {
  moveOver("lead-title");
  pressNext();
  focusLead();
  pressClose();
  expect(calls).toEqual(["close:lead:true"]);
});

test("a hovered child closed, a second press without moving the pointer closes nothing", () => {
  moveOver("child-close");
  dispatch("session.close");
  // The close collapses the row; the next row slides under the still pointer.
  const child = document.querySelector('[data-row-verbs="child"]')!;
  const parent = child.parentElement!;
  child.remove();
  slideUnder("lead-title");
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
  expect(calls).not.toContain("close:lead:true");
  parent.appendChild(child);
});

test("a second press is a no-op even when the closed row is still on the page", () => {
  moveOver("child-close");
  dispatch("session.close");
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
});

test("a pointer event without movement does not arm a row", () => {
  moveOver("child-close");
  press("k", "KeyK", { ctrlKey: true });
  slideUnder("child-close");
  expect(targetMode()).toBe("keyboard");
  moveOver("child-close");
  expect(targetMode()).toBe("pointer");
  expect(hoverTargetId()).toBe("child");
});

test("pointer between rows: row verbs do nothing", () => {
  moveOver("child-close");
  moveOver("gap");
  for (const a of ["session.close", "session.stash", "session.deferAdvance", "session.pin"]) dispatch(a);
  expect(calls).toEqual([]);
});

test("pointer out of the window: row verbs do nothing", () => {
  moveOver("child-close");
  document.getElementById("child-close")!.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: null }));
  dispatch("session.close");
  expect(calls).toEqual([]);
});

test("typing in a textarea switches to keyboard mode: with the pointer off the rows the chord closes the focused card", () => {
  moveOver("child-close");
  document.getElementById("composer")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  expect(targetMode()).toBe("keyboard");
  slideUnder("outside");
  pressClose();
  expect(calls).toEqual(["close:lead:true"]);
});

// The incident again, through the composer: click the lead, nudge the pointer
// onto a child (its toolbar shows), type a reply and send it, then press the
// chord in the empty composer. Keyboard mode, but the child advertises the
// chord: closing the lead under it is exactly what must not happen.
test("a reply typed while a child shows its toolbar, then the chord: nothing closes", () => {
  moveOver("lead-title");
  moveOver("child-close");
  const composer = document.getElementById("composer") as HTMLTextAreaElement;
  composer.focus();
  for (const key of ["o", "k", "Enter"]) composer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
  expect(targetMode()).toBe("keyboard");
  const chord = () => composer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  chord();
  expect(calls).toEqual([]);
  // The same press with the pointer off the rows reaches the focused card, as
  // before this change: the chord did fire above, and chose nothing.
  slideUnder("outside");
  chord();
  expect(calls).toEqual(["close:lead:true"]);
  composer.blur();
});

test("a modifier alone in a textarea does not switch modes", () => {
  moveOver("child-close");
  document.getElementById("composer")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Control", bubbles: true }));
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
});

test("before any pointer move, row verbs act on the focused card", () => {
  dispatch("session.close");
  expect(calls).toEqual(["close:lead:true"]);
});

test("a list re-sorted under a still pointer: the chord acts on nothing, not the row that moved away", () => {
  moveOver("child-close");
  slideUnder("other-title");
  dispatch("session.close");
  expect(calls).toEqual([]);
});

test("scrolling the list under the pointer drops the hovered row", () => {
  moveOver("child-close");
  document.getElementById("list")!.dispatchEvent(new dom.window.Event("scroll"));
  dispatch("session.close");
  expect(calls).toEqual([]);
});

test("a scroll elsewhere (the transcript streaming) keeps the hovered row", () => {
  moveOver("child-close");
  document.getElementById("transcript")!.dispatchEvent(new dom.window.Event("scroll"));
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
});

test("a row without a hover toolbar never arms: pointer mode with nothing to act on", () => {
  moveOver("child-close");
  moveOver("decision-title");
  dispatch("session.close");
  expect(calls).toEqual([]);
});

test("clicking into the composer switches to keyboard mode", () => {
  moveOver("child-close");
  moveOver("composer");
  document.getElementById("composer")!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  expect(targetMode()).toBe("keyboard");
  pressClose();
  expect(calls).toEqual(["close:lead:true"]);
});

// The composer autofocuses on every conversation switch. That focus is the
// app's, not the person's, so it must not flip the mode.
test("the hovered focused card closes, the view moves on and the composer autofocuses: a second press does nothing", () => {
  moveOver("lead-title");
  dispatch("session.close");
  expect(calls).toEqual(["close:lead:true"]);
  declareViewNav("gesture");
  useInboxStore.setState({ currentSessionId: "other" } as any);
  (document.getElementById("composer") as HTMLTextAreaElement).focus();
  dispatch("session.close");
  expect(calls).toEqual(["close:lead:true"]);
  (document.getElementById("composer") as HTMLTextAreaElement).blur();
});

test("a late autofocus after hovering a child still targets the child", () => {
  moveOver("child-close");
  (document.getElementById("composer") as HTMLTextAreaElement).focus();
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
  (document.getElementById("composer") as HTMLTextAreaElement).blur();
});

test("any other shortcut pressed switches to keyboard mode; a row verb's press does not", () => {
  moveOver("child-close");
  pressClose();
  expect(targetMode()).toBe("pointer");
  press("i", "KeyI", { ctrlKey: true }); // session.jumpIdle
  expect(targetMode()).toBe("keyboard");
});

test("typing in pointer mode outside an editable element keeps pointer mode", () => {
  moveOver("child-close");
  document.getElementById("outside")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  dispatch("session.close");
  expect(calls).toEqual(["close:child:false"]);
});

// Snooze on a conversation page used to fall back to the page's conversation
// even while another row showed its toolbar.
test("snooze on a conversation page with another row's toolbar showing opens nothing", async () => {
  const opened: string[][] = [];
  const real = useInboxStore.getState().openPalette;
  pathname = "/conversation/lead";
  useInboxStore.setState({
    currentUser: { _id: "me" },
    sessions: { lead: { _id: "lead", user_id: "me" }, child: { _id: "child", user_id: "me" } },
    openPalette: (opts: any) => { opened.push(opts.targets.map((t: any) => t._id)); },
  } as any);
  await act(async () => { root.render(<MemoryRouter initialEntries={["/conversation/lead"]}><ShortcutProvider><Host /></ShortcutProvider></MemoryRouter>); });
  try {
    moveOver("child-close");
    document.getElementById("composer")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    dispatch("session.snooze");
    expect(opened).toEqual([]);
    slideUnder("outside");
    dispatch("session.snooze");
    expect(opened).toEqual([["lead"]]);
    moveOver("child-close");
    dispatch("session.snooze");
    expect(opened).toEqual([["lead"], ["child"]]);
  } finally {
    pathname = "/inbox";
    useInboxStore.setState({ openPalette: real } as any);
    await act(async () => { root.render(<MemoryRouter initialEntries={["/inbox"]}><ShortcutProvider><Host /></ShortcutProvider></MemoryRouter>); });
  }
});

// A context menu advertises the chords for the session it was opened on, and
// its backdrop takes the hover away from the row.
// `dismissed` counts the menu's onDone (close it, clear a bulk selection).
let dismissed = 0;
type MenuOpts = Parameters<typeof useMenuTarget>[2];
function Menu({ ids, opts }: { ids: string[]; opts?: MenuOpts }) {
  useMenuTarget(ids, () => { dismissed += 1; }, opts);
  return null;
}
const menuRoot = createRoot(document.createElement("div"));
const openMenu = (ids: string[], opts?: MenuOpts) => act(async () => { dismissed = 0; menuRoot.render(<Menu ids={ids} opts={opts} />); });
const closeMenu = () => act(async () => { menuRoot.render(null); });

test("while a session's menu is open, the chord acts on that session and dismisses the menu; a second press does nothing", async () => {
  moveOver("outside");
  noteKeyboardNavigation();
  await openMenu(["other"]);
  pressClose();
  expect(calls).toEqual(["close:other:false"]);
  expect(dismissed).toBe(1);
  // Still mounted (the close has not rendered yet): the menu is spent.
  pressClose();
  dispatch("session.pin");
  expect(calls).toEqual(["close:other:false"]);
  expect(dismissed).toBe(1);
  await closeMenu();
  pressClose();
  expect(calls).toEqual(["close:other:false", "close:lead:true"]);
});

test("the menu outranks the hovered row", async () => {
  moveOver("child-close");
  await openMenu(["other"]);
  dispatch("session.stash");
  expect(calls).toEqual(["stash:other:false"]);
  await closeMenu();
});

test("a bulk menu: the chord closes the whole selection as one gesture, ⌘Z restores all; single-session verbs do nothing", async () => {
  const ids = ["a", "b", "c"].map((c) => c.repeat(32));
  const owner = Symbol("bulk-close");
  const real = useInboxStore.getState();
  const rows = Object.fromEntries(ids.map((id) => [id, { _id: id, session_id: `s-${id}`, title: id[0], agent_type: "claude_code", message_count: 8, agent_status: "idle", updated_at: Date.now() - 3_600_000 }]));
  useInboxStore.setState({ sessions: rows, conversations: rows, pending: {} } as any);
  real._setDispatch(async () => null, { owner });
  _resetUndoStacks();
  try {
    await openMenu(ids);
    dispatch("session.moveToBucket");
    expect(calls).toEqual([]);
    expect(dismissed).toBe(0);
    pressClose();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]); // not the per-row triage verb
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Closed 3 sessions"]);
    expect(dismissed).toBe(1);
    pressClose();
    await new Promise((r) => setTimeout(r, 20));
    expect(getUndoHistory().items).toHaveLength(1);
    expect(performUndo()).toBe(true);
    for (const id of ids) expect((useInboxStore.getState().sessions[id] as any).inbox_dismissed_at ?? null).toBeNull();
  } finally {
    await closeMenu();
    real._clearDispatch(owner);
  }
});

test("the header's session menu holds rename for its conversation, and closes on the chord", async () => {
  const renamed: string[] = [];
  const real = useInboxStore.getState().openSessionRename;
  useInboxStore.setState({ sessions: { child: { _id: "child", user_id: "me" } }, openSessionRename: (session: any) => { renamed.push(session._id); } } as any);
  let closed = 0;
  const host = createRoot(document.createElement("div"));
  await act(async () => { host.render(<MenuTarget ids={["child"]} onDone={() => { closed += 1; }} />); });
  try {
    moveOver("gap");
    dispatch("session.rename");
    expect(renamed).toEqual(["child"]);
    expect(closed).toBe(1);
  } finally {
    await act(async () => { host.unmount(); });
    useInboxStore.setState({ openSessionRename: real } as any);
  }
});

test("a teammate's session menu: triage chords do nothing, Copy link's chord targets that session", async () => {
  await openMenu(["theirs"], { foreign: true });
  pressClose();
  expect(calls).toEqual([]);
  expect(ROW_VERB_ACTIONS.has("conv.copyLink")).toBe(true);
  expect(rowVerbIds("lead")).toEqual([]);
  expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["theirs"]);
  await closeMenu();
});

// The star on a row advertises conv.favorite; the conversation view's handler
// asks rowVerbIds with its own conversation as the fallback.
test("conv.favorite follows the row rule", () => {
  expect(ROW_VERB_ACTIONS.has("conv.favorite")).toBe(true);
  expect(rowVerbIds("lead")).toEqual(["lead"]);
  moveOver("child-close");
  expect(rowVerbIds("lead")).toEqual(["child"]);
  moveOver("gap");
  expect(rowVerbIds("lead")).toEqual([]);
});

// The triage bar advertises the chords for the card it acts on.
test("the triage bar arms its card: hovering its Close then the chord closes that card", async () => {
  const { TriageBar } = await import("../components/triage/TriageBar");
  useInboxStore.setState({ sessions: { lead: { _id: "lead", user_id: "me" } } } as any);
  // One provider owns the page's key slot, so the bar mounts beside the
  // shortcut actions under it.
  const host = document.getElementById("root")!;
  await act(async () => { root.render(<MemoryRouter initialEntries={["/inbox"]}><ShortcutProvider><Host /><TriageBar /></ShortcutProvider></MemoryRouter>); });
  try {
    const bar = host.querySelector("[data-triage-bar]")!;
    expect(bar.getAttribute("data-row-verbs")).toBe("lead");
    const close = host.querySelector('[data-triage-verb="close"]')!;
    x += 1;
    underPointer = close;
    close.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, screenX: x, screenY: 1 }));
    pressClose();
    expect(calls).toEqual(["close:lead:true"]);
  } finally {
    await act(async () => { root.render(<MemoryRouter initialEntries={["/inbox"]}><ShortcutProvider><Host /></ShortcutProvider></MemoryRouter>); });
  }
});

test("conv.copyLink follows the row rule: a hovered row's link, not the open conversation's", () => {
  moveOver("child-close");
  expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["child"]);
  moveOver("outside");
  noteKeyboardNavigation();
  expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["lead"]);
});

test("a bulk menu's stash chord goes through the menu's own handler (its notices included)", async () => {
  const stashed: string[][] = [];
  await openMenu(["child", "other"], { verbs: { stash: (ids) => { stashed.push(ids); } } });
  dispatch("session.stash");
  expect(stashed).toEqual([["child", "other"]]);
  expect(calls).toEqual([]);
  expect(dismissed).toBe(1);
  await closeMenu();
});

const tick = () => new Promise((r) => setTimeout(r, 20));

test("a row verb with no target shows a hint, once in a while", async () => {
  _resetRowVerbHintForTests();
  hints.length = 0;
  moveOver("child-close");
  moveOver("gap");
  pressClose();
  await tick();
  expect(hints).toHaveLength(1);
  pressClose();
  dispatch("session.pin");
  await tick();
  expect(hints).toHaveLength(1);
  expect(calls).toEqual([]);
});

test("blocked by another row's toolbar in keyboard mode: the hint shows", async () => {
  _resetRowVerbHintForTests();
  hints.length = 0;
  moveOver("child-close");
  pressNext();
  focusLead();
  pressClose();
  await tick();
  expect(hints).toHaveLength(1);
});

test("never a hint when the verb has a target", async () => {
  _resetRowVerbHintForTests();
  hints.length = 0;
  moveOver("child-close");
  pressClose();
  moveOver("outside");
  noteKeyboardNavigation();
  pressClose();
  await tick();
  expect(calls).toEqual(["close:child:false", "close:lead:true"]);
  expect(hints).toHaveLength(0);
});

// The conversation view is not a target: its transcript and header show other
// objects (a child's completion card, a sender badge, reveals, pills), and a
// chord over any of them must never reach the conversation, least of all a
// lead. Pointing there targets nothing and says how to aim.
test("pointer over the transcript, a completion card or a sender badge: nothing closes, the hint shows", async () => {
  for (const spot of ["pane-body", "notif-card", "sender-badge", "pane-title"]) {
    _resetRowVerbHintForTests();
    hints.length = 0;
    moveOver(spot);
    pressClose();
    await tick();
    expect(calls).toEqual([]);
    expect(hints).toHaveLength(1);
  }
  // conv.favorite and conv.copyLink ask the same rule with the open
  // conversation as their fallback: over the transcript they act on nothing.
  expect(rowVerbIds("lead")).toEqual([]);
  expect(rowVerbIds("lead", { foreignOk: true })).toEqual([]);
});

test("any real mouse move after keyboard navigation switches to pointer mode", () => {
  moveOver("child-close");
  pressNext();
  expect(targetMode()).toBe("keyboard");
  moveOver("outside");
  expect(targetMode()).toBe("pointer");
  focusLead();
  pressClose();
  expect(calls).toEqual([]);
});

test("the header menu for a teammate's conversation: copy link targets it, nothing else does", async () => {
  const host = createRoot(document.createElement("div"));
  await act(async () => { host.render(<MenuTarget ids={["theirs"]} foreign />); });
  try {
    moveOver("pane-body");
    pressClose();
    dispatch("session.pin");
    expect(calls).toEqual([]);
    expect(rowVerbIds("lead")).toEqual([]);
    expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["theirs"]);
  } finally {
    await act(async () => { host.unmount(); });
  }
});

// A dropdown's content outlives its close by the exit animation.
test("a menu held by its open state lets go the moment it closes, while still mounted", async () => {
  const host = createRoot(document.createElement("div"));
  const render = (open: boolean) => act(async () => { host.render(<MenuTarget ids={["other"]} open={open} />); });
  try {
    await render(true);
    slideUnder("outside");
    expect(rowVerbIds("lead")).toEqual(["other"]);
    await render(false);
    expect(rowVerbIds("lead")).toEqual(["lead"]);
  } finally {
    await act(async () => { host.unmount(); });
  }
});

test("a drag forgets the row, so a stale hover after the drop arms nothing", () => {
  for (const type of ["dragstart", "pointercancel"]) {
    moveOver("child-close");
    expect(hoverTargetId()).toBe("child");
    document.getElementById("child-close")!.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    expect(hoverTargetId()).toBeNull();
    pressClose();
    expect(calls).toEqual([]);
  }
});
