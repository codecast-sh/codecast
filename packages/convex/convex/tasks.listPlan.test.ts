// `cast task ls --plan pl-N --all` on a large team ran out of the server's
// 64 MB (Union, Nov 17, ct-95906): the plan filter ran in JS after the whole
// workspace's tasks were collected. A plan names its tasks, so the listing
// reads those. The read cap here stands in for the server's memory: the
// workspace holds far more bytes than one read may take, the plan a few rows.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

const api = anyApi as any;
const TOKEN = "e".repeat(64);
const T0 = 1_790_000_000_000;
const PATH = "/Users/ashot/src/codecast";
const BIG = "x".repeat(20_000);
const ROWS = 200;
const READ_CAP = 2 * 1024 * 1024;

async function setup() {
  const t = convexTest({ schema, modules: allModules, transactionLimits: { bytesRead: READ_CAP } });
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const team = await ctx.db.insert("teams", { name: "Union", created_at: T0 } as any);
    const other = await ctx.db.insert("teams", { name: "Elsewhere", created_at: T0 } as any);
    await ctx.db.patch(owner, { team_id: team, active_team_id: team } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const task = (short_id: string, status: string, i: number, extra: Record<string, any> = {}) => ctx.db.insert("tasks", {
      user_id: owner, team_id: team, workspace: `team:${team}`, short_id, title: `Task ${short_id}`, description: BIG, status,
      task_type: "task", priority: "medium", source: "human", project_path: PATH, created_at: T0 + i, updated_at: T0 + i, ...extra,
    } as any);
    const all: string[] = [];
    for (let i = 0; i < ROWS; i++) all.push(await task(`ct-${i}`, i % 3 === 0 ? "done" : "open", i));
    // The owner's private row and another team's row: named by the plan, never listed in this workspace.
    const privateRow = await task("ct-private", "open", 500, { workspace: `user:${owner}` });
    const foreignRow = await task("ct-foreign", "open", 501, { team_id: other, workspace: `team:${other}` });
    // A row from before the access-key backfill: no stored key, the team's by routing.
    const legacyRow = await task("ct-legacy", "open", 400, { workspace: undefined });
    // Filed from another checkout: listed, but never on this checkout's ready frontier.
    const elsewhere = await task("ct-elsewhere", "open", 300, { project_path: "/Users/ashot/src/union-mobile" });
    const planned = [all[3], all[10], all[11], all[150], all[199], all[10], privateRow, foreignRow, legacyRow, elsewhere];
    await ctx.db.insert("plans", {
      user_id: owner, team_id: team, workspace: `team:${team}`, short_id: "pl-1", title: "A plan", status: "active", source: "human",
      task_ids: planned, created_at: T0, updated_at: T0,
    } as any);
    return { team };
  });
  return { t, ...ids };
}

const shortIds = (rows: any[]) => rows.map((r) => r.short_id);

test("a plan listing with done work included reads the plan's tasks, not the workspace", async () => {
  const { t, team } = await setup();
  const base = { api_token: TOKEN, workspace: "team", team_id: team, project_path: PATH, plan_id: "pl-1", limit: 1000 };
  const all = await t.query(api.tasks.list, { ...base, include_done: true, include_derived: true });
  expect(shortIds(all)).toEqual(["ct-legacy", "ct-elsewhere", "ct-199", "ct-150", "ct-11", "ct-10", "ct-3"]);
  expect(all[0].description).toBe(BIG);

  const open = await t.query(api.tasks.list, base);
  expect(shortIds(open)).toEqual(["ct-legacy", "ct-elsewhere", "ct-199", "ct-11", "ct-10"]);

  const ready = await t.query(api.tasks.list, { ...base, ready: true });
  expect(shortIds(ready).sort()).toEqual(["ct-10", "ct-11", "ct-199", "ct-legacy"]);

  const done = await t.query(api.tasks.list, { ...base, status: "done" });
  expect(shortIds(done)).toEqual(["ct-150", "ct-3"]);
});

test("the whole board pages under the read cap: every row once, newest first", async () => {
  const { t, team } = await setup();
  const base = { api_token: TOKEN, workspace: "team", team_id: team, project_path: PATH, include_done: true, include_derived: true };
  await expect(t.query(api.tasks.list, { ...base, limit: 1000 })).rejects.toThrow(/Read too much data/);

  const seen: string[] = [];
  let pages = 0;
  for (let cursor: string | null = null; ;) {
    const got: any = await t.query(api.tasks.listPage, { ...base, cursor, page_size: 50 });
    seen.push(...shortIds(got.tasks));
    pages++;
    cursor = got.cursor;
    if (cursor === null) break;
  }
  expect(pages).toBeGreaterThan(1);
  expect(seen).toEqual(["ct-elsewhere", ...Array.from({ length: ROWS }, (_, i) => `ct-${ROWS - 1 - i}`)]);
});

// A plan listing is the workspace listing narrowed to the plan: the same rows
// in a team view and a personal view, whatever key (or none) a row carries.
async function setupMatrix() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const mate = await ctx.db.insert("users", { name: "Mate" } as any);
    const stranger = await ctx.db.insert("users", { name: "Stranger" } as any);
    const team = await ctx.db.insert("teams", { name: "Union", created_at: T0 } as any);
    const other = await ctx.db.insert("teams", { name: "Elsewhere", created_at: T0 } as any);
    await ctx.db.patch(owner, { team_id: team, active_team_id: team } as any);
    for (const [user_id, team_id] of [[owner, team], [mate, team], [stranger, other]] as const) {
      await ctx.db.insert("team_memberships", { user_id, team_id, role: "admin", joined_at: T0 } as any);
    }
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const privateConv = await ctx.db.insert("conversations", {
      user_id: owner, team_id: team, is_private: true, agent_type: "claude_code", session_id: "s-private", started_at: T0, updated_at: T0, message_count: 1, status: "active",
    } as any);
    let i = 0;
    const task = (short_id: string, fields: Record<string, any>, title = `Task ${short_id}`) => ctx.db.insert("tasks", {
      user_id: owner, short_id, title, status: i % 2 ? "done" : "open", task_type: "task", priority: "medium", source: "human",
      project_path: PATH, created_at: T0 + i, updated_at: T0 + ++i, ...fields,
    } as any);
    const rows = {
      team: await task("mx-team", { team_id: team, workspace: `team:${team}` }),
      memory: await task("mx-memory", { team_id: team, workspace: `team:${team}` }, "fix the memory leak in listing"),
      ownerPrivate: await task("mx-owner-private", { team_id: team, workspace: `user:${owner}` }),
      matePrivate: await task("mx-mate-private", { user_id: mate, team_id: team, workspace: `user:${mate}` }),
      otherTeam: await task("mx-other-team", { user_id: stranger, team_id: other, workspace: `team:${other}` }),
      unkeyedPrivateConv: await task("mx-unkeyed-private-conv", { team_id: team, conversation_id: privateConv }),
      unkeyedOtherTeam: await task("mx-unkeyed-other-team", { user_id: stranger, team_id: other }),
      unkeyedPersonal: await task("mx-unkeyed-personal", {}),
    };
    const all = Object.values(rows);
    await ctx.db.insert("plans", {
      user_id: owner, team_id: team, workspace: `team:${team}`, short_id: "pl-mx", title: "Matrix", status: "active", source: "human",
      task_ids: all, created_at: T0, updated_at: T0,
    } as any);
    await ctx.db.insert("plans", {
      user_id: stranger, team_id: other, workspace: `team:${other}`, short_id: "pl-theirs", title: "Theirs", status: "active", source: "human",
      task_ids: [rows.otherTeam, rows.unkeyedOtherTeam, rows.team, rows.ownerPrivate], created_at: T0, updated_at: T0,
    } as any);
    return { team };
  });
  return { t, ...ids };
}

test("a plan listing equals the workspace listing narrowed to the plan, in the team and the personal view", async () => {
  const { t, team } = await setupMatrix();
  const views: Array<[Record<string, any>, string[]]> = [
    [{ workspace: "team", team_id: team }, ["mx-memory", "mx-team"]],
    [{ workspace: "personal" }, ["mx-unkeyed-personal", "mx-unkeyed-private-conv", "mx-owner-private"]],
  ];
  for (const [view, expected] of views) {
    const base = { api_token: TOKEN, ...view, project_path: PATH, include_done: true, include_derived: true, limit: 1000 };
    const planned = shortIds(await t.query(api.tasks.list, { ...base, plan_id: "pl-mx" }));
    const plain = shortIds(await t.query(api.tasks.list, base)).filter((s) => s.startsWith("mx-"));
    expect(planned).toEqual(plain);
    expect(planned).toEqual(expected);
  }
});

test("another team's plan id lists only the viewer's own rows", async () => {
  const { t, team } = await setupMatrix();
  const base = { api_token: TOKEN, project_path: PATH, include_done: true, include_derived: true, limit: 1000, plan_id: "pl-theirs" };
  expect(shortIds(await t.query(api.tasks.list, { ...base, workspace: "team", team_id: team }))).toEqual(["mx-team"]);
  expect(shortIds(await t.query(api.tasks.list, { ...base, workspace: "personal" }))).toEqual(["mx-owner-private"]);
});

test("a search inside a plan keeps a title matched by its words", async () => {
  const { t, team } = await setupMatrix();
  const got = await t.query(api.tasks.list, { api_token: TOKEN, workspace: "team", team_id: team, project_path: PATH, include_done: true, limit: 1000, plan_id: "pl-mx", query: "memory listing" });
  expect(shortIds(got)).toEqual(["mx-memory"]);
});

// CLIs from 630325aad (Oct 26) to e1854c0bc (Nov 8) send `--plan X --all` to
// the page route and loop until the cursor is null: the plan answers as one
// final page.
test("the page route answers a plan with every plan row once, as one final page", async () => {
  const { t, team } = await setupMatrix();
  const got = await t.query(api.tasks.listPage, { api_token: TOKEN, workspace: "team", team_id: team, project_path: PATH, include_done: true, include_derived: true, plan_id: "pl-mx", cursor: null, page_size: 1 });
  expect(got.cursor).toBeNull();
  expect(shortIds(got.tasks)).toEqual(["mx-memory", "mx-team"]);
});
