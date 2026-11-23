// The co-owners an inbox card shows beside its time: the session's OTHER
// owners (people in the order added, then its role), the one that drives
// ringed and a role a person took over from greyed. Read off the row
// (owner_ids, org_role_id, driver_user_id, owner_user_id) by the rule the
// header's owners segment and the server run (shared driverOf), so the card
// and the header agree. A session only you own shows nothing.
import { driverOf } from "@codecast/shared/contracts/sessionOwners";
import type { RoleLike } from "../components/org/RoleFace";

export type CoOwnerFace =
  | { key: string; kind: "person"; name: string; image?: string; driver: boolean }
  | { key: string; kind: "role"; role: RoleLike; driver: boolean; paused: boolean };

export type CoOwners = { faces: CoOwnerFace[]; more: number; title: string };

type Row = {
  owner_ids?: string[] | null;
  org_role_id?: string | null;
  driver_user_id?: string | null;
  owner_user_id?: string | null;
  standing_role_id?: string | null;
  role?: { _id: string; short_id?: string; name: string; handle: string; avatar?: string | null; icon?: RoleLike["icon"] } | null;
};

type Member = { _id: string; name?: string; email?: string; image?: string; github_avatar_url?: string };

const MAX_PEOPLE = 3;

export function coOwnersOf(row: Row, meId: string | null, members: readonly Member[]): CoOwners | null {
  // A role's own session reports to someone; it lists no owners of its own.
  if (row.standing_role_id || !Array.isArray(row.owner_ids)) return null;
  const ids = row.owner_ids;
  const role = row.org_role_id && row.role && String(row.role._id) === String(row.org_role_id) ? row.role : null;
  if (ids.length + (role ? 1 : 0) < 2) return null;
  const driver = driverOf({ role_id: row.org_role_id ?? null, driver_user_id: row.driver_user_id ?? null, primary_id: row.owner_user_id ?? null }, ids);
  const paused = !!role && driver?.kind === "user";
  const person = (id: string) => {
    const m = members.find((x) => x._id === id);
    return { name: m?.name || m?.email?.split("@")[0] || "Teammate", image: m?.image || m?.github_avatar_url || undefined };
  };
  const drives = (id: string) => driver?.kind === "user" && driver.user_id === id;
  const others = ids.filter((id) => id !== meId);
  const faces: CoOwnerFace[] = others.slice(0, MAX_PEOPLE).map((id) => ({ key: id, kind: "person", ...person(id), driver: drives(id) }));
  if (role) faces.push({ key: role._id, kind: "role", role, driver: driver?.kind === "role", paused });
  const names = [
    ...ids.map((id) => `${id === meId ? "You" : person(id).name}${drives(id) ? " (driver)" : ""}`),
    ...(role ? [`${role.name}${paused ? " (paused)" : driver?.kind === "role" ? " (driver)" : ""}`] : []),
  ];
  return { faces, more: Math.max(0, others.length - MAX_PEOPLE), title: `Owners: ${names.join(", ")}` };
}

/** The co-owners as one string, for a memo key: changes only when a face would. */
export function coOwnersSig(row: Row): string {
  return [row.owner_ids?.join(",") ?? "", row.org_role_id ?? "", row.driver_user_id ?? "", row.owner_user_id ?? "", row.standing_role_id ?? "", row.role ? `${row.role._id}:${row.role.name}:${row.role.avatar ?? ""}` : ""].join("|");
}
