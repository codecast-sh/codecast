// What the row verbs' shortcuts (close, stash, pin, defer…) act on. A row's
// hover toolbar advertises its chord, so the chord must act on that row, not
// on the focused card: on 2026-11-23 a hovered child row's ⌃⇧⌫ closed the
// focused lead instead, and ~30 children with it.
//
// Targeting is a mode, set by whichever input came last:
// - "pointer": any real pointer move, anywhere. Row verbs act on the row
//   under the pointer, and on nothing when there is none (the row just
//   closed, the pointer sits between rows or off the list, the list scrolled
//   or re-sorted under it). Never a fallback to the focused card: that is how
//   the lead got closed.
// - "keyboard": any shortcut that is not a row verb (navigation, compose
//   focus, tabs, the palette…), or typing into or clicking into an editable
//   element (composer, search, rename). Row verbs act on the focused card,
//   unless another row shows its hover toolbar: then they act on nothing.
//   Focus the app moves by itself (the composer autofocusing on a
//   conversation switch) does not count: it would flip the mode behind the
//   person's back.
//
// Whatever the mode, a verb acts only on the row showing its toolbar, or on
// the focused card when no other row shows one. A session's open context menu
// outranks both: it advertises the chords for the session it was opened on.
//
// A row is an element carrying data-row-verbs="<session id>": only rows that
// draw the hover toolbar carry it (inbox cards, sub-rows, feed cards, the
// triage bar for the card it acts on). Nothing else is a target: a
// conversation's transcript and header show other objects (completion
// cards, reveals, pills) whose chords must never reach the conversation, so
// pointing there targets nothing. Module
// state, never the store: it changes on pointer moves, and the store must not
// churn with them.

import { useEffect, useRef } from "react";

export type TargetMode = "pointer" | "keyboard";

const ROW = "[data-row-verbs]";
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

let mode: TargetMode = "keyboard";
let hovered: Element | null = null;
// The sessions an open context menu was opened on ([] once a chord acted from
// it), how to dismiss it, the menu's own bulk handlers (so a chord says what
// the item says), and whether the session is a teammate's (whose menu offers
// only verbs that change nothing, like Copy link); null with no menu open.
export type MenuVerb = "stash" | "close";
type MenuHold = {
  ids: string[];
  done: () => void;
  verb: (name: MenuVerb) => ((ids: string[]) => void) | undefined;
  foreign: boolean;
};
let menuTarget: MenuHold | null = null;
let lastX = NaN;
let lastY = NaN;

// Tag and property reads only: this runs on keystrokes, and a typed key must
// not query the DOM (the typing budget).
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerType === "touch") return;
  // Rows sliding under a still pointer (a close collapsing the row, j/k
  // scrolling the list) send moves without the screen position changing;
  // those must not arm the row that slid in.
  if (e.screenX === lastX && e.screenY === lastY) return;
  lastX = e.screenX;
  lastY = e.screenY;
  mode = "pointer";
  hovered = (e.target as Element | null)?.closest?.(ROW) ?? null;
}

function onPointerOut(e: PointerEvent) {
  if (!e.relatedTarget) hovered = null;
}

// A drag carries a row away, and the browser's :hover can stay on it after
// the drop: forget the row until the pointer moves again.
function forgetRow() {
  hovered = null;
}

// A scroll moves rows under a still pointer, and the browser holds the hover
// state until it settles: the row we hold may no longer be under the pointer.
function onScroll(e: Event) {
  const t = e.target as Node | null;
  if (hovered && t && (t === document || t.contains?.(hovered))) hovered = null;
}

// Typing into an editable element (the shortcut dispatcher stops the keys it
// handles, so this sees the typing, not the chord), or clicking into one.
function onKeyDown(e: KeyboardEvent) {
  if (mode === "pointer" && !MODIFIERS.has(e.key) && isEditableTarget(e.target)) mode = "keyboard";
}
function onPointerDown(e: PointerEvent) {
  if (isEditableTarget(e.target)) mode = "keyboard";
}

/** Watch the pointer, scrolling and typing. Returns the teardown. */
export function watchHoverTarget(): () => void {
  if (typeof window === "undefined") return () => {};
  const on: [EventTarget, string, (e: any) => void][] = [
    [document, "pointermove", onPointerMove],
    [document, "pointerout", onPointerOut],
    [document, "scroll", onScroll],
    [document, "pointerdown", onPointerDown],
    [document, "dragstart", forgetRow],
    [document, "pointercancel", forgetRow],
    [window, "keydown", onKeyDown],
  ];
  for (const [t, type, fn] of on) t.addEventListener(type, fn, true);
  return () => {
    for (const [t, type, fn] of on) t.removeEventListener(type, fn, true);
    mode = "keyboard";
    hovered = null;
  };
}

// The shortcuts that act on a row. Every other shortcut pressed is a keyboard
// action and switches to keyboard mode (noteShortcutUsed).
export const ROW_VERB_ACTIONS: ReadonlySet<string> = new Set([
  "session.close", "session.stash", "session.stashHide", "session.deferAdvance",
  "session.dormantAdvance", "session.pin", "session.markUnread", "session.snooze",
  "session.rename", "session.moveToBucket", "conv.favorite", "conv.copyLink",
]);

/** A shortcut's key was pressed and handled (ShortcutProvider). */
export function noteShortcutUsed(action: string): void {
  if (!ROW_VERB_ACTIONS.has(action)) noteKeyboardNavigation();
}

/** A key action moved the view or focus: the focused card is the target. */
export function noteKeyboardNavigation(): void {
  mode = "keyboard";
  hovered = null;
}

export function targetMode(): TargetMode {
  return mode;
}

/** Held by a session context menu while it is open: row verbs act on these
 *  sessions (the menu's own items do), whatever is hovered or focused.
 *  `onDone` runs once a chord has acted from the menu, as an item's own
 *  select would: close the menu, clear a bulk selection. `verbs` are the
 *  menu's own handlers for a selection; `foreign` marks a teammate's session. */
export function useMenuTarget(
  ids: readonly string[],
  onDone?: () => void,
  opts: { verbs?: Partial<Record<MenuVerb, (ids: string[]) => void>>; foreign?: boolean; open?: boolean } = {},
): void {
  const key = ids.join(",");
  const latest = useRef({ onDone, verbs: opts.verbs });
  latest.current = { onDone, verbs: opts.verbs };
  const foreign = !!opts.foreign;
  // A dropdown keeps its content mounted through the close animation: the
  // hold follows its open state, not its mount.
  const open = opts.open ?? true;
  useEffect(() => {
    if (!open) return;
    const held: MenuHold = {
      ids: key ? key.split(",") : [],
      done: () => latest.current.onDone?.(),
      verb: (name) => latest.current.verbs?.[name],
      foreign,
    };
    menuTarget = held;
    return () => { if (menuTarget === held) menuTarget = null; };
  }, [key, foreign, open]);
}

/** The open menu's own handler for a verb on a selection, if it has one. */
export function menuVerb(name: MenuVerb): ((ids: string[]) => void) | undefined {
  return menuTarget?.verb(name);
}

/** useMenuTarget for a menu whose items are not a component of their own
 *  (render it inside the menu's content, with the menu's open state). */
export function MenuTarget({ ids, onDone, foreign, open }: { ids: readonly string[]; onDone?: () => void; foreign?: boolean; open?: boolean }): null {
  useMenuTarget(ids, onDone, { foreign, open });
  return null;
}

/** A row verb acted. From an open menu, the menu is spent: a second press
 *  acts on nothing, and the menu closes. A verb that took the row out of the
 *  list (`removed`) forgets the hovered row, so a second press without a
 *  pointer move acts on nothing. */
export function noteRowVerbActed(removed: boolean): void {
  if (menuTarget) {
    const { done } = menuTarget;
    menuTarget.ids = [];
    menuTarget.done = () => {};
    done();
    return;
  }
  if (removed) hovered = null;
}

/** The sessions a row verb acts on, given `focused`, the card the surface
 *  acts on when nothing else claims the key: an open menu's sessions; in
 *  pointer mode the row under the pointer; in keyboard mode the focused card,
 *  unless another row shows its toolbar. Empty means do nothing; when the
 *  rule itself is why (no row under the pointer, another row's toolbar
 *  showing), a hint says how to choose one. `foreignOk`: the verb changes
 *  nothing (Copy link), so a teammate's menu offers it too. */
export function rowVerbIds(focused: string | null | undefined, { foreignOk = false } = {}): string[] {
  if (menuTarget) return menuTarget.foreign && !foreignOk ? [] : menuTarget.ids;
  if (mode === "pointer") {
    const id = hoverTargetId();
    if (!id) hintNoTarget();
    return id ? [id] : [];
  }
  const shown = visiblyHoveredRowId();
  if (shown && shown !== focused) {
    hintNoTarget();
    return [];
  }
  return focused ? [focused] : [];
}

// A key that does nothing feels broken: say once in a while how to aim it.
// Loaded on demand (it draws key caps from the components layer).
const HINT_EVERY_MS = 4000;
let lastHint = -Infinity;
function hintNoTarget(): void {
  const now = Date.now();
  if (now - lastHint < HINT_EVERY_MS) return;
  lastHint = now;
  void import("./rowVerbHint").then((m) => m.showRowVerbHint());
}
export function _resetRowVerbHintForTests(): void {
  lastHint = -Infinity;
}

/** The row the browser shows as hovered (its toolbar is drawn), whatever
 *  the mode; the innermost when rows nest. Queried only when a row verb's key
 *  is pressed, never on typing. */
function visiblyHoveredRowId(): string | null {
  if (typeof document === "undefined") return null;
  const rows = document.querySelectorAll(`${ROW}:hover`);
  return rows.length ? rows[rows.length - 1]!.getAttribute("data-row-verbs") : null;
}

/** The session id of the row under the pointer, or null. The row must still
 *  be on the page and still be what the browser shows as hovered (the toolbar
 *  draws on :hover): a list re-sorted under a still pointer moves the hover to
 *  another row without a pointer move, and then this row is no target. */
export function hoverTargetId(): string | null {
  if (!hovered?.isConnected || !hovered.matches(":hover")) return null;
  return hovered.getAttribute("data-row-verbs");
}
