import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { list, webMentionList } from "./plans";

// `team_id` is routing, `workspace` is access: a plan routed to a team but
// private to its owner (workspace user:<owner>) must not appear in a
// teammate's team listing. Both listings read the by_team_id routing index.

const OWNER = "u_owner";
const MATE = "u_mate";
const TEAM = "t_1";
const TOKEN = "plans-list-access-token";

async function tables() {
  return {
    users: [{ _id: OWNER, team_id: TEAM, active_team_id: TEAM }, { _id: MATE, team_id: TEAM, active_team_id: TEAM }],
    teams: [{ _id: TEAM, name: "T" }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
    ],
    api_tokens: [{ _id: "tok", user_id: MATE, token_hash: await hashToken(TOKEN) }],
    plans: [
      { _id: "plan_shared", short_id: "pl-1", user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`, title: "Shared", status: "active" },
      { _id: "plan_private", short_id: "pl-2", user_id: OWNER, team_id: TEAM, workspace: `user:${OWNER}`, title: "Private", status: "active" },
    ],
    directory_team_mappings: [],
    projects: [],
  };
}

function ctx(t: Record<string, any[]>, cookieUser: string | null = null) {
  return {
    auth: { getUserIdentity: async () => (cookieUser ? { subject: `${cookieUser}|session` } : null) },
    db: makeFakeDb(t),
  } as any;
}

describe("plan listings follow workspace, not routing team", () => {
  for (const status of [undefined, "active"]) {
    test(`list --team${status ? " --status" : ""} hides a teammate's owner-private plan`, async () => {
      const rows = await (list as any)._handler(ctx(await tables()), { api_token: TOKEN, workspace: "team", team_id: TEAM, status });
      const ids = (rows.plans ?? rows).map((p: any) => String(p._id));
      expect(ids).toContain("plan_shared");
      expect(ids).not.toContain("plan_private");
    });
  }

  test("webMentionList (team) hides a teammate's owner-private plan", async () => {
    const out = await (webMentionList as any)._handler(ctx(await tables(), MATE), { workspace: "team", team_id: TEAM });
    const ids = out.items.map((p: any) => p._id);
    expect(ids).toEqual(["plan_shared"]);
  });

  test("the owner still sees their private plan in the team listing", async () => {
    const out = await (webMentionList as any)._handler(ctx(await tables(), OWNER), { workspace: "team", team_id: TEAM });
    expect(out.items.map((p: any) => p._id).sort()).toEqual(["plan_private", "plan_shared"]);
  });
});
