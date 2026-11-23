// The co-owners an inbox card shows beside its time: the session's OTHER
// owners (people in the order added, then its role), a paused role greyed
// with a dashed ring and no face ringed. Read off the session row
// (owner_ids, org_role_id, driver_user_id, owner_user_id) by the rule the
// header's owners segment and the server run (shared driverOf), so the card
// and the header agree; the role's face is read live from the role rows, as
// the header reads it. A session only you own shows nothing.
import { driverOf } from "@codecast/shared/contracts/sessionOwners";
import { roleDrives } from "@codecast/shared/contracts";
import { railRowPlacement, type InboxSession } from "../store/inboxStore";
import type { RoleLike } from "../components/org/RoleFace";
import { roleIconSig, type RoleRows } from "./sessionIdentity";

export type CoOwnerFace =
  | { key: string; kind: "person"; name: string; image?: string }
  | { key: string; kind: "role"; role: RoleLike; paused: boolean };

export type CoOwners = { faces: CoOwnerFace[]; more: number; title: string };

type Row = {
  user_id?: string | null;
  owner_ids?: string[] | null;
  org_role_id?: string | null;
  driver_user_id?: string | null;
  owner_user_id?: string | null;
  standing_role_id?: string | null;
  role?: RoleLike | null;
};

type Member = { _id: string; name?: string; email?: string; image?: string; github_avatar_url?: string };

const MAX_PEOPLE = 3;

/** The role a session is filed under, live from the role rows; the row's own
 *  snapshot only while the rows have not loaded it. */
export function filedRoleOf(row: Row, rows: RoleRows | null): RoleLike | null {
  if (!row.org_role_id || row.standing_role_id) return null;
  const id = String(row.org_role_id);
  return rows?.roles.find((r) => r._id === id) ?? (row.role && String(row.role._id) === id ? row.role : null);
}

/** What the card draws of the filed role, as one string: its memo key. */
export function filedRoleSig(role: RoleLike | null): string {
  return role ? `${role._id}|${role.name ?? ""}|${role.handle}|${role.avatar ?? ""}|${roleIconSig(role.icon)}` : "";
}

/** The owners as a tooltip and VoiceOver read them: "Owners: You, Ashot,
 *  Evals lead (paused)". People are never said to drive; the role is Active
 *  or Paused. */
export function ownersTitle(people: string[], role: { name?: string | null; handle?: string } | null, paused: boolean): string {
  return `Owners: ${[...people, ...(role ? [`${role.name ?? role.handle} (${paused ? "paused" : "active"})`] : [])].join(", ")}`;
}

export function coOwnersOf(row: Row, meId: string | null, members: readonly Member[], role: RoleLike | null): CoOwners | null {
  // A role's own session reports to someone; it lists no owners of its own.
  if (row.standing_role_id || !Array.isArray(row.owner_ids)) return null;
  const ids = row.owner_ids;
  const others = ids.filter((id) => id !== meId);
  // Two owners or more; or someone else's on your account, which you only run.
  const runsOnMine = !!meId && row.user_id === meId && !ids.includes(meId);
  if (ids.length + (role ? 1 : 0) < 2 && !(runsOnMine && others.length + (role ? 1 : 0) > 0)) return null;
  const driver = driverOf({ role_id: row.org_role_id ?? null, driver_user_id: row.driver_user_id ?? null, primary_id: row.owner_user_id ?? null }, ids);
  const paused = !!role && driver?.kind === "user";
  const person = (id: string) => {
    const m = members.find((x) => x._id === id);
    return { name: m?.name || m?.email?.split("@")[0] || "Teammate", image: m?.image || m?.github_avatar_url || undefined };
  };
  const faces: CoOwnerFace[] = others.slice(0, MAX_PEOPLE).map((id) => ({ key: id, kind: "person", ...person(id) }));
  if (role) faces.push({ key: role._id ?? role.handle, kind: "role", role, paused });
  return { faces, more: Math.max(0, others.length - MAX_PEOPLE), title: ownersTitle(ids.map((id) => (id === meId ? "You" : person(id).name)), role, paused) };
}

/** The row's half of the co-owners as one string, for a memo key. */
export function coOwnersSig(row: Row): string {
  return [row.user_id ?? "", row.owner_ids?.join(",") ?? "", row.org_role_id ?? "", row.driver_user_id ?? "", row.owner_user_id ?? "", row.standing_role_id ?? ""].join("|");
}

// The role a session waits on (shared roleDrives): its role drives it and its
// own state is not working, so placement files it under Working, and the card
// says "With <role>". The role snapshot on the row names it only when it is
// the driving role (a standing session's snapshot is its own role).
export function withRoleOf(session: InboxSession, t: number): string | null {
  const role = session.role;
  if (!roleDrives(session) || !role || String(role._id) !== String(session.org_role_id)) return null;
  return railRowPlacement(session, t).state !== "working" ? role.name : null;
}
