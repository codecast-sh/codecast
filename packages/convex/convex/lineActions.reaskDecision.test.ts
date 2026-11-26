// Re-ask from a decision's page: the run's own machine asks it again, by the
// command its problem calls for, and only its owner can have it do that.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { reaskDecisionCore } from "./lineActions";

setDefaultTimeout(60_000);

const api = anyApi as any;
const TOKEN = "d".repeat(64);
const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed(run: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const bo = await ctx.db.insert("users", { name: "Bo" } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "ana-mac", label: "Ana's Mac", platform: "darwin", last_seen: now } as any);
    await ctx.db.insert("conversations", {
      user_id: ana, agent_type: "claude_code", session_id: "sess-1", short_id: "jx7rsk1", title: "Change",
      started_at: now, updated_at: now, message_count: 3, is_private: true, status: "active", project_path: "/repo",
    } as any);
    const task = await ctx.db.insert("tasks", { short_id: "ct-7", title: "Fee", status: "in_progress", task_type: "task", priority: "medium", source: "human", user_id: ana, workspace: `user:${ana}`, created_at: now, updated_at: now } as any);
    return { ana, bo, task };
  });
  const asked = await t.mutation(api.sessionDecisions.ask, { api_token: TOKEN, session_id: "sess-1", question: "Ship it?", options: [{ label: "Ship", description: "x" }, { label: "Drop", description: "y" }] });
  expect(asked.error).toBeUndefined();
  const runId = await t.run(async (ctx: any) => {
    const r = await ctx.db.insert("workflow_runs", {
      user_id: ids.ana, workflow_name: "change", status: "paused", node_statuses: [], task_id: ids.task, gate_node_id: "decide__decide",
      gate_decision_id: asked.id, runner_device: "ana-mac", project_path: "/repo", created_at: now, updated_at: now, ...run,
    } as any);
    await ctx.db.patch(ids.task, { workflow_run_id: r });
    await ctx.db.patch(asked.id, { workflow_run_id: r });
    return r;
  });
  const commands = () => t.run((ctx: any) => ctx.db.query("daemon_commands").collect());
  return { t, ...ids, decision: asked.id, runId, commands };
}

test("the run's owner has its machine run `cast workflow reask` for the problem, once per wait", async () => {
  const { t, ana, decision, runId, commands } = await seed();
  const first = await t.run((ctx: any) => reaskDecisionCore(ctx, ana, decision));
  expect(first).toMatchObject({ task: "ct-7", queued: false });
  const [cmd] = await commands();
  expect(cmd).toMatchObject({ command: "run_reask", target_device_id: "ana-mac" });
  expect(JSON.parse(cmd.args)).toEqual({ task: "ct-7", run: String(runId), project_path: "/repo" });
  // A second press while the first still waits answers with it.
  expect(await t.run((ctx: any) => reaskDecisionCore(ctx, ana, decision))).toMatchObject({ queued: true, command_id: first.command_id });
  expect(await commands()).toHaveLength(1);
});

test("someone else cannot move the owner's machine", async () => {
  const { t, bo, decision, commands } = await seed();
  await expect(t.run((ctx: any) => reaskDecisionCore(ctx, bo, decision))).rejects.toThrow();
  expect(await commands()).toHaveLength(0);
});

test("a run no longer waiting on this decision is not asked again", async () => {
  const { t, ana, decision } = await seed({ status: "running" });
  await expect(t.run((ctx: any) => reaskDecisionCore(ctx, ana, decision))).rejects.toThrow(/not waiting at a decision/);
  const moved = await seed({ gate_decision_id: undefined });
  await expect(moved.t.run((ctx: any) => reaskDecisionCore(ctx, moved.ana, moved.decision))).rejects.toThrow(/no longer waits/);
  // The problem moved on to a newer run: the machine would ask that one, not this decision's.
  const newer = await seed();
  await newer.t.run(async (ctx: any) => {
    const other = await ctx.db.insert("workflow_runs", { user_id: newer.ana, workflow_name: "change", status: "running", node_statuses: [], task_id: newer.task, created_at: 2, updated_at: 2 } as any);
    await ctx.db.patch(newer.task, { workflow_run_id: other });
  });
  await expect(newer.t.run((ctx: any) => reaskDecisionCore(ctx, newer.ana, newer.decision))).rejects.toThrow(/newer run/);
  expect(await newer.commands()).toHaveLength(0);
});
