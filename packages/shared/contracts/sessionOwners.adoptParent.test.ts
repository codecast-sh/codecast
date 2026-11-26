import { describe, expect, test } from "bun:test";
import { applyOwnersChangeTo, ownersChangeRefusal, ownersLeftRefusal, ownersOf, removesAgentOwner, type SessionOwnerFacts } from "./sessionOwners";

// Adopting a parent: a person drags a session onto another, and the dragged
// one becomes that session's worker. The parent owns it, a release is cleared,
// and the dragger's own owner row comes off; other people's rows stay.

const ME = "me";
const MATE = "mate";
const S = "sess";
const LEAD = "lead";
const at = { actor: ME, now: 1000 };

const facts = (over: Partial<SessionOwnerFacts> = {}): SessionOwnerFacts => ({
  conversation_id: S,
  rows: [],
  starter: ME,
  user_id: ME,
  ...over,
});

describe("applyOwnersChangeTo with adoptParent", () => {
  test("sets the parent, drops the actor's row and keeps the others", () => {
    const f = facts({ rows: [{ user_id: ME, added_at: 1 }, { user_id: MATE, added_at: 2 }] });
    const next = applyOwnersChangeTo(f, { adoptParent: LEAD }, at);
    expect(next.parent_conversation_id).toBe(LEAD);
    expect(next.parent_released_at).toBeNull();
    expect(next.rows).toEqual([{ user_id: MATE, added_at: 2 }]);
    expect(ownersOf(next)).toEqual({ people: [MATE], role: null, parentSession: LEAD, implicitStarter: null });
  });

  test("clears an earlier release, from the old parent or the new one", () => {
    const f = facts({ parent_conversation_id: "old", parent_released_at: 500 });
    expect(ownersOf(f).parentSession).toBeNull();
    const next = applyOwnersChangeTo(f, { adoptParent: LEAD }, at);
    expect(next.parent_released_at).toBeNull();
    expect(ownersOf(next).parentSession).toBe(LEAD);
  });

  test("the implicit starter lapses: the parent owns it alone", () => {
    const f = facts();
    expect(ownersOf(f).implicitStarter).toBe(ME);
    const o = ownersOf(applyOwnersChangeTo(f, { adoptParent: LEAD }, at));
    expect(o).toEqual({ people: [], role: null, parentSession: LEAD, implicitStarter: null });
  });

  test("the parent becomes the agent owner: the role comes off and it is no longer a role's start", () => {
    const next = applyOwnersChangeTo(facts({ org_role_id: "role1", role_started: true }), { adoptParent: LEAD }, at);
    expect(next.role_started).toBeNull();
    expect(ownersOf(next).role).toBeNull();
    expect(ownersOf(next).parentSession).toBe(LEAD);
  });

  test("an undo puts the old parent back, released when it was, with the actor's row", () => {
    const f = facts({ rows: [], parent_conversation_id: LEAD });
    const back = applyOwnersChangeTo(f, { adoptParent: "old", releaseParent: true, restore: [{ user_id: ME, added_at: 3 }] }, at);
    expect(back.parent_conversation_id).toBe("old");
    expect(back.parent_released_at).toBe(1000);
    expect(back.rows).toEqual([{ user_id: ME, added_at: 3 }]);
    expect(ownersChangeRefusal(f, { adoptParent: LEAD, releaseParent: true }, at)).toBeNull();
  });

  test("takes no agent owner off", () => {
    expect(removesAgentOwner(facts(), { adoptParent: LEAD })).toBe(false);
  });
});

describe("adoptParent refusals", () => {
  test("a session cannot work for itself", () => {
    expect(ownersChangeRefusal(facts(), { adoptParent: S }, at)).toMatch(/itself/);
    expect(ownersLeftRefusal(facts(), { adoptParent: S }, at)).toMatch(/itself/);
  });

  test("nor for the parent that already owns it", () => {
    expect(ownersChangeRefusal(facts({ parent_conversation_id: LEAD }), { adoptParent: LEAD }, at)).toMatch(/already works/);
  });

  test("a released parent may adopt it again", () => {
    expect(ownersChangeRefusal(facts({ parent_conversation_id: LEAD, parent_released_at: 5 }), { adoptParent: LEAD }, at)).toBeNull();
  });

  test("only someone who may edit its owners may hand it over", () => {
    const f = facts({ rows: [{ user_id: MATE, added_at: 1 }], user_id: "runner" });
    expect(ownersChangeRefusal(f, { adoptParent: LEAD }, at)).toMatch(/Only its owners/);
    expect(ownersChangeRefusal(f, { adoptParent: LEAD }, { actor: MATE, now: 1000 })).toBeNull();
  });
});

describe("detachParent", () => {
  test("takes the parent link and its release off, and the starter owns it again", () => {
    for (const released of [null, 50]) {
      const next = applyOwnersChangeTo(facts({ parent_conversation_id: LEAD, parent_released_at: released }), { detachParent: true }, at);
      expect(next.parent_conversation_id).toBeNull();
      expect(next.parent_released_at).toBeNull();
      expect(ownersOf(next)).toEqual({ people: [], role: null, parentSession: null, implicitStarter: ME });
    }
  });

  test("undoes an adopt that found no parent exactly, the actor's row and role included", () => {
    const before = facts({ rows: [{ user_id: ME, added_at: 10 }], org_role_id: "role1", parent_conversation_id: null });
    const adopted = applyOwnersChangeTo(before, { adoptParent: LEAD }, at);
    const back = applyOwnersChangeTo(adopted, { detachParent: true, role: "role1", restore: [{ user_id: ME, added_at: 10 }] }, at);
    expect(back.parent_conversation_id).toBeNull();
    expect(ownersOf(back)).toEqual(ownersOf(before));
  });

  test("only someone who may edit its owners may detach it", () => {
    const f = facts({ rows: [{ user_id: MATE, added_at: 1 }], user_id: "runner", parent_conversation_id: LEAD });
    expect(ownersChangeRefusal(f, { detachParent: true }, at)).toMatch(/Only its owners/);
  });
});

