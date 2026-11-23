// A session's owners and who drives it, as the owners menu saves them
// (convex sessionOwnership.applyOwnersChange). One write, painted on the
// click by the same rule the server runs (shared/contracts/sessionOwners), in
// the session row (sessions, else the conversation it was opened from), the
// one home of its people (owner_ids), its role and its driver. Two feeders
// write owner_ids there: the inbox rows and the owners read (listOwners, via
// feedSessionOwnerIds), so the card and the header read one field and either
// echo releases the Save. sessionOwners holds only the menu's details. The
// write rides `dispatch` to the side effect of the same name.
//
// Spread into the org slice (orgSlice createOrgSlice), so the store gains it
// without a line of its own.
import { action, asyncAction, sync } from "./mutativeMiddleware";
import { applySyncPatch } from "./syncProtocol";
import { startedByRole } from "@codecast/shared/contracts";
import { applyOwnersChangeTo, isLeave, listedOwnerIds, ownersFactsFromRead, takeOverBySend, type OwnerRowFact, type OwnersFacts } from "@codecast/shared/contracts/sessionOwners";

/** Who drives a session: the role it is filed under, one of its people, or
 *  (`none`) the default, which is how an undo puts back a driver nobody chose. */
export type SessionDriverTarget = { kind: "role" } | { kind: "user"; user_id: string } | { kind: "none" };

/** One Save of the owners menu: people added and removed, the role set or
 *  taken off (`role` absent leaves it), who drives, and leaving (after a move
 *  off your account when it runs there). */
export type SessionOwnersChange = {
  add?: string[];
  remove?: string[];
  /** Rows put back as they were (an undo of a remove). */
  restore?: OwnerRowFact[];
  role?: string | null;
  driver?: SessionDriverTarget;
  /** `runner_id`/`runner_is_bot` name the account the move hands it to: the
   *  store needs them to paint the result; only the device goes to the server. */
  leave?: { move_to_device_id?: string; runner_id?: string; runner_is_bot?: boolean };
  note?: string;
};

/** The row a session's owners live on: its inbox row, else the conversation
 *  it was opened from. */
function ownersHomeOf(s: { sessions?: Record<string, any>; conversations?: Record<string, any> }, conversationId: string): any | null {
  return s.sessions?.[conversationId] ?? s.conversations?.[conversationId] ?? null;
}

const sameIds = (a: unknown, b: readonly string[]) => Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);

/** The people as the owners rule reads them, from what the store shows: the
 *  read's rows, or, when a Save the server has not answered yet painted
 *  owner_ids, those people (each keeping its stamp, new ones after), so a
 *  second Save starts from the first. */
export function paintedFacts(read: any, home: any): OwnersFacts {
  const facts = ownersFactsFromRead(read, home);
  const painted: unknown = home?.owner_ids;
  if (!Array.isArray(painted) || sameIds(painted, listedOwnerIds(facts))) return facts;
  let last = Math.max(0, ...facts.rows.map((r) => r.added_at));
  const rows = (painted as string[]).map((id) => facts.rows.find((r) => r.user_id === id) ?? { user_id: id, added_at: ++last });
  return { ...facts, rows };
}

export type SessionOwnersSliceActions = {
  /** `inverse` puts the Save back for undo; null when nothing can. */
  applySessionOwners: (conversationId: string, change: SessionOwnersChange, inverse?: SessionOwnersChange | null) => void;
  /** The owners read's half of owner_ids (the inbox rows are the other). */
  feedSessionOwnerIds: (conversationId: string, ownerIds: string[]) => void;
  /** The composer's "Tell <role>": the words go to the role's own session
   *  (dispatch tellSessionRole) and the role keeps driving this one. Resolves
   *  once the server has queued them, so the composer keeps the words until then. */
  tellSessionRole: (conversationId: string, content: string, clientId: string) => Promise<unknown>;
};

export function createSessionOwnersSlice(): SessionOwnersSliceActions {
  return {
    applySessionOwners: action(function (this: any, conversationId: string, change: SessionOwnersChange, _inverse?: SessionOwnersChange | null) {
      const people = this.sessionOwners?.[conversationId];
      const home = ownersHomeOf(this, conversationId);
      if (!people || !home || home.standing_role_id) return;
      const before = paintedFacts(people, home);
      const to = change.leave?.runner_id ? { runner_id: change.leave.runner_id, runner_is_bot: !!change.leave.runner_is_bot } : undefined;
      const actor = String(this.currentUser?._id ?? "");
      const next = applyOwnersChangeTo(before, { ...change, leave: change.leave ? { move_to: to } : undefined }, { actor, now: Date.now() });
      home.owner_ids = listedOwnerIds(next);
      if ((home.org_role_id ?? null) !== next.role_id) home.org_role_id = next.role_id;
      if ((home.driver_user_id ?? null) !== next.driver_user_id) home.driver_user_id = next.driver_user_id;
      // A leave takes the session out of the leaver's inbox as the server
      // will: no claim on it, and after a move it runs on the other account.
      if (isLeave(change, actor)) {
        if (home.owned_by_me) home.owned_by_me = false;
        if (next.runner_id !== before.runner_id) home.user_id = next.runner_id;
        if ((home.owner_user_id ?? null) !== next.primary_id) home.owner_user_id = next.primary_id;
      } else if (actor && (change.add ?? []).includes(actor) && !home.owned_by_me) {
        // Rejoining (a leave's undo) puts the claim back.
        home.owned_by_me = true;
      }
      // A run a role started with no person left is the role's alone again
      // (runnerTakesLeftSession gave nobody a row): out of the runner's inbox.
      const alone = next.rows.length === 0 && startedByRole({ org_role_id: next.role_id, role_started: next.role_started, standing_role_id: next.standing_role_id });
      if (!!home.role_alone !== alone) home.role_alone = alone;
    }) as SessionOwnersSliceActions["applySessionOwners"],
    // Onto both twins it has (the inbox row and the conversation it was opened
    // from), so a Save made on either is released by this echo and neither
    // goes stale when the session enters or leaves the inbox. A partial patch:
    // only the owner_ids lock is checked, never the row's other locks. An
    // equal list keeps the row's own array.
    feedSessionOwnerIds: sync(function (this: any, conversationId: string, ownerIds: string[]) {
      for (const field of ["sessions", "conversations"] as const) {
        const row = this[field]?.[conversationId];
        if (!row) continue;
        const { fields, pending } = applySyncPatch(field, conversationId, { owner_ids: ownerIds }, [], this.pending);
        this.pending = pending;
        if (!sameIds(row.owner_ids, fields.owner_ids)) row.owner_ids = fields.owner_ids;
      }
    }) as SessionOwnersSliceActions["feedSessionOwnerIds"],
    // Nothing here changes: the message lands in the role's thread, not this one.
    tellSessionRole: asyncAction(function (this: any, _conversationId: string, _content: string, _clientId: string) {}) as SessionOwnersSliceActions["tellSessionRole"],
  };
}

/** A send that takes the wheel: only the session composer whose owner line
 *  said so passes it (convex lib/sessionTakeOver). */
export type SendTakeOver = { take_over?: boolean };

/**
 * The session composer's own send takes the wheel (convex lib/sessionTakeOver),
 * painted on the send's draft so the owner line and the header change with
 * the bubble. It reads and writes the owners exactly where applySessionOwners
 * does, so the two move together. Without the people row (the header never
 * mounted) only the runner, whom the server always lets take it, is painted;
 * anyone else waits for the echo rather than paint a guess the server may not
 * make.
 */
export function paintTakeOverOnSend(draft: any, conversationId: string): void {
  const me = String(draft.currentUser?._id ?? "");
  const people = draft.sessionOwners?.[conversationId];
  const home = draft.sessions?.[conversationId] ?? draft.conversations?.[conversationId];
  if (!me || !home || (!people && String(home.user_id ?? "") !== me)) return;
  const next = takeOverBySend(paintedFacts(people, home), me, Date.now());
  if (!next) return;
  const ownerIds = listedOwnerIds(next);
  if (!sameIds(home.owner_ids, ownerIds)) home.owner_ids = ownerIds;
  if ((home.driver_user_id ?? null) !== next.driver_user_id) home.driver_user_id = next.driver_user_id;
}
