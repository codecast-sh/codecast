// The changes a person set aside on a repository's grid (ct-101824): a stale failure or turn they have decided not to
// act on, parked until they bring it back. One home, the stamped clientState.ui bag, so it follows them to every window
// and device and the write is the store's own action (updateClientUI), drawn before the server answers.
import { useCallback, useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { ChangeRow } from "../lib/changes/rows";

const EMPTY: Record<string, number> = {};

export const setAsideKey = (repository: string, key: string) => `${repository}:${key}`;

/** Lay the viewer's set-aside marks on a repository's rows. Returns the same array when none apply. */
export function withSetAside(rows: ChangeRow[], repository: string, marks: Record<string, number>): ChangeRow[] {
  let changed = false;
  const out = rows.map((r) => {
    const at = marks[setAsideKey(repository, r.key)] ?? null;
    if ((r.set_aside ?? null) === at) return r;
    changed = true;
    return { ...r, set_aside: at };
  });
  return changed ? out : rows;
}

export function useChangesSetAside(repository: string) {
  const marks = useInboxStore((s) => s.clientState.ui?.changes_set_aside) ?? EMPTY;
  const setAside = useCallback((key: string, aside: boolean) => {
    const st = useInboxStore.getState();
    const next = { ...(st.clientState.ui?.changes_set_aside ?? {}) };
    if (aside) next[setAsideKey(repository, key)] = Date.now();
    else delete next[setAsideKey(repository, key)];
    st.updateClientUI({ changes_set_aside: next });
  }, [repository]);
  return useMemo(() => ({ marks, setAside }), [marks, setAside]);
}
