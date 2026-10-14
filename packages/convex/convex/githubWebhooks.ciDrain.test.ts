// CI deliveries drain per repository. A busy repository's CI sends a check_run
// per job per commit (littlebird: ~72 per PR head, 418 for one commit on main)
// and one scheduled job per delivery held the scheduler's slots for many
// minutes, delaying every other scheduled write in prod. A delivery now joins
// its repository's queue, the first one schedules a drain, and the drain folds
// a batch: one write per PR and one merge state refresh per settled PR.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./githubWebhooks.ts": () => import("./githubWebhooks"),
  "./githubApp.ts": () => import("./githubApp"),
  "./prShepherd.ts": () => import("./prShepherd"),
  "./changes.ts": () => import("./changes"),
  "./changesSchedule.ts": () => import("./changesSchedule"),
  "./teamFeatures.ts": () => import("./teamFeatures"),
  "./taskWaits.ts": () => import("./taskWaits"),
};

const REPO = "acme/app";
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 0, invite_code: "acme" } as any);
    await ctx.db.insert("github_app_installations", {
      team_id: team, installation_id: 7, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all",
    } as any);
    const pr = await ctx.db.insert("pull_requests", {
      team_id: team, github_pr_id: 1012, repository: REPO, number: 12, title: "PR 12", body: "", state: "open",
      author_github_username: "ana", linked_session_ids: [], created_at: 0, updated_at: 0, head_ref: "ana/pr-12", base_ref: "main", head_sha: HEAD,
    } as any);
    return { team, pr };
  });

  let delivery = 0;
  const deliver = (event_type: string, body: Record<string, unknown>) =>
    t.mutation(internal.githubWebhooks.storeWebhookEvent, {
      delivery_id: `d-${++delivery}`, event_type, action: "completed",
      payload: JSON.stringify({ repository: { full_name: REPO }, sender: { login: "ci" }, ...body }),
    });
  const checkRun = (id: number, head: string, prNumbers: number[]) => deliver("check_run", {
    check_run: {
      id, name: `job ${id}`, status: "completed", conclusion: "success", head_sha: head, html_url: `https://ci/${id}`,
      pull_requests: prNumbers.map((number) => ({ number })), check_suite: { id: 900 }, app: { slug: "github-actions" },
    },
  });
  const pending = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((j) => j.state.kind === "pending"));
  const named = async (suffix: string) => (await pending()).filter((j) => j.name.endsWith(suffix));
  const unprocessed = () => t.run(async (ctx) => (await ctx.db.query("github_webhook_events").collect()).filter((e) => !e.processed));
  const drain = () => t.mutation(internal.githubWebhooks.drainCiEvents, { repository: REPO });
  return { t, ids, deliver, checkRun, named, unprocessed, drain };
}

describe("CI deliveries drain per repository", () => {
  test("a matrix of deliveries schedules one drain, not one job each", async () => {
    const s = await setup();
    await s.deliver("workflow_run", { workflow_run: { id: 5, check_suite_id: 900, event: "pull_request", head_sha: HEAD, status: "completed" } });
    for (let i = 0; i < 72; i++) await s.checkRun(1000 + i, HEAD, [12]);
    for (let i = 0; i < 5; i++) await s.checkRun(2000 + i, MAIN, []);

    expect(await s.named(":drainCiEvents")).toHaveLength(1);
    for (const old of [":processCheckRunEvent", ":processWorkflowRunEvent", ":processCheckSuiteEvent"]) {
      expect(await s.named(old)).toHaveLength(0);
    }
    expect(await s.unprocessed()).toHaveLength(78);
  });

  test("a drain folds the batch into one PR write and asks for its merge state once", async () => {
    const s = await setup();
    await s.deliver("workflow_run", { workflow_run: { id: 5, check_suite_id: 900, event: "pull_request", head_sha: HEAD, status: "completed" } });
    for (let i = 0; i < 72; i++) await s.checkRun(1000 + i, HEAD, [12]);
    for (let i = 0; i < 5; i++) await s.checkRun(2000 + i, MAIN, []);

    const result = await s.drain();
    expect(result).toMatchObject({ events: 78, prs: 1, settled: 1, failed: [] });
    expect(await s.unprocessed()).toHaveLength(0);

    const pr = await s.t.run(async (ctx) => ctx.db.get(s.ids.pr));
    expect(pr!.checks).toHaveLength(72);
    expect(pr!.checks_state).toBe("success");
    // The workflow_run in the same batch landed first, so each check knows its event.
    expect(pr!.checks!.every((c: any) => c.event === "pull_request")).toBe(true);

    const refreshes = await s.named(":refreshMergeStates");
    expect(refreshes).toHaveLength(1);
    expect((refreshes[0].args[0] as any).pr_ids).toEqual([s.ids.pr]);
    expect(await s.named(":refreshMergeState")).toHaveLength(0);

    const green = await s.t.run(async (ctx) => (await ctx.db.query("external_events").collect())
      .filter((e: any) => e.kind === "pr_check" && e.title === "CI passed on PR #12"));
    expect(green).toHaveLength(1);
  });

  test("a queue longer than one batch drains in more than one pass", async () => {
    const s = await setup();
    for (let i = 0; i < 130; i++) await s.checkRun(1000 + i, HEAD, [12]);
    expect((await s.drain()).events).toBe(100);
    expect(await s.unprocessed()).toHaveLength(30);
    // The pass that hit the batch size scheduled the next (plus the first delivery's own drain).
    expect((await s.named(":drainCiEvents")).length).toBeGreaterThanOrEqual(2);
    expect((await s.drain()).events).toBe(30);
    expect(await s.unprocessed()).toHaveLength(0);
  });

  test("a delivery after the drain emptied the queue schedules a fresh drain", async () => {
    const s = await setup();
    await s.checkRun(1000, HEAD, [12]);
    await s.drain();
    const before = (await s.named(":drainCiEvents")).length;
    await s.checkRun(1001, HEAD, [12]);
    expect((await s.named(":drainCiEvents")).length).toBe(before + 1);
  });

  test("the catch-up sweep re-drains a queue whose drain was lost", async () => {
    const s = await setup();
    await s.checkRun(1000, HEAD, [12]);
    // The scheduled drain died: the delivery is still waiting three minutes on.
    await s.t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.name.endsWith(":drainCiEvents")) await ctx.scheduler.cancel(job._id);
      }
      for (const e of await ctx.db.query("github_webhook_events").collect()) await ctx.db.patch(e._id, { created_at: Date.now() - 3 * 60_000 });
    });
    expect(await s.named(":drainCiEvents")).toHaveLength(0);
    await s.t.mutation(internal.githubWebhooks.processCommentWebhooks, { limit: 50 });
    expect(await s.named(":drainCiEvents")).toHaveLength(1);
  });
});
