// The owners menu's staged change (components/OwnersMenu): who owns the
// session and who drives, as the person edits it before Save, and the one
// change Save sends with the change that undoes it. Pure, so the rules are
// tested without the menu: one role at a time and it drives when added;
// taking away the driver hands the wheel to the role, else the first person.
import type { OwnerRole, SessionDriver } from "../hooks/useOwners";
import type { SessionDriverTarget, SessionOwnersChange } from "../store/orgSlice";

export type OwnersDraft = {
  ownerIds: string[];
  role: OwnerRole | null;
  driver: SessionDriver | null;
  /** Leaving a session that runs on your account moves it here first. */
  moveTo: { device_id: string; is_remote: boolean; label: string } | null;
};

export const driverKey = (d: SessionDriver | null): string | null => (!d ? null : d.kind === "role" ? `r:${d.role_id}` : `p:${d.user_id}`);
const sameDriver = (a: SessionDriver | null, b: SessionDriver | null) => driverKey(a) === driverKey(b);
const target = (d: SessionDriver): SessionDriverTarget => (d.kind === "role" ? { kind: "role" } : { kind: "user", user_id: d.user_id });

function fallbackDriver(d: OwnersDraft): SessionDriver | null {
  if (d.role) return { kind: "role", role_id: d.role.role_id };
  return d.ownerIds[0] ? { kind: "user", user_id: d.ownerIds[0] } : null;
}

export function removePerson(d: OwnersDraft, id: string): OwnersDraft {
  const next = { ...d, ownerIds: d.ownerIds.filter((x) => x !== id) };
  return driverKey(d.driver) === `p:${id}` ? { ...next, driver: fallbackDriver(next) } : next;
}

export function removeRole(d: OwnersDraft): OwnersDraft {
  const next = { ...d, role: null };
  return d.driver?.kind === "role" ? { ...next, driver: fallbackDriver(next) } : next;
}

/** Adding a role replaces the current one and makes it drive. */
export function addRole(d: OwnersDraft, role: OwnerRole): OwnersDraft {
  return { ...d, role, driver: { kind: "role", role_id: role.role_id } };
}

export function addPerson(d: OwnersDraft, id: string, drive = false): OwnersDraft {
  if (d.ownerIds.includes(id)) return drive ? { ...d, driver: { kind: "user", user_id: id } } : d;
  return { ...d, ownerIds: [...d.ownerIds, id], driver: drive ? { kind: "user", user_id: id } : d.driver };
}

/** "Select all teammates": every given person not yet an owner becomes a
 *  pending owner, as a + on each would. Never sets a driver or the role. */
export function addPeople(d: OwnersDraft, ids: string[]): OwnersDraft {
  const fresh = ids.filter((id, i) => !d.ownerIds.includes(id) && ids.indexOf(id) === i);
  return fresh.length ? { ...d, ownerIds: [...d.ownerIds, ...fresh] } : d;
}

export function leave(d: OwnersDraft, meId: string, moveTo: OwnersDraft["moveTo"]): OwnersDraft {
  return { ...removePerson(d, meId), moveTo };
}

export type OwnersDiff = {
  added: string[];
  removed: string[];
  roleChanged: boolean;
  driverChanged: boolean;
  dirty: boolean;
  change: SessionOwnersChange;
  undo: SessionOwnersChange;
};

export function diffOwners(initial: OwnersDraft, draft: OwnersDraft): OwnersDiff {
  const added = draft.ownerIds.filter((id) => !initial.ownerIds.includes(id));
  const removed = initial.ownerIds.filter((id) => !draft.ownerIds.includes(id));
  const roleChanged = (draft.role?.role_id ?? null) !== (initial.role?.role_id ?? null);
  // Setting a role makes it drive on the server, so a person who should drive
  // instead is named after it.
  const driverChanged = !!draft.driver && (!sameDriver(draft.driver, initial.driver) || (roleChanged && !!draft.role && draft.driver.kind === "user"));
  const change: SessionOwnersChange = {
    ...(added.length ? { add: added } : {}),
    ...(removed.length ? { remove: removed } : {}),
    ...(roleChanged ? { role: draft.role?.role_id ?? null } : {}),
    ...(driverChanged && draft.driver ? { driver: target(draft.driver) } : {}),
  };
  const undo: SessionOwnersChange = {
    ...(removed.length ? { add: removed } : {}),
    ...(added.length ? { remove: added } : {}),
    ...(roleChanged ? { role: initial.role?.role_id ?? null } : {}),
    ...(initial.driver ? { driver: target(initial.driver) } : {}),
  };
  const dirty = added.length > 0 || removed.length > 0 || roleChanged || driverChanged || !!draft.moveTo;
  return { added, removed, roleChanged, driverChanged, dirty, change, undo };
}
