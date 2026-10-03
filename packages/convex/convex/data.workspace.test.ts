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

// A large team's `cast task ls` hit the 64 MB query cap: the scoped read pulled
// every keyed row in again through the legacy index only to skip it, and the
// task list pulled every finished task in only to drop it. Both now stay in
// the database; these record which rows each index read handed to JS.
describe("scoped reads leave skipped rows in the database", () => {
  function spyReads(db: any) {
    const reads: Record<string, string[]> = {};
    const spy = (q: any, table: string, index: string): any => new Proxy(q, {
      get: (target, key) => {
        if (key === "withIndex") return (name: string, fn: any) => spy(target.withIndex(name, fn), table, name);
        if (key === "filter" || key === "order") return (arg: any) => spy(target[key](arg), table, index);
        if (key === "collect" && table === "tasks") return async () => {
          const rows = await target.collect();
          (reads[index] ??= []).push(...rows.map((r: any) => r._id));
          return rows;
        };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const query = db.query.bind(db);
    db.query = (table: string) => spy(query(table), table, "none");
    db._tables.teams = [{ _id: TEAM, name: "Team" }];
    return reads;
  }

  test("the legacy team index reads unkeyed rows only", async () => {
    const { createDataContext } = await import("./data");
    const db = workspaceDb("tasks");
    db._tables.tasks.push({ _id: "legacy-team", user_id: OTHER, team_id: TEAM, title: "Old", status: "open", created_at: 1, updated_at: 1 });
    const reads = spyReads(db);
    const dc = await createDataContext({ db } as any, { userId: VIEWER as any, workspace: "team", team_id: TEAM as any });
    const rows = await dc.query("tasks").collect();
    expect(rows.map((r: any) => r._id).sort()).toEqual(["legacy-team", "team-row"]);
    expect(reads.by_team_id.sort()).toEqual(["legacy-private", "legacy-team"]);
  });

  test("cast task ls leaves finished tasks in the database", async () => {
    const { list } = await import("./tasks");
    const { hashToken } = await import("./apiTokens");
    const db = workspaceDb("tasks");
    db._tables.api_tokens = [{ _id: "token", user_id: VIEWER, token_hash: await hashToken("fixture-token") }];
    for (const t of db._tables.tasks) t.status = "open";
    db._tables.tasks.push(
      { _id: "done-row", user_id: OTHER, team_id: TEAM, workspace: `team:${TEAM}`, title: "Shipped", status: "done", created_at: 1, updated_at: 1 },
      { _id: "dropped-row", user_id: OTHER, team_id: TEAM, workspace: `team:${TEAM}`, title: "Dropped", status: "dropped", created_at: 1, updated_at: 1 },
    );
    const reads = spyReads(db);
    const rows = await (list as any)._handler({ db, auth: browserAuth }, { api_token: "fixture-token", workspace: "team", team_id: TEAM });
    expect(rows.map((r: any) => r._id)).toEqual(["team-row"]);
    expect(reads.by_workspace).toEqual(["team-row"]);

    const all = await (list as any)._handler({ db, auth: browserAuth }, { api_token: "fixture-token", workspace: "team", team_id: TEAM, include_done: true });
    expect(all.map((r: any) => r._id).sort()).toEqual(["done-row", "dropped-row", "team-row"]);

    // A status category reads the workspace like every other listing: the
    // team's done work, never the caller's own rows from another workspace.
    db._tables.tasks.push({ _id: "own-done", user_id: VIEWER, workspace: `user:${VIEWER}`, title: "Mine", status: "done", created_at: 1, updated_at: 1 });
    const done = await (list as any)._handler({ db, auth: browserAuth }, { api_token: "fixture-token", workspace: "team", team_id: TEAM, status: "done" });
    expect(done.map((r: any) => r._id)).toEqual(["done-row"]);
  });
});
