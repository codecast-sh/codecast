import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { CONVERSATION_ROW_TABLES } from "./lib/conversationRows";
import { ASK_RATE, askRateKey } from "./sessionAsk";

// `/btw` side answers: the composer's askSideQuestion dispatch lands a pending
// row, the scheduled answer reads the transcript with the cheap model (no
// tools) for the person who asked, and the row reads back answered, private
// to the asker. Nothing reaches the agent or its transcript.

setDefaultTimeout(30_000);
const S0 = 1_760_000_000_000;
const REPLY = "It capped retries at 8 (msg 5).";

let bodies: string[] = [];
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
let reply: () => Response = () =>
  new Response(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: REPLY }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
beforeEach(() => {
  bodies = [];
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    bodies.push(init.body);
    return reply();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

/** The answer runs in a scheduled action: let it start, then wait for it. */
const settle = async (t: { finishInProgressScheduledFunctions: () => Promise<void> }) => {
  await new Promise((done) => setTimeout(done, 20));
  await t.finishInProgressScheduledFunctions();
};

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner" } as any);
    const stranger = await ctx.db.insert("users", { name: "Stranger" } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: "s-btw", started_at: S0, updated_at: S0, title: "Tune the sync retry loop",
      message_count: 6, is_private: true, status: "active",
    } as any);
    const rows = [
      { role: "user", content: "The sync loop retries forever on a 500. Cap it." },
      { role: "assistant", content: "I'll cap retries with MAX_RETRIES = 5 and exponential backoff." },
      { role: "user", content: "5 is too low for flaky mobile links, make it 8." },
      { role: "assistant", content: "Raised MAX_RETRIES to 8; backoff unchanged." },
    ];
    for (const [i, row] of rows.entries()) await ctx.db.insert("messages", { conversation_id: conv, timestamp: S0 + i * 1000, ...row } as any);
    return { owner, stranger, conv };
  });
  const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|test` });
  const ask = (u: Id<"users">, question: string, clientId: string) =>
    as(u).mutation(api.dispatch.dispatch, { action: "askSideQuestion", args: [String(ids.conv), question, clientId] });
  const list = (u: Id<"users">) => as(u).query(api.sideAnswers.listForConversation, { conversation_id: String(ids.conv) });
  const messageCount = () => t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_conversation_id", (q) => q.eq("conversation_id", ids.conv)).collect()).length);
  return { t, ...ids, ask, list, messageCount };
}

describe("side answers", () => {
  test("a question lands pending, is answered from the transcript, and stays out of it", async () => {
    const s = await seed();
    expect(await s.ask(s.owner, "  What retry cap did we settle on?  ", "btw:1")).toMatchObject({ ok: true });

    const [pending] = await s.list(s.owner);
    expect(pending).toMatchObject({ client_id: "btw:1", question: "What retry cap did we settle on?", status: "pending" });

    await settle(s.t);
    const [answered] = await s.list(s.owner);
    expect(answered).toMatchObject({ status: "answered", answer: REPLY });
    expect(answered.answered_at).toBeGreaterThan(0);

    // The cheap model read the transcript, with no tools and no temperature.
    const body = JSON.parse(bodies[bodies.length - 1]);
    expect(body.tools).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("Raised MAX_RETRIES to 8");

    expect(await s.messageCount()).toBe(4);
  });

  test("one question spends one unit of the hour, at ask time", async () => {
    const s = await seed();
    await s.ask(s.owner, "What changed?", "btw:unit");
    await settle(s.t);
    const row = await s.t.run((ctx) => ctx.db.query("ip_rate_limits").withIndex("by_key", (q) => q.eq("key", askRateKey(String(s.owner)))).first());
    expect(row?.count).toBe(1);
  });

  test("a row the answer never settled is settled failed at the bound", async () => {
    const s = await seed();
    await s.ask(s.owner, "What changed?", "btw:stuck");
    const [row] = await s.list(s.owner);
    await s.t.mutation(internal.sideAnswers.expire, { id: row._id as any });
    expect((await s.list(s.owner))[0]).toMatchObject({ status: "failed", error_code: "TIMEOUT" });
    // An answered row is left alone.
    await s.ask(s.owner, "Why 8?", "btw:done");
    await settle(s.t);
    const answered = (await s.list(s.owner)).find((r) => r.client_id === "btw:done")!;
    await s.t.mutation(internal.sideAnswers.expire, { id: answered._id as any });
    expect((await s.list(s.owner)).find((r) => r.client_id === "btw:done")).toMatchObject({ status: "answered" });
  });

  test("a redriven send is one row", async () => {
    const s = await seed();
    await s.ask(s.owner, "Why 8?", "btw:dup");
    await s.ask(s.owner, "Why 8?", "btw:dup");
    expect(await s.list(s.owner)).toHaveLength(1);
    await settle(s.t);
  });

  test("someone who cannot read the session is refused and sees nothing", async () => {
    const s = await seed();
    await s.ask(s.owner, "What changed?", "btw:o");
    expect(await s.ask(s.stranger, "What changed?", "btw:s")).toEqual({ error: "You do not have access to read this session" });
    expect(await s.list(s.stranger)).toEqual([]);
    await settle(s.t);
  });

  test("a spent hour is refused at once, with no row and no scheduled answer", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => { await ctx.db.insert("ip_rate_limits", { key: askRateKey(String(s.owner)), count: ASK_RATE.max, window_start: Date.now() } as any); });
    const res = await s.ask(s.owner, "What changed?", "btw:rate");
    expect(res).toMatchObject({ error: expect.stringContaining("You have asked a lot this hour") });
    expect(await s.list(s.owner)).toEqual([]);
  });

  test("an empty or oversized question is refused before any row", async () => {
    const s = await seed();
    expect(await s.ask(s.owner, "   ", "btw:e")).toMatchObject({ error: expect.any(String) });
    expect(await s.ask(s.owner, "x".repeat(5000), "btw:big")).toMatchObject({ error: expect.any(String) });
    expect(await s.list(s.owner)).toEqual([]);
  });

  test("a refused model call settles the row failed with the API's reason", async () => {
    reply = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low." } }), { status: 400 });
    try {
      const s = await seed();
      await s.ask(s.owner, "What changed?", "btw:f");
      await settle(s.t);
      const [failed] = await s.list(s.owner);
      expect(failed).toMatchObject({ status: "failed", error_code: "MODEL_FAILED" });
      expect(failed.error_message).toContain("credit balance is too low");
    } finally {
      reply = () => new Response(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: REPLY }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
    }
  });

  test("deleting the session purges its side answers", async () => {
    expect(CONVERSATION_ROW_TABLES.some(([table]) => table === "side_answers")).toBe(true);
    const s = await seed();
    await s.ask(s.owner, "What changed?", "btw:p");
    await settle(s.t);
    await s.t.mutation(internal.sessionDelete.purgeConversationRows, { conversation_id: String(s.conv) });
    expect(await s.t.run((ctx) => ctx.db.query("side_answers").collect())).toEqual([]);
  });
});
