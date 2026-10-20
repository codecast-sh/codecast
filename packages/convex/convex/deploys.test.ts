import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { backfill, recordDeployMarker, report, request, stage } from "./deploys";

// Deploys as objects (docs/architecture/deploys.md): a marker records or
// finishes a deploy, the line's stage sends what waits, and every deploy
// names the fixes it carried. Synthetic data only.

const TEAM = "team_1" as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const TOKEN = "cast_deploy_token";
const PROJECT = "proj_1";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

async function seed(extra: Record<string, any[]> = {}) {
  return {
    users: [{ _id: ME, name: "Ana" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [{ _id: "dev_row", user_id: ME, device_id: "ana-mac" }],
    projects: [{
      _id: PROJECT, short_id: "pj-1", title: "Checkout", user_id: ME, team_id: TEAM, workspace: WS,
      line_profile: { finders: [], changed_at: 1, root: "/repo", device_id: "ana-mac", deploy: { command: "./deploy.sh", target: "production", trigger: "person" } },
    }],
    tasks: [
      { _id: "task_a", short_id: "ct-1", title: "Totals round wrong", user_id: ME, team_id: TEAM, workspace: WS, project_id: PROJECT, status: "done" },
      { _id: "task_b", short_id: "ct-2", title: "Coupon ignored", user_id: ME, team_id: TEAM, workspace: WS, project_id: PROJECT, status: "done" },
    ],
    workflow_runs: [
      { _id: "run_a", workspace: WS, task_id: "task_a", status: "completed", gate_decision_id: "dec_a", updated_at: NOW - 2 * DAY, created_at: NOW - 3 * DAY, merge: { sha: "aaaaaaa1111", branch: "fix/a", into: "main", at: NOW - 2 * DAY } },
      { _id: "run_b", workspace: WS, task_id: "task_b", status: "completed", updated_at: NOW - DAY, created_at: NOW - 2 * DAY, merge: { sha: "bbbbbbb2222", branch: "fix/b", into: "main", at: NOW - DAY } },
    ],
    session_decisions: [{ _id: "dec_a", short_id: "sd-9", status: "answered" }],
    deploys: [],
    external_events: [],
    event_sources: [],
    event_groups: [],
    signals: [],
    counters: [],
    daemon_commands: [],
    ...extra,
  } as Record<string, any[]>;
}

const ctxFor = (tables: Record<string, any[]>) =>
  ({ db: makeFakeDb(tables), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } }) as any;

const marker = (over: Record<string, any> = {}) => ({ workspace: WS, team_id: TEAM, target: "production", sha: "ccccccc3333", source: "acme-api", at: NOW - 60_000, ...over });

describe("deploy markers (DP1)", () => {
  test("a marker nobody asked for records a live deploy carrying the fixes merged before it", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    const id = await recordDeployMarker(ctx, marker());
    expect(id).toBe("dp-1");
    const d = t.deploys[0];
    expect(d).toMatchObject({ status: "live", trigger: "outside", target: "production", workspace: WS });
    expect(d.carries.map((c: any) => [c.task_id, c.how, c.decision_id])).toEqual([
      ["task_a", "deployed after the merge", "dec_a"],
      ["task_b", "deployed after the merge", undefined],
    ]);
  });

  test("the same version reported twice is one deploy, and the second report adds what it knows", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await recordDeployMarker(ctx, marker());
    const again = await recordDeployMarker(ctx, marker({ url: "https://github.com/acme/app/actions/runs/7", commits: [{ sha: "ccccccc3333", subject: "fix totals" }] }));
    expect(again).toBe("dp-1");
    expect(t.deploys).toHaveLength(1);
    expect(t.deploys[0].url).toBe("https://github.com/acme/app/actions/runs/7");
    expect(t.deploys[0].commits).toHaveLength(1);
  });

  test("a later deploy does not carry what an earlier one already put live", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await recordDeployMarker(ctx, marker());
    await recordDeployMarker(ctx, marker({ sha: "ddddddd4444", at: NOW - 30_000 }));
    expect(t.deploys[1].carries).toEqual([]);
  });

  test("a laptop's boot is no deploy", async () => {
    const t = await seed();
    expect(await recordDeployMarker(ctxFor(t), marker({ target: "local" }))).toBeNull();
    expect(t.deploys).toHaveLength(0);
  });
});

describe("a fix that landed outside a run's merge step", () => {
  test("a problem's landed commit is a merge the next deploy carries", async () => {
    const t = await seed();
    t.workflow_runs = [];
    t.tasks[0].landed = { sha: "1111111aaaa", at: NOW - DAY, url: "https://github.com/acme/app/commit/1111111", repository: "acme/app", branch: "main" };
    const ctx = ctxFor(t);
    await recordDeployMarker(ctx, marker());
    expect(t.deploys[0].carries).toEqual([expect.objectContaining({ task_id: "task_a", how: "deployed after the merge", merge_sha: "1111111aaaa" })]);
    expect(t.deploys[0].carries[0]).not.toHaveProperty("run_id");
  });
});

describe("the line's deploy stage (DP2)", () => {
  test("the stage lists the shipped fixes no live deploy carried", async () => {
    const t = await seed();
    const s = await (stage as any)._handler(ctxFor(t), { project_id: "pj-1", api_token: TOKEN });
    expect(s.waiting.map((w: any) => w.task_short_id)).toEqual(["ct-1", "ct-2"]);
    expect(s.deploy.command).toBe("./deploy.sh");
  });

  test("Deploy asks for one deploy sending every waiting fix, queues it on the publishing machine, and refuses a second", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    const r = await (request as any)._handler(ctx, { project_id: PROJECT, api_token: TOKEN });
    expect(r).toMatchObject({ short_id: "dp-1", carries: 2 });
    expect(t.deploys[0]).toMatchObject({ status: "requested", trigger: "person", target: "production", project_id: PROJECT });
    expect(t.deploys[0].carries.every((c: any) => c.how === "sent")).toBe(true);
    expect(t.daemon_commands[0]).toMatchObject({ command: "line_deploy", target_device_id: "ana-mac" });
    expect(JSON.parse(t.daemon_commands[0].args)).toEqual({ deploy: "dp-1", root: "/repo" });
    await expect((request as any)._handler(ctx, { project_id: PROJECT, api_token: TOKEN })).rejects.toThrow("dp-1 is already going out");
  });

  test("the team's marker finishes the line's deploy, and the stage is empty after", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await (request as any)._handler(ctx, { project_id: PROJECT, api_token: TOKEN, here: true });
    await (report as any)._handler(ctx, { api_token: TOKEN, deploy: "dp-1", status: "running", url: "https://ci/run/1" });
    const id = await recordDeployMarker(ctx, marker({ sha: "eeeeeee5555", at: NOW }));
    expect(id).toBe("dp-1");
    expect(t.deploys).toHaveLength(1);
    expect(t.deploys[0]).toMatchObject({ status: "live", sha: "eeeeeee5555", url: "https://ci/run/1" });
    const s = await (stage as any)._handler(ctx, { project_id: PROJECT, api_token: TOKEN });
    expect(s.waiting).toEqual([]);
    expect(s.open).toBeNull();
  });

  test("a report never moves a deploy backwards, and a failure keeps its fixes waiting", async () => {
    const t = await seed();
    const ctx = ctxFor(t);
    await (request as any)._handler(ctx, { project_id: PROJECT, api_token: TOKEN, here: true });
    await (report as any)._handler(ctx, { api_token: TOKEN, deploy: "dp-1", status: "failed", note: "exited 1" });
    await (report as any)._handler(ctx, { api_token: TOKEN, deploy: "dp-1", status: "live" });
    expect(t.deploys[0].status).toBe("failed");
    const s = await (stage as any)._handler(ctx, { project_id: PROJECT, api_token: TOKEN });
    expect(s.waiting).toHaveLength(2);
  });

  test("one deploy ships one checkout: a fix in another project on the same root waits on it too", async () => {
    const t = await seed();
    t.projects.push({ _id: "proj_2", short_id: "pj-2", title: "Calls", user_id: ME, team_id: TEAM, workspace: WS, line_profile: { finders: [], changed_at: 1, root: "/repo" } });
    t.tasks[1].project_id = "proj_2";
    const s = await (stage as any)._handler(ctxFor(t), { project_id: "pj-1", api_token: TOKEN });
    expect(s.waiting.map((w: any) => w.task_short_id)).toEqual(["ct-1", "ct-2"]);
    t.projects[1].line_profile.root = "/elsewhere";
    const narrower = await (stage as any)._handler(ctxFor(t), { project_id: "pj-1", api_token: TOKEN });
    expect(narrower.waiting.map((w: any) => w.task_short_id)).toEqual(["ct-1"]);
  });

  test("with no deploy path in the profile, nothing is asked for", async () => {
    const t = await seed();
    t.projects[0].line_profile.deploy = { command: null, target: null, trigger: "person" };
    await expect((request as any)._handler(ctxFor(t), { project_id: PROJECT, api_token: TOKEN })).rejects.toThrow("no deploy stage");
  });
});

describe("backfill (DP6)", () => {
  test("every marker becomes a deploy once, oldest first, and a rerun skips them", async () => {
    const t = await seed({
      event_sources: [{ _id: "src_1", name: "acme-api", workspace: WS, team_id: TEAM, project_id: PROJECT }],
      external_events: [
        { _id: "ev_1", source_id: "src_1", kind: "deploy", workspace: WS, team_id: TEAM, title: "Deployed x", sha: "ccccccc3333", data: { source_name: "acme-api", environment: "production", release: "ccccccc3333" }, created_at: NOW - 12 * 3600_000, dedupe_key: "k1" },
        { _id: "ev_2", source_id: "src_1", kind: "deploy", workspace: WS, team_id: TEAM, title: "Deployed y", sha: "fffffff6666", data: { source_name: "acme-api", environment: "local", release: "fffffff6666" }, created_at: NOW - 6 * 3600_000, dedupe_key: "k2" },
      ],
    });
    const ctx = ctxFor(t);
    const first = await (backfill as any)._handler(ctx, { source_id: "src_1" });
    expect(first).toMatchObject({ markers: 2, recorded: 1, not_live: 1 });
    expect(t.external_events[0].meta.deploy).toBe("dp-1");
    expect(t.deploys[0]).toMatchObject({ source: "acme-api", target: "production" });
    // A deploy ships the code, not the source's project: it belongs to the workspace.
    expect(t.deploys[0].project_id).toBeUndefined();
    const second = await (backfill as any)._handler(ctx, { source_id: "src_1" });
    expect(second).toMatchObject({ recorded: 0, skipped: 1 });
  });
});

describe("the Changes page reads the deploy behind a marker", () => {
  test("a deploy marker's ship names its deploy object, so the live strip opens it", async () => {
    const { shipOf } = await import("./changes");
    expect(shipOf({ kind: "deploy", sha: "abc1234", created_at: 1, meta: { surface: "backend", deploy: "dp-7" } } as any)).toMatchObject({ surface: "backend", deploy: "dp-7" });
    expect(shipOf({ kind: "deploy", sha: "abc1234", created_at: 1, meta: { surface: "backend" } } as any)).not.toHaveProperty("deploy");
  });
});
