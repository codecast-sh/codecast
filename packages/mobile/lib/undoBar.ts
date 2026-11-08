import { create } from 'zustand';
import { onUndoReset, setUndoNotifier, undoEntry, withoutUndo } from '@platform/engine';
import { sessionTitle, splitLabelNote } from '@codecast/web/store/undo/labels';
import { useInboxStore } from '@codecast/web/store/inboxStore';

// The app's one undo bar (components/UndoBar, mounted at the root). It is the
// mobile notifier for the shared undo engine: every gesture the engine records
// with a toast (stash, kill-all, restore) shows here with its own Undo, as
// sonner shows it on web (web/store/undoStack.ts).
//
// A single kill does not run straight away. Undoing a kill brings the row back
// but leaves the agent stopped, so the kill is held behind the bar instead and
// only reaches the store when the bar drains. Undo during the hold leaves the
// agent untouched. A new bar, the app leaving the foreground (the bar's
// AppState listener), or swiping the bar away runs the held kill at once, so
// it is never lost. No React Native in here, so bun tests it directly.

export const UNDO_BAR_MS = 5000;
const NOTICE_MS = 2500;

export type UndoBarItem = {
  /** Each showing has its own key, so the bar restarts its countdown. */
  key: number;
  title: string;
  note?: string;
  durationMs: number;
  tone: 'quiet' | 'kill';
  onUndo?: () => void;
};

type UndoBarState = { item: UndoBarItem | null; heldKillId: string | null };

export const useUndoBar = create<UndoBarState>(() => ({ item: null, heldKillId: null }));

let shown = 0;
let held: { id: string; key: number; timer: ReturnType<typeof setTimeout> } | null = null;

function show(item: Omit<UndoBarItem, 'key'>): number {
  // Whatever the bar was holding runs before something else takes its place.
  runHeldKill();
  shown += 1;
  useUndoBar.setState({ item: { ...item, key: shown } });
  return shown;
}

/** A plain notice on the bar, with nothing to undo ("Copied", "Bookmarked"). */
export function showNotice(title: string) {
  show({ title, durationMs: NOTICE_MS, tone: 'quiet' });
}

/** Take the bar down if it still shows `key` (the bar's own timer and swipe). */
export function dismissUndoBar(key: number) {
  if (held?.key === key) runHeldKill();
  if (useUndoBar.getState().item?.key === key) useUndoBar.setState({ item: null });
}

function endHold(): string | null {
  if (!held) return null;
  const { id, key, timer } = held;
  held = null;
  clearTimeout(timer);
  useUndoBar.setState((s) => ({ heldKillId: null, item: s.item?.key === key ? null : s.item }));
  return id;
}

/** Run the held kill now, if there is one (the bar calls it when the app
 *  leaves the foreground). */
export function runHeldKill() {
  const id = endHold();
  // The hold was the undo window; the kill itself records nothing, so no
  // second bar follows it.
  if (id) withoutUndo(() => useInboxStore.getState().killSession(id));
}

/** Kill `id` once the bar drains, unless Undo is pressed first. */
export function holdKill(id: string) {
  const title = `Killing ${sessionTitle(useInboxStore.getState(), id)}`;
  const key = show({ title, durationMs: UNDO_BAR_MS, tone: 'kill', onUndo: () => { endHold(); } });
  held = { id, key, timer: setTimeout(runHeldKill, UNDO_BAR_MS) };
  useUndoBar.setState({ heldKillId: id });
}

setUndoNotifier({
  notify: showNotice,
  notifyWithUndo: (label, entryId) => {
    const [title, note] = splitLabelNote(label);
    show({ title, note, durationMs: UNDO_BAR_MS, tone: 'quiet', onUndo: () => { undoEntry(entryId); } });
  },
});

// An account boundary: the history is gone, and a kill held for the account
// that just left is dropped rather than run against the next one.
onUndoReset(() => {
  endHold();
  useUndoBar.setState({ item: null });
});
