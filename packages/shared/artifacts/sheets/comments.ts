// Comment threads on cells. A thread is made on an address (its anchor,
// c:<tab>!C4); the cell there then carries the thread's key (`cm`, one key or
// a list) and the tab lists the thread as pinned. From then on the thread sits
// wherever its cell goes, so sorts, inserts, moves and their undo carry it, and
// a pinned thread no cell carries had its cell deleted: it sits nowhere.
import type { ArtifactOp } from "../core";
import { cellKey, parseKey, tabKey } from "./refs";
import { buildModel, cellNum, type CellEl, type SheetModel } from "./model";
import { tabPatchOps } from "./ops";

/** The threads a cell carries. */
export function cellThreads(el: CellEl | undefined): string[] {
  const v = el?.cm as unknown;
  return typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Ops that pin threads to the cells at their anchors (several threads on one cell all ride it). */
export function pinCommentOps(model: SheetModel, threads: ReadonlyArray<{ key: string; anchor?: unknown }>): ArtifactOp[] {
  const cells = new Map<string, { el?: CellEl; list: string[]; tab: string; col: number; row: number }>();
  const pins = new Map<string, Set<string>>();
  const carried = threads.length ? carriedThreads(model) : new Map();
  for (const th of threads) {
    const k = typeof th.anchor === "string" ? parseKey(th.anchor) : null;
    const t = k?.type === "cell" ? model.byId.get(k.tab) : undefined;
    if (k?.type !== "cell" || !t || t.meta.pinned?.includes(th.key)) continue;
    // A thread a cell already carries (stamped before tabs listed their pins) is only listed, never stamped twice.
    const held = carried.get(th.key);
    if (held) {
      const pinned = pins.get(held.tab) ?? new Set(model.byId.get(held.tab)?.meta.pinned ?? []);
      pinned.add(th.key);
      pins.set(held.tab, pinned);
      continue;
    }
    const key = cellKey(k.tab, k.col, k.row);
    const at = cells.get(key) ?? { el: t.cells.get(cellNum(k.col, k.row)), list: cellThreads(t.cells.get(cellNum(k.col, k.row))), tab: k.tab, col: k.col, row: k.row };
    if (!at.list.includes(th.key)) at.list = [...at.list, th.key];
    cells.set(key, at);
    const pinned = pins.get(k.tab) ?? new Set(t.meta.pinned ?? []);
    pinned.add(th.key);
    pins.set(k.tab, pinned);
  }
  const ops: ArtifactOp[] = [];
  for (const [key, c] of cells) {
    const cm = c.list.length === 1 ? c.list[0] : c.list;
    if (cellThreads(c.el).length === c.list.length) continue;
    ops.push(c.el ? { k: key, set: { cm } } : { k: key, put: { kind: "cell", cm } });
  }
  // Only the pinned list changes: a field write, so a page whose copy of the tab is stale can't undo someone's filter or freeze.
  // A tab that exists only implicitly (no element yet) gets its element written whole.
  for (const [tab, keys] of pins) {
    const meta = model.byId.get(tab)?.meta;
    if (meta && meta.order !== Number.MAX_SAFE_INTEGER) ops.push({ k: tabKey(tab), set: { pinned: [...keys] } });
    else ops.push(...tabPatchOps(model, tab, { pinned: [...keys] }));
  }
  return ops;
}

/**
 * Where a thread sits now: the cell carrying it, else (not pinned yet) its
 * anchor; null when its cell was deleted; undefined when its anchor is not a
 * cell. The carried map is built once per model by the caller for many threads.
 */
export function threadCell(model: SheetModel, thread: { key: string; anchor?: unknown }, carried = carriedThreads(model)): { tab: string; col: number; row: number } | null | undefined {
  const held = carried.get(thread.key);
  if (held) return held;
  const k = typeof thread.anchor === "string" ? parseKey(thread.anchor) : null;
  if (k?.type !== "cell") return undefined;
  return model.byId.get(k.tab)?.meta.pinned?.includes(thread.key) ? null : { tab: k.tab, col: k.col, row: k.row };
}

/** Every carried thread in the sheet and the cell carrying it. */
export function carriedThreads(model: SheetModel): Map<string, { tab: string; col: number; row: number }> {
  const out = new Map<string, { tab: string; col: number; row: number }>();
  for (const t of model.tabs) {
    const data = model.byId.get(t.id);
    for (const [n, el] of data?.cells ?? []) if (el.cm !== undefined) for (const key of cellThreads(el)) out.set(key, { tab: t.id, col: n % 32768, row: Math.floor(n / 32768) });
  }
  return out;
}

/** The spec hooks a comments layer calls (ArtifactSpec.pinComment / commentPlaces), over a doc's elements. */
export const sheetCommentHooks = {
  /** A new thread on a cell rides that cell from the start. */
  pinComment(elements: readonly import("../core").ArtifactElement[], anchor: string, threadKey: string): ArtifactOp[] {
    return pinCommentOps(buildModel(elements), [{ key: threadKey, anchor }]);
  },
  /** Where threads sit now: the key of the cell carrying each, null for one whose cell was deleted; absent when the anchor is not a cell. */
  commentPlaces(elements: readonly import("../core").ArtifactElement[], threads: ReadonlyArray<{ key: string; anchor?: unknown }>): Map<string, string | null> {
    const model = buildModel(elements);
    const carried = carriedThreads(model);
    const out = new Map<string, string | null>();
    for (const th of threads) {
      const at = threadCell(model, th, carried);
      if (at !== undefined) out.set(th.key, at && cellKey(at.tab, at.col, at.row));
    }
    return out;
  },
};
