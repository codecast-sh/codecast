import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { log, record, show } from "./ciVerdicts";
import { ciOf, recordCommitCi } from "./deployTargetsCi";
import { logTail, parseRunnerVerdict } from "@codecast/shared/contracts/ciVerdict";

// Our own CI runner's verdict per commit (ct-102083): one runner row per (repository, sha, name), upserted the way
// GitHub's rows are, and read by `cast ci show|log` but by nothing that decides a deploy. Synthetic data only.

const TEAM = "team1".padEnd(32, "0") as any;
const OTHER = "team2".padEnd(32, "0") as any;
const ME = "user_me";
const TOKEN = "cast_ci_token";
const OUT = "user_out";
const OUT_TOKEN = "cast_ci_token_out";
const REPO = "acme/app";
const SHA = "ab".repeat(20);
const NOW = Date.now();

async function world() {
  const t: Record<string, any[]> = {
    users: [{ _id: ME, name: "Ana" }, { _id: OUT, name: "Oz" }],
    api_tokens: [{ _id: "tok_1", user_id: ME, token_hash: await hashToken(TOKEN) }, { _id: "tok_2", user_id: OUT, token_hash: await hashToken(OUT_TOKEN) }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }, { _id: "m2", user_id: OUT, team_id: OTHER, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }, { _id: OTHER, name: "Other" }],
    github_app_installations: [],
    repo_sources: [{ _id: "rs1", repository: REPO, team_id: TEAM }],
    commit_ci: [],
  };
  const deleted: string[] = [];
  const ctx = {
    db: makeFakeDb(t),
    auth: { getUserIdentity: async () => null },
    storage: { delete: async (id: string) => { deleted.push(id); }, getUrl: async (id: string) => `https://files.test/${id}` },
  } as any;
  return { t, ctx, deleted };
}

const job = (name: string, conclusion: string, extra: Record<string, unknown> = {}) => ({ name, counts: true, conclusion, seconds: 60, failing: [], ...extra });
const verdict = (over: Record<string, unknown> = {}) => ({
  api_token: TOKEN, repository: REPO, sha: SHA, name: "union-ci", run_kind: "main", host: "union-line-3", run_id: "run-1",
  started_at: NOW, status: "completed", conclusion: "success", jobs: [job("test", "success", { log_storage_id: "log_a" })], ...over,
});
const put = (ctx: any, over: Record<string, unknown> = {}) => (record as any)._handler(ctx, verdict(over));

describe("recording a runner verdict", () => {
  test("one row per commit and name, scoped to the repository's team", async () => {
    const { t, ctx } = await world();
    const r = await put(ctx);
    expect(r).toMatchObject({ sha: SHA, written: true, conclusion: "success" });
    expect(t.commit_ci).toHaveLength(1);
    expect(t.commit_ci[0]).toMatchObject({ kind: "runner", workspace: `team:${TEAM}`, host: "union-line-3", run_kind: "main", name: "union-ci" });
    expect(t.commit_ci[0].jobs[0]).toMatchObject({ name: "test", log_storage_id: "log_a" });
  });

  test("a finished run is not overwritten by the same run still in progress; a newer run takes the row and its old logs go", async () => {
    const { t, ctx, deleted } = await world();
    await put(ctx);
    const late = await put(ctx, { status: "in_progress", conclusion: undefined, jobs: [] });
    expect(late).toMatchObject({ written: false, status: "completed" });
    expect(t.commit_ci[0].jobs).toHaveLength(1);

    const older = await put(ctx, { run_id: "run-0", started_at: NOW - 1000, conclusion: "failure" });
    expect(older).toMatchObject({ written: false, run_id: "run-1", conclusion: "success" });

    await put(ctx, { run_id: "run-2", started_at: NOW + 1000, status: "in_progress", conclusion: undefined, jobs: [job("test", "failure", { log_storage_id: "log_b" })] });
    expect(t.commit_ci).toHaveLength(1);
    expect(t.commit_ci[0]).toMatchObject({ run_id: "run-2", status: "in_progress" });
    expect(t.commit_ci[0].conclusion).toBeUndefined();
    expect(deleted).toEqual(["log_a"]);
  });

  test("a caller outside the repository's team cannot write or read it", async () => {
    const { ctx } = await world();
    await expect(put(ctx, { api_token: OUT_TOKEN })).rejects.toThrow();
    await put(ctx);
    await expect((show as any)._handler(ctx, { api_token: OUT_TOKEN, repository: REPO, sha: SHA })).rejects.toThrow();
  });

  test("a short sha is refused on write", async () => {
    const { ctx } = await world();
    await expect(put(ctx, { sha: SHA.slice(0, 12) })).rejects.toThrow(/40-character/);
  });
});

describe("reading it back", () => {
  test("show finds the commit by a prefix and lists the runner's jobs beside GitHub's runs", async () => {
    const { ctx } = await world();
    await put(ctx, { conclusion: "failure", jobs: [job("test", "failure", { log_storage_id: "log_a", failing: [{ job: "test", test: "adds", assertion: "1 != 2", file: "a.test.ts", line: 3, excerpt: "x" }] }), job("build-image", "skipped", { counts: false })] });
    await recordCommitCi(ctx, { repository: REPO, sha: SHA, name: "CI", kind: "workflow", status: "completed", conclusion: "success", started_at: NOW }, TEAM);
    const r = await (show as any)._handler(ctx, { api_token: TOKEN, repository: REPO, sha: SHA.slice(0, 9) });
    expect(r.sha).toBe(SHA);
    expect(r.runs.map((x: any) => [x.kind, x.conclusion])).toEqual([["runner", "failure"], ["workflow", "success"]]);
    expect(r.runs[0].jobs[0]).toMatchObject({ name: "test", has_log: true, failing: [{ test: "adds" }] });
    expect(r.runs[0].jobs[0].log_storage_id).toBeUndefined();
  });

  test("log hands back the job's storage URL, and names the jobs there are when asked for another", async () => {
    const { ctx } = await world();
    await put(ctx);
    expect(await (log as any)._handler(ctx, { api_token: TOKEN, repository: REPO, sha: SHA, job: "test" })).toMatchObject({ url: "https://files.test/log_a", encoding: "gzip" });
    await expect((log as any)._handler(ctx, { api_token: TOKEN, repository: REPO, sha: SHA, job: "lint" })).rejects.toThrow(/jobs: test/);
  });
});

describe("in shadow, runner rows decide nothing", () => {
  test("a red runner verdict leaves a commit's deploy CI GitHub's alone", async () => {
    const { ctx } = await world();
    await put(ctx, { conclusion: "failure", jobs: [job("test", "failure")] });
    expect((await ciOf(ctx, REPO, SHA)).state).toBe("none");
    await recordCommitCi(ctx, { repository: REPO, sha: SHA, name: "CI", kind: "workflow", status: "completed", conclusion: "success", started_at: NOW }, TEAM);
    const ci = await ciOf(ctx, REPO, SHA);
    expect(ci.state).toBe("passed");
    expect(ci.runs.map((r) => r.name)).toEqual(["CI"]);
  });
});

describe("the verdict contract", () => {
  test("a good verdict parses; a broken one names every problem", () => {
    const good = { version: 1, repository: REPO, sha: SHA.toUpperCase(), name: "union-ci", kind: "main", host: "h", run_id: "r", started_at: 1, finished_at: 2, status: "completed", conclusion: "success", jobs: [{ name: "test", counts: true, conclusion: "success", seconds: 3, failing: [], log: "jobs/test.log" }] };
    const ok = parseRunnerVerdict(good);
    expect("verdict" in ok && ok.verdict.sha).toBe(SHA);
    const bad = parseRunnerVerdict({ ...good, sha: "abc", status: "completed", conclusion: undefined, jobs: [{ name: "test", counts: "yes", conclusion: "green", seconds: 1, log: "../x" }] });
    expect("problems" in bad && bad.problems).toEqual([
      "sha must be 40 hex characters",
      "a completed verdict needs conclusion success, failure or infra",
      "jobs[0].counts must be true or false",
      "jobs[0].conclusion must be success, failure, skipped or infra",
      "jobs[0].log must be a path inside the verdict's directory",
    ]);
  });

  test("a long log keeps its tail from a line start, and says how much it kept", () => {
    const log = new TextEncoder().encode("one\ntwo\nthree\nfour\n");
    expect(logTail(log, 100)).toBe(log);
    const text = new TextDecoder().decode(logTail(log, 9));
    expect(text).toBe("[codecast kept the last 5 of 19 bytes]\nfour\n");
  });
});
