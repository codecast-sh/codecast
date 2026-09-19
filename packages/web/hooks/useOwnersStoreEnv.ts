"use client";

/**
 * The inbox store's half of the owners environment, shared by the web
 * OwnersBadge and the mobile AssignmentChip. useOwners stays free of the store;
 * this file binds it: the implicit owner read off the session row, and the one
 * reparent path (org-staffing.md S11), so an owner change or a role move from
 * either platform dispatches through reparentOrgSession and reaches the same
 * core. Each platform injects only what differs: its roster, its current user
 * and its toast.
 *
 * MOBILE-SAFE like useOwners: bundled into the Expo app, so no DOM and no
 * sonner here.
 */

import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import { reparentToastLine } from "../store/orgSlice";
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
  const starterIds = useInboxStore(useShallow((s) => {
    const row = sessionRowOf(s, conversationId);
    return [row?.author_user_id ?? null, row?.user_id ?? null] as const;
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
  return {
    teamMembers,
    currentUser,
    implicitOwnerId,
    notify,
    reparent: async (target, opts) => {
      const r = await useInboxStore.getState().reparentOrgSession(conversationId, target, { note: opts.note });
      // Always a SESSION reparent here, whether the new parent is a person or a
      // role: the session is what is told. A stale session is DEFERRED rather
      // than woken, which still deserves the line — it says when it will read.
      if (r && (r.told?.sessions || r.told?.deferred)) {
        notify(reparentToastLine(r.short_id ?? "The session", r.reports_to?.name ?? opts.parentName ?? "its new parent", "session", r.told), "success");
      } else if (opts.toastFallback) {
        notify(opts.toastFallback, "success");
      }
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
  return { liveRoles, orgRoleId, currentRole, isStandingThread };
}
