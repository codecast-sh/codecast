// Red main's judge, run against the responses GitHub gave for two real runs
// (docs/architecture/main-red.md): what it reads decides the verdict settle records.
import { describe, expect, test } from "bun:test";
import { internal } from "./_generated/api";
import { noteMainCiRun } from "./mainRed";
import * as recorded from "./mainRed.recorded.testkit";
import { REPO, sha, failure, world } from "./mainRed.testkit";

describe("judge, on what GitHub said about two real runs", () => {
  /** codecast's CI shape: test jobs, and `verify`, which needs them all. */
  const WORKFLOW = [
    "name: CI",
    "on: { push: { branches: [main] }, pull_request: { branches: [main] } }",
    "jobs:",
    "  code_paths:",
    "    name: classify changed paths",
    "  test-always:",
    "    name: guard, ratchet and cross-package tests",
    "    needs: [code_paths]",
    "  test-web:",
    "    needs: [code_paths]",
    "  test-cli:",
    "    needs: [code_paths]",
    "  verify:",
    "    name: verify",
    "    needs:",
    "      - code_paths",
    "      - test-always",
    "      - test-web",
    "      - test-cli",
  ].join("\n");

  /**
   * GitHub's Actions API as the recorded runs answered it: `jobs(run)` gives a run's jobs, the workflow file comes
   * from the contents API (404 with `file: null`), and every request is kept.
   */
  function github(responses: { jobs: (run: string) => any; logs: Record<string, string>; rerun?: Response; run?: any; file?: string | null }) {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}${url.search}`);
      const logs = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
      if (logs && responses.logs[logs[1]]) return new Response(responses.logs[logs[1]], { status: 200 });
      const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
      if (jobs && url.searchParams.get("filter") === "latest") return Response.json(responses.jobs(jobs[1]!));
      if (method === "POST" && /\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(url.pathname)) return responses.rerun?.clone() ?? new Response(null, { status: 201 });
      if (responses.run && /\/actions\/runs\/\d+$/.test(url.pathname)) return Response.json(responses.run);
      if (url.pathname.endsWith("/contents/.github/workflows/ci.yml") && responses.file !== null) return Response.json({ encoding: "base64", content: btoa(responses.file ?? WORKFLOW) });
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = real; } };
  }

  async function connected(permissions?: Record<string, string>) {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("github_app_installations", { team_id: w.team, installation_id: 77, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all", created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("github_installation_tokens", { installation_id: 77, token: "recorded-token", expires_at: Date.now() + 3_600_000, ...(permissions ? { permissions } : {}) } as any);
    });
    /** A finished run's webhook, then its judge, scheduled the way the drain schedules it. */
    const finish = async (runId: number, runSha: string, attempt: number, conclusion: "success" | "failure") => {
      await w.t.run(async (ctx) => {
        const ci = { repository: REPO, workflow: "CI", ok: conclusion === "success", conclusion, at: 5000 + attempt, url: `https://github.com/${REPO}/actions/runs/${runId}`, sha: runSha, branch: "main", run_id: String(runId) };
        await noteMainCiRun(ctx, ci, { workflow_run: { id: runId, event: "push", path: ".github/workflows/ci.yml", run_attempt: attempt } });
      });
      await new Promise((r) => setTimeout(r, 5));
      await w.t.finishInProgressScheduledFunctions();
      return await w.t.run(async (ctx) => await ctx.db.query("main_ci_runs").withIndex("by_repository_run", (q) => q.eq("repository", REPO).eq("run_id", String(runId))).first());
    };
    /** Main's base commit, judged green with every test job, then the commits the test pushes. */
    const base = () => w.t.run(async (ctx) => {
      await ctx.db.insert("commits", { sha: sha(1), message: "base", author_name: "ana", author_email: "a@x", author_login: "ana", timestamp: 1, files_changed: 1, insertions: 1, deletions: 0, repository: REPO, team_id: w.team, branch: "main", main_at: 1001 } as any);
      await ctx.db.insert("main_ci_runs", {
        workspace: `team:${w.team}`, team_id: w.team, repository: REPO, branch: "main", workflow: "CI", path: ".github/workflows/ci.yml", run_id: "1", attempt: 1, sha: sha(1), seq: 1001, state: "green",
        jobs: [{ name: "test-cli", ok: true }, { name: "test-web", ok: true }, { name: "verify", ok: true }], failed: [], failing: [], at: 1, updated_at: 1,
      } as any);
    });
    const commit = (commitSha: string, at: number, message: string, author = "ana", conv?: any) => w.t.run(async (ctx) => {
      await ctx.db.insert("commits", { sha: commitSha, message: conv ? `${message}\n\nCodecast-Session: ${conv}` : message, author_name: author, author_email: `${author}@x`, author_login: author, timestamp: at, files_changed: 1, insertions: 1, deletions: 0, repository: REPO, team_id: w.team, branch: "main", main_at: at, pushed_by: author } as any);
    });
    return { ...w, finish, base, commitAt: commit };
  }

  test("red, rerun, green on the rerun: the failed job is read, the aggregate is not, the jobs are rerun once, and the flake is recorded with no main_red", async () => {
    const w = await connected();
    let attempt = 1;
    const gh = github({ jobs: () => (attempt === 1 ? recorded.FLAKE_JOBS_A1 : recorded.FLAKE_JOBS_A2), logs: recorded.FLAKE_LOGS_A1 });
    try {
      const first = await w.finish(recorded.FLAKE_RUN, recorded.FLAKE_SHA, 1, "failure");
      expect(first).toMatchObject({ state: "rerunning", attempt: 1, failed: ["test-web"] });
      expect(first!.failing.map((f) => [f.job, f.test])).toEqual([["test-web", "the calls page and the face row render through every missing query"]]);
      expect(gh.calls).toEqual([
        `GET /repos/${REPO}/actions/runs/${recorded.FLAKE_RUN}/jobs?filter=latest&per_page=100`,
        `GET /repos/${REPO}/contents/.github/workflows/ci.yml?ref=${recorded.FLAKE_SHA}`,
        `GET /repos/${REPO}/actions/jobs/136247463040/logs`,
        `POST /repos/${REPO}/actions/runs/${recorded.FLAKE_RUN}/rerun-failed-jobs`,
      ]);
      gh.calls.length = 0;
      attempt = 2;
      const second = await w.finish(recorded.FLAKE_RUN, recorded.FLAKE_SHA, 2, "success");
      expect(second).toMatchObject({ state: "green", attempt: 2, failing: [] });
      expect(second!.jobs).toContainEqual({ name: "test-web", ok: true });
      expect(second!.jobs.map((j) => j.name)).not.toContain("test-platform");
      // The rerun's attempt reads its jobs and nothing else: no log, no file, no second rerun.
      expect(gh.calls).toEqual([`GET /repos/${REPO}/actions/runs/${recorded.FLAKE_RUN}/jobs?filter=latest&per_page=100`]);
    } finally {
      gh.restore();
    }
    expect(await w.events("main_red")).toHaveLength(0);
    expect((await w.events("ci_flake")).map((e) => e.title)).toEqual(["Flaky on main: the calls page and the face row render through every missing query (green on a rerun)"]);
  });

  test("without the workflow file, the aggregate is told by timing: verify started only once test-web finished", async () => {
    const w = await connected();
    const gh = github({ jobs: () => recorded.FLAKE_JOBS_A1, logs: recorded.FLAKE_LOGS_A1, file: null });
    try {
      expect(await w.finish(recorded.FLAKE_RUN, recorded.FLAKE_SHA, 1, "failure")).toMatchObject({ state: "rerunning", failed: ["test-web"] });
    } finally {
      gh.restore();
    }
  });

  test("a rerun GitHub refuses proves nothing alone: the next run of the job failing it too raises, not rerun, with the reason", async () => {
    const w = await connected();
    await w.base();
    await w.commitAt(recorded.RED_SHA, 1002, "Find stations of hosted runs", "bo", w.boConv);
    await w.commitAt(sha(3), 1003, "next");
    // GitHub's answer when a run is too old to rerun; the job's log is past the cap.
    const refused = new Response(JSON.stringify({ message: "Unable to retry this workflow run because it was created over a month ago" }), { status: 403 });
    const logs = { ...recorded.RED_LOGS, "136759860651": "x".repeat(9 * 1024 * 1024) };
    const gh = github({ jobs: () => recorded.RED_JOBS_A1, logs, rerun: refused });
    try {
      const first = await w.finish(recorded.RED_RUN, recorded.RED_SHA, 1, "failure");
      expect(first).toMatchObject({ state: "unproven", failed: ["test-cli"] });
      expect(first!.rerun_refused).toContain("GitHub refused the rerun (403: Unable to retry");
      expect(await w.events("main_red")).toHaveLength(0);
      expect(await w.briefs(w.boConv)).toHaveLength(0);
      // The next commit's run fails test-cli too.
      await w.finish(990, sha(3), 1, "failure");
    } finally {
      gh.restore();
    }
    const [e] = await w.events("main_red");
    expect(e.data?.main_red).toMatchObject({ culprit_sha: recorded.RED_SHA, culprit_exact: true, reran: false });
    expect(e.summary).toContain("Not rerun: GitHub refused the rerun (403");
    expect(e.data?.main_red?.failing.map((f) => [f.job, f.excerpt.includes("over 8MB")])).toEqual([["test-cli", true]]);
    expect((await w.briefs(w.boConv))[0].content).toContain("Not rerun: GitHub refused the rerun");
  });

  test("a rerun GitHub refuses, then the next run passes the job: unproven and recovered, never a flake, and nobody is told", async () => {
    const w = await connected();
    await w.base();
    await w.commitAt(recorded.RED_SHA, 1002, "Find stations of hosted runs", "bo", w.boConv);
    await w.commitAt(recorded.FLAKE_SHA, 1003, "next");
    let run = recorded.RED_JOBS_A1;
    const gh = github({ jobs: () => run, logs: recorded.RED_LOGS, rerun: new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }) });
    try {
      expect(await w.finish(recorded.RED_RUN, recorded.RED_SHA, 1, "failure")).toMatchObject({ state: "unproven" });
      run = recorded.FLAKE_JOBS_A2;
      expect(await w.finish(991, recorded.FLAKE_SHA, 1, "success")).toMatchObject({ state: "green" });
    } finally {
      gh.restore();
    }
    expect(await w.events("main_red")).toHaveLength(0);
    // A fix the next commit made looks the same as a flake: nothing goes on the quarantine list.
    expect(await w.events("ci_flake")).toHaveLength(0);
    expect(await w.t.run(async (ctx) => (await ctx.db.query("main_ci_runs").collect()).find((r) => r.run_id === String(recorded.RED_RUN))?.state)).toBe("recovered");
  });

  test("an installation that has not granted actions: write is never asked to rerun: the red is unproven", async () => {
    const w = await connected({ actions: "read", contents: "write" });
    const gh = github({ jobs: () => recorded.RED_JOBS_A1, logs: recorded.RED_LOGS });
    try {
      const first = await w.finish(recorded.RED_RUN, recorded.RED_SHA, 1, "failure");
      expect(first).toMatchObject({ state: "unproven", rerun_refused: "the GitHub App installation grants actions: read, not write" });
      expect(gh.calls.some((c) => c.startsWith("POST"))).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("a rerun whose webhook never came: the recheck reads the run, finds the finished attempt, and judges it", async () => {
    const w = await connected();
    let attempt = 1;
    const gh = github({ jobs: () => (attempt === 1 ? recorded.FLAKE_JOBS_A1 : recorded.FLAKE_JOBS_A2), logs: recorded.FLAKE_LOGS_A1, run: { id: recorded.FLAKE_RUN, status: "completed", conclusion: "success", run_attempt: 2 } });
    try {
      const first = await w.finish(recorded.FLAKE_RUN, recorded.FLAKE_SHA, 1, "failure");
      expect(first).toMatchObject({ state: "rerunning", attempt: 1 });
      attempt = 2;
      expect(await w.t.action(internal.mainRed.recheck, { run: first!._id, attempt: 1 })).toBe("reclaimed");
      await new Promise((r) => setTimeout(r, 5));
      await w.t.finishInProgressScheduledFunctions();
      expect(await w.t.run(async (ctx) => await ctx.db.get(first!._id))).toMatchObject({ state: "green", attempt: 2 });
    } finally {
      gh.restore();
    }
    expect(await w.events("ci_flake")).toHaveLength(1);
    expect(await w.events("main_red")).toHaveLength(0);
  });

  test("a judge that throws is logged and retried twice with backoff, then the run is lost", async () => {
    const w = await connected();
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("fetch failed: ECONNRESET"); }) as unknown as typeof fetch;
    try {
      const row = await w.finish(recorded.FLAKE_RUN, recorded.FLAKE_SHA, 1, "failure");
      expect(row).toMatchObject({ state: "judging", judge_error: "fetch failed: ECONNRESET" });
      const retries = await w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.endsWith("mainRed:judge") && f.state.kind === "pending"));
      expect(retries.map((f) => [f.args[0].tries, Math.round((f.scheduledTime - Date.now()) / 60_000)])).toEqual([[1, 1]]);
      // The last retry throws too.
      expect(await w.t.action(internal.mainRed.judge, { run: row!._id, attempt: 1, ok: false, tries: 2 })).toBe("failed");
      expect(await w.t.run(async (ctx) => (await ctx.db.get(row!._id))?.state)).toBe("lost");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a finished attempt whose judge never settled it is judged again by the recheck", async () => {
    const w = await connected();
    const row = await w.t.run(async (ctx) => ctx.db.insert("main_ci_runs", {
      workspace: `team:${w.team}`, team_id: w.team, repository: REPO, branch: "main", workflow: "CI", path: ".github/workflows/ci.yml", run_id: String(recorded.FLAKE_RUN), attempt: 1,
      sha: recorded.FLAKE_SHA, seq: 5000, state: "judging", jobs: [], failed: [], failing: [], at: 5000, updated_at: 5000,
    } as any));
    const gh = github({ jobs: () => recorded.FLAKE_JOBS_A1, logs: recorded.FLAKE_LOGS_A1, run: { id: recorded.FLAKE_RUN, status: "completed", conclusion: "failure", run_attempt: 1 } });
    try {
      expect(await w.t.action(internal.mainRed.recheck, { run: row, attempt: 1 })).toBe("rejudged");
      await new Promise((r) => setTimeout(r, 5));
      await w.t.finishInProgressScheduledFunctions();
    } finally {
      gh.restore();
    }
    expect(await w.t.run(async (ctx) => (await ctx.db.get(row))?.state)).toBe("rerunning");
  });

  test("a rerun GitHub cancelled is lost: it holds nothing and names nobody", async () => {
    const w = await connected();
    const gh = github({ jobs: () => recorded.FLAKE_JOBS_A1, logs: recorded.FLAKE_LOGS_A1, run: { id: recorded.FLAKE_RUN, status: "completed", conclusion: "cancelled", run_attempt: 2 } });
    try {
      const first = await w.finish(recorded.FLAKE_RUN, recorded.FLAKE_SHA, 1, "failure");
      expect(await w.t.action(internal.mainRed.recheck, { run: first!._id, attempt: 1 })).toBe("lost");
      expect(await w.t.run(async (ctx) => (await ctx.db.get(first!._id))?.state)).toBe("lost");
    } finally {
      gh.restore();
    }
    expect(await w.events("main_red")).toHaveLength(0);
  });

  test("red, rerun, red again: the rerun's own failures name the culprit, and its session is briefed", async () => {
    const w = await connected();
    await w.base();
    await w.commitAt(recorded.RED_SHA, 1002, "Find stations of hosted runs", "ana", w.anaConv);
    let attempt = 1;
    const gh = github({ jobs: () => (attempt === 1 ? recorded.RED_JOBS_A1 : recorded.RED_JOBS_A2), logs: recorded.RED_LOGS });
    try {
      expect(await w.finish(recorded.RED_RUN, recorded.RED_SHA, 1, "failure")).toMatchObject({ state: "rerunning" });
      expect(await w.events("main_red")).toHaveLength(0);
      gh.calls.length = 0;
      attempt = 2;
      expect(await w.finish(recorded.RED_RUN, recorded.RED_SHA, 2, "failure")).toMatchObject({ state: "red", attempt: 2 });
      expect(gh.calls.some((c) => c.startsWith("POST"))).toBe(false);
    } finally {
      gh.restore();
    }
    const [e] = await w.events("main_red");
    expect(e.data?.main_red).toMatchObject({
      culprit_sha: recorded.RED_SHA, culprit_exact: true, candidates: [recorded.RED_SHA], culprit_subject: "Find stations of hosted runs",
      culprit_session: String(w.anaConv).slice(0, 7), reran: true, ci_run_url: `https://github.com/${REPO}/actions/runs/${recorded.RED_RUN}`,
    });
    // The second attempt failed a different test than the first; the event carries what is still red, and never the aggregate.
    expect(e.data?.main_red?.failing.map((f) => [f.job, f.test, f.file, f.line])).toEqual([
      ["test-cli", "actual load bench uses private tmux doctor stubs, independent HTTP and exact verified cleanup", "packages/cli/src/bench/httpFixture.ts", 14],
    ]);
    expect((await w.briefs(w.anaConv))[0].content).toContain("fake HTTP startup failed");
  });
});
