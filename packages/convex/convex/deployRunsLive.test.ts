import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish } from "./deployTargets";
import { stampMainOrder } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { HANDED_EXIT, completeRunsOnLive, deployStopOf, healOutsideMerges, liveExitOf, recordOutsideMergeOnPr } from "./deployCarries";

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
    node("unshipped", "exit", { label: "Not merged" }), node("handed", "exit", { label: "Handed to its role" }),
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
  // A pull request merged on GitHub, as the webhook writes its row, and the follow-up it schedules, run at once.
  const mergedOnGitHub = async (number: number, merged: number, by?: string) => {
    t.pull_requests.push({ _id: `pr_${number}`, team_id: TEAM, github_pr_id: number, repository: REPO, number, title: "a fix", body: "", state: "merged", author_github_username: "ana", head_ref: `fix-${number}`, base_ref: "main", linked_session_ids: [], merged_at: NOW - 20_000, merge_commit_sha: sha(merged), created_at: NOW - 90_000, updated_at: NOW - 20_000 });
    return (await (recordOutsideMergeOnPr as any)._handler(ctx, { pr: `pr_${number}`, ...(by ? { by } : {}) })).run;
  };
  const heal = async (dry: boolean) => (await (healOutsideMerges as any)._handler(ctx, { dry })).healed;
  return { t, mark, drain, mergedOnGitHub, heal };
}

/** A change run on pull request #n that ended before its own merge: stopped at Not merged, or handed to its role. */
const endedBeforeMerge = (id: string, n: number, task: string, how: "stopped" | "handed") => ({
  _id: id, user_id: ME, workflow_id: "wf_change", task_id: task, workspace: WS, team_id: TEAM,
  status: how === "stopped" ? "failed" : "completed", current_node_id: how === "stopped" ? "unshipped" : HANDED_EXIT,
  ...(how === "stopped" ? { fail_reason: "Stopped: merge is off for this flow; a person turns it on with cast role line --merge on" } : {}),
  pr: { repository: REPO, number: n, first_head_sha: sha(80), head_sha: sha(81), at: NOW - 90_000 },
  node_statuses: [done("verdicts"), { node_id: "merge", status: "failed", outcome: "failure", result_preview: "merge is off", started_at: NOW - 40_000, completed_at: NOW - 39_000 }, { node_id: how === "stopped" ? "unshipped" : HANDED_EXIT, status: how === "stopped" ? "failed" : "completed", started_at: NOW - 39_000, completed_at: NOW - 39_000 }],
  created_at: NOW - 100_000, updated_at: NOW - 30_000,
});

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
    // Said once ("is over: Live: <sha> on …"), from the run itself: here a run with no session of its own, by name.
    expect(heard[0].content).toContain(`The Ship run on ct-1 is over: ${wait.result_preview} It had stopped at Deploy`);
    expect(heard[0].content).toStartWith('<session-message from="unknown" name="the Ship run on ct-1">');
    expect(heard[0].content).not.toContain("Live. Live:");
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

  test("a run with a session of its own says it is over from that session, as its runner's messages do", async () => {
    const { t, mark, drain } = await world();
    t.conversations.push({ _id: "conv_run", short_id: "jx7run1", user_id: ME, agent_type: "claude_code", status: "active", message_count: 2, title: "Ship ct-1" });
    run(t, "run_a").primary_conversation_id = "conv_run";
    await mark("cli", 2, "live");
    expect(await drain()).toEqual(["run_a"]);
    expect(told(t, "conv_subject")[0].content).toStartWith('<session-message from="jx7run1">');
    expect(told(t, "conv_run")).toHaveLength(0);
  });

  test("a run stopped days ago is found by its merge sha, past hundreds of newer failed runs", async () => {
    const { t, mark, drain } = await world();
    t.workflow_runs.push({ ...stoppedAtDeploy("run_old", 1, "Deploy stuck: cli is not live after 60m.", "task_c"), updated_at: NOW - 10 * 86_400_000 });
    for (let i = 0; i < 320; i++) {
      t.workflow_runs.push({ ...stoppedAtDeploy(`run_noise_${i}`, 9, "merge is off for this flow", "task_c"), merge: undefined, current_node_id: "merge", node_statuses: [{ node_id: "merge", status: "failed" }], updated_at: NOW - 86_400_000 + i });
    }
    await mark("cli", 2, "live");
    expect((await drain()).sort()).toEqual(["run_a", "run_old"]);
    expect(run(t, "run_old")).toMatchObject({ status: "completed", current_node_id: "exit" });
  });

  test("a deploy that does not hold the change completes nothing", async () => {
    const { t, mark, drain } = await world();
    // A live deploy of the web commit holds web's change, not cli's: run A waits for cli, run B's web is now live.
    await mark("web", 3, "live");
    expect(await drain()).toEqual(["run_b"]);
    expect(run(t, "run_a").status).toBe("failed");
  });
});

// ct-102786: Merge refused (the role's merge is off), the Release Captain merged #349 half a minute later, and it went
// live on cli, web and mobile; the run still read failed "Not merged" and sent a person to ship it again.
describe("a run whose pull request someone else merged reads that merge and goes Live with it", () => {
  test("a stopped run records the merge, reads going live in place of its stop, and completes at Live once deploys carry it", async () => {
    const { t, mark, drain, mergedOnGitHub } = await world();
    t.workflow_runs.push(endedBeforeMerge("run_m", 7, "task_b", "stopped"));
    t.tasks[1].execution_status = "blocked";
    t.tasks[1].execution_concerns = run(t, "run_m").fail_reason;
    t.pending_messages.push({ _id: "pm_m_end", conversation_id: "conv_subject", client_id: "run:run_m:end:9f9f", content: "Not merged", status: "delivered", from_user_id: ME, created_at: NOW - 29_000 });

    expect(await mergedOnGitHub(7, 2, "captain")).toBe("run_m");
    expect(run(t, "run_m")).toMatchObject({ status: "failed", current_node_id: "unshipped", fail_reason: `Merged by someone else: #7 merged as ${sha(2).slice(0, 7)} by captain; going live.` });
    expect(run(t, "run_m").merge).toMatchObject({ sha: sha(2), branch: "fix-7", into: "main", outside: true, by: "captain", pr_url: `https://github.com/${REPO}/pull/7` });
    expect(t.tasks[1].execution_status).toBeUndefined();
    expect(told(t, "conv_subject").filter((m) => m._id !== "pm_m_end")).toHaveLength(0);

    await mark("cli", 2, "live");
    expect((await drain())).toContain("run_m");
    const m = run(t, "run_m");
    expect(m).toMatchObject({ status: "completed", current_node_id: "exit", fail_reason: undefined });
    expect(m.merge.outside).toBe(true);
    expect(m.node_statuses.find((n: any) => n.node_id === "deploy__wait")).toMatchObject({ status: "completed", result_preview: expect.stringMatching(/^Live: [0-9a-f]{7} on cli dp-\d+\.$/) });
    expect(m.node_statuses.some((n: any) => n.node_id === "unshipped")).toBe(false);
    const heard = told(t, "conv_subject").filter((x) => x._id !== "pm_m_end" && x.client_id === "run:run_m:live");
    expect(heard).toHaveLength(1);
    expect(heard[0].content).toContain("It had ended before its merge, and its pull request was merged outside it by captain; deploys took the change live.");
  });

  test("a run handed to its role completes at Live at once when deploys already carry the merge", async () => {
    const { t, mark, drain, mergedOnGitHub } = await world();
    t.workflow_runs.push(endedBeforeMerge("run_h", 8, "task_c", "handed"));
    await mark("cli", 2, "live");
    await drain();
    expect(await mergedOnGitHub(8, 2)).toBe("run_h");
    expect(run(t, "run_h")).toMatchObject({ status: "completed", current_node_id: "exit" });
    expect(run(t, "run_h").merge).toMatchObject({ outside: true });
    expect(run(t, "run_h").merge.by).toBeUndefined();
  });

  test("the task of a run handed to its role stays in review through the merge, and is done once the merge goes live", async () => {
    const { t, mark, drain, mergedOnGitHub } = await world();
    t.tasks.push({ _id: "task_d", short_id: "ct-4", workspace: WS, status: "in_review", review_verdict: { verdict: "approve", at: NOW - 60_000 } });
    t.workflow_runs.push(endedBeforeMerge("run_hd", 11, "task_d", "handed"));
    await mergedOnGitHub(11, 2, "captain");
    expect(t.tasks.find((x) => x._id === "task_d")!.status).toBe("in_review");
    await mark("cli", 2, "live");
    expect(await drain()).toContain("run_hd");
    expect(t.tasks.find((x) => x._id === "task_d")!.status).toBe("done");
  });

  test("a flow with no Deploy segment says merged, not going live", async () => {
    const { t, mergedOnGitHub } = await world();
    t.workflows.push({ _id: "wf_nodeploy", user_id: ME, name: "review-only", label: "Review", nodes: [node("merge", "command"), node("unshipped", "exit"), node("exit", "exit")], edges: [{ from: "merge", to: "exit" }] });
    t.workflow_runs.push({ ...endedBeforeMerge("run_nd", 12, "task_c", "stopped"), workflow_id: "wf_nodeploy" });
    await mergedOnGitHub(12, 2);
    expect(run(t, "run_nd").fail_reason).toBe(`Merged by someone else: #12 merged as ${sha(2).slice(0, 7)}.`);
  });

  test("the backfill heals the pull request's newest run, and its dry run lists only that run", async () => {
    const { t, heal } = await world();
    t.workflow_runs.push({ ...endedBeforeMerge("run_b_old", 13, "task_c", "stopped"), created_at: NOW - 300_000 });
    t.workflow_runs.push(endedBeforeMerge("run_b_new", 13, "task_c", "stopped"));
    t.pull_requests.push({ _id: "pr_13", team_id: TEAM, github_pr_id: 13, repository: REPO, number: 13, title: "x", body: "", state: "merged", author_github_username: "ana", head_ref: "fix-13", base_ref: "main", linked_session_ids: [], merged_at: NOW - 20_000, merge_commit_sha: sha(2), created_at: NOW - 90_000, updated_at: NOW - 20_000 });
    expect(await heal(true)).toEqual(["run_b_new"]);
    expect(run(t, "run_b_new").merge).toBeUndefined();
    expect(await heal(false)).toEqual(["run_b_new"]);
    expect(run(t, "run_b_new").merge.outside).toBe(true);
    expect(run(t, "run_b_old").merge).toBeUndefined();
    expect(await heal(false)).toEqual([]);
  });

  test("a running run, a run that recorded its own merge, and an older run on the same pull request are left alone", async () => {
    const { t, mergedOnGitHub } = await world();
    t.workflow_runs.push({ ...endedBeforeMerge("run_old7", 9, "task_c", "stopped"), created_at: NOW - 200_000 });
    t.workflow_runs.push({ ...endedBeforeMerge("run_live9", 9, "task_c", "stopped"), status: "running", current_node_id: "merge", fail_reason: undefined });
    expect(await mergedOnGitHub(9, 2)).toBeNull();
    expect(run(t, "run_old7").merge).toBeUndefined();
    expect(run(t, "run_live9").merge).toBeUndefined();
    t.workflow_runs.push({ ...endedBeforeMerge("run_own", 10, "task_c", "stopped"), merge: { sha: sha(2), branch: "b", into: "main", at: NOW } });
    expect(await mergedOnGitHub(10, 2)).toBeNull();
    expect(run(t, "run_own").merge.outside).toBeUndefined();
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
