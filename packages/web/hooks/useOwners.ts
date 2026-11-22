"use client";

/**
 * The OWNERS of a session: the people whose inboxes it is in, at most one
 * role, who drives (messages the agent) and the account that runs it. Shared
 * by the web header (AssignmentBadge, OwnersMenu) and the mobile
 * AssignmentChip.
 *
 * Local-first: listOwners FEEDS the `sessionOwners` store collection (one row
 * per conversation, keyed by its id) and this hook reads that row. Every
 * write is the store's applySessionOwners action, which patches owner_ids,
 * role_id and driver on the row before applyOwnersChange lands, so the faces
 * and the menu repaint in the same tick, undo and redo included; a refusal
 * rolls the row back through the store's own refusal path.
 *
 * MOBILE-SAFE by construction: this file is bundled into the Expo app, so no
 * DOM, no sonner, no window/document (see shared-code Hermes traps). The
 * environment injects what differs per platform: the team roster, the current
 * user and a notify callback; useStoreOwnersEnv adds the rest.
 */

import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isConvexId } from "../lib/entityLinks";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { peopleOf } from "@codecast/shared/team/memberKind";
import type { SessionOwnersChange, SessionOwnersView } from "../store/orgSlice";
import { driverKey } from "../lib/ownersDraft";

type OwnerInfo = {
  user_id: string;
  name: string | null;
  email: string | null;
  // Assignment provenance off the session_owners row (see sessionOwnership).
  added_by?: string;
  added_by_name?: string | null;
  added_at?: number;
  note?: string | null;
  seen_at?: number | null;
  image?: string | null;
  added_by_image?: string | null;
};

/** The role owner (sessionOwnership.OwnerRole): at most one per session. */
export type OwnerRole = {
  role_id: string;
  short_id: string;
  handle: string;
  name: string;
  avatar: string | null;
  hold?: "bound" | "filed";
};

/** Who drives: the filed role, or one of the people who own it. */
export type SessionDriver = { kind: "role"; role_id: string } | { kind: "user"; user_id: string };

/** The account that runs the session, whether or not it owns it. */
export type OwnerRunner = OwnerInfo & { is_bot: boolean };

/** The `sessionOwners` row: listOwners as the server answers it, keyed by the
 *  conversation. `owners`, `role` and `runner` are enrichment the server
 *  derives; `owner_ids`, `role_id` and `driver` are what a Save writes. */
export type SessionOwnersRow = {
  _id: string;
  short_id: string;
  conversation_id: string;
  owners: OwnerInfo[];
  owner_ids: string[];
  role: OwnerRole | null;
  role_id: string | null;
  driver: SessionDriver | null;
  driver_user_id: string | null;
  runner: OwnerRunner | null;
  can_edit: boolean;
};


/**
 * One handoff as the transcript draws it: who passed the session to whom, when,
 * and the note they wrote. Derived from the owner row the handoff created (a
 * self-claim is not a handoff).
 */
export type HandoffInfo = {
  to: string;
  to_name: string;
  to_image?: string | null;
  from: string;
  from_name: string;
  from_image?: string | null;
  at: number;
  note: string | null;
  seen: boolean;
};

export type OwnersEnv = {
  // Warm-paint fallback roster only: the picker overlays the SESSION team's
  // members via listOwnerCandidates (subscribed only while the menu is open).
  teamMembers: any[] | undefined;
  currentUser: any;
  notify?: (msg: string, kind: "success" | "error") => void;
  // The store write (useStoreOwnersEnv): applySessionOwners with the view it
  // paints and the change that puts it back.
  apply: (change: SessionOwnersChange, view: SessionOwnersView, inverse: { change: SessionOwnersChange; view: SessionOwnersView } | null) => void;
  // The assignee's acknowledgement (store ackSessionAssignment).
  ack: () => void;
  // A role's face for a role id the row does not describe yet (just added).
  roleById?: (roleId: string) => OwnerRole | null;
  // Human who started the session (author, else runner): the owner until the
  // row has loaded.
  implicitOwnerId?: string;
};

/**
 * Whether the live listOwners subscription should run. Skipped while the row
 * is an optimistic stub (client UUID, no server row yet) and whenever there is
 * no current user: every feature this hook powers is per-user, and a guest on
 * a share link has nothing to assign.
 */
export function shouldQueryOwners(conversationId: string, currentUser: unknown): boolean {
  return Boolean(conversationId && isConvexId(conversationId) && currentUser);
}

/**
 * The roster the picker offers. The server's list wins — listOwnerCandidates
 * returns the SESSION team's members, the only people the owner mutations
 * accept. The injected roster (the viewer's active team) is a warm-paint
 * fallback for while that query loads.
 */
export function pickRoster(
  serverMembers: any[] | undefined,
  injected: any[] | undefined,
): any[] {
  return serverMembers ?? injected ?? [];
}

/**
 * Session-team roster for the assignment picker. Skip while the menu is
 * closed: this is the collect that timed listOwners out when it ran for
 * every open conversation.
 */
export function useOwnerCandidates(
  conversationId: string,
  currentUser: unknown,
  enabled = true,
) {
  const { data } = useQueryNoThrow(
    api.sessionOwnership.listOwnerCandidates,
    enabled && shouldQueryOwners(conversationId, currentUser)
      ? { session_id: conversationId }
      : "skip",
  );
  return data?.team_members;
}

// A server from before the owners fields (a deploy gap) answers only `owners`:
// derive the rest so the header still draws, read-only.
const selectOwnersRow = (d: any) => (d ? [{
  owner_ids: (d.owners ?? []).map((o: OwnerInfo) => o.user_id), role: null, role_id: null, driver: null, driver_user_id: null, runner: null, can_edit: false,
  ...d, _id: String(d.conversation_id), conversation_id: String(d.conversation_id),
}] : []);
const ownersRowSig = (r: SessionOwnersRow) => [
  (r.owner_ids ?? []).join(","),
  r.role_id ?? "",
  r.role?.name ?? "",
  driverKey(r.driver) ?? "",
  r.driver_user_id ?? "",
  r.runner?.user_id ?? "",
  r.can_edit ? 1 : 0,
  (r.owners ?? []).map((o) => `${o.user_id}:${o.name ?? ""}:${o.image ?? ""}:${o.seen_at ?? ""}:${o.added_at ?? ""}`).join(","),
].join("|");

/** The row as a Save's view: what applySessionOwners writes. */
export const viewOfRow = (r: Pick<SessionOwnersRow, "owner_ids" | "role_id" | "driver">): SessionOwnersView => ({ owner_ids: r.owner_ids, role_id: r.role_id, driver: r.driver });

export function useOwners(conversationId: string, env: OwnersEnv) {
  const { teamMembers, currentUser, implicitOwnerId } = env;

  // The feeder: useQueryNoThrow underneath, so a timeout or a client ahead of
  // a deploy keeps the cached row and never unmounts the conversation.
  const feed = useSyncCollection(
    "sessionOwners",
    api.sessionOwnership.listOwners,
    shouldQueryOwners(conversationId, currentUser) ? { session_id: conversationId } : "skip",
    { select: selectOwnersRow },
  );
  const where = useMemo(() => (r: SessionOwnersRow) => r._id === conversationId, [conversationId]);
  const row = useCollectionRows<SessionOwnersRow>("sessionOwners", { where, sig: ownersRowSig })[0] ?? null;

  const ownerList: string[] = row ? row.owner_ids : implicitOwnerId ? [implicitOwnerId] : [];
  const ownerIds = useMemo(() => new Set(ownerList), [ownerList.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const role: OwnerRole | null = !row?.role_id ? null
    : row.role?.role_id === row.role_id ? row.role
    : env.roleById?.(row.role_id) ?? { role_id: row.role_id, short_id: "", handle: "", name: "Role", avatar: null };
  const driver = row?.driver ?? null;
  const runner = row?.runner ?? null;

  const roster: any[] = useMemo(() => teamMembers ?? [], [teamMembers]);
  const memberById = useMemo(() => {
    const m = new Map<string, any>();
    for (const mem of roster) if (mem?._id) m.set(mem._id, mem);
    return m;
  }, [roster]);

  const displayFor = (id: string) => {
    const mem = memberById.get(id);
    const info = (row?.owners ?? []).find((o) => o.user_id === id) ?? (runner?.user_id === id ? runner : undefined);
    const name =
      mem?.name || info?.name || mem?.email?.split("@")[0] || info?.email?.split("@")[0] || "Teammate";
    return { name, image: mem?.image || mem?.github_avatar_url || info?.image || undefined };
  };

  const meId = currentUser?._id?.toString?.();

  // Every handoff the owner rows record, oldest first. Visible to every
  // viewer: the transcript marks where each transfer landed.
  const handoffs: HandoffInfo[] = useMemo(() => {
    const out: HandoffInfo[] = [];
    for (const o of row?.owners ?? []) {
      if (!o.added_by || o.added_by === o.user_id || !o.added_at) continue;
      const from = memberById.get(o.added_by);
      const to = memberById.get(o.user_id);
      out.push({
        to: o.user_id,
        to_name: to?.name || o.name || to?.email?.split("@")[0] || o.email?.split("@")[0] || "Teammate",
        to_image: to?.image || to?.github_avatar_url || o.image,
        from: o.added_by,
        from_name: from?.name || o.added_by_name || from?.email?.split("@")[0] || "A teammate",
        from_image: from?.image || from?.github_avatar_url || o.added_by_image,
        at: o.added_at,
        note: o.note ?? null,
        seen: !!o.seen_at,
      });
    }
    return out.sort((a, b) => a.at - b.at);
  }, [row, memberById]);

  /** One Save: `view` paints on the row now, `change` goes to the server, and
   *  `inverse` (null when nothing can put it back, as after a move) is undo's. */
  const applyChange = (change: SessionOwnersChange, view: SessionOwnersView, inverse: { change: SessionOwnersChange; view: SessionOwnersView } | null) => {
    if (!row) return;
    env.apply(change, view, inverse);
  };

  // Who drives once `removed` is gone: the role, else the first person left.
  const fallbackDriver = (ids: string[], roleId: string | null): SessionDriver | null =>
    roleId ? { kind: "role", role_id: roleId } : ids[0] ? { kind: "user", user_id: ids[0] } : null;

  /** The phone's single toggle: add or remove one person; `note` rides an add
   *  to the person added. */
  const toggle = (id: string, note?: string) => {
    if (!row) return;
    const before = viewOfRow(row);
    const removing = ownerIds.has(id);
    const owner_ids = removing ? row.owner_ids.filter((x) => x !== id) : [...row.owner_ids, id];
    const driver = removing && driverKey(row.driver) === `p:${id}` ? fallbackDriver(owner_ids, row.role_id) : row.driver;
    const change: SessionOwnersChange = removing ? { remove: [id] } : { add: [id], ...(note?.trim() ? { note: note.trim() } : {}) };
    applyChange(change, { owner_ids, role_id: row.role_id, driver }, { change: removing ? { add: [id] } : { remove: [id] }, view: before });
  };

  /** File the session under a role: the role becomes an owner and drives. */
  const moveToRole = (roleId: string, _roleName?: string) => {
    if (!row) return;
    applyChange({ role: roleId }, { owner_ids: row.owner_ids, role_id: roleId, driver: { kind: "role", role_id: roleId } },
      { change: { role: row.role_id, driver: row.driver_user_id ? { kind: "user", user_id: row.driver_user_id } : { kind: "none" } }, view: viewOfRow(row) });
  };

  /** Remove every person (the phone's "clear"); the role stays. */
  const clearAll = () => {
    if (!row || row.owner_ids.length === 0) return;
    applyChange({ remove: row.owner_ids }, { owner_ids: [], role_id: row.role_id, driver: fallbackDriver([], row.role_id) },
      { change: { add: row.owner_ids }, view: viewOfRow(row) });
  };

  // Bots (Mr Bot, Anchors) can't own a session — a bot's inbox is nobody's.
  const selectable = peopleOf(roster as any[]);

  // The current user's own UNACKED handoff (someone else assigned them, no
  // seen_at) — drives the "assigned to you" banner. The store's ack stamps
  // seen_at on the row, which hides it in the same tick.
  const myRow = meId ? (row?.owners ?? []).find((o) => o.user_id === meId) : undefined;
  // The handoff: my owner row when someone ELSE added me. Outlives the ack —
  // the conversation marks where in the timeline the handoff landed for as
  // long as I own the session, not just until I press "Got it".
  const handoff = myRow && myRow.added_by && myRow.added_by !== meId ? myRow : null;
  const myAssignment = handoff && !handoff.seen_at ? handoff : null;
  const ack = env.ack;

  // Whether the viewer may see the owners at all (false: the server refused
  // or failed, undefined: not answered yet), and whether they may change them.
  // A refusal or a failure wins over a cached row: the controls go rather than offer a write the server refuses.
  const canManage = feed.refused || feed.error ? false : row ? true : undefined;
  const canEdit = !!row?.can_edit;
  return { row, ownerIds, ownerList, implicitOwnerId, role, driver, runner, displayFor, toggle, moveToRole, applyChange, handoffs, clearAll, selectable, currentUser, handoff, myAssignment, ack, canManage, canEdit };
}

export type OwnersApi = ReturnType<typeof useOwners>;
