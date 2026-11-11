// Feeds the trail (lib/navTrail) from what the active app tab shows, the way
// lib/visitRecorder feeds recents: one observer of the screen rather than a
// call in every navigation primitive, so no way of moving (a link, the
// palette, a notification, the rail, browser back and forward) can skip it.
//
// What a tab shows is its path, with one exception: the inbox's home (the
// board or the feed) keeps the last session's `?s=` in the path while it is
// on screen, so the inbox with `showMySessions` up is the bare /inbox.
//
// In every style: Modern's Back control reads the trail, and closing an item
// (hooks/useNavTrail useNavClose) reads it in Classic and Minimal too.

import { useInboxStore } from "../store/inboxStore";
import { placeKey } from "./navPlace";
import { placeName } from "./placeTitle";
import { recordTrail, type TrailMove } from "./navTrail";

type ShownState = { tabs: Array<{ id: string; path: string }>; activeTabId: string | null; showMySessions?: boolean };

/** The place the active tab shows, or null with no tab. */
export function shownPlace(st: ShownState): { scope: string; path: string } | null {
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  if (!tab?.path) return null;
  const path = tab.path.split("?")[0] === "/inbox" && st.showMySessions ? "/inbox" : tab.path;
  return { scope: tab.id, path };
}

// The one-shot intents a move declares before it happens. A history step is
// known from popstate; the back control says where it is going.
const intent: { traverseAt: number; back: { key: string; at: number; move: "back" | "up" } | null } = { traverseAt: 0, back: null };

/** The back control is about to go to `path`: along the trail ("back"), or up
 *  to the page's parent when there was none ("up"). */
export function noteTrailBack(path: string, move: "back" | "up" = "back"): void {
  intent.back = { key: placeKey(path), at: Date.now(), move };
}

function moveFor(path: string): TrailMove {
  const now = Date.now();
  if (intent.back && now - intent.back.at < 3000 && intent.back.key === placeKey(path)) {
    const move = intent.back.move;
    intent.back = null;
    return move;
  }
  if (now - intent.traverseAt < 500) {
    intent.traverseAt = 0;
    return "traverse";
  }
  return "push";
}

/** Start recording; returns the stop. The first pass records what is on screen. */
export function startNavTrail(): () => void {
  let last: string | null = null;
  let lastScope: string | null = null;
  let queued = false;
  const run = () => {
    queued = false;
    const st = useInboxStore.getState();
    const shown = shownPlace(st);
    if (!shown) return;
    // A tab switch shows another tab's place: its own trail already ends there.
    const moved = shown.scope === lastScope && shown.path !== last;
    const fresh = shown.scope !== lastScope;
    last = shown.path;
    lastScope = shown.scope;
    if (!moved && !fresh) return;
    recordTrail(shown.scope, shown.path, fresh ? "push" : moveFor(shown.path), placeName(st, shown.path), st.tabs.map((t) => t.id));
  };
  // Decide after the move settles: a history step's popstate listeners all run
  // before this, whichever registered first.
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  };
  const onPop = () => {
    intent.traverseAt = Date.now();
  };
  window.addEventListener("popstate", onPop, true);
  run();
  let prev = useInboxStore.getState();
  const unsub = useInboxStore.subscribe((st) => {
    if (st.tabs === prev.tabs && st.activeTabId === prev.activeTabId && st.showMySessions === prev.showMySessions) return;
    prev = st;
    schedule();
  });
  return () => {
    unsub();
    window.removeEventListener("popstate", onPop, true);
  };
}
