// Dropping one session card onto another in the inbox sidebar makes the
// dragged session the target's worker: the owners change `adopt_parent`
// (shared contracts/sessionOwners). Pure, so the sidebar (GlobalSessionPanel)
// lights only a drop the server would take, and the rules are tested without it.
import { isClosedSession, underOwnersModel } from "@codecast/shared/contracts";
import { mayEditOwners, ownersChangeRefusal, ownersLeftRefusal, ownersOf, ownsSession, type SessionOwnerFacts } from "@codecast/shared/contracts/sessionOwners";
import type { OwnerRestoreRow, SessionOwnersChange, SessionOwnersRow } from "../store/sessionOwnersSlice";

/** How many links up the target's parents a drop looks for the dragged
 *  session: a safety bound, as on the server; a visited set ends any loop. */
export const ADOPT_CHAIN_CAP = 50;

export type AdoptRow = {
  _id: string;
  owners_model?: boolean | null;
  inbox_killed_at?: number | null;
  inbox_closed_at?: number | null;
  inbox_dismissed_at?: number | null;
  standing_role_id?: unknown;
  is_subagent?: boolean | null;
  is_workflow_sub?: boolean | null;
  parent_message_uuid?: string | null;
  user_id?: unknown;
  owned_by_me?: unknown;
  implicit_owner?: unknown;
};

/** What the store knows of one session's owners: its facts and the read's
 *  own edit answer, null without a read (the row's stamps decide then). */
export type AdoptOwners = { facts: SessionOwnerFacts | null; canEdit: boolean };

/** The viewer owns it now (an owner row, or its implicit starter). */
export function viewerOwns(row: AdoptRow, owners: AdoptOwners, viewerId: string): boolean {
  if (owners.facts) return ownsSession(owners.facts, viewerId);
  return row.owned_by_me === true || String(row.implicit_owner ?? "") === viewerId;
}

/** The viewer may change its owners: the read's answer, else owning or running it. */
export function mayEdit(row: AdoptRow, owners: AdoptOwners, viewerId: string): boolean {
  if (owners.canEdit) return true;
  if (owners.facts) return mayEditOwners(owners.facts, viewerId);
  return viewerOwns(row, owners, viewerId) || String(row.user_id ?? "") === viewerId;
}

/**
 * Why `dragged` cannot become `target`'s worker, or null when the drop is
 * taken: the server's refusals, as far as the store can tell. Both under the
 * owners model; the dragged one no role's standing session; the target alive,
 * not nested under the dragged one, and one the viewer owns or runs (work is
 * handed only to a session that is yours); the viewer may edit the dragged
 * one's owners. `parentOf` names the session a row is nested under, the
 * painted parent first. Whether the target's runner can open the dragged
 * session is the server's alone to say.
 */
export function adoptDropRefusal(a: {
  dragged: AdoptRow | null | undefined;
  target: AdoptRow | null | undefined;
  draggedOwners: AdoptOwners;
  targetOwners: AdoptOwners;
  viewerId: string;
  parentOf: (id: string) => string | null;
}): string | null {
  const { dragged, target, viewerId } = a;
  if (!dragged || !target || !viewerId) return "Unknown session";
  if (!underOwnersModel(dragged) || !underOwnersModel(target)) return "Off the owners model";
  if (dragged._id === target._id) return "A session cannot work for itself";
  if (dragged.standing_role_id) return "A role's own session works for no session";
  if (dragged.is_subagent || dragged.is_workflow_sub || dragged.parent_message_uuid) return "It is nested under its session by how it was started; it can't be moved";
  if (target.inbox_killed_at) return "That session was killed";
  if (isClosedSession(target)) return "That session is closed";
  const seen = new Set<string>();
  for (let link = a.parentOf(target._id); link && !seen.has(link) && seen.size < ADOPT_CHAIN_CAP; link = a.parentOf(link)) {
    if (link === dragged._id) return "That session already works for this one";
    seen.add(link);
  }
  if (!mayEdit(target, a.targetOwners, viewerId)) return "You can only hand work to a session you own or run";
  const change = { adoptParent: target._id };
  const at = { actor: viewerId, now: Date.now() };
  const { facts, canEdit } = a.draggedOwners;
  if (facts) return canEdit ? ownersLeftRefusal(facts, change, at) : ownersChangeRefusal(facts, change, at);
  return mayEdit(dragged, a.draggedOwners, viewerId) ? null : "Only its owners can change who owns it";
}

export type RowDropZone = "before" | "after" | "adopt";

/**
 * Where on a row a dragged card would land, by the pointer's height in it.
 * An adopting row gives the middle half to the adopt; its top and bottom
 * quarters keep what the row did before: the reorder line on a reorderable
 * row, and on a row inside a drop section (a label, a status) nothing, so the
 * drag falls through to the section. Any other adopting row is all adopt; a
 * row that only reorders splits at its middle.
 */
export function rowDropZone(y: number, top: number, height: number, opts: { reorderable: boolean; adoptable: boolean; sectionDrop?: boolean }): RowDropZone | null {
  const at = height > 0 ? (y - top) / height : 0.5;
  if (opts.adoptable && !opts.reorderable && !opts.sectionDrop) return "adopt";
  const edge = at < 0.25 ? "before" : at > 0.75 ? "after" : null;
  if (opts.adoptable) return edge ? (opts.reorderable ? edge : null) : "adopt";
  if (opts.reorderable) return at < 0.5 ? "before" : "after";
  return null;
}

/**
 * The owners change a drop sends, and what puts it back, in order: the
 * parent that owned it again, when one did (live and unreleased: the owners
 * read names only that one), else the parent a person released it from,
 * nested back released, else no parent at all (a detach, so it leaves
 * the new parent's band and close cascade; a released or dead parent owned
 * nothing) with its old role, and the viewer's row. A viewer who does not
 * run it may no longer edit its owners once their row is gone, so their undo
 * first adds them back (anyone who can see a session may add themselves).
 * Null when it had both a role and a parent (an adopt cannot carry a role),
 * or when its old parent is a session the viewer may not hand work to (the
 * server would refuse putting it back). A role's start and its hold are not
 * put back.
 */
export function adoptChange(facts: SessionOwnerFacts | null, read: SessionOwnersRow | null, meId: string, targetId: string, mayHandTo: (sessionId: string) => boolean, releasedLink: string | null = null): { change: SessionOwnersChange; inverse: SessionOwnersChange[] | null } {
  const change: SessionOwnersChange = { adopt_parent: targetId };
  if (!facts) return { change, inverse: null };
  const was = ownersOf(facts);
  if (was.parentSession && was.role) return { change, inverse: null };
  if (was.parentSession && !mayHandTo(was.parentSession)) return { change, inverse: null };
  // A parent a person released it from still links it: undo nests it back
  // there released, so a later Put back can still find it, and its role
  // returns in a step of its own (an adopt cannot carry one).
  // The open conversation's read names it; a card's row keeps the link too.
  const released = !was.parentSession ? read?.released_parent?.conversation_id ?? releasedLink : null;
  const reNest = !!released && mayHandTo(released);
  const back: SessionOwnersChange = was.parentSession
    ? { adopt_parent: was.parentSession }
    : reNest ? { adopt_parent: released!, release_parent: true }
      : { detach_parent: true, ...(was.role ? { role: was.role } : {}) };
  const after: SessionOwnersChange[] = reNest && was.role ? [{ role: was.role }] : [];
  const rejoin: SessionOwnersChange[] = String(facts.user_id ?? "") === meId ? [] : [{ add: [meId] }];
  const held = facts.rows.find((r) => r.user_id === meId);
  if (!held) return { change, inverse: [...rejoin, back, ...after] };
  const info = read?.people_info[meId];
  const row: OwnerRestoreRow = {
    user_id: meId,
    added_by: info?.added_by ?? meId,
    added_at: info?.added_at ?? held.added_at,
    ...(typeof info?.seen_at === "number" ? { seen_at: info.seen_at } : {}),
    ...(typeof info?.note === "string" ? { note: info.note } : {}),
  };
  return { change, inverse: [...rejoin, { ...back, restore: [row] }, ...after] };
}
