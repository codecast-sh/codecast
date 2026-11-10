// Orchestration + progress event streams keyed off an ENUMERABLE plan_short_id.
//  - emit/append inserted events after resolving the short_id with no access
//    check.
//  - listByPlan/replay/latest verified an api_token but never checked plan
//    access.
//  - webListByPlan had no auth at all.
// Every path must gate on canAccessPlan / requireAccessiblePlan.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { emit, listByPlan, webListByPlan } from "./orchestrationEvents";
import { append, replay, latest } from "./progressEvents";

const OWNER = "u_owner";
const STRANGER = "u_stranger";
const TEAM = "t_team";
const PLAN = "plan_1";
const SHORT = "pl-1";

const OWNER_TOKEN = "tok-owner";
const STRANGER_TOKEN = "tok-stranger";

async function tables(): Promise<Record<string, any[]>> {
  return {
    users: [{ _id: OWNER }, { _id: STRANGER }],
    teams: [{ _id: TEAM, name: "Team" }],
    team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "admin" }],
    // Private plan: owner-only (no team_id grant).
    plans: [{ _id: PLAN, short_id: SHORT, user_id: OWNER, title: "Secret plan" }],
    api_tokens: [
      { _id: "at_owner", user_id: OWNER, token_hash: await hashToken(OWNER_TOKEN), last_used_at: Date.now() },
      { _id: "at_stranger", user_id: STRANGER, token_hash: await hashToken(STRANGER_TOKEN), last_used_at: Date.now() },
    ],
    orchestration_events: [
      { _id: "oe1", plan_id: PLAN, plan_short_id: SHORT, event_type: "started", created_at: 1 },
    ],
    progress_events: [
      { _id: "pe1", plan_id: PLAN, plan_short_id: SHORT, event_type: "started", sequence: 0, created_at: 1 },
    ],
  };
}

function ctx(t: Record<string, any[]>, authUserId?: string | null) {
  return {
    auth: {
      async getUserIdentity() {
        return authUserId ? { subject: `${authUserId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
  } as any;
}

describe("orchestration/progress events plan access", () => {
  test("listByPlan: owner reads, stranger is refused", async () => {
    const owned = await (listByPlan as any)._handler(ctx(await tables()), {
      api_token: OWNER_TOKEN, plan_short_id: SHORT,
    });
    expect(owned.length).toBe(1);
    await expect(
      (listByPlan as any)._handler(ctx(await tables()), {
        api_token: STRANGER_TOKEN, plan_short_id: SHORT,
      }),
    ).rejects.toThrow();
  });

  test("emit: a stranger cannot attach events to a plan they cannot access", async () => {
    const t = await tables();
    await expect(
      (emit as any)._handler(ctx(t), {
        api_token: STRANGER_TOKEN, plan_short_id: SHORT, event_type: "evil",
      }),
    ).rejects.toThrow();
    // No event row was inserted for the stranger's attempt.
    expect(t.orchestration_events.length).toBe(1);
  });

  test("append/replay/latest: stranger refused, owner allowed", async () => {
    await expect(
      (append as any)._handler(ctx(await tables()), {
        api_token: STRANGER_TOKEN, plan_short_id: SHORT, event_type: "evil",
      }),
    ).rejects.toThrow();
    await expect(
      (replay as any)._handler(ctx(await tables()), {
        api_token: STRANGER_TOKEN, plan_short_id: SHORT,
      }),
    ).rejects.toThrow();
    await expect(
      (latest as any)._handler(ctx(await tables()), {
        api_token: STRANGER_TOKEN, plan_short_id: SHORT,
      }),
    ).rejects.toThrow();
    const rep = await (replay as any)._handler(ctx(await tables()), {
      api_token: OWNER_TOKEN, plan_short_id: SHORT,
    });
    expect(rep.length).toBe(1);
  });

  test("webListByPlan: unauthenticated refused, stranger refused, owner allowed", async () => {
    await expect(
      (webListByPlan as any)._handler(ctx(await tables(), null), { plan_id: PLAN }),
    ).rejects.toThrow();
    await expect(
      (webListByPlan as any)._handler(ctx(await tables(), STRANGER), { plan_id: PLAN }),
    ).rejects.toThrow();
    const owned = await (webListByPlan as any)._handler(ctx(await tables(), OWNER), { plan_id: PLAN });
    expect(owned.length).toBe(1);
  });
  test("events cannot be pre-seeded under a short id whose plan does not exist yet", async () => {
    const t = await tables();
    await expect(
      (emit as any)._handler(ctx(t), {
        api_token: STRANGER_TOKEN, plan_short_id: "pl-future", event_type: "planted",
      }),
    ).rejects.toThrow();
    expect(t.orchestration_events.length).toBe(1);
    // A row already planted under that short id is never served, even once a
    // plan takes the id: reads go by the resolved plan id.
    t.orchestration_events.push({ _id: "oe-planted", user_id: STRANGER, plan_short_id: "pl-future", event_type: "planted", created_at: 2 });
    expect(await (listByPlan as any)._handler(ctx(t), { api_token: OWNER_TOKEN, plan_short_id: "pl-future" })).toEqual([]);
    t.plans.push({ _id: "plan_2", short_id: "pl-future", user_id: OWNER, title: "Later plan" });
    expect(await (listByPlan as any)._handler(ctx(t), { api_token: OWNER_TOKEN, plan_short_id: "pl-future" })).toEqual([]);
    // The owner still emits to, and reads, their own plan.
    await (emit as any)._handler(ctx(t), { api_token: OWNER_TOKEN, plan_short_id: SHORT, event_type: "task_started" });
    const owned = await (listByPlan as any)._handler(ctx(t), { api_token: OWNER_TOKEN, plan_short_id: SHORT });
    expect(owned.map((e: any) => e.event_type)).toEqual(["started", "task_started"]);
  });
});
