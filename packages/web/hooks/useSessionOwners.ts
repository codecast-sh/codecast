"use client";

/**
 * A session's owners under the session_owners model, read off the store
 * (store/sessionOwnersSlice): its people, its role, the session that owns it,
 * with the names and faces the header, the menu and the composer strip draw.
 * `on` is false for a session off the model, which draws today's UI.
 *
 * Subscribes to one string of what it draws, never the whole row: the inbox
 * row's other fields move on every heartbeat.
 *
 * MOBILE-SAFE: no DOM.
 */

import { useInboxStore } from "../store/inboxStore";
import { isInboxMember, underOwnersModel } from "@codecast/shared/contracts";
import { ownerFactsOf, ownerIdsOf, ownersHomeOf, ownersModelOnFor, ownersReadOf, seatRoleOf, type SessionOwnersRow } from "../store/sessionOwnersSlice";
import { useOrgRoles } from "./useOrgRoles";
import { teamMembersOf } from "../lib/activeTeam";
import type { DraftRole, OwnersDraft } from "../lib/ownersDraft";
import type { OrgRole } from "../components/org/orgTypes";

export type OwnerPerson = { _id: string; name: string; image?: string };
export type OwnerRoleFace = DraftRole & { avatar?: string | null; icon?: any };

export const memberName = (m: any): string => m?.name || m?.email?.split("@")[0] || "Teammate";
export const roleOwnerOf = (r: OrgRole): OwnerRoleFace => ({ role_id: r._id, short_id: r.short_id, handle: r.handle, name: r.name, avatar: (r as any).avatar ?? null, icon: (r as any).icon ?? null });
/** RoleFace's spelling of a role. */
export const roleLikeOf = (r: OwnerRoleFace) => ({ _id: r.role_id, short_id: r.short_id ?? undefined, handle: r.handle, name: r.name, avatar: r.avatar ?? null, icon: r.icon ?? null });

const NONE = "";

/** The parent session as an owner of its own, or null when it is the role's
 *  own standing session: the same agent, so the role stands for both. */
export function shownParentOf(view: Pick<SessionOwnersView, "parent" | "role">): SessionOwnersView["parent"] {
  return view.parent && !(view.role && view.parent.seatRoleId === view.role.role_id) ? view.parent : null;
}

/** What the owners UI draws of a session, as one string: its wake signature. */
function ownersSig(s: any, conversationId: string): string {
  if (!ownersModelOnFor(s, conversationId)) return NONE;
  const home = ownersHomeOf(s, conversationId);
  const read = ownersReadOf(s, conversationId);
  const facts = ownerFactsOf(s, conversationId);
  const ids = ownerIdsOf(s, conversationId) ?? [];
  return [
    "on",
    ids.join(","),
    facts ? facts.org_role_id ?? "" : home?.org_role_id ?? "",
    facts ? facts.parent_conversation_id ?? "" : home?.owner_session_id ?? "",
    seatRoleOf(s, facts ? facts.parent_conversation_id : home?.owner_session_id) ?? "",
    home && isInboxMember(home, s.currentUser?._id) ? "member" : "",
    read ? `${read.owners_changed_at ?? ""}:${read.can_edit ? 1 : 0}:${read.role?.name ?? ""}:${read.parent_session?.title ?? ""}:${read.people_ids.map((id) => `${id}=${read.people_info[id]?.name ?? ""}`).join(";")}` : "-",
    home?.user_id ?? "",
  ].join("|");
}

export type SessionOwnersView = {
  on: boolean;
  meId: string | null;
  people: OwnerPerson[];
  role: OwnerRoleFace | null;
  /** The session that owns it, with its title when the viewer may read it,
   *  and the role it is the standing session of. */
  parent: { id: string; title: string; seatRoleId: string | null } | null;
  /** The agent that answers it: its role, else its parent session. */
  agent: { kind: "role"; role: OwnerRoleFace } | { kind: "session"; id: string; title: string } | null;
  mine: boolean;
  canEdit: boolean;
  /** The owners as the menu stages them. */
  draft: OwnersDraft;
  read: SessionOwnersRow | null;
  runnerId: string | null;
  personOf: (id: string) => OwnerPerson;
};

const OFF: SessionOwnersView = {
  on: false, meId: null, people: [], role: null, parent: null, agent: null, mine: false, canEdit: false,
  draft: { people: [], role: null, parent: null }, read: null, runnerId: null, personOf: (id) => ({ _id: id, name: "Teammate" }),
};

export function useSessionOwners(conversationId: string): SessionOwnersView {
  // The signature gates the re-render; the body reads the state it names.
  useInboxStore((s) => ownersSig(s, conversationId));
  const roster = useInboxStore(teamMembersOf) as any[];
  const currentUser = useInboxStore((s) => s.currentUser);
  const { roles } = useOrgRoles();
  const s = useInboxStore.getState() as any;
  if (!ownersModelOnFor(s, conversationId)) return OFF;
  const home = ownersHomeOf(s, conversationId);
  const read = ownersReadOf(s, conversationId);
  const facts = ownerFactsOf(s, conversationId);
  const meId = currentUser?._id ? String(currentUser._id) : null;
  const ids = ownerIdsOf(s, conversationId) ?? [];
  const personOf = (id: string): OwnerPerson => {
    if (id === meId && currentUser) return { _id: id, name: memberName(currentUser), image: currentUser.image || currentUser.github_avatar_url || undefined };
    const m = roster.find((x) => String(x._id) === id);
    const info = read?.people_info[id] ?? (read?.implicit_starter && String(read.implicit_starter.user_id) === id ? read.implicit_starter : null);
    return { _id: id, name: m ? memberName(m) : info?.name || info?.email?.split("@")[0] || "Teammate", image: m?.image || m?.github_avatar_url || info?.image || undefined };
  };
  // Before the owners read lands, the row still names its role and parent.
  const roleId = facts ? (facts.org_role_id ? String(facts.org_role_id) : null) : home?.org_role_id ? String(home.org_role_id) : null;
  const live = roleId ? roles.find((r) => r._id === roleId) : undefined;
  const role: OwnerRoleFace | null = !roleId ? null
    : live ? roleOwnerOf(live)
      : read?.role?.role_id === roleId ? { role_id: roleId, short_id: read.role.short_id, handle: read.role.handle, name: read.role.name }
        : (home?.role && String(home.role._id) === roleId) ? { role_id: roleId, short_id: home.role.short_id, handle: home.role.handle, name: home.role.name ?? home.role.handle, avatar: home.role.avatar }
          : { role_id: roleId, handle: "role", name: "Role" };
  const parentId = facts ? (facts.parent_conversation_id ? String(facts.parent_conversation_id) : null) : home?.owner_session_id ? String(home.owner_session_id) : null;
  const parentTitle = parentId
    ? (read?.parent_session?.conversation_id === parentId ? read.parent_session.title : null) ?? s.sessions?.[parentId]?.title ?? s.conversations?.[parentId]?.title ?? "Session that started it"
    : null;
  const parent = parentId ? { id: parentId, title: parentTitle!, seatRoleId: seatRoleOf(s, parentId) } : null;
  const runnerId = home?.user_id ? String(home.user_id) : null;
  return {
    on: true,
    meId,
    people: ids.map(personOf),
    role,
    parent,
    agent: role ? { kind: "role", role } : parent ? { kind: "session", id: parent.id, title: parent.title } : null,
    // Owning it, or holding it in the inbox as the person its wait reached.
    // The inbox row's stamps decide (a change paints them); with no inbox row
    // under the model, the owners read.
    mine: !!meId && (home && underOwnersModel(home) ? isInboxMember(home, meId) : ids.includes(meId)),
    canEdit: read ? read.can_edit : !!meId && (ids.includes(meId) || runnerId === meId),
    draft: { people: ids, role, parent: parentId },
    read,
    runnerId,
    personOf,
  };
}
