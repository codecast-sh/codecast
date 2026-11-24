// The owners menu's staged change under the session_owners model
// (components/OwnersMenu): who owns the session as the person edits it before
// Save, the one change Save sends and the change that puts it back. Pure, so
// the rules are tested without the menu: one role at a time, the parent
// session can only be released, and leaving is removing yourself.
// The store paints the result by the shared owners rule (sessionOwnersSlice).
import type { OwnerRestoreRow, SessionOwnersChange } from "../store/sessionOwnersSlice";

export type DraftRole = { role_id: string; short_id?: string | null; handle: string; name: string };

export type OwnersDraft = {
  /** People, in the order added (the implicit starter included). */
  people: string[];
  role: DraftRole | null;
  /** The session that owns it, until released. */
  parent: string | null;
};

export function addPerson(d: OwnersDraft, id: string): OwnersDraft {
  return d.people.includes(id) ? d : { ...d, people: [...d.people, id] };
}

/** "Select all teammates": each one not yet an owner, as a + on each would. */
export function addPeople(d: OwnersDraft, ids: readonly string[]): OwnersDraft {
  const fresh = ids.filter((id, i) => !d.people.includes(id) && ids.indexOf(id) === i);
  return fresh.length ? { ...d, people: [...d.people, ...fresh] } : d;
}

export function removePerson(d: OwnersDraft, id: string): OwnersDraft {
  return d.people.includes(id) ? { ...d, people: d.people.filter((x) => x !== id) } : d;
}

/** One role at a time: adding a role replaces the current one. */
export function setRole(d: OwnersDraft, role: DraftRole): OwnersDraft {
  return { ...d, role };
}

export function removeRole(d: OwnersDraft): OwnersDraft {
  return d.role ? { ...d, role: null } : d;
}

export function releaseParent(d: OwnersDraft): OwnersDraft {
  return d.parent ? { ...d, parent: null } : d;
}

export type OwnersDiff = {
  added: string[];
  removed: string[];
  roleAdded: DraftRole | null;
  roleRemoved: DraftRole | null;
  parentReleased: boolean;
  leaving: boolean;
  dirty: boolean;
  change: SessionOwnersChange;
  /** The change that puts it back, or null when nothing can: a released
   *  parent never comes back, and a person who left with other changes may
   *  no longer make them. */
  inverse: SessionOwnersChange | null;
};

/**
 * `snapshots` are the owner rows as they stand, so an undo of a remove puts
 * each back with its stamp. `meRuns`: the viewer runs the session, so they
 * may still edit after leaving.
 */
export function diffOwners(initial: OwnersDraft, draft: OwnersDraft, opts: { meId?: string; snapshots?: readonly OwnerRestoreRow[]; meRuns?: boolean } = {}): OwnersDiff {
  const added = draft.people.filter((id) => !initial.people.includes(id));
  const removed = initial.people.filter((id) => !draft.people.includes(id));
  const roleChanged = (draft.role?.role_id ?? null) !== (initial.role?.role_id ?? null);
  const parentReleased = !!initial.parent && !draft.parent;
  const leaving = !!opts.meId && removed.includes(opts.meId);
  const change: SessionOwnersChange = {
    ...(added.length ? { add: added } : {}),
    ...(removed.length ? { remove: removed } : {}),
    ...(roleChanged ? { role: draft.role?.role_id ?? null } : {}),
    ...(parentReleased ? { release_parent: true } : {}),
  };
  const dirty = added.length > 0 || removed.length > 0 || roleChanged || parentReleased;
  const onlyLeave = leaving && removed.length === 1 && !added.length && !roleChanged && !parentReleased;
  let inverse: SessionOwnersChange | null;
  if (!dirty || parentReleased) inverse = null;
  // Anyone who sees a session may add themselves: a leave alone is undone by rejoining.
  else if (onlyLeave) inverse = { add: [opts.meId!] };
  else if (leaving && !opts.meRuns) inverse = null;
  else {
    const restore = (opts.snapshots ?? []).filter((r) => removed.includes(r.user_id));
    const readd = removed.filter((id) => !restore.some((r) => r.user_id === id));
    inverse = {
      ...(restore.length ? { restore } : {}),
      ...(readd.length ? { add: readd } : {}),
      ...(added.length ? { remove: added } : {}),
      ...(roleChanged ? { role: initial.role?.role_id ?? null } : {}),
    };
  }
  return {
    added,
    removed,
    roleAdded: roleChanged ? draft.role : null,
    roleRemoved: roleChanged ? initial.role : null,
    parentReleased,
    leaving,
    dirty,
    change,
    inverse,
  };
}

/** Take it over (the composer strip): every agent owner comes off and the
 *  viewer becomes an owner. Undo puts the role back and takes the viewer off
 *  again; a released parent never comes back, so that has no undo. */
export function takeOverChange(current: OwnersDraft, meId: string): { change: SessionOwnersChange; inverse: SessionOwnersChange | null } {
  const change: SessionOwnersChange = { take_over: true };
  if (current.parent) return { change, inverse: null };
  return {
    change,
    inverse: {
      ...(current.role ? { role: current.role.role_id } : {}),
      ...(current.people.includes(meId) ? {} : { remove: [meId] }),
    },
  };
}
