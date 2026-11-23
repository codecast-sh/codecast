"use client";

/**
 * The OWNERS of a session: the people whose inboxes it is in, at most one
 * role, who drives (messages the agent) and the account that runs it. Shared
 * by the web header (AssignmentBadge, OwnersMenu) and the mobile
 * AssignmentChip.
 *
 * Local-first: listOwners FEEDS the `sessionOwners` store collection (the
 * menu's details, one row per conversation) and the session row's owner_ids,
 * which the inbox rows feed too; who owns it, the role and the driver come
 * from the session row, their one home. Every write is the
 * store's applySessionOwners action, which paints each fact in its home by the
 * rule the server runs (shared/contracts/sessionOwners) before
 * applyOwnersChange lands; a refusal rolls it back through the store's own
 * refusal path.
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
import { driverOf, listedOwnerIds, ownersFactsFromRead, type OwnerRowFact } from "@codecast/shared/contracts/sessionOwners";
import { useInboxStore } from "../store/inboxStore";
import type { SessionOwnersChange } from "../store/sessionOwnersSlice";

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

/** The `sessionOwners` row: the owners menu's details, as listOwners answers,
 *  keyed by the conversation: the owners with names and stamps, the runner,
 *  the author, the agent accounts and the role's face. Who owns it (owner_ids),
 *  the role and the driver live on the session row, their one home. */
export type SessionOwnersRow = {
  _id: string;
  short_id: string;
  conversation_id: string;
  owners: (OwnerInfo & { implicit?: boolean })[];
  /** The filed role's face (name, handle, avatar), for when the org tree is not loaded. */
  role: OwnerRole | null;
  runner: OwnerRunner | null;
  author_id: string | null;
  bots: string[];
  /** A role started it: while it is filed under a role, it has no starter owner. */
  role_started?: boolean;
  can_edit: boolean;
  /** The viewer reads it as a teammate, owner or not (a leave can be undone). */
  team_access?: boolean;
};

/** The session row's half of the owners facts: the role, the driver, the
 *  primary, the runner and the people (null: no feeder has written them yet). */
export type SessionOwnerFacts = { role_id: string | null; driver_user_id: string | null; primary_id: string | null; runner_id: string | null; owner_ids?: string[] | null };


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
  // The store write (useStoreOwnersEnv): applySessionOwners with the change
  // that puts it back.
  apply: (change: SessionOwnersChange, inverse: SessionOwnersChange | null) => void;
  // The session row's facts: the role, the driver, the primary, the runner.
  session: SessionOwnerFacts;
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

// The menu's details only: who owns it, the role and the driver the server
// also answers have their home on the session row (feedOwnerFacts puts them
// there). A server from before these fields (a deploy gap) answers
// only `owners`: default the rest so the header still draws, read-only.
export const selectOwnersRow = (d: any) => {
  if (!d) return [];
  const { role_id: _r, driver: _d, driver_user_id: _du, owner_ids: _o, ...details } = d;
  return [{
    role: null, runner: null, author_id: null, bots: [], can_edit: false,
    ...details, _id: String(d.conversation_id), conversation_id: String(d.conversation_id),
  }];
};
export const feedOwnerFacts = (d: any) => {
  if (!d || !Array.isArray(d.owner_ids)) return;
  useInboxStore.getState().feedSessionOwners(String(d.conversation_id), {
    owner_ids: d.owner_ids.map(String),
    ...("role_id" in d ? { org_role_id: d.role_id ?? null } : {}),
    ...("driver_user_id" in d ? { driver_user_id: d.driver_user_id ?? null } : {}),
  });
};
const ownersRowSig = (r: SessionOwnersRow) => [
  r.role?.role_id ?? "",
  r.role?.name ?? "",
  r.runner?.user_id ?? "",
  r.can_edit ? 1 : 0,
  r.team_access ? 1 : 0,
  (r.owners ?? []).map((o) => `${o.user_id}:${o.name ?? ""}:${o.image ?? ""}:${o.seen_at ?? ""}:${o.added_at ?? ""}`).join(","),
].join("|");

/** The rows a removal can be undone with: put back exactly as they were. */
export function snapshotsOf(row: Pick<SessionOwnersRow, "owners"> | null, ids: string[]): OwnerRowFact[] {
  return (row?.owners ?? []).filter((o) => !o.implicit && ids.includes(o.user_id) && o.added_at).map((o) => ({
    user_id: o.user_id, added_by: o.added_by ?? o.user_id, added_at: o.added_at!,
    ...(o.seen_at ? { seen_at: o.seen_at } : {}), ...(o.note ? { note: o.note } : {}),
  }));
}

/** Undo's change for a removal: the rows back in place, or a plain add for an owner who had none. */
function putBack(row: SessionOwnersRow | null, ids: string[]): SessionOwnersChange {
  const restore = snapshotsOf(row, ids);
  const add = ids.filter((id) => !restore.some((r) => r.user_id === id));
  return { ...(restore.length ? { restore } : {}), ...(add.length ? { add } : {}) };
}

export function useOwners(conversationId: string, env: OwnersEnv) {
  const { teamMembers, currentUser, implicitOwnerId } = env;

  // The feeder: useQueryNoThrow underneath, so a timeout or a client ahead of
  // a deploy keeps the cached row and never unmounts the conversation.
  const feed = useSyncCollection(
    "sessionOwners",
    api.sessionOwnership.listOwners,
    shouldQueryOwners(conversationId, currentUser) ? { session_id: conversationId } : "skip",
    { select: selectOwnersRow, alsoFeed: feedOwnerFacts },
  );
  const where = useMemo(() => (r: SessionOwnersRow) => r._id === conversationId, [conversationId]);
  const row = useCollectionRows<SessionOwnersRow>("sessionOwners", { where, sig: ownersRowSig })[0] ?? null;

  // The people off the session row; before a feeder wrote them there, by the
  // owners rule over the read (or its starter until the read lands).
  const ownerList: string[] = env.session.owner_ids
    ?? (row ? listedOwnerIds(ownersFactsFromRead(row, { org_role_id: env.session.role_id, driver_user_id: env.session.driver_user_id, owner_user_id: env.session.primary_id, user_id: env.session.runner_id }))
      : implicitOwnerId ? [implicitOwnerId] : []);
  const ownerIds = useMemo(() => new Set(ownerList), [ownerList.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const facts = env.session;
  const role: OwnerRole | null = !facts.role_id ? null
    : row?.role?.role_id === facts.role_id ? row.role
    : env.roleById?.(facts.role_id) ?? { role_id: facts.role_id, short_id: "", handle: "", name: "Role", avatar: null };
  const driver = driverOf(facts, ownerList) as SessionDriver | null;
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

  /** One Save: the store paints it by the shared rule, `change` goes to the
   *  server, and `inverse` (null when nothing can put it back) is undo's. */
  const applyChange = (change: SessionOwnersChange, inverse: SessionOwnersChange | null) => {
    if (!row) return;
    env.apply(change, inverse);
  };

  /** The phone's single toggle: add or remove one person; `note` rides an add
   *  to the person added. Taking yourself off is a leave. */
  const toggle = (id: string, note?: string) => {
    if (!row) return;
    if (ownerIds.has(id)) {
      applyChange({ remove: [id] }, id === meId ? null : putBack(row, [id]));
      return;
    }
    applyChange({ add: [id], ...(note?.trim() ? { note: note.trim() } : {}) }, { remove: [id] });
  };

  /** File the session under a role: the role becomes an owner and drives. */
  const moveToRole = (roleId: string, _roleName?: string) => {
    if (!row) return;
    applyChange({ role: roleId }, { role: facts.role_id, driver: facts.driver_user_id ? { kind: "user", user_id: facts.driver_user_id } : { kind: "none" } });
  };

  /** The phone's "clear": everyone but you comes off; the role stays. */
  const clearAll = () => {
    if (!row) return;
    const others = ownerList.filter((id) => id !== meId);
    if (others.length) applyChange({ remove: others }, putBack(row, others));
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
  return { row, session: facts, ownerIds, ownerList, implicitOwnerId, role, driver, runner, displayFor, toggle, moveToRole, applyChange, handoffs, clearAll, selectable, currentUser, handoff, myAssignment, ack, canManage, canEdit };
}

export type OwnersApi = ReturnType<typeof useOwners>;
