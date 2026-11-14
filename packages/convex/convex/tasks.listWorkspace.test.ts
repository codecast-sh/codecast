// `cast task ls` lists a workspace. The CLI sends its working directory on
// every call, and that path only picks the workspace (a directory mapping);
// it never narrows the rows. Paths are per machine: a task filed from
// /Users/ashot/src/codecast and one filed from /home/ubuntu/src/codecast sit
// on the same team key, and a listing run from either checkout shows both
// (ct-93798: `--status in_review` returned 1 of 9 rows from the Linux box).
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
const TOKEN = "d".repeat(64);
const T0 = 1_790_000_000_000;
const MAC = "/Users/ashot/src/codecast";
const LINUX = "/home/ubuntu/src/codecast";
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./tasks.ts": () => import("./tasks"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const teamId = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const team = await ctx.db.insert("teams", { name: "Codecast", created_at: T0 } as any);
    await ctx.db.patch(owner, { team_id: team, active_team_id: team } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    // Both checkouts map to the team, the way a person shares one repo from two machines.
    for (const path_prefix of [MAC, LINUX]) {
      await ctx.db.insert("directory_team_mappings", { user_id: owner, path_prefix, team_id: team, created_at: T0 } as any);
    }
    const rows: Array<[string, string, string]> = [
      ["ct-1", "in_review", LINUX],
      ["ct-2", "in_review", MAC],
      ["ct-3", "in_review", MAC],
      ["ct-4", "in_review", "/Users/ashot/src/union-mobile"],
      ["ct-5", "in_progress", MAC],
      ["ct-6", "open", MAC],
      ["ct-7", "open", LINUX],
      ["ct-8", "open", "/Users/ashot/src/union-mobile"],
    ];
    for (const [i, [short_id, status, project_path]] of rows.entries()) {
      await ctx.db.insert("tasks", {
        user_id: owner, team_id: team, workspace: `team:${team}`, short_id, title: `Task ${short_id}`, status,
        task_type: "task", priority: "medium", source: "human", project_path, created_at: T0 + i, updated_at: T0 + i,
      } as any);
    }
    return team;
  });
  return { t, teamId };
}

const ids = (rows: any[]) => rows.map((r) => r.short_id).sort();

test("a listing run from one checkout shows the team's tasks filed from any checkout", async () => {
  const { t, teamId } = await setup();
  const explicit = await t.query(api.tasks.list, { api_token: TOKEN, workspace: "team", team_id: teamId, project_path: LINUX, status: "in_review", limit: 500 });
  expect(ids(explicit)).toEqual(["ct-1", "ct-2", "ct-3", "ct-4"]);

  // No --team: the Linux checkout's mapping picks the team, and the rows are still the whole team's.
  const mapped = await t.query(api.tasks.list, { api_token: TOKEN, project_path: LINUX, status: "in_review", limit: 500 });
  expect(ids(mapped)).toEqual(["ct-1", "ct-2", "ct-3", "ct-4"]);

  const working = await t.query(api.tasks.list, { api_token: TOKEN, project_path: LINUX, status: "in_progress", limit: 500 });
  expect(ids(working)).toEqual(["ct-5"]);

  // The default listing (every open category) and the paged listing agree.
  const open = await t.query(api.tasks.list, { api_token: TOKEN, project_path: LINUX, limit: 500 });
  expect(ids(open)).toEqual(["ct-1", "ct-2", "ct-3", "ct-4", "ct-5", "ct-6", "ct-7", "ct-8"]);
  const page = await t.query(api.tasks.listPage, { api_token: TOKEN, project_path: LINUX, include_done: true, cursor: null, page_size: 100 });
  expect(ids(page.tasks)).toEqual(["ct-1", "ct-2", "ct-3", "ct-4", "ct-5", "ct-6", "ct-7", "ct-8"]);
});

// `cast task ready --claim` and the claim frontier hand a session work to
// take, so the ready frontier stays in the checkout it runs from: a session in
// one repo never claims a task filed from another.
test("a ready listing stays in this checkout and leaves out another repo's task", async () => {
  const { t, teamId } = await setup();
  for (const scope of [{}, { workspace: "team", team_id: teamId }]) {
    const ready = await t.query(api.tasks.list, { api_token: TOKEN, ...scope, project_path: LINUX, ready: true, limit: 500 });
    expect(ids(ready)).toContain("ct-7");
    expect(ids(ready)).not.toContain("ct-8");
  }
});

test("the search branch and the status branch return the same in_review set", async () => {
  const { t, teamId } = await setup();
  const base = { api_token: TOKEN, workspace: "team", team_id: teamId, project_path: LINUX, status: "in_review", limit: 500 };
  const listed = await t.query(api.tasks.list, base);
  const searched = await t.query(api.tasks.list, { ...base, query: "Task" });
  expect(ids(listed)).toEqual(ids(searched));
});
