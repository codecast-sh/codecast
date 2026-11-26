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
  const readAll = (who: any, team = ids.team) => t.withIdentity({ subject: `${who}|session` }).query(api.workflow_runs.shippingRuns, { team_id: team });
  const read = async (who: any, team = ids.team) => (await readAll(who, team)).runs;
  return { t, ids, run, task, read, readAll };
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

  test("another flow's later run on the task (a build, an eval) keeps the Ship card", async () => {
    const { run, task, read, ids } = await setup();
    const a = await task(5);
    const ship = await run({ task: a, status: "running", at: NOW - 5000 });
    await run({ task: a, flow: ids.build, status: "running", at: NOW - 1000 });
    const b = await task(6);
    const failed = await run({ task: b, status: "failed", at: NOW - 5000 });
    await run({ task: b, flow: ids.build, status: "completed", at: NOW - 1000 });
    expect((await read(ids.ana)).map((r: any) => r._id).sort()).toEqual([ship, failed].sort());
  });

  test("a superseded live run is dropped: here it stands at a station its flow no longer has", async () => {
    const { run, read, ids } = await setup();
    const current = await run();
    await run({ extra: { current_node_id: "triage" } });
    expect((await read(ids.ana)).map((r: any) => r._id)).toEqual([current]);
  });

  test("slim rows: station ids and statuses only, and no conversation's title (the page's pills read their own)", async () => {
    const { run, read, ids } = await setup();
    await run({ spawner: ids.secret, at: NOW - 2000 });
    await run({ spawner: ids.open, at: NOW - 1000 });
    const [open, secret] = await read(ids.ana);
    expect(open.node_statuses).toEqual([{ node_id: "pr", status: "completed" }, { node_id: "review", status: "running" }]);
    expect(secret.spawner_conversation_id).toBe(ids.secret);
    expect(Object.keys(open).sort()).toEqual([
      "_id", "ci_verdict", "created_at", "current_node_id", "current_node_label", "fail_reason", "gate_decision_short_id", "gate_decision_status", "gate_node_id", "gate_prompt",
      "merge", "node_statuses", "pr", "primary_conversation_id", "project_path", "review_verdict", "spawner_conversation_id", "stand_in", "status", "task_id",
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
    expect(await t.query(api.workflow_runs.shippingRuns, { team_id: ids.team })).toEqual({ runs: [], shippers: [] });
  });

  test("a run carries its stations' verdicts and its merge", async () => {
    const { run, read, ids } = await setup();
    await run({ extra: { ci_verdict: { node_id: "ci", green: true, head_sha: "h1", at: 5, attempt: 1 }, review_verdict: { node_id: "review", verdict: "approve", head_sha: "h1", at: 6, attempt: 1 } } });
    const [row] = await read(ids.ana);
    expect(row).toMatchObject({ ci_verdict: { green: true, head_sha: "h1", at: 5 }, review_verdict: { verdict: "approve", at: 6 }, merge: null, gate_node_id: null });
    await run({ status: "paused", extra: { gate_node_id: "land" }, at: NOW });
    expect((await read(ids.ana))[0].gate_node_id).toBe("land");
    await run({ extra: { spawner_stand_in: true }, at: NOW + 1 });
    expect((await read(ids.ana))[0].stand_in).toBe(true);
  });
});

describe("workflow_runs.shippingRuns read caps", () => {
  test("a burst of other flows' failed runs, newer than a change run and past the per-status cap, never hides it", async () => {
    const { t, ids, run, read } = await setup();
    const change = await run({ status: "failed", at: NOW - 100_000 });
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("workflow_runs", { user_id: ids.ana, workspace: ids.ws, team_id: ids.team, workflow_id: ids.build, status: "failed", node_statuses: [], created_at: NOW - 50_000 + i, updated_at: NOW - 50_000 + i } as any);
      }
    });
    expect((await read(ids.ana)).map((r: any) => r._id)).toEqual([change]);
  });

  test("a run merged within the window is a shipper however many runs were updated after it", async () => {
    const { t, ids, run, readAll } = await setup();
    const merged = await run({ status: "completed", spawner: ids.open, at: NOW - 200_000, extra: { merge: { sha: "e".repeat(40), branch: "x", into: "main", at: NOW - 200_000 } } });
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("workflow_runs", { user_id: ids.ana, workspace: ids.ws, team_id: ids.team, workflow_id: ids.build, status: "completed", node_statuses: [], created_at: NOW - 100_000 + i, updated_at: NOW - 100_000 + i } as any);
      }
    });
    expect((await readAll(ids.ana)).shippers.map((s: any) => s.run_id)).toEqual([merged]);
  });
});

describe("workflow_runs.shippingRuns shippers", () => {
  test("the change runs of the window, unmerged and merged (completed included), with who pressed Ship", async () => {
    const { run, task, readAll, ids } = await setup();
    const a = await task(1);
    const merged = await run({ task: a, status: "completed", spawner: ids.open, extra: { merge: { sha: "e".repeat(40), branch: "x", into: "main", at: NOW } } });
    const live = await run({ spawner: ids.secret, extra: { spawner_stand_in: true } });
    await run({ flow: ids.build, status: "completed" });
    await run({ status: "completed", updated: NOW - 31 * DAY });
    const { shippers } = await readAll(ids.ana);
    expect(shippers.map((s: any) => s.run_id).sort()).toEqual([merged, live].sort());
    expect(shippers.find((s: any) => s.run_id === merged)).toEqual({
      run_id: merged, task_short_id: "ct-1", merged_sha: "e".repeat(40), spawner_conversation_id: ids.open,
      user_id: ids.ben, stand_in: false, created_at: NOW - 1000,
    });
    // The owner is the pressing session's, not the account the run ran as (Ana's machine ran Ben's Ship).
    // A stand-in is its runner's.
    expect(shippers.find((s: any) => s.run_id === live)).toMatchObject({ task_short_id: null, merged_sha: null, stand_in: true, spawner_conversation_id: ids.secret, user_id: ids.ana });
  });

  test("a private pressing session names its owner only to that owner", async () => {
    const { run, readAll, ids } = await setup();
    const id = await run({ spawner: ids.secret });
    expect((await readAll(ids.ana)).shippers.find((s: any) => s.run_id === id)!.user_id).toBeNull();
    expect((await readAll(ids.ben)).shippers.find((s: any) => s.run_id === id)!.user_id).toBe(ids.ben);
  });

  test("another team's runs never show, and a stranger gets none", async () => {
    const { run, readAll, ids } = await setup();
    await run({ status: "completed", extra: { merge: { sha: "a".repeat(40), branch: "x", into: "main", at: NOW } } });
    await run({ status: "running", workspace: `team:${ids.other}` });
    await run({ status: "completed", workspace: `team:${ids.other}`, extra: { merge: { sha: "b".repeat(40), branch: "y", into: "main", at: NOW } } });
    expect((await readAll(ids.ana)).shippers).toHaveLength(1);
    expect(await readAll(ids.eve)).toEqual({ runs: [], shippers: [] });
  });
});
