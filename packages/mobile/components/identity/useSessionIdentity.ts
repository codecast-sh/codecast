// How a mobile surface gets a session's identity fields out of the store.
//
// The inbox list wakes on sessionsWakeSig, which leaves the character fields
// out on purpose, and a whole row ref flips on every heartbeat. So a face
// subscribes to a signature of the identity fields alone, and reads the row
// through identityRowOf: the resolver stays the only reader of those fields.
import { useMemo } from 'react';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { makeCollectionSig } from '@codecast/web/store/wakeSig';
import { identityRowOf, identitySig, type IdentityRow } from '@codecast/web/lib/sessionIdentity';

// session_id rides along because the lookup answers by it too.
const sessionsIdentitySig = makeCollectionSig<any>((row) => `${row?.session_id ?? ''}|${identitySig(row)}`);

function rowFor(s: any, id: string | null | undefined) {
  return id ? s.sessions?.[id] ?? s.conversations?.[id] ?? null : null;
}

/** One session's identity row, by conversation id. `fallback` serves a row the
 *  store does not hold (a teammate's session opened from a link). */
export function useSessionIdentityRow(id: string | null | undefined, fallback?: (IdentityRow & Record<string, unknown>) | null): IdentityRow | null {
  const sig = useInboxStore((s) => identitySig(rowFor(s, id)));
  const fallbackSig = identitySig(fallback);
  return useMemo(() => {
    const row = rowFor(useInboxStore.getState(), id) ?? fallback;
    return row ? identityRowOf(row) : null;
    // The signatures are the real deps: a row ref flips on every heartbeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sig, fallbackSig]);
}

/** A lookup over every session the store holds, by conversation id or by the
 *  agent's session id (what a chat line's origin_session_id carries). */
export function useSessionIdentityLookup(): (id: string | null | undefined) => IdentityRow | null {
  const sig = useInboxStore((s) => sessionsIdentitySig(s.sessions));
  return useMemo(() => {
    const map = new Map<string, IdentityRow>();
    for (const row of Object.values(useInboxStore.getState().sessions ?? {}) as any[]) {
      if (!row?._id) continue;
      const identity = identityRowOf(row);
      map.set(String(row._id), identity);
      if (row.session_id) map.set(String(row.session_id), identity);
    }
    return (id) => (id ? map.get(String(id)) ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}
