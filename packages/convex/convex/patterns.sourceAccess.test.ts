import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { create } from "./patterns";

// `source_session_id` is resolved by the global by_session_id index. A session
// the caller cannot read must donate neither a link nor its team: otherwise a
// pattern is stamped into another team's workspace by naming their session.

const CALLER = "u_caller";
const OTHER = "u_other";
const TOKEN = "patterns-source-access-token";

async function db(extraConv: Record<string, any>) {
  return makeFakeDb({
    users: [{ _id: CALLER }, { _id: OTHER, team_id: "t_other" }],
    teams: [{ _id: "t_other" }],
    team_memberships: [{ _id: "m1", user_id: OTHER, team_id: "t_other", role: "member" }],
    api_tokens: [{ _id: "tok", user_id: CALLER, token_hash: await hashToken(TOKEN) }],
    patterns: [],
    conversations: [{ _id: "conv_1", session_id: "sess-1", is_private: false, team_id: "t_other", ...extraConv }],
  });
}
const run = (d: any) => (create as any)._handler({ db: d, auth: { getUserIdentity: async () => null } }, {
  api_token: TOKEN, name: "p", description: "d", content: "c", source_session_id: "sess-1",
});

describe("patterns.create source session", () => {
  test("another team's session donates no link and no team", async () => {
    const d = await db({ user_id: OTHER });
    expect((await run(d)).success).toBe(true);
    const row = d._tables.patterns[0];
    expect(row.source_conversation_id).toBeUndefined();
    expect(row.team_id).toBeUndefined();
    expect(row.workspace).toBe(`user:${CALLER}`);
  });

  test("the caller's own session still links", async () => {
    const d = await db({ user_id: CALLER, team_id: undefined, is_private: true });
    expect((await run(d)).success).toBe(true);
    expect(d._tables.patterns[0].source_conversation_id).toBe("conv_1");
  });
});
