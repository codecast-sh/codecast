// A session's owners under the session_owners model (shared
// contracts/sessionOwners). Their one home on the client is the owners read
// (sessionOwnership.listOwners for an open conversation, listOwnersFor for the
// cards on screen; hooks/useSyncSessionOwners), kept in `sessionOwners`, one
// row per conversation: `people_ids` (who holds an owner row, in the order
// added), `role` and `parent_session` are the facts a change paints; the rest
// is detail (names and stamps, the parent's title, who started it, whether the
// viewer may edit). The session's inbox row is the home of what the viewer's
// inbox reads: whether it is theirs (owned_by_me, implicit_owner) and who
// answers it (org_role_id, owner_session_id). Membership and placement read
// those stamps only.
//
// applySessionOwners is every owner change a person makes on web (the menu's
// Save, Take it over, Add me, and their undo): painted on the press by the
// same rule the server runs, on the read and on the inbox row's stamps, each
// under the ordinary field lock, and riding `dispatch` to the side effect of
// the same name (convex dispatch.ts). A refusal rolls every painted field
// back; the dispatch's acknowledgement settles the locks it planted
// (settleOwnersAck, lib/dispatchBinding), so a server answer that differs
// from the paint (someone else's change at the same moment) lands.
//
// Spread into the store (inboxStore), so it gains these without a line of its own.
import { windowOrgTree } from "./orgSlice";
import { underOwnersModel } from "@codecast/shared/contracts";
import { action } from "./mutativeMiddleware";
import {
  applyOwnersChangeTo,
  ownersChangeRefusal,
  ownersLeftRefusal,
  ownersOf,
  type OwnerRowFact,
  type OwnersChange,
  type SessionOwnerFacts,
} from "@codecast/shared/contracts/sessionOwners";

export type OwnerPersonInfo = {
  user_id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
  added_by?: string;
  added_at?: number;
  seen_at?: number | null;
  note?: string | null;
};

/** One `sessionOwners` row: the owners read (listOwners with session_owners:
 *  true), keyed by the conversation's id. */
export type SessionOwnersRow = {
  _id: string;
  /** Who holds an owner row, in the order added: the one home of that fact (a change paints it). */
  people_ids: string[];
  /** What the read says of each person: name, face, the row's stamps, keyed by id. Detail only:
   *  never enumerated to say who owns it (people_ids does). */
  people_info: Record<string, OwnerPersonInfo>;
  role: { role_id: string; short_id: string | null; handle: string; name: string } | null;
  parent_session: { conversation_id: string; short_id: string; title: string | null } | null;
  implicit_starter: OwnerPersonInfo | null;
  starter_id: string | null;
  role_started: boolean;
  can_edit: boolean;
  owners_changed_at: number | null;
};

/** A removed owner row put back as it was (an undo of a remove). */
export type OwnerRestoreRow = { user_id: string; added_by: string; added_at: number; seen_at?: number; note?: string };

/** One owners change, in the server's spelling (applyOwnersChange). */
export type SessionOwnersChange = {
  add?: string[];
  remove?: string[];
  restore?: OwnerRestoreRow[];
  /** A role id replaces the role; null removes it; absent leaves it. */
  role?: string | null;
  release_parent?: boolean;
  take_over?: boolean;
  /** Make it the worker of this session (a conversation id); the viewer's own row comes off. */
  adopt_parent?: string;
  /** Out from under any parent, link and release gone (an adopt's undo). */
  detach_parent?: boolean;
};

type OwnersState = { sessions?: Record<string, any>; conversations?: Record<string, any>; sessionOwners?: Record<string, SessionOwnersRow> };

/** The row a session's owners are read from: its inbox row, else the
 *  conversation it was opened from. */
export function ownersHomeOf(s: OwnersState, conversationId: string): any | null {
  return s.sessions?.[conversationId] ?? s.conversations?.[conversationId] ?? null;
}

/** The owners read of a session, or null: a cached row of another shape
 *  (an older build's) reads as none. */
export function ownersReadOf(s: OwnersState, conversationId: string): SessionOwnersRow | null {
  const row = s.sessionOwners?.[conversationId];
  return row && Array.isArray(row.people_ids) && row.people_info && typeof row.people_info === "object" ? row : null;
}

/** The session follows the owners model: its row says so, or its owners read
 *  does. A row cached before the flag turned on, or fed by a list that leaves
 *  the stamp off, lacks owners_model, so the read is asked too; a read off the
 *  model drops the cached one (applySessionOwnersReads), so the flag going off
 *  clears it the moment the session is read again. */
export function ownersModelOnFor(s: OwnersState, conversationId: string): boolean {
  if (ownersReadOf(s, conversationId)) return true;
  const inbox = s.sessions?.[conversationId];
  return inbox ? underOwnersModel(inbox) : ownersHomeOf(s, conversationId)?.owners_model === true;
}

const sameIds = (a: unknown, b: readonly string[]) => Array.isArray(a) && a.length === b.length && a.every((id, i) => String(id) === b[i]);

/** The role a session is the standing session of: its own row says so, else
 *  the org tree names it as a role's standing session. A parent session that
 *  is its child's role's seat is that role, not a second owner. */
export function seatRoleOf(s: any, sessionId: unknown): string | null {
  if (!sessionId) return null;
  const id = String(sessionId);
  const seat = s.sessions?.[id]?.standing_role_id ?? s.conversations?.[id]?.standing_role_id
    ?? (((windowOrgTree(s) as any)?.roles ?? []) as Array<{ _id: string; standing?: { conversation_id?: string } | null }>).find((r) => r.standing?.conversation_id === id)?._id;
  return seat ? String(seat) : null;
}

// ownerFactsOf per conversation, kept while its inputs are the same objects:
// every card and the header ask on every store change.
const factsMemo = new Map<string, { read: SessionOwnersRow; runner: unknown; facts: SessionOwnerFacts }>();

/**
 * The owner facts as the store shows them, from the owners read alone: who
 * holds an owner row in the order `people_ids` paints (a change the server has
 * not answered keeps its paint there, so a second change starts from the
 * first), its role and its parent. Null without a read.
 */
export function ownerFactsOf(s: OwnersState, conversationId: string): SessionOwnerFacts | null {
  const read = ownersReadOf(s, conversationId);
  if (!read) return null;
  const runner = ownersHomeOf(s, conversationId)?.user_id ?? null;
  const hit = factsMemo.get(conversationId);
  if (hit && hit.read === read && hit.runner === runner) return hit.facts;
  // people_ids' order is the truth; a stamp only spaces it. A server read is
  // already in stamp order, so its stamps stand. A person the paint added (no
  // stamp) or put back after leaving (a stale one) comes just after the one before.
  let last = 0;
  const rows: OwnerRowFact[] = read.people_ids.map((id) => {
    const stamp = read.people_info[String(id)]?.added_at ?? 0;
    last = stamp > last ? stamp : last + 1;
    return { user_id: String(id), added_at: last };
  });
  const parentId = read.parent_session?.conversation_id ?? null;
  const starter = read.starter_id ?? read.implicit_starter?.user_id ?? null;
  const facts: SessionOwnerFacts = {
    conversation_id: conversationId,
    rows,
    starter: starter ? String(starter) : null,
    user_id: runner,
    org_role_id: read.role?.role_id ?? null,
    parent_conversation_id: parentId,
    parent_released_at: parentId ? null : 0,
    role_started: read.role_started,
  };
  factsMemo.set(conversationId, { read, runner, facts });
  return facts;
}

/** Who owns the session as the store shows it: its people, then its implicit starter. */
export function ownerIdsOf(s: OwnersState, conversationId: string): string[] | null {
  const facts = ownerFactsOf(s, conversationId);
  if (!facts) return null;
  const o = ownersOf(facts);
  return o.implicitStarter ? [...o.people, o.implicitStarter] : o.people;
}

/** The shared rule's spelling of a store change. */
export function sharedChangeOf(change: SessionOwnersChange): OwnersChange {
  return {
    ...(change.add ? { add: change.add } : {}),
    ...(change.remove ? { remove: change.remove } : {}),
    ...(change.restore ? { restore: change.restore.map((r) => ({ user_id: r.user_id, added_at: r.added_at })) } : {}),
    ...(change.role !== undefined ? { role: change.role } : {}),
    ...(change.release_parent ? { releaseParent: true } : {}),
    ...(change.take_over ? { takeOver: true } : {}),
    ...(change.adopt_parent ? { adoptParent: change.adopt_parent } : {}),
    ...(change.detach_parent ? { detachParent: true } : {}),
  };
}

/** Why the viewer may not make this change (shared ownersChangeRefusal), or null. */
export function ownersChangeRefusalIn(s: OwnersState & { currentUser?: any }, conversationId: string, change: SessionOwnersChange): string | null {
  const facts = ownerFactsOf(s, conversationId);
  const actor = String(s.currentUser?._id ?? "");
  if (!facts || !actor) return null;
  const ctx = { actor, now: Date.now() };
  // The read's edit right is the server's: it knows the runner when the row does not.
  if (ownersReadOf(s, conversationId)?.can_edit) return ownersLeftRefusal(facts, sharedChangeOf(change), ctx);
  return ownersChangeRefusal(facts, sharedChangeOf(change), ctx);
}

export type SessionOwnersSliceActions = {
  /** One owners change. `inverse` puts it back for undo, as one change or
   *  several sent in order (one undo entry); null when nothing can. */
  applySessionOwners: (conversationId: string, change: SessionOwnersChange, inverse?: SessionOwnersChange | SessionOwnersChange[] | null) => void;
};

/** A role as the owners read spells it (sessionOwnership ownersModelRead),
 *  from the role rows, so the read's echo matches the paint. */
function roleRefOf(s: any, roleId: string): NonNullable<SessionOwnersRow["role"]> {
  const r = (Object.values(s.viewerRoles ?? {}) as any[]).find((x) => String(x?._id) === roleId)
    ?? (((windowOrgTree(s) as any)?.roles ?? []) as any[]).find((x) => String(x?._id) === roleId);
  return { role_id: roleId, short_id: r?.short_id ?? null, handle: r?.handle ?? "", name: r?.name ?? "Role" };
}

export function createSessionOwnersSlice(): SessionOwnersSliceActions {
  return {
    applySessionOwners: action(function (this: any, conversationId: string, change: SessionOwnersChange, _inverse?: SessionOwnersChange | SessionOwnersChange[] | null) {
      const actor = String(this.currentUser?._id ?? "");
      if (!actor) return;
      const facts = ownerFactsOf(this, conversationId);
      if (!facts) {
        // Add me on a session whose read has not arrived (an agent not yet
        // read): a new read row holding only you, which the server's read
        // replaces when it lands.
        if (change.add?.includes(actor) && !this.sessionOwners[conversationId]) {
          this.sessionOwners[conversationId] = {
            _id: conversationId, people_ids: [actor], people_info: {}, role: null, parent_session: null,
            implicit_starter: null, starter_id: null, role_started: false, can_edit: false, owners_changed_at: null,
          } satisfies SessionOwnersRow;
        }
        return;
      }
      const next = ownersOf(applyOwnersChangeTo(facts, sharedChangeOf(change), { actor, now: Date.now() }));
      const read = this.sessionOwners[conversationId];
      if (!sameIds(read.people_ids, next.people)) read.people_ids = next.people;
      if ((read.role?.role_id ?? null) !== next.role) read.role = next.role ? roleRefOf(this, next.role) : null;
      if (!next.parentSession && read.parent_session) read.parent_session = null;
      if (change.adopt_parent && next.parentSession === change.adopt_parent && read.parent_session?.conversation_id !== next.parentSession) {
        const home = ownersHomeOf(this, next.parentSession);
        read.parent_session = { conversation_id: next.parentSession, short_id: home?.short_id ?? next.parentSession.slice(0, 7), title: home?.title ?? null };
      }
      // The inbox row's stamps, as the server will stamp them for the viewer:
      // the row moves in or out of the inbox, and its agent stops or starts
      // answering, in the same tick.
      const row = this.sessions?.[conversationId];
      if (row && underOwnersModel(row)) {
        const stamps: Record<string, unknown> = {
          owned_by_me: next.people.includes(actor),
          implicit_owner: next.implicitStarter,
          org_role_id: next.role,
          owner_session_id: next.parentSession,
        };
        // An adopt nests it under the target as the server writes it
        // (convex lib/ownersChange): the parent link, and adopted_at stamped
        // once, so the target's card draws it on the press (ownedChildrenOf).
        // A detach takes both off.
        if (change.adopt_parent && next.parentSession === change.adopt_parent) {
          stamps.parent_conversation_id = change.adopt_parent;
          stamps.adopted_at = row.adopted_at ?? Date.now();
        } else if (change.detach_parent) {
          stamps.parent_conversation_id = null;
          stamps.adopted_at = null;
        }
        for (const [field, value] of Object.entries(stamps)) if ((row[field] ?? null) !== (value ?? null)) row[field] = value;
      }
    }) as SessionOwnersSliceActions["applySessionOwners"],
  };
}
