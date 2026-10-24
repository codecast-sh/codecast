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
import { isAvatarKey, defaultAvatarFor, avatarOf, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";
import type { SessionRoleSnapshot } from "../store/inboxStore";
import { assistantLabel } from "./conversationBlockStyles";

export type IdentityRow = {
  _id: string;
  title?: string | null;
  character_avatar?: string | null;
  character_name?: string | null;
  standing_role_id?: string | null;
  org_role_id?: string | null;
  /** The bot identity a role's standing session acts as. A row that carries
   *  no role pointer of its own (a thin row, a conversation stub) is still
   *  found to be a role's through it. */
  acting_user_id?: string | null;
  role?: SessionRoleSnapshot | null;
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
    const avatar = isAvatarKey(r.avatar) ? r.avatar : defaultAvatarFor(r.handle);
    // The role's given name (org-staffing.md S30), never its title: "Hazel",
    // not "Cam's Engineering Co-worker".
    return { kind: "role", avatar, name: roleIdentity({ ...r, avatar }).name, handle: r.handle, role: r };
  }
  const reportsTo = row.org_role_id && row.role ? row.role : null;
  const c: Character = characterOf(row);
  if (!c.chosen && !personifyAll) return { kind: "plain", reportsTo };
  return { kind: "character", avatar: c.avatar, name: c.name, chosen: c.chosen, reportsTo };
}

/** Who an agent speaks as wherever its words are shown: a role's given name,
 *  a character's name, or for a plain session its agent's product name.
 *  `identity` is null for a plain session, which keeps the agent's mark. */
export function speakerOf(row: IdentityRow | null, agentType?: string | null, personifyAll = false): {
  name: string;
  identity: Exclude<SessionIdentity, { kind: "plain" }> | null;
} {
  const id = row ? sessionIdentity(row, personifyAll) : null;
  if (!id || id.kind === "plain") return { name: assistantLabel(agentType ?? undefined), identity: null };
  return { name: id.name, identity: id };
}

/** Where a role's identity lives: the role rows (the org tree's `roles`, fed
 *  app wide by org.roles) and the seats pairing each role with its bot user.
 *  One home per fact: a role's name and face are read from its row, never
 *  from the bot user minted for it, whose name is the title it was born with. */
export type RoleRows = {
  roles: readonly { _id: string; short_id: string; name: string; handle: string; avatar?: string | null; status: string; given_name?: string | null; tenure?: { kind: "standing" | "program" } | null; assistant?: IdentityRoleRow["assistant"]; scope_type?: "team" | "user" }[];
  anchors: readonly { bot_user_id: string; org_role_id?: string | null }[];
};

/** The role a row is the standing session of: its own pointer, else the role
 *  whose bot it acts as. */
export function standingRoleOf(row: IdentityRow, rows: RoleRows | null | undefined): string | null {
  if (row.standing_role_id) return row.standing_role_id;
  if (!row.acting_user_id || !rows) return null;
  return rows.anchors.find((a) => a.bot_user_id === row.acting_user_id && a.org_role_id)?.org_role_id ?? null;
}

/** The row with its role read from the role rows, so every surface draws the
 *  role as it is now (a rename, a new face) and a row the server sent without
 *  a snapshot still wears its role. Returns the row itself when there is no
 *  live role to read. */
export function withLiveRole<T extends IdentityRow>(row: T, rows: RoleRows | null | undefined): T {
  const roleId = standingRoleOf(row, rows);
  const live = roleId ? rows?.roles.find((r) => r._id === roleId) : null;
  if (!live) return row;
  const role: SessionRoleSnapshot = {
    _id: live._id, short_id: live.short_id, name: live.name, handle: live.handle,
    avatar: avatarOf(live), status: live.status, tenure_kind: live.tenure?.kind ?? "standing",
    given_name: live.given_name ?? null,
  };
  return { ...row, standing_role_id: roleId, role };
}

type IdentityRoleRow = Parameters<typeof roleIdentity>[0];

/** The role a user is the bot of, as a person reads it: the given name, the
 *  role's subtitle ("Head of People", "Executive Assistant, global"), its
 *  handle and face. Null for anyone who is not a role's bot. The roster and
 *  chat name a role's bot user through this; the bot user itself keeps the
 *  title it was born with, which chat's mention handles are derived from. */
export function roleOfUser(userId: string | null | undefined, rows: RoleRows | null | undefined): { roleId: string; name: string; title: string; handle: string; shortId: string; face: AvatarKey } | null {
  if (!userId) return null;
  const roleId = standingRoleOf({ _id: "", acting_user_id: userId }, rows);
  const r = roleId ? rows?.roles.find((x) => x._id === roleId) : null;
  if (!r) return null;
  const face = avatarOf(r);
  const id = roleIdentity({ ...r, avatar: face });
  return { roleId: r._id, name: id.name, title: id.subtitle, handle: r.handle, shortId: r.short_id, face };
}

/** A wake signature of what withLiveRole reads for this row. */
export function liveRoleSig(row: IdentityRow | null | undefined, rows: RoleRows | null | undefined): string {
  if (!row) return "";
  const roleId = standingRoleOf(row, rows);
  const r = roleId ? rows?.roles.find((x) => x._id === roleId) : null;
  return r ? `${r._id}|${r.name}|${r.handle}|${r.avatar ?? ""}|${r.given_name ?? ""}|${r.status}` : "";
}

/** The author a role's standing session is shown as: the role's given name
 *  and face. Null for any other row. */
export function roleAuthorOf(row: IdentityRow): { name: string; face: AvatarKey } | null {
  const id = sessionIdentity(row);
  return id.kind === "role" ? { name: id.name, face: id.avatar } : null;
}

/** The character a row WOULD wear — what the picker opens on, and what the
 *  "personify this session" gesture writes. Independent of whether it is
 *  personified yet, so opting in shows the same face the preview promised. */
export function characterFor(row: IdentityRow): Character {
  const c = characterOf(row);
  return c.chosen ? c : defaultCharacterFor(row._id);
}

/** The face a row draws when a surface asks for one regardless of opt-in: its
 *  role's, its character's, or the default it WOULD wear. SessionFace on web
 *  and on mobile both draw from this, so the picker's preview, a hover card
 *  and a phone row agree on the animal. */
export function faceIdentity(row: IdentityRow): { kind: "role" | "character"; avatar: AvatarKey; name?: string } {
  const id = sessionIdentity(row, true);
  return id.kind === "plain" ? { kind: "character", avatar: characterFor(row).avatar } : id;
}

/** The corner badge's box on a face of `size` px: 0 under 16 px, where the
 *  badge would be a smudge. */
export function faceBadgeSize(size: number): number {
  return size >= 16 ? Math.round(size * 0.46) : 0;
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

/** The role a session reports to, when the role looks after it: the session
 *  renders as a small row under that role's card. A role's own standing
 *  session answers null; it is the card. */
export function roleLookingAfter(row: IdentityRow): SessionRoleSnapshot | null {
  if (row.standing_role_id) return null;
  return row.org_role_id && row.role ? row.role : null;
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
    acting_user_id: row.acting_user_id ?? null,
    role: row.role ?? null,
  };
}

/** A wake signature of the identity fields alone. A surface that draws a face
 *  subscribes to this rather than to the row, whose ref flips on every
 *  heartbeat; built on identityRowOf so the two can never disagree on which
 *  fields make an identity. */
export function identitySig(row: (IdentityRow & Record<string, unknown>) | null | undefined): string {
  if (!row) return "";
  const r = identityRowOf(row);
  const role = r.role ? `${r.role._id}:${r.role.avatar}:${r.role.name}:${r.role.handle}:${r.role.given_name ?? ""}` : "";
  return [r._id, r.character_avatar ?? "", r.character_name ?? "", r.standing_role_id ?? "", r.org_role_id ?? "", r.acting_user_id ?? "", role].join("|");
}
