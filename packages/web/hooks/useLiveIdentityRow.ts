// A session row with its role read from the role rows (lib/sessionIdentity
// withLiveRole). Kept out of lib/sessionIdentity so the resolver stays a pure
// module (see useIdentityPrefs). Every identity component reads its row through
// this, so a role's standing session wears the role's given name and face on
// every surface, even when the row it was handed carries no snapshot.
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import { identityRowOf, liveRoleSig, roleAuthorOf, roleOfUser, speakerOf, withLiveRole, type IdentityRow, type RoleAuthor, type RoleRows, type SessionIdentity } from "../lib/sessionIdentity";
import { roleRowsOf, roleRowsSig } from "../lib/roleRows";
import { useIdentityPrefs } from "./useIdentityPrefs";

/** Answers the role rows for everything below it instead of the store; null
 *  is "no roles", so each row keeps the role snapshot it carries. The homepage
 *  hero sets it, so its fixtures never read the visitor's org. */
export const RoleRowsOverride = createContext<RoleRows | null | undefined>(undefined);

const noSubscription = () => () => {};

export function useLiveIdentityRow<T extends IdentityRow>(row: T): T;
export function useLiveIdentityRow<T extends IdentityRow>(row: T | null): T | null;
export function useLiveIdentityRow<T extends IdentityRow>(row: T | null): T | null {
  const override = useContext(RoleRowsOverride);
  const rows = () => (override === undefined ? roleRowsOf(useInboxStore.getState() as never) : override);
  // A row with neither pointer is no role's (standingRoleOf), whatever the
  // role rows say, so it costs the store no subscription: every card and
  // sidebar row resolves its identity through here. Otherwise it subscribes
  // to the matched role's fields alone.
  const mayBeRole = !!row && (!!row.standing_role_id || !!row.acting_user_id);
  const sig = useSyncExternalStore(
    override === undefined && mayBeRole ? useInboxStore.subscribe : noSubscription,
    () => liveRoleSig(row, rows()),
    () => liveRoleSig(row, override === undefined ? roleRowsOf(useInboxStore.getInitialState() as never) : override),
  );
  return useMemo(
    () => (row ? withLiveRole(row, rows()) : null),
    [row, sig, override], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Who a conversation is, for the surfaces inside it (the header face, the
 *  speaker on every assistant turn): the session row's identity fields, with
 *  the conversation row's role pointers filling what a thin session row lacks.
 *  A teammate's session visited from outside the inbox has only a thin
 *  session row, so without the conversation's pointers a role's standing
 *  session would speak as its agent. Subscribes to the identity fields alone,
 *  so a heartbeat re-renders nothing. */
export function useConversationIdentityRow(conversationId: string | null | undefined): IdentityRow | null {
  const base = useInboxStore(useShallow((s) => {
    if (!conversationId) return null;
    const sess = s.sessions[conversationId] as any;
    const conv = s.conversations[conversationId] as any;
    const src = sess ?? conv;
    if (!src) return null;
    const row = identityRowOf(src);
    return {
      ...row,
      standing_role_id: row.standing_role_id ?? conv?.standing_role_id ?? null,
      acting_user_id: row.acting_user_id ?? conv?.acting_user_id ?? null,
    };
  }));
  return useLiveIdentityRow(base);
}

/** speakerOf (lib/sessionIdentity) over the live row: the name an agent
 *  speaks under, and the row to draw its face from (null for a plain session). */
export function useAgentSpeaker(row: IdentityRow | null, agentType?: string | null): {
  name: string;
  row: IdentityRow | null;
  identity: Exclude<SessionIdentity, { kind: "plain" }> | null;
} {
  const live = useLiveIdentityRow(row);
  const speaker = speakerOf(live, agentType, useIdentityPrefs());
  return { ...speaker, row: speaker.identity ? live : null };
}

/** useAgentSpeaker for the agent of one conversation. */
export function useConversationSpeaker(conversationId: string | null | undefined, agentType?: string | null) {
  return useAgentSpeaker(useConversationIdentityRow(conversationId), agentType);
}

/** Who wrote something, when it was a role: the role's given name (its title,
 *  characters off) and face,
 *  found from the writer's session (a comment's session_info) or its user id
 *  (a role's bot user), both read from the role rows. Null for anyone else.
 *  Wakes only when the roles or their seats change. */
export function useRoleAuthor(): (by: { userId?: string | null; session?: IdentityRow | null }) => RoleAuthor | null {
  const sig = useInboxStore((s) => roleRowsSig(s as never));
  const prefs = useIdentityPrefs();
  return useMemo(() => {
    const tree = roleRowsOf(useInboxStore.getState() as never);
    return ({ userId, session }) => {
      if (session) {
        const role = roleAuthorOf(withLiveRole(session, tree), prefs);
        if (role) return role;
      }
      const role = roleOfUser(userId, tree, prefs);
      return role ? { name: role.name, face: role.face, tile: role.tile, style: role.style } : null;
    };
  }, [sig, prefs]); // eslint-disable-line react-hooks/exhaustive-deps
}
