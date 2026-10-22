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
