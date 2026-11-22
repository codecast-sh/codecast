// The owners menu's staged change (components/OwnersMenu): who owns the
// session and who drives, as the person edits it before Save, and the one
// change Save sends, the view it paints on the store row, and the change and
// view that put it back. Pure, so the rules are tested without the menu: one
// role at a time and it drives when added; taking away the driver hands the
// wheel to the role, else the first person; leaving rides the change itself.
import type { OwnerRole, SessionDriver } from "../hooks/useOwners";
import type { SessionDriverTarget, SessionOwnersChange, SessionOwnersView } from "../store/orgSlice";

export type MoveTo = { device_id: string; is_remote: boolean; label: string; runner_id: string; runner_is_bot: boolean };

export type OwnersDraft = {
  ownerIds: string[];
  role: OwnerRole | null;
  driver: SessionDriver | null;
  /** Leaving a session that runs on your account moves it here first. */
  moveTo: MoveTo | null;
};

export const driverKey = (d: SessionDriver | null | undefined): string | null => (!d ? null : d.kind === "role" ? `r:${d.role_id}` : `p:${d.user_id}`);
const sameDriver = (a: SessionDriver | null, b: SessionDriver | null) => driverKey(a) === driverKey(b);
const target = (d: SessionDriver): SessionDriverTarget => (d.kind === "role" ? { kind: "role" } : { kind: "user", user_id: d.user_id });

function fallbackDriver(d: Pick<OwnersDraft, "ownerIds" | "role">): SessionDriver | null {
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

export function leave(d: OwnersDraft, meId: string, moveTo: MoveTo | null): OwnersDraft {
  return { ...removePerson(d, meId), moveTo };
}

export type OwnersDiff = {
  added: string[];
  removed: string[];
  leaving: boolean;
  roleChanged: boolean;
  driverChanged: boolean;
  dirty: boolean;
  change: SessionOwnersChange;
  /** What the store row shows once the change lands, as listOwners will echo it. */
  view: SessionOwnersView;
  /** The change and view that put it back; null after a move, which undo cannot reverse. */
  inverse: { change: SessionOwnersChange; view: SessionOwnersView } | null;
};

/**
 * `meId` makes taking yourself out a leave (the server's leave rule, with the
 * move when there is one) rather than a plain remove. `initialDriverUserId` is
 * the row's driver_user_id: an undo of a driver change puts back a driver
 * nobody chose as unset, never as a stamped person.
 */
export function diffOwners(initial: OwnersDraft, draft: OwnersDraft, opts: { meId?: string; initialDriverUserId?: string | null } = {}): OwnersDiff {
  const added = draft.ownerIds.filter((id) => !initial.ownerIds.includes(id));
  const gone = initial.ownerIds.filter((id) => !draft.ownerIds.includes(id));
  const leaving = !!opts.meId && gone.includes(opts.meId);
  const removed = gone.filter((id) => id !== opts.meId);
  const roleChanged = (draft.role?.role_id ?? null) !== (initial.role?.role_id ?? null);
  // Setting a role makes it drive on the server, so a person who should drive
  // instead is named after it.
  const driverChanged = !!draft.driver && (!sameDriver(draft.driver, initial.driver) || (roleChanged && !!draft.role && draft.driver.kind === "user"));
  const change: SessionOwnersChange = {
    ...(added.length ? { add: added } : {}),
    ...(removed.length ? { remove: removed } : {}),
    ...(roleChanged ? { role: draft.role?.role_id ?? null } : {}),
    ...(driverChanged && draft.driver ? { driver: target(draft.driver) } : {}),
    ...(leaving ? { leave: draft.moveTo ? { move_to_device_id: draft.moveTo.device_id } : {} } : {}),
  };
  // With nobody left, the person whose account now runs it owns it.
  const runnerOwns = draft.ownerIds.length === 0 && !!draft.moveTo && !draft.moveTo.runner_is_bot;
  const ownerIds = runnerOwns ? [draft.moveTo!.runner_id] : draft.ownerIds;
  const driver = draft.driver ?? fallbackDriver({ ownerIds, role: draft.role });
  const view: SessionOwnersView = { owner_ids: ownerIds, role_id: draft.role?.role_id ?? null, driver };
  const initialView: SessionOwnersView = { owner_ids: initial.ownerIds, role_id: initial.role?.role_id ?? null, driver: initial.driver };
  const undoDriver: SessionDriverTarget = opts.initialDriverUserId
    ? { kind: "user", user_id: opts.initialDriverUserId }
    : initial.role && initial.driver?.kind === "role" ? { kind: "role" } : { kind: "none" };
  const inverse = draft.moveTo ? null : {
    change: {
      ...(gone.length ? { add: gone } : {}),
      ...(added.length ? { remove: added } : {}),
      ...(roleChanged ? { role: initial.role?.role_id ?? null } : {}),
      ...(driverChanged || roleChanged ? { driver: undoDriver } : {}),
    } as SessionOwnersChange,
    view: initialView,
  };
  const dirty = added.length > 0 || gone.length > 0 || roleChanged || driverChanged;
  return { added, removed, leaving, roleChanged, driverChanged, dirty, change, view, inverse };
}
