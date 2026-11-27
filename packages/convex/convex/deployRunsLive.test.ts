import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish } from "./deployTargets";
import { stampMainOrder } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { completeRunsOnLive, deployStopOf, liveExitOf } from "./deployCarries";

// A change run that stopped at Deploy failed on a release race (ct-102064: cli dp-3424 failed at Send, and dp-3456,
// a later release, carried its merge live) reads Live once a deploy that carries its change goes live, and its
// session hears so once. Synthetic data only.

const TEAM = "team_1" as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_runs_live_token";
const REPO = "acme/app";
const NOW = Date.now();

const sha = (n: number) => `${n.toString(16).padStart(2, "0")}ef`.repeat(10);
const file = (filename: string) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 });

// The change flow's Deploy segment as the stored graph holds it, flattened.
const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, label: id, shape: "box", type, ...extra });
const GRAPH = {
  nodes: [
    node("merge", "command"), node("landed", "command"), node("deploy", "conditional"),
    node("deploy__wait", "command", { script: "cast flow await-deploy --merge \"$run_dir/merge.json\"" }),
    node("deploy__live", "command"), node("deploy__failed", "exit"), node("deploy__stuck", "exit"), node("exit", "exit", { label: "Live" }),
  ],
  edges: [
    { from: "landed", to: "deploy" }, { from: "deploy", to: "deploy__wait" },
    { from: "deploy__wait", to: "deploy__live", condition: "outcome = success" },
    { from: "deploy__wait", to: "deploy__stuck", condition: "outcome = failure and deploy__wait.exit_code = 5" },
    { from: "deploy__wait", to: "deploy__failed", condition: "outcome = failure and deploy__wait.exit_code != 4 and deploy__wait.exit_code != 5" },
    { from: "deploy__live", to: "exit" },
  ],
};

const done = (node_id: string, extra: Record<string, unknown> = {}) => ({ node_id, status: "completed", outcome: "success", started_at: NOW - 60_000, completed_at: NOW - 50_000, ...extra });
const stoppedAtDeploy = (id: string, merged: number, reason: string, task: string) => ({
  _id: id, user_id: ME, workflow_id: "wf_change", task_id: task, workspace: WS, team_id: TEAM, status: "failed",
  current_node_id: "deploy__failed", fail_reason: `Stopped: ${reason}`, spawner_conversation_id: "conv_conductor",
  merge: { sha: sha(merged), branch: "fix", into: "main", at: NOW - 40_000 },
  node_statuses: [done("merge"), done("landed"), done("deploy"), { node_id: "deploy__wait", status: "failed", outcome: "failure", result_preview: reason, started_at: NOW - 40_000, completed_at: NOW - 30_000 }, { node_id: "deploy__failed", status: "failed" }],
  created_at: NOW - 100_000, updated_at: NOW - 30_000,
});

async function world() {
  const t = {
    users: [{ _id: ME, name: "Ana" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [], github_app_installations: [], commit_ci: [], ship_passes: [], external_events: [], event_groups: [], signals: [],
    counters: [], daemon_commands: [], agent_tasks: [], projects: [], pull_requests: [],
    repo_sources: [{ _id: "rs1", repository: REPO, team_id: TEAM }],
    commits: [] as any[],
    deploy_targets: [] as any[],
    deploys: [] as any[],
    workflows: [{ _id: "wf_change", user_id: ME, name: "change", label: "Ship", ...GRAPH }],
    conversations: [
      { _id: "conv_subject", user_id: ME, agent_type: "claude_code", status: "active", message_count: 4, title: "the fix" },
      { _id: "conv_conductor", user_id: ME, agent_type: "claude_code", status: "active", message_count: 9, title: "the conductor" },
    ],
    tasks: [
      { _id: "task_a", short_id: "ct-1", workspace: WS, status: "done", execution_status: "blocked", execution_concerns: "Stopped: The deploy that carried a failed: cli dp-1 (Stopped at Send.).", created_from_conversation: "conv_subject", conversation_ids: ["conv_subject"] },
      { _id: "task_b", short_id: "ct-2", workspace: WS, status: "done", created_from_conversation: "conv_subject" },
      { _id: "task_c", short_id: "ct-3", workspace: WS, status: "done" },
    ],
    pending_messages: [
      // The runner's end message to the session the change came from (runner.ts tellSubject, key "end").
      { _id: "pm_end", conversation_id: "conv_subject", client_id: "run:run_a:end:1a2b3c4d", content: "stopped at Deploy failed", status: "delivered", from_user_id: ME, created_at: NOW - 29_000 },
    ] as any[],
    workflow_runs: [] as any[],
  } as Record<string, any[]>;
  const db = makeFakeDb(t);
  const scheduled: Array<{ fn: unknown; args: any }> = [];
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async (_ms: number, fn: unknown, args: any) => { scheduled.push({ fn, args }); return null; } } } as any;
  await (publish as any)._handler(ctx, {
    api_token: TOKEN, team_id: TEAM, repository: REPO,
    targets: [
      { name: "cli", runs: "release", live: { kind: "marker" }, policy: "press", paths: ["cli/**"] },
      { name: "web", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["web/**"] },
    ],
  });
  // Main: sha(1) cli (run A's merge), sha(2) cli, sha(3) web (run B's merge), sha(4) cli.
  const files: Record<number, string> = { 1: "cli/a.ts", 2: "cli/b.ts", 3: "web/c.tsx", 4: "cli/d.ts" };
  for (const n of [1, 2, 3, 4]) {
    t.commits.push({ _id: `commit_${n}`, sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: NOW, files_changed: 1, insertions: 0, deletions: 0, repository: REPO, team_id: TEAM, branch: "main", files: [file(files[n]!)] });
    await stampMainOrder(ctx, [`commit_${n}` as any], NOW - 10_000 + n);
  }
  t.workflow_runs.push(
    stoppedAtDeploy("run_a", 1, "The deploy that carried a failed: cli dp-1 (Stopped at Send.).", "task_a"),
    // Its change touches web, which nothing has taken live.
    stoppedAtDeploy("run_b", 3, "Deploy stuck: web is not live with c after 60m.", "task_b"),
    // Stopped for another reason: its change is on main, but the run never reached Deploy.
    { ...stoppedAtDeploy("run_c", 2, "merge is off for this flow", "task_c"), current_node_id: "merge", node_statuses: [{ node_id: "merge", status: "failed" }] },
    // Stopped at Deploy like run A, but a person queued it to resume.
    { ...stoppedAtDeploy("run_d", 1, "The deploy that carried a failed: cli dp-1 (Stopped at Send.).", "task_c"), resume_queued: { at: "deploy", by: ME, since: NOW } },
  );
  t.tasks[0].execution_concerns = t.workflow_runs[0].fail_reason;
  const mark = (target: string, n: number, status: "live" | "failed" = "live") =>
    recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target, sha: sha(n), repository: REPO, source: "m", status, at: NOW });
  // What a live deploy scheduled, run as the scheduler would.
  const drain = async () => {
    const out: string[][] = [];
    for (const s of scheduled.splice(0)) if ((s.args as any)?.deploy) out.push((await (completeRunsOnLive as any)._handler(ctx, s.args)).completed);
    return out.flat();
  };
  return { t, mark, drain };
}

const run = (t: Record<string, any[]>, id: string) => t.workflow_runs.find((r) => r._id === id)!;
const told = (t: Record<string, any[]>, conv: string) => t.pending_messages.filter((m) => m.conversation_id === conv && m._id !== "pm_end");

describe("a run stopped at Deploy reads Live once a later deploy carries its change", () => {
  test("a release race: the failed release leaves it stopped, the next live release completes it at Live, and its session hears it once", async () => {
    const { t, mark, drain } = await world();
    await mark("cli", 1, "failed");
    expect(await drain()).toEqual([]);
    expect(run(t, "run_a").status).toBe("failed");

    await mark("cli", 2, "live");
    expect(await drain()).toEqual(["run_a"]);
    const a = run(t, "run_a");
    expect(a.status).toBe("completed");
    expect(a.current_node_id).toBe("exit");
    expect(a.fail_reason).toBeUndefined();
    const wait = a.node_statuses.find((n: any) => n.node_id === "deploy__wait");
    expect(wait).toMatchObject({ status: "completed", outcome: "success" });
    expect(wait.result_preview).toMatch(/^Live: [0-9a-f]{7} on cli dp-\d+\.$/);
    expect(a.node_statuses.some((n: any) => n.node_id === "deploy__failed")).toBe(false);
    expect(a.node_statuses.filter((n: any) => n.node_id === "deploy__live" || n.node_id === "exit").map((n: any) => n.status)).toEqual(["completed", "completed"]);
    // The blocker the stop left on the task goes with it.
    expect(t.tasks[0].execution_concerns).toBeUndefined();
    expect(t.tasks[0].execution_status).toBeUndefined();

    // The session that heard the stop (not the conductor that started the run) hears the run is over, once.
    const heard = told(t, "conv_subject");
    expect(heard.length).toBe(1);
    expect(heard[0].content).toContain("The Ship run on ct-1 is over: Live.");
    expect(heard[0].content).toContain(wait.result_preview);
    expect(told(t, "conv_conductor").length).toBe(0);

    // Its change touching web keeps run B stopped; run C stopped before Deploy and is not read at all.
    expect(run(t, "run_b").status).toBe("failed");
    expect(run(t, "run_c")).toMatchObject({ status: "failed", current_node_id: "merge" });
    expect(run(t, "run_d").status).toBe("failed");

    // A later live deploy changes nothing more and says nothing again.
    await mark("cli", 4, "live");
    expect(await drain()).toEqual([]);
    expect(told(t, "conv_subject").length).toBe(1);
  });

  test("a deploy that does not hold the change completes nothing", async () => {
    const { t, mark, drain } = await world();
    // A live deploy of the web commit holds web's change, not cli's: run A waits for cli, run B's web is now live.
    await mark("web", 3, "live");
    expect(await drain()).toEqual(["run_b"]);
    expect(run(t, "run_a").status).toBe("failed");
  });
});

describe("which runs a live deploy reads", () => {
  const base = { status: "failed", merge: { sha: sha(1), branch: "b", into: "main", at: 1 } } as any;
  test("only a merged run that stopped at its Deploy segment's failed or stuck exit after its wait failed", () => {
    const waitFailed = [{ node_id: "direct_deploy__wait", status: "failed" }];
    expect(deployStopOf({ ...base, current_node_id: "direct_deploy__stuck", node_statuses: waitFailed })).toBe("direct_deploy");
    expect(deployStopOf({ ...base, current_node_id: "direct_deploy__failed", node_statuses: [] })).toBeNull();
    expect(deployStopOf({ ...base, merge: undefined, current_node_id: "direct_deploy__failed", node_statuses: waitFailed })).toBeNull();
    expect(deployStopOf({ ...base, status: "completed", current_node_id: "direct_deploy__failed", node_statuses: waitFailed })).toBeNull();
    expect(deployStopOf({ ...base, current_node_id: "check__failed", node_statuses: [{ node_id: "check__wait", status: "completed" }] })).toBeNull();
  });
  test("only a segment whose wait is await-deploy and whose Live leads straight to an exit", () => {
    expect(liveExitOf(GRAPH as any, "deploy")).toEqual({ live: "deploy__live", exit: "exit" });
    const watched = { ...GRAPH, nodes: [...GRAPH.nodes, node("watch", "agent")], edges: GRAPH.edges.map((e) => (e.from === "deploy__live" ? { from: "deploy__live", to: "watch" } : e)) };
    expect(liveExitOf(watched as any, "deploy")).toBeNull();
    const other = { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "deploy__wait" ? { ...n, script: "make release" } : n)) };
    expect(liveExitOf(other as any, "deploy")).toBeNull();
  });
});
