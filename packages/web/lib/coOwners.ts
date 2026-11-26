// The co-owners an inbox card shows beside its time under the session_owners
// model: the session's OTHER owners (people in the order added, then its role,
// then the session that owns it). Read from the store alone: who owns it is
// the owners read (`sessionOwners`, fed for the cards on screen by
// hooks/useSyncVisibleSessionOwners), the same facts the header reads
// (ownerFactsOf), so the card and the header agree. Until the read lands the card shows no faces;
// a session only you own shows none either.
import { ownerFactsOf, ownerIdsOf, ownersModelOnFor, ownersReadOf, seatRoleOf } from "../store/sessionOwnersSlice";

type Member = { _id: string; name?: string; email?: string; image?: string; github_avatar_url?: string };
type State = Parameters<typeof ownerIdsOf>[0];

export type CoOwners = {
  people: Array<{ key: string; name: string; image?: string }>;
  more: number;
  role: { _id: string; handle: string; name?: string } | null;
  parentId: string | null;
  title: string;
};

const MAX_PEOPLE = 3;

export function coOwnersOf(s: State, conversationId: string, meId: string | null, members: readonly Member[]): CoOwners | null {
  if (!ownersModelOnFor(s, conversationId)) return null;
  const read = ownersReadOf(s, conversationId);
  const facts = ownerFactsOf(s, conversationId);
  const ids = ownerIdsOf(s, conversationId);
  if (!read || !facts || !ids) return null;
  // The same facts the header reads: a change the server has not answered
  // shows here as it does there.
  const others = ids.filter((id) => id !== meId);
  const roleId = facts.org_role_id ? String(facts.org_role_id) : null;
  const parentLink = facts.parent_conversation_id ? String(facts.parent_conversation_id) : null;
  // A parent that is the role's own standing session is that role: one owner.
  const parentId = parentLink && !(roleId && seatRoleOf(s, parentLink) === roleId) ? parentLink : null;
  if (!others.length && !roleId && !parentId) return null;
  const person = (id: string) => {
    const m = members.find((x) => String(x._id) === id);
    const info = read.people_info[id] ?? (read.implicit_starter?.user_id === id ? read.implicit_starter : null);
    return { name: m?.name || info?.name || m?.email?.split("@")[0] || info?.email?.split("@")[0] || "Teammate", image: m?.image || m?.github_avatar_url || info?.image || undefined };
  };
  const snap = read.role?.role_id === roleId ? read.role : null;
  const role = roleId ? { _id: roleId, handle: snap?.handle ?? "", name: snap?.name } : null;
  const parentTitle = parentId ? (read.parent_session?.conversation_id === parentId ? read.parent_session.title : null) ?? "the session that started it" : null;
  const names = [
    ...ids.map((id) => (id === meId ? "You" : person(id).name)),
    ...(role ? [role.name ?? (role.handle ? `@${role.handle}` : "its role")] : []),
    ...(parentTitle ? [parentTitle] : []),
  ];
  return {
    people: others.slice(0, MAX_PEOPLE).map((id) => ({ key: id, ...person(id) })),
    more: Math.max(0, others.length - MAX_PEOPLE),
    role,
    parentId,
    title: `Owners: ${names.join(", ")}`,
  };
}

/** What the card's faces read, as one string: their wake signature. */
export function coOwnersSig(s: State, conversationId: string): string {
  if (!ownersModelOnFor(s, conversationId)) return "";
  const read = ownersReadOf(s, conversationId);
  const facts = ownerFactsOf(s, conversationId);
  if (!read || !facts) return "-";
  return [
    (ownerIdsOf(s, conversationId) ?? []).join(","),
    facts.org_role_id ?? "",
    facts.parent_conversation_id ?? "",
    seatRoleOf(s, facts.parent_conversation_id) ?? "",
    read.role?.name ?? "",
    read.parent_session?.title ?? "",
    read.people_ids.map((id) => `${id}=${read.people_info[id]?.name ?? ""}:${read.people_info[id]?.image ?? ""}`).join(";"),
  ].join("|");
}
