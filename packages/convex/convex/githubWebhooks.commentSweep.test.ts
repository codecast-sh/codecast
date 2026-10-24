// The comment sweep finishes every comment delivery it handles, so deliveries
// that change nothing cannot fill the head of its queue and starve the
// comments behind them (a bot editing comments codecast never stored, 2026-10-16).
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { processCommentWebhooks } from "./githubWebhooks";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./_generated/server.ts": () => import("./_generated/server"),
  "./githubWebhooks.ts": () => import("./githubWebhooks"),
};

const REPO = "codecast-sh/codecast";

function delivery(id: string, action: string, commentId: number, login: string) {
  return {
    delivery_id: id,
    event_type: "issue_comment",
    action,
    processed: false,
    created_at: 0,
    payload: JSON.stringify({
      action,
      repository: { full_name: REPO },
      issue: { number: 55, pull_request: {} },
      comment: { id: commentId, body: "hi", user: { login }, created_at: "2026-10-23T08:56:30Z", updated_at: "2026-10-23T08:56:30Z" },
    }),
  };
}

test("edits to unknown comments are finished, so a later comment still lands", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("pull_requests", {
      repository: REPO, number: 55, title: "migrate move", state: "open", head_ref: "feat/migrate-move", base_ref: "main",
      head_sha: "73af16e2e244", author_github_username: "stevenpollack", linked_session_ids: [], created_at: 1, updated_at: 2,
    } as any);
    for (let i = 0; i < 3; i++) await ctx.db.insert("github_webhook_events", delivery(`bot-${i}`, "edited", 900 + i, "github-actions[bot]"));
    await ctx.db.insert("github_webhook_events", delivery("human", "created", 1, "ashot"));
  });

  const sweep = () => t.run((ctx) => (processCommentWebhooks as any)._handler(ctx, { limit: 3 }));
  expect((await sweep()).results.map((r: any) => r.status)).toEqual(["no-op", "no-op", "no-op"]);
  expect((await sweep()).results.map((r: any) => r.status)).toEqual(["processed"]);

  const comments = await t.run((ctx) => ctx.db.query("review_comments").collect());
  expect(comments.map((c) => c.author_github_username)).toEqual(["ashot"]);
  const pending = await t.run((ctx) => ctx.db.query("github_webhook_events").filter((q) => q.eq(q.field("processed"), false)).collect());
  expect(pending).toHaveLength(0);
});
