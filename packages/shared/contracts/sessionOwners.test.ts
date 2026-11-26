import { describe, expect, test } from "bun:test";
import {
  actsForRole,
  agentOwnerOf,
  applyOwnersChangeTo,
  mayEditOwners,
  ownersChangeRefusal,
  ownersModelOn,
  ownersOf,
  ownsSession,
  waitAudience,
  type SessionOwnerFacts,
} from "./sessionOwners";

const ME = "u_me";
const ASHOT = "u_ashot";
const BOT = "u_bot";
const ROLE = "r_eval";
const PARENT = "c_parent";
const NOW = 1_000;

const facts = (over: Partial<SessionOwnerFacts> = {}): SessionOwnerFacts => ({ rows: [], starter: ME, user_id: ME, ...over });
const row = (user_id: string, added_at: number) => ({ user_id, added_at });

describe("ownersOf", () => {
  test("the starter owns a session nobody else does", () => {
    expect(ownersOf(facts())).toEqual({ people: [], role: null, parentSession: null, implicitStarter: ME });
  });

  test("people come in the order they were added, and the starter is not implicit", () => {
    expect(ownersOf(facts({ rows: [row(ASHOT, 5), row(ME, 2)] })).people).toEqual([ME, ASHOT]);
    expect(ownersOf(facts({ rows: [row(ASHOT, 5)] })).implicitStarter).toBeNull();
  });

  test("a role or a parent session takes the starter's place", () => {
    expect(ownersOf(facts({ org_role_id: ROLE }))).toEqual({ people: [], role: ROLE, parentSession: null, implicitStarter: null });
    expect(ownersOf(facts({ parent_conversation_id: PARENT })).parentSession).toBe(PARENT);
    expect(ownersOf(facts({ parent_conversation_id: PARENT })).implicitStarter).toBeNull();
  });

  test("a released parent no longer owns it", () => {
    const o = ownersOf(facts({ parent_conversation_id: PARENT, parent_released_at: 5 }));
    expect(o.parentSession).toBeNull();
    expect(o.implicitStarter).toBe(ME);
  });

  test("a role-started session never has an implicit starter, even once the role is off", () => {
    expect(ownersOf(facts({ org_role_id: ROLE, role_started: true })).implicitStarter).toBeNull();
    expect(ownersOf(facts({ role_started: true })).implicitStarter).toBeNull();
  });

  test("a session with no human starter has no implicit owner", () => {
    expect(ownersOf(facts({ starter: null, user_id: BOT })).implicitStarter).toBeNull();
  });
});

// Only a nested worker (parent_conversation_id) has a parent session owner. A
// session another one only spawned (spawned_by_conversation_id: a plain
// `cast spawn`, an agent-team teammate) is its spawner's peer. The facts type
// no longer carries spawned_by, so these pass it through a cast to prove the
// rule ignores it.
describe("a plain spawn is its spawner's peer", () => {
  const spawned = (over: Partial<SessionOwnerFacts> = {}) => facts({ spawned_by_conversation_id: PARENT, ...over } as Partial<SessionOwnerFacts>);
  const reach = { agentReachable: true, fallbackPerson: null };

  test("no parent session owns it: its starter does", () => {
    expect(ownersOf(spawned())).toEqual({ people: [], role: null, parentSession: null, implicitStarter: ME });
  });

  test("its waits go to its starter, even with an agent reachable", () => {
    expect(waitAudience(spawned(), reach)).toEqual({ agent: null, people: [ME], person: null });
  });

  test("a --subagent worker is owned by the session it is nested under, which hears its waits", () => {
    for (const f of [facts({ parent_conversation_id: PARENT }), spawned({ parent_conversation_id: PARENT })]) {
      expect(ownersOf(f)).toEqual({ people: [], role: null, parentSession: PARENT, implicitStarter: null });
      expect(waitAudience(f, reach)).toEqual({ agent: { kind: "session", id: PARENT }, people: [], person: null });
    }
  });
});

describe("agentOwnerOf", () => {
  test("the role answers before the parent session", () => {
    expect(agentOwnerOf(facts({ org_role_id: ROLE, parent_conversation_id: PARENT }))).toEqual({ kind: "role", id: ROLE });
    expect(agentOwnerOf(facts({ parent_conversation_id: PARENT }))).toEqual({ kind: "session", id: PARENT });
    expect(agentOwnerOf(facts({ parent_conversation_id: PARENT, parent_released_at: 1 }))).toBeNull();
    expect(agentOwnerOf(facts())).toBeNull();
  });
});

describe("ownsSession and mayEditOwners", () => {
  test("people and the implicit starter own it; the runner edits but does not own", () => {
    expect(ownsSession(facts(), ME)).toBe(true);
    expect(ownsSession(facts({ rows: [row(ASHOT, 1)] }), ME)).toBe(false);
    expect(ownsSession(facts({ rows: [row(ASHOT, 1)] }), ASHOT)).toBe(true);
    expect(mayEditOwners(facts({ rows: [row(ASHOT, 1)] }), ME)).toBe(true);
    expect(mayEditOwners(facts({ rows: [row(ASHOT, 1)], user_id: BOT }), ME)).toBe(false);
  });
});

describe("applyOwnersChangeTo", () => {
  const at = { actor: ME, now: NOW };

  test("adding a person keeps the starter as a row of their own, first", () => {
    const next = applyOwnersChangeTo(facts(), { add: [ASHOT] }, at);
    expect(ownersOf(next).people).toEqual([ME, ASHOT]);
  });

  test("adding a role keeps the starter as an owner", () => {
    const next = applyOwnersChangeTo(facts(), { role: ROLE }, at);
    expect(ownersOf(next)).toEqual({ people: [ME], role: ROLE, parentSession: null, implicitStarter: null });
  });

  test("delegating to a role and leaving at once writes no starter row", () => {
    const next = applyOwnersChangeTo(facts(), { role: ROLE, remove: [ME] }, at);
    expect(ownersOf(next)).toEqual({ people: [], role: ROLE, parentSession: null, implicitStarter: null });
  });

  test("adding a person keeps the role; a new role replaces the old", () => {
    const withRole = facts({ rows: [row(ME, 1)], org_role_id: ROLE });
    expect(ownersOf(applyOwnersChangeTo(withRole, { add: [ASHOT] }, at)).role).toBe(ROLE);
    expect(ownersOf(applyOwnersChangeTo(withRole, { role: "r_other" }, at)).role).toBe("r_other");
  });

  test("taking over a role's start takes the role off, makes the taker an owner and ends the role's start", () => {
    const roleRun = facts({ org_role_id: ROLE, role_started: true, starter: null, user_id: BOT });
    const next = applyOwnersChangeTo(roleRun, { takeOver: true }, at);
    expect(ownersOf(next)).toEqual({ people: [ME], role: null, parentSession: null, implicitStarter: null });
    expect(next.role_started).toBeNull();
  });

  test("taking over a sub-agent releases its parent and makes the taker an owner", () => {
    const next = applyOwnersChangeTo(facts({ parent_conversation_id: PARENT }), { takeOver: true }, { actor: ASHOT, now: NOW });
    expect(next.parent_released_at).toBe(NOW);
    expect(ownersOf(next)).toEqual({ people: [ASHOT], role: null, parentSession: null, implicitStarter: null });
  });

  test("taking over removes every agent owner, role and parent", () => {
    const next = applyOwnersChangeTo(facts({ org_role_id: ROLE, parent_conversation_id: PARENT }), { takeOver: true }, at);
    expect(ownersOf(next)).toEqual({ people: [ME], role: null, parentSession: null, implicitStarter: null });
  });

  test("removing the role or releasing the parent alone removes only that one and adds nobody", () => {
    const both = facts({ rows: [row(ASHOT, 1)], org_role_id: ROLE, parent_conversation_id: PARENT });
    expect(ownersOf(applyOwnersChangeTo(both, { role: null }, at))).toEqual({ people: [ASHOT], role: null, parentSession: PARENT, implicitStarter: null });
    expect(ownersOf(applyOwnersChangeTo(both, { releaseParent: true }, at))).toEqual({ people: [ASHOT], role: ROLE, parentSession: null, implicitStarter: null });
  });

  test("a restore keeps the implicit starter as a row of their own", () => {
    const next = applyOwnersChangeTo(facts(), { restore: [row(ASHOT, 5)] }, at);
    expect(ownersOf(next).people).toEqual([ASHOT, ME]);
  });

  test("a released parent counts as released at any stamp, 0 included", () => {
    expect(ownersOf(facts({ parent_conversation_id: PARENT, parent_released_at: 0 })).parentSession).toBeNull();
  });

  test("an owner already present is not added twice", () => {
    const next = applyOwnersChangeTo(facts({ rows: [row(ME, 1)], org_role_id: ROLE }), { role: null }, at);
    expect(next.rows).toEqual([row(ME, 1)]);
  });

  test("restored rows come back in their old place", () => {
    const next = applyOwnersChangeTo(facts({ rows: [row(ME, 1), row("u_c", 9)] }), { restore: [row(ASHOT, 5)] }, at);
    expect(ownersOf(next).people).toEqual([ME, ASHOT, "u_c"]);
  });

  test("removing the last person brings the starter back as implicit owner", () => {
    const next = applyOwnersChangeTo(facts({ rows: [row(ASHOT, 1)] }), { remove: [ASHOT] }, at);
    expect(ownersOf(next).implicitStarter).toBe(ME);
  });
});

describe("ownersChangeRefusal", () => {
  const as = (actor: string) => ({ actor, now: NOW });

  test("anyone may add themselves; only an owner or the runner may do more", () => {
    const f = facts({ rows: [row(ME, 1)] });
    expect(ownersChangeRefusal(f, { add: [ASHOT] }, as(ASHOT))).toBeNull();
    expect(ownersChangeRefusal(f, { add: [ASHOT, "u_c"] }, as(ASHOT))).toMatch(/Only its owners/);
    expect(ownersChangeRefusal(f, { remove: [ME] }, as(ASHOT))).toMatch(/Only its owners/);
    expect(ownersChangeRefusal(f, { add: ["u_c"] }, as(ME))).toBeNull();
  });

  test("the runner edits a session it does not own", () => {
    expect(ownersChangeRefusal(facts({ rows: [row(ASHOT, 1)] }), { add: ["u_c"] }, as(ME))).toBeNull();
  });

  test("a change that leaves nobody is refused", () => {
    const roleRun = facts({ org_role_id: ROLE, role_started: true, starter: null, user_id: BOT, rows: [row(ME, 1)] });
    expect(ownersChangeRefusal(roleRun, { role: null, remove: [ME] }, as(ME))).toMatch(/Nobody would own it/);
    expect(ownersChangeRefusal(facts({ org_role_id: ROLE, role_started: true, starter: null, user_id: BOT }), { role: null }, as(BOT))).toMatch(/Nobody would own it/);
  });

  test("the starter cannot leave a session nobody else owns", () => {
    expect(ownersChangeRefusal(facts({ rows: [row(ME, 1)] }), { remove: [ME] }, as(ME))).toMatch(/You started it/);
    expect(ownersChangeRefusal(facts({ rows: [row(ME, 1), row(ASHOT, 2)] }), { remove: [ME] }, as(ME))).toBeNull();
    expect(ownersChangeRefusal(facts({ rows: [row(ME, 1)], org_role_id: ROLE }), { remove: [ME] }, as(ME))).toBeNull();
  });
});

describe("actsForRole", () => {
  test("a standing session, or a role's own start it still owns", () => {
    expect(actsForRole({ standing_role_id: ROLE })).toBe(true);
    expect(actsForRole({ role_started: true, org_role_id: ROLE })).toBe(true);
    expect(actsForRole({ role_started: true })).toBe(false);
    expect(actsForRole({ org_role_id: ROLE })).toBe(false);
  });
});

describe("ownersModelOn", () => {
  const on = { _id: "t_on", features: { session_owners: true } };
  const off = { _id: "t_off", features: {} };
  test("a team session reads its own team's flag", () => {
    expect(ownersModelOn({ team_id: "t_on" }, [on, off])).toBe(true);
    expect(ownersModelOn({ team_id: "t_off" }, [on, off])).toBe(false);
  });
  test("a personal session is on when its runner is in any team with the flag", () => {
    expect(ownersModelOn({}, [off, on])).toBe(true);
    expect(ownersModelOn({}, [off])).toBe(false);
    expect(ownersModelOn({}, [])).toBe(false);
  });
});
