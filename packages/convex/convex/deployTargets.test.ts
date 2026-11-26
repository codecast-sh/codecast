import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish, recordLiveRead, recordShipPass, reportMainCommits, request, view } from "./deployTargets";
import { checkSuiteCi, recordCommitCi, recordGithubDeployStatus, stampMainOrder, statusEventOf, workflowRunCi } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { liveReaderUrlRefusal } from "./lib/liveReaderUrl";
import { cancelForPause, mayDispatchCore, nextCore, readRun, recordRun, send, settle, sweepCore } from "./deployDispatch";
import { recordWorkflowRunDeploy } from "./deployTargetsCi";
import { endingOf, liftEndedPauses, remindCore, rollback } from "./deployRollback";
import { grant as grantPause, lift as liftPause, pause as pausePause, status as pauseStatus } from "./deployPause";
import { dispatch } from "./dispatch";

// A repository's deploy targets (docs/architecture/deploys.md DP10 to DP14):
// published from the checkout, live from whichever path recorded it, the
// commits on main after the live sha waiting by session with CI, and a deploy
// of any target asked for from codecast. Synthetic data only.

// Shaped like a server id, so the Deploys page's dispatch writes take it.
const TEAM = "team1".padEnd(32, "0") as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_targets_token";
const BO = "user_bo";
const BO_TOKEN = "cast_targets_token_bo";
const REPO = "acme/app";
const NOW = Date.now();

const sha = (n: number) => String(n).padStart(2, "0").repeat(20);

async function seed() {
  return {
    users: [{ _id: ME, name: "Ana" }, { _id: BO, name: "Bo", email: "bo@acme.dev" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }, { _id: "tok_2", user_id: BO, token_hash: await hashToken(BO_TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }, { _id: "m2", user_id: BO, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [{ _id: "dev_row", user_id: ME, device_id: "ana-mac" }],
    github_app_installations: [],
    repo_sources: [{ _id: "rs1", repository: REPO, team_id: TEAM }],
    conversations: [
      { _id: "conv_api_work", title: "Fix the totals", user_id: ME, team_id: TEAM },
      { _id: "conv_ui_work", title: "New checkout page", user_id: ME, team_id: TEAM },
    ],
    tasks: [{ _id: "task_a", short_id: "ct-7", title: "Totals round wrong", user_id: ME, team_id: TEAM, workspace: WS }],
    commits: [] as any[],
    commit_ci: [] as any[],
    deploy_targets: [] as any[],
    deploys: [] as any[],
    deploy_pauses: [] as any[],
    org_roles: [] as any[],
    ship_passes: [] as any[],
    external_events: [],
    event_groups: [],
    workflow_runs: [],
    signals: [],
    counters: [],
    daemon_commands: [] as any[],
    agent_tasks: [],
    projects: [],
  } as Record<string, any[]>;
}

const ctxFor = (tables: Record<string, any[]>) =>
  ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } }) as any;

const TARGETS = [
  { name: "backend", command: "./deploy-api.sh", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["api/**"], ship_stage: "before_push" },
  { name: "web", runs: "push", live: { kind: "github-status", context: "acme - web" }, policy: "press", paths: ["web/**"] },
  { name: "cli", command: "gh workflow run release.yml", runs: "here", live: { kind: "json", url: "https://dl.acme.dev/latest.json", sha_field: "sourceCommit", version_field: "version" }, policy: "press", paths: ["cli/**"], ship_stage: "press" },
];

async function published() {
  const t = await seed();
  const ctx = ctxFor(t);
  await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: TARGETS, device_id: "ana-mac", root: "/repo" });
  return { t, ctx };
}

/** Commits on main, in order, as a push stamps them. */
async function pushMain(t: Record<string, any[]>, ctx: any, rows: Array<{ n: number; files: string[]; conv?: string; tasks?: string[] }>, at: number) {
  const ids = [];
  for (const r of rows) {
    const _id = `commit_${r.n}`;
    t.commits.push({
      _id, sha: sha(r.n), message: `change ${r.n}\n\nCodecast-Session: ${r.conv ?? ""}`, author_name: "Ana", author_email: "a@x", timestamp: at, files_changed: r.files.length, insertions: 0, deletions: 0,
      repository: REPO, team_id: TEAM, branch: "main", files: r.files.map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 })),
      ...(r.conv ? { conversation_id: r.conv } : {}), ...(r.tasks ? { task_ids: r.tasks } : {}),
    });
    ids.push(_id as any);
  }
  await stampMainOrder(ctx, ids, at);
}

const viewOf = async (ctx: any, target?: string) => (await (view as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, ...(target ? { target } : {}) })).targets;
/** A repository's production controls as the view gives them, once per repository. */
const productionOf = async (ctx: any, token = TOKEN) => (await (view as any)._handler(ctx, { api_token: token, team_id: TEAM })).productions.find((p: any) => p.repository === REPO);

describe("publishing targets (DP10)", () => {
  test("a checkout's targets are stored per repository, and one it stops declaring is retired", async () => {
    const { t, ctx } = await published();
    expect(t.deploy_targets.map((r) => [r.name, r.workspace, r.device_id, r.root])).toEqual([
      ["backend", WS, "ana-mac", "/repo"], ["web", WS, "ana-mac", "/repo"], ["cli", WS, "ana-mac", "/repo"],
    ]);
    await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: TARGETS.slice(0, 2), device_id: "ana-mac", root: "/repo" });
    expect(t.deploy_targets.find((r) => r.name === "cli").retired_at).toBeNumber();
    expect((await viewOf(ctx)).map((x: any) => x.name)).toEqual(["backend", "web"]);
  });
});

describe("the newest commit's targets stand (DP10, pipeline.md PL5)", () => {
  const pub = (ctx: any, targets: any[], head?: { sha: string; at: number }, device = "ana-mac") =>
    (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets, device_id: device, root: "/repo", ...(head ? { head_sha: head.sha, head_at: head.at } : {}) });

  test("a fresher checkout's set retires what it no longer declares; an older commit's set is refused and changes nothing", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    // Published before any commit was named: four targets, as an old clone declares them.
    await pub(ctx, TARGETS);
    const fresh = await pub(ctx, TARGETS.slice(0, 2), { sha: sha(9), at: 9_000 });
    expect(fresh.refused).toBeUndefined();
    expect(t.deploy_targets.filter((r) => !r.retired_at).map((r) => r.name)).toEqual(["backend", "web"]);
    expect(t.deploy_targets.find((r) => r.name === "backend")).toMatchObject({ head_sha: sha(9), head_at: 9_000 });
    const stale = await pub(ctx, TARGETS, { sha: sha(3), at: 3_000 }, "old-mac");
    expect(stale.refused).toContain("newer commit");
    expect(t.deploy_targets.filter((r) => !r.retired_at).map((r) => [r.name, r.device_id])).toEqual([["backend", "ana-mac"], ["web", "ana-mac"]]);
    expect((await pub(ctx, TARGETS)).refused).toContain("newer commit");
    expect((await pub(ctx, TARGETS.slice(0, 2), { sha: sha(9), at: 9_000 })).refused).toBeUndefined();
    expect((await pub(ctx, TARGETS, { sha: sha(12), at: 12_000 })).refused).toBeUndefined();
    expect(t.deploy_targets.filter((r) => !r.retired_at).map((r) => r.name)).toEqual(["backend", "web", "cli"]);
  });
});

describe("the waiting queue (DP12)", () => {
  test("the commits on main after the live sha that touch a target wait for it, by session, each with its CI", async () => {
    const { t, ctx } = await published();
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }], NOW - 10_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(1), repository: REPO, source: "cast ship mark", at: NOW - 9_000 });
    await pushMain(t, ctx, [
      { n: 2, files: ["api/b.ts"], conv: "conv_api_work", tasks: ["task_a"] },
      { n: 3, files: ["web/page.tsx"], conv: "conv_ui_work" },
      { n: 4, files: ["api/c.ts", "web/x.tsx"], conv: "conv_api_work" },
      { n: 5, files: ["api/d.ts"] },
    ], NOW - 5_000);
    await recordCommitCi(ctx, { repository: REPO, sha: sha(2), name: "CI", kind: "workflow", run_id: "1", status: "completed", conclusion: "success", started_at: NOW - 4_000 }, TEAM);
    await recordCommitCi(ctx, { repository: REPO, sha: sha(4), name: "CI", kind: "workflow", run_id: "2", status: "completed", conclusion: "failure", url: "https://ci/2", started_at: NOW - 3_000 }, TEAM);
    await recordCommitCi(ctx, { repository: REPO, sha: sha(5), name: "CI", kind: "workflow", run_id: "3", status: "in_progress", started_at: NOW - 2_000 }, TEAM);

    const [backend] = await viewOf(ctx, "backend");
    expect(backend.live).toMatchObject({ short_id: "dp-1", sha: sha(1) });
    expect(backend.queue).toMatchObject({ known: true, commits: 3, untouched: 1, head_sha: sha(5), head_ci: "running" });
    expect(backend.queue.groups.map((g: any) => [g.key, g.commits.map((c: any) => [c.sha.slice(0, 2), c.ci]), g.ci])).toEqual([
      ["s:conv_api_work", [["04", "failed"], ["02", "passed"]], "failed"],
      ["none", [["05", "running"]], "running"],
    ]);
    expect(backend.queue.groups[0].session).toEqual({ conversation_id: "conv_api_work", short_id: "conv_ap", title: "Fix the totals", user_id: "user_me" });
    expect(backend.queue.groups[0].commits[1].tasks).toEqual([{ task_id: "task_a", short_id: "ct-7", title: "Totals round wrong" }]);
    expect(backend.queue.groups[0].commits[0].ci_url).toBe("https://ci/2");
  });

  test("a deploy going live records the commits it carried, the sessions and tasks behind them, and what came after", async () => {
    const { t, ctx } = await published();
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }], NOW - 10_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(1), repository: REPO, source: "m", at: NOW - 9_000 });
    await pushMain(t, ctx, [{ n: 2, files: ["api/b.ts"], conv: "conv_api_work", tasks: ["task_a"] }, { n: 3, files: ["web/x.tsx"], conv: "conv_ui_work" }], NOW - 5_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(3), repository: REPO, source: "m", at: NOW - 1_000 });
    const dp2 = t.deploys.find((d) => d.short_id === "dp-2");
    expect(dp2.previous_sha).toBe(sha(1));
    expect(dp2.commits).toEqual([{ sha: sha(2), subject: "change 2", author: "Ana", conversation_id: "conv_api_work", task_ids: ["task_a"] }]);
    // An error group that started after dp-2 went live is its aftermath, not dp-1's.
    t.event_groups.push({ _id: "eg_1", workspace: WS, kind: "error", short_id: "eg-1", title: "TypeError", first_seen: NOW - 500, last_seen: NOW - 400, count: 3 });
    const [backend] = await viewOf(ctx, "backend");
    expect(backend.history[0]).toMatchObject({
      short_id: "dp-2",
      sessions: [{ conversation_id: "conv_api_work", short_id: "conv_ap", title: "Fix the totals" }],
      tasks: [{ task_id: "task_a", short_id: "ct-7", title: "Totals round wrong" }],
      after: { new_errors: 1, regressions: 0, reopened: 0, quiet: false, open: true },
    });
    expect(backend.history[1]).toMatchObject({ short_id: "dp-1", tasks: [], after: { new_errors: 0, quiet: true, open: false } });
    expect(backend.live.after).toEqual(backend.history[0].after);
    expect(backend.queue.commits).toBe(0);
  });

  test("a source's marker (an environment, a short sha, no repository) fills its range from the published target; a commit with no trailer is its task's session", async () => {
    const { t, ctx } = await published();
    t.tasks[0].conversation_ids = ["conv_ui_work", "conv_api_work"];
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }], NOW - 10_000);
    const marker = { workspace: WS, team_id: TEAM, target: "backend", source: "acme-errors", started_by: { kind: "source" as const, name: "acme-errors" } };
    await recordDeployMarker(ctx, { ...marker, sha: sha(1).slice(0, 9), version: sha(1).slice(0, 9), at: NOW - 9_000 });
    await pushMain(t, ctx, [{ n: 2, files: ["api/b.ts"], tasks: ["task_a"] }, { n: 3, files: ["api/c.ts"] }], NOW - 5_000);
    const [backend] = await viewOf(ctx, "backend");
    expect(backend.queue.groups.map((g: any) => [g.key, g.session?.via ?? null, g.commits.length])).toEqual([["s:conv_api_work", "task", 1], ["none", null, 1]]);
    await recordDeployMarker(ctx, { ...marker, sha: sha(3).slice(0, 9), version: sha(3).slice(0, 9), at: NOW - 1_000 });
    const dp2 = t.deploys.find((d) => d.short_id === "dp-2");
    expect(dp2).toMatchObject({ repository: REPO, previous_sha: sha(1).slice(0, 9) });
    expect(dp2.commits.map((c: any) => [c.sha, c.conversation_id ?? null])).toEqual([[sha(3), null], [sha(2), "conv_api_work"]]);
  });

  test("a live sha codecast never saw on main leaves the queue unknown, not empty", async () => {
    const { ctx } = await published();
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(9), repository: REPO, source: "m", at: NOW });
    expect((await viewOf(ctx, "backend"))[0].queue.known).toBe(false);
  });
});

describe("recording every way a target goes live (DP11)", () => {
  test("a ship pass records each target step's deploy with the sha it pushed, and the pass itself", async () => {
    const { t, ctx } = await published();
    const r = await (recordShipPass as any)._handler(ctx, {
      api_token: TOKEN, team_id: TEAM, repository: REPO, ok: true, stage: "done", base: sha(1), tip: sha(2), pushed: sha(3),
      commits: [{ sha: sha(3), message: "feat: x", files: 2, session_id: "conv_ap", conversation_id: "conv_api_work" }],
      held: [{ group: "s:other", paths: 3, note: "mid-turn" }],
      deploys: [{ name: "typing-guard", stage: "before_push", ok: true }, { name: "convex", stage: "before_push", ok: true, target: "backend", dirty: 2 }],
      started_at: NOW - 60_000,
    });
    expect(r.deploys).toEqual([{ name: "typing-guard", deploy: null }, { name: "convex", deploy: "dp-1" }]);
    expect(t.deploys[0]).toMatchObject({ target: "backend", status: "live", sha: sha(3), dirty: 2, source: "cast ship checkout", ship_pass_id: t.ship_passes[0]._id });
    expect(t.ship_passes[0]).toMatchObject({ ok: true, pushed: sha(3), held: [{ group: "s:other", paths: 3, note: "mid-turn" }] });
    expect(t.ship_passes[0].deploys[1]).toMatchObject({ target: "backend", deploy: "dp-1" });
  });

  test("a failed target step records a failed deploy", async () => {
    const { t, ctx } = await published();
    await (recordShipPass as any)._handler(ctx, {
      api_token: TOKEN, team_id: TEAM, repository: REPO, ok: false, stage: "deploy", reason: "convex failed before the push", tip: sha(2),
      commits: [], held: [], deploys: [{ name: "convex", stage: "before_push", ok: false, target: "backend", output: "TypeError" }], started_at: NOW,
    });
    expect(t.deploys[0]).toMatchObject({ status: "failed", sha: sha(2), note: "TypeError" });
  });

  test("a Railway commit status on main's commit is the web target's deploy: pending, then live; a failure fails it", async () => {
    const { t, ctx } = await published();
    const payload = (state: string, n: number) => ({ sha: sha(n), context: "acme - web", state, target_url: "https://railway/x", branches: [{ name: "main" }], repository: { full_name: REPO, default_branch: "main" }, updated_at: new Date(NOW).toISOString() });
    await recordGithubDeployStatus(ctx, statusEventOf(payload("pending", 1))!);
    expect(t.deploys[0]).toMatchObject({ target: "web", status: "running" });
    await recordGithubDeployStatus(ctx, statusEventOf(payload("success", 1))!);
    expect(t.deploys).toHaveLength(1);
    expect(t.deploys[0]).toMatchObject({ status: "live", sha: sha(1), url: "https://railway/x" });
    await recordGithubDeployStatus(ctx, statusEventOf(payload("failure", 2))!);
    expect(t.deploys[1]).toMatchObject({ status: "failed", sha: sha(2) });
    expect((await viewOf(ctx, "web"))[0].live.sha).toBe(sha(1));
    // Another context, or a commit off main, is no deploy.
    expect(await recordGithubDeployStatus(ctx, statusEventOf({ ...payload("success", 3), context: "lint" })!)).toEqual([]);
    expect(statusEventOf({ ...payload("success", 3), branches: [{ name: "feature" }] })!.on_default_branch).toBe(false);
  });

  test("a json reader records a deploy when the document names a new commit, once", async () => {
    const { t, ctx } = await published();
    const cli = t.deploy_targets.find((r) => r.name === "cli");
    expect(await (recordLiveRead as any)._handler(ctx, { target_id: cli._id, sha: sha(4), version: "1.2.0" })).toBe("dp-1");
    expect(await (recordLiveRead as any)._handler(ctx, { target_id: cli._id, sha: sha(4), version: "1.2.0" })).toBeNull();
    expect(t.deploys[0]).toMatchObject({ target: "cli", sha: sha(4), version: "1.2.0", source: "live reader" });
  });

  test("a mark that names its deploy finishes it with the sha that actually went out", async () => {
    const { t, ctx } = await published();
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }], NOW - 10_000);
    const asked = await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend", here: true });
    t.deploys[0].sha = sha(1); // the first step fixed origin's head
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(2), repository: REPO, source: "cast ship mark", deploy: asked.short_id, dirty: 1, at: NOW });
    expect(t.deploys).toHaveLength(1);
    expect(t.deploys[0]).toMatchObject({ status: "live", sha: sha(2), dirty: 1 });
  });
});

describe("deploying a target from codecast (DP13)", () => {
  test("Deploy asks for one deploy of main's head, queued on the publishing machine, and refuses a second", async () => {
    const { t, ctx } = await published();
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"], conv: "conv_api_work" }], NOW - 10_000);
    const r = await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend" });
    expect(r).toMatchObject({ short_id: "dp-1", action: "deploy", commits: 1 });
    expect(t.deploys[0]).toMatchObject({ status: "requested", target: "backend", action: "deploy", repository: REPO });
    expect(t.deploys[0].commits[0].conversation_id).toBe("conv_api_work");
    expect(JSON.parse(t.daemon_commands[0].args)).toEqual({ deploy: "dp-1", root: "/repo" });
    expect(t.daemon_commands[0]).toMatchObject({ command: "line_deploy", target_device_id: "ana-mac" });
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend" })).rejects.toThrow(/already going out/);
  });

  test("a deploy names the commit it makes live: on the default branch, after the live one, and its commits stop there", async () => {
    const { t, ctx } = await published();
    t.deploy_targets.find((r) => r.name === "backend").command = "./deploy-api.sh --sha $sha";
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }], NOW - 30_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(1), repository: REPO, source: "m", at: NOW - 25_000 });
    await pushMain(t, ctx, [{ n: 2, files: ["api/b.ts"], conv: "conv_api_work" }], NOW - 20_000);
    await pushMain(t, ctx, [{ n: 3, files: ["api/c.ts"] }], NOW - 10_000);
    const r = await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend", sha: sha(2).slice(0, 9) });
    expect(r).toMatchObject({ action: "deploy", sha: sha(2), commits: 1 });
    expect(t.deploys.find((d) => d.short_id === r.short_id)).toMatchObject({ status: "requested", sha: sha(2), previous_sha: sha(1) });
    expect(t.deploys.find((d) => d.short_id === r.short_id).commits.map((c: any) => c.sha)).toEqual([sha(2)]);
  });

  test("a named commit that is not on main, not after the live one, or that the command cannot send is refused, saying why", async () => {
    const { t, ctx } = await published();
    t.deploy_targets.find((r) => r.name === "backend").command = "./deploy-api.sh --sha $sha";
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts", "cli/a.ts"] }, { n: 2, files: ["api/b.ts", "cli/b.ts"] }], NOW - 30_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(2), repository: REPO, source: "m", at: NOW - 25_000 });
    const ask = (more: Record<string, unknown>) => (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend", ...more });
    await expect(ask({ sha: "f".repeat(40) })).rejects.toThrow(`is not a commit on ${REPO}'s default branch as codecast has read it`);
    await expect(ask({ sha: sha(2) })).rejects.toThrow("is already live on backend");
    await expect(ask({ sha: sha(1) })).rejects.toThrow("is older than what is live on backend");
    await expect(ask({ sha: sha(2), action: "rollback" })).rejects.toThrow("sha names the commit of a deploy");
    // The cli target's command sends the tree it runs in (no $sha): only main's head can be pinned.
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "cli", sha: sha(1) })).rejects.toThrow(`cli's command sends the tree it runs in, not a sha, so it ships main's head (${sha(2).slice(0, 10)}), not ${sha(1).slice(0, 10)}`);
    expect(await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "cli", sha: sha(2) })).toMatchObject({ sha: sha(2) });
  });

  test("a target that deploys on push has nothing to send; a tree-sending command cannot redeploy a sha; no rollback, no rollback", async () => {
    const { t, ctx } = await published();
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "web" })).rejects.toThrow(/deploys itself/);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(1), repository: REPO, source: "m", at: NOW - 2_000 });
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(2), repository: REPO, source: "m", at: NOW - 1_000 });
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend", action: "redeploy", of: "dp-1" })).rejects.toThrow(/cannot redeploy/);
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend", action: "rollback" })).rejects.toThrow(/no rollback/);
    t.deploy_targets.find((r) => r.name === "backend").rollback = "./rollback.sh $sha";
    const r = await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend", action: "rollback" });
    expect(r).toMatchObject({ action: "rollback", sha: sha(1) });
    expect(t.deploys[2]).toMatchObject({ action: "rollback", rollback_of: "dp-1", sha: sha(1), previous_sha: sha(2) });
  });
});

describe("CI on main per commit (DP12)", () => {
  const repo = { full_name: REPO, default_branch: "main" };
  test("every workflow run on main is its commit's CI, going or done; pull request runs and other branches are not", () => {
    const run = { id: 5, head_sha: sha(1), head_branch: "main", event: "push", status: "in_progress", run_started_at: new Date(NOW).toISOString(), html_url: "https://ci/5" };
    expect(workflowRunCi({ workflow_run: run, repository: repo, workflow: { name: "CI" } })).toMatchObject({ sha: sha(1), name: "CI", status: "in_progress", run_id: "5" });
    expect(workflowRunCi({ workflow_run: { ...run, event: "pull_request" }, repository: repo, workflow: { name: "CI" } })).toBeNull();
    expect(workflowRunCi({ workflow_run: { ...run, head_branch: "x" }, repository: repo, workflow: { name: "CI" } })).toBeNull();
  });

  test("another app's suite counts once it starts; Actions' suites and suites left queued forever do not", () => {
    const suite = { id: 9, head_sha: sha(1), head_branch: "main", status: "completed", conclusion: "success", app: { slug: "vercel", name: "Vercel" }, created_at: new Date(NOW).toISOString() };
    expect(checkSuiteCi({ check_suite: suite, repository: repo })).toMatchObject({ name: "Vercel", kind: "suite", conclusion: "success" });
    expect(checkSuiteCi({ check_suite: { ...suite, app: { slug: "github-actions" } }, repository: repo })).toBeNull();
    expect(checkSuiteCi({ check_suite: { ...suite, status: "queued", conclusion: null, app: { slug: "railway-app" } }, repository: repo })).toBeNull();
  });

  test("a rerun takes the workflow's row over; an older run's late delivery does not", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    const base = { repository: REPO, sha: sha(1), name: "CI", kind: "workflow" as const };
    await recordCommitCi(ctx, { ...base, run_id: "1", status: "completed", conclusion: "failure", started_at: NOW - 100 }, TEAM);
    await recordCommitCi(ctx, { ...base, run_id: "1", status: "completed", conclusion: "success", started_at: NOW }, TEAM);
    await recordCommitCi(ctx, { ...base, run_id: "0", status: "completed", conclusion: "failure", started_at: NOW - 500 }, TEAM);
    expect(t.commit_ci).toHaveLength(1);
    expect(t.commit_ci[0]).toMatchObject({ conclusion: "success", workspace: WS });
  });
});

describe("why a deploy failed", () => {
  test("GitHub's description is a failed deploy's note, and the same failure reported again enriches it", async () => {
    const { t, ctx } = await published();
    const payload = (description?: string) => ({ sha: sha(1), context: "acme - web", state: "failure", ...(description ? { description } : {}), branches: [{ name: "main" }], repository: { full_name: REPO, default_branch: "main" } });
    await recordGithubDeployStatus(ctx, statusEventOf(payload())!);
    await recordGithubDeployStatus(ctx, statusEventOf(payload("Deployment failed"))!);
    expect(t.deploys).toHaveLength(1);
    expect(t.deploys[0]).toMatchObject({ status: "failed", note: "Deployment failed" });
  });
});

describe("a repository GitHub does not report", () => {
  test("the checkout's report of main orders its commits, and the queue follows them", async () => {
    const { t, ctx } = await published();
    const c = (n: number, files: string[], conv?: string) => ({ sha: sha(n), message: `change ${n}${conv ? `\n\nCodecast-Session: ${conv}` : ""}`, author_name: "Ana", author_email: "a@x", at: NOW - 10_000 + n, files });
    await (reportMainCommits as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, branch: "main", commits: [c(1, ["api/a.ts"]), c(2, ["api/b.ts"]), c(3, ["web/x.tsx"])] });
    expect(t.commits.map((r) => [r.sha.slice(0, 2), r.main_at != null])).toEqual([["01", true], ["02", true], ["03", true]]);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "backend", sha: sha(1), repository: REPO, source: "m", at: NOW });
    const [backend] = await viewOf(ctx, "backend");
    expect(backend.queue).toMatchObject({ known: true, commits: 1, untouched: 1 });
  });
});

describe("a json live reader's url (pollLiveReaders)", () => {
  test("only http(s) to a public host is fetched", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://dl.acme.dev/latest.json",
      "not a url",
      "http://localhost:3210/latest.json",
      "http://127.0.0.1/latest.json",
      "http://2130706433/latest.json",
      "http://0.0.0.0/",
      "http://10.1.2.3/latest.json",
      "http://172.16.0.9/x",
      "http://192.168.1.1/x",
      "http://100.64.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/x",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      "http://[::ffff:10.0.0.1]/x",
      "http://convex-backend:3210/x",
      "http://db.internal/x",
      "http://printer.local/x",
      "https://user:pw@dl.acme.dev/latest.json",
    ]) expect([url, liveReaderUrlRefusal(url) !== null]).toEqual([url, true]);
  });

  test("publish refuses a json reader aimed inside the network, and stores nothing", async () => {
    const t = await seed();
    const inside = { ...TARGETS[2], live: { ...TARGETS[2].live, url: "http://169.254.169.254/latest/meta-data/" } };
    await expect((publish as any)._handler(ctxFor(t), { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: [inside] })).rejects.toThrow("must name a public host");
    expect(t.deploy_targets).toEqual([]);
  });

  test("a public release document is still read", () => {
    for (const url of [
      "https://dl.acme.dev/latest.json",
      "http://dl.acme.dev:8080/latest.json",
      "https://8.8.8.8/latest.json",
      "https://172.32.0.1/x",
      "https://[2606:4700::1111]/x",
    ]) expect([url, liveReaderUrlRefusal(url)]).toEqual([url, null]);
  });
});

describe("production paused (DP17)", () => {
  const as = (token: string) => ({ api_token: token, team_id: TEAM, repository: REPO });

  test("a pause is held by admins and members an admin granted it, never by a deploy grant alone", async () => {
    const { t, ctx } = await published();
    await expect((pausePause as any)._handler(ctx, { ...as(TOKEN), reason: "errors spiking" })).rejects.toThrow(/held by founders, engineers and the Release Captain/);
    t.team_memberships[0].role = "admin";
    await expect((grantPause as any)._handler(ctx, { ...as(BO_TOKEN), person: "Ana" })).rejects.toThrow(/Only a team admin/);
    expect(await (grantPause as any)._handler(ctx, { ...as(TOKEN), person: "bo@acme.dev" })).toEqual({ person: "Bo", holds: true });
    expect(await (pauseStatus as any)._handler(ctx, as(BO_TOKEN))).toEqual({ repository: REPO, paused: null, can_pause: true });
    await (grantPause as any)._handler(ctx, { ...as(TOKEN), person: "bo@acme.dev", revoke: true });
    expect((await (pauseStatus as any)._handler(ctx, as(BO_TOKEN))).can_pause).toBe(false);
  });

  test("while paused nothing is sent to the repository's targets; whoever paused lifts it, and sends go again", async () => {
    const { t, ctx } = await published();
    t.team_memberships[0].role = "admin";
    t.team_memberships[1].production_pause = true;
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }], NOW - 10_000);
    const p = await (pausePause as any)._handler(ctx, { ...as(TOKEN), reason: "errors spiking" });
    expect(p).toMatchObject({ repository: REPO, by: "Ana", reason: "errors spiking", lifts: "Ana or the Release Captain lifts it.", until: null });
    await expect((pausePause as any)._handler(ctx, { ...as(BO_TOKEN), reason: "again" })).rejects.toThrow(/already paused by Ana/);
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend" })).rejects.toThrow(/Production is paused by Ana: errors spiking/);
    expect(await productionOf(ctx)).toMatchObject({ pause: { by: "Ana", reason: "errors spiking" }, can_pause: true });
    expect((await viewOf(ctx)).every((t: any) => !("pause" in t))).toBe(true);
    await expect((liftPause as any)._handler(ctx, as(BO_TOKEN))).rejects.toThrow(/Ana paused production; they or the Release Captain lift it/);
    expect(await (liftPause as any)._handler(ctx, as(TOKEN))).toEqual({ lifted: true, repository: REPO });
    expect(t.deploy_pauses[0]).toMatchObject({ lifted_by: "Ana" });
    expect(await (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "backend" })).toMatchObject({ action: "deploy" });
  });

  test("the Deploys page pauses and lifts through dispatch, and the repository says whether its viewer may lift", async () => {
    const { t, ctx } = await published();
    t.team_memberships[0].role = "admin";
    t.team_memberships[1].production_pause = true;
    const asUser = (user: string) => ({ ...ctx, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
    const press = (user: string, action: string, args: unknown[]) => (dispatch as any)._handler(asUser(user), { action, args });
    expect(await press(ME, "pauseProduction", [TEAM, REPO, "errors spiking"])).toMatchObject({ by: "Ana", reason: "errors spiking", cancelled: [] });
    expect(await productionOf(ctx)).toMatchObject({ pause: { by: "Ana" }, can_pause: true, can_lift: true });
    expect((await viewOf(ctx, "backend"))[0]).toMatchObject({ workflow: null });
    expect(await productionOf(ctx, BO_TOKEN)).toMatchObject({ can_pause: true, can_lift: false });
    await expect(press(BO, "liftProductionPause", [TEAM, REPO])).rejects.toThrow(/Ana paused production/);
    expect(await press(ME, "liftProductionPause", [TEAM, REPO])).toEqual({ lifted: true, repository: REPO });
    expect(await productionOf(ctx)).toMatchObject({ pause: null, can_lift: false });
  });
});

describe("codecast's deploy queue through its GitHub app (DP18)", () => {
  const PROD = { name: "production", command: "./deploy.sh --sha $sha", runs: "here", live: { kind: "marker" }, policy: "press", paths: [], workflow: "deploy.yml", rollback_inputs: { components: "backend-web" } };

  async function production() {
    const t = await seed();
    const scheduled: Array<{ fn: string; args: any }> = [];
    const ctx = { ...ctxFor(t), scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push({ fn: String(fn?.[Symbol.for("functionName")] ?? fn), args }); return null; } } } as any;
    // No machine publishes it: only codecast's GitHub app can send it.
    await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: [PROD] });
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }, { n: 2, files: ["api/b.ts"] }], NOW - 60_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(1), repository: REPO, source: "m", at: NOW - 50_000 });
    return { t, ctx, scheduled };
  }
  const ask = (ctx: any, more: Record<string, unknown> = {}) => (request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "production", ...more });

  test("a deploy with no publishing machine queues with main's exact head and goes out one at a time", async () => {
    const { t, ctx } = await production();
    const r = await ask(ctx);
    expect(r).toMatchObject({ short_id: "dp-2", sha: sha(2) });
    expect(t.daemon_commands).toEqual([]);
    const d = t.deploys.find((x) => x.short_id === "dp-2");
    expect(d.dispatch).toMatchObject({ state: "queued", inputs: { sha: sha(2), actor: "Ana" } });
    expect(await nextCore(ctx, WS, "production")).toEqual({ sending: "dp-2" });
    expect(await nextCore(ctx, WS, "production")).toEqual({ waiting: "dp-2 is going out" });
    await (settle as any)._handler(ctx, { deploy: d._id, outcome: "sent" });
    expect(d.dispatch.state).toBe("sent");
    await expect(ask(ctx)).rejects.toThrow(/dp-2 is already going out/);
    // Its run, named by the sha in its run-name, is the queued deploy, not a deploy of its own.
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(2), repository: REPO, source: "github: Deploy", workflow_run: "77", url: "https://github.com/acme/app/actions/runs/77", status: "running", at: NOW });
    expect(t.deploys.filter((x) => x.target === "production")).toHaveLength(2);
    expect(d).toMatchObject({ status: "running", workflow_run: "77" });
  });

  test("a rollback queues behind the running deploy instead of being refused, and goes out with the rollback inputs once it ends", async () => {
    const { t, ctx } = await production();
    t.team_memberships[0].role = "admin";
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(2), repository: REPO, source: "m", at: NOW - 40_000 });
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(2), repository: REPO, source: "github: Deploy", workflow_run: "80", url: "https://github.com/acme/app/actions/runs/80", status: "running", at: NOW - 30_000 });
    const running = t.deploys.find((x) => x.workflow_run === "80");
    // Codecast's rollback is the one way back: a bare rollback request would skip its pause.
    await expect(ask(ctx, { action: "rollback" })).rejects.toThrow(/pauses production first/);
    const r = await (rollback as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, reason: "errors spiking" });
    expect(r).toMatchObject({ target: "production", sha: sha(1) });
    const rb = t.deploys.find((x) => x.short_id === r.deploy);
    expect(rb).toMatchObject({ action: "rollback", status: "requested" });
    expect(rb.dispatch.inputs).toEqual({ sha: sha(1), actor: "Ana", components: "backend-web" });
    expect(await nextCore(ctx, WS, "production")).toEqual({ waiting: `${running.short_id} is going out` });
    running.status = "live";
    // Production is paused, and the rollback that paused it is the one deploy that goes out.
    expect(await nextCore(ctx, WS, "production")).toEqual({ sending: r.deploy });
  });

  test("the Deploys page's Roll back takes codecast's rollback, and its deploy carries the page's client key", async () => {
    const { t, ctx } = await production();
    t.team_memberships[0].role = "admin";
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(2), repository: REPO, source: "m", at: NOW - 40_000 });
    expect((await viewOf(ctx, "production"))[0]).toMatchObject({ workflow: "deploy.yml", rollback_inputs: { components: "backend-web" } });
    const asAna = { ...ctx, auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) } };
    const r = await (dispatch as any)._handler(asAna, { action: "rollbackProduction", args: ["dp-client-abc", TEAM, REPO, "production", null, "checkout broken"] });
    expect(r).toMatchObject({ target: "production", sha: sha(1), ending: "revert" });
    expect(t.deploys.find((x) => x.short_id === r.deploy)).toMatchObject({ action: "rollback", client_key: "dp-client-abc" });
    expect((await productionOf(ctx)).pause).toMatchObject({ rollback: r.deploy, until: { task: r.task, kind: "revert" } });
  });

  test("a pause cancels what waits in the queue and stops a run before rollout; any other cancel is neutral", async () => {
    const { t, ctx, scheduled } = await production();
    const queued = await ask(ctx);
    // A run another path dispatched for an earlier commit: a deploy of its own, going out.
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(1), repository: REPO, source: "github: Deploy", workflow_run: "81", url: "https://github.com/acme/app/actions/runs/81", status: "running", at: NOW - 30_000 });
    const out = await cancelForPause(ctx, WS, REPO, "Ana", "production paused: errors");
    expect(out).toHaveLength(2);
    expect(t.deploys.find((x) => x.short_id === queued.short_id)).toMatchObject({ status: "cancelled", cancel: { by: "Ana", why: "production paused: errors" } });
    expect(scheduled.some((c) => c.args?.why === "production paused: errors" && c.args?.deploy)).toBe(true);
    // A run cancelled anywhere else carries no codecast cancel.
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(1), repository: REPO, source: "github: Deploy", workflow_run: "81", url: "https://github.com/acme/app/actions/runs/81", status: "cancelled", at: NOW });
    expect(t.deploys.find((x) => x.workflow_run === "81")).toMatchObject({ status: "cancelled" });
    expect(t.deploys.find((x) => x.workflow_run === "81").cancel).toBeUndefined();
  });

  const runPayload = (run: Record<string, unknown>) => ({
    workflow_run: { id: 90, head_sha: sha(2), head_branch: "main", path: ".github/workflows/deploy.yml", event: "workflow_dispatch", run_attempt: 1, html_url: `https://github.com/${REPO}/actions/runs/90`, display_title: `Deploy ${sha(2)} for Ana`, name: "Deploy", run_started_at: new Date(NOW).toISOString(), created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), status: "in_progress", conclusion: null, ...run },
    repository: { full_name: REPO, default_branch: "main" },
    workflow: { name: "Deploy" },
  });

  test("a pause that comes while a deploy is claimed cancels it before GitHub is asked; the pause's own rollback still goes", async () => {
    const { t, ctx } = await production();
    t.team_memberships[0].role = "admin";
    const asked = await ask(ctx);
    expect(await nextCore(ctx, WS, "production")).toEqual({ sending: asked.short_id });
    await (pausePause as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, reason: "errors" });
    const d = t.deploys.find((x) => x.short_id === asked.short_id);
    expect(await mayDispatchCore(ctx, d._id)).toBe(false);
    expect(d).toMatchObject({ status: "cancelled", cancel: { by: "Ana", why: "production paused: errors" } });
    // The rollback that paused passes the same read.
    t.deploy_pauses[0].rollback = "dp-9";
    d.status = "requested";
    d.short_id = "dp-9";
    d.dispatch = { ...d.dispatch, state: "sending" };
    expect(await mayDispatchCore(ctx, d._id)).toBe(true);
  });

  test("a deploy sent before the pause is cancelled before rollout when its run starts after it", async () => {
    const { t, ctx, scheduled } = await production();
    t.team_memberships[0].role = "admin";
    const asked = await ask(ctx);
    await nextCore(ctx, WS, "production");
    const d = t.deploys.find((x) => x.short_id === asked.short_id);
    await (settle as any)._handler(ctx, { deploy: d._id, outcome: "sent" });
    await (pausePause as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, reason: "errors" });
    scheduled.length = 0;
    expect(await recordWorkflowRunDeploy(ctx, runPayload({}))).toEqual([asked.short_id]);
    expect(d).toMatchObject({ status: "running", workflow_run: "90" });
    expect(scheduled.find((c) => c.args?.deploy === d._id)?.args).toEqual({ deploy: d._id, by: "Ana", why: "production paused: errors" });
  });

  test("a deploy whose webhooks went quiet is read from GitHub, and its finished run frees the queue", async () => {
    const { t, ctx, scheduled } = await production();
    const asked = await ask(ctx);
    await nextCore(ctx, WS, "production");
    const d = t.deploys.find((x) => x.short_id === asked.short_id);
    await (settle as any)._handler(ctx, { deploy: d._id, outcome: "sent" });
    await recordWorkflowRunDeploy(ctx, runPayload({}));
    expect(d.status).toBe("running");
    scheduled.length = 0;
    expect((await sweepCore(ctx, d.updated_at + 60_000)).read).toEqual([]);
    expect((await sweepCore(ctx, d.updated_at + 6 * 60_000)).read).toEqual([asked.short_id]);
    expect(scheduled.some((c) => c.args?.deploy === d._id && !("by" in c.args))).toBe(true);
    // The reader asks GitHub for the run and records what it says as the webhook would have.
    const realFetch = globalThis.fetch;
    const recorded: any[] = [];
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/runs/90") ? runPayload({ status: "completed", conclusion: "success" }).workflow_run : { default_branch: "main" }), { status: 200 })) as any;
    const actx = {
      runQuery: async (_fn: any, args: any) => ("deploy" in args ? { repository: REPO, team_id: TEAM, workflow: "deploy.yml", run: "90", sha: sha(2), since: NOW } : { installation_id: 9 }),
      runAction: async () => ({ token: "t" }),
      runMutation: async (_fn: any, args: any) => { recorded.push(args); },
    };
    try {
      expect(await (readRun as any)._handler(actx, { deploy: d._id })).toBe("completed success");
    } finally {
      globalThis.fetch = realFetch;
    }
    await (recordRun as any)._handler(ctx, recorded[0]);
    expect(d.status).toBe("live");
  });

  test("the send dispatches the workflow on the default branch with the exact sha, only when GitHub has no run going", async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    let going = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (String(url).includes("/runs?status=")) return new Response(JSON.stringify({ total_count: String(url).includes("status=in_progress") ? going : 0 }), { status: 200 });
      if (String(url).endsWith("/dispatches")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }) as any;
    const settled: any[] = [];
    let mayGo = true;
    const actx = {
      runQuery: async (_fn: any, args: any) => ("deploy" in args ? { repository: REPO, team_id: TEAM, workflow: "deploy.yml", inputs: { sha: sha(2), actor: "Ana" } } : { installation_id: 9 }),
      runAction: async () => ({ token: "t", permissions: { actions: "write" } }),
      // settle records its outcome; mayDispatch is the pause read last, before the dispatch.
      runMutation: async (_fn: any, args: any) => ("outcome" in args ? void settled.push(args) : mayGo),
    };
    try {
      going = 1;
      expect(await (send as any)._handler(actx, { deploy: "d1" })).toBe("a run is in_progress");
      expect(settled.at(-1)).toMatchObject({ outcome: "busy" });
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      going = 0;
      // A pause that came since the claim: nothing is dispatched.
      mayGo = false;
      expect(await (send as any)._handler(actx, { deploy: "d1" })).toBe("paused");
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      mayGo = true;
      expect(await (send as any)._handler(actx, { deploy: "d1" })).toBe("sent");
      const post = calls.find((c) => c.method === "POST")!;
      expect(post.url).toBe(`https://api.github.com/repos/${REPO}/actions/workflows/deploy.yml/dispatches`);
      expect(post.body).toEqual({ ref: "main", inputs: { sha: sha(2), actor: "Ana" } });
      expect(settled.at(-1)).toMatchObject({ outcome: "sent" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("rolling production back (DP19)", () => {
  const PROD = { name: "production", command: "./deploy.sh --sha $sha", runs: "here", live: { kind: "marker" }, policy: "press", paths: [], workflow: "deploy.yml", rollback_inputs: { components: "backend-web" }, ci_workflow: "ci.yml" };
  const CAPTAIN = { _id: "role_rc", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Release Captain", handle: "release", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", authority: [{ id: "production-pause", kind: "write", label: "Pause", granted_by: ME, granted_at: 1 }] };

  async function rolledBack(files2: string[]) {
    const t = await seed();
    t.team_memberships[0].role = "admin";
    t.org_roles.push(CAPTAIN);
    const ctx = ctxFor(t);
    await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: [PROD] });
    await pushMain(t, ctx, [{ n: 1, files: ["api/a.ts"] }, { n: 2, files: files2 }], NOW - 60_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(1), repository: REPO, source: "m", at: NOW - 50_000 });
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: sha(2), repository: REPO, source: "m", at: NOW - 40_000 });
    const r = await (rollback as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, reason: "checkout broken" });
    return { t, ctx, r };
  }
  const ci = (t: Record<string, any[]>, n: number, status: string, conclusion?: string) =>
    t.commit_ci.push({ _id: `ci_${n}_${t.commit_ci.length}`, workspace: WS, team_id: TEAM, repository: REPO, sha: sha(n), name: "CI", kind: "workflow", path: ".github/workflows/ci.yml", run_id: `r${t.commit_ci.length}`, status, ...(conclusion ? { conclusion } : {}), started_at: NOW + t.commit_ci.length, updated_at: NOW });

  test("a rollback pauses production first and files the revert of what it took off to the Release Captain", async () => {
    const { t, ctx, r } = await rolledBack(["api/b.ts"]);
    expect(r).toMatchObject({ ending: "revert", commits: 1, migrations: [] });
    const task = t.tasks.find((x) => x.short_id === r.task);
    expect(task.title).toBe(`Revert what rollback ${r.deploy} took off production`);
    expect(task.description).toContain(`${sha(2).slice(0, 10)} change 2`);
    expect(String(task.assignee)).toBe("role_rc");
    expect(t.deploy_pauses[0]).toMatchObject({ rollback: r.deploy, until: { kind: "revert", shas: [sha(2)] }, by: { kind: "person", name: "Ana" } });
    await expect((request as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, target: "production" })).rejects.toThrow(/Production is paused by Ana: Rollback/);
  });

  test("a range holding a migration is ended by a fix forward, never a revert", async () => {
    const { t, r } = await rolledBack(["api/b.ts", "backend/drizzle/0007_add_col.sql"]);
    expect(r).toMatchObject({ ending: "fix_forward", migrations: ["backend/drizzle/0007_add_col.sql"] });
    expect(t.tasks.find((x) => x.short_id === r.task).title).toBe(`Fix forward what rollback ${r.deploy} took off production`);
  });

  test("the pause lifts itself once the commit naming its task is green on main, not when it merges", async () => {
    const { t, ctx, r } = await rolledBack(["api/b.ts"]);
    const taskId = t.tasks.find((x) => x.short_id === r.task)._id;
    await pushMain(t, ctx, [{ n: 3, files: ["api/b.ts"], tasks: [taskId] }], NOW + 1_000);
    expect(await liftEndedPauses(ctx, REPO)).toEqual([]);
    ci(t, 3, "in_progress");
    expect(await liftEndedPauses(ctx, REPO)).toEqual([]);
    ci(t, 3, "completed", "failure");
    expect(await liftEndedPauses(ctx, REPO)).toEqual([]);
    ci(t, 3, "completed", "success");
    expect(await liftEndedPauses(ctx, REPO)).toEqual([REPO]);
    expect(t.deploy_pauses[0]).toMatchObject({ lifted_by: "green on main", lifted_on: sha(3) });
  });

  test("a range codecast could not read whole is never a safe revert, and an ending commit past what it reads is not silently missed", async () => {
    const t = await seed();
    t.team_memberships[0].role = "admin";
    t.org_roles.push(CAPTAIN);
    const ctx = ctxFor(t);
    await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: [PROD] });
    const hex = (n: number) => n.toString(16).padStart(40, "a");
    const rows = Array.from({ length: 1503 }, (_, i) => ({ _id: `c_${i}`, sha: hex(i), message: `change ${i}`, author_name: "Ana", author_email: "a@x", timestamp: NOW, files_changed: 1, insertions: 0, deletions: 0, repository: REPO, team_id: TEAM, branch: "main", files: [{ filename: "api/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }] }));
    t.commits.push(...rows);
    await stampMainOrder(ctx, rows.map((r) => r._id as any), NOW - 3_600_000);
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: hex(0), repository: REPO, source: "m", at: NOW - 50_000 });
    await recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target: "production", sha: hex(1502), repository: REPO, source: "m", at: NOW - 40_000 });
    const r = await (rollback as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, reason: "broken" });
    expect(r).toMatchObject({ ending: "fix_forward", migrations: [] });
    // Its task's commit landed right after the rollback, then more than codecast reads at once landed after it.
    const p = t.deploy_pauses[0];
    p.until = { ...p.until, from_sha: hex(0) };
    rows[1].task_ids = [t.tasks.find((x) => x.short_id === r.task)._id];
    expect(await endingOf(ctx, p)).toBe("unreadable");
    expect(await liftEndedPauses(ctx, REPO)).toEqual([]);
    expect(p.lifted_at).toBeUndefined();
  });

  test("a standing pause reminds whoever lifts it only inside the team's working hours", async () => {
    const { t, ctx } = await rolledBack(["api/b.ts"]);
    t.teams[0].timezone = "America/Los_Angeles";
    const saturdayNoon = Date.parse("2026-11-28T20:00:00Z");
    const wednesdayNight = Date.parse("2026-11-25T07:00:00Z");
    t.deploy_pauses[0].created_at = wednesdayNight - 5 * 3_600_000;
    expect(await remindCore(ctx, saturdayNoon)).toBe(0);
    expect(await remindCore(ctx, wednesdayNight)).toBe(0);
    expect(t.deploy_pauses[0].reminded_at).toBeUndefined();
    const wednesdayMorning = Date.parse("2026-11-25T18:00:00Z");
    expect(await remindCore(ctx, wednesdayMorning)).toBe(1);
    expect(t.deploy_pauses[0].reminded_at).toBe(wednesdayMorning);
    expect(await remindCore(ctx, wednesdayMorning + 3_600_000)).toBe(0);
  });
});
