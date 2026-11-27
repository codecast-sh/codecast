// Deploys in a personal workspace (deploys.md DP11): a repository none of the caller's teams works on records into
// `user:<id>`, the Deploys page's reads take that workspace, and a personal flow run's end records its deploy
// (lib/runDeploy.ts), once, as its backfill does. Synthetic data only; run under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { findDeployWorkspace } from "./changesDeploy";
import { recordRunDeploy, runDeployEnd, runDeploySha } from "./lib/runDeploy";

const api = anyApi as any;
const internal = anyApi as any;
const NOW = Date.now();
const MINE = "pia/garden";
const TEAMS = "acme/app";
const SHA = "a".repeat(40);
const LANDED = "b".repeat(40);

/** The stations of a real ship-now run (sit, ct-92246): ship__ship deployed, then codecast's own wait failed. */
const SHIP_NOW_SHA = "669d33be";
const shipNowStations = (wait: "failed" | "completed" = "failed") => [
  { node_id: "review__changes", status: "failed", outcome: "failure", completed_at: NOW - 900, result_preview: '{"exit": "changes"}' },
  { node_id: "ship", status: "completed", outcome: "success", completed_at: NOW - 800 },
  { node_id: "ship__rebase", status: "completed", outcome: "success", completed_at: NOW - 700, result_preview: '{"rebased": true, "landed": false, "why": "on origin/main at 669d33be"}' },
  { node_id: "ship__ship", status: "completed", outcome: "success", completed_at: NOW - 600, result_preview:
    "2026-11-11T10:40:29-08:00 [/opt/sit] rebased onto origin/main (4 new commit(s))\n2026-11-11T10:40:32-08:00 [/opt/sit] post-deploy OK: cd /opt/sit && sudo systemctl restart sit\nactive\n669d33be Ask a routine's view again once a sit is begun (ct-92246)\n/sit 200" },
  { node_id: "ship__shipped", status: "completed", outcome: "success", completed_at: NOW - 500, result_preview: '{"exit": "shipped"}' },
  { node_id: "deploy", status: "completed", outcome: "success", completed_at: NOW - 400 },
  wait === "failed"
    ? { node_id: "deploy__wait", status: "failed", outcome: "failure", completed_at: NOW - 300, result_preview: "Error: Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second." }
    : { node_id: "deploy__wait", status: "completed", outcome: "success", completed_at: NOW - 300, result_preview: "669d33be12 is on main; no deploy target ships these files, so nothing waits on a deploy." },
  ...(wait === "failed" ? [{ node_id: "deploy__failed", status: "failed", completed_at: NOW - 200 }] : [{ node_id: "deploy__live", status: "completed", completed_at: NOW - 200, result_preview: '{"exit": "live"}' }, { node_id: "exit", status: "completed", completed_at: NOW - 100 }]),
];

async function setup() {
  const t = convexTest(schema, allModules);
  const tokens = { pia: "personal-deploys-pia", ana: "personal-deploys-ana" };
  const ids = await t.run(async (ctx) => {
    const pia = await ctx.db.insert("users", { name: "Pia" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: NOW } as any);
    // Pia is in Acme, which works on acme/app; her garden is hers alone.
    for (const u of [pia, ana]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: NOW } as any);
    await ctx.db.insert("repo_sources", { user_id: ana, team_id: team, repository: TEAMS, root: "/src/app", enabled: true, last_synced_at: NOW, created_at: NOW, updated_at: NOW } as any);
    await ctx.db.insert("api_tokens", { user_id: pia, token_hash: await hashToken(tokens.pia), name: "Test", created_at: 1, last_used_at: 1 });
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(tokens.ana), name: "Test", created_at: 1, last_used_at: 1 });
    const ws = `user:${pia}`;
    const node = (id: string, label: string) => ({ id, label, shape: "box", type: "agent" });
    const flow = await ctx.db.insert("workflows", {
      user_id: pia, workspace: ws, name: "personal", slug: "personal", label: "Ship", source: "digraph personal { }",
      nodes: [node("land", "Land"), node("deploy", "Deploy"), node("exit", "Live"), node("unverified", "Deployed, unverified"), node("nodeploy", "Landed"), node("deploy_failed", "Deploy failed"), node("review", "Review"), node("deploy__failed", "Deploy failed")],
      edges: [], created_at: NOW, updated_at: NOW,
    } as any);
    const lineDeploy = await ctx.db.insert("workflows", { user_id: pia, workspace: ws, name: "line-deploy", slug: "line-deploy", nodes: [node("exit", "Live")], edges: [], created_at: NOW, updated_at: NOW } as any);
    const session = (title: string, remote?: string) => ctx.db.insert("conversations", {
      user_id: pia, is_private: true, title, git_root: "/repo", agent_type: "claude_code", session_id: `s-${title}`,
      ...(remote ? { git_remote_url: remote } : {}), started_at: NOW, updated_at: NOW, message_count: 1, status: "active",
    } as any);
    const shipper = await session("Garden work", "git@github.com:Pia/Garden.git");
    const teamSession = await session("App work", "https://github.com/acme/app.git");
    const bare = await session("No remote");
    const task = await ctx.db.insert("tasks", { short_id: "ct-7", title: "Water the ferns", status: "in_progress", workspace: ws, user_id: pia, created_from_conversation: shipper, created_at: NOW, updated_at: NOW } as any);
    return { pia, ana, team, ws, flow, lineDeploy, shipper, teamSession, bare, task };
  });
  const run = (o: { end?: string; status?: string; flow?: any; spawner?: any; merge?: boolean; stations?: any[]; workspace?: string; fail_reason?: string; task?: null } = {}) =>
    t.run((ctx) => ctx.db.insert("workflow_runs", {
      user_id: ids.pia, workspace: o.workspace ?? ids.ws, workflow_id: o.flow ?? ids.flow, ...(o.task === null ? {} : { task_id: ids.task }),
      status: o.status ?? "completed", current_node_id: o.end ?? "exit",
      node_statuses: o.stations ?? [{ node_id: "deploy", status: "completed", completed_at: NOW - 10, result_preview: JSON.stringify({ outcome: "live", sha: SHA }) }],
      spawner_conversation_id: o.spawner ?? ids.shipper,
      ...(o.merge === false ? {} : { merge: { sha: SHA, branch: "ferns", into: "main", at: NOW - 100 } }),
      ...(o.fail_reason ? { fail_reason: o.fail_reason } : {}),
      created_at: NOW - 1000, updated_at: NOW,
    } as any));
  const record = (id: any, opts: { dry?: boolean } = {}) => t.run(async (ctx) => recordRunDeploy(ctx, (await ctx.db.get(id))!, opts));
  const deploys = () => t.run((ctx) => ctx.db.query("deploys").collect());
  return { t, ids, tokens, run, record, deploys };
}

describe("findDeployWorkspace", () => {
  test("a repository a team of the caller's works on is the team's; any other is the caller's own", async () => {
    const { t, ids } = await setup();
    await t.run(async (ctx) => {
      expect(await findDeployWorkspace(ctx, ids.pia, TEAMS)).toBe(`team:${ids.team}`);
      expect(await findDeployWorkspace(ctx, ids.pia, MINE)).toBe(`user:${ids.pia}`);
    });
  });
});

describe("recording into a personal workspace", () => {
  test("cast ship mark on a team-less repository records a deploy in user:, with no team event", async () => {
    const { t, ids, tokens, deploys } = await setup();
    const res = await t.mutation(api.changesDeploy.markDeploy, { api_token: tokens.pia, repository: MINE, surface: "backend", sha: SHA });
    expect(res).toMatchObject({ team_id: null, workspace: ids.ws, event_id: null });
    const [d] = await deploys();
    expect(d).toMatchObject({ workspace: ids.ws, target: "backend", sha: SHA, status: "live", repository: MINE });
    expect(d.team_id).toBeUndefined();
    // A retry of the same clean push is the same deploy.
    await t.mutation(api.changesDeploy.markDeploy, { api_token: tokens.pia, repository: MINE, surface: "backend", sha: SHA });
    expect(await deploys()).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.query("external_events").collect())).filter((e) => e.kind === "deploy")).toHaveLength(0);
  });

  test("a team repository still records into its team", async () => {
    const { t, ids, tokens, deploys } = await setup();
    const res = await t.mutation(api.changesDeploy.markDeploy, { api_token: tokens.pia, repository: TEAMS, surface: "backend", sha: SHA });
    expect(res.team_id).toBe(ids.team);
    expect((await deploys())[0].workspace).toBe(`team:${ids.team}`);
  });

  test("a ship pass on a team-less repository lands in user:; publishing targets stays a team's", async () => {
    const { t, ids, tokens, deploys } = await setup();
    await expect(t.mutation(api.deployTargets.publish, {
      api_token: tokens.pia, repository: MINE, root: "/garden",
      targets: [{ name: "production", command: "./deploy.sh", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["**"] }],
    })).rejects.toThrow("None of your teams");
    const pass = await t.mutation(api.deployTargets.recordShipPass, {
      api_token: tokens.pia, repository: MINE, ok: true, stage: "done", pushed: SHA, commits: [], held: [],
      deploys: [{ name: "deploy", stage: "after_push", ok: true, target: "production" }], started_at: NOW - 1000,
    });
    expect(pass.deploys[0].deploy).toMatch(/^dp-/);
    const rows = await t.run(async (ctx) => ({
      targets: await ctx.db.query("deploy_targets").collect(),
      passes: await ctx.db.query("ship_passes").collect(),
    }));
    expect(rows.targets).toEqual([]);
    expect(rows.passes.map((r) => r.workspace)).toEqual([ids.ws]);
    expect((await deploys()).map((d) => [d.workspace, d.target, d.status])).toEqual([[ids.ws, "production", "live"]]);
  });
});

describe("the Deploys page's reads by workspace", () => {
  test("each read takes a personal workspace, for its owner only", async () => {
    const { t, ids, tokens } = await setup();
    // No personal publish path exists; a row placed here proves the read goes by workspace.
    await t.run((ctx) => ctx.db.insert("deploy_targets", { workspace: ids.ws, repository: MINE, name: "production", runs: "here", live: { kind: "marker" }, policy: "press", paths: ["**"], publisher_user_id: ids.pia, published_at: NOW, updated_at: NOW } as any));
    await t.mutation(api.changesDeploy.markDeploy, { api_token: tokens.pia, repository: MINE, surface: "production", sha: SHA });
    const shipping = await t.run((ctx) => ctx.db.insert("workflow_runs", { user_id: ids.pia, workspace: ids.ws, workflow_id: ids.flow, status: "running", current_node_id: "review", node_statuses: [], created_at: NOW, updated_at: NOW } as any));
    await t.run((ctx) => ctx.db.insert("checkouts", { workspace: ids.ws, repository: MINE, device_id: "mac", path: "/garden", report: {}, hash: "h", reporter_user_id: ids.pia, reported_at: NOW, updated_at: NOW } as any));
    // The personal flow takes a change, so its run is in the Shipping column.
    await t.run((ctx) => ctx.db.patch(ids.flow, { source: 'digraph personal { graph [kind="line", takes="task,branch"] }' } as any));

    const as = (who: any) => t.withIdentity({ subject: `${who}|session` });
    const view = await t.query(api.deployTargets.view, { api_token: tokens.pia, workspace: ids.ws });
    expect(view.team_id).toBeNull();
    expect(view.targets.map((x: any) => [x.name, x.live?.sha])).toEqual([["production", SHA]]);
    expect(view.productions).toEqual([{ repository: MINE, pause: null, can_pause: false, can_lift: false }]);
    expect((await as(ids.pia).query(api.deployRefs.recentForTeam, { workspace: ids.ws })).map((d: any) => d.sha)).toEqual([SHA]);
    expect((await as(ids.pia).query(api.workflow_runs.shippingRuns, { workspace: ids.ws })).runs.map((r: any) => r._id)).toEqual([shipping]);
    expect((await t.query(api.checkouts.forTeam, { api_token: tokens.pia, workspace: ids.ws })).map((r: any) => r.path)).toEqual(["/garden"]);

    // Someone else asking for Pia's workspace gets nothing.
    expect((await t.query(api.deployTargets.view, { api_token: tokens.ana, workspace: ids.ws })).targets).toEqual([]);
    expect(await as(ids.ana).query(api.deployRefs.recentForTeam, { workspace: ids.ws })).toEqual([]);
    expect((await as(ids.ana).query(api.workflow_runs.shippingRuns, { workspace: ids.ws })).runs).toEqual([]);
    expect(await t.query(api.checkouts.forTeam, { api_token: tokens.ana, workspace: ids.ws })).toEqual([]);
    // Exactly one of team_id and workspace.
    await expect(as(ids.pia).query(api.deployRefs.recentForTeam, { workspace: ids.ws, team_id: ids.team })).rejects.toThrow();
    await expect(as(ids.pia).query(api.deployRefs.recentForTeam, {})).rejects.toThrow();
  });
});

describe("runDeployEnd: where a run ended says what its deploy did", () => {
  const base = { node_statuses: [], fail_reason: undefined, merge: undefined } as any;
  test("live, unverified and shipped exits are live; deploy failures fail; Landed and the rest are nothing", () => {
    const deployed = [{ node_id: "deploy", status: "completed", completed_at: 2, result_preview: JSON.stringify({ outcome: "live", sha: SHA }) }];
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "exit", node_statuses: deployed }, "Live")).toEqual({ status: "live" });
    // Live with no step that ran a deploy: the change landed and went nowhere.
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "exit" }, "Live")).toEqual({ skip: "landed" });
    // A Live end is checked before a "pushed … but the deploy failed" line: the ship step succeeded.
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "exit", fail_reason: "pushed 07e2fe22 to main but the deploy failed; run scripts/deploy.sh", node_statuses: deployed }, "Live")).toEqual({ status: "live" });
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "unverified" }, "Deployed, unverified")).toEqual({ status: "live", note: "Deployed, not seen running" });
    expect(runDeployEnd({
      ...base, status: "completed", current_node_id: "unverified",
      node_statuses: [{ node_id: "deploy", status: "completed", completed_at: 2, result_preview: JSON.stringify({ outcome: "unverified", note: "no health endpoint" }) }],
    }, "Deployed, unverified")).toEqual({ status: "live", note: "Deployed, not seen running: no health endpoint" });
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "shipped", node_statuses: shipNowStations("completed") }, "Shipped")).toEqual({ status: "live" });
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "nodeploy" }, "Landed")).toEqual({ skip: "landed" });
    expect(runDeployEnd({ ...base, status: "completed", current_node_id: "exit" }, "Exit")).toEqual({ skip: "no deploy" });
    expect(runDeployEnd({ ...base, status: "failed", current_node_id: "review" }, "Review")).toEqual({ skip: "no deploy" });
    // A run that stopped at a Live-labelled station without completing did not deploy.
    expect(runDeployEnd({ ...base, status: "failed", current_node_id: "exit" }, "Live")).toEqual({ skip: "no deploy" });
    // The real ship-now run: ship__ship deployed, only codecast's own wait failed after. Live, noted unconfirmed.
    expect(runDeployEnd({ ...base, status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: Error: Too many writes", node_statuses: shipNowStations() }, "Deploy failed"))
      .toEqual({ status: "live", note: "Deployed; codecast couldn't confirm it went live: Error: Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second." });
    // The step that ran the deploy failed: a failed deploy with its words.
    const shipFailed = shipNowStations().map((n) => (n.node_id === "ship__ship" ? { ...n, status: "failed", result_preview: "ssh: connect to host port 22: Operation timed out" } : n));
    expect(runDeployEnd({ ...base, status: "failed", current_node_id: "deploy__failed", node_statuses: shipFailed }, "Deploy failed"))
      .toEqual({ status: "failed", note: "ssh: connect to host port 22: Operation timed out" });
    expect(runDeployEnd({
      ...base, status: "failed", current_node_id: "deploy_failed",
      node_statuses: [{ node_id: "deploy", status: "completed", completed_at: 2, result_preview: JSON.stringify({ outcome: "failed", note: "ssh timed out" }) }],
    }, "Deploy failed")).toEqual({ status: "failed", note: "ssh timed out" });
    expect(runDeployEnd({ ...base, status: "failed", current_node_id: "x", fail_reason: "Stopped: it broke" }, "Deploy failed")).toEqual({ status: "failed", note: "it broke" });
  });

  test("the sha is the merge's, else a deploy or landing station's, else one a station's output names", () => {
    // ship-now and build runs in sit and dance have no merge and no JSON sha: the text names it.
    expect(runDeploySha({ node_statuses: shipNowStations() } as any)).toBe(SHIP_NOW_SHA);
    expect(runDeploySha({ node_statuses: shipNowStations("completed") } as any)).toBe("669d33be12");
    expect(runDeploySha({ node_statuses: [{ node_id: "ship__ship", status: "completed", result_preview: "deployed 3865b78 to /opt/dance\nlive: 3865b78 is on main and deployed to /opt/dance on nose" }] } as any)).toBe("3865b78");
    // A timestamp at a line's start is not a sha.
    expect(runDeploySha({ node_statuses: [{ node_id: "ship__ship", status: "completed", result_preview: "2026-11-11T10:40:29-08:00 rebased" }] } as any)).toBeNull();
    expect(runDeploySha({ node_statuses: [], merge: { sha: SHA.toUpperCase() } } as any)).toBe(SHA);
    expect(runDeploySha({ node_statuses: [{ node_id: "landed", status: "completed", completed_at: 1, result_preview: JSON.stringify({ sha: LANDED }) }] } as any)).toBe(LANDED);
    expect(runDeploySha({ node_statuses: [{ node_id: "review", status: "completed", result_preview: JSON.stringify({ sha: LANDED }) }] } as any)).toBeNull();
  });
});

describe("recordRunDeploy", () => {
  test("a Live run records a live production deploy naming its task and the session that shipped it", async () => {
    const { t, ids, run, record, deploys } = await setup();
    const id = await run();
    const r = await record(id);
    expect(r).toMatchObject({ recorded: "live" });
    const [d] = await deploys();
    expect(d).toMatchObject({ workspace: ids.ws, target: "production", status: "live", sha: SHA, repository: MINE, ship_run: id, source: "personal flow", trigger: "outside" });
    expect(d.started_by).toMatchObject({ kind: "person", name: "Pia" });
    expect(d.carries).toEqual([expect.objectContaining({ task_id: ids.task, run_id: id, merge_sha: SHA, how: "sent" })]);
    expect(d.commits).toEqual([{ sha: SHA, subject: "Water the ferns", conversation_id: ids.shipper, task_ids: [ids.task] }]);
    // The card the page draws names the session and the task: never "Nothing recorded".
    const [card] = await t.withIdentity({ subject: `${ids.pia}|session` }).query(api.deployRefs.recentForTeam, { workspace: ids.ws });
    expect(card.sessions.map((s: any) => [s.conversation_id, s.task_short_ids])).toEqual([[String(ids.shipper), ["ct-7"]]]);
    expect(card.tasks.map((x: any) => x.short_id)).toEqual(["ct-7"]);
    expect(card.commit_rows).toHaveLength(1);
  });

  test("Deployed, unverified is live; a deploy failure is a failed deploy with the station's words", async () => {
    const { run, record, deploys } = await setup();
    await record(await run({ end: "unverified" }));
    await record(await run({
      end: "deploy_failed", status: "failed", merge: false,
      stations: [{ node_id: "deploy", status: "completed", completed_at: NOW - 5, result_preview: JSON.stringify({ outcome: "failed", note: "nose refused the push", sha: LANDED }) }],
    }));
    const rows = (await deploys()).sort((a, b) => a._creationTime - b._creationTime);
    expect(rows.map((d) => [d.status, d.sha, d.note ?? null])).toEqual([["live", SHA, "Deployed, not seen running"], ["failed", LANDED, "nose refused the push"]]);
    expect(rows[1].carries).toEqual([]);
  });

  test("Landed, an unrelated end, a line deploy's run, a team run and an unfinished run record nothing", async () => {
    const { ids, run, record, deploys } = await setup();
    expect(await record(await run({ end: "nodeploy" }))).toEqual({ skipped: "landed" });
    expect(await record(await run({ end: "review", status: "failed" }))).toEqual({ skipped: "no deploy" });
    expect(await record(await run({ flow: ids.lineDeploy }))).toEqual({ skipped: "line deploy" });
    expect(await record(await run({ workspace: `team:${ids.team}` }))).toEqual({ skipped: "not personal" });
    expect(await record(await run({ status: "running" }))).toEqual({ skipped: "not ended" });
    // The task's session names the remote when the session that pressed Ship has none.
    expect(await record(await run({ spawner: ids.bare }))).toMatchObject({ recorded: "live" });
    expect(await deploys()).toHaveLength(1);
  });

  test("no repository, and a repository a team of the person's works on, are skipped", async () => {
    const { t, ids, run, record, deploys } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.task, { created_from_conversation: undefined } as any));
    expect(await record(await run({ spawner: ids.bare }))).toEqual({ skipped: "no repository" });
    expect(await record(await run({ spawner: ids.teamSession }))).toEqual({ skipped: "team repository" });
    expect(await deploys()).toHaveLength(0);
  });

  test("a second call for the same run changes nothing", async () => {
    const { run, record, deploys } = await setup();
    const id = await run();
    const first = await record(id);
    const before = await deploys();
    expect(await record(id)).toEqual({ already: (first as any).deploy });
    expect(await deploys()).toEqual(before);
  });

  test("the runner's last report of a personal run records its deploy", async () => {
    const { t, ids, tokens, deploys } = await setup();
    const id = await t.run((ctx) => ctx.db.insert("workflow_runs", {
      user_id: ids.pia, workspace: ids.ws, workflow_id: ids.flow, task_id: ids.task, status: "running", current_node_id: "deploy",
      node_statuses: [{ node_id: "deploy", status: "running", started_at: NOW }], spawner_conversation_id: ids.shipper,
      merge: { sha: SHA, branch: "ferns", into: "main", at: NOW - 100 }, created_at: NOW - 1000, updated_at: NOW - 1000,
    } as any));
    await t.mutation(api.workflow_runs.updateProgress, { api_token: tokens.pia, run_id: id, node_id: "deploy", node_status: "completed", outcome: "success", current_node_id: "exit", run_status: "completed", result_preview: JSON.stringify({ outcome: "live", sha: SHA }) });
    // Recorded apart from the report: a scheduled mutation.
    expect(await deploys()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
    expect((await deploys()).map((d) => [d.ship_run, d.status, d.sha])).toEqual([[id, "live", SHA]]);
  });

  test("a ship-now run whose wait failed after ship__ship deployed records a live deploy, its sha read from the output", async () => {
    const { run, record, deploys } = await setup();
    const id = await run({ end: "deploy__failed", status: "failed", merge: false, stations: shipNowStations(), fail_reason: "Stopped: Error: Too many writes per second." });
    expect(await record(id)).toMatchObject({ recorded: "live" });
    const [d] = await deploys();
    expect(d).toMatchObject({ status: "live", sha: SHIP_NOW_SHA, ship_run: id });
    expect(d.note).toStartWith("Deployed; codecast couldn't confirm it went live: Error: Too many writes");
  });

  test("a failed deploy with no sha still names its task and the session that shipped it", async () => {
    const { t, ids, run, record } = await setup();
    await record(await run({ end: "deploy_failed", status: "failed", merge: false, stations: [{ node_id: "deploy", status: "completed", completed_at: NOW - 5, result_preview: JSON.stringify({ outcome: "failed", note: "no route to nose" }) }] }));
    const [card] = await t.withIdentity({ subject: `${ids.pia}|session` }).query(api.deployRefs.recentForTeam, { workspace: ids.ws });
    expect(card).toMatchObject({ status: "failed", sha: null, commit_rows: [] });
    expect(card.sessions.map((s: any) => [s.conversation_id, s.task_short_ids])).toEqual([[String(ids.shipper), ["ct-7"]]]);
    expect(card.tasks.map((x: any) => x.short_id)).toEqual(["ct-7"]);
  });

  test("a run resumed after Deploy failed that ends Live updates its deploy", async () => {
    const { t, ids, run, record, deploys } = await setup();
    const id = await run({ end: "deploy_failed", status: "failed", merge: false, stations: [{ node_id: "deploy", status: "completed", completed_at: NOW - 5, result_preview: JSON.stringify({ outcome: "failed", note: "no route to nose" }) }] });
    const first = await record(id);
    await t.run((ctx) => ctx.db.patch(id, {
      status: "completed", current_node_id: "exit", merge: { sha: SHA, branch: "ferns", into: "main", at: NOW },
      node_statuses: [{ node_id: "deploy", status: "completed", completed_at: NOW + 5, result_preview: JSON.stringify({ outcome: "live", sha: SHA }) }], updated_at: NOW + 10,
    } as any));
    expect(await record(id)).toEqual({ updated: "live", deploy: (first as any).deploy });
    const rows = await deploys();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "live", sha: SHA, live_at: NOW + 10, short_id: (first as any).deploy });
    expect(rows[0].note).toBeUndefined();
    expect(rows[0].carries).toEqual([expect.objectContaining({ task_id: ids.task, run_id: id })]);
    expect(rows[0].commits?.map((c) => c.sha)).toEqual([SHA]);
    // And nothing more on a third look.
    expect(await record(id)).toEqual({ already: (first as any).deploy });
  });

  test("a build run stopped at Not merged after it pushed to main and the deploy failed records a failed deploy of that sha", async () => {
    const { run, record, deploys } = await setup();
    // The real sit run (ct-85591): ship__ship pushed 07e2fe22, then ssh to nose timed out.
    const said = "ssh: connect to host 100.117.130.98 port 22: Operation timed out\r\npushed 07e2fe22 to main but the deploy failed; run scripts/deploy.sh\npushed 07e2fe22 to main but the deploy failed; run scripts/deploy.sh\nok Comment added to ct-85591";
    const id = await run({
      end: "ship__unshipped", status: "failed", merge: false,
      fail_reason: "Stopped: The change was not shipped. ssh: connect to host 100.117.130.98 port 22: Operation timed out pushed 07e2fe22 to main but the deploy failed; run scripts/deploy.sh",
      stations: [
        { node_id: "ship", status: "completed", completed_at: NOW - 400 },
        { node_id: "ship__rebase", status: "completed", completed_at: NOW - 300, result_preview: '{"rebased": true, "landed": false, "why": "on origin/main at 07e2fe22"}' },
        { node_id: "ship__ship", status: "failed", completed_at: NOW - 200, result_preview: said },
        { node_id: "ship__unshipped", status: "failed", completed_at: NOW - 100 },
      ],
    });
    expect(await record(id)).toMatchObject({ recorded: "failed" });
    const [d] = await deploys();
    expect(d).toMatchObject({ status: "failed", sha: "07e2fe22", note: "ssh: connect to host 100.117.130.98 port 22: Operation timed out", ship_run: id });
    // Read from the stop reason alone, too.
    expect(runDeployEnd({ status: "failed", current_node_id: "ship__unshipped", node_statuses: [], fail_reason: "Stopped: The change was not shipped. ssh: timed out pushed 07e2fe22 to main but the deploy failed; run scripts/deploy.sh" } as any, "Not merged"))
      .toEqual({ status: "failed", note: "ssh: timed out" });
  });

  test("real Live ends with no deploy record nothing: a change already on main, and one no deploy ships", async () => {
    const { run, record, deploys } = await setup();
    // dance build ct-84279 (th769e2c): its rebase found the change already on origin/main; nothing shipped it.
    const alreadyOnMain = await run({ merge: false, stations: [
      { node_id: "ship", status: "completed", completed_at: NOW - 300 },
      { node_id: "ship__rebase", status: "completed", completed_at: NOW - 200, result_preview: '{"rebased": true, "landed": true, "why": "already on origin/main"}\nWorkspace \'build-ct-84279\' not found (run: cast workspace acquire build-ct-84279)' },
      { node_id: "ship__landed", status: "completed", completed_at: NOW - 100, result_preview: '{"exit": "landed"}' },
      { node_id: "exit", status: "completed", completed_at: NOW - 50 },
    ] });
    // wardrobe change flow (th71fzb3): merged, but nothing this run deploys ships its files.
    const nothingShips = await run({ stations: [
      { node_id: "merge", status: "completed", completed_at: NOW - 500, result_preview: JSON.stringify({ sha: SHA, pr: 1 }, null, 2) },
      { node_id: "landed", status: "completed", completed_at: NOW - 400, result_preview: SHA },
      { node_id: "deploy", status: "completed", completed_at: NOW - 300 },
      { node_id: "deploy__wait", status: "completed", completed_at: NOW - 200, result_preview: "aaaaaaa is on main; nothing this run deploys ships its files." },
      { node_id: "deploy__live", status: "completed", completed_at: NOW - 100, result_preview: '{"exit": "live"}' },
      { node_id: "exit", status: "completed", completed_at: NOW - 50, result_preview: "Retired jx71ejv: its change is live from main at aaaaaaaaaa and it has no other work." },
    ] });
    expect(await record(alreadyOnMain)).toEqual({ skipped: "landed" });
    expect(await record(nothingShips)).toEqual({ skipped: "landed" });
    expect(await deploys()).toHaveLength(0);
  });

  test("a note over 2000 characters is stored cut, and a second look changes nothing", async () => {
    const { run, record, deploys } = await setup();
    const long = "x".repeat(2500) + " the end";
    const id = await run({ end: "deploy_failed", status: "failed", merge: false, stations: [{ node_id: "deploy", status: "completed", completed_at: NOW - 5, result_preview: JSON.stringify({ outcome: "failed", note: long }) }] });
    const first = await record(id);
    const [d] = await deploys();
    expect(d.note).toHaveLength(2000);
    expect(d.note!.endsWith(" the end")).toBe(true);
    expect(await record(id)).toEqual({ already: (first as any).deploy });
  });

  test("a resume never turns a live deploy failed: the failed redeploy is noted, the sha and carries stay", async () => {
    const { t, ids, run, record, deploys } = await setup();
    const id = await run();
    const first = await record(id);
    const failing = { status: "failed", current_node_id: "deploy_failed", merge: undefined, updated_at: NOW + 10,
      node_statuses: [{ node_id: "deploy", status: "completed", completed_at: NOW + 5, result_preview: JSON.stringify({ outcome: "failed", note: "nose refused", sha: LANDED }) }] };
    await t.run((ctx) => ctx.db.patch(id, failing as any));
    expect(await record(id)).toEqual({ updated: "live", deploy: (first as any).deploy });
    const [d] = await deploys();
    expect(d).toMatchObject({ status: "live", sha: SHA, note: "A later redeploy failed: nose refused" });
    expect(d.carries).toEqual([expect.objectContaining({ task_id: ids.task, run_id: id })]);
    expect(d.commits?.map((c) => c.sha)).toEqual([SHA]);
    expect(await record(id)).toEqual({ already: (first as any).deploy });
  });

  test("an update that keeps the status keeps what the deploy carried", async () => {
    const { t, ids, run, record, deploys } = await setup();
    const id = await run({ end: "unverified" });
    await record(id);
    const other = await t.run((ctx) => ctx.db.insert("tasks", { short_id: "ct-9", title: "Mulch", status: "done", workspace: ids.ws, user_id: ids.pia, created_at: NOW, updated_at: NOW } as any));
    const [before] = await deploys();
    await t.run((ctx) => ctx.db.patch(before._id, { carries: [...before.carries, { task_id: other, how: "deployed after the merge" }] } as any));
    // Resumed and seen running this time: still live, the note goes, both carries stay.
    await t.run((ctx) => ctx.db.patch(id, { current_node_id: "exit", updated_at: NOW + 10 } as any));
    expect(await record(id)).toMatchObject({ updated: "live" });
    const [d] = await deploys();
    expect(d.note).toBeUndefined();
    expect(d.carries.map((c) => c.task_id).sort()).toEqual([ids.task, other].sort());
  });

  test("the run's end fires the deploy trigger; the backfill does not", async () => {
    const { t, ids, run, record } = await setup();
    await t.run((ctx) => ctx.db.insert("agent_tasks", { user_id: ids.pia, title: "After a deploy", prompt: "x", schedule_type: "event", status: "scheduled", run_count: 0, event_filter: { event_type: "deploy_live" }, created_at: 0, updated_at: 0 } as any));
    const fired = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f: any) => f.name.includes("matchTaskTriggers") && f.args[0]?.event_type === "deploy_live").length);
    await run();
    await t.mutation(internal.personalDeploysBackfill.run, { dryRun: false });
    expect(await fired()).toBe(0);
    await t.mutation(internal.runDeploys.record, { run_id: await run() });
    expect(await fired()).toBe(1);
  });

  test("two runs that end Live at one sha are two deploys, each carrying its own task", async () => {
    const { t, ids, run, record, deploys } = await setup();
    const other = await t.run((ctx) => ctx.db.insert("tasks", { short_id: "ct-8", title: "Prune the roses", status: "in_progress", workspace: ids.ws, user_id: ids.pia, created_from_conversation: ids.shipper, created_at: NOW, updated_at: NOW } as any));
    const a = await run();
    const b = await run();
    await t.run((ctx) => ctx.db.patch(b, { task_id: other } as any));
    await record(a);
    await record(b);
    const rows = (await deploys()).sort((x, y) => x._creationTime - y._creationTime);
    expect(rows.map((d) => [d.ship_run, d.sha, d.carries.map((c) => c.task_id)])).toEqual([[a, SHA, [ids.task]], [b, SHA, [other]]]);
  });
});

describe("personalDeploysBackfill", () => {
  test("a dry run counts; the real one records; a second records nothing new", async () => {
    const { t, ids, run, deploys } = await setup();
    await run();
    await run({ end: "deploy_failed", status: "failed", merge: false, stations: [] });
    await run({ end: "nodeploy" });
    await run({ spawner: ids.teamSession, task: null });
    await run({ status: "running", end: "review" });
    const dry = await t.mutation(internal.personalDeploysBackfill.run, {});
    expect(dry).toMatchObject({ dryRun: true, live: 1, failed: 1, landed: 1, team_repository: 1, already: 0 });
    expect(await deploys()).toHaveLength(0);
    const real = await t.mutation(internal.personalDeploysBackfill.run, { dryRun: false });
    expect(real).toMatchObject({ dryRun: false, live: 1, failed: 1, landed: 1, team_repository: 1 });
    expect((await deploys()).map((d) => d.status).sort()).toEqual(["failed", "live"]);
    const again = await t.mutation(internal.personalDeploysBackfill.run, { dryRun: false });
    expect(again).toMatchObject({ live: 0, failed: 0, already: 2, updated: 0 });
    expect(await deploys()).toHaveLength(2);
  });
});
