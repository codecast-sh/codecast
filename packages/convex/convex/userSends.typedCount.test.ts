// conversations.typed_message_count: one per row of the per-send log that is
// not a picked decision answer. Live logging adds to it once per message, the
// log's deletes take from it, and sendBackfill.countTyped sets it from the log
// for sessions logged before it was kept.
import { expect, jest, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    const conv = () =>
      ctx.db.insert("conversations", {
        user_id: me, agent_type: "claude_code", session_id: crypto.randomUUID(),
        started_at: 1, updated_at: 1, message_count: 0, is_private: false, status: "active",
      } as any);
    return { me, a: await conv(), b: await conv() };
  });
  const message = (c: Id<"conversations">, content: string, timestamp: number) =>
    t.run((ctx) => ctx.db.insert("messages", { conversation_id: c, role: "user", content, timestamp } as any));
  const count = (c: Id<"conversations">) => t.run(async (ctx) => (await ctx.db.get(c))?.typed_message_count);
  return { t, ...ids, message, count };
}

test("each typed message counts once in its session, however often it is recorded", async () => {
  const { t, me, a, message, count } = await seed();
  const first = await message(a, "fix the build", 1000);
  const second = await message(a, "now run the tests", 2000);
  const record = (message_id: Id<"messages">, timestamp: number) =>
    t.mutation(internal.userSends.record, { conversation_id: a, message_id, user_id: me, words: 3, by_person: false, timestamp });
  await record(first, 1000);
  await record(first, 1000);
  await record(second, 2000);
  expect(await count(a)).toBe(2);
});

test("pruning a send from the log takes it off the count", async () => {
  const { t, me, a, message, count } = await seed();
  const typed = await message(a, "fix the build", 1000);
  const relayed = await message(a, '<session-message from="jx12345">hello</session-message>', 2000);
  await t.run(async (ctx) => {
    for (const [message_id, text] of [[typed, "fix the build"], [relayed, "hello"]] as const) {
      await ctx.db.insert("user_sends", { user_id: me, conversation_id: a, message_id, timestamp: 1, words: 1, text, clipped: false });
    }
    await ctx.db.patch(a, { typed_message_count: 2 });
  });
  await t.mutation(internal.sendBackfill.pruneLog, {});
  expect(await count(a)).toBe(1);
});

async function backfill(t: any) {
  jest.useFakeTimers();
  try {
    await t.mutation(internal.sendBackfill.countTyped, {});
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  } finally {
    jest.useRealTimers();
  }
}

test("the backfill sets each session's count from the log, across pages, without picked answers", async () => {
  const { t, me, a, b, message, count } = await seed();
  await t.run(async (ctx) => {
    const send = async (c: Id<"conversations">, n: number, extra: Record<string, unknown> = {}) => {
      for (let i = 0; i < n; i++) {
        const message_id = await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "x", timestamp: i } as any);
        await ctx.db.insert("user_sends", { user_id: me, conversation_id: c, message_id, timestamp: i, words: 1, text: "x", clipped: false, ...extra });
      }
    };
    // More than one page of the walk, so the larger session is cut across steps.
    await send(a, 320);
    await send(b, 4);
    await send(b, 1, { decision: { question: "Ship?", picked: true } });
    await ctx.db.patch(b, { typed_message_count: 99 });
  });
  await backfill(t);
  expect(await count(a)).toBe(320);
  expect(await count(b)).toBe(4);
  // A rerun, and a send logged after it, keep the count exact.
  await t.mutation(internal.userSends.record, { conversation_id: b, message_id: await message(b, "one more", 9000), user_id: me, words: 2, by_person: false, timestamp: 9000 });
  await backfill(t);
  expect(await count(b)).toBe(5);
});

test("a send rebuild's wipe takes the wiped sends off the count", async () => {
  const { t, me, a, message, count } = await seed();
  const typed = await message(a, "fix the build", 1000);
  await t.mutation(internal.userSends.record, { conversation_id: a, message_id: typed, user_id: me, words: 3, by_person: false, timestamp: 1000 });
  expect(await count(a)).toBe(1);
  jest.useFakeTimers();
  try {
    // The rebuild recounts only messages older than its live grace, so this one stays out of the log.
    await t.mutation(internal.sendBackfill.wipe, { after: 0, before: 0, run: "test" });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  } finally {
    jest.useRealTimers();
  }
  const logged = await t.run((ctx) => ctx.db.query("user_sends").collect());
  expect(logged).toHaveLength(0);
  expect(await count(a)).toBe(0);
});
