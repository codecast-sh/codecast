// A line graph's own closing station (one that leads straight to the run's
// end) closes its problem as the run, so the run goes on to its exit; a
// person's drop while the run waits in a long script, such as a queue, still
// stops it. Run through the real mutations under convex-test.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
const TOKEN = "c".repeat(64);
const T0 = 1_790_000_000_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
  "./tasks.ts": () => import("./tasks"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
  "./sessionDecisions.ts": () => import("./sessionDecisions"),
  "./issueSync.ts": () => import("./issueSync"),
};

const nodes = [
  { id: "start", label: "Start", shape: "Mdiamond", type: "start" },
  { id: "exit", label: "Exit", shape: "Msquare", type: "exit" },
  { id: "queue", label: "Queue", shape: "parallelogram", type: "script", script: "bun nodes.ts queue" },
  { id: "build", label: "Build", shape: "box", type: "agent" },
  { id: "decide", label: "Decide", shape: "hexagon", type: "human" },
  { id: "watch", label: "Watch", shape: "parallelogram", type: "script", script: "cast task update" },
  { id: "closed_at_build", label: "Closed", shape: "parallelogram", type: "script", script: "bun nodes.ts close" },
];
const edges = [
  { from: "start", to: "queue" }, { from: "queue", to: "build" }, { from: "build", to: "decide" },
  { from: "build", to: "closed_at_build" }, { from: "decide", to: "watch" }, { from: "watch", to: "exit" },
  { from: "closed_at_build", to: "exit" },
];

async function dropAt(current_node_id: string) {
  const t = convexTest(schema, modules);
  const runId = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const workspace = `user:${owner}`;
    const workflow = await ctx.db.insert("workflows", { user_id: owner, name: "onefix", slug: "onefix", source: "", nodes, edges, created_at: T0, updated_at: T0 } as any);
    const taskId = await ctx.db.insert("tasks", { user_id: owner, workspace, short_id: "ct-1", title: "A problem", status: "in_progress", task_type: "task", priority: "medium", source: "signal", cause: {}, created_at: T0, updated_at: T0 } as any);
    const run = await ctx.db.insert("workflow_runs", {
      user_id: owner, workspace, task_id: taskId, workflow_id: workflow, workflow_name: "onefix", status: "running", current_node_id,
      graph_nodes: nodes.map((n) => ({ id: n.id, label: n.label, shape: n.shape, type: n.type })),
      node_statuses: [{ node_id: "start", status: "completed", outcome: "success", started_at: T0, completed_at: T0 }], created_at: T0, updated_at: T0,
    } as any);
    await ctx.db.patch(taskId, { workflow_run_id: run } as any);
    return run;
  });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "dropped" });
  return t.run(async (ctx) => (await ctx.db.get(runId)) as any);
}

test("a close made while the run stands at its own closing station leaves the run going on to its exit", async () => {
  expect((await dropAt("closed_at_build")).status).toBe("running");
});

test("a person's drop while the run waits in its queue script still stops it", async () => {
  expect(await dropAt("queue")).toMatchObject({ status: "failed", fail_reason: "Stopped: the problem was dropped by a person" });
});

test("a person's drop while the build session works still stops it", async () => {
  expect(await dropAt("build")).toMatchObject({ status: "failed", fail_reason: "Stopped: the problem was dropped by a person" });
});
