// Whether the undo timeline card is open, and how: a "peek" (opened by the
// held-modifier walk, narrating each step) or "interactive" (opened by the
// palette row, the chord or a toast's History action, keyboard-driven).
// A module-level external store so the toast notifier, the shortcut handlers
// and the card's host all read one value without a React context.
/** "hidden": no header button and no settings row; the palette row, the
 *  chord, the toast's History action, the held peek and the milestone tip
 *  are the doorways (S9). "visible" adds the header button. */
export const UNDO_HISTORY_TIER: "hidden" | "visible" = "hidden";

export type UndoTimelineMode = "peek" | "interactive";
export type UndoTimelineSnapshot = { open: boolean; mode: UndoTimelineMode };

let snapshot: UndoTimelineSnapshot = { open: false, mode: "interactive" };
const listeners = new Set<() => void>();

function set(next: UndoTimelineSnapshot): void {
  if (next.open === snapshot.open && next.mode === snapshot.mode) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

// Focus goes back where it was when the card opened, on every close (Esc,
// the chord again, an act, the peek fading), not only Esc. The page body
// (nothing focused) is such a place: the card leaves focus there rather than
// in a field that had it earlier, where the next single-key shortcut would
// type. An overlay that opened the card (the palette, whose input still
// holds focus as it closes; a toast, whose History button leaves with it) is
// not a place to return to, so the target is the last focus outside any
// overlay, or the body when focus left that for the body before.
const OVERLAY = '[role="dialog"], [cmdk-root], [data-radix-popper-content-wrapper], [data-sonner-toaster]';
let lastSteadyFocus: HTMLElement | null = null;
let returnTo: HTMLElement | null = null;

const steady = (el: Element | null): el is HTMLElement =>
  !!el && el instanceof HTMLElement && el !== document.body && !el.closest(OVERLAY);
const inOverlay = (el: Element | null): boolean => !!el && el !== document.body && !!el.closest?.(OVERLAY);

// Installed by the first subscriber (UndoTimelineHost mounts with the app),
// against whatever document is live then.
let trackedDoc: Document | null = null;
function trackFocus(): void {
  if (typeof document === "undefined" || trackedDoc === document) return;
  trackedDoc = document;
  document.addEventListener(
    "focusin",
    (e) => {
      if (steady(e.target as Element | null)) lastSteadyFocus = e.target as HTMLElement;
    },
    true,
  );
  // Focus left for nothing (a blur to the body, not a move to another
  // element or a switch to another window, which keeps activeElement).
  document.addEventListener(
    "focusout",
    (e) => {
      if (!(e as FocusEvent).relatedTarget && steady(e.target as Element | null) && document.activeElement !== e.target) lastSteadyFocus = null;
    },
    true,
  );
}

const cardEl = () => (typeof document !== "undefined" ? document.querySelector("[data-undo-timeline]") : null);

export function open(mode: UndoTimelineMode = "interactive"): void {
  if (!snapshot.open && typeof document !== "undefined") {
    const active = document.activeElement;
    returnTo = steady(active) ? active : inOverlay(active) ? lastSteadyFocus : null;
  }
  set({ open: true, mode });
}

export function close(): void {
  if (!snapshot.open) return;
  const target = returnTo;
  returnTo = null;
  // Only when focus is in the card (or already fell to the body): a close
  // that follows a click elsewhere leaves focus where the click put it.
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const card = cardEl();
  const lost = !active || active === document.body || (!!card && card.contains(active));
  set({ open: false, mode: snapshot.mode });
  if (!lost) return;
  if (target?.isConnected) target.focus({ preventScroll: true });
  else if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/** Close when open; otherwise open in `mode`. */
export function toggle(mode: UndoTimelineMode = "interactive"): void {
  if (snapshot.open) close();
  else open(mode);
}

export function isOpen(): boolean {
  return snapshot.open;
}

export function getMode(): UndoTimelineMode {
  return snapshot.mode;
}

/** The same reference until the state changes (for useSyncExternalStore). */
export function getSnapshot(): UndoTimelineSnapshot {
  return snapshot;
}

export function subscribe(fn: () => void): () => void {
  trackFocus();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// A keyboard undo that stopped at an entry it may not take back blind (one
// whose undo widens access) while the card is open: the notifier stays quiet
// so no toast covers the card, and the card marks that row instead. `n`
// counts the stops, so a second press on the same row flashes it again.
export type UndoTimelineFlash = { id: string; n: number };
let flash: UndoTimelineFlash | null = null;
const flashListeners = new Set<() => void>();

export function flashRow(id: string): void {
  flash = { id, n: (flash?.n ?? 0) + 1 };
  for (const listener of [...flashListeners]) listener();
}

export function getFlash(): UndoTimelineFlash | null {
  return flash;
}

export function subscribeFlash(fn: () => void): () => void {
  flashListeners.add(fn);
  return () => {
    flashListeners.delete(fn);
  };
}
