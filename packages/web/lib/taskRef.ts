// The one task a ref names, by its _id or its short id (ct-…). A LOOKUP of a row the caller already
// names, never a list: the workspace enumeration guard allows this file for that shape only.
type RefRow = { _id: string; short_id?: string };

export function taskByRef<T extends RefRow>(tasks: Record<string, T> | null | undefined, ref: string | null | undefined): T | null {
  if (!tasks || !ref) return null;
  const byId = tasks[ref];
  if (byId) return byId;
  let refs = refIndexes.get(tasks);
  if (!refs) {
    refs = new Map();
    for (const id in tasks) { const r = tasks[id]?.short_id; if (r && !refs.has(r)) refs.set(r, tasks[id]); }
    refIndexes.set(tasks, refs);
  }
  return (refs.get(ref) as T | undefined) ?? null;
}

/** Each task record's rows by ref, read once per record: a list of controls that each name a task by its ref reads
 *  one index, not one scan of every task each. */
const refIndexes = new WeakMap<object, Map<string, RefRow>>();
