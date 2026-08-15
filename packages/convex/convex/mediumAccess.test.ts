// Regression coverage for the MEDIUM access findings that are pure gate/scope
// fixes: adminFindChildren user scope (16), getSessionMetrics user scope (17),
// and the team-inheritance stamps that must use the VISIBLE team, not routing
// (patterns/decisions 10). Inheritance for docs/sessionInsights is covered in
// their own files.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { adminFindChildren } from "./conversations";
import { getSessionMetrics } from "./managedSessions";
import { create as createPattern } from "./patterns";
import { create as createDecision } from "./decisions";

const OWNER = "u_owner";
const OTHER = "u_other";
const TEAM = "t_team";
const OWNER_TOKEN = "tok-owner";

async function tables(): Promise<Record<string, any[]>> {
  return {
    users: [
      { _id: OWNER, name: "Owner", team_id: TEAM },
      { _id: OTHER, name: "Other" },
    ],
    teams: [{ _id: TEAM, name: "Team" }],
    team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "admin" }],
    api_tokens: [
      { _id: "at_owner", user_id: OWNER, token_hash: await hashToken(OWNER_TOKEN), last_used_at: Date.now() },
    ],
    conversations: [
      { _id: "parent", user_id: OWNER, is_private: true },
      { _id: "child_mine", user_id: OWNER, parent_conversation_id: "parent", title: "Mine", is_subagent: true },
      { _id: "child_theirs", user_id: OTHER, parent_conversation_id: "parent", title: "Theirs", is_subagent: true },
      // A private session and a team-visible session, for the stamp tests.
      { _id: "conv_private", user_id: OWNER, team_id: TEAM, is_private: true, session_id: "sess_priv" },
      { _id: "conv_shared", user_id: OWNER, team_id: TEAM, is_private: false, session_id: "sess_shared" },
    ],
    session_metrics: [
      { _id: "sm_owner", session_id: "sess_x", user_id: OWNER, cpu: 1, collected_at: 1 },
      { _id: "sm_other", session_id: "sess_x", user_id: OTHER, cpu: 2, collected_at: 2 },
    ],
    patterns: [],
    decisions: [],
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

describe("adminFindChildren user scope (16)", () => {
  test("returns only the caller's own children", async () => {
    const res = await (adminFindChildren as any)._handler(ctx(await tables(), OWNER), {
      parent_conversation_id: "parent", api_token: OWNER_TOKEN,
    });
    expect(res.map((c: any) => c._id)).toEqual(["child_mine"]);
  });
});

describe("getSessionMetrics user scope (17)", () => {
  test("returns only the caller's own metrics rows for a shared session_id", async () => {
    const res = await (getSessionMetrics as any)._handler(ctx(await tables(), OWNER), {
      session_id: "sess_x",
    });
    expect(res.map((r: any) => r._id)).toEqual(["sm_owner"]);
  });
  test("a stranger sees none", async () => {
    const res = await (getSessionMetrics as any)._handler(ctx(await tables(), OTHER), {
      session_id: "sess_x",
    });
    expect(res.map((r: any) => r._id)).toEqual(["sm_other"]);
  });
});

describe("patterns/decisions inherit only the VISIBLE team (10)", () => {
  test("a pattern mined from a PRIVATE session does not carry its routing team", async () => {
    const t = await tables();
    await (createPattern as any)._handler(ctx(t, OWNER), {
      api_token: OWNER_TOKEN, name: "p", description: "d", content: "c",
      source_session_id: "sess_priv",
    });
    const row = t.patterns.find((p: any) => p.name === "p");
    // Falls back to the user's default team, never the private session's routing team.
    expect(row.team_id).toBe(TEAM); // user.team_id fallback — not derived from the private conv
  });

  test("a decision mined from a SHARED session inherits its team", async () => {
    const t = await tables();
    await (createDecision as any)._handler(ctx(t, OWNER), {
      api_token: OWNER_TOKEN, title: "t", rationale: "r", session_id: "sess_shared",
    });
    const row = t.decisions.find((d: any) => d.title === "t");
    expect(row.team_id).toBe(TEAM);
  });
});
