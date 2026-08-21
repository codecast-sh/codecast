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
