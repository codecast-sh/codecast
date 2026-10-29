// How a mobile surface gets a session's identity fields out of the store.
//
// The inbox list wakes on sessionsWakeSig, which leaves the character fields
// out on purpose, and a whole row ref flips on every heartbeat. So a face
// subscribes to a signature of the identity fields alone, and reads the row
// through identityRowOf: the resolver stays the only reader of those fields.
//
// Every row comes back with its role read live from the role rows
// (withLiveRole), the same as web's useConversationIdentityRow: a role's
// standing session wears the role's given name and face even when the row it
// was found by is thin and carries no role snapshot.
import { useMemo } from 'react';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { makeCollectionSig } from '@codecast/web/store/wakeSig';
import { useLiveIdentityRow } from '@codecast/web/hooks/useLiveIdentityRow';
import { roleRowsOf, roleRowsSig } from '@codecast/web/lib/roleRows';
import { identityRowOf, identitySig, withLiveRole, type IdentityRow } from '@codecast/web/lib/sessionIdentity';

type SourceRow = IdentityRow & Record<string, unknown>;

// session_id rides along because the lookup answers by it too.
const sessionsIdentitySig = makeCollectionSig<any>((row) => `${row?.session_id ?? ''}|${identitySig(row)}`);

/** The session row's identity fields, with the conversation row's role
 *  pointers (and the fallback's) filling what a thin session row lacks. */
function identityFor(s: any, id: string | null | undefined, fallback?: SourceRow | null): IdentityRow | null {
  const sess = id ? s.sessions?.[id] : null;
  const conv = id ? s.conversations?.[id] : null;
  const src = sess ?? conv ?? fallback;
  if (!src) return null;
  const row = identityRowOf(src);
  return {
    ...row,
    standing_role_id: row.standing_role_id ?? conv?.standing_role_id ?? fallback?.standing_role_id ?? null,
    acting_user_id: row.acting_user_id ?? conv?.acting_user_id ?? fallback?.acting_user_id ?? null,
  };
}

/** One session's identity row, by conversation id. `fallback` serves a row the
 *  store does not hold (a teammate's session opened from a link). */
export function useSessionIdentityRow(id: string | null | undefined, fallback?: SourceRow | null): IdentityRow | null {
  const fallbackSig = identitySig(fallback);
  const sig = useInboxStore((s) => identitySig(identityFor(s, id, fallback) as SourceRow | null));
  const base = useMemo(
    () => identityFor(useInboxStore.getState(), id, fallback),
    // The signatures are the real deps: a row ref flips on every heartbeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, sig, fallbackSig],
  );
  return useLiveIdentityRow(base);
}

/** A lookup over every session the store holds, by conversation id or by the
 *  agent's session id (what a chat line's origin_session_id carries). */
export function useSessionIdentityLookup(): (id: string | null | undefined) => IdentityRow | null {
  const sig = useInboxStore((s) => sessionsIdentitySig(s.sessions));
  const rolesSig = useInboxStore((s) => roleRowsSig(s as never));
  return useMemo(() => {
    const state = useInboxStore.getState();
    const { sessions } = state;
    const roleRows = roleRowsOf(state as never);
    const map = new Map<string, IdentityRow>();
    for (const row of Object.values(sessions ?? {}) as any[]) {
      if (!row?._id) continue;
      const identity = withLiveRole(identityRowOf(row), roleRows);
      map.set(String(row._id), identity);
      if (row.session_id) map.set(String(row.session_id), identity);
    }
    return (id) => (id ? map.get(String(id)) ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, rolesSig]);
}
