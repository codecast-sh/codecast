import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { create } from "./decisions";

// `cast decisions add --session`: the session places the decision (its team,
// and so its workspace) only when the caller can read that session.

const TEAM_A = "teams_a";
const TEAM_B = "teams_b";
const ANA = "users_ana"; // team A
const BEN = "users_ben"; // team B
const TOKEN = "cast_decisions_token";

async function ctx() {
  const db = makeFakeDb({
    users: [{ _id: ANA, name: "Ana" }, { _id: BEN, name: "Ben" }],
    api_tokens: [{ _id: "tok_1", user_id: ANA, token_hash: await hashToken(TOKEN) }],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM_A, role: "member", visibility: "full" },
      { _id: "m2", user_id: BEN, team_id: TEAM_B, role: "member", visibility: "full" },
    ],
    teams: [{ _id: TEAM_A, name: "A" }, { _id: TEAM_B, name: "B" }],
    conversations: [
      { _id: "conv_ben", session_id: "sess-ben", user_id: BEN, team_id: TEAM_B, is_private: false, status: "active" },
      { _id: "conv_ana", session_id: "sess-ana", user_id: ANA, team_id: TEAM_A, is_private: false, status: "active" },
    ],
    managed_sessions: [],
    decisions: [],
  });
  return { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } } as any;
}

describe("decisions.create", () => {
  test("another team's session does not place the decision in that team", async () => {
    const c = await ctx();
    const r = await (create as any)._handler(c, { api_token: TOKEN, title: "Use Postgres", rationale: "fits", session_id: "sess-ben" });
    expect(r.success).toBe(true);
    const row = c.db._tables.decisions[0];
    expect(row.user_id).toBe(ANA);
    expect(row.workspace).not.toBe(`team:${TEAM_B}`);
    expect(row.team_id).not.toBe(TEAM_B);
    expect(row.conversation_id).toBeUndefined();
  });

  test("the caller's own team visible session still places it", async () => {
    const c = await ctx();
    const r = await (create as any)._handler(c, { api_token: TOKEN, title: "Use Postgres", rationale: "fits", session_id: "sess-ana" });
    expect(r.success).toBe(true);
    const row = c.db._tables.decisions[0];
    expect(row.workspace).toBe(`team:${TEAM_A}`);
    expect(row.conversation_id).toBe("conv_ana");
  });
});
