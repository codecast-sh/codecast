// An incident of runs stopped at Deploy (pl-1146 piece 1) and the live deploy
// that completes them (deployCarries.completeLiveRuns, ct-102364): the
// completion clears the stop's own blocked status, never the incident's
// blocked_by, and the incident closing afterwards queues no resume of a run
// that is already over. Under convex-test. Synthetic data.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { stampMainOrder } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { moveTaskStatus } from "./tasks";

const api = anyApi as any;
const TOKEN = "d".repeat(64);
const REPO = "acme/app";
const NOW = Date.now();
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}ef`.repeat(10);

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, label: id, shape: "box", type, ...extra });
// The change flow's Deploy segment, flattened (as deployRunsLive.test.ts has it).
const GRAPH = {
  nodes: [
    node("merge", "command"), node("deploy", "conditional"),
    node("deploy__wait", "command", { script: "cast flow await-deploy --merge \"$run_dir/merge.json\"" }),
    node("deploy__live", "command"), node("deploy__failed", "exit", { shared: true }), node("exit", "exit", { label: "Live" }),
  ],
  edges: [
    { from: "merge", to: "deploy" }, { from: "deploy", to: "deploy__wait" },
    { from: "deploy__wait", to: "deploy__live", condition: "outcome = success" },
    { from: "deploy__wait", to: "deploy__failed", condition: "outcome = failure" },
    { from: "deploy__live", to: "exit" },
  ],
};

describe("a live deploy completing runs an incident holds", () => {
  test("keeps each task waiting on the incident, and the incident's close resumes none of them", async () => {
    const t = convexTest(schema, allModules);
    const ids = await t.run(async (ctx: any) => {
      const me = await ctx.db.insert("users", { name: "Ana" });
      await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: NOW, last_used_at: NOW });
      const team = await ctx.db.insert("teams", { name: "Acme", created_at: NOW });
      await ctx.db.insert("team_memberships", { user_id: me, team_id: team, role: "member", joined_at: NOW });
      await ctx.db.insert("repo_sources", { user_id: me, team_id: team, repository: REPO, root: "/code/app", enabled: true, last_synced_at: NOW, created_at: NOW, updated_at: NOW });
      const ws = `team:${team}`;
      const wf = await ctx.db.insert("workflows", { user_id: me, name: "change", slug: "change", label: "Ship", ...GRAPH, created_at: NOW, updated_at: NOW });
      const commits = [];
      for (const n of [1, 2]) {
        commits.push(await ctx.db.insert("commits", {
          sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: NOW, files_changed: 1, insertions: 1, deletions: 0,
          repository: REPO, team_id: team, branch: "main", files: [{ filename: `cli/${n}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 }],
        }));
      }
      await stampMainOrder(ctx, commits, NOW - 10_000);
      const tasks = [];
      const runs = [];
      for (const n of [1, 2]) {
        const task = await ctx.db.insert("tasks", {
          user_id: me, team_id: team, workspace: ws, short_id: `ct-90${n}`, title: `change ${n}`, status: "in_progress", task_type: "task", priority: "medium", source: "human", created_at: NOW, updated_at: NOW,
        });
        tasks.push(task);
        runs.push(await ctx.db.insert("workflow_runs", {
          user_id: me, workflow_id: wf, task_id: task, workspace: ws, team_id: team, status: "running", current_node_id: "deploy__wait", runner_device: "laptop",
          pr: { repository: REPO, number: n, first_head_sha: sha(n), head_sha: sha(n), at: NOW },
          merge: { sha: sha(n), branch: `fix-${n}`, into: "main", at: NOW - 20_000 },
          node_statuses: [{ node_id: "merge", status: "completed", outcome: "success", started_at: NOW - 30_000, completed_at: NOW - 20_000 }],
          created_at: NOW - 60_000, updated_at: NOW - 20_000,
        }));
      }
      return { me, team, ws, tasks, runs };
    });
    await t.mutation(api.deployTargets.publish, { api_token: TOKEN, team_id: ids.team, repository: REPO, targets: [{ name: "cli", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["cli/**"] }] });

    const report = (runId: any, body: Record<string, unknown>) => t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, ...body });
    const drain = async () => {
      await new Promise((done) => setTimeout(done, 20));
      await t.finishInProgressScheduledFunctions();
    };
    for (const [i, runId] of ids.runs.entries()) {
      await report(runId, { current_node_id: "deploy__wait", node_id: "deploy__wait", node_status: "failed", outcome: "failure" });
      await report(runId, { current_node_id: "deploy__failed", node_id: "deploy__failed", node_status: "failed", run_status: "failed", fail_reason: `Stopped: The deploy that carried a failed: cli dp-${30 + i} (Stopped at Send.).` });
      await drain();
    }
    const get = (id: any) => t.run((ctx: any) => ctx.db.get(id));
    const first: any = await get(ids.runs[0]);
    expect(first.stop_station).toBe("deploy__wait");
    const incident: any = await get(first.incident_task_id);
    expect(incident).not.toBeNull();
    for (const task of ids.tasks) expect(((await get(task)) as any).blocked_by).toEqual([incident.short_id]);

    // A later release carries both merges live: both runs complete at Live.
    await t.run((ctx: any) => recordDeployMarker(ctx, { workspace: ids.ws, team_id: ids.team, target: "cli", sha: sha(2), repository: REPO, source: "m", status: "live", at: Date.now() }));
    await drain();
    for (const runId of ids.runs) expect(((await get(runId)) as any).status).toBe("completed");
    for (const taskId of ids.tasks) {
      const task: any = await get(taskId);
      // The stop's own blocked status went with the completion; the incident's edge stays.
      expect(task.execution_status).toBeUndefined();
      expect(task.blocked_by).toEqual([incident.short_id]);
    }

    await t.run(async (ctx: any) => moveTaskStatus(ctx, await ctx.db.get(incident._id), "done", { actorUserId: ids.me }));
    for (const runId of ids.runs) {
      const run: any = await get(runId);
      expect(run.status).toBe("completed");
      expect(run.resume_queued).toBeUndefined();
    }
  });
});
