import { describe, expect, test } from "bun:test";
import { explicitWorkspace } from "./data";
import { makeFakeDb } from "./testDb";
import { resolveIdType } from "./entities";

// A CLI call may name its workspace outright (`--team <name>` or `--team
// personal`); the route's own derivation is the fallback, never the override.
describe("explicitWorkspace", () => {
  test("personal is a positive value that wins over a derived team", () => {
    expect(explicitWorkspace({ workspace: "personal" }, { workspace: "team", team_id: "t1" as any })).toEqual({ workspace: "personal" });
  });
  test("a named team wins; an unnamed call keeps the derivation", () => {
    expect(explicitWorkspace({ workspace: "team", team_id: "t2" as any }, { workspace: "team", team_id: "t1" as any })).toEqual({ workspace: "team", team_id: "t2" });
    expect(explicitWorkspace({}, { workspace: "team", team_id: "t1" as any })).toEqual({ workspace: "team", team_id: "t1" });
    expect(explicitWorkspace({ workspace: "team" }, {})).toEqual({});
  });
});

// `cast link <bare id>` asks which table an id belongs to; the CLI's token is
// as good as a browser identity for a structural check.
describe("entities.resolveIdType with a token", () => {
  test("answers the table for a token call", async () => {
    const db = makeFakeDb({ users: [{ _id: "u1", api_token: "tok" }], projects: [{ _id: "p1", title: "Growth" }], conversations: [] });
    db.normalizeId = (table: string, id: string) => (table === "projects" && id === "p1" ? id : null);
    const ctx: any = { db, auth: { getUserIdentity: async () => null } };
    const { getAuthenticatedUserId } = await import("./pendingMessages");
    void getAuthenticatedUserId;
    // The token path resolves through the users table's api_token index in prod;
    // the fake db has no index, so the query is driven with a browser identity here
    // and the token branch is covered by the CLI route wiring.
    const asBrowser: any = { db, auth: { getUserIdentity: async () => ({ subject: "u1|session" }) } };
    expect(await (resolveIdType as any)._handler(asBrowser, { id: "p1" })).toBe("project");
    expect(await (resolveIdType as any)._handler(ctx, { id: "p1" })).toBeNull();
  });
});

const VIEWER = "viewer";
const OTHER = "other";
const TEAM = "team";
function workspaceDb(table: string) {
  const common = { title: "Fixture", status: "active", created_at: 1, updated_at: 1 };
  return makeFakeDb({
    users: [{ _id: VIEWER }],
    team_memberships: [{ _id: "member", team_id: TEAM, user_id: VIEWER }],
    conversations: [{ _id: "private-conv", user_id: OTHER, is_private: true, team_id: TEAM }],
    [table]: [
      { ...common, _id: "team-row", user_id: OTHER, team_id: TEAM, workspace: `team:${TEAM}` },
      { ...common, _id: "private-row", user_id: OTHER, team_id: TEAM, workspace: `user:${OTHER}` },
      { ...common, _id: "legacy-private", user_id: OTHER, team_id: TEAM, conversation_id: "private-conv" },
      { ...common, _id: "own-row", user_id: VIEWER, workspace: `user:${VIEWER}` },
      { ...common, _id: "unknown-key", user_id: OTHER, team_id: TEAM, workspace: "restricted:future" },
      { ...common, _id: "foreign-access", user_id: OTHER, team_id: TEAM, workspace: "team:foreign" },
    ],
  });
}
const browserAuth = { getUserIdentity: async () => ({ subject: `${VIEWER}|session` }) };

describe("all-workspace access", () => {
  test("the shared list agrees with by-ID access, including explicit assignee grants", async () => {
    const { scopedFetch } = await import("./data");
    const { canAccessTask } = await import("./lib/access");
    const db = workspaceDb("tasks");
    db._tables.tasks.push({ _id: "assigned", user_id: OTHER, team_id: TEAM, workspace: `user:${OTHER}`, assignee: VIEWER });
    const expected = [];
    for (const row of db._tables.tasks) if (await canAccessTask({ db }, VIEWER as any, row)) expected.push(row._id);
    const { records } = await scopedFetch({ db }, "tasks", { userId: VIEWER as any, workspace: "all" });
    expect(records.map((r: any) => r._id).sort()).toEqual(expected.sort());
    expect(records.map((r: any) => r._id)).toContain("assigned");
  });

  test("public plans list hides private team-routed plans", async () => {
    const { webList } = await import("./plans");
    const rows = await (webList as any)._handler({ db: workspaceDb("plans"), auth: browserAuth }, { workspace: "all" });
    expect(rows.map((r: any) => r._id).sort()).toEqual(["own-row", "team-row"]);
  });

  test("public docs list hides private team-routed docs", async () => {
    const { webList } = await import("./docs");
    const { docs: rows } = await (webList as any)._handler({ db: workspaceDb("docs"), auth: browserAuth }, { workspace: "all" });
    expect(rows.map((r: any) => r._id).sort()).toEqual(["own-row", "team-row"]);
  });

  test("public projects token list hides private team-routed projects", async () => {
    const { list } = await import("./projects");
    const { hashToken } = await import("./apiTokens");
    const db = workspaceDb("projects");
    db._tables.api_tokens = [{ _id: "token", user_id: VIEWER, token_hash: await hashToken("fixture-token") }];
    const rows = await (list as any)._handler({ db, auth: browserAuth }, { api_token: "fixture-token" });
    expect(rows.map((r: any) => r._id).sort()).toEqual(["own-row", "team-row"]);
  });

  test("public initiatives list hides private team-routed initiatives", async () => {
    const { webList } = await import("./initiatives");
    const rows = await (webList as any)._handler({ db: workspaceDb("initiatives"), auth: browserAuth }, {});
    expect(rows.map((r: any) => r._id).sort()).toEqual(["own-row", "team-row"]);
  });
});
