// A run no runner took past its start (its machine took the run and nothing
// claimed it: "No runner started it") made nothing to continue. Resumed, it
// goes back to pending, which its machine's runner starts from the top; marked
// running at the named station, every runner refused it ("is running: nothing
// to run") and it sat with nothing driving it. Seven Union line runs on two
// hosts did, holding their run slots, on 2026-11-13.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { resumeFailedRunCore, resumeQueuedRun } from "./failedRunResume";
import { failStrandedPendingRuns, STRANDED_PENDING_MS } from "./workflow_runs";

setDefaultTimeout(120_000);

const T0 = 1_800_000_000_000;
const NEVER_STARTED = { status: "failed", node_statuses: [], fail_reason: "No runner started it: a machine took the run 11 minutes ago and nothing claimed it. Rerun it." };
const MID_RUN = {
  status: "failed", current_node_id: "queue", fail_reason: "Stopped: the problem was closed by a person",
  node_statuses: [{ node_id: "bind", status: "completed", outcome: "success" }, { node_id: "triage", status: "completed", outcome: "success" }, { node_id: "queue", status: "running" }],
};

async function setup(run: Record<string, unknown>) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ada", email: "ada@line.dev" } as any);
    const task = await ctx.db.insert("tasks", {
      user_id: user, short_id: "ct-75279", title: "A problem", task_type: "bug", priority: "medium", source: "agent", status: "open",
      workspace: `user:${user}`, created_at: T0, updated_at: T0,
    } as any);
    const runId = await ctx.db.insert("workflow_runs", {
      user_id: user, task_id: task, runner_device: "line-5", project_path: "/home/ubuntu/work/union-mobile/outreach",
      workspace: `user:${user}`, created_at: T0, updated_at: T0, ...run,
    } as any);
    // The command its first launch took, before the runner died.
    await ctx.db.insert("daemon_commands", {
      user_id: user, command: "run_workflow", args: JSON.stringify({ workflow_run_id: runId }), target_device_id: "line-5", created_at: T0, executed_at: T0 + 1_000,
    } as any);
    return { user, runId };
  });
  const row = () => t.run(async (ctx) => ctx.db.get(ids.runId as Id<"workflow_runs">));
  const commands = () => t.run(async (ctx) => (await ctx.db.query("daemon_commands").collect()).map((c) => ({ device: c.target_device_id, run: JSON.parse(c.args ?? "{}").workflow_run_id, taken: !!c.executed_at })));
  return { t, ...ids, row, commands };
}

describe("resuming a run no runner took past its start", () => {
  test("puts it back to pending, a new attempt its machine starts from the top, whatever station is named", async () => {
    const { t, user, runId, row, commands } = await setup(NEVER_STARTED);
    const at = T0 + 60 * 60_000;
    const r = await t.run((ctx) => resumeFailedRunCore(ctx, user, runId, "bind", {}, at));
    expect(r).toMatchObject({ resumed_at: "bind", queued: false, from_start: true });
    const after = await row();
    expect(after).toMatchObject({ status: "pending", fresh_branch: true, visits_reset_at: at, updated_at: at });
    expect(after?.current_node_id).toBeUndefined();
    expect(after?.fail_reason).toBeUndefined();
    expect(await commands()).toContainEqual({ device: "line-5", run: runId, taken: false });
  });

  test("queued, the sweep's resume puts it back to pending the same way", async () => {
    const { t, user, runId, row } = await setup(NEVER_STARTED);
    expect(await t.run((ctx) => resumeFailedRunCore(ctx, user, runId, "bind", { queue: true }, T0 + 1))).toMatchObject({ queued: true, from_start: true });
    expect(await row()).toMatchObject({ status: "failed", resume_queued: { at: "bind" } });
    expect(await t.run((ctx) => resumeQueuedRun(ctx, runId, T0 + 2))).toBe(String(runId));
    const after = await row();
    expect(after).toMatchObject({ status: "pending", visits_reset_at: T0 + 2 });
    expect(after?.resume_queued).toBeUndefined();
  });

  test("a run a runner took past its start still goes on, running, from the named station", async () => {
    const { t, user, runId, row } = await setup(MID_RUN);
    const r = await t.run((ctx) => resumeFailedRunCore(ctx, user, runId, "queue", {}, T0 + 1));
    expect(r).toMatchObject({ resumed_at: "queue", from_start: false });
    expect(await row()).toMatchObject({ status: "running", current_node_id: "queue", visits_reset_at: T0 + 1 });
  });

  test("back to pending, it waits for its machine to take the new command: the one its first launch took does not fail it again", async () => {
    const { t, user, runId, row } = await setup(NEVER_STARTED);
    const at = T0 + 60 * 60_000;
    await t.run((ctx) => resumeFailedRunCore(ctx, user, runId, "bind", {}, at));
    const later = at + STRANDED_PENDING_MS + 60_000;
    expect(await t.run((ctx) => failStrandedPendingRuns(ctx, user, later))).toEqual([]);
    expect(await row()).toMatchObject({ status: "pending" });
    // Its machine takes the new command and no runner claims it: then it fails, by name.
    await t.run(async (ctx) => {
      const fresh = (await ctx.db.query("daemon_commands").collect()).find((c) => !c.executed_at)!;
      await ctx.db.patch(fresh._id, { executed_at: at + 5_000 } as any);
    });
    expect(await t.run((ctx) => failStrandedPendingRuns(ctx, user, later))).toEqual([String(runId)]);
    expect((await row())?.status).toBe("failed");
  });
});
