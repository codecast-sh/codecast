import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { publish } from "./deployTargets";
import { stampMainOrder } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { get } from "./deployReach";

// How far a merged pull request or a commit on main has gone toward
// production (deploys.md DP16), read end to end from the tables. Synthetic data only.

const TEAM = "team_1" as any;
const WS = `team:${TEAM}`;
const ME = "user_me";
const STRANGER = "user_stranger";
const TOKEN = "cast_reach_token";
const REPO = "acme/app";
const NOW = Date.now();

const sha = (n: number) => `${n.toString(16).padStart(2, "0")}cd`.repeat(10);
const file = (filename: string) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 });

async function world() {
  const t = {
    users: [{ _id: ME, name: "Ana" }, { _id: STRANGER, name: "Sam" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    devices: [],
    github_app_installations: [],
    repo_sources: [{ _id: "rs1", repository: REPO, team_id: TEAM }],
    conversations: [],
    tasks: [],
    commits: [] as any[],
    commit_ci: [],
    deploy_targets: [] as any[],
    deploys: [] as any[],
    ship_passes: [],
    external_events: [],
    event_groups: [],
    signals: [],
    counters: [],
    daemon_commands: [],
    agent_tasks: [],
    projects: [],
    pull_requests: [] as any[],
  } as Record<string, any[]>;
  const db = makeFakeDb(t);
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } } as any;
  await (publish as any)._handler(ctx, {
    api_token: TOKEN, team_id: TEAM, repository: REPO,
    targets: [
      { name: "web", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["web/**"] },
      { name: "api", runs: "push", live: { kind: "marker" }, policy: "press", paths: ["api/**"] },
    ],
  });
  // Main: sha(1) web, sha(2) web (the PR's merge), sha(3) api, sha(4) web.
  const files: Record<number, string> = { 1: "web/a.tsx", 2: "web/b.tsx", 3: "api/c.ts", 4: "web/d.tsx" };
  for (const n of [1, 2, 3, 4]) {
    t.commits.push({ _id: `commit_${n}`, sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: NOW, files_changed: 1, insertions: 0, deletions: 0, repository: REPO, team_id: TEAM, branch: "main", files: [file(files[n]!)] });
    await stampMainOrder(ctx, [`commit_${n}` as any], NOW - 10_000 + n);
  }
  // A commit on a branch: main never ordered it.
  t.commits.push({ _id: "commit_branch", sha: sha(7), message: "wip", author_name: "Ana", author_email: "a@x", timestamp: NOW, files_changed: 1, insertions: 0, deletions: 0, repository: REPO, team_id: TEAM, branch: "feature", files: [file("web/x.tsx")] });
  t.pull_requests.push({
    _id: "pr_12", team_id: TEAM, github_pr_id: 99, repository: REPO, number: 12, title: "Checkout", body: "", state: "merged", author_github_username: "ana",
    linked_session_ids: [], files: [file("web/b.tsx")], created_at: NOW - 20_000, updated_at: NOW - 9_000, merged_at: NOW - 9_998, merge_commit_sha: sha(2),
  });
  t.pull_requests.push({ _id: "pr_13", team_id: TEAM, github_pr_id: 100, repository: REPO, number: 13, title: "Open", body: "", state: "open", author_github_username: "ana", linked_session_ids: [], created_at: NOW, updated_at: NOW });
  const as = (user: string) => ({ ...ctx, auth: { getUserIdentity: async () => ({ subject: `${user}|sess` }) } });
  const reach = (ref: string, user = ME) => (get as any)._handler(as(user), { ref });
  const mark = (target: string, n: number, status: "live" | "running" | "failed" = "live", at = NOW) =>
    recordDeployMarker(ctx, { workspace: WS, team_id: TEAM, target, sha: sha(n), repository: REPO, source: "m", status, at });
  return { t, ctx, reach, mark };
}

describe("a merged pull request's reach", () => {
  test("only the target its files touch, and its state follows the deploys: waiting, going out, live", async () => {
    const w = await world();
    await w.mark("web", 1, "live", NOW - 9_000);
    await w.mark("api", 1, "live", NOW - 9_000);
    const waiting = await w.reach("acme/app#12");
    expect(waiting).toMatchObject({ _id: "acme/app#12", ref: "acme/app#12", state: "waiting", sha: sha(2) });
    expect(waiting.targets.map((x: any) => [x.target, x.state, x.now?.short_id])).toEqual([["web", "waiting", "dp-1"]]);

    // A deploy of a later commit on main is running: it holds the merge by its place on main.
    await w.mark("web", 4, "running", NOW - 5_000);
    const going = await w.reach("Acme/App#12");
    expect(going.state).toBe("going_out");
    expect(going.targets[0]).toMatchObject({ target: "web", state: "going_out", deploy: { short_id: "dp-3", status: "running" }, now: { short_id: "dp-1" } });

    await w.mark("web", 4, "live", NOW - 4_000);
    expect(w.t.deploys.find((d) => d.short_id === "dp-3")).toMatchObject({ status: "live", cut_at: w.t.commits.find((c) => c.sha === sha(4)).main_at });
    const live = await w.reach("acme/app#12");
    expect(live.state).toBe("live");
    expect(live.targets[0]).toMatchObject({ state: "live", deploy: { short_id: "dp-3", status: "live" }, now: null });
  });

  test("a failed deploy after the live one, and a rollback, are what it reports", async () => {
    const w = await world();
    await w.mark("web", 1, "live", NOW - 9_000);
    await w.mark("web", 4, "failed", NOW - 8_000);
    expect((await w.reach("acme/app#12")).targets[0]).toMatchObject({ state: "failed", deploy: { short_id: "dp-2" } });
    await w.mark("web", 2, "live", NOW - 7_000);
    expect((await w.reach("acme/app#12")).state).toBe("live");
    // A rollback to sha(1) is a deploy row of its own (as deployTargets.request writes one), stamped at sha(1)'s place.
    const first = w.t.deploys.find((d) => d.short_id === "dp-1");
    w.t.deploys.push({ ...first, _id: "dp_back", short_id: "dp-9", action: "rollback", rollback_of: "dp-1", created_at: NOW - 6_000, live_at: NOW - 6_000 });
    expect((await w.reach("acme/app#12")).targets[0]).toMatchObject({ state: "rolled_back", deploy: { short_id: "dp-3" }, now: { short_id: "dp-9" } });
  });

  test("with no files on the row, the merge commit's files decide the targets", async () => {
    const w = await world();
    w.t.pull_requests[0].files = undefined;
    w.t.pull_requests[0].merge_commit_sha = sha(3);
    const r = await w.reach("acme/app#12");
    expect(r.targets.map((x: any) => x.target)).toEqual(["api"]);
  });

  test("an open pull request, a viewer outside the team, or an unknown ref is null", async () => {
    const w = await world();
    await w.mark("web", 4, "live");
    expect(await w.reach("acme/app#13")).toBeNull();
    expect(await w.reach("acme/app#12", STRANGER)).toBeNull();
    expect(await w.reach("acme/app#404")).toBeNull();
    expect(await w.reach("not a ref")).toBeNull();
  });
});

describe("a commit's reach", () => {
  test("a commit on main reads like its pull request; a commit only on a branch is null", async () => {
    const w = await world();
    await w.mark("web", 1, "live", NOW - 9_000);
    await w.mark("api", 3, "live", NOW - 8_000);
    const r = await w.reach(`acme/app@${sha(3).slice(0, 10)}`);
    expect(r).toMatchObject({ _id: `acme/app@${sha(3).slice(0, 10)}`, ref: `acme/app@${sha(3).slice(0, 10)}`, state: "live", sha: sha(3) });
    expect(r.targets.map((x: any) => [x.target, x.state])).toEqual([["api", "live"]]);
    expect((await w.reach(`acme/app@${sha(4)}`)).targets.map((x: any) => [x.target, x.state])).toEqual([["web", "waiting"]]);
    expect(await w.reach(`acme/app@${sha(7)}`)).toBeNull();
    expect(await w.reach(`acme/app@${sha(3)}`, STRANGER)).toBeNull();
  });

  test("a repository with no targets the viewer can read is null", async () => {
    const w = await world();
    for (const t of w.t.deploy_targets) t.workspace = `user:${STRANGER}`;
    expect(await w.reach("acme/app#12")).toBeNull();
  });
});
