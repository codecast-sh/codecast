// The company's objects as the Org screen finds them in the store: a goal, a
// project, a role or a person by any ref a link may carry, the short ref its
// address takes, and who answers for it (D5, D6). Pure: every reader passes
// the rows it already holds, so the screen, a sheet and a test share one rule.
import { isConvexId, orgObjectOfRef, personRefOf, type OrgObjectKind } from "@codecast/shared/entities";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { isInitiativeKey, ownerSeat } from "../../../lib/initiatives";
import { namedLead } from "../lines/lineData";
import { roleWords } from "../orgStaffingTypes";
import type { GoalProject } from "../goalsLayout";
import type { OrgPerson, OrgRole, OrgTree } from "../orgTypes";
import { findHeadOfPeople } from "../staffingModel";
import type { SheetRef } from "./sheetStack";

export type Member = { _id: string; name?: string; github_username?: string; image?: string; github_avatar_url?: string };

const norm = (ref: string) => ref.trim().replace(/^@/, "").toLowerCase();

export function findGoal(rows: readonly InitiativeRow[], ref: string): InitiativeRow | undefined {
  const r = norm(ref);
  return rows.find((g) => g._id === ref || (!!g.short_id && g.short_id.toLowerCase() === r) || g.client_key === ref);
}

export function findProject<P extends GoalProject>(rows: readonly P[], ref: string): P | undefined {
  const r = norm(ref);
  return rows.find((p) => p._id === ref || (!!p.short_id && p.short_id.toLowerCase() === r) || p.client_key === ref);
}

export function findRole(tree: OrgTree | null | undefined, ref: string): OrgRole | undefined {
  const r = norm(ref);
  return tree?.roles.find((x) => x._id === ref || x.short_id.toLowerCase() === r || x.handle.toLowerCase() === r);
}

/** A person by handle or user id: the roster names the handle. */
export function findPerson(tree: OrgTree | null | undefined, members: readonly Member[], ref: string): { person: OrgPerson | null; member: Member | null } {
  const r = norm(ref);
  const member = members.find((m) => String(m._id) === ref || m.github_username?.toLowerCase() === r) ?? null;
  const id = member ? String(member._id) : ref;
  return { person: tree?.people.find((p) => p.user_id === id) ?? null, member };
}

/** Whether a ref can be an Org screen address (/org/<ref>): a short ref (`in-N`,
 *  `pj-…`, `or-N`, `@handle`), a goal's stub key, or a Convex id. Anything else
 *  is a scope page, so an object is never sent there by a ref it cannot hold. */
export function namesOrgObject(ref: string): boolean {
  return !!orgObjectOfRef(ref) || isInitiativeKey(ref) || isConvexId(ref);
}

/** The ref an object's address takes: its short id, a person's handle. A goal
 *  still a stub keeps its key until the server mints its `in-N`. */
export function canonicalRef(s: SheetRef, rows: { goals: readonly InitiativeRow[]; projects: readonly GoalProject[]; tree: OrgTree | null; members: readonly Member[] }): string | null {
  if (s.kind === "initiative") { const g = findGoal(rows.goals, s.ref); return g ? g.short_id || g.client_key || g._id : null; }
  if (s.kind === "project") { const p = findProject(rows.projects, s.ref); return p ? p.short_id || p._id : null; }
  if (s.kind === "role") return findRole(rows.tree, s.ref)?.short_id ?? null;
  const { person, member } = findPerson(rows.tree, rows.members, s.ref);
  if (member) return personRefOf({ _id: String(member._id), github_username: member.github_username });
  return person ? person.user_id : null;
}

/** Who answers for an object, as a conversation to sit beside it. */
export type Seat = {
  conversationId: string;
  /** Whom the composer and the chip address. */
  name: string;
  /** The role whose standing session it is; null for a person's own agent. */
  role: OrgRole | null;
  /** Why this seat: "owner of …", "lead of …", "@handle". */
  caption: string | null;
};

/** The responsible party's conversation (D5): a goal's owner seat, a
 *  project's lead, a role's own standing session. A person answers in their
 *  own messages, not a seat, and the Head of People is the screen's default,
 *  so both come back null: the left pane is then the Head of People. */
export function seatFor(s: SheetRef | null, rows: { goals: readonly InitiativeRow[]; projects: readonly GoalProject[]; tree: OrgTree | null }): Seat | null {
  const { tree } = rows;
  if (!s || !tree) return null;
  const head = findHeadOfPeople(tree);
  const roleSeat = (role: OrgRole | undefined | null, caption: string | null): Seat | null => {
    const conv = role?.standing?.conversation_id;
    if (!role || !conv || role._id === head?._id) return null;
    // Named as the map names the role: "Talk to …" and "Ask …" say what its node says.
    return { conversationId: conv, name: roleWords(role).name, role, caption };
  };
  if (s.kind === "role") { const role = findRole(tree, s.ref); return roleSeat(role, role ? `@${role.handle}` : null); }
  if (s.kind === "project") {
    const p = findProject(rows.projects, s.ref);
    const live = tree.roles.filter((r) => r.status !== "retired");
    return p ? roleSeat(namedLead(p, live), `lead of ${p.title}`) : null;
  }
  if (s.kind === "initiative") {
    const g = findGoal(rows.goals, s.ref);
    if (!g) return null;
    const seat = ownerSeat(tree, g.owner);
    if (!seat.conversationId || seat.conversationId === head?.standing?.conversation_id) return null;
    return { conversationId: seat.conversationId, name: seat.speaker ?? "the owner", role: seat.role, caption: `owner of ${g.title}` };
  }
  return null;
}
