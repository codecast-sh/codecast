// Red main's test world: a team whose repository declares a deploy target, its CI jobs, and failures read from them.
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { internal } from "./_generated/api";
import { noteMainCiRun } from "./mainRed";
import type { CiFailure } from "@codecast/shared/contracts/ciFailures";

export const REPO = "acme/app";
// Red main judges only the repositories listed (mainRedRepos): the test world's is.
process.env.MAIN_RED_REPOS = REPO;
export const sha = (n: number) => `${n.toString(16).padStart(2, "0")}c0ffee`.repeat(5);
export const failure = (test: string | null, job = "test-cli"): CiFailure => ({ job, test, assertion: test ? `${test} failed` : null, file: null, line: null, excerpt: "Expected: 1\nReceived: 2" });
/** The jobs of a run as the jobs API lists them: the named jobs failed, the rest passed, and `verify`, which needs them all, failed with them (as every real codecast red does). */
export const jobsFailing = (...failed: string[]) => [
  ...["test-cli", "test-web"].map((name) => ({ name, ok: !failed.includes(name) })),
  { name: "verify", ok: failed.length === 0 },
];
export const CLI_JOBS = jobsFailing();
export const redJobs = jobsFailing("test-cli");
/** The failed jobs judge names: every failed job but an aggregate (`verify` failing with another job). */
export const ownFailures = (jobs: Array<{ name: string; ok: boolean }>) => {
  const failed = jobs.filter((j) => !j.ok).map((j) => j.name);
  return failed.length > 1 ? failed.filter((n) => n !== "verify") : failed;
};

/** A team whose repository declares a deploy target (in the team's workspace, or with `personal` in Ana's own) and whose CI runs on pull requests. */
export async function world(opts: { personal?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana", github_username: "ana" } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", github_username: "bo" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1 } as any);
    for (const u of [ana, bo]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1, visibility: "summary" } as any);
    const conv = (user: any, title: string) => ctx.db.insert("conversations", { user_id: user, team_id: team, session_id: title, title, status: "active", is_private: false, started_at: 1, updated_at: 1 } as any);
    const anaConv = await conv(ana, "ana's session");
    const boConv = await conv(bo, "bo's session");
    await ctx.db.insert("deploy_targets", {
      ...(opts.personal ? { workspace: `user:${ana}` } : { workspace: `team:${team}`, team_id: team }),
      repository: REPO, name: "web", runs: "push", live: { kind: "marker" }, policy: "auto", paths: [], workflow: "deploy.yml",
      publisher_user_id: ana, published_at: 1, updated_at: 1,
    } as any);
    await ctx.db.insert("ci_workflows", { repository: REPO, path: ".github/workflows/ci.yml", seen_at: 1 });
    return { ana, bo, team, anaConv, boConv };
  });

  /**
   * A commit on main at `n`, by `author` and pushed by them unless `pushedBy` says otherwise, from `session` when its
   * message carries the trailer. `mainAt` places it on the branch (long ago by default).
   */
  const commit = (n: number, author: "ana" | "bo" | "eve", session?: any, o: { pushedBy?: string; mainAt?: number } = {}) =>
    t.run(async (ctx) => {
      await ctx.db.insert("commits", {
        sha: sha(n), message: `change ${n}${session ? `\n\nCodecast-Session: ${session}` : ""}`, author_name: author, author_email: `${author}@x`, author_login: author,
        timestamp: 1000 + n, files_changed: 1, insertions: 1, deletions: 0, repository: REPO, team_id: ids.team, branch: "main", main_at: o.mainAt ?? 1000 + n,
        pushed_by: o.pushedBy ?? author,
      } as any);
    });

  let runId = 500;
  /** A finished run of CI on main at `n`, claimed the way the webhook drain claims it. */
  const claim = (n: number, conclusion: "success" | "failure", attempt = 1, id = ++runId) =>
    t.run(async (ctx) => {
      const payload = { workflow_run: { id, event: "push", path: ".github/workflows/ci.yml", run_attempt: attempt } };
      const ci = { repository: REPO, workflow: "CI", ok: conclusion === "success", conclusion, at: 1000 + n, url: `https://github.com/${REPO}/actions/runs/${id}`, sha: sha(n), branch: "main", run_id: String(id) };
      const claimed = await noteMainCiRun(ctx, ci, payload);
      const row = await ctx.db.query("main_ci_runs").withIndex("by_repository_run", (q) => q.eq("repository", REPO).eq("run_id", String(id))).first();
      return { claimed, row: row!._id, id };
    });
  const settle = (row: any, attempt: number, verdict: "green" | "red" | "rerunning" | "unproven" | "lost", jobs: any[], failing: CiFailure[] = [], o: { reran?: boolean; rerun_refused?: string; listed_jobs?: string[] } = {}) =>
    t.mutation(internal.mainRed.settle, { run: row, attempt, verdict, jobs, failed: verdict === "green" ? [] : ownFailures(jobs), failing, reran: o.reran ?? attempt > 1, ...(o.rerun_refused ? { rerun_refused: o.rerun_refused } : {}), ...(o.listed_jobs ? { listed_jobs: o.listed_jobs } : {}) });
  /** A run that is red on both attempts: the jobs its failures name failed, and verify with them. */
  const red = async (n: number, failing: CiFailure[], jobs = jobsFailing(...new Set(failing.map((f) => f.job)))) => {
    const first = await claim(n, "failure");
    await settle(first.row, 1, "rerunning", jobs, failing);
    const second = await claim(n, "failure", 2, first.id);
    return await settle(second.row, 2, "red", jobs, failing);
  };
  const green = async (n: number, jobs = CLI_JOBS) => {
    const r = await claim(n, "success");
    return await settle(r.row, 1, "green", jobs);
  };
  const events = (kind: string) => t.run(async (ctx) => (await ctx.db.query("external_events").collect()).filter((e) => e.kind === kind));
  const briefs = (conv: any) => t.run(async (ctx) => await ctx.db.query("pending_messages").filter((q) => q.eq(q.field("conversation_id"), conv)).collect());
  return { t, ...ids, commit, claim, settle, red, green, events, briefs };
}
