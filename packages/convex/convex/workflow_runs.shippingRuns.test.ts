// The Deploys page's Shipping column reads a team's Ship runs still on their way to main (workflow_runs.shippingRuns):
// runs of a flow that takes a change, not merged, not superseded, the newest of each task. Run under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const api = anyApi as any;
const NOW = Date.now();
const DAY = 86_400_000;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: NOW } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: NOW } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "admin", joined_at: NOW } as any);
    await ctx.db.insert("team_memberships", { user_id: ben, team_id: team, role: "member", joined_at: NOW } as any);
    await ctx.db.insert("team_memberships", { user_id: eve, team_id: other, role: "admin", joined_at: NOW } as any);
    const ws = `team:${team}`;
    const change = await ctx.db.insert("workflows", { user_id: ana, workspace: ws, name: "change", slug: "change", label: "Change", source: 'digraph change { graph [kind="line", takes="branch"] }', nodes: ["pr", "review", "land"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), shape: "box", type: "agent" })), edges: [], created_at: NOW, updated_at: NOW } as any);
    const build = await ctx.db.insert("workflows", { user_id: ana, workspace: ws, name: "build", slug: "build", source: "digraph build { }", nodes: [], edges: [], created_at: NOW, updated_at: NOW } as any);
    const session = (user_id: any, title: string, is_private: boolean) => ctx.db.insert("conversations", {
      user_id, team_id: team, is_private, title, git_root: "/repo", agent_type: "claude_code", session_id: `s-${title}`,
      started_at: NOW, updated_at: NOW, message_count: 1, status: "active",
    } as any);
    const open = await session(ben, "Ben's open session", false);
    const secret = await session(ben, "Ben's private session", true);
    return { ana, ben, eve, team, other, ws, change, build, open, secret };
  });
  const run = (o: { task?: any; status?: string; flow?: any; workspace?: string; at?: number; updated?: number; spawner?: any; extra?: Record<string, unknown> } = {}) =>
    t.run((ctx) => ctx.db.insert("workflow_runs", {
      user_id: ids.ana, workspace: o.workspace ?? ids.ws, team_id: ids.team, workflow_id: o.flow ?? ids.change, ...(o.task ? { task_id: o.task } : {}),
      status: o.status ?? "running", current_node_id: "review", node_statuses: [{ node_id: "pr", status: "completed" }, { node_id: "review", status: "running", label: "Review" }],
      ...(o.spawner ? { spawner_conversation_id: o.spawner } : {}),
      created_at: o.at ?? NOW - 1000, updated_at: o.updated ?? o.at ?? NOW - 1000, ...(o.extra ?? {}),
    } as any));
  const task = (n: number, status = "in_progress") => t.run((ctx) => ctx.db.insert("tasks", { short_id: `ct-${n}`, title: `Task ${n}`, status, workspace: ids.ws, team_id: ids.team, user_id: ids.ana, created_at: NOW, updated_at: NOW } as any));
  const read = (who: any, team = ids.team) => t.withIdentity({ subject: `${who}|session` }).query(api.workflow_runs.shippingRuns, { team_id: team });
  return { t, ids, run, task, read };
}

describe("workflow_runs.shippingRuns", () => {
  test("keeps unmerged Ship runs and drops merged, completed, non-change and stale ones", async () => {
    const { ids, run, read } = await setup();
    const t1 = await run({ status: "running" });
    const t2 = await run({ status: "paused", extra: { gate_prompt: "Ship it?" } });
    const t3 = await run({ status: "failed", extra: { fail_reason: "CI red" } });
    await run({ status: "completed" });
    await run({ extra: { merge: { sha: "a".repeat(40), branch: "b", into: "main", at: NOW } } });
    await run({ extra: { node_statuses: [{ node_id: "land__landed", status: "completed" }] } });
    await run({ flow: ids.build });
    await run({ updated: NOW - 31 * DAY });
    const rows = await read(ids.ana);
    expect(rows.map((r: any) => r._id).sort()).toEqual([t1, t2, t3].sort());
    expect(rows.find((r: any) => r._id === t2).gate_prompt).toBe("Ship it?");
    expect(rows.find((r: any) => r._id === t3).fail_reason).toBe("CI red");
  });

  test("one row per task, its newest run; a later merged round or a closed task leaves none", async () => {
    const { run, task, read, ids } = await setup();
    const a = await task(1);
    await run({ task: a, status: "failed", at: NOW - 5000 });
    const newest = await run({ task: a, status: "running", at: NOW - 1000 });
    const b = await task(2);
    await run({ task: b, status: "failed", at: NOW - 5000 });
    await run({ task: b, status: "completed", at: NOW - 1000, extra: { merge: { sha: "b".repeat(40), branch: "x", into: "main", at: NOW } } });
    const c = await task(3, "done");
    await run({ task: c, status: "failed" });
    const loose1 = await run();
    const loose2 = await run();
    const rows = await read(ids.ana);
    expect(rows.map((r: any) => r._id).sort()).toEqual([newest, loose1, loose2].sort());
    expect(rows.find((r: any) => r._id === newest)).toMatchObject({ task_short_id: "ct-1", task_title: "Task 1", workflow_slug: "change", workflow_label: "Change", current_node_label: "Review" });
  });

  test("a superseded live run is dropped: here it stands at a station its flow no longer has", async () => {
    const { run, read, ids } = await setup();
    const current = await run();
    await run({ extra: { current_node_id: "triage" } });
    expect((await read(ids.ana)).map((r: any) => r._id)).toEqual([current]);
  });

  test("slim rows: station ids and statuses only, the spawner's title only when the viewer may read it", async () => {
    const { run, read, ids } = await setup();
    await run({ spawner: ids.secret, at: NOW - 2000 });
    await run({ spawner: ids.open, at: NOW - 1000 });
    const [open, secret] = await read(ids.ana);
    expect(open.node_statuses).toEqual([{ node_id: "pr", status: "completed" }, { node_id: "review", status: "running" }]);
    expect(open.spawner_title).toBe("Ben's open session");
    expect(secret.spawner_conversation_id).toBe(ids.secret);
    expect(secret.spawner_title).toBeNull();
    const [, own] = await read(ids.ben);
    expect(own.spawner_title).toBe("Ben's private session");
    expect(Object.keys(open).sort()).toEqual([
      "_id", "created_at", "current_node_id", "current_node_label", "fail_reason", "gate_decision_short_id", "gate_decision_status", "gate_prompt",
      "node_statuses", "pr", "primary_conversation_id", "project_path", "spawner_conversation_id", "spawner_title", "status", "task_id",
      "task_short_id", "task_title", "updated_at", "user_id", "workflow_label", "workflow_slug",
    ]);
  });

  test("another team's runs never show, and a stranger or a signed-out reader gets nothing", async () => {
    const { t, run, read, ids } = await setup();
    await run();
    await run({ workspace: `team:${ids.other}` });
    expect(await read(ids.ana)).toHaveLength(1);
    expect(await read(ids.eve)).toEqual([]);
    expect(await read(ids.eve, ids.other)).toHaveLength(1);
    expect(await t.query(api.workflow_runs.shippingRuns, { team_id: ids.team })).toEqual([]);
  });
});
