// Run-stop incidents (pl-1146 piece 1): runs stopped the same way on different
// changes become one incident owned by @release, their tasks wait on it, and
// closing it queues each run to resume where it stopped. Through the runner's
// own report (workflow_runs.updateProgress) under convex-test. Synthetic data.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { openFlowStopIncidents, stopStationOf } from "./flowStops";
import { moveTaskStatus } from "./tasks";

const api = anyApi as any;
const TOKEN = "s".repeat(64);
const T0 = Date.now();

const node = (id: string, type: string, label = id) => ({ id, label, shape: "box", type });
// Union's change shape: every failure of the land segment routes to one generic `stopped` exit.
const GRAPH = {
  nodes: [node("start", "start"), node("land__pr", "command"), node("land__ci", "command", "CI"), node("stopped", "exit", "Not merged"), node("exit", "exit")],
  edges: [],
};

async function world(o: { release?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const me = await ctx.db.insert("users", { name: "Ana" });
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 });
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: T0 });
    await ctx.db.insert("team_memberships", { user_id: me, team_id: team, role: "member", joined_at: T0 });
    const ws = `team:${team}`;
    const release = o.release === false ? null : await ctx.db.insert("org_roles", {
      name: "Release", handle: "release", host_user_id: me, team_id: team, scope: { project_ids: [], plan_ids: [] }, status: "active", created_at: T0, updated_at: T0,
    });
    const wf = await ctx.db.insert("workflows", { user_id: me, name: "change", slug: "change", label: "Change", ...GRAPH, created_at: T0, updated_at: T0 });
    const conv = await ctx.db.insert("conversations", {
      user_id: me, team_id: team, agent_type: "claude_code", status: "active", message_count: 1, started_at: T0, updated_at: T0, git_remote_url: "git@github.com:acme/app.git",
    });
    const task = (short_id: string) => ctx.db.insert("tasks", {
      user_id: me, team_id: team, workspace: ws, short_id, title: short_id, status: "in_progress", task_type: "task", priority: "medium", source: "human", created_at: T0, updated_at: T0,
    });
    const run = (taskId: any) => ctx.db.insert("workflow_runs", {
      user_id: me, workflow_id: wf, task_id: taskId, workspace: ws, team_id: team, status: "running", current_node_id: "land__pr",
      node_statuses: [], spawner_conversation_id: conv, runner_device: "laptop", created_at: T0, updated_at: T0,
    });
    const tasks = [await task("ct-901"), await task("ct-902")];
    return { me, team, ws, release, tasks, runs: [await run(tasks[0]), await run(tasks[1]), await run(tasks[0])] };
  });

  const report = (runId: any, body: Record<string, unknown>) => t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, ...body });
  /** The runner's reports for a run stopped at `stopped` after CI failed with `why`, then the scheduled filing. */
  const stop = async (runId: any, why: string) => {
    await report(runId, { current_node_id: "land__ci", node_id: "land__ci", node_status: "running" });
    await report(runId, { current_node_id: "land__ci", node_id: "land__ci", node_status: "failed", outcome: "failure" });
    await report(runId, { current_node_id: "stopped", node_id: "stopped", node_status: "failed", run_status: "failed", fail_reason: `Stopped: ${why}` });
    await new Promise((done) => setTimeout(done, 20));
    await t.finishInProgressScheduledFunctions();
  };
  /** A resumed run, running again (resumeRunAt), as its runner reports it. */
  const resume = (runId: any) => t.run((ctx: any) => ctx.db.patch(runId, { status: "running", fail_reason: undefined, resume_queued: undefined }));
  const get = (id: any) => t.run((ctx: any) => ctx.db.get(id));
  const cause = async (runId: any) => {
    const run: any = await get(runId);
    const rows = await t.run((ctx: any) => ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", ids.ws).eq("fingerprint", run.stop_fingerprint)).collect());
    return rows[0]?.task_id ? ((await get(rows[0].task_id)) as any) : null;
  };
  return { t, ids, stop, resume, get, cause };
}

describe("a stop shared by two changes is one incident", () => {
  test("two runs on two tasks stopped the same way: one cause, @release holds it, both tasks wait on it", async () => {
    const { t, ids, stop, get, cause } = await world();
    await stop(ids.runs[0], "CI failed on 4f2a9c1 3 times.");
    const first: any = await get(ids.runs[0]);
    expect(first.stop_station).toBe("land__ci");
    expect(first.stop_fingerprint).toMatch(/^flowstop:acme\/app:change:land__ci:[0-9a-f]{8}$/);
    const lone = await cause(ids.runs[0]);
    expect(lone).not.toBeNull();
    // One stopped change is not an incident.
    expect(lone.assignee).toBeUndefined();
    expect(first.incident_task_id).toBeUndefined();

    await stop(ids.runs[1], "CI failed on 9b0e7d3 5 times.");
    const second: any = await get(ids.runs[1]);
    expect(second.stop_fingerprint).toBe(first.stop_fingerprint);
    const incident = await cause(ids.runs[1]);
    expect(String(incident._id)).toBe(String(lone._id));
    expect(incident.assignee).toBe(String(ids.release));
    expect(incident.cause.signal_count).toBe(2);
    for (const r of ids.runs.slice(0, 2)) expect(String(((await get(r)) as any).incident_task_id)).toBe(String(incident._id));
    for (const task of ids.tasks) expect(((await get(task)) as any).blocked_by).toEqual([incident.short_id]);

    const listed = await t.run((ctx: any) => openFlowStopIncidents(ctx, ids.ws));
    expect(listed.map((i) => i.short_id)).toEqual([incident.short_id]);
    expect(listed[0].runs.map((r) => r.task_short_id).sort()).toEqual(["ct-901", "ct-902"]);
  });

  test("one run stopping twice, or a second run of the same task, is not an incident", async () => {
    const { ids, stop, resume, get, cause } = await world();
    await stop(ids.runs[0], "CI failed 3 times.");
    await resume(ids.runs[0]);
    await stop(ids.runs[0], "CI failed 4 times.");
    // Another run of ct-901 stopping the same way.
    await stop(ids.runs[2], "CI failed 5 times.");
    const c = await cause(ids.runs[0]);
    expect(c.cause.signal_count).toBe(3);
    expect(c.assignee).toBeUndefined();
    expect(((await get(ids.runs[0])) as any).incident_task_id).toBeUndefined();
    expect(((await get(ids.tasks[0])) as any).blocked_by ?? []).toEqual([]);
  });

  test("a repeat stop changes nothing more, and with no @release the incident still blocks", async () => {
    const { ids, stop, resume, get, cause } = await world({ release: false });
    await stop(ids.runs[0], "CI failed 3 times.");
    await stop(ids.runs[1], "CI failed 3 times.");
    await resume(ids.runs[1]);
    await stop(ids.runs[1], "CI failed 3 times.");
    const c = await cause(ids.runs[1]);
    expect(c.assignee).toBeUndefined();
    for (const task of ids.tasks) expect(((await get(task)) as any).blocked_by).toEqual([c.short_id]);
  });

  test("closing the incident queues each stopped run to resume at its station, and skips one resumed since", async () => {
    const { t, ids, stop, resume, get, cause } = await world();
    await stop(ids.runs[0], "CI failed 3 times.");
    await stop(ids.runs[1], "CI failed 3 times.");
    const incident = await cause(ids.runs[0]);
    // ct-902's run was resumed by hand before the incident closed.
    await resume(ids.runs[1]);
    await t.run(async (ctx: any) => moveTaskStatus(ctx, await ctx.db.get(incident._id), "done", { actorUserId: ids.me }));
    const a: any = await get(ids.runs[0]);
    expect(a.resume_queued).toMatchObject({ at: "land__ci", by: ids.me });
    expect(((await get(ids.runs[1])) as any).resume_queued).toBeUndefined();
    expect(await t.run((ctx: any) => openFlowStopIncidents(ctx, ids.ws))).toEqual([]);
  });
});

describe("stopStationOf", () => {
  test("the station that failed last, not the exit the run ended on", () => {
    const nodes = [
      { node_id: "land__ci", status: "failed", completed_at: 2 },
      { node_id: "land__review", status: "failed", completed_at: 5 },
      { node_id: "land__pr", status: "completed", completed_at: 6 },
      { node_id: "stopped", status: "failed", completed_at: 7 },
    ];
    expect(stopStationOf(nodes, "stopped")).toBe("land__review");
    expect(stopStationOf([{ node_id: "deploy__failed", status: "failed" }], "deploy__failed")).toBe("deploy__failed");
  });
});
