// The person's Stop and the stop stamp on the row (plan pl-840, polish
// round 10): stopping a running turn ends it as done with its hold settled
// and one line in the transcript, and a turn that stops on a notice marks the
// conversation (hosted_stop) until the next turn starts.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { enqueuePendingMessage, markPendingDelivered } from "../pendingMessages";
import { allModules as modules } from "../testModules.testkit";
import { leaseTurn, STOPPED_LINE } from "./turns";

setDefaultTimeout(60_000);

async function setup() {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", { name: "Dana", emailVerificationTime: 1 } as any));
  const authed = t.withIdentity({ subject: user });
  const conversationId = (await authed.mutation(api.assistant.entry.startConversation, {})).conversation_id as Id<"conversations">;
  // A turn leased for a message, not yet run: the scheduled run is left pending.
  const say = (content: string) => t.run(async (ctx) => {
    await enqueuePendingMessage(ctx, await ctx.db.get(conversationId), user, { content, human: true });
    await leaseTurn(ctx, conversationId);
  });
  const read = () => t.run(async (ctx) => ({
    turns: await ctx.db.query("assistant_turns").collect(),
    messages: await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversationId)).collect(),
    wallet: (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("user_id", user)).first())!,
    conversation: (await ctx.db.get(conversationId))!,
  }));
  return { t, user, authed, conversationId, say, read };
}

describe("the person's Stop", () => {
  test("ends the running turn as done, settles its hold and says so once", async () => {
    const { authed, conversationId, say, read } = await setup();
    await say("Plan a week of dinners");
    expect((await read()).turns.map((turn) => turn.status)).toEqual(["running"]);

    expect(await authed.mutation(api.assistant.entry.stop, { conversation_id: conversationId })).toBe(true);
    const s = await read();
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "done"]]);
    expect(s.turns[0].holding).toBeUndefined();
    expect(s.wallet.period_reserved_usd).toBe(0);
    // The words it was leased for are in the transcript, then the stop, and
    // they do not start the turn over.
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([["user", "Plan a week of dinners"], ["assistant", STOPPED_LINE]]);
    // Nothing running: a second press changes nothing.
    expect(await authed.mutation(api.assistant.entry.stop, { conversation_id: conversationId })).toBe(false);
  });

  test("only the conversation's owner can stop it", async () => {
    const { t, conversationId, say, read } = await setup();
    await say("Plan a week of dinners");
    const stranger = await t.run((ctx) => ctx.db.insert("users", {} as any));
    expect(await t.withIdentity({ subject: stranger }).mutation(api.assistant.entry.stop, { conversation_id: conversationId })).toBe(false);
    expect((await read()).turns.map((turn) => turn.status)).toEqual(["running"]);
  });
});

describe("the stop stamp on the row", () => {
  test("a turn that stops on a notice stamps its kind, and the next turn clears it", async () => {
    const { t, conversationId, say, read } = await setup();
    await say("Plan a week of dinners");
    const [turn] = (await read()).turns;
    // Its run took the message, then died: the lease runs out and the sweep
    // ends it on an error notice.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("pending_messages").collect()) await markPendingDelivered(ctx, row);
      await ctx.db.patch(turn._id, { started_at: Date.now() - 60 * 60_000, run_claimed_at: Date.now() - 60 * 60_000 });
    });
    await t.mutation(internal.assistant.turns.expire, { turn_id: turn._id });
    expect((await read()).conversation.hosted_stop).toBe("error");

    await say("Try again");
    const s = await read();
    expect(s.turns.some((x) => x.status === "running")).toBe(true);
    expect(s.conversation.hosted_stop).toBeUndefined();
  });
});
