// Where the reader was in each transcript, so browser back and forward land on
// the same spot instead of the live tail. A spot is a message (by message_uuid,
// plus its timestamp to page the window to it when it is no longer loaded) and
// that row's top offset in the scroll container. A fresh open (a click, a
// notification) still lands on the tail: only a history step restores.

export type ReadingSpot = { messageUuid: string; timestamp: number; offset: number };

const MAX_SPOTS = 200;
// A history step lands on its conversation within this window; a later open
// of a remembered conversation is a fresh one.
const TRAVERSE_WINDOW_MS = 3000;

const spots = new Map<string, ReadingSpot>();
let traversedAt: number | null = null;

// The Navigation API's traverse fires before any popstate listener runs. A
// router's popstate listener renders the conversation synchronously, so a
// popstate listener of our own heard the step only after the open had already
// asked (measured: 120ms late). popstate is the fallback where the API is missing.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const nav = (window as { navigation?: EventTarget }).navigation;
  if (nav) {
    nav.addEventListener("navigate", (e) => {
      const type = (e as Event & { navigationType?: string }).navigationType;
      // A click after the step is a fresh open, whatever the window says.
      if (type === "traverse") traversedAt = Date.now();
      else if (type === "push") traversedAt = null;
    });
  } else {
    window.addEventListener("popstate", () => { traversedAt = Date.now(); }, true);
  }
}

/** Record the reader's spot in a conversation; null forgets it (they are at the tail). */
export function rememberReadingSpot(conversationId: string, spot: ReadingSpot | null): void {
  spots.delete(conversationId);
  if (!spot) return;
  spots.set(conversationId, spot);
  if (spots.size > MAX_SPOTS) spots.delete(spots.keys().next().value!);
}

/** The spot to restore when a conversation opens: only when a history step
 *  (back or forward) just opened it. Consumes the step either way. */
export function readingSpotForOpen(conversationId: string, now = Date.now()): ReadingSpot | null {
  if (traversedAt === null || now - traversedAt > TRAVERSE_WINDOW_MS) return null;
  traversedAt = null;
  return spots.get(conversationId) ?? null;
}

/** Tests: mark a history step at `at`. */
export function _noteTraversalForTests(at: number): void {
  traversedAt = at;
}
