// Incremental persistence diff for the IDB collection caches. The naive engine
// clear()s the entire table and re-pours every row on ANY change — a
// sledgehammer that rewrites thousands of rows (and leaves a transient empty
// window) to persist a single edit or a snapshot prune.
//
// diffCollection compares the new in-memory collection against what was last
// persisted (by object identity — applySyncTable reuses the prior row reference
// when nothing the UI renders changed, so a stable ref means a stable row) and
// returns exactly which rows to upsert and which to delete. Unchanged syncs
// produce an empty diff, so they touch disk zero times.
export type CollectionDiff = {
  puts: any[];
  deletes: string[];
  next: Map<string, any>;
};

export function diffCollection(
  prev: Map<string, any> | undefined,
  data: Record<string, any>,
): CollectionDiff {
  const next = new Map<string, any>();
  const puts: any[] = [];

  for (const id in data) {
    const row = data[id];
    next.set(id, row);
    // New row, or its reference changed → it needs to be (re)written.
    if (!prev || prev.get(id) !== row) puts.push(row);
  }

  const deletes: string[] = [];
  if (prev) {
    for (const id of prev.keys()) {
      if (!(id in data)) deletes.push(id);
    }
  }

  return { puts, deletes, next };
}

/**
 * The ids an action's patches touched in one collection, or null when a patch
 * replaced the collection whole (then only a full diff can say what changed).
 */
export function patchedIds(patches: ReadonlyArray<{ path: string | ReadonlyArray<string | number> }>, key: string): Set<string> | null {
  const ids = new Set<string>();
  for (const p of patches) {
    // A string path (patches made without pathAsArray) names no row this can trust: full diff.
    if (typeof p.path === "string") return null;
    if (String(p.path[0]) !== key) continue;
    if (p.path.length < 2) return null;
    ids.add(String(p.path[1]));
  }
  return ids;
}

/**
 * diffCollection for the rows an action patched: the same puts and deletes a
 * full diff would find among `ids`, at a cost of the ids, not the collection.
 * `shadow` (what was last persisted) is updated in place. A row gone from
 * `data` is a delete only when `isRemoved` says it was removed on purpose;
 * otherwise the disk keeps it (see writePatchesToIDB).
 */
export function diffPatchedRows(
  shadow: Map<string, any>,
  data: Record<string, any>,
  ids: Iterable<string>,
  isRemoved: (id: string) => boolean,
): { puts: any[]; deletes: string[] } {
  const puts: any[] = [];
  const deletes: string[] = [];
  for (const id of ids) {
    const row = Object.prototype.hasOwnProperty.call(data, id) ? data[id] : undefined;
    if (row !== undefined) {
      if (shadow.get(id) !== row) {
        puts.push(row);
        shadow.set(id, row);
      }
    } else if (shadow.has(id) && isRemoved(id)) {
      deletes.push(id);
      shadow.delete(id);
    }
  }
  return { puts, deletes };
}

/**
 * A meta blob writer that keeps the latest value per key and writes it once per
 * quiet spell (and on `flush`), so a run of actions that each change the blob
 * (the pending map grows by a lock per field written) serializes it once, not
 * once per action.
 */
export function createCoalescedWriter(
  put: (key: string, value: any) => void,
  delayMs: number,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): { write: (key: string, value: any) => void; flush: () => void; drop: () => void } {
  const latest = new Map<string, any>();
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    for (const [key, value] of latest) put(key, value);
    latest.clear();
  };
  return {
    write(key, value) {
      latest.set(key, value);
      if (timer === null) timer = schedule(flush, delayMs);
    },
    flush,
    /** Forget what waits (a purge): the timer still fires, with nothing to write. */
    drop: () => latest.clear(),
  };
}
