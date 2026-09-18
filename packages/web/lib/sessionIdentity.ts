// The one resolver for who a session is (docs/architecture/session-characters.md
// S1). Every surface that draws a face or a name for a session calls this and
// nothing else reads the character fields or the role pointers.
//
// Three answers, and the first one that fits wins:
//   role      a role's standing session wears the ROLE — its face and name are
//             the role's, and it is personified whether or not anyone opted in,
//             because the role IS the identity (org-staffing.md S13).
//   character somebody gave this session a face or a name, or the workspace
//             asked for every session to have one.
//   plain     nobody opted in: the session renders the way it always has, a
//             title and its agent's icon. This is the DEFAULT, so turning the
//             feature on is a choice rather than something that happens to you.
import { characterOf, defaultCharacterFor, type Character } from "@codecast/shared/contracts/sessionCharacter";
import { isAvatarKey, defaultAvatarFor, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import type { SessionRoleSnapshot } from "../store/inboxStore";

export type IdentityRow = {
  _id: string;
  title?: string | null;
  character_avatar?: string | null;
  character_name?: string | null;
  standing_role_id?: string | null;
  org_role_id?: string | null;
  role?: SessionRoleSnapshot | null;
  escalated_by_role?: { role_id: string; line: string; at: number } | null;
};

export type SessionIdentity =
  | { kind: "plain"; reportsTo: SessionRoleSnapshot | null }
  | { kind: "character"; avatar: AvatarKey; name: string; chosen: boolean; reportsTo: SessionRoleSnapshot | null }
  | { kind: "role"; avatar: AvatarKey; name: string; handle: string; role: SessionRoleSnapshot };

/** The one resolver every surface calls. `personifyAll` is the workspace
 *  switch; identity components read it via usePersonifyAll (hooks/) rather
 *  than importing the store from this module. */
export function sessionIdentity(row: IdentityRow, personifyAll = false): SessionIdentity {
  if (row.standing_role_id && row.role) {
    const r = row.role;
    return { kind: "role", avatar: isAvatarKey(r.avatar) ? r.avatar : defaultAvatarFor(r.handle), name: r.name, handle: r.handle, role: r };
  }
  const reportsTo = row.org_role_id && row.role ? row.role : null;
  const c: Character = characterOf(row);
  if (!c.chosen && !personifyAll) return { kind: "plain", reportsTo };
  return { kind: "character", avatar: c.avatar, name: c.name, chosen: c.chosen, reportsTo };
}

/** The character a row WOULD wear — what the picker opens on, and what the
 *  "personify this session" gesture writes. Independent of whether it is
 *  personified yet, so opting in shows the same face the preview promised. */
export function characterFor(row: IdentityRow): Character {
  const c = characterOf(row);
  return c.chosen ? c : defaultCharacterFor(row._id);
}

/** The card line's parts. `name` is null for a plain session, which renders
 *  exactly as it always did: the title alone. A role drops a title that only
 *  repeats its name (a standing session's title IS the role's name, S16). */
export function identityLine(
  row: IdentityRow,
  title: string | null | undefined,
  personifyAll = false,
): { name: string | null; title: string | null; handle: string | null } {
  const id = sessionIdentity(row, personifyAll);
  const t = (title ?? "").trim();
  if (id.kind === "plain") return { name: null, title: t || null, handle: null };
  if (id.kind === "role") return { name: id.name, title: t && t !== id.name ? t : null, handle: id.handle };
  return { name: id.name, title: t || null, handle: null };
}

/** The role a row IS the standing session of, or null. The inbox reads it to
 *  put the role's one number on its card (org-roles-run-work.md R1). */
export function standingRoleIdOf(row: IdentityRow): string | null {
  return row.standing_role_id ?? null;
}

/** The role a session reports to, when the role still looks after it: the
 *  session renders as a small row under that role's card. An escalated session
 *  answers null here and `escalationOf` instead. */
export function roleLookingAfter(row: IdentityRow): SessionRoleSnapshot | null {
  if (row.standing_role_id || row.escalated_by_role) return null;
  return row.org_role_id && row.role ? row.role : null;
}

/** A role put this session in front of the person: who, and the one line that
 *  says what the person will decide. `role` is null when the row's snapshot
 *  has not arrived, and the line still renders. */
export function escalationOf(row: IdentityRow): { role: SessionRoleSnapshot | null; line: string; at: number } | null {
  const e = row.escalated_by_role;
  if (!e) return null;
  return { role: row.role && row.role._id === e.role_id ? row.role : null, line: e.line, at: e.at };
}

/** The identity fields alone, lifted off a bigger row. Surfaces that carry a
 *  session into another shape — a mention item, a dropdown's live snapshot —
 *  pass this instead of the whole row, so they neither copy a session's churn
 *  nor read the character fields themselves. */
export function identityRowOf(row: IdentityRow & Record<string, unknown>): IdentityRow {
  return {
    _id: row._id,
    title: row.title ?? null,
    character_avatar: row.character_avatar ?? null,
    character_name: row.character_name ?? null,
    standing_role_id: row.standing_role_id ?? null,
    org_role_id: row.org_role_id ?? null,
    role: row.role ?? null,
  };
}
