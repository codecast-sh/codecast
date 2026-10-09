// `cast plan create --steps` files the plan's steps in the plan's own
// workspace and prints the `--team` a read of them needs. Both come from the
// workspace the create resolved to, which only the create knows: the CLI used
// to read the plan back to learn it. These tests pin that the answer carries
// it, so dropping the field would fail here rather than silently file the
// steps in whatever workspace the next shell resolves to.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { create } from "./plans";

const USER = "u_owner";
const TEAM = "team_codecast";
const TOKEN = "plan-workspace-token";

async function ctxFor(over: Record<string, any[]> = {}) {
  const t: Record<string, any[]> = {
    users: [{ _id: USER, name: "Owner" }],
    teams: [{ _id: TEAM, name: "Codecast" }],
    team_memberships: [{ _id: "m1", user_id: USER, team_id: TEAM, status: "active" }],
    api_tokens: [{ _id: "tok", user_id: USER, token_hash: await hashToken(TOKEN) }],
    plans: [],
    docs: [],
    conversations: [],
    entity_conversations: [],
    ...over,
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return null; } },
      db: makeFakeDb(t),
      scheduler: { runAfter: async () => null },
      runMutation: async () => null,
    } as any,
    t,
  };
}

describe("plans.create names the workspace it filed in", () => {
  test("a personal plan answers with its own access key", async () => {
    const { ctx, t } = await ctxFor();
    const result = await (create as any)._handler(ctx, { api_token: TOKEN, title: "Solo plan" });
    expect(result.workspace).toBe(`user:${USER}`);
    expect(result.team_id).toBeUndefined();
    expect(t.plans[0].workspace).toBe(result.workspace);
  });

  test("a team-visible session hands its team to the plan, and the answer says so", async () => {
    const { ctx, t } = await ctxFor({
      conversations: [{ _id: "conv_1", session_id: "sess-abc", user_id: USER, team_id: TEAM, team_visibility: "full" }],
    });
    const result = await (create as any)._handler(ctx, { api_token: TOKEN, title: "Team plan", conversation_id: "sess-abc" });
    expect(result.workspace).toBe(`team:${TEAM}`);
    expect(result.team_id).toBe(TEAM);
    expect(t.plans[0].workspace).toBe(result.workspace);
  });
});
