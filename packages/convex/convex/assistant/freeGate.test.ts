// The Free plan's gate (assistant/freeGate.ts) under convex-test, on pi-ai's
// faux provider: an unproven address stops on `verify` with a mailed code and
// picks its ask up once the code is entered; aliases of one mailbox share one
// Free month; the day's ceiling pauses Free turns and alerts once; a paid
// plan is never gated.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { enqueuePendingMessage } from "../pendingMessages";
import { FREE_DAILY_CEILING_USD } from "@codecast/shared/contracts/assistant";
import { setPlan } from "../lib/wallet";
import { allModules as modules, loadPiAi } from "../testModules.testkit";
import { leaseTurn, turnDeps } from "./turns";
import { freeDay, freeDailyCeilingUsd, freeMailbox, nextFreeDay, noteFreeSpend } from "./freeGate";

setDefaultTimeout(120_000);

const pi = await loadPiAi();
let faux: any;
const saved = { ...turnDeps };

beforeAll(() => {
  faux = pi.registerFauxProvider({ models: [{ id: "claude-haiku-4-5-20251001" }, { id: "claude-sonnet-5-5" }], tokenSize: { min: 3, max: 6 } });
});
afterAll(() => faux.unregister());
beforeEach(() => {
  faux.setResponses([]);
  turnDeps.model = (id: string) => faux.getModel(id) ?? faux.getModel();
  turnDeps.apiKeys = () => undefined;
  turnDeps.streamEveryMs = 0;
});
afterEach(() => Object.assign(turnDeps, saved));

const reply = (text: string) => pi.fauxAssistantMessage(text);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type T = ReturnType<typeof convexTest>;

async function settle(t: T, forMs = 20_000) {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await t.finishInProgressScheduledFunctions();
    const due = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => (job.state.kind === "pending" || job.state.kind === "inProgress") && job.scheduledTime <= Date.now() + 3_000,
      ).length,
    );
    if (due === 0) return;
    await pause(20);
  }
  throw new Error("scheduled work did not settle");
}

/** A person and one hosted conversation. `proven` stamps the address as
 *  confirmed, as a Google, Apple or GitHub sign-in or an entered code does. */
async function person(t: T, email: string, proven: boolean) {
  const user = await t.run((ctx) => ctx.db.insert("users", { email, ...(proven ? { emailVerificationTime: 1 } : {}) } as any));
  const authed = t.withIdentity({ subject: user });
  const { conversation_id } = await authed.mutation(api.assistant.entry.startConversation, {});
  return { user, authed, conversationId: conversation_id as Id<"conversations"> };
}

async function say(t: T, conversationId: Id<"conversations">, user: Id<"users">, content: string) {
  await t.run(async (ctx) => {
    await enqueuePendingMessage(ctx, await ctx.db.get(conversationId), user, { content, human: true });
    await leaseTurn(ctx, conversationId);
  });
}

async function view(t: T, conversationId: Id<"conversations">) {
  return t.run(async (ctx) => ({
    conversation: await ctx.db.get(conversationId),
    messages: await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversationId)).collect(),
    turns: await ctx.db.query("assistant_turns").withIndex("by_conversation_status", (q) => q.eq("conversation_id", conversationId)).collect(),
    ledger: await ctx.db.query("wallet_ledger").collect(),
    days: await ctx.db.query("assistant_free_days").collect(),
  }));
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("freeMailbox", () => {
  test("aliases a consumer provider hands out name one mailbox; a company address stays whole", () => {
    expect(freeMailbox("Dana.Lee+news@Gmail.com")).toBe("danalee@gmail.com");
    expect(freeMailbox("d.a.n.a@googlemail.com")).toBe("dana@gmail.com");
    expect(freeMailbox("dana+x@outlook.com")).toBe("dana@outlook.com");
    expect(freeMailbox("dana.lee@outlook.com")).toBe("dana.lee@outlook.com");
    expect(freeMailbox("dana+x@acme.io")).toBe("dana+x@acme.io");
    expect(freeMailbox("+x@gmail.com")).toBeNull();
    expect(freeMailbox("not an address")).toBeNull();
  });

  test("the day and the moment paused turns resume are UTC", () => {
    const at = Date.UTC(2026, 9, 7, 23, 59);
    expect(freeDay(at)).toBe("2026-10-07");
    expect(nextFreeDay(at)).toBe(Date.UTC(2026, 9, 8));
  });
});

describe("the Free gate", () => {
  test("an unproven address stops on verify with a mailed code, and the code picks the ask up", async () => {
    const t = convexTest(schema, modules);
    const { user, authed, conversationId } = await person(t, "dana@example.com", false);
    await say(t, conversationId, user, "Plan a weekend in Lisbon");
    await settle(t);

    let s = await view(t, conversationId);
    expect(s.conversation?.hosted_stop).toBe("verify");
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "budget"]]);
    expect(s.ledger.filter((row) => row.kind === "reserve")).toHaveLength(0);
    const notice = s.messages.at(-1)!;
    expect(notice.subtype).toBe("hosted_notice:verify");
    expect(notice.content).toContain("dana@example.com");
    const code = await t.run((ctx) => ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user)).first());
    expect(code?.email).toBe("dana@example.com");

    // A second ask before confirming reuses the live code instead of mailing another.
    await say(t, conversationId, user, "Hello?");
    await settle(t);
    const again = await t.run((ctx) => ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user)).first());
    expect(again?.code_hash).toBe(code!.code_hash);

    // The test cannot read the mailed code, so it sets one it knows.
    await t.run(async (ctx) => ctx.db.patch(code!._id, { code_hash: await sha256("123456") }));
    await expect(authed.mutation(api.assistant.entry.confirmEmailProof, { code: "000000", conversation_id: conversationId })).rejects.toThrow(/not right/);
    faux.setResponses([reply("Lisbon it is. Here's a plan.")]);
    const confirmed = await authed.mutation(api.assistant.entry.confirmEmailProof, { code: "123456", conversation_id: conversationId });
    expect(confirmed.resumed).toBe(true);
    await settle(t);

    s = await view(t, conversationId);
    expect(s.conversation?.hosted_stop).toBeUndefined();
    expect(s.messages.at(-1)?.content).toBe("Lisbon it is. Here's a plan.");
    expect((await t.run((ctx) => ctx.db.get(user)))?.emailVerificationTime).toBeGreaterThan(0);
    const mailbox = await t.run((ctx) => ctx.db.query("assistant_free_mailboxes").collect());
    expect(mailbox.map((row) => [row.mailbox, row.user_id])).toEqual([["dana@example.com", user]]);
  });

  test("a second account on an alias of a used mailbox gets no Free month of its own", async () => {
    const t = convexTest(schema, modules);
    const first = await person(t, "dana.lee@gmail.com", true);
    faux.setResponses([reply("Done.")]);
    await say(t, first.conversationId, first.user, "Hi");
    await settle(t);
    expect((await view(t, first.conversationId)).messages.at(-1)?.content).toBe("Done.");

    const second = await person(t, "danalee+2@gmail.com", true);
    await say(t, second.conversationId, second.user, "Hi");
    await settle(t);
    const s = await view(t, second.conversationId);
    expect(s.conversation?.hosted_stop).toBe("limit");
    expect(s.messages.at(-1)?.content).toContain("already has a Free plan on another Codecast account");

    // A paid plan pays its own way, so the mailbox no longer matters.
    await t.run((ctx) => setPlan(ctx, second.user, "plus"));
    faux.setResponses([reply("Now on Plus.")]);
    await say(t, second.conversationId, second.user, "Try again");
    await settle(t);
    expect((await view(t, second.conversationId)).messages.at(-1)?.content).toBe("Now on Plus.");
  });

  test("the day's ceiling pauses Free turns, and a Free turn's spend counts toward it", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await person(t, "sam@example.com", true);
    faux.setResponses([reply("Sure.")]);
    await say(t, conversationId, user, "Hi");
    await settle(t);
    let s = await view(t, conversationId);
    const charged = s.ledger.find((row) => row.kind === "charge")!.amount_usd;
    expect(charged).toBeGreaterThan(0);
    expect(s.days).toHaveLength(1);
    expect(s.days[0]).toMatchObject({ day: freeDay(Date.now()), turns: 1 });
    expect(s.days[0].spent_usd).toBeCloseTo(charged, 6);
    expect(s.days[0].alerted_at).toBeUndefined();

    await t.run((ctx) => ctx.db.patch(s.days[0]._id, { spent_usd: freeDailyCeilingUsd() }));
    await say(t, conversationId, user, "And another thing");
    await settle(t);
    s = await view(t, conversationId);
    expect(s.conversation?.hosted_stop).toBe("limit");
    expect(s.messages.at(-1)?.content).toContain("Free requests are paused until");
  });

  test("crossing the ceiling tells the operator once a day", async () => {
    const t = convexTest(schema, modules);
    const { user } = await person(t, "kim@example.com", true);
    const day = freeDay(Date.now());
    await t.run(async (ctx) => {
      await ctx.db.insert("wallets", { user_id: user, plan: "free", period_start: 0, period_end: Date.now() + 1e9, period_cap_usd: 2, period_cost_usd: 0, period_reserved_usd: 0, topup_usd: 0 });
      await ctx.db.insert("assistant_free_days", { day, spent_usd: FREE_DAILY_CEILING_USD - 0.01, turns: 10 });
      await noteFreeSpend(ctx, user, 0.02);
      await noteFreeSpend(ctx, user, 0.02);
    });
    const alerts = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("alertFreeCeiling")),
    );
    expect(alerts).toHaveLength(1);
    const [row] = await t.run((ctx) => ctx.db.query("assistant_free_days").collect());
    expect(row.turns).toBe(12);
    expect(row.alerted_at).toBeGreaterThan(0);
  });
});
