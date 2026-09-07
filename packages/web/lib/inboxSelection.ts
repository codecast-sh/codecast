/**
 * The inbox list's multi-selection: which session cards are ticked.
 *
 * Its own tiny store rather than a key on the inbox store: it is per-window
 * gesture state (never synced, never persisted), and the ⌘K handler in
 * shortcuts/actions.ts has to read it without a prop path from the panel.
 * Ids are conversation ids, in the order they were picked.
 */
import { create } from "zustand";

type InboxSelectionState = {
  ids: string[];
  /** The last plain/meta-clicked card — the shift-range's start. */
  anchorId: string | null;
  set: (ids: string[], anchorId?: string | null) => void;
  toggle: (id: string) => void;
  /** Select every id between the anchor and `id` in `order` (screen order). */
  range: (id: string, order: string[]) => void;
  clear: () => void;
};

export const useInboxSelection = create<InboxSelectionState>((set, get) => ({
  ids: [],
  anchorId: null,
  set: (ids, anchorId) => set({ ids: [...new Set(ids)], anchorId: anchorId === undefined ? ids[ids.length - 1] ?? null : anchorId }),
  toggle: (id) => {
    const { ids } = get();
    set(ids.includes(id) ? { ids: ids.filter((x) => x !== id), anchorId: id } : { ids: [...ids, id], anchorId: id });
  },
  range: (id, order) => {
    const { ids, anchorId } = get();
    const from = anchorId ? order.indexOf(anchorId) : -1;
    const to = order.indexOf(id);
    if (from === -1 || to === -1) {
      set({ ids: [...new Set([...ids, id])], anchorId: id });
      return;
    }
    const [a, b] = from < to ? [from, to] : [to, from];
    set({ ids: [...new Set([...ids, ...order.slice(a, b + 1)])], anchorId });
  },
  clear: () => set({ ids: [], anchorId: null }),
}));

/** The selection, but only the ids still present in `alive` (rows can leave the list). */
export function selectedAlive(ids: string[], alive: (id: string) => boolean): string[] {
  return ids.filter(alive);
}

/** Cmd/Ctrl-click toggles, Shift-click ranges, a plain click is not a selection gesture. */
export function selectionGesture(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): "toggle" | "range" | null {
  if (e.shiftKey) return "range";
  if (e.metaKey || e.ctrlKey) return "toggle";
  return null;
}
