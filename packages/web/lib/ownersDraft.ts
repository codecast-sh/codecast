// The owners menu's staged change (components/OwnersMenu): who owns the
// session and who drives, as the person edits it before Save, and the one
// change Save sends and the change that puts it back (the store paints the
// result by the shared owners rule). Pure, so the rules are tested without the menu: one
// role at a time and it drives when added; taking away the driver hands the
// wheel to the role, else the first person; leaving rides the change itself.
import type { OwnerRole, SessionDriver } from "../hooks/useOwners";
import type { SessionDriverTarget, SessionOwnersChange } from "../store/sessionOwnersSlice";
import type { OwnerRowFact } from "@codecast/shared/contracts/sessionOwners";

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
  /** The change that puts it back. A leave alone, with no move, from a
   *  session the leaver reads as a teammate (`canRejoin`) is undone by
   *  rejoining: the server's self-claim takes anyone who sees the session.
   *  Any other leave has none: after a move the session runs on another
   *  account, which may not share it, and a leave with other changes leaves
   *  edits a person who left may no longer make. */
  inverse: SessionOwnersChange | null;
};

/**
 * `meId` makes taking yourself out a leave (the server's leave rule, with the
 * move when there is one) rather than a plain remove. `initialDriverUserId` is
 * the session's driver_user_id: an undo puts back a driver nobody chose as
 * unset, never as a stamped person. `snapshots` are the owner rows as they
 * stand, so an undo of a remove puts each back in its place.
 */
export function diffOwners(initial: OwnersDraft, draft: OwnersDraft, opts: { meId?: string; initialDriverUserId?: string | null; snapshots?: OwnerRowFact[]; canRejoin?: boolean } = {}): OwnersDiff {
  const added = draft.ownerIds.filter((id) => !initial.ownerIds.includes(id));
  const gone = initial.ownerIds.filter((id) => !draft.ownerIds.includes(id));
  const leaving = !!opts.meId && gone.includes(opts.meId);
  const removed = gone.filter((id) => id !== opts.meId);
  const roleChanged = (draft.role?.role_id ?? null) !== (initial.role?.role_id ?? null);
  // Setting a role makes it drive on the server, so a person who should drive
  // instead is named after it.
  const driverChanged = !!draft.driver && (!sameDriver(draft.driver, initial.driver) || (roleChanged && !!draft.role && draft.driver.kind === "user"));
  const move = draft.moveTo;
  const change: SessionOwnersChange = {
    ...(added.length ? { add: added } : {}),
    ...(removed.length ? { remove: removed } : {}),
    ...(roleChanged ? { role: draft.role?.role_id ?? null } : {}),
    ...(driverChanged && draft.driver ? { driver: target(draft.driver) } : {}),
    ...(leaving ? { leave: move ? { move_to_device_id: move.device_id, runner_id: move.runner_id, runner_is_bot: move.runner_is_bot } : {} } : {}),
  };
  const undoDriver: SessionDriverTarget = opts.initialDriverUserId
    ? { kind: "user", user_id: opts.initialDriverUserId }
    : initial.role && initial.driver?.kind === "role" ? { kind: "role" } : { kind: "none" };
  const restore = (opts.snapshots ?? []).filter((r) => removed.includes(r.user_id));
  const readd = removed.filter((id) => !restore.some((r) => r.user_id === id));
  const leaveOnly = leaving && !move && !!opts.canRejoin && !added.length && !removed.length && !roleChanged && !driverChanged;
  const inverse: SessionOwnersChange | null = leaveOnly ? { add: [opts.meId!] } : leaving ? null : {
    ...(restore.length ? { restore } : {}),
    ...(readd.length ? { add: readd } : {}),
    ...(added.length ? { remove: added } : {}),
    ...(roleChanged ? { role: initial.role?.role_id ?? null } : {}),
    ...(driverChanged || roleChanged ? { driver: undoDriver } : {}),
  };
  const dirty = added.length > 0 || gone.length > 0 || roleChanged || driverChanged;
  return { added, removed, leaving, roleChanged, driverChanged, dirty, change, inverse };
}

/** The machines a leave can move a session on your account to: the team's
 *  agent boxes that are not yours. A cloud box is left out, since the cloud
 *  migration rail moves only within one account. */
export function teamMoveTargets<B extends { device_id: string; is_remote?: boolean; local_project_roots?: string[] }>(own: readonly { device_id: string }[], boxes: readonly B[] | null | undefined): B[] {
  const mine = new Set(own.map((d) => d.device_id));
  return (boxes ?? []).filter((b) => !mine.has(b.device_id) && !b.is_remote).map((b) => ({ ...b, local_project_roots: b.local_project_roots ?? [] }));
}

/** A machine a leave moves to, named by whose it is: "<First>'s <machine>",
 *  unless its name already says so. Leaving puts the session on that account. */
export function machineOf(ownerName: string | null | undefined, device: string): string {
  const first = ownerName?.split(/\s+/)[0];
  if (!first || device.toLowerCase().startsWith(first.toLowerCase())) return device;
  return `${first}'s ${device}`;
}
