import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

// 2026-11-23: a hovered child row's Close tooltip advertised ⌃⇧⌫, the user
// pressed it, and the focused lead closed instead (with ~30 children). A row
// verb now acts on an open menu's session, else the row the pointer moved onto,
// else nothing while another row shows its toolbar, else the focused card
// (lib/hoverTarget).

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
const { MenuTarget, _resetRowVerbHintForTests, hoverTargetId, rowVerbIds, useMenuTarget } = await import("../lib/hoverTarget");
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

const tick = () => new Promise((r) => setTimeout(r, 20));

test("hovering a child row then session.close closes the child only", () => {
  moveOver("child-close");
  expect(hoverTargetId()).toBe("child");
  pressClose();
  expect(calls).toEqual(["close:child:false"]);
});

test("the innermost row wins: hovering the lead's own area targets the lead", () => {
  moveOver("lead-title");
  dispatch("session.stash");
  expect(calls).toEqual(["stash:lead:true"]);
});

test("every row verb follows the armed row", () => {
  for (const a of ["session.stash", "session.stashHide", "session.deferAdvance", "session.dormantAdvance", "session.pin", "session.moveToBucket"]) {
    moveOver("child-close");
    dispatch(a);
  }
  expect(calls).toEqual(["stash:child:false", "stash:child:false", "defer:child:false", "dormant:child:false", "pin:child", "label:child"]);
});

// (a) The incident: a child closes, the next row slides under the still pointer
// and shows its toolbar. It is not the focused card, so the key does nothing:
// the lead never closes.
test("(a) a hovered child closes; the row that slides under the still pointer is not armed and the lead never closes", async () => {
  _resetRowVerbHintForTests();
  hints.length = 0;
  moveOver("child-close");
  pressClose();
  expect(calls).toEqual(["close:child:false"]);
  slideUnder("other-title");
  pressClose();
  await tick();
  expect(calls).toEqual(["close:child:false"]);
  expect(calls).not.toContain("close:lead:true");
  expect(hints).toHaveLength(1);
});

// (b) The triage loop: click a card, close it, focus advances to the next card,
// which slides under the pointer; it is both focused and shown, so the next
// press closes it.
test("(b) click a card and press twice: it closes, then the next card focus moved to", () => {
  moveOver("lead-title");
  pressClose();
  expect(calls).toEqual(["close:lead:true"]);
  declareViewNav("gesture");
  useInboxStore.setState({ currentSessionId: "other" } as any);
  slideUnder("other-title");
  pressClose();
  expect(calls).toEqual(["close:lead:true", "close:other:true"]);
});

// (c) With no row under the pointer the key goes where it always went: the
// viewed conversation. The transcript, its completion cards and sender badges,
// the header, the gap between rows: none is a row.
test("(c) pointer over the transcript, a completion card, a sender badge, the header or between rows: closes the viewed conversation", async () => {
  _resetRowVerbHintForTests();
  hints.length = 0;
  for (const spot of ["pane-body", "notif-card", "sender-badge", "pane-title", "gap", "decision-title"]) {
    moveOver(spot);
    pressClose();
  }
  await tick();
  expect(calls).toEqual(Array(6).fill("close:lead:true"));
  expect(hints).toHaveLength(0);
});

// (d) Typing does not move the target: the armed row is what is advertised.
test("(d) typing in the composer with an armed child: the chord acts on the child, never the lead", () => {
  moveOver("child-close");
  const composer = document.getElementById("composer") as HTMLTextAreaElement;
  composer.focus();
  for (const key of ["o", "k", "Enter"]) composer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
  composer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  expect(calls).toEqual(["close:child:false"]);
  composer.blur();
});

test("keyboard navigation does not disarm the row showing its toolbar", () => {
  moveOver("child-close");
  pressNext();
  focusLead();
  pressClose();
  expect(calls).toEqual(["close:child:false"]);
});

test("a pointer event without movement does not arm a row", () => {
  slideUnder("child-close");
  expect(hoverTargetId()).toBeNull();
  moveOver("child-close");
  expect(hoverTargetId()).toBe("child");
});

test("a list re-sorted under a still pointer: nothing, not the row that moved away nor the lead", () => {
  moveOver("child-close");
  slideUnder("other-title");
  pressClose();
  expect(calls).toEqual([]);
});

test("scrolling the list under the pointer disarms the row; while it still shows its toolbar, nothing", () => {
  moveOver("child-close");
  document.getElementById("list")!.dispatchEvent(new dom.window.Event("scroll"));
  expect(hoverTargetId()).toBeNull();
  pressClose();
  expect(calls).toEqual([]);
});

test("a scroll elsewhere (the transcript streaming) keeps the armed row", () => {
  moveOver("child-close");
  document.getElementById("transcript")!.dispatchEvent(new dom.window.Event("scroll"));
  pressClose();
  expect(calls).toEqual(["close:child:false"]);
});

test("pointer out of the window: back to the focused card", () => {
  moveOver("child-close");
  document.getElementById("child-close")!.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: null }));
  underPointer = null;
  pressClose();
  expect(calls).toEqual(["close:lead:true"]);
});

test("a drag disarms the row, so a stale hover after the drop arms nothing", () => {
  for (const type of ["dragstart", "pointercancel"]) {
    moveOver("child-close");
    document.getElementById("child-close")!.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    expect(hoverTargetId()).toBeNull();
    pressClose();
    expect(calls).toEqual([]);
  }
});

test("snooze follows the rule; on a conversation page the page's conversation is the focused card", async () => {
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
    slideUnder("child-close");
    dispatch("session.snooze");
    expect(opened).toEqual([]);
    moveOver("pane-body");
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

// A context menu advertises the chords for the session it was opened on.
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

test("the menu outranks the armed row", async () => {
  moveOver("child-close");
  await openMenu(["other"]);
  dispatch("session.stash");
  expect(calls).toEqual(["stash:other:false"]);
  await closeMenu();
});

test("a menu held by its open state lets go the moment it closes, while still mounted", async () => {
  const host = createRoot(document.createElement("div"));
  const render = (open: boolean) => act(async () => { host.render(<MenuTarget ids={["other"]} open={open} />); });
  try {
    await render(true);
    expect(rowVerbIds("lead")).toEqual(["other"]);
    await render(false);
    expect(rowVerbIds("lead")).toEqual(["lead"]);
  } finally {
    await act(async () => { host.unmount(); });
  }
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
    await tick();
    expect(calls).toEqual([]); // not the per-row triage verb
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Closed 3 sessions"]);
    expect(dismissed).toBe(1);
    pressClose();
    await tick();
    expect(getUndoHistory().items).toHaveLength(1);
    expect(performUndo()).toBe(true);
    for (const id of ids) expect((useInboxStore.getState().sessions[id] as any).inbox_dismissed_at ?? null).toBeNull();
  } finally {
    await closeMenu();
    real._clearDispatch(owner);
  }
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

test("the header's session menu holds rename for its conversation, and closes on the chord", async () => {
  const renamed: string[] = [];
  const real = useInboxStore.getState().openSessionRename;
  useInboxStore.setState({ sessions: { child: { _id: "child", user_id: "me" } }, openSessionRename: (session: any) => { renamed.push(session._id); } } as any);
  let closed = 0;
  const host = createRoot(document.createElement("div"));
  await act(async () => { host.render(<MenuTarget ids={["child"]} onDone={() => { closed += 1; }} />); });
  try {
    dispatch("session.rename");
    expect(renamed).toEqual(["child"]);
    expect(closed).toBe(1);
  } finally {
    await act(async () => { host.unmount(); });
    useInboxStore.setState({ openSessionRename: real } as any);
  }
});

test("a teammate's menu (a row's, or the header's): triage chords do nothing, copy link targets that session", async () => {
  await openMenu(["theirs"], { foreign: true });
  pressClose();
  dispatch("session.pin");
  expect(calls).toEqual([]);
  expect(rowVerbIds("lead")).toEqual([]);
  expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["theirs"]);
  await closeMenu();
  const host = createRoot(document.createElement("div"));
  await act(async () => { host.render(<MenuTarget ids={["theirs"]} foreign />); });
  try {
    expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["theirs"]);
    expect(rowVerbIds("lead")).toEqual([]);
  } finally {
    await act(async () => { host.unmount(); });
  }
});

// conv.favorite and conv.copyLink (a row's star, a menu's Copy link) ask the
// same rule with the open conversation as the focused card.
test("favorite and copy link follow the rule", () => {
  expect(rowVerbIds("lead")).toEqual(["lead"]);
  moveOver("child-close");
  expect(rowVerbIds("lead", { foreignOk: true })).toEqual(["child"]);
  moveOver("pane-body");
  expect(rowVerbIds("lead")).toEqual(["lead"]);
  slideUnder("other-title");
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

test("the hint shows only when another row's toolbar blocks the key, once in a while; never with a target", async () => {
  _resetRowVerbHintForTests();
  hints.length = 0;
  moveOver("child-close");
  pressClose();
  moveOver("pane-body");
  pressClose();
  await tick();
  expect(hints).toHaveLength(0);
  slideUnder("other-title");
  pressClose();
  dispatch("session.pin");
  await tick();
  expect(hints).toHaveLength(1);
  expect(calls).toEqual(["close:child:false", "close:lead:true"]);
});
