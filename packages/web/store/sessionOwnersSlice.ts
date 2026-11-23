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
import { action } from "./mutativeMiddleware";
import { applyOwnersChangeTo, listedOwnerIds, ownersFactsFromRead, type OwnerRowFact, type OwnersFacts } from "@codecast/shared/contracts/sessionOwners";

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

type OwnersHome = { field: "sessions" | "conversations"; row: any };

/** The row a session's owners live on: its inbox row, else the conversation
 *  it was opened from. */
export function ownersHomeOf(s: { sessions?: Record<string, any>; conversations?: Record<string, any> }, conversationId: string): OwnersHome | null {
  const session = s.sessions?.[conversationId];
  if (session) return { field: "sessions", row: session };
  const conversation = s.conversations?.[conversationId];
  return conversation ? { field: "conversations", row: conversation } : null;
}

const sameIds = (a: unknown, b: readonly string[]) => Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);

/** The owners read's half of owner_ids (the inbox rows are the other): onto
 *  the session row through syncRecord, so a Save's hold on it is released by
 *  this echo too. An equal list keeps the row's own array. */
export function feedSessionOwnerIds(
  store: { sessions: Record<string, any>; conversations: Record<string, any>; syncRecord: (field: string, id: string, record: any) => void },
  conversationId: string,
  ownerIds: string[],
): void {
  const home = ownersHomeOf(store, conversationId);
  if (!home) return;
  const held = home.row.owner_ids;
  store.syncRecord(home.field, conversationId, { owner_ids: sameIds(held, ownerIds) ? held : ownerIds });
}

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
};

export function createSessionOwnersSlice(): SessionOwnersSliceActions {
  return {
    applySessionOwners: action(function (this: any, conversationId: string, change: SessionOwnersChange, _inverse?: SessionOwnersChange | null) {
      const people = this.sessionOwners?.[conversationId];
      const home = ownersHomeOf(this, conversationId)?.row;
      if (!people || !home || home.standing_role_id) return;
      const before = paintedFacts(people, home);
      const to = change.leave?.runner_id ? { runner_id: change.leave.runner_id, runner_is_bot: !!change.leave.runner_is_bot } : undefined;
      const next = applyOwnersChangeTo(before, { ...change, leave: change.leave ? { move_to: to } : undefined }, { actor: String(this.currentUser?._id ?? ""), now: Date.now() });
      home.owner_ids = listedOwnerIds(next);
      if ((home.org_role_id ?? null) !== next.role_id) home.org_role_id = next.role_id;
      if ((home.driver_user_id ?? null) !== next.driver_user_id) home.driver_user_id = next.driver_user_id;
    }) as SessionOwnersSliceActions["applySessionOwners"],
  };
}
