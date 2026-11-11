// The Messages feed's reads over the per-send log: one person's sends, newest
// first, paged and tailed by timestamp, with written decision answers kept
// and picked options dropped.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { MY_SEND_SNIPPET } from "./userSends";

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    const other = await ctx.db.insert("users", { name: "Other" } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: me, title: "Fix the build", project_path: "/Users/me/src/app", agent_type: "claude_code",
      session_id: "s1", started_at: 1, updated_at: 1, message_count: 0, status: "active",
    } as any);
    const send = async (user: any, timestamp: number, text: string, extra: Record<string, unknown> = {}) => {
      const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: text, timestamp } as any);
      await ctx.db.insert("user_sends", { user_id: user, conversation_id: conv, message_id: message, timestamp, words: 1, text, clipped: false, ...extra } as any);
      return message;
    };
    for (let i = 1; i <= 5; i++) await send(me, i * 1000, `prompt ${i}`);
    await send(other, 3500, "someone else's prompt");
    await send(me, 6000, "Ship it", { decision: { question: "Which way?", picked: true } });
    await send(me, 7000, "Hold until Thursday", { decision: { question: "Ship now?", picked: false } });
    const long = await send(me, 8000, "x".repeat(MY_SEND_SNIPPET + 50));
    return { me, other, conv, long };
  });
  return { t, ...ids, as: t.withIdentity({ subject: ids.me }) };
}

test("mine pages the viewer's sends newest first and stops at the end", async () => {
  const { as } = await seed();
  const first = await as.query(api.userSends.mine, { limit: 3 });
  // The picked option at 6000 takes its slot in the page and is dropped, so
  // the page is short but the cursor still walks past it.
  expect(first.rows.map((r) => r.timestamp)).toEqual([8000, 7000]);
  expect(first.nextBefore).toBe(6000);
  const second = await as.query(api.userSends.mine, { before: first.nextBefore!, limit: 3 });
  expect(second.rows.map((r) => r.timestamp)).toEqual([5000, 4000, 3000]);
  const rest = await as.query(api.userSends.mine, { before: second.nextBefore!, limit: 10 });
  expect(rest.rows.map((r) => r.timestamp)).toEqual([2000, 1000]);
  expect(rest.nextBefore).toBeNull();
});

test("a picked option is a tap, not typing; a written answer keeps its question", async () => {
  const { as } = await seed();
  const { rows } = await as.query(api.userSends.mine, {});
  expect(rows.some((r) => r.text === "Ship it")).toBe(false);
  expect(rows.find((r) => r.text === "Hold until Thursday")?.question).toBe("Ship now?");
  expect(rows.some((r) => r.text.startsWith("someone else"))).toBe(false);
});

test("rows carry the session and a clipped snippet; fullText reads the rest", async () => {
  const { as, long, other, t } = await seed();
  const { rows } = await as.query(api.userSends.mine, { after: 7500 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ session_title: "Fix the build", project: "app", clipped: true, _id: `ms:${long}` });
  expect(rows[0].text).toHaveLength(MY_SEND_SNIPPET);
  expect((await as.query(api.userSends.fullText, { message_id: long }))?.text).toHaveLength(MY_SEND_SNIPPET + 50);
  expect(await t.withIdentity({ subject: other }).query(api.userSends.fullText, { message_id: long })).toBeNull();
});

test("logHistory fills the log for past sends without touching the day counters, once", async () => {
  const t = convexTest(schema, allModules);
  const { me, conv } = await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: me, title: "Old work", agent_type: "claude_code", session_id: "s1", started_at: 1, updated_at: 1, message_count: 0, status: "active",
    } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "rename the config loader", timestamp: 100 } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: '<session-message from="jx12345">status?</session-message>', timestamp: 200 } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "done", timestamp: 300 } as any);
    return { me, conv };
  });
  for (let i = 0; i < 2; i++) {
    await t.mutation(internal.sendBackfill.logHistory, { user_id: me });
    await t.finishAllScheduledFunctions(() => {});
  }
  const { sends, days } = await t.run(async (ctx) => ({
    sends: await ctx.db.query("user_sends").collect(),
    days: await ctx.db.query("user_send_daily").collect(),
  }));
  expect(sends.map((s) => [s.conversation_id, s.text])).toEqual([[conv, "rename the config loader"]]);
  expect(days).toHaveLength(0);
});
