import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { bindSession } from "./plans";

// `/cli/plans/bind` forwards the request body verbatim to `plans.bindSession`
// (http.ts), so the argument names in this validator ARE the CLI's wire format.
// Released CLIs send `session_id`; the function was written expecting
// `conversation_id`. The mismatch surfaced as a validator rejection on
// `cast task start` for any plan-bound task, on every CLI already in the wild.
//
// These tests pin both spellings. Deleting either one breaks a live client, so a
// failure here means someone has narrowed the wire format under a deployed CLI.

const USER = "u_owner";
const TOKEN = "bind-compat-token";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

async function tables() {
  return {
    users: [{ _id: USER, name: "Owner" }],
    teams: [],
    team_memberships: [],
    api_tokens: [{ _id: "tok", user_id: USER, token_hash: await hashToken(TOKEN) }],
    plans: [{
      _id: "plan_1",
      short_id: "pl-1",
      user_id: USER,
      title: "Capability Library",
      session_ids: [],
    }],
    conversations: [{
      _id: "conv_1",
      session_id: "sess-abc",
      user_id: USER,
    }],
    entity_conversations: [],
  };
}

function ctx(t: Record<string, any[]>) {
  return {
    auth: auth(null),
    db: makeFakeDb(t),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

// The bug was a VALIDATOR rejection, and `._handler` bypasses argument
// validation — so the handler tests below would have passed against the broken
// build. `exportArgs()` returns the real wire contract Convex enforces, which is
// what a deployed CLI actually meets. Assert on that, or this file only pretends
// to cover the regression.
describe("plans.bindSession wire contract", () => {
  const args = JSON.parse((bindSession as any).exportArgs()).value as Record<
    string,
    { optional: boolean }
  >;

  test("accepts both session_id and conversation_id", () => {
    expect(args.session_id).toBeDefined();
    expect(args.conversation_id).toBeDefined();
  });

  test("neither is required, so a CLI sending only one is accepted", () => {
    expect(args.session_id.optional).toBe(true);
    expect(args.conversation_id.optional).toBe(true);
  });

  test("the fields a CLI must always send stay required", () => {
    expect(args.api_token.optional).toBe(false);
    expect(args.short_id.optional).toBe(false);
  });
});

describe("plans.bindSession accepts both wire spellings", () => {
  test("binds when the caller sends session_id (what released CLIs send)", async () => {
    const t = await tables();
    const c = ctx(t);
    await (bindSession as any)._handler(c, {
      api_token: TOKEN,
      short_id: "pl-1",
      session_id: "sess-abc",
    });
    const patch = c.db._patched.find((p: any) => p._id === "plan_1");
    expect(patch?.patch.session_ids).toEqual(["conv_1"]);
  });

  test("binds when the caller sends conversation_id (the original spelling)", async () => {
    const t = await tables();
    const c = ctx(t);
    await (bindSession as any)._handler(c, {
      api_token: TOKEN,
      short_id: "pl-1",
      conversation_id: "sess-abc",
    });
    const patch = c.db._patched.find((p: any) => p._id === "plan_1");
    expect(patch?.patch.session_ids).toEqual(["conv_1"]);
  });

  test("conversation_id wins when both are sent, so a mixed body is never ambiguous", async () => {
    const t = await tables();
    t.conversations.push({ _id: "conv_2", session_id: "sess-other", user_id: USER });
    const c = ctx(t);
    await (bindSession as any)._handler(c, {
      api_token: TOKEN,
      short_id: "pl-1",
      conversation_id: "sess-abc",
      session_id: "sess-other",
    });
    const patch = c.db._patched.find((p: any) => p._id === "plan_1");
    expect(patch?.patch.session_ids).toEqual(["conv_1"]);
  });

  test("omitting both is a clear error, not a lookup for undefined", async () => {
    const t = await tables();
    await expect((bindSession as any)._handler(ctx(t), {
      api_token: TOKEN,
      short_id: "pl-1",
    })).rejects.toThrow(/required/);
  });

  test("rebinding to a new plan re-points active_plan_id (last bind wins)", async () => {
    // Regression: a guard added 2026-03 only set active_plan_id when the
    // conversation had none, so `cast plan bind` on a session already bound to
    // an old plan updated plan_ids but left the header pointing at the old
    // (often finished) plan forever; nothing else could ever flip it.
    const t = await tables();
    t.plans.push({
      _id: "plan_old",
      short_id: "pl-0",
      user_id: USER,
      title: "Finished plan",
      session_ids: ["conv_1"],
      current_session_id: "conv_1",
    } as any);
    Object.assign(t.conversations[0], { active_plan_id: "plan_old", plan_ids: ["plan_old"] });
    const c = ctx(t);
    await (bindSession as any)._handler(c, {
      api_token: TOKEN,
      short_id: "pl-1",
      session_id: "sess-abc",
    });
    const patch = c.db._patched.find((p: any) => p._id === "conv_1");
    expect(patch?.patch.active_plan_id).toBe("plan_1");
    expect(patch?.patch.plan_ids).toEqual(["plan_old", "plan_1"]);
  });

  test("an unknown session still fails closed", async () => {
    const t = await tables();
    await expect((bindSession as any)._handler(ctx(t), {
      api_token: TOKEN,
      short_id: "pl-1",
      session_id: "sess-does-not-exist",
    })).rejects.toThrow();
  });
});
