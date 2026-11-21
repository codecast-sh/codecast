// Red main routes to its culprit (docs/architecture/main-red.md): a run
// claimed from the webhook, settled with what GitHub said, raises main_red once
// per culprit and main_green on recovery, and briefs the culprit's session.
// These drive `settle` with the verdict `judge` reads; mainRed.judge.test.ts
// runs `judge` itself against responses GitHub gave for two real runs.
import { describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { HOLD_MS, JUDGING_TIMEOUT_MS, STALE_MS, mainRedRepos, noteCiWorkflow, noteMainCiRun } from "./mainRed";
import { REPO, sha, failure, CLI_JOBS, redJobs, world } from "./mainRed.testkit";

describe("red main", () => {
  test("flake then green: the rerun passes, no event fires, and the flaky test is recorded", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    const first = await w.claim(2, "failure");
    await w.settle(first.row, 1, "rerunning", redJobs, [failure("parser > reads")]);
    const second = await w.claim(2, "success", 2, first.id);
    expect(await w.settle(second.row, 2, "green", CLI_JOBS)).toBe("green");
    expect(await w.events("main_red")).toHaveLength(0);
    expect(await w.briefs(w.anaConv)).toHaveLength(0);
    const flakes = await w.events("ci_flake");
    expect(flakes.map((e) => e.title)).toEqual(["Flaky on main: parser > reads (green on a rerun)"]);
  });

  test("exact culprit: one event with its payload, and its session is woken with the failure", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    expect(await w.red(2, [failure("parser > reads")])).toBe("main_red");
    const [e] = await w.events("main_red");
    expect(e.data?.main_red).toMatchObject({
      repo: REPO, branch: "main", culprit_sha: sha(2), culprit_exact: true, candidates: [sha(2)], culprit_subject: "change 2", culprit_author: "ana",
      culprit_session: String(w.anaConv).slice(0, 7), red_shas: [sha(2)], reran: true, failing: [{ job: "test-cli", test: "parser > reads" }],
    });
    const [msg] = await w.briefs(w.anaConv);
    expect(msg.content).toContain(`your commit ${sha(2).slice(0, 7)} broke it`);
    expect(msg.content).toContain("parser > reads");
    expect(await w.briefs(w.boConv)).toHaveLength(0);
  });

  test("exact culprit with no session: its author gets a task", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "bo");
    await w.red(2, [failure("parser > reads")]);
    const tasks = await w.t.run(async (ctx) => await ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignee: String(w.bo), priority: "high" });
    expect(tasks[0].title).toBe(`Fix red main: ${sha(2).slice(0, 7)} broke CI`);
    expect(tasks[0].description).toContain("parser > reads");
  });

  test("a burst: one push of three commits lists them as candidates, and each candidate's session is briefed as one of 3", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.commit(3, "bo", w.boConv);
    await w.commit(4, "eve");
    await w.red(4, [failure("parser > reads")]);
    const [e] = await w.events("main_red");
    expect(e.data?.main_red).toMatchObject({ culprit_sha: sha(4), culprit_exact: false, candidates: [sha(2), sha(3), sha(4)], culprit_session: null });
    const [toAna] = await w.briefs(w.anaConv);
    const [toBo] = await w.briefs(w.boConv);
    expect(toAna.content).toContain("on these 3 commits, so one of them broke it");
    expect(toAna.content).toContain(`Yours is ${sha(2).slice(0, 7)}`);
    expect(toBo.content).toContain(`Yours is ${sha(3).slice(0, 7)}`);
  });

  test("a streak: later reds with the same failure join the culprit's event and wake nobody", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("parser > reads")]);
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, [failure("parser > reads")])).toBe("joined");
    expect(await w.events("main_red")).toHaveLength(1);
    const reds = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(reds.map((r) => r.payload.red_shas)).toEqual([[sha(2), sha(3)]]);
    expect(await w.briefs(w.boConv)).toHaveLength(0);
  });

  test("a streak where a later red breaks another job: that commit is a culprit of its own", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("parser > reads")]);
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, [failure("parser > reads"), failure("router > routes", "test-web")])).toBe("main_red");
    const fired = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect(fired.map((p) => [p?.culprit_sha, p?.culprit_exact, p?.failing.map((f) => f.test)])).toEqual([
      [sha(2), true, ["parser > reads"]],
      [sha(3), true, ["router > routes"]],
    ]);
    expect((await w.briefs(w.boConv))[0].content).toContain("router > routes");
  });

  test("another failing test in a job a culprit already owns is the same culprit's: the list a log prints is never identity", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    // The job crashed: its log names no test.
    await w.red(2, [failure(null)]);
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, [failure("parser > reads")])).toBe("joined");
    // A partial fix: 12 of 14 errors were kept from the culprit's run, and the fixer's run shows the last two.
    await w.commit(4, "bo", w.boConv);
    const errors = Array.from({ length: 14 }, (_, i) => failure(`t${String(i).padStart(2, "0")}`));
    expect(await w.red(4, errors.slice(3, 14))).toBe("joined");
    expect(await w.events("main_red")).toHaveLength(1);
    expect(await w.briefs(w.boConv)).toHaveLength(0);
  });

  test("recovery: the first green run that ran the failed job fires main_green with the culprit; a run that skipped it does not", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("parser > reads")]);
    await w.commit(3, "bo");
    await w.green(3, [{ name: "docs", ok: true }, { name: "verify", ok: true }]);
    expect(await w.events("main_green")).toHaveLength(0);
    await w.commit(4, "ana");
    await w.green(4);
    const [g] = await w.events("main_green");
    expect(g.data?.main_red?.culprit_sha).toBe(sha(2));
    expect(g.sha).toBe(sha(4));
    const reds = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(reds[0]).toMatchObject({ status: "green", green_sha: sha(4) });
  });

  test("only a repository listed in MAIN_RED_REPOS is judged; the list is empty by default", async () => {
    expect([...mainRedRepos(" Acme/App , codecast-sh/codecast,")]).toEqual(["acme/app", "codecast-sh/codecast"]);
    const w = await world();
    await w.commit(1, "ana");
    const listed = process.env.MAIN_RED_REPOS;
    try {
      delete process.env.MAIN_RED_REPOS;
      expect(mainRedRepos().size).toBe(0);
      process.env.MAIN_RED_REPOS = "codecast-sh/codecast";
      const unlisted = await w.t.run(async (ctx) => noteMainCiRun(ctx, { repository: REPO, workflow: "CI", ok: false, conclusion: "failure", at: 1001, sha: sha(1), branch: "main", run_id: "777" }, { workflow_run: { id: 777, event: "push", path: ".github/workflows/ci.yml" } }));
      expect(unlisted).toBe(false);
      expect(await w.t.run(async (ctx) => await ctx.db.query("main_ci_runs").collect())).toEqual([]);
      process.env.MAIN_RED_REPOS = `codecast-sh/codecast, ${REPO.toUpperCase()}`;
      expect((await w.claim(1, "failure")).claimed).toBe(true);
    } finally {
      process.env.MAIN_RED_REPOS = listed;
    }
  });

  test("the claim: a repeated delivery, a deploy workflow's run, a push-only workflow and a repository with no deploy targets are not judged", async () => {
    const w = await world();
    await w.commit(1, "ana");
    const first = await w.claim(1, "failure");
    expect(first.claimed).toBe(true);
    expect((await w.claim(1, "failure", 1, first.id)).claimed).toBe(false);
    const other = await w.t.run(async (ctx) => {
      const ci = { repository: REPO, workflow: "Deploy", ok: true, conclusion: "success", at: 1, sha: sha(1), branch: "main", run_id: "9001" };
      const deploy = await noteMainCiRun(ctx, ci, { workflow_run: { id: 9001, event: "push", path: ".github/workflows/deploy.yml" } });
      const elsewhere = await noteMainCiRun(ctx, { ...ci, repository: "acme/other", workflow: "CI", run_id: "9002" }, { workflow_run: { id: 9002, event: "push", path: ".github/workflows/ci.yml" } });
      const scheduled = await noteMainCiRun(ctx, { ...ci, workflow: "CI", run_id: "9003" }, { workflow_run: { id: 9003, event: "schedule", path: ".github/workflows/ci.yml" } });
      // A workflow that never ran on a pull request (a release, a publish) is not CI, so it is never rerun.
      const release = (id: number) => noteMainCiRun(ctx, { ...ci, workflow: "Release", run_id: String(id) }, { workflow_run: { id, event: "push", path: ".github/workflows/release.yml" } });
      const before = await release(9004);
      const pr = (over: Record<string, any>) => noteCiWorkflow(ctx, { repository: { full_name: REPO }, workflow_run: { event: "pull_request", path: ".github/workflows/release.yml", status: "completed", head_repository: { full_name: REPO }, ...over } });
      // A fork's pull request can add a trigger to any workflow, and a run still waiting may never run: neither marks it CI.
      await pr({ head_repository: { full_name: "outsider/app" } });
      await pr({ status: "requested" });
      const afterForkAndWaiting = await release(9005);
      await pr({});
      const after = await release(9006);
      return [deploy, elsewhere, scheduled, before, afterForkAndWaiting, after];
    });
    expect(other).toEqual([false, false, false, false, false, true]);
  });
});

describe("verdicts that land out of the branch's order", () => {
  const parser = [failure("parser > reads")];
  const held = (w: Awaited<ReturnType<typeof world>>, n: number) =>
    w.t.run(async (ctx) => (await ctx.db.query("main_ci_runs").collect()).find((r) => r.sha === sha(n))!);

  test("the fix's green settles before a streak member's rerun: no second main_red, nobody briefed again", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, parser);
    await w.commit(3, "bo", w.boConv);
    const r3 = await w.claim(3, "failure");
    await w.settle(r3.row, 1, "rerunning", redJobs, parser);
    await w.commit(4, "ana");
    await w.green(4);
    expect(await w.events("main_green")).toHaveLength(1);
    const s3 = await w.claim(3, "failure", 2, r3.id);
    expect(await w.settle(s3.row, 2, "red", redJobs, parser)).toBe("history");
    expect(await w.events("main_red")).toHaveLength(1);
    expect(await w.briefs(w.boConv)).toHaveLength(0);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
    const open = await w.t.run(async (ctx) => (await ctx.db.query("main_reds").collect()).filter((r) => r.status === "red"));
    expect(open).toHaveLength(0);
  });

  test("the culprit's own rerun settles after a later streak member: the later red waits, and the culprit is the earlier commit, exact", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    const r2 = await w.claim(2, "failure");
    await w.settle(r2.row, 1, "rerunning", redJobs, parser);
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, parser)).toBe("held");
    expect(await w.events("main_red")).toHaveLength(0);
    const s2 = await w.claim(2, "failure", 2, r2.id);
    expect(await w.settle(s2.row, 2, "red", redJobs, parser)).toBe("main_red");
    const fired = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect(fired.map((p) => [p?.culprit_sha, p?.culprit_exact, p?.candidates])).toEqual([[sha(2), true, [sha(2)]]]);
    const reds = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(reds.map((r) => r.payload.red_shas)).toEqual([[sha(2), sha(3)]]);
    expect(await w.briefs(w.boConv)).toHaveLength(0);
    expect((await held(w, 3)).held_since).toBeUndefined();
  });

  test("a manual rerun of an old red after recovery fires nothing", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    const r2 = await w.claim(2, "failure");
    await w.settle(r2.row, 1, "rerunning", redJobs, parser);
    const a2 = await w.claim(2, "failure", 2, r2.id);
    await w.settle(a2.row, 2, "red", redJobs, parser);
    await w.commit(3, "ana");
    await w.green(3);
    const a3 = await w.claim(2, "failure", 3, r2.id);
    expect(a3.claimed).toBe(true);
    expect(await w.settle(a3.row, 3, "red", redJobs, parser)).toBe("history");
    expect(await w.events("main_red")).toHaveLength(1);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
  });

  test("a hold ends at its deadline: the red is placed with what has settled", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana");
    const r2 = await w.claim(2, "failure");
    await w.settle(r2.row, 1, "rerunning", redJobs, parser);
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, parser)).toBe("held");
    const row = await held(w, 3);
    await w.t.run(async (ctx) => ctx.db.patch(row._id, { held_since: Date.now() - HOLD_MS - 1 }));
    await w.t.mutation(internal.mainRed.release, { run: row._id });
    const [p] = (await w.events("main_red")).map((e) => e.data?.main_red);
    // Commit 2's run never settled, so it was never tested: it stays a candidate.
    expect([p?.culprit_sha, p?.culprit_exact, p?.candidates]).toEqual([sha(3), false, [sha(2), sha(3)]]);
  });

  test("a run that never gets a verdict frees the reds held behind it", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana");
    const r2 = await w.claim(2, "failure");
    await w.settle(r2.row, 1, "rerunning", redJobs, parser);
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, parser)).toBe("held");
    expect(await w.settle(r2.row, 1, "lost", [])).toBe("lost");
    const [p] = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect([p?.culprit_sha, p?.candidates]).toEqual([sha(3), [sha(2), sha(3)]]);
  });
});

describe("a commit whose run has not finished yet", () => {
  const parser = [failure("parser > reads")];
  const now = Date.now();

  test("an earlier commit's slower run holds a later red, and the earlier commit is the culprit, exact", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    // Pushed separately just now: 2's CI is slow and has no row yet; 3's finishes red first. GitHub cannot be asked here.
    await w.commit(2, "ana", w.anaConv, { mainAt: now + 2 });
    await w.commit(3, "bo", w.boConv, { mainAt: now + 3 });
    expect(await w.red(3, parser)).toBe("held");
    expect(await w.events("main_red")).toHaveLength(0);
    expect(await w.red(2, parser)).toBe("main_red");
    const fired = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect(fired.map((p) => [p?.culprit_sha, p?.culprit_exact, p?.candidates])).toEqual([[sha(2), true, [sha(2)]]]);
    const reds = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(reds.map((r) => r.payload.red_shas)).toEqual([[sha(2), sha(3)]]);
    expect(await w.briefs(w.boConv)).toHaveLength(0);
  });

  /** A held red on commit 3 whose candidate 2 has no run here, set up without claims so no judge runs. */
  async function heldBehindCommit2() {
    const w = await world();
    const ids = await w.t.run(async (ctx) => {
      await ctx.db.insert("github_app_installations", { team_id: w.team, installation_id: 77, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all", created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("github_installation_tokens", { installation_id: 77, token: "recorded-token", expires_at: now + 3_600_000 } as any);
      const row = (n: number, state: string, seq: number, extra: Record<string, any> = {}) => ctx.db.insert("main_ci_runs", {
        workspace: `team:${w.team}`, team_id: w.team, repository: REPO, branch: "main", workflow: "CI", path: ".github/workflows/ci.yml", run_id: String(700 + n), attempt: 1,
        sha: sha(n), seq, state, jobs: state === "green" ? CLI_JOBS : redJobs, failed: [], failing: [], at: seq, updated_at: now, url: `https://github.com/${REPO}/actions/runs/${700 + n}`, ...extra,
      } as any);
      await row(1, "green", 1001);
      const three = await row(3, "red", now + 3, { failed: ["test-cli"], failing: parser, reran: true, held_since: now, candidates_probe: { at: now, answered: false, failed: false, pending: [] } });
      return { three };
    });
    await w.commit(1, "ana");
    await w.commit(2, "ana", w.anaConv, { mainAt: now + 2 });
    await w.commit(3, "bo", w.boConv, { mainAt: now + 3 });
    return { ...w, ...ids };
  }

  /** GitHub's runs for a commit, as `actions/runs?head_sha=` answers. */
  function githubRuns(byHead: Record<string, any[]>) {
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      const head = url.searchParams.get("head_sha");
      if (url.pathname.endsWith("/actions/runs") && head) {
        asked.push(head);
        return Response.json({ total_count: (byHead[head] ?? []).length, workflow_runs: byHead[head] ?? [] });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
    return { asked, restore: () => { globalThis.fetch = real; } };
  }

  test("GitHub says the earlier commit's run is still going: the red waits for it", async () => {
    const w = await heldBehindCommit2();
    const gh = githubRuns({ [sha(2)]: [{ id: 702, path: ".github/workflows/ci.yml", status: "in_progress", conclusion: null }] });
    try {
      expect(await w.t.action(internal.mainRed.probeCandidates, { run: w.three, shas: [sha(2)] })).toBe("pending");
    } finally {
      gh.restore();
    }
    expect(gh.asked).toEqual([sha(2)]);
    expect(await w.events("main_red")).toHaveLength(0);
    // 2's run lands red: 2 is placed first and named exact, and 3 joins it.
    const two = await w.t.run(async (ctx) => ctx.db.insert("main_ci_runs", {
      workspace: `team:${w.team}`, team_id: w.team, repository: REPO, branch: "main", workflow: "CI", path: ".github/workflows/ci.yml", run_id: "702", attempt: 2,
      sha: sha(2), seq: now + 2, state: "judging", jobs: [], failed: [], failing: [], at: now + 2, updated_at: now,
    } as any));
    expect(await w.settle(two, 2, "red", redJobs, parser)).toBe("main_red");
    const fired = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect(fired.map((p) => [p?.culprit_sha, p?.culprit_exact])).toEqual([[sha(2), true]]);
  });

  test("GitHub says the earlier commit has no run going (it rode the same push): the red names both as candidates", async () => {
    const w = await heldBehindCommit2();
    const gh = githubRuns({ [sha(2)]: [{ id: 99, path: ".github/workflows/release.yml", status: "in_progress" }] });
    try {
      expect(await w.t.action(internal.mainRed.probeCandidates, { run: w.three, shas: [sha(2)] })).toBe("settled");
    } finally {
      gh.restore();
    }
    const [p] = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect([p?.culprit_sha, p?.culprit_exact, p?.candidates]).toEqual([sha(3), false, [sha(2), sha(3)]]);
  });
});

describe("a culprit is the jobs it broke", () => {
  const X = failure("X");
  const Y = failure("Y", "test-web");

  test("the aggregate never ties reds together: a culprit's job passing fixes it, and a re-break of that job is a new culprit someone is told of", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    expect(await w.red(2, [X])).toBe("main_red");
    await w.commit(3, "ana");
    expect(await w.red(3, [Y])).toBe("main_red");
    // X fixed while Y keeps main red: test-cli passed, verify still failed.
    await w.commit(4, "ana");
    expect(await w.red(4, [Y])).toBe("joined");
    const reds = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(reds.map((r) => [r.payload.culprit_sha, r.status])).toEqual([[sha(2), "fixed"], [sha(3), "red"]]);
    // Bo breaks test-cli again.
    await w.commit(5, "bo", w.boConv);
    expect(await w.red(5, [X, Y])).toBe("main_red");
    const fired = (await w.events("main_red")).map((e) => e.data?.main_red);
    expect(fired.map((p) => [p?.culprit_sha, p?.culprit_exact, p?.failing.map((f) => f.job)])).toEqual([
      [sha(2), true, ["test-cli"]],
      [sha(3), true, ["test-web"]],
      [sha(5), true, ["test-cli"]],
    ]);
    expect(await w.briefs(w.boConv)).toHaveLength(1);
    // Culprit 3 collected only the reds of its own job; culprit 2 was not touched by them.
    const after = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(after.map((r) => r.payload.red_shas)).toEqual([[sha(2)], [sha(3), sha(4), sha(5)], [sha(5)]]);
  });

  test("a culprit fixed in a red run turns green, with main_green, on the next green run", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [X]);
    await w.commit(3, "ana");
    await w.red(3, [Y]);
    await w.commit(4, "ana");
    await w.red(4, [Y]);
    expect(await w.events("main_green")).toHaveLength(0);
    await w.commit(5, "ana");
    await w.green(5);
    const greens = (await w.events("main_green")).map((e) => e.data?.main_red?.culprit_sha);
    expect(greens.sort()).toEqual([sha(2), sha(3)].sort());
  });

  test("one commit that breaks two workflows is one culprit and one event", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("ci_workflows", { repository: REPO, path: ".github/workflows/e2e.yml", seen_at: 1 });
    });
    const e2e = (n: number, ok: boolean, id: number) => w.t.run(async (ctx) => {
      const ci = { repository: REPO, workflow: "e2e", ok, conclusion: ok ? "success" : "failure", at: 1000 + n, url: `https://github.com/${REPO}/actions/runs/${id}`, sha: sha(n), branch: "main", run_id: String(id) };
      await noteMainCiRun(ctx, ci, { workflow_run: { id, event: "push", path: ".github/workflows/e2e.yml", run_attempt: 2 } });
      return (await ctx.db.query("main_ci_runs").withIndex("by_repository_run", (q) => q.eq("repository", REPO).eq("run_id", String(id))).first())!._id;
    });
    await w.commit(1, "ana");
    await w.green(1);
    await w.settle(await e2e(1, true, 801), 2, "green", [{ name: "playwright", ok: true }]);
    await w.commit(2, "ana", w.anaConv);
    expect(await w.red(2, [X])).toBe("main_red");
    expect(await w.settle(await e2e(2, false, 802), 2, "red", [{ name: "playwright", ok: false }], [failure("checkout flow", "playwright")])).toBe("merged");
    expect(await w.events("main_red")).toHaveLength(1);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
    const [r] = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(r.jobs).toEqual([{ workflow: "CI", job: "test-cli" }, { workflow: "e2e", job: "playwright" }]);
    expect(r.payload.failing.map((f) => f.job)).toEqual(["test-cli", "playwright"]);
  });
});

describe("culprits that cannot close", () => {
  test("a culprit whose jobs have not run for a week expires, with no event", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("X")]);
    await w.t.run(async (ctx) => {
      for (const r of await ctx.db.query("main_reds").collect()) await ctx.db.patch(r._id, { seen_at: Date.now() - STALE_MS - 1 });
    });
    // A docs-only run: it skips test-cli.
    await w.commit(3, "ana");
    await w.green(3, [{ name: "docs", ok: true }]);
    const [r] = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(r.status).toBe("expired");
    expect(await w.events("main_green")).toHaveLength(0);
  });

  test("a culprit whose job is missing from a run's full job list (skipped jobs included) left the workflow, and expires", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("X")]);
    await w.commit(3, "ana");
    const run = await w.claim(3, "success");
    await w.settle(run.row, 1, "green", [{ name: "test-web", ok: true }, { name: "verify", ok: true }], [], { listed_jobs: ["test-web", "verify"] });
    const [r] = await w.t.run(async (ctx) => await ctx.db.query("main_reds").collect());
    expect(r.status).toBe("expired");
  });

  test("a culprit on a reusable workflow's job ('build / test') stays one culprit across a streak, and each session hears once", async () => {
    const w = await world();
    const J = (ok: boolean) => [{ name: "build / test", ok }, { name: "verify", ok }];
    // The full job list, as the jobs API gives it: the caller job reports as `build / test`.
    const listed_jobs = ["build / test", "verify"];
    const redRun = async (n: number) => {
      const first = await w.claim(n, "failure");
      await w.settle(first.row, 1, "rerunning", J(false), [failure("x", "build / test")], { listed_jobs });
      const second = await w.claim(n, "failure", 2, first.id);
      return await w.settle(second.row, 2, "red", J(false), [failure("x", "build / test")], { listed_jobs });
    };
    await w.commit(1, "ana");
    await w.green(1, J(true));
    await w.commit(2, "ana", w.anaConv);
    expect(await redRun(2)).toBe("main_red");
    await w.commit(3, "bo", w.boConv);
    expect(await redRun(3)).toBe("joined");
    await w.commit(4, "bo");
    expect(await redRun(4)).toBe("joined");
    expect(await w.events("main_red")).toHaveLength(1);
    expect([(await w.briefs(w.anaConv)).length, (await w.briefs(w.boConv)).length]).toEqual([1, 0]);
    expect(await w.t.run(async (ctx) => (await ctx.db.query("main_reds").collect()).map((r) => r.status))).toEqual(["red"]);
  });

  test("a culprit commit raised again after its culprit expired tells nobody a second time", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    const r2 = await w.claim(2, "failure");
    await w.settle(r2.row, 1, "rerunning", redJobs, [failure("X")]);
    const a2 = await w.claim(2, "failure", 2, r2.id);
    expect(await w.settle(a2.row, 2, "red", redJobs, [failure("X")])).toBe("main_red");
    await w.t.run(async (ctx) => {
      for (const r of await ctx.db.query("main_reds").collect()) await ctx.db.patch(r._id, { seen_at: Date.now() - STALE_MS - 1 });
    });
    await w.commit(3, "ana");
    await w.green(3, [{ name: "docs", ok: true }]);
    // Somebody reruns commit 2's run by hand: nothing has passed test-cli since, so the commit is named again.
    const a3 = await w.claim(2, "failure", 3, r2.id);
    expect(await w.settle(a3.row, 3, "red", redJobs, [failure("X")])).toBe("main_red");
    expect(await w.events("main_red")).toHaveLength(2);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
  });

  test("a backlog of old open culprits never hides a new one: reds read the newest first", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("main_reds", {
          workspace: `team:${w.team}`, team_id: w.team, repository: REPO, jobs: [{ workflow: "CI", job: `old-${i}` }], newest_red_seq: 10 + i, status: "red", seen_at: Date.now(), created_at: 1 + i, updated_at: 1 + i,
          payload: { repo: REPO, branch: "main", culprit_sha: `old${i}`, culprit_exact: true, candidates: [], culprit_subject: null, culprit_author: null, culprit_session: null, culprit_run: null, culprit_task: null, red_shas: [], first_red_at: 1, ci_run_url: null, reran: true, failing: [] },
        } as any);
      }
    });
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    expect(await w.red(2, [failure("X")])).toBe("main_red");
    await w.commit(3, "bo", w.boConv);
    expect(await w.red(3, [failure("X")])).toBe("joined");
    expect(await w.events("main_red")).toHaveLength(1);
  });

  test("a held red outside the newest runs of its workflow is still placed at its deadline", async () => {
    const w = await world();
    const held = await w.t.run(async (ctx) => {
      const row = (n: number, extra: Record<string, any>) => ctx.db.insert("main_ci_runs", {
        workspace: `team:${w.team}`, team_id: w.team, repository: REPO, branch: "main", workflow: "CI", path: ".github/workflows/ci.yml", run_id: String(3000 + n), attempt: 1,
        sha: sha(n), seq: 1000 + n, state: "green", jobs: CLI_JOBS, failed: [], failing: [], at: 1000 + n, updated_at: 1, ...extra,
      } as any);
      const old = await row(1, { state: "red", jobs: redJobs, failed: ["test-cli"], failing: [failure("X")], held_since: Date.now() - HOLD_MS - 1 });
      for (let n = 2; n < 70; n++) await row(n, {});
      return old;
    });
    await w.t.mutation(internal.mainRed.release, { run: held });
    expect(await w.t.run(async (ctx) => (await ctx.db.get(held))?.held_since ?? "placed")).toBe("placed");
  });
});

describe("a claim that never got judged", () => {
  test("a row still judging past the timeout is claimed again by the next delivery or the retry; a fresh one is not", async () => {
    const w = await world();
    await w.commit(1, "ana");
    const first = await w.claim(1, "failure");
    // A repeat delivery while the judge may still be running does nothing.
    expect((await w.claim(1, "failure", 1, first.id)).claimed).toBe(false);
    await w.t.run(async (ctx) => ctx.db.patch(first.row, { updated_at: Date.now() - JUDGING_TIMEOUT_MS - 1 }));
    expect((await w.claim(1, "failure", 1, first.id)).claimed).toBe(true);
    const judges = await w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.endsWith("mainRed:judge")));
    expect(judges).toHaveLength(2);
  });
});

describe("the judging workspace", () => {
  test("is pinned on the first judgment and kept, until that workspace no longer declares a target", async () => {
    const w = await world();
    const personalTarget = await w.t.run(async (ctx) => ctx.db.insert("deploy_targets", {
      workspace: `user:${w.bo}`, repository: REPO, name: "bo-web", runs: "push", live: { kind: "marker" }, policy: "press", paths: [], publisher_user_id: w.bo, published_at: 0, updated_at: 0,
    } as any));
    await w.commit(1, "ana");
    const first = await w.claim(1, "success");
    const pinned = () => w.t.run(async (ctx) => (await ctx.db.query("ci_workflows").collect())[0]?.workspace);
    // The oldest target's workspace, whatever team the webhook routes to.
    expect(await pinned()).toBe(`user:${w.bo}`);
    expect(await w.t.run(async (ctx) => (await ctx.db.get(first.row))?.workspace)).toBe(`user:${w.bo}`);
    await w.commit(2, "ana");
    await w.claim(2, "success");
    expect(await pinned()).toBe(`user:${w.bo}`);
    // Bo's workspace retires its target: the next run re-pins.
    await w.t.run(async (ctx) => ctx.db.patch(personalTarget, { retired_at: 1 }));
    await w.commit(3, "ana");
    const third = await w.claim(3, "success");
    expect(await pinned()).toBe(`team:${w.team}`);
    expect(await w.t.run(async (ctx) => (await ctx.db.get(third.row))?.workspace)).toBe(`team:${w.team}`);
  });
});

describe("no baseline, no blame", () => {
  test("the first run ever is a baseline: no event, nobody briefed", async () => {
    const w = await world();
    await w.commit(1, "ana", w.anaConv);
    expect(await w.red(1, [failure("parser > reads")])).toBe("baseline");
    expect(await w.events("main_red")).toHaveLength(0);
    expect(await w.briefs(w.anaConv)).toHaveLength(0);
    // The streak it starts stays quiet until a green gives it a baseline.
    await w.commit(2, "bo", w.boConv);
    expect(await w.red(2, [failure("parser > reads")])).toBe("baseline");
    expect(await w.events("main_red")).toHaveLength(0);
  });

  test("a last green whose commit left the branch (a force-push) names nobody", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      // Judged green on a commit the branch no longer holds: no place in main's order.
      await ctx.db.insert("main_ci_runs", { workspace: `team:${w.team}`, team_id: w.team, repository: REPO, branch: "main", workflow: "CI", run_id: "1", attempt: 1, sha: sha(9), seq: 900, state: "green", jobs: CLI_JOBS, failed: [], failing: [], at: 1, updated_at: 1 } as any);
    });
    await w.commit(2, "ana", w.anaConv);
    expect(await w.red(2, [failure("parser > reads")])).toBe("baseline");
    expect(await w.briefs(w.anaConv)).toHaveLength(0);
  });
});

describe("who may be told", () => {
  test("a trailer naming a teammate's session does not reach it: the author gets a task", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    // Bo's commit names Ana's session.
    await w.commit(2, "bo", w.anaConv);
    await w.red(2, [failure("parser > reads")]);
    expect(await w.briefs(w.anaConv)).toHaveLength(0);
    const tasks = await w.t.run(async (ctx) => await ctx.db.query("tasks").collect());
    expect(tasks.map((t) => t.assignee)).toEqual([String(w.bo)]);
  });

  test("a push onto the default branch records its authenticated pusher on each commit, a branch push does not", async () => {
    const w = await world();
    let n = 0;
    const push = async (branch: string, pusher: string) => {
      const payload = {
        ref: `refs/heads/${branch}`, after: sha(5), pusher: { name: pusher }, sender: { login: pusher },
        repository: { full_name: REPO, default_branch: "main" },
        commits: [{ id: sha(5), message: "change 5", timestamp: new Date(1005).toISOString(), author: { name: "Ana", email: "a@acme.dev", username: "ana" }, modified: ["x.ts"], distinct: true }],
      };
      const event_id = await w.t.run(async (ctx) => ctx.db.insert("github_webhook_events", { delivery_id: `p-${n++}`, event_type: "push", payload: JSON.stringify(payload), processed: false, created_at: 1 } as any));
      await w.t.run(async (ctx) => {
        await ctx.db.insert("github_app_installations", { team_id: w.team, installation_id: 70 + n, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all" } as any);
      });
      await w.t.mutation(internal.githubWebhooks.processPushEvent, { event_id });
    };
    const pushedBy = () => w.t.run(async (ctx) => { const c = await ctx.db.query("commits").withIndex("by_sha", (q) => q.eq("sha", sha(5))).first(); return c ? c.pushed_by ?? "nobody" : "no commit"; });
    await push("feature", "bo");
    expect(await pushedBy()).toBe("nobody");
    await push("main", "bo");
    expect(await pushedBy()).toBe("bo");
  });

  test("an author email anyone can set does not reach a session: only the push's own pusher does", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    // Authored as Ana (an email), naming Ana's session, but pushed by Bo.
    await w.commit(2, "ana", w.anaConv, { pushedBy: "bo" });
    await w.red(2, [failure("parser > reads")]);
    expect(await w.briefs(w.anaConv)).toHaveLength(0);
  });

  test("the change run whose merge put the commit on the branch vouches for its owner's session", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    // Pushed by a bot, merged by Ana's change run.
    await w.commit(2, "ana", w.anaConv, { pushedBy: "codecast-bot" });
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workflow_runs", { user_id: w.ana, workspace: `team:${w.team}`, status: "completed", node_statuses: [], created_at: 1, updated_at: 1, merge: { sha: sha(2), branch: "b", into: "main", at: 1002 } } as any);
    });
    await w.red(2, [failure("parser > reads")]);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
    const [e] = await w.events("main_red");
    expect(e.title).not.toContain("change 2");
  });

  test("more than five candidates brief no session: one task goes to whoever pushed the newest, naming the range", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.commit(3, "bo", w.boConv);
    for (let n = 4; n <= 7; n++) await w.commit(n, "ana");
    await w.commit(8, "eve", undefined, { pushedBy: "bo" });
    await w.red(8, [failure("X")]);
    const [e] = await w.events("main_red");
    expect([e.data?.main_red?.culprit_exact, e.data?.main_red?.candidates.length]).toEqual([false, 7]);
    expect([(await w.briefs(w.anaConv)).length, (await w.briefs(w.boConv)).length]).toEqual([0, 0]);
    const tasks = await w.t.run(async (ctx) => await ctx.db.query("tasks").collect());
    expect(tasks.map((t) => [t.assignee, t.title])).toEqual([[String(w.bo), `Find which of 7 commits broke main: ${sha(2).slice(0, 7)}..${sha(8).slice(0, 7)}`]]);
  });

  test("a candidate's trailer naming someone else's session is skipped, its own author's is briefed", async () => {
    const w = await world();
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "eve", w.boConv);
    await w.commit(3, "ana", w.anaConv);
    await w.red(3, [failure("parser > reads")]);
    expect(await w.briefs(w.boConv)).toHaveLength(0);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
  });
});

describe("the target's workspace", () => {
  test("a repository a personal deploy target declares files its runs, events and recovery in that person's workspace", async () => {
    const w = await world({ personal: true });
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("parser > reads")]);
    await w.commit(3, "ana");
    await w.green(3);
    const rows = await w.t.run(async (ctx) => ({
      runs: await ctx.db.query("main_ci_runs").collect(),
      events: (await ctx.db.query("external_events").collect()).filter((e) => e.kind.startsWith("main_")),
    }));
    expect(new Set(rows.runs.map((r) => r.workspace))).toEqual(new Set([`user:${w.ana}`]));
    expect(rows.runs.every((r) => r.team_id === undefined)).toBe(true);
    expect(rows.events.map((e) => [e.kind, e.workspace, e.team_id])).toEqual([
      ["main_red", `user:${w.ana}`, undefined],
      ["main_green", `user:${w.ana}`, undefined],
    ]);
    expect(await w.briefs(w.anaConv)).toHaveLength(1);
  });
});

describe("what a deploy names as the reason main is red", () => {
  test("an open culprit is named only while the branch's head is red by its own run", async () => {
    const w = await world();
    const open = async () => (await w.t.withIdentity({ subject: `${w.ana}|session` }).query(api.mainRed.open, { repository: REPO })).open.map((p) => p.culprit_sha);
    await w.commit(1, "ana");
    await w.green(1);
    await w.commit(2, "ana", w.anaConv);
    await w.red(2, [failure("parser > reads")]);
    expect(await open()).toEqual([sha(2)]);
    // A newer head whose CI has not judged it yet: main is not known to be red.
    await w.commit(3, "bo");
    expect(await open()).toEqual([]);
    await w.red(3, [failure("parser > reads")]);
    expect(await open()).toEqual([sha(2)]);
    // A green head that skipped the failed job leaves the culprit open but names nothing.
    await w.commit(4, "bo");
    await w.green(4, [{ name: "docs", ok: true }]);
    expect(await open()).toEqual([]);
  });
});
