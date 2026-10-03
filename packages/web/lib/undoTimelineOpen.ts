// Whether the undo timeline card is open, and how: a "peek" (opened by the
// held-modifier walk, narrating each step) or "interactive" (opened by the
// palette row, the chord or a toast's History action, keyboard-driven).
// A module-level external store so the toast notifier, the shortcut handlers
// and the card's host all read one value without a React context.
export type UndoTimelineMode = "peek" | "interactive";
export type UndoTimelineSnapshot = { open: boolean; mode: UndoTimelineMode };

let snapshot: UndoTimelineSnapshot = { open: false, mode: "interactive" };
const listeners = new Set<() => void>();

function set(next: UndoTimelineSnapshot): void {
  if (next.open === snapshot.open && next.mode === snapshot.mode) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

export function open(mode: UndoTimelineMode = "interactive"): void {
  set({ open: true, mode });
}

export function close(): void {
  set({ open: false, mode: snapshot.mode });
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
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
