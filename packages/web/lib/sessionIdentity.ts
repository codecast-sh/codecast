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
//
// A viewer who turns characters off (`show_characters`, roleIcon.ts) sees no
// animal and no invented name anywhere: a role wears its drawn icon and is
// named by its title, and every other session is plain.
import { characterOf, defaultCharacterFor, type Character } from "@codecast/shared/contracts/sessionCharacter";
import { isAvatarKey, defaultAvatarFor, avatarOf, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";
import { isRoleIcon, pickRoleIconAccent, roleMonogram, type RoleIcon, type RoleIconAccent } from "@codecast/shared/contracts/roleIcon";
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

/** What a viewer chose about faces. `characters` (default on): roles wear
 *  animal characters, else their icon and title. `personifyAll` (default off):
 *  every session gets a character; meaningless with characters off, so the
 *  readers below never see it on then. */
export type IdentityPrefs = { readonly characters: boolean; readonly personifyAll: boolean };

const PREFS = {
  on: { characters: true, personifyAll: false },
  all: { characters: true, personifyAll: true },
  off: { characters: false, personifyAll: false },
} as const satisfies Record<string, IdentityPrefs>;

/** Everyone's view until they choose: characters on, only chosen ones. */
export const DEFAULT_IDENTITY_PREFS: IdentityPrefs = PREFS.on;
/** Every session personified: the surfaces that preview the face a row WOULD
 *  wear (the picker, the hover header) read through this. */
export const PERSONIFY_ALL_PREFS: IdentityPrefs = PREFS.all;
/** A viewer who turned characters off. */
export const NO_CHARACTER_PREFS: IdentityPrefs = PREFS.off;

/** The prefs from the viewer's stored settings. Returns one of three shared
 *  objects, so a store subscription can compare by reference. */
export function identityPrefsOf(ui: { show_characters?: boolean; personify_sessions?: boolean } | null | undefined): IdentityPrefs {
  if (ui?.show_characters === false) return PREFS.off;
  return ui?.personify_sessions === true ? PREFS.all : PREFS.on;
}

/** A role's face when characters are off: its drawn icon on a tinted tile,
 *  or, until it has one, the first letter of its title on the same tile.
 *  `accent` is the icon's, or for a monogram a stable hue from the handle. */
export type RoleTile = { icon: RoleIcon | null; monogram: string; accent: RoleIconAccent; title: string };

export function roleTile(role: { name: string; handle: string; icon?: unknown }, title = role.name): RoleTile {
  const icon = isRoleIcon(role.icon) ? role.icon : null;
  return { icon, monogram: roleMonogram(title), accent: icon?.accent ?? pickRoleIconAccent([], role.handle), title };
}

export type SessionIdentity =
  | { kind: "plain"; reportsTo: SessionRoleSnapshot | null }
  | { kind: "character"; avatar: AvatarKey; name: string; chosen: boolean; reportsTo: SessionRoleSnapshot | null }
  /** `style` says which face the viewer sees: "character" draws `avatar` and
   *  names the role by its given name; "icon" draws `tile` and names it by
   *  its title. `avatar` and `tile` are both always present, so a surface
   *  that shows both faces (the role editor) reads them here too. */
  | { kind: "role"; style: "character" | "icon"; avatar: AvatarKey; tile: RoleTile; name: string; title: string; handle: string; role: SessionRoleSnapshot };

/** The one resolver every surface calls. `prefs` is the viewer's; identity
 *  components read it via useIdentityPrefs (hooks/) rather than importing the
 *  store from this module. */
export function sessionIdentity(row: IdentityRow, prefs: IdentityPrefs = DEFAULT_IDENTITY_PREFS): SessionIdentity {
  if (row.standing_role_id && row.role) {
    const r = row.role;
    const avatar = isAvatarKey(r.avatar) ? r.avatar : defaultAvatarFor(r.handle);
    // With characters, the role's given name (org-staffing.md S30), never its
    // title: "Hazel", not "Cam's Engineering Co-worker". Without, its title.
    const words = roleIdentity({ ...r, avatar });
    const style = prefs.characters ? "character" : "icon";
    return { kind: "role", style, avatar, tile: roleTile(r, words.title), name: style === "icon" ? words.title : words.name, title: words.title, handle: r.handle, role: r };
  }
  const reportsTo = row.org_role_id && row.role ? row.role : null;
  if (!prefs.characters) return { kind: "plain", reportsTo };
  const c: Character = characterOf(row);
  if (!c.chosen && !prefs.personifyAll) return { kind: "plain", reportsTo };
  return { kind: "character", avatar: c.avatar, name: c.name, chosen: c.chosen, reportsTo };
}

/** Who an agent speaks as wherever its words are shown: a role's given name
 *  (or title, characters off), a character's name, or for a plain session its
 *  agent's product name. `identity` is null for a plain session, which keeps
 *  the agent's mark. */
export function speakerOf(row: IdentityRow | null, agentType?: string | null, prefs: IdentityPrefs = DEFAULT_IDENTITY_PREFS): {
  name: string;
  identity: Exclude<SessionIdentity, { kind: "plain" }> | null;
} {
  const id = row ? sessionIdentity(row, prefs) : null;
  if (!id || id.kind === "plain") return { name: assistantLabel(agentType ?? undefined), identity: null };
  return { name: id.name, identity: id };
}

/** Where a role's identity lives: the role rows (`viewerRoles`, every role
 *  the viewer can see in any workspace, fed by roleIcons.viewerRoles; built by
 *  lib/roleRows) and the seats pairing each role with its bot user.
 *  One home per fact: a role's name and face are read from its row, never
 *  from the bot user minted for it, whose name is the title it was born with. */
export type RoleRows = {
  roles: readonly { _id: string; short_id: string; name: string; handle: string; avatar?: string | null; status: string; given_name?: string | null; icon?: RoleIcon | null; tenure_kind?: string | null; assistant?: IdentityRoleRow["assistant"]; scope_type?: "team" | "user" }[];
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
    avatar: avatarOf(live), status: live.status, tenure_kind: live.tenure_kind === "program" ? "program" : "standing",
    given_name: live.given_name ?? null, icon: live.icon ?? null,
  };
  return { ...row, standing_role_id: roleId, role };
}

type IdentityRoleRow = Parameters<typeof roleIdentity>[0];

/** The role a user is the bot of, as a person reads it: the given name (the
 *  subtitle, characters off), the role's subtitle ("Head of People",
 *  "Executive Assistant, global"), its handle and both faces. Null for anyone
 *  who is not a role's bot. The roster and chat name a role's bot user
 *  through this; the bot user itself keeps the title it was born with, which
 *  chat's mention handles are derived from. */
export function roleOfUser(userId: string | null | undefined, rows: RoleRows | null | undefined, prefs: IdentityPrefs = DEFAULT_IDENTITY_PREFS): { roleId: string; name: string; title: string; handle: string; shortId: string; face: AvatarKey; tile: RoleTile; style: "character" | "icon" } | null {
  if (!userId) return null;
  const roleId = standingRoleOf({ _id: "", acting_user_id: userId }, rows);
  const r = roleId ? rows?.roles.find((x) => x._id === roleId) : null;
  if (!r) return null;
  const face = avatarOf(r);
  const id = roleIdentity({ ...r, avatar: face }, { characters: prefs.characters });
  return { roleId: r._id, name: id.name, title: id.subtitle, handle: r.handle, shortId: r.short_id, face, tile: roleTile(r, id.title), style: prefs.characters ? "character" : "icon" };
}

/** A wake signature of what withLiveRole reads for this row. */
export function liveRoleSig(row: IdentityRow | null | undefined, rows: RoleRows | null | undefined): string {
  if (!row) return "";
  const roleId = standingRoleOf(row, rows);
  const r = roleId ? rows?.roles.find((x) => x._id === roleId) : null;
  return r ? `${r._id}|${r.name}|${r.handle}|${r.avatar ?? ""}|${r.given_name ?? ""}|${r.status}|${roleIconSig(r.icon)}` : "";
}

/** A role's author mark: who wrote it (the given name, or the title with
 *  characters off) and the face to draw. */
export type RoleAuthor = { name: string; face: AvatarKey; tile: RoleTile; style: "character" | "icon" };

/** The author a role's standing session is shown as. Null for any other row. */
export function roleAuthorOf(row: IdentityRow, prefs: IdentityPrefs = DEFAULT_IDENTITY_PREFS): RoleAuthor | null {
  const id = sessionIdentity(row, prefs);
  return id.kind === "role" ? { name: id.name, face: id.avatar, tile: id.tile, style: id.style } : null;
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
  const id = sessionIdentity(row, PERSONIFY_ALL_PREFS);
  return id.kind === "plain" ? { kind: "character", avatar: characterFor(row).avatar } : id;
}

/** The face a row draws for this viewer, wherever a surface draws one even for
 *  a row nobody personified: the animal (faceIdentity) with characters on;
 *  with them off, a role's tile, and for any other row no face at all, since
 *  an animal would be a character the viewer turned off. */
export function viewerFace(row: IdentityRow, prefs: IdentityPrefs): { kind: "animal"; avatar: AvatarKey; name?: string; role: boolean } | { kind: "tile"; tile: RoleTile; name: string } | { kind: "none" } {
  const id = sessionIdentity(row, prefs);
  if (id.kind === "role" && id.style === "icon") return { kind: "tile", tile: id.tile, name: id.name };
  if (!prefs.characters) return { kind: "none" };
  const f = faceIdentity(row);
  return { kind: "animal", avatar: f.avatar, name: f.name, role: f.kind === "role" };
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
  prefs: IdentityPrefs = DEFAULT_IDENTITY_PREFS,
): { name: string | null; title: string | null; handle: string | null } {
  const id = sessionIdentity(row, prefs);
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
  const role = r.role ? `${r.role._id}:${r.role.avatar}:${r.role.name}:${r.role.handle}:${r.role.given_name ?? ""}:${roleIconSig(r.role.icon)}` : "";
  return [r._id, r.character_avatar ?? "", r.character_name ?? "", r.standing_role_id ?? "", r.org_role_id ?? "", r.acting_user_id ?? "", role].join("|");
}

/** A short wake signature of a role's icon: its concept, accent and shapes
 *  digested, so a redraw repaints and a heartbeat never does. */
export function roleIconSig(icon: RoleIcon | null | undefined): string {
  if (!icon) return "";
  const text = JSON.stringify(icon.shapes);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${icon.concept}/${icon.accent}/${h.toString(36)}`;
}
