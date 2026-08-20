// THE sanctioned way to enumerate a workspace-scoped store collection.
//
// The store caches rows from every workspace the user has viewed (and IDB
// persists them), so a raw `Object.values(s.tasks)` in a component leaks
// another team's rows the moment the active team changes. This hook applies
// the ONE boundary rule (lib/workspaceScope inWorkspace) against a workspace
// key computed once from the canonical pointers, so no call site builds the
// key by hand or forgets the filter. Enumerations of tasks / plans / docs /
// projects in components go through here — the lint test in
// lib/__tests__/workspaceEnumeration.test.ts fails on raw enumeration.
//
// Re-render discipline (CLAUDE.md store rules): never subscribe an
// always-mounted component to a whole high-churn collection. This hook
// subscribes to a MEMBERSHIP signature — the ids of rows in the active
// workspace — so a field edit on a row (title, status, heartbeat-driven
// counters) does not re-render the caller; only a row entering/leaving the
// workspace does. Callers that render row FIELDS add their own signature over
// those fields (see GlobalSessionPanel needsAttentionSig for the shape) —
// this hook decides which rows, not when their contents changed.
import { useMemo } from "react";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { activeWorkspaceKey, filterByWorkspace, inWorkspace, type WorkspaceKey } from "../lib/workspaceScope";
import type { WorkspaceScopedStoreKey } from "../store/clientSyncRegistry";

// Derived from the registry: a collection declares `workspaceScoped: true`
// and this hook accepts it — no second list to keep in step.
export type WorkspaceScopedTable = WorkspaceScopedStoreKey;

/** The viewer's active workspace key, from the canonical pointers. Null while
 *  the viewer is unknown — everything reads empty (fail closed), never all. */
export function useActiveWorkspaceKey(): WorkspaceKey | null {
  return useInboxStore((s) =>
    activeWorkspaceKey(s.clientState.ui?.active_team_id, s.currentUser?._id ? String(s.currentUser._id) : null));
}

// Membership signature: which row ids are in the workspace. Memoized on
// (collection ref, key, field-sig fn) so unrelated store writes cost nothing.
// The store reuses a collection's identity when nothing in it changed, so this
// scan (10k+ rows for tasks/docs) runs once per real change, not once per
// store notification per subscriber.
type SigEntry = { key: WorkspaceKey | null; sig: string };
const sigCache = new WeakMap<object, Map<((row: any) => string) | null, SigEntry>>();
function membershipSig(
  collection: Record<string, any>,
  key: WorkspaceKey | null,
  fieldSig: ((row: any) => string) | null = null,
): string {
  let perFn = sigCache.get(collection);
  const hit = perFn?.get(fieldSig);
  if (hit && hit.key === key) return hit.sig;
  const ids: string[] = [];
  let extra = "";
  if (key) {
    for (const id in collection) {
      const row = collection[id];
      if (!inWorkspace(row, key)) continue;
      ids.push(id);
      if (fieldSig) extra += fieldSig(row) + "\n";
    }
  }
  const sig = fieldSig ? ids.join("\n") + "\u0000" + extra : ids.join("\n");
  if (!perFn) { perFn = new Map(); sigCache.set(collection, perFn); }
  perFn.set(fieldSig, { key, sig });
  return sig;
}

/**
 * The rows of `table` that belong to the active workspace. Stable array ref
 * until membership changes. Pass `sig` to ALSO re-render on a field change:
 * a projection of the fields you render, folded into the wake signature.
 */
export function useWorkspaceCollection<T = any>(
  table: WorkspaceScopedTable,
  sig?: (row: T) => string,
): T[] {
  const s = useTrackedStore([
    (st) => activeWorkspaceKey(st.clientState.ui?.active_team_id, st.currentUser?._id ? String(st.currentUser._id) : null),
    (st) => {
      const key = activeWorkspaceKey(st.clientState.ui?.active_team_id, st.currentUser?._id ? String(st.currentUser._id) : null);
      return membershipSig((st as any)[table], key, sig ?? null);
    },
  ]);
  const key = activeWorkspaceKey(s.clientState.ui?.active_team_id, s.currentUser?._id ? String(s.currentUser._id) : null);
  const coll = (s as any)[table] as Record<string, T>;
  const memberSig = membershipSig(coll, key);
  // Rows filed under a store key that isn't their own _id are dropped (e.g. a
  // task detail-query copy keyed by its URL short id, planted by pre-fix
  // builds). Every sync channel keys rows by _id, so such a copy never
  // receives updates — rendered, it's a phantom frozen at stale field values
  // beside (or instead of) the live row. Stubs pass: keyed by their temp _id.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- memberSig stands in for the churny collection ref
  return useMemo(
    () =>
      filterByWorkspace(
        Object.entries(coll)
          .filter(([k, row]) => k === String((row as any)?._id))
          .map(([, row]) => row) as any[],
        key,
      ) as T[],
    [memberSig, key, sig ? coll : null],
  );
}
