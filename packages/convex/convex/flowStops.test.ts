// Run-stop incidents (pl-1146 piece 1): runs stopped by the shared pipeline on
// different changes become one incident owned by @release, their tasks wait on
// it, and closing it resumes each run where it stopped. The graph is Union's
// change shape, parsed from .cast text by the CLI's own parser: every segment
// stop routes through its exit step to one generic `stopped` exit. Through the
// runner's own report (workflow_runs.updateProgress) under convex-test.
// Synthetic data.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { openFlowStopIncidents, stopOf, stopStationOf } from "./flowStops";
import { moveTaskStatus } from "./tasks";
import { mergeProblemInto } from "./signals";
import { isUngroundedCause } from "./lineGround";
import { rankedCandidates } from "./orgLine";
import { parseWorkflowSource } from "../../cli/src/workflow/parser";
import { graphEdgesPayload, graphNodesPayload } from "../../cli/src/workflow/graphPayload";
import { BUILTIN_WORKFLOW_TEMPLATES } from "../../cli/src/workflow/templates";

const api = anyApi as any;
const TOKEN = "s".repeat(64);
const T0 = Date.now();

const LAND = `digraph land {
  graph [kind="segment", label="Land"]
  start [shape=Mdiamond]
  pr [label="PR", shape=parallelogram, script="true"]
  ci [label="CI", shape=parallelogram, script="true"]
  wait_main [label="Waiting for green main", shape=parallelogram, script="true"]
  review [label="Review", shape=parallelogram, script="true"]
  landed [shape=Msquare, label="Merged"]
  red_main [shape=Msquare, label="Not merged: main stayed red", shared=true, stop="$wait_main.output"]
  unread [shape=Msquare, label="Not merged: CI unread", shared=true, stop="GitHub's CI could not be read"]
  rejected [shape=Msquare, label="Not merged: rejected", stop="The reviewer rejected the change: $review.output"]
  start -> pr
  pr -> ci
  ci -> unread [condition="ci.json.error"]
  ci -> wait_main [condition="outcome = failure"]
  ci -> review
  wait_main -> red_main [condition="outcome = failure"]
  wait_main -> ci
  review -> landed [condition="outcome = success"]
  review -> rejected
}`;
const CHANGE = `digraph change {
  graph [label="Change", on_failure=stop]
  start [shape=Mdiamond]
  land [flow="land"]
  exit [shape=Msquare, label="Merged"]
  stopped [shape=Msquare, label="Not merged", stop="$stop_reason"]
  start -> land
  land -> exit [condition="outcome = success"]
  land -> stopped [condition="outcome = failure"]
}`;
const GRAPH = parseWorkflowSource(CHANGE, undefined, { resolveFlow: (slug) => (slug === "land" ? { src: LAND } : null) });

async function world(o: { release?: boolean; lines?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const me = await ctx.db.insert("users", { name: "Ana" });
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 });
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: T0, features: o.lines === false ? { line: false, org: true } : { line: true, org: true } });
    await ctx.db.insert("team_memberships", { user_id: me, team_id: team, role: "member", joined_at: T0 });
    const ws = `team:${team}`;
    const release = o.release === false ? null : await ctx.db.insert("org_roles", {
      name: "Release", handle: "release", host_user_id: me, team_id: team, scope: { project_ids: [], plan_ids: [] }, status: "active", created_at: T0, updated_at: T0,
    });
    const wf = await ctx.db.insert("workflows", {
      user_id: me, name: "change", slug: "change", label: "Change", nodes: graphNodesPayload(GRAPH), edges: graphEdgesPayload(GRAPH), created_at: T0, updated_at: T0,
    });
    const conv = await ctx.db.insert("conversations", {
      user_id: me, team_id: team, agent_type: "claude_code", status: "active", message_count: 1, started_at: T0, updated_at: T0, git_remote_url: "git@github.com:acme/app.git",
    });
    const task = (short_id: string) => ctx.db.insert("tasks", {
      user_id: me, team_id: team, workspace: ws, short_id, title: short_id, status: "in_progress", task_type: "task", priority: "medium", source: "human", created_at: T0, updated_at: T0,
    });
    const tasks = [await task("ct-901"), await task("ct-902"), await task("ct-903")];
    return { me, team, ws, wf, conv, release, tasks };
  });
  /** A new run of a task, the newest of its runs. */
  const newRun = (taskId: any, extra: Record<string, unknown> = {}) => t.run((ctx: any) => ctx.db.insert("workflow_runs", {
    user_id: ids.me, workflow_id: ids.wf, task_id: taskId, workspace: ids.ws, team_id: ids.team, status: "running", current_node_id: "land__pr",
    node_statuses: [], spawner_conversation_id: ids.conv, runner_device: "laptop", created_at: T0, updated_at: T0, ...extra,
  }));
  // One run per task; the third is @release's own line run.
  const runs = [await newRun(ids.tasks[0]), await newRun(ids.tasks[1]), await newRun(ids.tasks[2], ids.release ? { org_role_id: ids.release } : {})];

  const report = (runId: any, body: Record<string, unknown>) => t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, ...body });
  const drain = async () => {
    await new Promise((done) => setTimeout(done, 20));
    await t.finishInProgressScheduledFunctions();
  };
  const station = async (runId: any, node: string, status: "completed" | "failed") => {
    await report(runId, { current_node_id: node, node_id: node, node_status: "running" });
    await report(runId, { current_node_id: node, node_id: node, node_status: status, outcome: status === "failed" ? "failure" : "success" });
  };
  /** The runner's reports for a run that left Land by `exit` after `failed` stations, then the scheduled filing. */
  const stopAt = async (runId: any, exit: string, failed: string[], why: string) => {
    await station(runId, "land__pr", "completed");
    for (const node of failed) await station(runId, node, "failed");
    await station(runId, `land__${exit}`, "failed");
    await report(runId, { current_node_id: "stopped", node_id: "stopped", node_status: "failed", run_status: "failed", fail_reason: `Stopped: ${why}` });
    await drain();
  };
  /** Main stayed red: CI failed, the wait for green main gave up. */
  const redMain = (runId: any, why = "main CI stayed red on 4f2a9c1 for 4h") => stopAt(runId, "red_main", ["land__ci", "land__wait_main"], why);
  /** A resumed run, running again (resumeRunAt), as its runner reports it. */
  const resume = (runId: any) => t.run((ctx: any) => ctx.db.patch(runId, { status: "running", fail_reason: undefined, resume_queued: undefined }));
  const get = (id: any) => t.run((ctx: any) => ctx.db.get(id));
  const signals = (fingerprint: string) => t.run((ctx: any) => ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", ids.ws).eq("fingerprint", fingerprint)).collect());
  const cause = async (runId: any) => {
    const run: any = await get(runId);
    const rows: any[] = await signals(run.stop_fingerprint);
    return rows[0]?.task_id ? ((await get(rows[0].task_id)) as any) : null;
  };
  /** Closes a task, then runs the resumes its close scheduled. */
  const close = async (taskId: any, status: "done" | "dropped" = "done") => {
    await t.run(async (ctx: any) => moveTaskStatus(ctx, await ctx.db.get(taskId), status, { actorUserId: ids.me }));
    await drain();
  };
  return { t, ids: { ...ids, runs }, newRun, report, stopAt, redMain, resume, get, signals, cause, close };
}

describe("a pipeline stop shared by two changes is one incident", () => {
  test("two runs on two tasks stopped by red main: one cause, @release holds it, both tasks wait on it, each resumes at the station that failed", async () => {
    const { t, ids, redMain, report, get, signals, cause } = await world();
    await redMain(ids.runs[0], "main CI stayed red on 4f2a9c1 for 4h");
    const first: any = await get(ids.runs[0]);
    // Not the segment's exit step (land__red_main), which only echoes the exit and fails again.
    expect(first.stop_station).toBe("land__wait_main");
    // Keyed by the shared exit it left by, never by its words.
    expect(first.stop_fingerprint).toBe("flowstop:acme/app:change:land__red_main");
    // One stopped change is a held signal: no cause for Ground or a line to pick up.
    const held: any[] = await signals(first.stop_fingerprint);
    expect(held.map((r) => [r.attach, r.task_id])).toEqual([["held", undefined]]);
    expect(first.incident_task_id).toBeUndefined();

    // Words that share nothing with the first stop's: the files and prose of another change.
    await redMain(ids.runs[1], "wait_main gave up: web/inbox.tsx and cli/src/daemon.ts fail on main; the agent thinks a flaky e2e");
    const second: any = await get(ids.runs[1]);
    expect(second.stop_fingerprint).toBe(first.stop_fingerprint);
    const incident = await cause(ids.runs[1]);
    expect(incident.assignee).toBe(String(ids.release));
    expect(incident.cause.signal_count).toBe(2);
    expect((await signals(first.stop_fingerprint)).map((r: any) => String(r.task_id))).toEqual([String(incident._id), String(incident._id)]);
    for (const r of ids.runs.slice(0, 2)) expect(String(((await get(r)) as any).incident_task_id)).toBe(String(incident._id));
    for (const task of ids.tasks.slice(0, 2)) expect(((await get(task)) as any).blocked_by).toEqual([incident.short_id]);
    // @release's, never fix work: Ground does not ground it, and the role's line does not start a hand on it, even
    // filed under a project the role looks after.
    expect(isUngroundedCause(incident)).toBe(false);
    const role = await t.run(async (ctx: any) => {
      const project = await ctx.db.insert("projects", { user_id: ids.me, team_id: ids.team, workspace: ids.ws, title: "App", status: "active", created_at: T0, updated_at: T0 });
      await ctx.db.patch(incident._id, { project_id: project });
      await ctx.db.patch(ids.release, { scope: { project_ids: [project], plan_ids: [] } });
      return await ctx.db.get(ids.release);
    });
    expect((await t.run((ctx: any) => rankedCandidates(ctx, role))).map((c: any) => c.task.short_id)).not.toContain(incident.short_id);

    const listed = await t.run((ctx: any) => openFlowStopIncidents(ctx, ids.ws));
    expect(listed.map((i) => i.short_id)).toEqual([incident.short_id]);
    expect(listed[0].runs.map((r) => r.task_short_id).sort()).toEqual(["ct-901", "ct-902"]);
    // A report repeated for a run already stopped is refused (workflow_runs.runOver) and files nothing again.
    expect(await report(ids.runs[1], { current_node_id: "stopped", node_id: "stopped", node_status: "failed", run_status: "failed", fail_reason: "Stopped: main CI stayed red" })).toMatchObject({ ended: { status: "failed" } });
    expect(((await get(incident._id)) as any).cause.signal_count).toBe(2);
  });

  test("a stop about the change itself is never an incident, however alike the words read across changes", async () => {
    const { t, ids, stopAt, get } = await world();
    for (const r of ids.runs.slice(0, 2)) await stopAt(r, "rejected", ["land__review"], "The reviewer rejected the change: it does what the task asked, badly.");
    for (const r of ids.runs.slice(0, 2)) {
      const run: any = await get(r);
      expect(run.stop_station).toBe("land__review");
      expect(run.stop_fingerprint).toBeUndefined();
      expect(run.incident_task_id).toBeUndefined();
    }
    const rows = await ids.tasks.slice(0, 2).reduce(async (acc: Promise<any[]>, task) => [...(await acc), ...((((await get(task)) as any).blocked_by) ?? [])], Promise.resolve([]));
    expect(rows).toEqual([]);
    expect(await t.run((ctx: any) => ctx.db.query("signals").collect())).toEqual([]);
  });

  test("one run stopping twice, or a second run of the same task, is not an incident", async () => {
    const { ids, newRun, redMain, resume, get, signals } = await world();
    await redMain(ids.runs[0]);
    await resume(ids.runs[0]);
    await redMain(ids.runs[0]);
    // Another run of ct-901 stopping the same way.
    await redMain(await newRun(ids.tasks[0]));
    const rows: any[] = await signals(((await get(ids.runs[0])) as any).stop_fingerprint);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => !r.task_id)).toBe(true);
    expect(((await get(ids.runs[0])) as any).incident_task_id).toBeUndefined();
    expect(((await get(ids.tasks[0])) as any).blocked_by ?? []).toEqual([]);
  });

  test("a stop that no longer stands for its change is not the second one: its task closed, a newer run replaced it, or it is over a day old", async () => {
    for (const gone of ["closed", "superseded", "stale"] as const) {
      const { t, ids, newRun, redMain, get, signals, close } = await world();
      await redMain(ids.runs[0]);
      if (gone === "closed") await close(ids.tasks[0]);
      if (gone === "superseded") await newRun(ids.tasks[0]);
      if (gone === "stale") await t.run((ctx: any) => ctx.db.patch(ids.runs[0], { updated_at: Date.now() - 25 * 60 * 60_000 }));
      await redMain(ids.runs[1]);
      const rows: any[] = await signals(((await get(ids.runs[1])) as any).stop_fingerprint);
      expect([gone, rows.length, rows.every((r) => !r.task_id)]).toEqual([gone, 2, true]);
      expect([gone, ((await get(ids.runs[1])) as any).incident_task_id]).toEqual([gone, undefined]);
      expect([gone, ((await get(ids.tasks[1])) as any).blocked_by ?? []]).toEqual([gone, []]);
    }
  });

  test("a repeat stop changes nothing more, and with no @release the incident still blocks", async () => {
    const { ids, redMain, resume, get, cause } = await world({ release: false });
    await redMain(ids.runs[0]);
    await redMain(ids.runs[1]);
    await resume(ids.runs[1]);
    await redMain(ids.runs[1]);
    const c = await cause(ids.runs[1]);
    expect(c.assignee).toBeUndefined();
    for (const task of ids.tasks.slice(0, 2)) expect(((await get(task)) as any).blocked_by).toEqual([c.short_id]);
  });
});

describe("closing an incident", () => {
  test("resumes each run it still stops at its station: at once for a person's run, queued for a line's; one resumed since stays", async () => {
    const { t, ids, redMain, resume, get, cause, close } = await world();
    await redMain(ids.runs[0]);
    await redMain(ids.runs[1]);
    await redMain(ids.runs[2]);
    const incident = await cause(ids.runs[0]);
    expect(String(((await get(ids.runs[2])) as any).incident_task_id)).toBe(String(incident._id));
    // ct-902's run was resumed by hand before the incident closed.
    await resume(ids.runs[1]);
    await close(incident._id);
    // A person's run (no role): nothing would carry out a queue for it, so it resumes now on its machine.
    expect(await get(ids.runs[0])).toMatchObject({ status: "running", current_node_id: "land__wait_main" });
    expect(((await get(ids.runs[0])) as any).resume_queued).toBeUndefined();
    // @release's own line run, in a workspace where lines run: queued for the line's sweep.
    expect(((await get(ids.runs[2])) as any).resume_queued).toMatchObject({ at: "land__wait_main", by: ids.me });
    expect(((await get(ids.runs[1])) as any).resume_queued).toBeUndefined();
    expect(await t.run((ctx: any) => openFlowStopIncidents(ctx, ids.ws))).toEqual([]);
  });

  test("where no line runs, even a line's run resumes at once", async () => {
    const { ids, redMain, get, cause, close } = await world({ lines: false });
    await redMain(ids.runs[0]);
    await redMain(ids.runs[2]);
    await close((await cause(ids.runs[0]))._id);
    for (const r of [ids.runs[0], ids.runs[2]]) {
      expect(await get(r)).toMatchObject({ status: "running", current_node_id: "land__wait_main" });
      expect(((await get(r)) as any).resume_queued).toBeUndefined();
    }
  });

  test("a run stopped since by something else is neither resumed nor listed", async () => {
    const { t, ids, redMain, stopAt, resume, get, cause, close } = await world();
    await redMain(ids.runs[0]);
    await redMain(ids.runs[1]);
    const incident = await cause(ids.runs[0]);
    // ct-902's run was resumed by hand, then the reviewer rejected its change.
    await resume(ids.runs[1]);
    await stopAt(ids.runs[1], "rejected", ["land__review"], "The reviewer rejected the change: no.");
    expect(String(((await get(ids.runs[1])) as any).incident_task_id)).toBe(String(incident._id));
    expect((await t.run((ctx: any) => openFlowStopIncidents(ctx, ids.ws)))[0].runs.map((r) => r.task_short_id)).toEqual(["ct-901"]);
    await close(incident._id);
    expect(((await get(ids.runs[1])) as any).status).toBe("failed");
    expect(((await get(ids.runs[1])) as any).resume_queued).toBeUndefined();
    expect(((await get(ids.runs[0])) as any).status).toBe("running");
  });

  test("a run a newer run of its task replaced is neither listed nor resumed", async () => {
    const { t, ids, newRun, redMain, get, cause, close } = await world();
    await redMain(ids.runs[0]);
    await redMain(ids.runs[1]);
    const incident = await cause(ids.runs[0]);
    // ct-902 started again from the top while the incident was open.
    const fresh = await newRun(ids.tasks[1]);
    expect((await t.run((ctx: any) => openFlowStopIncidents(ctx, ids.ws)))[0].runs.map((r) => r.task_short_id)).toEqual(["ct-901"]);
    await close(incident._id);
    expect(await get(ids.runs[0])).toMatchObject({ status: "running", current_node_id: "land__wait_main" });
    expect(await get(ids.runs[1])).toMatchObject({ status: "failed" });
    expect(((await get(ids.runs[1])) as any).resume_queued).toBeUndefined();
    expect(((await get(fresh)) as any).status).toBe("running");
  });

  test("merged into another problem as its duplicate, its runs wait on that one and resume only when it closes", async () => {
    const { t, ids, redMain, get, cause, close } = await world();
    await redMain(ids.runs[0]);
    await redMain(ids.runs[1]);
    const incident = await cause(ids.runs[0]);
    const survivor = await t.run((ctx: any) => ctx.db.insert("tasks", {
      user_id: ids.me, team_id: ids.team, workspace: ids.ws, short_id: "ct-950", title: "Main is red", status: "open", task_type: "bug", priority: "medium", source: "signal",
      cause: { signal_count: 0, first_seen: T0, last_seen: T0, fingerprints: [] }, created_at: T0, updated_at: T0,
    }));
    await t.run(async (ctx: any) => mergeProblemInto(ctx, ids.me, await ctx.db.get(incident._id), await ctx.db.get(survivor), "the same breakage.", Date.now()));
    expect(((await get(incident._id)) as any).status).toBe("dropped");
    for (const r of ids.runs.slice(0, 2)) {
      expect(await get(r)).toMatchObject({ status: "failed", incident_task_id: survivor });
      expect(((await get(r)) as any).resume_queued).toBeUndefined();
    }
    for (const task of ids.tasks.slice(0, 2)) expect(((await get(task)) as any).blocked_by).toEqual(["ct-950"]);
    await close(survivor);
    for (const r of ids.runs.slice(0, 2)) expect(await get(r)).toMatchObject({ status: "running", current_node_id: "land__wait_main" });
  });
});

describe("stopOf", () => {
  const nodes = graphNodesPayload(GRAPH);
  test("a routed stop: the station that failed last, not its exit step, and shared from the exit step it left by", () => {
    const rows = [
      { node_id: "land__ci", status: "failed", completed_at: 2 },
      { node_id: "land__wait_main", status: "failed", completed_at: 5 },
      { node_id: "land__review", status: "failed", outcome: "stopped", completed_at: 8 },
      { node_id: "land__red_main", status: "failed", completed_at: 7 },
      { node_id: "stopped", status: "failed", completed_at: 8 },
    ];
    expect(stopOf(rows, "stopped", nodes)).toEqual({ station: "land__wait_main", sharedExit: "land__red_main" });
  });
  test("a stop with no station failed resumes its segment from the entry", () => {
    const rows = [
      { node_id: "land__ci", status: "completed", completed_at: 2 },
      { node_id: "land__unread", status: "failed", completed_at: 3 },
      { node_id: "stopped", status: "failed", completed_at: 4 },
    ];
    expect(stopOf(rows, "stopped", nodes)).toEqual({ station: "land", sharedExit: "land__unread" });
  });
  test("a rejection is not shared; with no graph, the station that failed last", () => {
    expect(stopOf([{ node_id: "land__review", status: "failed", completed_at: 1 }, { node_id: "land__rejected", status: "failed", completed_at: 2 }], "stopped", nodes)).toEqual({ station: "land__review", sharedExit: null });
    expect(stopStationOf([{ node_id: "deploy__failed", status: "failed" }], "deploy__failed")).toBe("deploy__failed");
  });
  test("an exit that names resume= resumes there: the change flow's main-red stop at PR, not at Wait for green main", () => {
    const change = graphNodesPayload(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change));
    const rows = [
      { node_id: "pr", status: "completed", completed_at: 1 },
      { node_id: "wait_main", status: "failed", completed_at: 2 },
      { node_id: "mainred", status: "failed", completed_at: 3 },
    ];
    expect(stopOf(rows, "mainred", change)).toEqual({ station: "pr", sharedExit: "mainred" });
    // Without it, the station that failed.
    expect(stopOf(rows, "mainred", change.map(({ resume: _r, ...n }) => n))).toEqual({ station: "wait_main", sharedExit: "mainred" });
  });
});
