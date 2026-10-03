// Per-store hooks that run after an undo writes a store's rows back, so a
// surface can react to the revert itself (the inbox animates a session row
// back in when its hide fields clear). The binding's afterReplay calls
// runUndoRevert once per undo; each hook receives its store's rows, each with
// the cells that undo applied.
import type { CellChange, UndoEntry } from "@platform/engine";

export type UndoRevertRow = { id: string; cells: CellChange[] };
export type UndoRevertHook = (rows: UndoRevertRow[], entry: UndoEntry) => void;

const hooks = new Map<string, Set<UndoRevertHook>>();

/** Run `fn` after every undo that writes rows of `store`. Returns the unregister. */
export function registerUndoRevert(store: string, fn: UndoRevertHook): () => void {
  const set = hooks.get(store) ?? new Set<UndoRevertHook>();
  set.add(fn);
  hooks.set(store, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) hooks.delete(store);
  };
}

export function runUndoRevert(entry: UndoEntry, applied: readonly CellChange[]): void {
  if (hooks.size === 0) return;
  const byStore = new Map<string, Map<string, CellChange[]>>();
  for (const cell of applied) {
    if (!hooks.has(cell.store)) continue;
    const rows = byStore.get(cell.store) ?? new Map<string, CellChange[]>();
    const cells = rows.get(cell.id) ?? [];
    cells.push(cell);
    rows.set(cell.id, cells);
    byStore.set(cell.store, rows);
  }
  for (const [store, rows] of byStore) {
    const list = [...rows].map(([id, cells]) => ({ id, cells }));
    for (const fn of hooks.get(store) ?? []) {
      try {
        fn(list, entry);
      } catch (error) {
        console.error(`[undo] revert hook for ${store} failed`, error);
      }
    }
  }
}
