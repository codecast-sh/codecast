// `cast task ls -q`: a search reads bounded slices of one workspace (the title
// search index, a short id, the most recently touched rows), never the whole
// open set, which ran out of the server's 64 MB on a large team.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { list } from "./tasks";
import { hashToken } from "./apiTokens";

const id = (name: string) => name.padEnd(32, "0");
const OWNER = id("userowner");
const TEAM = id("teamunion");
const OTHER = id("teamother");
const TOKEN = "task-search-token";

const task = (n: number, extra: Record<string, any> = {}) => ({
  _id: `tasks_${n}`, short_id: `ct-${n}`, title: `Task ${n}`, user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`,
  status: "open", source: "human", updated_at: n, created_at: n, ...extra,
});

async function makeCtx(tasks: any[]) {
  const db = makeFakeDb({
    users: [{ _id: OWNER, name: "Ashot", active_team_id: TEAM, team_id: TEAM }],
    teams: [{ _id: TEAM, name: "Union" }, { _id: OTHER, name: "Other" }],
    team_memberships: [{ _id: "tm_1", user_id: OWNER, team_id: TEAM, role: "admin" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks,
  });
  const indexes: string[] = [];
  const query = db.query.bind(db);
  (db as any).query = (table: string) => {
    const q = query(table);
    if (table !== "tasks") return q;
    const withIndex = q.withIndex.bind(q);
    q.withIndex = (name: string, fn?: any) => { indexes.push(name); return withIndex(name, fn); };
    return q;
  };
  return { ctx: { db, auth: { async getUserIdentity() { return null; } } } as any, indexes };
}

const ls = (ctx: any, args: Record<string, any>) =>
  (list as any)._handler(ctx, { api_token: TOKEN, workspace: "team", team_id: TEAM, ...args });

describe("task search", () => {
  test("finds by title, short id and description, open work only by default", async () => {
    const { ctx, indexes } = await makeCtx([
      task(1, { title: "Deploy the convex backend" }),
      task(2, { title: "Unrelated", description: "mentions deploy in passing" }),
      task(3, { title: "Deploy finished long ago", status: "done" }),
      task(4, { title: "Another team's deploy", team_id: OTHER, workspace: `team:${OTHER}` }),
      task(5, { title: "Nothing here" }),
    ]);
    const rows = await ls(ctx, { query: "deploy" });
    expect(rows.map((r: any) => r.short_id).sort()).toEqual(["ct-1", "ct-2"]);
    expect(indexes).not.toContain("by_workspace_status");

    const all = await ls(ctx, { query: "deploy", include_done: true });
    expect(all.map((r: any) => r.short_id).sort()).toEqual(["ct-1", "ct-2", "ct-3"]);

    const byId = await ls(ctx, { query: "ct-5" });
    expect(byId.map((r: any) => r.short_id)).toEqual(["ct-5"]);
  });
});
