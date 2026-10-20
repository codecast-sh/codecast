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
import { makeCollectionSig } from "../store/wakeSig";

export type CollectionRowsOpts<T> = {
  /** Which rows. Default: all. */
  where?: (row: T) => boolean;
  /** Fields the caller renders — folded into the wake signature so a change
   *  to any of them re-renders; anything else on the row is ignored. Default:
   *  membership only (ids). */
  sig?: (row: T) => string;
  sort?: (a: T, b: T) => number;
};

// The wake signature over the matching rows: a digest per (where, sig) pair,
// memoized by the collection ref and per row (makeCollectionSig), so the N
// components reading the same slice share one pass, a write to one row
// re-reads that row only, and subscribers compare a short string.
const sliceSigs = new Map<unknown, Map<unknown, (collection: Record<string, unknown>) => string>>();
function sliceSig<T>(
  collection: Record<string, T> | undefined,
  where: ((row: T) => boolean) | undefined,
  sig: ((row: T) => string) | undefined,
): string {
  if (!collection) return "";
  let bySig = sliceSigs.get(where);
  if (!bySig) { bySig = new Map(); sliceSigs.set(where, bySig); }
  let fn = bySig.get(sig);
  if (!fn) {
    fn = makeCollectionSig<any>((row) => (!row || (where && !where(row)) ? null : sig ? sig(row) : ""));
    bySig.set(sig, fn);
  }
  return fn(collection as Record<string, unknown>);
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
