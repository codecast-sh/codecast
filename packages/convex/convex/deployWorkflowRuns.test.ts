import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish, request } from "./deployTargets";
import { stampMainOrder, workflowRunDeploy } from "./deployTargetsCi";
import { get as getDeploy, recordDeployMarker } from "./deploys";
import { processWorkflowRunEvent } from "./githubWebhooks";

// A target's deploy workflow (deploys.md DP11): every run of the file a
// target's `workflow` names, on the default branch, is that target's deploy,
// whoever dispatched it. Synthetic data only.

const TEAM = "team_1" as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_workflow_token";
const REPO = "acme/app";
const NOW = Date.now();

/** A 40-character sha with letters in it, so a run name's short prefix reads as one. */
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}ab`.repeat(10);
const HEAD = sha(9);

async function seed() {
  return {
    users: [{ _id: ME, name: "Ana" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [{ _id: "dev_row", user_id: ME, device_id: "ana-mac" }],
    github_app_installations: [],
    github_webhook_events: [] as any[],
    github_check_suites: [] as any[],
    repo_sources: [{ _id: "rs1", repository: REPO, team_id: TEAM }],
    conversations: [],
    tasks: [],
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
    pull_requests: [],
  } as Record<string, any[]>;
}

const ctxFor = (tables: Record<string, any[]>) =>
  ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } }) as any;

const TARGETS = [
  { name: "web", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["web/**"], workflow: "deploy.yml" },
  { name: "api", command: "gh workflow run api.yml", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["api/**"], workflow: "api.yml" },
];

async function world(targets: any[] = TARGETS) {
  const t = await seed();
  const ctx = ctxFor(t);
  await (publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets, device_id: "ana-mac", root: "/repo" });
  // Main knows sha(1)..sha(3) and the head.
  for (const [i, n] of [1, 2, 3, 9].entries()) {
    t.commits.push({ _id: `commit_${n}`, sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: NOW - 10_000, files_changed: 1, insertions: 0, deletions: 0, repository: REPO, team_id: TEAM, branch: "main", files: [{ filename: "web/a.tsx", status: "modified", additions: 1, deletions: 0, changes: 1 }] });
    await stampMainOrder(ctx, [`commit_${n}` as any], NOW - 10_000 + i);
  }
  let delivery = 0;
  const deliver = async (payload: any) => {
    delivery += 1;
    const event_id = await ctx.db.insert("github_webhook_events", { delivery_id: `d${delivery}`, event_type: "workflow_run", action: payload.action, payload: JSON.stringify(payload), processed: false, created_at: 0 });
    return await (processWorkflowRunEvent as any)._handler(ctx, { event_id });
  };
  const dp = (short: string) => t.deploys.find((d) => d.short_id === short);
  return { t, ctx, deliver, dp };
}

let runId = 4000;
const nextRun = () => ++runId;

/** A workflow_run delivery as GitHub sends it: a dispatched Deploy on main, its run name naming the sha. */
function workflowRun(id: number, over: Record<string, any> = {}, repo: Record<string, any> = {}) {
  const status = over.status ?? "in_progress";
  return {
    action: status === "completed" ? "completed" : status === "queued" ? "requested" : "in_progress",
    repository: { full_name: "Acme/App", default_branch: "main", ...repo },
    workflow: { name: "Deploy", path: ".github/workflows/deploy.yml" },
    sender: { login: "samvit" },
    workflow_run: {
      id,
      name: "Deploy",
      display_title: `Deploy ${sha(1).slice(0, 10)} for Samvit`,
      path: ".github/workflows/deploy.yml",
      event: "workflow_dispatch",
      check_suite_id: id + 9000,
      head_branch: "main",
      head_sha: HEAD,
      head_repository: { full_name: "acme/app" },
      status,
      conclusion: null,
      run_attempt: 1,
      html_url: `https://github.com/acme/app/actions/runs/${id}`,
      run_started_at: new Date(NOW - 1_000).toISOString(),
      created_at: new Date(NOW - 2_000).toISOString(),
      triggering_actor: { login: "samvit" },
      pull_requests: [],
      ...over,
    },
  };
}
const done = (id: number, conclusion: string, over: Record<string, any> = {}) => workflowRun(id, { status: "completed", conclusion, ...over });

describe("a run of a target's deploy workflow is its deploy", () => {
  test("in progress: a running deploy with the run's url and the sha its name names, from a short prefix", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(workflowRun(id));
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp("dp-1")).toMatchObject({
      target: "web",
      status: "running",
      sha: sha(1),
      repository: REPO,
      url: `https://github.com/acme/app/actions/runs/${id}`,
      source: "github: Deploy",
      started_by: { kind: "source", name: "samvit" },
      workspace: WS,
    });
    expect(w.dp("dp-1").finished_at).toBeUndefined();
  });

  test("completed success: the same deploy goes live, cut at its sha's place on main", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(workflowRun(id));
    await w.deliver(done(id, "success"));
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp("dp-1")).toMatchObject({ status: "live", sha: sha(1), live_at: expect.any(Number), finished_at: expect.any(Number) });
    expect(w.dp("dp-1").cut_at).toBe(w.t.commits.find((c) => c.sha === sha(1)).main_at);
  });

  test("failure: the deploy fails with a note naming how the run ended", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(workflowRun(id));
    await w.deliver(done(id, "timed_out"));
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp("dp-1")).toMatchObject({ status: "failed", note: "Deploy run ended timed_out." });
    // A redelivery of the same failure changes nothing.
    await w.deliver(done(id, "timed_out"));
    expect(w.t.deploys).toHaveLength(1);
  });

  test("each conclusion maps to a deploy status", () => {
    const status = (s: string, conclusion: string | null) => workflowRunDeploy(workflowRun(1, { status: s, conclusion }))!.status;
    for (const s of ["queued", "in_progress", "waiting", "requested", "pending"]) expect([s, status(s, null)]).toEqual([s, "running"]);
    expect(status("completed", "success")).toBe("live");
    for (const c of ["failure", "timed_out", "startup_failure", "action_required"]) expect([c, status("completed", c)]).toEqual([c, "failed"]);
    for (const c of ["cancelled", "skipped", "stale", "neutral"]) expect([c, status("completed", c)]).toEqual([c, "cancelled"]);
  });

  test("the pure reader keeps the run's head and the sha its name names apart; the recorder picks between them", () => {
    const r = workflowRunDeploy(workflowRun(77, { display_title: `Deploy ${sha(1).slice(0, 10).toUpperCase()} for Samvit` }))!;
    expect(r).toMatchObject({ repository: REPO, workflow: "deploy.yml", run: "77", head_sha: HEAD, named_shas: [sha(1).slice(0, 10)], status: "running", name: "Deploy", actor: "samvit" });
    expect(workflowRunDeploy(workflowRun(77, { display_title: "Deploy" }))!.named_shas).toEqual([]);
    expect(workflowRunDeploy(workflowRun(77, { run_attempt: 3 }))).toMatchObject({ run: "77/attempts/3", url: "https://github.com/acme/app/actions/runs/77/attempts/3" });
  });

  test("cancelled: the deploy is cancelled, never live", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(workflowRun(id));
    await w.deliver(done(id, "cancelled"));
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp("dp-1")).toMatchObject({ status: "cancelled", finished_at: expect.any(Number) });
    expect(w.dp("dp-1").live_at).toBeUndefined();
  });

  test("a second run of another sha queued while the first runs is its own deploy; the first's end leaves it alone", async () => {
    const w = await world();
    const a = nextRun();
    const b = nextRun();
    await w.deliver(workflowRun(a));
    await w.deliver(workflowRun(b, { status: "queued", display_title: `Deploy ${sha(2).slice(0, 10)} for Ana` }));
    expect(w.t.deploys.map((d) => [d.short_id, d.status, d.sha])).toEqual([["dp-1", "running", sha(1)], ["dp-2", "running", sha(2)]]);
    expect(w.dp("dp-2").url).toBe(`https://github.com/acme/app/actions/runs/${b}`);
    await w.deliver(done(a, "success"));
    expect(w.dp("dp-1").status).toBe("live");
    expect(w.dp("dp-2")).toMatchObject({ status: "running", sha: sha(2), url: `https://github.com/acme/app/actions/runs/${b}` });
    await w.deliver(done(b, "success", { display_title: `Deploy ${sha(2).slice(0, 10)} for Ana` }));
    expect(w.t.deploys.map((d) => [d.short_id, d.status])).toEqual([["dp-1", "live"], ["dp-2", "live"]]);
  });

  test("two runs of one sha are two deploys", async () => {
    const w = await world();
    const a = nextRun();
    const b = nextRun();
    await w.deliver(done(a, "success"));
    await w.deliver(workflowRun(b));
    expect(w.t.deploys.map((d) => [d.short_id, d.status, d.sha])).toEqual([["dp-1", "live", sha(1)], ["dp-2", "running", sha(1)]]);
  });

  test("a rerun (attempt 2) is a deploy of its own, its url naming the attempt", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(workflowRun(id));
    await w.deliver(done(id, "failure"));
    await w.deliver(workflowRun(id, { run_attempt: 2 }));
    expect(w.t.deploys).toHaveLength(2);
    expect(w.dp("dp-2")).toMatchObject({ status: "running", sha: sha(1), url: `https://github.com/acme/app/actions/runs/${id}/attempts/2` });
    await w.deliver(done(id, "success", { run_attempt: 2 }));
    expect(w.t.deploys.map((d) => [d.short_id, d.status])).toEqual([["dp-1", "failed"], ["dp-2", "live"]]);
  });

  test("a completion delivered before its start leaves the deploy live", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(done(id, "success"));
    await w.deliver(workflowRun(id));
    expect(w.t.deploys.map((d) => [d.short_id, d.status])).toEqual([["dp-1", "live"]]);
  });

  test("a run off the default branch, of another workflow file, of a pull request from a fork's main, or in another repository is no deploy", async () => {
    const w = await world();
    await w.deliver(workflowRun(nextRun(), { head_branch: "feature" }));
    await w.deliver(workflowRun(nextRun(), { path: ".github/workflows/ci.yml", name: "CI" }));
    await w.deliver(workflowRun(nextRun(), { event: "pull_request", head_repository: { full_name: "someone/app" } }));
    await w.deliver(workflowRun(nextRun(), { event: "pull_request" }));
    await w.deliver(workflowRun(nextRun(), { head_repository: { full_name: "acme/other" } }, { full_name: "acme/other" }));
    expect(w.t.deploys).toEqual([]);
    // The api target's own workflow file is the api target's deploy, and only its.
    await w.deliver(workflowRun(nextRun(), { path: ".github/workflows/api.yml" }));
    expect(w.t.deploys.map((d) => [d.target, d.status])).toEqual([["api", "running"]]);
  });

  test("a dispatched run's named commit stands even when main never ingested it; a run name with no hex word ships its head", async () => {
    const w = await world();
    await w.deliver(workflowRun(nextRun(), { display_title: "Deploy cafebabe1 for Samvit" }));
    expect(w.dp("dp-1").sha).toBe("cafebabe1");
    const unknown = "abcdef0123456789abcdef0123456789abcdef01";
    await w.deliver(workflowRun(nextRun(), { display_title: `Deploy ${unknown}` }));
    expect(w.dp("dp-2").sha).toBe(unknown);
    // A run number or a date is not a sha.
    await w.deliver(workflowRun(nextRun(), { display_title: "Deploy #20261120" }));
    expect(w.dp("dp-3").sha).toBe(HEAD);
    // A hex-looking word before the real commit does not hide it.
    await w.deliver(workflowRun(nextRun(), { display_title: `Deploy defaced ${sha(2).slice(0, 10)} for Samvit` }));
    expect(w.dp("dp-4").sha).toBe(sha(2));
  });

  test("a run first heard before its name resolved takes the commit a later delivery names, and its reader's marker is the same deploy", async () => {
    const w = await world();
    const id = nextRun();
    // GitHub's requested delivery can carry the workflow's name before the run-name is filled in.
    await w.deliver(workflowRun(id, { status: "queued", display_title: "Deploy" }));
    expect(w.dp("dp-1").sha).toBe(HEAD);
    await w.deliver(workflowRun(id));
    expect(w.dp("dp-1").sha).toBe(sha(1));
    await w.deliver(done(id, "success"));
    // Production's own reader then reports the version it runs: the run's deploy, not a second one.
    await recordDeployMarker(w.ctx, { workspace: WS, team_id: TEAM, target: "web", sha: sha(1).slice(0, 9), version: sha(1).slice(0, 9), repository: REPO, source: "live reader", at: NOW });
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp("dp-1")).toMatchObject({ status: "live", sha: sha(1) });
  });

  test("a json marker of the same full sha (no run) finishes the running workflow deploy", async () => {
    const w = await world();
    await w.deliver(workflowRun(nextRun()));
    const got = await recordDeployMarker(w.ctx, { workspace: WS, team_id: TEAM, target: "web", sha: sha(1), version: "1.2.0", repository: REPO, source: "live reader", at: NOW });
    expect(got).toBe("dp-1");
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp("dp-1")).toMatchObject({ status: "live", version: "1.2.0", live_at: NOW });
  });

  test("a run of a sha another path recorded live is its own deploy: a rollback shows, and its failure is kept", async () => {
    const w = await world();
    const marker = { workspace: WS, team_id: TEAM, target: "web", repository: REPO, source: "cast ship mark" };
    await recordDeployMarker(w.ctx, { ...marker, sha: sha(1), at: NOW - 5_000 });
    await recordDeployMarker(w.ctx, { ...marker, sha: sha(2), at: NOW - 4_000 });
    // Back to sha(1), by hand: dp-1 is superseded and never this run.
    const back = nextRun();
    await w.deliver(workflowRun(back));
    await w.deliver(done(back, "failure"));
    expect(w.t.deploys.map((d) => [d.short_id, d.status, d.sha, d.url ?? null])).toEqual([
      ["dp-1", "live", sha(1), null],
      ["dp-2", "live", sha(2), null],
      ["dp-3", "failed", sha(1), `https://github.com/acme/app/actions/runs/${back}`],
    ]);
    // A redeploy of the live sha that fails is a failed deploy too, not lost in the live one.
    const again = nextRun();
    await w.deliver(workflowRun(again, { display_title: `Deploy ${sha(2).slice(0, 10)}` }));
    await w.deliver(done(again, "failure", { display_title: `Deploy ${sha(2).slice(0, 10)}` }));
    expect(w.t.deploys.at(-1)).toMatchObject({ short_id: "dp-4", status: "failed", sha: sha(2) });
    expect(w.dp("dp-2").status).toBe("live");
  });

  test("a run's success, first heard after a reader recorded its sha live, is that live deploy", async () => {
    const w = await world();
    await recordDeployMarker(w.ctx, { workspace: WS, team_id: TEAM, target: "web", sha: sha(1), repository: REPO, source: "live reader", at: NOW - 500 });
    const id = nextRun();
    await w.deliver(done(id, "success"));
    expect(w.t.deploys.map((d) => [d.short_id, d.status, d.url])).toEqual([["dp-1", "live", `https://github.com/acme/app/actions/runs/${id}`]]);
  });

  test("an open requested deploy with no url and no sha is adopted by the first run; one asked for at another sha is not", async () => {
    const w = await world();
    const asked = await (request as any)._handler(w.ctx, { api_token: TOKEN, team_id: TEAM, target: "api", here: true });
    expect(w.dp(asked.short_id)).toMatchObject({ status: "requested" });
    expect(w.dp(asked.short_id).url).toBeUndefined();
    expect(w.dp(asked.short_id).sha).toBeUndefined();
    const id = nextRun();
    await w.deliver(workflowRun(id, { path: ".github/workflows/api.yml" }));
    expect(w.t.deploys).toHaveLength(1);
    expect(w.dp(asked.short_id)).toMatchObject({ status: "running", sha: sha(1), url: `https://github.com/acme/app/actions/runs/${id}` });
    await w.deliver(done(id, "success", { path: ".github/workflows/api.yml" }));
    expect(w.dp(asked.short_id).status).toBe("live");

    // A second ask, its sha fixed at sha(2): a run shipping sha(3) is a deploy of its own.
    const again = await (request as any)._handler(w.ctx, { api_token: TOKEN, team_id: TEAM, target: "api", here: true });
    w.dp(again.short_id).sha = sha(2);
    await w.deliver(workflowRun(nextRun(), { path: ".github/workflows/api.yml", display_title: `Deploy ${sha(3).slice(0, 10)}` }));
    expect(w.dp(again.short_id)).toMatchObject({ status: "requested", sha: sha(2) });
    expect(w.t.deploys.at(-1)).toMatchObject({ target: "api", status: "running", sha: sha(3) });
  });

  test("a push run's title is a commit subject, never a named commit: the run ships its head", async () => {
    const w = await world();
    await w.deliver(workflowRun(nextRun(), { event: "push", display_title: `fix: green CI after ${sha(2).slice(0, 9)}` }));
    expect(w.dp("dp-1").sha).toBe(HEAD);
  });

  test("a run first heard when it finished keeps when it started", async () => {
    const w = await world();
    const startedAt = NOW - 52 * 60_000;
    await w.deliver(done(nextRun(), "failure", { run_started_at: new Date(startedAt).toISOString(), updated_at: new Date(NOW).toISOString() }));
    expect(w.dp("dp-1")).toMatchObject({ status: "failed", created_at: startedAt, finished_at: NOW });
  });

  test("two targets cannot name one workflow: a run of it is one deploy of one target", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    const both = [
      { name: "web", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["web/**"], workflow: "deploy.yml" },
      { name: "api", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["api/**"], workflow: "deploy.yml" },
    ];
    await expect((publish as any)._handler(ctx, { api_token: TOKEN, team_id: TEAM, repository: REPO, targets: both, device_id: "ana-mac", root: "/repo" })).rejects.toThrow(/named by another target/);
  });

  test("deploys.get finds a deploy by the url of the run that carried it, any attempt or job page", async () => {
    const w = await world();
    const id = nextRun();
    await w.deliver(workflowRun(id));
    await w.deliver(workflowRun(id, { run_attempt: 2 }));
    const get = (ref: string) => (getDeploy as any)._handler(w.ctx, { ref, api_token: TOKEN });
    expect((await get(`https://github.com/acme/app/actions/runs/${id}`))?.short_id).toBe("dp-1");
    expect((await get(`https://github.com/Acme/App/actions/runs/${id}/attempts/1`))?.short_id).toBe("dp-1");
    expect((await get(`https://github.com/acme/app/actions/runs/${id}/job/77`))?.short_id).toBe("dp-1");
    expect((await get(`https://github.com/acme/app/actions/runs/${id}/attempts/2`))?.short_id).toBe("dp-2");
    expect(await get(`https://github.com/acme/app/actions/runs/1`)).toBeNull();
    expect(await get(`https://github.com/acme/other/actions/runs/${id}`)).toBeNull();
  });
});
