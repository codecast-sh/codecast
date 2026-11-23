// A session's owners and who drives it, as the owners menu saves them
// (convex sessionOwnership.applyOwnersChange). One write, painted on the
// click by the same rule the server runs (shared/contracts/sessionOwners), in
// each fact's one home: the role and the driver on the session row, and the
// people on the inbox row when the session is listed (its owner_ids, which
// the card draws), else on the sessionOwners row (ownerIdsHomeOf). It rides
// `dispatch` to the side effect of the same name, and the fields it holds
// release on the echo.
//
// Spread into the org slice (orgSlice createOrgSlice), so the store gains it
// without a line of its own.
import { action } from "./mutativeMiddleware";
import { applyOwnersChangeTo, listedOwnerIds, ownersFactsFromRead, type OwnerRowFact } from "@codecast/shared/contracts/sessionOwners";

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

/** Where a session's people live: its inbox row once the server lists them
 *  there, else its sessionOwners row. The header reads by the same test
 *  (useStoreOwnersEnv), so the card and the header hold one answer. */
type OwnerIdsHolder = { owner_ids?: string[] | null };
export function ownerIdsHomeOf(home: OwnerIdsHolder, people: OwnerIdsHolder): OwnerIdsHolder {
  return Array.isArray(home.owner_ids) ? home : people;
}

export type SessionOwnersSliceActions = {
  /** `inverse` puts the Save back for undo; null when nothing can. */
  applySessionOwners: (conversationId: string, change: SessionOwnersChange, inverse?: SessionOwnersChange | null) => void;
};

export function createSessionOwnersSlice(): SessionOwnersSliceActions {
  return {
    applySessionOwners: action(function (this: any, conversationId: string, change: SessionOwnersChange, _inverse?: SessionOwnersChange | null) {
      const people = this.sessionOwners?.[conversationId];
      const home = this.sessions?.[conversationId] ?? this.conversations?.[conversationId];
      if (!people || !home || home.standing_role_id) return;
      const before = ownersFactsFromRead(people, home);
      const to = change.leave?.runner_id ? { runner_id: change.leave.runner_id, runner_is_bot: !!change.leave.runner_is_bot } : undefined;
      const next = applyOwnersChangeTo(before, { ...change, leave: change.leave ? { move_to: to } : undefined }, { actor: String(this.currentUser?._id ?? ""), now: Date.now() });
      ownerIdsHomeOf(home, people).owner_ids = listedOwnerIds(next);
      if ((home.org_role_id ?? null) !== next.role_id) home.org_role_id = next.role_id;
      if ((home.driver_user_id ?? null) !== next.driver_user_id) home.driver_user_id = next.driver_user_id;
    }) as SessionOwnersSliceActions["applySessionOwners"],
  };
}
