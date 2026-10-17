// THE generic store reader for a non-workspace-scoped collection: the rows of
// `key` matching `where`, sorted, as a stable array that only changes when a
// matching row enters/leaves or a rendered field (per `sig`) changes.
//
// Re-render discipline (CLAUDE.md store rules): never subscribe a component to
// a whole collection ref — every heartbeat on any row hands back a new ref.
// This subscribes to a SIGNATURE over the matching rows instead. Workspace-
// scoped tables (tasks/plans/docs/projects) go through useWorkspaceCollection,
// which applies the access boundary; this hook is for everything else.
import { useMemo } from "react";
import { useTrackedStore } from "../store/inboxStore";

export type CollectionRowsOpts<T> = {
  /** Which rows. Default: all. */
  where?: (row: T) => boolean;
  /** Fields the caller renders — folded into the wake signature so a change
   *  to any of them re-renders; anything else on the row is ignored. Default:
   *  membership only (ids). */
  sig?: (row: T) => string;
  sort?: (a: T, b: T) => number;
};

// Cache the signature per (collection ref, where, sig) so the N components
// reading the same slice don't each rescan on every store notification.
const sigCache = new WeakMap<object, Map<unknown, Map<unknown, string>>>();
// And each row's line per (where, sig), by row ref: a write to one row hands
// back a new collection in which every other row keeps its ref, so the rescan
// calls where and sig only for the rows that changed.
// `last` is the slice's previous signature: an equal rebuild hands back that
// same string, so a subscriber's Object.is is a pointer check rather than a
// compare of the whole slice (see makeCollectionSig).
type SliceLines = { rows: WeakMap<object, { id: string; line: string }>; last?: string };
const rowLineCache = new Map<unknown, Map<unknown, SliceLines>>();
function rowLines(where: unknown, sig: unknown): SliceLines {
  let bySig = rowLineCache.get(where);
  if (!bySig) { bySig = new Map(); rowLineCache.set(where, bySig); }
  let lines = bySig.get(sig);
  if (!lines) { lines = { rows: new WeakMap() }; bySig.set(sig, lines); }
  return lines;
}

function sliceSig<T>(
  collection: Record<string, T> | undefined,
  where: ((row: T) => boolean) | undefined,
  sig: ((row: T) => string) | undefined,
): string {
  if (!collection) return "";
  let byWhere = sigCache.get(collection);
  if (!byWhere) { byWhere = new Map(); sigCache.set(collection, byWhere); }
  let bySig = byWhere.get(where);
  if (!bySig) { bySig = new Map(); byWhere.set(where, bySig); }
  const hit = bySig.get(sig);
  if (hit !== undefined) return hit;
  const lines = rowLines(where, sig);
  let out = "";
  for (const id in collection) {
    const row = collection[id];
    if (!row) continue;
    const cacheable = typeof row === "object";
    const hit = cacheable ? lines.rows.get(row as object) : undefined;
    let line = hit?.id === id ? hit.line : undefined;
    if (line === undefined) {
      line = where && !where(row) ? "" : sig ? `${id}|${sig(row)}\n` : `${id}\n`;
      if (cacheable) lines.rows.set(row as object, { id, line });
    }
    out += line;
  }
  if (out === lines.last) out = lines.last;
  else lines.last = out;
  bySig.set(sig, out);
  return out;
}

export function useCollectionRows<T = any>(key: string, opts: CollectionRowsOpts<T> = {}): T[] {
  const { where, sig, sort } = opts;
  const dep = useMemo(() => Object.assign((st: any) => sliceSig<T>(st[key], where, sig), { label: `sliceSig(${key})` }), [key, where, sig]);
  const s = useTrackedStore([dep]);
  const coll = (s as any)[key] as Record<string, T> | undefined;
  const signature = sliceSig<T>(coll, where, sig);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature stands in for the churny ref
  return useMemo(() => {
    const rows: T[] = [];
    for (const id in coll ?? {}) {
      const row = coll![id];
      if (row && (!where || where(row))) rows.push(row);
    }
    return sort ? rows.sort(sort) : rows;
  }, [signature, sort]);
}
