// What the row verbs' shortcuts (close, stash, pin, defer…) act on. A row's
// hover toolbar advertises its chord, so the chord must act on that row, not
// on the focused card: on 2026-11-23 a hovered child row's ⌃⇧⌫ closed the
// focused lead instead, and ~30 children with it.
//
// The rule, in order:
// 1. An open session menu's sessions: the menu advertises the chords.
// 2. The armed row: a row the pointer really moved onto (the screen position
//    changed), still under it. Scrolling, a drag or a cancelled pointer
//    disarms it; a row that slides under a still pointer never arms.
// 3. Nothing, when another row shows its toolbar (:hover) and is not the
//    focused card: the key must not act behind the row advertising it.
// 4. The focused card, as before: the pointer over the transcript, between
//    rows or off the list leaves the chord where it always went.
//
// A row is an element carrying data-row-verbs="<session id>": only rows that
// draw the hover toolbar carry it (inbox cards, sub-rows, feed cards, the
// triage bar for the card it acts on). Module state, never the store: it
// changes on pointer moves, and the store must not churn with them.

import { useRef } from "react";
import { toast } from "sonner";
import { useWatchEffect } from "../hooks/useWatchEffect";

const ROW = "[data-row-verbs]";

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

function onPointerMove(e: PointerEvent) {
  if (e.pointerType === "touch") return;
  // Rows sliding under a still pointer (a close collapsing the row, j/k
  // scrolling the list) send moves without the screen position changing;
  // those must not arm the row that slid in.
  if (e.screenX === lastX && e.screenY === lastY) return;
  lastX = e.screenX;
  lastY = e.screenY;
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

/** Watch the pointer and scrolling. Returns the teardown. */
export function watchHoverTarget(): () => void {
  if (typeof document === "undefined") return () => {};
  const on: [string, (e: any) => void][] = [
    ["pointermove", onPointerMove],
    ["pointerout", onPointerOut],
    ["scroll", onScroll],
    ["dragstart", forgetRow],
    ["pointercancel", forgetRow],
  ];
  for (const [type, fn] of on) document.addEventListener(type, fn, true);
  return () => {
    for (const [type, fn] of on) document.removeEventListener(type, fn, true);
    hovered = null;
  };
}

/** Held by a session context menu while it is open: row verbs act on these
 *  sessions (the menu's own items do), whatever is hovered or focused.
 *  `onDone` runs once a chord has acted from the menu, as an item's own
 *  select would: close the menu, clear a bulk selection. `verbs` are the
 *  menu's own handlers for a selection; `foreign` marks a teammate's session;
 *  `open` is a dropdown's open state (its content outlives the close by the
 *  exit animation, so the hold follows the state, not the mount). */
export function useMenuTarget(
  ids: readonly string[],
  onDone?: () => void,
  opts: { verbs?: Partial<Record<MenuVerb, (ids: string[]) => void>>; foreign?: boolean; open?: boolean } = {},
): void {
  const key = ids.join(",");
  const latest = useRef({ onDone, verbs: opts.verbs });
  latest.current = { onDone, verbs: opts.verbs };
  const foreign = !!opts.foreign;
  const open = opts.open ?? true;
  useWatchEffect(() => {
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

/** A row verb acted. From an open menu, the menu is spent and closes, as its
 *  own item would. A verb that took the row out of the list (`removed`)
 *  disarms it: whatever slides under the still pointer is not armed. */
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
 *  acts on when nothing else claims the key (the rule at the top). Empty
 *  means do nothing; when another row's toolbar is why, a hint says so.
 *  `foreignOk`: the verb changes nothing (Copy link), so a teammate's menu
 *  offers it too. */
export function rowVerbIds(focused: string | null | undefined, { foreignOk = false } = {}): string[] {
  if (menuTarget) return menuTarget.foreign && !foreignOk ? [] : menuTarget.ids;
  const armed = hoverTargetId();
  if (armed) return [armed];
  const shown = visiblyHoveredRowId();
  if (shown && shown !== focused) {
    hintNoTarget();
    return [];
  }
  return focused ? [focused] : [];
}

// A key that does nothing feels broken: say once in a while why.
const HINT_EVERY_MS = 4000;
let lastHint = -Infinity;
function hintNoTarget(): void {
  const now = Date.now();
  if (now - lastHint < HINT_EVERY_MS) return;
  lastHint = now;
  toast("Move the pointer onto the row to act on it", { id: "row-verb-hint", duration: 2500 });
}
export function _resetRowVerbHintForTests(): void {
  lastHint = -Infinity;
}

/** The row the browser shows as hovered (its toolbar is drawn), armed or not;
 *  the innermost when rows nest. Queried only when a row verb's key is
 *  pressed, never on typing. */
function visiblyHoveredRowId(): string | null {
  if (typeof document === "undefined") return null;
  const rows = document.querySelectorAll(`${ROW}:hover`);
  return rows.length ? rows[rows.length - 1]!.getAttribute("data-row-verbs") : null;
}

/** The armed row's session id, or null. The row must still be on the page
 *  and still be what the browser shows as hovered (the toolbar draws on
 *  :hover): a list re-sorted under a still pointer moves the hover to another
 *  row without a pointer move, and then this row is no target. */
export function hoverTargetId(): string | null {
  if (!hovered?.isConnected || !hovered.matches(":hover")) return null;
  return hovered.getAttribute("data-row-verbs");
}
