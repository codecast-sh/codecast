// Generated PR guides (prGuides.ts): who may start and read one, one write at
// a time per pull request, and the team's daily spend cap. The model call
// itself is covered by lib/prGuidePrompt.test.ts; here begin/finish/forPr run
// against the real schema.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { PR_GUIDE_DAILY_CAP_USD, PR_GUIDE_WRITING_STALE_MS } from "./prGuides";

setDefaultTimeout(120_000);

const PATCH = "@@ -1,1 +1,2 @@\n a\n+b";

async function setup(files: any[] = [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: PATCH }]) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Ada", email: "ada@example.com" } as any);
    const stranger = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com" } as any);
    const team = await ctx.db.insert("teams", { name: "Mine", invite_code: "MINE1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: me, team_id: team, role: "member", joined_at: 1 } as any);
    const pr = await ctx.db.insert("pull_requests", {
      team_id: team, github_pr_id: 1, repository: "acme/app", number: 1, title: "Fix", body: "why",
      state: "open", author_github_username: "ada", linked_session_ids: [], created_at: 1, updated_at: 1,
      head_sha: "abc", files,
    } as any);
    return { me, stranger, team, pr };
  });
  return { t, ...ids };
}

describe("prGuides", () => {
  test("begin reserves a writing row on the head commit; finish makes it ready; forPr reads it for a member only", async () => {
    const { t, me, stranger, pr } = await setup();
    const started = await t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me });
    expect(started.input.files[0].patch).toBe(PATCH);
    expect(started.input.title).toBe("Fix");
    let read: any = await t.withIdentity({ subject: `${me}|s` }).query(api.prGuides.forPr, { pr_id: pr });
    expect(read.latest).toMatchObject({ status: "writing", head_sha: "abc" });
    expect(read.guide).toBeNull();

    await t.mutation(internal.prGuides.finish, {
      guide_id: started.guide_id, summary: "S", steps: [{ title: "B", why: "w", file: "a.ts", start: 2, end: 2 }],
      input_tokens: 10, output_tokens: 20, cost_usd: 0.01,
    });
    read = await t.withIdentity({ subject: `${me}|s` }).query(api.prGuides.forPr, { pr_id: pr });
    expect(read.guide).toMatchObject({ status: "ready", summary: "S", cost_usd: 0.01 });
    expect(read.guide.steps).toHaveLength(1);
    expect(read.latest._id).toBe(read.guide._id);

    expect(await t.withIdentity({ subject: `${stranger}|s` }).query(api.prGuides.forPr, { pr_id: pr })).toBeNull();
    await expect(t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: stranger })).rejects.toThrow(/access denied/);
  });

  test("a failed rewrite is the latest attempt but never hides the guide already written", async () => {
    const { t, me, pr } = await setup();
    const first = await t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me });
    await t.mutation(internal.prGuides.finish, { guide_id: first.guide_id, steps: [{ title: "B", why: "w", file: "a.ts" }] });
    const second = await t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me });
    await t.mutation(internal.prGuides.finish, { guide_id: second.guide_id, error: "no answer" });
    const read: any = await t.withIdentity({ subject: `${me}|s` }).query(api.prGuides.forPr, { pr_id: pr });
    expect(read.latest).toMatchObject({ status: "failed", error: "no answer" });
    expect(read.guide._id).toBe(first.guide_id);
  });

  test("one write at a time per pull request, until the writing row goes stale", async () => {
    const { t, me, pr } = await setup();
    const { guide_id } = await t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me });
    await expect(t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me })).rejects.toThrow(/already being written/);
    await t.run((ctx) => ctx.db.patch(guide_id, { created_at: Date.now() - PR_GUIDE_WRITING_STALE_MS - 1 }));
    await t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me });
  });

  test("a team past its daily cap cannot start another; spend older than a day no longer counts", async () => {
    const { t, me, team, pr } = await setup();
    const spent = await t.run((ctx) => ctx.db.insert("pr_guides", {
      pr_id: pr, team_id: team, status: "ready", model: "m", prompt_version: "v", requested_by: me,
      created_at: Date.now() - 1000, cost_usd: PR_GUIDE_DAILY_CAP_USD,
    }));
    await expect(t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me })).rejects.toThrow(/spent its/);
    await t.run((ctx) => ctx.db.patch(spent, { created_at: Date.now() - 25 * 60 * 60_000 }));
    await t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me });
  });

  test("a pull request with no synced files cannot start one", async () => {
    const { t, me, pr } = await setup([]);
    await expect(t.mutation(internal.prGuides.begin, { pr_id: pr, user_id: me })).rejects.toThrow(/No file changes/);
  });
});
