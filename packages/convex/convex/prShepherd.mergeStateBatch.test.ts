// A push to a base branch refreshes the merge state of every open PR aimed at
// it. A repo with hundreds of open PRs used to schedule one job per PR (plus a
// retry each), which held the scheduler's slots for minutes after every merge
// to main and delayed every other scheduled write in prod. The fan-out now
// goes out as batches, and a batch re-asks only the PRs GitHub had no answer for.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
};

const REPO = "acme/app";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function setup(openOnMain: number) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 0, invite_code: "acme" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", team_id: team, github_access_token: "tok" } as any);
    // The push handler routes by the App install; the refresh reads with the
    // linked session's user token (no install token is minted under test).
    await ctx.db.insert("github_app_installations", {
      team_id: team, installation_id: 7, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all",
    } as any);
    const session = await ctx.db.insert("conversations", {
      user_id: ana, team_id: team, agent_type: "claude_code", session_id: "s1", started_at: 0, updated_at: 0, message_count: 0, status: "active",
    } as any);
    const pr = (number: number, base_ref: string) => ctx.db.insert("pull_requests", {
      team_id: team, github_pr_id: 1000 + number, repository: REPO, number, title: `PR ${number}`, body: "", state: "open",
      author_github_username: "ana", linked_session_ids: [session], created_at: 0, updated_at: 0, head_ref: `ana/pr-${number}`, base_ref,
    } as any);
    const onMain: Id<"pull_requests">[] = [];
    for (let n = 1; n <= openOnMain; n++) onMain.push(await pr(n, "main"));
    const elsewhere = await pr(9999, "release");
    return { team, onMain, elsewhere };
  });
  const pending = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((j) => j.state.kind === "pending"));
  return { t, ids, pending };
}

describe("merge state refresh after a push to a base branch", () => {
  test("goes out in batches of 100, never one job per PR", async () => {
    const { t, ids, pending } = await setup(250);
    const event_id = await t.run(async (ctx) => ctx.db.insert("github_webhook_events", {
      delivery_id: "d-1", event_type: "push", processed: false, created_at: 0,
      payload: JSON.stringify({
        ref: "refs/heads/main", after: "abc", repository: { full_name: REPO }, pusher: { name: "ana" },
        commits: [{ id: "abc", message: "fix: x", timestamp: new Date(0).toISOString(), author: { name: "Ana", email: "a@x", username: "ana" }, distinct: true }],
      }),
    } as any));
    await t.mutation(internal.githubWebhooks.processPushEvent, { event_id });

    const jobs = await pending();
    expect(jobs.filter((j) => j.name.endsWith(":refreshMergeState"))).toHaveLength(0);
    const batches = jobs.filter((j) => j.name.endsWith(":refreshMergeStates"));
    expect(batches.map((j) => (j.args[0] as any).pr_ids.length)).toEqual([100, 100, 50]);
    const scheduled = batches.flatMap((j) => (j.args[0] as any).pr_ids as string[]);
    expect(new Set(scheduled)).toEqual(new Set(ids.onMain as string[]));
    expect(scheduled).not.toContain(ids.elsewhere);
  });

  test("a batch writes the answers and re-asks only the PRs GitHub had not computed", async () => {
    const { t, ids, pending } = await setup(6);
    // GitHub answers mergeable for even PR numbers and null (still computing) for odd ones.
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      const pull = url.match(/\/pulls\/(\d+)$/);
      if (pull) {
        const n = Number(pull[1]);
        return new Response(JSON.stringify({
          mergeable: n % 2 === 0 ? true : null, mergeable_state: n % 2 === 0 ? "clean" : "unknown",
          base: { ref: "main", sha: "b" }, head: { ref: `ana/pr-${n}`, sha: `h${n}` }, draft: false, requested_reviewers: [],
        }));
      }
      if (url.includes("/compare/")) return new Response(JSON.stringify({ behind_by: 2 }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await t.action(internal.prShepherd.refreshMergeStates, { pr_ids: ids.onMain, attempt: 0 });

    const rows = await t.run(async (ctx) => Promise.all(ids.onMain.map((id) => ctx.db.get(id))));
    for (const pr of rows) {
      expect(pr!.behind_by).toBe(2);
      expect(pr!.mergeable).toBe(pr!.number % 2 === 0 ? true : undefined);
    }
    const retries = (await pending()).filter((j) => j.name.endsWith(":refreshMergeStates"));
    expect(retries).toHaveLength(1);
    expect((retries[0].args[0] as any).attempt).toBe(1);
    expect(new Set((retries[0].args[0] as any).pr_ids)).toEqual(new Set(rows.filter((p) => p!.number % 2 === 1).map((p) => p!._id)));
  });
});
