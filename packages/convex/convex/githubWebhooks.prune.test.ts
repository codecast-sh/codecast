// Stored GitHub deliveries leave once they are past any use (ct-60898).
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { WEBHOOK_EVENT_RETENTION_MS, pruneWebhookEvents } from "./githubWebhooks";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./_generated/server.ts": () => import("./_generated/server"),
  "./githubWebhooks.ts": () => import("./githubWebhooks"),
};

afterEach(() => setSystemTime());

test("deliveries older than the retention window are deleted, newer ones stay", async () => {
  const t = convexTest(schema, modules);
  const start = Date.parse("2026-10-01T00:00:00Z");
  const delivery = (id: string, processed: boolean) => ({ delivery_id: id, event_type: "check_run", payload: "{}", processed, created_at: Date.now() });

  setSystemTime(start);
  await t.run(async (ctx) => {
    await ctx.db.insert("github_webhook_events", delivery("old-processed", true));
    await ctx.db.insert("github_webhook_events", delivery("old-stuck", false));
  });
  setSystemTime(start + WEBHOOK_EVENT_RETENTION_MS + 3600_000);
  await t.run(async (ctx) => { await ctx.db.insert("github_webhook_events", delivery("fresh", false)); });

  const deleted = await t.run((ctx) => (pruneWebhookEvents as any)._handler(ctx, {}));
  expect(deleted).toBe(2);
  const left = await t.run((ctx) => ctx.db.query("github_webhook_events").collect());
  expect(left.map((r) => r.delivery_id)).toEqual(["fresh"]);
});

test("a page resumes after the last row it deleted, and a cron start waits for a running chain", async () => {
  const t = convexTest(schema, modules);
  const start = Date.parse("2026-10-01T00:00:00Z");
  const delivery = (id: string) => ({ delivery_id: id, event_type: "check_run", payload: "{}", processed: true, created_at: Date.now() });

  setSystemTime(start);
  const firstAt = await t.run(async (ctx) => {
    const id = await ctx.db.insert("github_webhook_events", delivery("first"));
    return (await ctx.db.get(id))!._creationTime;
  });
  setSystemTime(start + 1000);
  await t.run(async (ctx) => { await ctx.db.insert("github_webhook_events", delivery("second")); });
  setSystemTime(start + WEBHOOK_EVENT_RETENTION_MS + 3600_000);

  // A continuation page skips everything at or before its cursor.
  expect(await t.run((ctx) => (pruneWebhookEvents as any)._handler(ctx, { after: firstAt }))).toBe(1);
  expect((await t.run((ctx) => ctx.db.query("github_webhook_events").collect())).map((r) => r.delivery_id)).toEqual(["first"]);

  // A chain is marked running: the cron's start leaves the row alone.
  await t.run((ctx) => ctx.db.insert("drain_markers", { key: "github-webhook-events-prune", scheduled: true, scheduled_at: Date.now() }));
  expect(await t.run((ctx) => (pruneWebhookEvents as any)._handler(ctx, {}))).toBe(0);
  expect(await t.run((ctx) => ctx.db.query("github_webhook_events").collect())).toHaveLength(1);
});
