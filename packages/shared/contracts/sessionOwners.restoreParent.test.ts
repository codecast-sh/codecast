import { describe, expect, test } from "bun:test";
import { applyOwnersChangeTo, ownersChangeRefusal, ownersOf, releasedParentOf, type SessionOwnerFacts } from "./sessionOwners";

// Putting the parent back: a person took a worker over (or released its
// parent), and hands it back to the session it was nested under.

const ME = "me";
const S = "sess";
const LEAD = "lead";
const ROLE = "role";
const at = { actor: ME, now: 1000 };

const facts = (over: Partial<SessionOwnerFacts> = {}): SessionOwnerFacts => ({
  conversation_id: S,
  rows: [],
  starter: ME,
  user_id: ME,
  parent_conversation_id: LEAD,
  ...over,
});

describe("restoreParent", () => {
  test("a take-over and its restore are a round trip, and the taker stays an owner", () => {
    const taken = applyOwnersChangeTo(facts({ parent_released_at: null }), { takeOver: true }, at);
    expect(ownersOf(taken)).toEqual({ people: [ME], role: null, parentSession: null, implicitStarter: null });
    expect(releasedParentOf(taken)).toBe(LEAD);
    const back = applyOwnersChangeTo(taken, { restoreParent: true }, at);
    expect(back.parent_released_at).toBeNull();
    expect(ownersOf(back)).toEqual({ people: [ME], role: null, parentSession: LEAD, implicitStarter: null });
  });

  test("keeps the role and the people", () => {
    const f = facts({ parent_released_at: 5, org_role_id: ROLE, rows: [{ user_id: ME, added_at: 1 }] });
    const back = applyOwnersChangeTo(f, { restoreParent: true }, at);
    expect(ownersOf(back)).toEqual({ people: [ME], role: ROLE, parentSession: LEAD, implicitStarter: null });
  });

  test("an implicit starter keeps owning it: their row is written", () => {
    const f = facts({ parent_released_at: 5 });
    expect(ownersOf(f).implicitStarter).toBe(ME);
    const back = applyOwnersChangeTo(f, { restoreParent: true }, at);
    expect(ownersOf(back).people).toEqual([ME]);
  });

  test("is refused when no released parent is left to go back to", () => {
    expect(ownersChangeRefusal(facts({ parent_released_at: null }), { restoreParent: true }, at)).toBe("It has no session to go back to");
    expect(ownersChangeRefusal(facts({ parent_conversation_id: null, parent_released_at: 5 }), { restoreParent: true }, at)).toBe("It has no session to go back to");
    expect(ownersChangeRefusal(facts({ parent_released_at: 5 }), { restoreParent: true }, at)).toBeNull();
  });

  test("a release in the same change wins over a restore", () => {
    const next = applyOwnersChangeTo(facts({ parent_released_at: null }), { releaseParent: true, restoreParent: true }, at);
    expect(next.parent_released_at).toBe(1000);
  });

  test("is not something a viewer may do by only adding themselves", () => {
    const f = facts({ parent_released_at: 5, rows: [{ user_id: "mate", added_at: 1 }], user_id: "mate", starter: "mate" });
    expect(ownersChangeRefusal(f, { add: [ME], restoreParent: true }, at)).toBe("Only its owners can change who owns it; you can add yourself");
  });
});
