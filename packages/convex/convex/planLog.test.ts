import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { FIRST_READ_LIMIT, unreadLogEntries } from "./planLog";

setDefaultTimeout(30_000);
const api = anyApi as any;
const TOKEN = "g".repeat(64);
const T0 = 1_790_000_000_000;

async function world(policy: "lead" | "shared-log") {
  const t = convexTest(schema, allModules);
  const me = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    return me;
  });
  const plan = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Shared log", messaging_policy: policy });
  for (const session_id of ["sess-a", "sess-b"]) {
    await t.run(async (ctx) => {
      await ctx.db.insert("conversations", {
        user_id: me, session_id, agent_type: "claude_code", status: "active", message_count: 0,
        started_at: T0, updated_at: T0, active_plan_id: plan.id, short_id: `c-${session_id}`, title: `Agent ${session_id}`,
      } as any);
    });
  }
  const comment = (session_id: string, type: string, content: string) =>
    t.mutation(api.plans.addComment, { api_token: TOKEN, short_id: plan.short_id, session_id, type, content });
  const unread = (session_id: string) => t.mutation(api.planLog.unread, { api_token: TOKEN, session_id });
  return { comment, unread, plan };
}

test("a shared-log plan delivers each fact, fail and interface once, never the reader's own", async () => {
  const { comment, unread, plan } = await world("shared-log");
  await comment("sess-a", "fact", "the cache keys on host");
  await comment("sess-a", "progress", "halfway");
  await comment("sess-a", "fail", "a global lock deadlocks the pusher");
  await comment("sess-b", "interface", "my own contract");

  const first = await unread("sess-b");
  expect(first.plan_short_id).toBe(plan.short_id);
  expect(first.entries.map((e: any) => [e.type, e.content])).toEqual([
    ["fact", "the cache keys on host"],
    ["fail", "a global lock deadlocks the pusher"],
  ]);
  expect(first.entries[0]).toMatchObject({ session: "c-sess-a", title: "Agent sess-a" });
  expect((await unread("sess-b")).entries).toEqual([]);

  await new Promise((r) => setTimeout(r, 2));
  await comment("sess-a", "interface", "plans.messaging_policy: lead | shared-log");
  expect((await unread("sess-b")).entries.map((e: any) => e.content)).toEqual(["plans.messaging_policy: lead | shared-log"]);
  // Another session keeps its own cursor.
  expect((await unread("sess-a")).entries.map((e: any) => e.content)).toEqual(["my own contract"]);
});

test("a lead plan, or a session with no plan, gets nothing", async () => {
  const { comment, unread } = await world("lead");
  await comment("sess-a", "fact", "the cache keys on host");
  expect(await unread("sess-b")).toEqual({ entries: [] });
  expect(await unread("sess-unknown")).toEqual({ entries: [] });
});

test("the first read is capped to the newest entries", () => {
  const entries = Array.from({ length: FIRST_READ_LIMIT + 5 }, (_, i) => ({ type: "discovery", content: `f${i}`, timestamp: T0 + i }));
  const first = unreadLogEntries(entries, null, new Set());
  expect(first.length).toBe(FIRST_READ_LIMIT);
  expect(first[0].content).toBe("f5");
  expect(unreadLogEntries(entries, T0 + FIRST_READ_LIMIT + 3, new Set()).map((e) => e.content)).toEqual([`f${FIRST_READ_LIMIT + 4}`]);
});
