"use client";

/**
 * The inbox store's half of the owners environment, shared by the web
 * OwnersBadge and the mobile AssignmentChip: the implicit owner read off the
 * session row, a role's face from the org roles, and the one write
 * (applySessionOwners), so an owner change from either platform paints the
 * store row and reaches the same core. Each platform injects only what
 * differs: its roster, its current user and its toast.
 *
 * MOBILE-SAFE like useOwners: bundled into the Expo app, so no DOM and no
 * sonner here.
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import { useOrgRoles } from "./useOrgRoles";
import type { OwnersEnv } from "./useOwners";

/** The session row a conversation id names: the live session, else the
 *  conversation it was opened from. */
function sessionRowOf(s: any, conversationId: string): any {
  const live = typeof s.resolveLiveSessionId === "function" ? s.resolveLiveSessionId(conversationId) : conversationId;
  return s.sessions?.[live] ?? s.conversations?.[conversationId];
}

export function useStoreOwnersEnv(
  conversationId: string,
  base: Pick<OwnersEnv, "teamMembers" | "currentUser"> & { notify: NonNullable<OwnersEnv["notify"]> },
): OwnersEnv {
  const { teamMembers, currentUser, notify } = base;
  // A run a role holds alone has no starter owner (shared starterOf).
  const starterIds = useInboxStore(useShallow((s) => {
    const row = sessionRowOf(s, conversationId);
    return row?.role_alone ? [null, null] as const : [row?.author_user_id ?? null, row?.user_id ?? null] as const;
  }));
  const implicitOwnerId = (() => {
    const isBot = (id: string) => {
      if (currentUser?._id === id) return !!currentUser.is_bot;
      const m = teamMembers?.find((x: any) => x._id === id);
      return m ? !!m.is_bot : false;
    };
    for (const id of starterIds) {
      if (id && !isBot(id)) return id as string;
    }
    return undefined;
  })();
  const { roles } = useOrgRoles();
  // The role, the driver and the primary owner live on the session row, and
  // so do the people once the inbox lists them (ownerIdsHomeOf).
  const [roleId, driverUserId, primaryId, runnerId, rowOwners] = useInboxStore(useShallow((s) => {
    const row = sessionRowOf(s, conversationId);
    return [row?.org_role_id ?? null, row?.driver_user_id ?? null, row?.owner_user_id ?? null, row?.user_id ?? null, Array.isArray(row?.owner_ids) ? row.owner_ids.join(",") : null] as const;
  }));
  const ownerIds = useMemo(() => (rowOwners === null ? null : rowOwners ? rowOwners.split(",") : []), [rowOwners]);
  return {
    session: { role_id: roleId, driver_user_id: driverUserId, primary_id: primaryId, runner_id: runnerId, owner_ids: ownerIds },
    teamMembers,
    currentUser,
    implicitOwnerId,
    notify,
    ack: () => useInboxStore.getState().ackSessionAssignment(conversationId),
    apply: (change, inverse) => useInboxStore.getState().applySessionOwners(conversationId, change, inverse),
    roleById: (roleId) => {
      const r = roles.find((x) => x._id === roleId);
      return r ? { role_id: r._id, short_id: r.short_id, handle: r.handle, name: r.name, avatar: (r as any).avatar ?? null } : null;
    },
  };
}

/**
 * What the ownership menu reads about a session's reporting line to a role:
 * the roles it can be filed under, the one it reports to now, and whether the
 * menu may offer the move at all. Reader only; the menu mounts
 * useSyncOrgTreeFeeder while it is open.
 */
export function useSessionRoleFacts(conversationId: string) {
  const { roles } = useOrgRoles();
  // A team role only takes sessions routed to its team; a personal role takes
  // any (sessionOwnership.performReparentSession). The menu offers only the
  // roles the server will accept. `undefined` means the row is not in the
  // store, so the team is unknown and nothing is ruled out.
  const sessionTeamId = useInboxStore((s) => {
    const row = sessionRowOf(s, conversationId);
    return row ? ((row.team_id as string | undefined) ?? null) : undefined;
  });
  const liveRoles = roles.filter(
    (r) => r.status !== "retired" && (sessionTeamId === undefined || !r.team_id || r.team_id === sessionTeamId),
  );
  const orgRoleId = useInboxStore((s) => {
    const live = (s as any).resolveLiveSessionId?.(conversationId) ?? conversationId;
    return ((s.sessions as any)?.[live]?.org_role_id ?? (s.conversations as any)?.[conversationId]?.org_role_id) as string | undefined;
  });
  const currentRole = orgRoleId ? liveRoles.find((r) => r._id === orgRoleId) : undefined;
  // A standing agent's own thread is a seat, not a hand: the server refuses to
  // file it under a role (sessionOwnership.performReparentSession), so the
  // menu does not offer it.
  const isStandingThread = useInboxStore((s) => {
    const row = sessionRowOf(s, conversationId);
    return !!(row?.is_anchor || row?.anchor_id || row?.standing_role_id);
  });
  // A role's own session belongs to whom the role reports to (S28): its owner
  // changes by moving the role, never by a separate owner list.
  const seatRoleId = useInboxStore((s) => sessionRowOf(s, conversationId)?.standing_role_id as string | undefined);
  return { liveRoles, orgRoleId, currentRole, isStandingThread, seatRoleId };
}
