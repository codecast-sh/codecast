// A commit naming a task that lands on its repository's default branch stamps
// the task's landed commit (lib/taskLanded), which the line reads as the fix's
// merge (ct-57458 reached Union's main as a commit, no pull request). A push
// to any other branch stamps nothing, and an older commit never replaces a newer one.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./changes.ts": () => import("./changes"),
  "./changesSchedule.ts": () => import("./changesSchedule"),
  "./githubWebhooks.ts": () => import("./githubWebhooks"),
  "./teamFeatures.ts": () => import("./teamFeatures"),
};

const REPO = "acme/app";
const NOW = Date.parse("2026-10-13T12:00:00Z");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, invite_code: "acme" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "admin", joined_at: NOW - 1, visibility: "full" } as any);
    await ctx.db.insert("github_app_installations", {
      team_id: team, installation_id: 7, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all",
    } as any);
    const task = await ctx.db.insert("tasks", {
      short_id: "ct-57458", title: "Intro email", status: "in_review", team_id: team, created_by: ana, created_at: NOW, updated_at: NOW,
    } as any);
    return { team, task };
  });
  let n = 0;
  const push = async (branch: string, sha: string, at: number) => {
    const payload = {
      ref: `refs/heads/${branch}`, after: sha, pusher: { name: "ana" },
      repository: { full_name: REPO, default_branch: "main" },
      commits: [{ id: sha, message: "fix(broker): intro email says which side offers what (ct-57458)", timestamp: new Date(at).toISOString(), author: { name: "Ana", email: "a@acme.dev", username: "ana" }, modified: ["x.ts"], distinct: true }],
    };
    const event_id = await t.run(async (ctx) => ctx.db.insert("github_webhook_events", {
      delivery_id: `d-${n++}`, event_type: "push", payload: JSON.stringify(payload), processed: false, created_at: at,
    } as any));
    await t.mutation(internal.githubWebhooks.processPushEvent, { event_id });
  };
  const landed = () => t.run(async (ctx) => (await ctx.db.get(ids.task))?.landed ?? null);
  return { t, push, landed };
}

describe("a task's landed commit", () => {
  test("a push to the default branch stamps it; a branch push does not", async () => {
    const s = await setup();
    await s.push("codecast/line-ct-57458", "b1", NOW + 1000);
    expect(await s.landed()).toBeNull();
    await s.push("main", "m1", NOW + 2000);
    expect(await s.landed()).toEqual({ sha: "m1", at: NOW + 2000, url: `https://github.com/${REPO}/commit/m1`, repository: REPO, branch: "main" });
  });

  test("an older landing never replaces a newer one", async () => {
    const s = await setup();
    await s.push("main", "m2", NOW + 5000);
    await s.push("main", "m1", NOW + 3000);
    expect((await s.landed())?.sha).toBe("m2");
  });
});
