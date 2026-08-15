// getSessionInsight condenses a whole transcript (summary, per-turn ask/did,
// blockers). It gated on getAuthUserId only and returned that for ANY
// conversation id. team_id on a conversation is routing, so it must gate on
// real access (canAccessConversation).
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getSessionInsight } from "./sessionInsights";

const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const TEAM = "t_team";

function tables(convExtra: Record<string, any> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Owner" },
      { _id: MEMBER, name: "Member" },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, name: "Team" }],
    team_memberships: [
      { _id: "m_owner", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", user_id: MEMBER, team_id: TEAM, role: "member" },
    ],
    conversations: [
      { _id: "conv", user_id: OWNER, team_id: TEAM, is_private: true, ...convExtra },
    ],
    session_insights: [
      {
        _id: "ins",
        conversation_id: "conv",
        summary: "did secret work",
        headline: "secret",
        turns: [{ ask: "do the secret thing", did: ["did it"] }],
        blockers: ["a secret blocker"],
      },
    ],
  };
}

function ctx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
  } as any;
}

const run = (userId: string | null, t: Record<string, any[]>) =>
  (getSessionInsight as any)._handler(ctx(userId, t), { conversation_id: "conv" });

describe("getSessionInsight access", () => {
  test("owner reads their own insight", async () => {
    const r = await run(OWNER, tables());
    expect(r?.summary).toBe("did secret work");
  });

  test("a teammate cannot read the insight of a PRIVATE session", async () => {
    expect(await run(MEMBER, tables())).toBeNull();
  });

  test("a teammate CAN read the insight of a team-visible session", async () => {
    const r = await run(MEMBER, tables({ is_private: false }));
    expect(r?.summary).toBe("did secret work");
  });

  test("a stranger reads nothing", async () => {
    expect(await run(STRANGER, tables({ is_private: false }))).toBeNull();
  });

  test("an anonymous caller reads nothing", async () => {
    expect(await run(null, tables({ is_private: false }))).toBeNull();
  });
});
