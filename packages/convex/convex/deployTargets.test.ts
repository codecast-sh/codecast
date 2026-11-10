import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish, recordLiveRead, recordShipPass, reportMainCommits, request, view } from "./deployTargets";
import { checkSuiteCi, recordCommitCi, recordGithubDeployStatus, stampMainOrder, statusEventOf, workflowRunCi } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { liveReaderUrlRefusal } from "./lib/liveReaderUrl";

// A repository's deploy targets (docs/architecture/deploys.md DP10 to DP14):
// published from the checkout, live from whichever path recorded it, the
// commits on main after the live sha waiting by session with CI, and a deploy
// of any target asked for from codecast. Synthetic data only.

const TEAM = "team_1" as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_targets_token";
const REPO = "acme/app";
const NOW = Date.now();

const sha = (n: number) => String(n).padStart(2, "0").repeat(20);

async function seed() {
  return {
    users: [{ _id: ME, name: "Ana" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
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
    expect(backend.queue.groups[0].session).toEqual({ conversation_id: "conv_api_work", short_id: "conv_ap", title: "Fix the totals" });
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
