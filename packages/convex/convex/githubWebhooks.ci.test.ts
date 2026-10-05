// CI on a repository's default branch (external-data.md X7, X9 "CI failed on
// main"): a completed workflow_run on the default branch files as a check
// group on the team's system github-ci source, one group per repository and
// workflow, and only a flip announces. Pull request runs stay the PR
// pipeline's (githubWebhooks.checks.test.ts).
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { armedTriggerRows, makeFakeDb, schemaIndexes } from "./testDb";
import { defaultBranchCiRun, processWorkflowRunEvent } from "./githubWebhooks";
import { createSource, triggerSourceName } from "./ingest";

const TEAM = "team_1";
const REPO = "codecast-sh/codecast";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

let runId = 700;
let clock = Date.parse("2026-10-04T10:00:00Z");

/** A workflow_run delivery as GitHub sends it, finished on main by default. */
function workflowRun(over: Record<string, any> = {}, repo: Record<string, any> = {}) {
  runId += 1;
  clock += 60_000;
  return {
    action: "completed",
    repository: { full_name: "codecast-sh/Codecast", default_branch: "main", ...repo },
    sender: { login: "ashot" },
    workflow_run: {
      id: runId,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      check_suite_id: runId + 9000,
      head_branch: "main",
      head_sha: SHA,
      head_repository: { full_name: "codecast-sh/codecast" },
      status: "completed",
      conclusion: "failure",
      html_url: `https://github.com/${REPO}/actions/runs/${runId}`,
      run_started_at: new Date(clock).toISOString(),
      created_at: new Date(clock).toISOString(),
      pull_requests: [],
      ...over,
    },
  };
}

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: TEAM }, { _id: "u2" }],
      teams: [{ _id: TEAM, name: "Acme" }],
      team_memberships: [
        { _id: "m2", user_id: "u2", team_id: TEAM, role: "member", joined_at: 1 },
        { _id: "m1", user_id: "u1", team_id: TEAM, role: "admin", joined_at: 5 },
      ],
      github_app_installations: [{ _id: "i1", team_id: TEAM, installation_id: 1, account_login: "codecast-sh", account_type: "Organization" }],
      github_webhook_events: [],
      github_check_suites: [],
      counters: [],
      projects: [],
      event_sources: [],
      event_source_stats: [],
      event_groups: [],
      event_group_tallies: [],
      event_samples: [],
      external_events: [],
      agent_tasks: armedTriggerRows("check_failed", "check_recovered"),
      conversations: [],
      pull_requests: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const ctx = { db, scheduler } as any;
  let n = 0;
  const deliver = async (payload: any) => {
    n += 1;
    const event_id = await db.insert("github_webhook_events", {
      delivery_id: `d${n}`,
      event_type: "workflow_run",
      action: payload.action,
      payload: JSON.stringify(payload),
      processed: false,
      created_at: 0,
    });
    return await (processWorkflowRunEvent as any)._handler(ctx, { event_id });
  };
  const tables = (db as any)._tables;
  const firings = () => scheduled.filter((s) => s.name.endsWith("matchTaskTriggers")).map((s) => s.args);
  return { db, ctx, tables, scheduled, deliver, firings };
}

describe("defaultBranchCiRun", () => {
  test("a finished push run on the default branch is read", () => {
    expect(defaultBranchCiRun(workflowRun())).toMatchObject({ repository: REPO, workflow: "CI", ok: false, conclusion: "failure", branch: "main", sha: SHA });
    expect(defaultBranchCiRun(workflowRun({ conclusion: "success" }))?.ok).toBe(true);
    expect(defaultBranchCiRun(workflowRun({ conclusion: "timed_out" }))?.ok).toBe(false);
    expect(defaultBranchCiRun(workflowRun({ event: "schedule" }))?.ok).toBe(false);
  });

  test("pull request runs, other branches, unfinished and silent runs are not", () => {
    expect(defaultBranchCiRun(workflowRun({ event: "pull_request", head_branch: "feature" }))).toBeNull();
    // A pull request from a fork's own main reports head_branch main.
    expect(defaultBranchCiRun(workflowRun({ event: "pull_request" }))).toBeNull();
    expect(defaultBranchCiRun(workflowRun({ event: "push", head_repository: { full_name: "someone/codecast" } }))).toBeNull();
    expect(defaultBranchCiRun(workflowRun({ head_branch: "release" }))).toBeNull();
    expect(defaultBranchCiRun(workflowRun({ status: "in_progress", conclusion: null }))).toBeNull();
    expect(defaultBranchCiRun(workflowRun({ conclusion: "cancelled" }))).toBeNull();
    expect(defaultBranchCiRun(workflowRun({ conclusion: "skipped" }))).toBeNull();
    expect(defaultBranchCiRun(workflowRun({}, { default_branch: undefined }))).toBeNull();
  });
});

describe("CI on the default branch files on the github-ci source", () => {
  test("the first red run creates the source and announces check_failed once", async () => {
    const w = world();
    const out = await w.deliver(workflowRun());
    expect(out.ci).toEqual({ transitions: 1 });

    expect(w.tables.event_sources).toHaveLength(1);
    expect(w.tables.event_sources[0]).toMatchObject({
      workspace: `team:${TEAM}`,
      team_id: TEAM,
      provider: "github",
      name: "github-ci",
      owner_user_id: "u1",
      promote: [],
      status: "active",
    });
    expect(w.tables.event_groups).toHaveLength(1);
    expect(w.tables.event_groups[0]).toMatchObject({ kind: "check", fingerprint: `invariant:ci:${REPO}:CI`, status: "open", count: 1, title: `CI on ${REPO} main` });

    expect(w.tables.external_events).toHaveLength(1);
    expect(w.tables.external_events[0]).toMatchObject({ kind: "check_failed", source: "github", repository: REPO, sha: SHA, branch: "main", workspace: `team:${TEAM}` });
    expect(w.tables.external_events[0].url).toContain("/actions/runs/");

    expect(w.firings()).toHaveLength(1);
    expect(w.firings()[0]).toMatchObject({ event_type: "check_failed", source: "github-ci", workspace: `team:${TEAM}`, repository: REPO });
  });

  test("red after red is counted, not announced; green recovers; red again announces", async () => {
    const w = world();
    await w.deliver(workflowRun());
    const second = await w.deliver(workflowRun());
    expect(second.ci).toEqual({ transitions: 0 });
    expect(w.tables.external_events).toHaveLength(1);
    expect(w.firings()).toHaveLength(1);

    await w.deliver(workflowRun({ conclusion: "success" }));
    await w.deliver(workflowRun({ conclusion: "failure" }));
    expect(w.tables.external_events.map((e: any) => e.kind)).toEqual(["check_failed", "check_recovered", "check_failed"]);
    expect(w.firings().map((f: any) => f.event_type)).toEqual(["check_failed", "check_recovered", "check_failed"]);
    // One source and one group throughout.
    expect(w.tables.event_sources).toHaveLength(1);
    expect(w.tables.event_groups).toHaveLength(1);
  });

  test("a green first run is on record without announcing, so its first red is the flip", async () => {
    const w = world();
    await w.deliver(workflowRun({ conclusion: "success" }));
    expect(w.tables.external_events).toHaveLength(0);
    expect(w.tables.event_groups[0]).toMatchObject({ status: "resolved", count: 0 });
    await w.deliver(workflowRun());
    expect(w.tables.external_events.map((e: any) => e.kind)).toEqual(["check_failed"]);
  });

  test("each workflow and each repository is its own group", async () => {
    const w = world();
    await w.deliver(workflowRun({ name: "CI" }));
    await w.deliver(workflowRun({ name: "Deploy" }));
    await w.deliver(workflowRun({ name: "CI", head_repository: { full_name: "codecast-sh/site" } }, { full_name: "codecast-sh/site" }));
    expect(w.tables.event_groups.map((g: any) => g.fingerprint).sort()).toEqual([
      `invariant:ci:${REPO}:CI`,
      `invariant:ci:${REPO}:Deploy`,
      "invariant:ci:codecast-sh/site:CI",
    ]);
    expect(w.tables.event_sources).toHaveLength(1);
    expect(w.tables.external_events).toHaveLength(3);
  });

  test("an older run finishing after a newer one does not speak for the branch", async () => {
    const w = world();
    const older = workflowRun({ conclusion: "failure" });
    const newer = workflowRun({ conclusion: "success" });
    await w.deliver(newer);
    const late = await w.deliver(older);
    expect(late.ci).toEqual({ transitions: 0, skipped: "stale" });
    expect(w.tables.external_events).toHaveLength(0);
    expect(w.tables.event_groups[0].status).toBe("resolved");
  });

  test("a paused source takes nothing", async () => {
    const w = world();
    await w.deliver(workflowRun({ conclusion: "success" }));
    await w.db.patch(w.tables.event_sources[0]._id, { status: "paused" });
    const out = await w.deliver(workflowRun());
    expect(out.ci).toEqual({ transitions: 0, skipped: "paused" });
    expect(w.tables.external_events).toHaveLength(0);
  });

  test("pull request runs leave the source untouched and still map their suite", async () => {
    const w = world();
    const out = await w.deliver(workflowRun({ event: "pull_request", head_branch: "ct-1-feature", pull_requests: [{ number: 12 }] }));
    expect(out.ci).toBeUndefined();
    expect(out).toMatchObject({ success: true, event: "pull_request" });
    expect(w.tables.github_check_suites).toHaveLength(1);
    expect(w.tables.event_sources).toHaveLength(0);
    expect(w.tables.event_groups).toHaveLength(0);
    expect(w.tables.external_events).toHaveLength(0);
  });

  test("a repository no team routes to files nowhere", async () => {
    const w = world();
    const out = await w.deliver(workflowRun({ head_repository: { full_name: "stranger/repo" } }, { full_name: "stranger/repo" }));
    expect(out.ci).toBeUndefined();
    expect(w.tables.event_sources).toHaveLength(0);
  });
});

describe("the github-ci name and provider are codecast's", () => {
  test("a trigger may name github-ci in a team workspace before CI first reports", async () => {
    const w = world();
    expect(await triggerSourceName(w.ctx, "u1" as any, `team:${TEAM}`, " GitHub-CI ")).toBe("github-ci");
    await expect(triggerSourceName(w.ctx, "u1" as any, "user:u1", "github-ci")).rejects.toThrow("No source");
    await w.deliver(workflowRun());
    expect(await triggerSourceName(w.ctx, "u1" as any, `team:${TEAM}`, w.tables.event_sources[0].short_id)).toBe("github-ci");
  });

  test("createSource refuses the reserved name", async () => {
    const w = world();
    const as = { auth: { getUserIdentity: async () => ({ subject: "u1|sess" }) }, db: w.db, scheduler: { runAfter: async () => {} } } as any;
    await expect((createSource as any)._handler(as, { name: "github-ci", provider: "http", workspace: "team", team_id: TEAM })).rejects.toThrow("github-ci");
  });
});
