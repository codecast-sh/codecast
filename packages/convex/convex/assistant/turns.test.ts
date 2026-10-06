// The hosted assistant's turn engine under convex-test, on pi-ai's faux
// provider (plan pl-840, docs/architecture/hosted-assistant.md "The turn"):
// a plain reply, a tool call, an approval answered each way (and answered
// with no usage left), a wallet with no room, a safety stop before a run, a
// run that runs out of time and carries on, input that lands while a turn
// runs, the per-plan turn limit, a dead run's lease expiring, a run
// that fails, and a run that reaches its ceiling. After each, the wallet must
// balance: every turn charged once, nothing left reserved, and the period's
// usage equal to the charges.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { declineText, defineTool, Type, type Tool } from "@platform/agent";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { enqueuePendingMessage, healAndNotifyStuckMessages } from "../pendingMessages";
import { finalizeAnswer } from "../sessionDecisions";
import { decisionAnswerClientId } from "@codecast/shared/contracts";
import { ensureWallet, LEAK_GRACE_MS, reserve } from "../lib/wallet";
import { allModules as modules, loadPiAi } from "../testModules.testkit";
import { toolsFor } from "./tools";
import { ALWAYS_ALLOW, APPROVE, DECLINE, allowScope, alwaysCovers, approvalContext, leaseTurn, systemPrompt, turnDeps, withRules } from "./turns";
import { strandedCalls } from "./history";
import { hostedInputWaits } from "./input";

setDefaultTimeout(120_000);

const pi = await loadPiAi();

let faux: any;
const saved = { ...turnDeps };
/** What the test tools were called with. */
let sent: Array<Record<string, unknown>> = [];

const testTools = (): Tool[] => [
  defineTool({
    name: "send_mail",
    label: "Send an email",
    description: "Sends an email.",
    parameters: Type.Object({ to: Type.Array(Type.String()), subject: Type.String(), body: Type.String() }),
    risk: "write",
    run: (args) => {
      sent.push(args);
      return `Sent to ${args.to.join(", ")}.`;
    },
  }),
  defineTool({
    name: "slow_lookup",
    description: "Looks something up, slowly.",
    parameters: Type.Object({ q: Type.String() }),
    risk: "read",
    run: ({ q }, { signal }) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(`found ${q}`), 2_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("stopped"));
        });
      }),
  }),
];

beforeAll(() => {
  faux = pi.registerFauxProvider({
    models: [
      { id: "claude-haiku-4-5-20251001" },
      { id: "claude-sonnet-5-5" },
      // A model no turn's ceiling can pay for.
      { id: "pricey", cost: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } },
    ],
    tokenSize: { min: 3, max: 6 },
  });
});
afterAll(() => faux.unregister());

beforeEach(() => {
  sent = [];
  faux.setResponses([]);
  turnDeps.model = (id: string) => faux.getModel(id) ?? faux.getModel();
  turnDeps.apiKeys = () => undefined;
  turnDeps.leaseMarginMs = 60_000;
  turnDeps.streamEveryMs = 0;
  turnDeps.toolsFor = async (ctx, userId, conversationId, options) => {
    const set = await toolsFor(ctx, userId, conversationId, options);
    return { ...set, tools: [...set.tools, ...testTools()] };
  };
});
afterEach(() => Object.assign(turnDeps, saved));

async function setup() {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", { name: "Dana", timezone: "America/Los_Angeles" } as any));
  const authed = t.withIdentity({ subject: user });
  const start = async () => (await authed.mutation(api.assistant.entry.startConversation, {})).conversation_id as Id<"conversations">;
  const conversationId = await start();
  return { t, user, conversationId, start };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs scheduled work that is due until none is left: wakes, runs, leases. */
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

/** The person sends a message; the engine leases a turn for it. */
async function say(t: T, conversationId: Id<"conversations">, user: Id<"users">, content: string) {
  await t.run(async (ctx) => {
    const conversation = await ctx.db.get(conversationId);
    await enqueuePendingMessage(ctx, conversation, user, { content, human: true });
    await leaseTurn(ctx, conversationId);
  });
}

async function state(t: T, conversationId: Id<"conversations">, user: Id<"users">) {
  return t.run(async (ctx) => ({
    turns: (await ctx.db.query("assistant_turns").collect()).sort((a, b) => a._creationTime - b._creationTime),
    messages: await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversationId)).collect(),
    pending: await ctx.db.query("pending_messages").collect(),
    wallet: (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("user_id", user)).first())!,
    ledger: await ctx.db.query("wallet_ledger").collect(),
    decisions: await ctx.db.query("session_decisions").collect(),
    rules: await ctx.db.query("assistant_rules").collect(),
    managed: await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId)).first(),
    conversation: await ctx.db.get(conversationId),
  }));
}

/** Every turn charged once, nothing held, usage (above `startUsd`, what the
 *  period had spent before the test) equal to the charges. */
async function expectBalanced(t: T, conversationId: Id<"conversations">, user: Id<"users">, startUsd = 0) {
  const s = await state(t, conversationId, user);
  expect(s.wallet.period_reserved_usd).toBe(0);
  const charges = s.ledger.filter((row) => row.kind === "charge");
  const ended = s.turns.filter((turn) => turn.status !== "running" && turn.status !== "queued");
  expect(charges.length).toBe(ended.length);
  for (const turn of ended) {
    expect(turn.holding).toBeUndefined();
    expect(charges.filter((row) => row.turn_id === turn._id)).toHaveLength(1);
  }
  const charged = charges.reduce((sum, row) => sum + row.amount_usd, 0);
  expect(s.wallet.period_cost_usd - startUsd).toBeCloseTo(charged, 6);
  expect(ended.reduce((sum, turn) => sum + (turn.cost_usd ?? 0), 0)).toBeCloseTo(charged, 6);
  const held = s.ledger.filter((row) => row.kind === "reserve").reduce((sum, row) => sum + row.amount_usd, 0);
  const released = s.ledger.filter((row) => row.kind === "release").reduce((sum, row) => sum + row.amount_usd, 0);
  expect(held).toBeCloseTo(released, 6);
  return s;
}

const reply = (text: string) => pi.fauxAssistantMessage(text);
const callTool = (name: string, args: Record<string, unknown>, id = `call_${name}`) =>
  pi.fauxAssistantMessage([pi.fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

describe("a turn", () => {
  test("a plain reply streams into one row, is charged once, and leaves the conversation done", async () => {
    const { t, user, conversationId } = await setup();
    faux.setResponses([reply("Hello Dana, what can I take off your plate today?")]);
    await say(t, conversationId, user, "Hi there");
    await settle(t);

    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({ status: "done", reason: "done", model: "claude-haiku-4-5-20251001" });
    expect(s.turns[0].cost_usd).toBeGreaterThan(0);
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Hi there"],
      ["assistant", "Hello Dana, what can I take off your plate today?"],
    ]);
    expect(s.messages[1].usage?.output_tokens).toBeGreaterThan(0);
    // The final write carried the usage once, so the conversation counted it.
    expect(s.conversation?.usage_totals?.output).toBe(s.messages[1].usage?.output_tokens);
    expect(s.pending.every((row) => row.status === "delivered")).toBe(true);
    expect(s.managed?.agent_status).toBe("done");
  });

  test("the first message of a new conversation wakes its turn on its own", async () => {
    const t = convexTest(schema, modules);
    const user = await t.run((ctx) => ctx.db.insert("users", {}));
    faux.setResponses([reply("On it.")]);
    const started = await t.withIdentity({ subject: user }).mutation(api.assistant.entry.startConversation, { firstMessage: "Book a dentist" });
    await settle(t);
    const s = await expectBalanced(t, started.conversation_id as Id<"conversations">, user);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "done"]]);
    expect(s.messages.map((m) => m.content)).toEqual(["Book a dentist", "On it."]);
  });

  test("a tool call and its result are stored as rows the transcript renders", async () => {
    const { t, user, conversationId } = await setup();
    faux.setResponses([callTool("list_tasks", {}), reply("You have nothing on your list.")]);
    await say(t, conversationId, user, "What's on my list?");
    await settle(t);

    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({ status: "done", reason: "done" });
    const [ask, call, result, answer] = s.messages;
    expect(ask).toMatchObject({ role: "user", content: "What's on my list?" });
    expect(call.role).toBe("assistant");
    expect(call.tool_calls?.[0]).toMatchObject({ id: "call_list_tasks", name: "list_tasks" });
    expect(result.role).toBe("user");
    expect(result.tool_results?.[0]).toMatchObject({ tool_use_id: "call_list_tasks" });
    expect(answer).toMatchObject({ role: "assistant", content: "You have nothing on your list." });
  });
});

describe("approvals", () => {
  const draft = { to: ["dana@example.com"], subject: "Lunch", body: "Thursday at noon works for me." };

  async function parkOnApproval() {
    const ctx = await setup();
    faux.setResponses([callTool("send_mail", draft, "call_send")]);
    await say(ctx.t, ctx.conversationId, ctx.user, "Tell Dana Thursday works");
    await settle(ctx.t);
    return ctx;
  }

  async function answer(t: T, user: Id<"users">, index: number) {
    await t.run(async (ctx) => {
      const decision = (await ctx.db.query("session_decisions").collect()).find((row) => row.status === "pending")!;
      await finalizeAnswer(ctx, decision, { status: "answered", answer_index: index }, { kind: "user", id: String(user), user_id: user }, { deliver: true });
      await leaseTurn(ctx, decision.conversation_id);
    });
    await settle(t);
  }

  test("a write call parks the turn on a decision that shows the exact draft", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([]);
    expect(s.turns[0]).toMatchObject({
      status: "waiting",
      reason: "approval",
      pending_call: { tool_call_id: "call_send", tool: "send_mail", args: draft },
    });
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]).toMatchObject({ question: "Send an email to Dana?", blocking: true, status: "pending", asked_user_ids: [user] });
    expect(s.decisions[0].options.map((o) => o.label)).toEqual([APPROVE, ALWAYS_ALLOW, DECLINE]);
    expect(s.decisions[0].context_md).toContain("dana@example.com");
    expect(s.decisions[0].context_md).toContain("Thursday at noon works for me.");
    expect(s.managed?.agent_status).toBe("permission_blocked");
    // Waking again before an answer starts nothing.
    await t.mutation(internal.assistant.entry.wake, { conversation_id: conversationId, cause: "continue" });
    await settle(t);
    expect((await state(t, conversationId, user)).turns).toHaveLength(1);
  });

  test("Approve runs the call once and the conversation continues", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("Done, I told Dana Thursday works.")]);
    await answer(t, user, 0);

    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([draft]);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0].status).toBe("done");
    expect(s.turns[1]).toMatchObject({ status: "done", reason: "done", continues: s.turns[0]._id });
    expect(s.turns[1].started_calls).toEqual(["call_send"]);
    const result = s.messages.find((m) => m.tool_results?.[0]?.tool_use_id === "call_send");
    expect(result?.tool_results?.[0].content).toContain("Sent to dana@example.com");
    // The answer's message is a wake, not a line in the transcript.
    expect(s.messages.some((m) => m.content?.startsWith("Decision:"))).toBe(false);
    expect(s.pending.every((row) => row.status === "delivered")).toBe(true);
    expect(s.rules).toEqual([]);
    expect(s.messages[s.messages.length - 1].content).toBe("Done, I told Dana Thursday works.");
  });

  test("Always allow runs the call and stops asking for that recipient", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("Sent.")]);
    await answer(t, user, 1);
    let s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([draft]);
    expect(s.rules).toMatchObject([{ user_id: user, tool: "send_mail", decision: "allow", match: "dana@example.com" }]);

    faux.setResponses([callTool("send_mail", { ...draft, subject: "Again" }, "call_again"), reply("Sent again.")]);
    await say(t, conversationId, user, "Send it again");
    await settle(t);
    s = await expectBalanced(t, conversationId, user);
    expect(sent).toHaveLength(2);
    expect(s.decisions).toHaveLength(1);
    expect(s.turns[s.turns.length - 1]).toMatchObject({ status: "done", reason: "done" });

    // Another recipient still asks.
    faux.setResponses([callTool("send_mail", { ...draft, to: ["lee@example.com"] }, "call_lee")]);
    await say(t, conversationId, user, "Tell Lee too");
    await settle(t);
    s = await expectBalanced(t, conversationId, user);
    expect(sent).toHaveLength(2);
    expect(s.decisions).toHaveLength(2);
  });

  test("Decline answers the call as declined and runs nothing", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("Okay, I won't send it.")]);
    await answer(t, user, 2);
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([]);
    const result = s.messages.find((m) => m.tool_results?.[0]?.tool_use_id === "call_send");
    expect(result?.tool_results?.[0]).toMatchObject({ is_error: true });
    expect(result?.tool_results?.[0].content).toContain("declined");
    expect(s.turns[1]).toMatchObject({ status: "done", reason: "done" });
  });

  test("dismissing the card wakes the conversation and the call is declined", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("No problem, I left it.")]);
    await t.run(async (ctx) => {
      const decision = (await ctx.db.query("session_decisions").collect())[0];
      await finalizeAnswer(ctx, decision, { status: "dismissed" }, { kind: "user", id: String(user), user_id: user }, { deliver: true });
    });
    // No lease by hand: the dismissal's own wake starts the turn.
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([]);
    expect(s.turns.map((turn) => turn.status)).toEqual(["done", "done"]);
    expect(s.messages[s.messages.length - 1].content).toBe("No problem, I left it.");
  });

  test("an answer from someone other than the owner runs nothing", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("I didn't send it.")]);
    await t.run(async (ctx) => {
      const decision = (await ctx.db.query("session_decisions").collect())[0];
      // Written straight to the row, past every resolve path's own refusal.
      await ctx.db.patch(decision._id, { status: "answered", answer_index: 0, answered_by: { kind: "role", id: "r" }, resolved_at: Date.now() });
      await leaseTurn(ctx, conversationId);
    });
    await settle(t);
    await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([]);
  });

  test("writing again instead of answering takes the card down and the call does not run", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("Got it, I'll leave the email.")]);
    await say(t, conversationId, user, "Actually, never mind");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([]);
    expect(s.decisions[0].status).toBe("withdrawn");
    const result = s.messages.find((m) => m.tool_results?.[0]?.tool_use_id === "call_send");
    expect(result?.tool_results?.[0].content).toContain("wrote again");
  });

  test("a routine firing while the card is open waits for the answer", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    await t.run(async (ctx) => {
      const conversation = await ctx.db.get(conversationId);
      // enqueuePendingMessage wakes a hosted conversation itself.
      await enqueuePendingMessage(ctx, conversation, user, { content: "Daily: check the inbox", origin: "scheduler" });
    });
    await settle(t);
    let s = await expectBalanced(t, conversationId, user);
    expect(s.turns).toHaveLength(1);
    expect(s.decisions[0].status).toBe("pending");
    expect(s.messages.some((m) => m.tool_results?.some((r) => r.tool_use_id === "call_send"))).toBe(false);
    expect(await t.run((ctx) => hostedInputWaits(ctx, conversationId))).toBe(true);
    // The stuck-message sweep leaves it alone for as long as the card is open.
    const swept = await t.run((ctx) => healAndNotifyStuckMessages(ctx, Date.now() + 60 * 60_000));
    expect(swept.rewoken).toBe(0);

    // The answer runs the call, then the routine gets a turn of its own.
    faux.setResponses([reply("Sent."), reply("Your inbox is clear.")]);
    await answer(t, user, 0);
    s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([draft]);
    expect(await t.run((ctx) => hostedInputWaits(ctx, conversationId))).toBe(false);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "approval"], ["done", "done"], ["done", "done"]]);
    expect(s.messages.slice(-3).map((m) => [m.role, m.content])).toEqual([
      ["assistant", "Sent."],
      ["user", "Daily: check the inbox"],
      ["assistant", "Your inbox is clear."],
    ]);
  });

  test("the rest of a batch is asked in turn, and input sent meanwhile waits for all of it", async () => {
    const { t, user, conversationId } = await setup();
    const toDana = { ...draft };
    const toLee = { ...draft, to: ["lee@example.com"] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    faux.setResponses([
      async () => {
        entered = true;
        await gate;
        return pi.fauxAssistantMessage([pi.fauxToolCall("send_mail", toDana, { id: "call_a" }), pi.fauxToolCall("send_mail", toLee, { id: "call_b" })], { stopReason: "toolUse" });
      },
    ]);
    await say(t, conversationId, user, "Tell Dana and Lee Thursday works");
    const running = (async () => settle(t))();
    while (!entered) await pause(10);
    await say(t, conversationId, user, "And book a room");
    release();
    await running;
    await settle(t);

    // The first call is asked; the second waits its turn.
    let s = await expectBalanced(t, conversationId, user);
    expect(s.decisions.map((d) => d.status)).toEqual(["pending"]);
    expect(s.turns[0].pending_call?.tool_call_id).toBe("call_a");

    await answer(t, user, 0);
    s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([toDana]);
    // The second call is asked now, not declined, and the typed input still waits.
    expect(s.messages.some((m) => m.tool_results?.some((r) => r.tool_use_id === "call_b"))).toBe(false);
    expect(s.decisions.map((d) => d.status)).toEqual(["answered", "pending"]);
    expect(s.turns[s.turns.length - 1].pending_call?.tool_call_id).toBe("call_b");
    expect(s.pending.find((row) => row.content === "And book a room")?.status).toBe("pending");

    faux.setResponses([reply("Both sent."), reply("Which day should I book the room for?")]);
    await answer(t, user, 0);
    s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([toDana, toLee]);
    expect(s.messages.slice(-3).map((m) => [m.role, m.content])).toEqual([
      ["assistant", "Both sent."],
      ["user", "And book a room"],
      ["assistant", "Which day should I book the room for?"],
    ]);
  });

  test("Always allow given twice for the same people writes one rule", async () => {
    const { t, user, conversationId, start } = await parkOnApproval();
    const other = await start();
    faux.setResponses([callTool("send_mail", draft, "call_other")]);
    await say(t, other, user, "Tell Dana Thursday works");
    await settle(t);
    expect((await state(t, conversationId, user)).decisions.map((d) => d.status)).toEqual(["pending", "pending"]);
    faux.setResponses([reply("Sent."), reply("Sent too.")]);
    await answer(t, user, 1);
    await answer(t, user, 1);
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([draft, draft]);
    expect(s.rules).toHaveLength(1);
  });

  test("an allow rule for someone never waives the card once outside content is in front of the model", async () => {
    const { t, user, conversationId } = await setup();
    await t.run((ctx) => ctx.db.insert("assistant_rules", { user_id: user, tool: "send_mail", decision: "allow", match: "dana@example.com", created_at: Date.now() }));
    // list_tasks brings in text the person did not write, as mail would; the
    // send that follows it is asked even though the rule names its recipient.
    faux.setResponses([callTool("list_tasks", {}), callTool("send_mail", draft, "call_send")]);
    await say(t, conversationId, user, "Check my list and tell Dana");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([]);
    expect(s.turns[0]).toMatchObject({ status: "waiting", reason: "approval", pending_call: { tool_call_id: "call_send" } });
    expect(s.decisions.map((d) => d.status)).toEqual(["pending"]);
  });

  async function emptyWallet(t: T, user: Id<"users">) {
    await t.run(async (ctx) => {
      const wallet = await ensureWallet(ctx, user);
      await ctx.db.patch(wallet._id, { period_cost_usd: wallet.period_cap_usd });
    });
  }

  test("an answer that lands with no usage left answers the call as not run, before the line, and never runs it later", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    const before = await state(t, conversationId, user);
    await emptyWallet(t, user);
    const calls = faux.state.callCount;
    await answer(t, user, 1);

    let s = await expectBalanced(t, conversationId, user, before.wallet.period_cap_usd - before.wallet.period_cost_usd);
    expect(faux.state.callCount).toBe(calls);
    expect(sent).toEqual([]);
    expect(s.decisions[0].status).toBe("answered");
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "approval"], ["done", "budget"]]);
    // The Always allow still stands: the person chose it.
    expect(s.rules).toHaveLength(1);
    const tail = s.messages.slice(-3);
    expect(tail[0].tool_calls?.[0].id).toBe("call_send");
    expect(tail[1].tool_results?.[0]).toMatchObject({ tool_use_id: "call_send", is_error: true });
    expect(tail[1].tool_results?.[0].content).toContain("no usage left");
    expect(tail[2]).toMatchObject({ role: "assistant" });
    expect(tail[2].content).toContain("upgrade or add usage");
    expect(s.managed?.agent_status).toBe("idle");

    // The period resets; the next message runs a turn that does not send.
    await t.run(async (ctx) => {
      const wallet = await ensureWallet(ctx, user);
      await ctx.db.patch(wallet._id, { period_cost_usd: 0 });
    });
    faux.setResponses([reply("I didn't send it. Want me to try again?")]);
    await say(t, conversationId, user, "Did it go out?");
    await settle(t);
    s = await state(t, conversationId, user);
    expect(sent).toEqual([]);
    expect(s.wallet.period_reserved_usd).toBe(0);
    expect(s.turns[s.turns.length - 1]).toMatchObject({ status: "done", reason: "done" });
    expect(s.messages[s.messages.length - 1].content).toBe("I didn't send it. Want me to try again?");
  });

  test("writing again with no usage left takes the card down and answers the call as not run", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    const before = await state(t, conversationId, user);
    await emptyWallet(t, user);
    await say(t, conversationId, user, "Never mind");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user, before.wallet.period_cap_usd - before.wallet.period_cost_usd);
    expect(sent).toEqual([]);
    expect(s.decisions[0].status).toBe("withdrawn");
    expect(s.turns.map((turn) => turn.status)).toEqual(["done", "done"]);
    expect(s.messages.slice(-3).map((m) => [m.role, m.tool_results?.[0]?.tool_use_id ?? m.content])).toEqual([
      ["user", "call_send"],
      ["user", "Never mind"],
      ["assistant", expect.stringContaining("upgrade or add usage")],
    ]);
    // The result names the real reason, as begin would: the person moved on.
    const result = s.messages[s.messages.length - 3].tool_results?.[0].content;
    expect(result).toBe(declineText("send_mail", "The person wrote again instead of answering, so it did not run."));
    expect(result).not.toContain("usage");
  });

  test("Decline with no usage left answers the call as declined, the same words a turn with room writes", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    const before = await state(t, conversationId, user);
    await emptyWallet(t, user);
    const calls = faux.state.callCount;
    await answer(t, user, 2);
    let s = await expectBalanced(t, conversationId, user, before.wallet.period_cap_usd - before.wallet.period_cost_usd);
    expect(faux.state.callCount).toBe(calls);
    expect(sent).toEqual([]);
    expect(s.rules).toEqual([]);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "approval"], ["done", "budget"]]);
    const tail = s.messages.slice(-2);
    expect(tail[0].tool_results?.[0]).toEqual({ tool_use_id: "call_send", content: declineText("send_mail"), is_error: true });
    expect(tail[1].content).toContain("upgrade or add usage");

    // After the period resets, the model reads a declined call, not a usage limit.
    await t.run(async (ctx) => {
      const wallet = await ensureWallet(ctx, user);
      await ctx.db.patch(wallet._id, { period_cost_usd: 0 });
    });
    let seen = "";
    faux.setResponses([(context: unknown) => {
      seen = JSON.stringify(context);
      return reply("Understood, it stays unsent.");
    }]);
    await say(t, conversationId, user, "Ok");
    await settle(t);
    s = await state(t, conversationId, user);
    expect(sent).toEqual([]);
    expect(seen).toContain("The person declined send_mail");
    expect(seen).not.toContain("no usage left");
    expect(s.messages[s.messages.length - 1].content).toBe("Understood, it stays unsent.");
  });

  test("an answer whose message lands before the decision turns answered still runs", async () => {
    const { t, user, conversationId } = await parkOnApproval();
    faux.setResponses([reply("Sent it.")]);
    const decisionId = await t.run(async (ctx) => {
      const decision = (await ctx.db.query("session_decisions").collect())[0];
      const conversation = await ctx.db.get(conversationId);
      await enqueuePendingMessage(ctx, conversation, user, {
        content: "Decision: Approve",
        client_id: decisionAnswerClientId(String(decision._id)),
        human: true,
        wake_cause: "approval",
      });
      return decision._id;
    });
    await t.finishInProgressScheduledFunctions();
    expect((await state(t, conversationId, user)).turns).toHaveLength(1);
    // The patch lands after; the engine's own look-again wake finds it.
    await t.run((ctx) =>
      ctx.db.patch(decisionId, { status: "answered", answer_index: 0, answered_by: { kind: "user", id: String(user), user_id: user }, resolved_by: user, resolved_at: Date.now() } as any),
    );
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(sent).toEqual([draft]);
    expect(s.turns.map((turn) => turn.status)).toEqual(["done", "done"]);
  });
});

describe("limits", () => {
  test("no room in the wallet ends the turn at once with a plain line saying what to do", async () => {
    const { t, user, conversationId } = await setup();
    await t.run(async (ctx) => {
      const wallet = await ensureWallet(ctx, user);
      await ctx.db.patch(wallet._id, { period_cost_usd: wallet.period_cap_usd });
    });
    const before = await state(t, conversationId, user);
    const calls = faux.state.callCount;
    await say(t, conversationId, user, "Plan my week");
    await settle(t);

    const s = await expectBalanced(t, conversationId, user, before.wallet.period_cost_usd);
    expect(faux.state.callCount).toBe(calls);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({ status: "done", reason: "budget", cost_usd: 0 });
    expect(s.wallet.period_cost_usd).toBe(before.wallet.period_cost_usd);
    const [asked, line] = s.messages;
    expect(asked).toMatchObject({ role: "user", content: "Plan my week" });
    expect(line.role).toBe("assistant");
    expect(line.content).toContain("upgrade or add usage");
    expect(s.pending.every((row) => row.status === "delivered")).toBe(true);
    expect(s.managed?.agent_status).toBe("idle");
  });

  test("a hold an ended turn leaked is freed for the next turn even when it is short of the ceiling", async () => {
    const { t, user, conversationId } = await setup();
    const crashed = await t.run(async (ctx) => {
      const wallet = await ensureWallet(ctx, user);
      const turnId = await ctx.db.insert("assistant_turns", { conversation_id: conversationId, user_id: user, status: "running", cost_reserved_usd: 0 });
      expect(await reserve(ctx, user, turnId, 0.1)).toBe(true);
      // Its finish failed to settle; the wallet has no room beside the leak.
      await ctx.db.patch(turnId, { status: "failed", ended_at: Date.now() - LEAK_GRACE_MS });
      await ctx.db.patch(wallet._id, { period_cost_usd: wallet.period_cap_usd - 0.1 });
      return turnId;
    });
    faux.setResponses([reply("Here is your week.")]);
    await say(t, conversationId, user, "Plan my week");
    const started = await state(t, conversationId, user);
    const turn = started.turns.find((row) => row._id !== crashed)!;
    expect(turn).toMatchObject({ status: "running", cost_reserved_usd: 0.1 });
    expect(started.ledger.filter((row) => row.kind === "release").map((row) => row.turn_id)).toEqual([crashed]);
    await settle(t);
    const s = await state(t, conversationId, user);
    expect(s.turns.find((row) => row._id === turn._id)).toMatchObject({ status: "done" });
    expect(s.turns.find((row) => row._id === turn._id)!.reason).not.toBe("budget");
    expect(s.wallet.period_reserved_usd).toBe(0);
  });

  test("a run that reaches its deadline is continued by a new turn", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.deadlineMs = 400;
    faux.setResponses([callTool("slow_lookup", { q: "flights" }), reply("I couldn't finish the lookup, but here's what I know.")]);
    await say(t, conversationId, user, "Find me flights");
    await settle(t);

    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]).toMatchObject({ status: "done", reason: "time" });
    expect(s.turns[1]).toMatchObject({ status: "done", reason: "done", continues: s.turns[0]._id });
    const result = s.messages.find((m) => m.tool_results?.[0]?.tool_use_id === "call_slow_lookup");
    expect(result?.tool_results?.[0].is_error).toBe(true);
    expect(s.messages[s.messages.length - 1].content).toBe("I couldn't finish the lookup, but here's what I know.");
  });

  test("input that lands while a turn runs waits, then wakes the next turn", async () => {
    const { t, user, conversationId } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    faux.setResponses([
      async () => {
        entered = true;
        await gate;
        return reply("First answer.");
      },
      reply("Second answer."),
    ]);
    await say(t, conversationId, user, "First question");
    const running = (async () => settle(t))();
    while (!entered) await pause(10);
    // A second message while the first turn runs: its wake finds the lease taken.
    await say(t, conversationId, user, "Second question");
    let s = await state(t, conversationId, user);
    expect(s.turns.map((turn) => turn.status)).toEqual(["running"]);
    release();
    await running;
    await settle(t);

    s = await expectBalanced(t, conversationId, user);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "done"], ["done", "done"]]);
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "First question"],
      ["assistant", "First answer."],
      ["user", "Second question"],
      ["assistant", "Second answer."],
    ]);
  });
});

describe("more limits", () => {
  test("past the plan's running turns, a turn queues, says it is waiting, and starts when a slot frees", async () => {
    const { t, user, conversationId, start } = await setup();
    const second = await start();
    const third = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = 0;
    const held = (text: string) => async () => {
      entered++;
      await gate;
      return reply(text);
    };
    faux.setResponses([held("First."), held("Second."), reply("Third.")]);
    await say(t, conversationId, user, "One thing");
    const running = (async () => settle(t))();
    while (entered < 1) await pause(10);
    // The free plan runs one turn at a time, but a conversation's first ask
    // takes one slot past it, so a newcomer's first request never waits.
    await say(t, second, user, "Another thing");
    while (entered < 2) await pause(10);
    await say(t, third, user, "A third thing");
    let s = await state(t, third, user);
    expect(s.turns.map((turn) => turn.status)).toEqual(["running", "running", "queued"]);
    expect(s.turns[2].conversation_id).toBe(third);
    // The waiting conversation says so instead of looking stuck.
    expect(s.managed?.agent_status).toBe("waiting");
    release();
    await running;
    await settle(t);
    s = await expectBalanced(t, third, user);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "done"], ["done", "done"], ["done", "done"]]);
    expect(s.messages.map((m) => m.content)).toEqual(["A third thing", "Third."]);
  });

  test("a provider that cannot serve fails the turn at once, charges nothing, alerts once and retries by itself", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.fallbackModel = () => undefined;
    turnDeps.retryDelaysMs = [50, 50];
    const broke = () => {
      throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
    };
    faux.setResponses([broke, broke, broke]);
    await say(t, conversationId, user, "Help me write a kind note");
    await settle(t);
    let s = await expectBalanced(t, conversationId, user);
    // Two retries, then it stops trying and says so.
    expect(s.turns.map((turn) => [turn.status, turn.reason, turn.cost_usd])).toEqual(Array(3).fill(["failed", "error", 0]));
    const notices = s.messages.filter((m) => m.subtype?.startsWith("hosted_notice:"));
    expect(notices.map((m) => m.subtype)).toEqual(["hosted_notice:unavailable", "hosted_notice:unavailable", "hosted_notice:error"]);
    expect(notices[0].content).toContain("try again by myself");
    expect(notices[2].content).toContain("stopped trying");
    expect(s.ledger.filter((row) => row.kind === "charge").every((row) => row.amount_usd === 0)).toBe(true);
    const incidents = await t.run((ctx) => ctx.db.query("assistant_incidents").collect());
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ provider: "anthropic", fault: "billing", count: 3 });

    // The provider is back: the person asks again, it answers from their
    // words (the notices are not in the model's history), and the incident closes.
    faux.setResponses([reply("Here is a kind note.")]);
    await say(t, conversationId, user, "Try again please");
    await settle(t);
    s = await state(t, conversationId, user);
    expect(s.messages[s.messages.length - 1].content).toBe("Here is a kind note.");
    expect((await t.run((ctx) => ctx.db.query("assistant_incidents").collect()))[0].closed_at).toBeNumber();
  });

  test("a provider failure moves the turn to the fallback tier, and the operator still hears about the first", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.fallbackModel = (model) => (model === "claude-sonnet-5-5" ? undefined : "claude-sonnet-5-5");
    faux.setResponses([
      () => {
        throw new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
      },
      reply("Done, from the fallback."),
    ]);
    await say(t, conversationId, user, "Hi");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns[0]).toMatchObject({ status: "done", reason: "done", model: "claude-sonnet-5-5" });
    expect(s.messages[s.messages.length - 1].content).toBe("Done, from the fallback.");
    const incidents = await t.run((ctx) => ctx.db.query("assistant_incidents").collect());
    expect(incidents.map((row) => [row.fault, row.model])).toEqual([["auth", "claude-haiku-4-5-20251001"]]);
  });

  test("a run that died is ended by its lease, charged what it recorded, and the next message runs", async () => {
    const { t, user, conversationId } = await setup();
    const dead = async (spent: number) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert("assistant_turns", {
          conversation_id: conversationId,
          user_id: user,
          status: "running",
          started_at: Date.now() - 60 * 60_000,
          cost_reserved_usd: 0,
          cost_usd: spent,
          model: "claude-haiku-4-5-20251001",
        });
        expect(await reserve(ctx, user, id, 0.25)).toBe(true);
        return id;
      });

    // The sweep scheduled with the lease.
    const swept = await dead(0.004);
    await t.mutation(internal.assistant.turns.expire, { turn_id: swept });
    let s = await expectBalanced(t, conversationId, user);
    expect(s.turns[0]).toMatchObject({ status: "failed", reason: "error", cost_usd: 0.004 });
    expect(s.ledger.find((row) => row.kind === "charge")?.amount_usd).toBe(0.004);
    expect(s.messages[s.messages.length - 1].content).toContain("Something went wrong");
    expect(s.managed?.agent_status).toBe("idle");

    // A lease that finds a dead turn ends it the same way, then starts its own.
    await dead(0.002);
    faux.setResponses([reply("Here now.")]);
    await say(t, conversationId, user, "Hello?");
    await settle(t);
    s = await expectBalanced(t, conversationId, user);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["failed", "error"], ["failed", "error"], ["done", "done"]]);
    expect(s.messages[s.messages.length - 1].content).toBe("Here now.");
  });

  test("a run out of time is continued at most three times, then says so", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.deadlineMs = 300;
    faux.setResponses([1, 2, 3, 4].map((n) => callTool("slow_lookup", { q: `try ${n}` }, `call_${n}`)));
    await say(t, conversationId, user, "Find me flights");
    await settle(t, 40_000);
    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual(Array(4).fill(["done", "time"]));
    expect(s.messages[s.messages.length - 1].content).toContain("taking longer than I can work in one go");
    expect(s.managed?.agent_status).toBe("idle");
  });

  test("a run out of time in a conversation stopped meanwhile goes idle with a line", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.deadlineMs = 300;
    faux.setResponses([callTool("slow_lookup", { q: "flights" })]);
    await say(t, conversationId, user, "Find me flights");
    const running = (async () => settle(t))();
    // Blocked once the run is under way (its call is stored), not before it begins.
    while (!(await state(t, conversationId, user)).messages.some((m) => m.tool_calls?.length)) await pause(10);
    await t.run((ctx) => ctx.db.patch(conversationId, { pending_api_error_kind: "safety" } as any));
    await running;
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns.map((turn) => [turn.status, turn.reason])).toEqual([["done", "time"]]);
    expect(s.messages[s.messages.length - 1].content).toContain("taking longer than I can work in one go");
    expect(s.managed?.agent_status).toBe("idle");
  });

  test("a run that reaches its ceiling stops with a plain line and is charged what it spent", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.model = () => faux.getModel("pricey");
    const calls = faux.state.callCount;
    await say(t, conversationId, user, "Write me a novel");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(faux.state.callCount).toBe(calls);
    expect(s.turns[0]).toMatchObject({ status: "done", reason: "budget" });
    expect(s.messages[s.messages.length - 1].content).toContain("the most I spend on one go");
    expect(s.managed?.agent_status).toBe("idle");
  });

  test("a run that fails writes a calm line and gives the reservation back", async () => {
    const { t, user, conversationId } = await setup();
    faux.setResponses([
      () => {
        throw new Error("provider exploded");
      },
    ]);
    await say(t, conversationId, user, "Hi");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns[0]).toMatchObject({ status: "failed", reason: "error" });
    expect(s.turns[0].error).toContain("provider exploded");
    expect(s.messages[s.messages.length - 1].content).toContain("Something went wrong");
    expect(s.managed?.agent_status).toBe("idle");
  });

  test("a failure before the run starts still ends and settles the turn", async () => {
    const { t, user, conversationId } = await setup();
    turnDeps.toolsFor = async () => {
      throw new Error("no tools today");
    };
    await say(t, conversationId, user, "Hi");
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns[0]).toMatchObject({ status: "failed", reason: "error", cost_usd: 0 });
    expect(s.messages[s.messages.length - 1].content).toContain("Something went wrong");
  });

  test("a conversation deleted while its turn runs: the turn ends and its hold is given back", async () => {
    const { t, user, conversationId } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    faux.setResponses([
      async () => {
        entered = true;
        await gate;
        return reply("Too late.");
      },
    ]);
    await say(t, conversationId, user, "Hi");
    const running = (async () => settle(t))();
    while (!entered) await pause(10);
    await t.run((ctx) => ctx.db.delete(conversationId));
    release();
    await running;
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(s.conversation).toBeNull();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].status).not.toBe("running");
    expect(s.turns[0].cost_usd).toBeGreaterThan(0);
  });

  test("a conversation deleted before its run begins: the turn ends at once", async () => {
    const { t, user, conversationId } = await setup();
    faux.setResponses([reply("Never sent.")]);
    const calls = faux.state.callCount;
    await say(t, conversationId, user, "Hi");
    await t.run((ctx) => ctx.db.delete(conversationId));
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(faux.state.callCount).toBe(calls);
    expect(s.turns.map((turn) => [turn.status, turn.reason, turn.cost_usd])).toEqual([["failed", "error", 0]]);
  });

  test("a conversation safety-blocked between its lease and its run: the run never starts", async () => {
    const { t, user, conversationId } = await setup();
    faux.setResponses([callTool("send_mail", { to: ["dana@example.com"], subject: "x", body: "y" })]);
    const calls = faux.state.callCount;
    await say(t, conversationId, user, "Hi");
    await t.run((ctx) => ctx.db.patch(conversationId, { pending_api_error_kind: "safety" } as any));
    await settle(t);
    const s = await expectBalanced(t, conversationId, user);
    expect(faux.state.callCount).toBe(calls);
    expect(s.turns.map((turn) => [turn.status, turn.reason, turn.cost_usd, turn.error])).toEqual([["failed", "error", 0, "Safety stop"]]);
    expect(s.managed?.agent_status).toBe("idle");
    // Nothing sent here can start a turn, so the line asks for no retry.
    const line = s.messages[s.messages.length - 1].content ?? "";
    expect(line).toContain("safety check");
    expect(line).not.toContain("try again");
  });

  test("a conversation deleted before its lease expires: the sweep still ends and settles the turn", async () => {
    const { t, user, conversationId } = await setup();
    const id = await t.run(async (ctx) => {
      const turnId = await ctx.db.insert("assistant_turns", {
        conversation_id: conversationId,
        user_id: user,
        status: "running",
        started_at: Date.now() - 60 * 60_000,
        cost_reserved_usd: 0,
        cost_usd: 0.003,
        model: "claude-haiku-4-5-20251001",
      });
      expect(await reserve(ctx, user, turnId, 0.25)).toBe(true);
      await ctx.db.delete(conversationId);
      return turnId;
    });
    await t.mutation(internal.assistant.turns.expire, { turn_id: id });
    const s = await expectBalanced(t, conversationId, user);
    expect(s.turns[0]).toMatchObject({ status: "failed", reason: "error", cost_usd: 0.003 });
  });
});

describe("pieces", () => {
  test("rules: an allow or refuse rule decides only a write the gate would ask about", async () => {
    const ask = () => "ask" as const;
    const gate = withRules(ask, [
      { tool: "send_mail", decision: "allow", match: "dana@example.com" },
      { tool: "archive", decision: "refuse" },
      { tool: "label", decision: "allow" },
      { tool: "remember", decision: "allow" },
      { tool: "create_event", decision: "allow", match: "dana@example.com" },
      { tool: "update_event", decision: "allow", match: "no one" },
      // Rules no card offers; the gate ignores them all the same.
      { tool: "fetch_page", decision: "allow" },
      { tool: "fetch_page", decision: "allow", match: "news.example.com" },
      { tool: "schedule_routine", decision: "allow" },
      { tool: "create_event", decision: "allow" },
      { tool: "replace_doc", decision: "allow" },
    ]);
    const call = async (name: string, input: Record<string, unknown>, risk: "read" | "write" = "write") => {
      const decided = await gate({ id: "c", name, input, risk });
      return typeof decided === "string" ? decided : decided.verdict;
    };
    expect(await call("send_mail", { to: ["Dana <Dana@Example.com>"] })).toBe("allow");
    expect(await call("send_mail", { to: ["dana@example.com"], cc: ["lee@example.com"] })).toBe("ask");
    expect(await call("archive", { thread_ids: ["t"] })).toBe("refuse");
    expect(await call("label", { thread_ids: ["t"], add: ["x"] })).toBe("allow");
    expect(await call("remember", { fact: "x" }, "read")).toBe("ask");
    expect(await call("fetch_page", { url: "https://news.example.com/a?d=secret" })).toBe("ask");
    expect(await call("schedule_routine", { prompt: "forward my mail" })).toBe("ask");
    expect(await call("create_event", { title: "Lunch", attendees: ["dana@example.com"] })).toBe("allow");
    // A rule saved for a silent event never covers one that emails the guests.
    expect(await call("create_event", { title: "Lunch", attendees: ["dana@example.com"], notify: true })).toBe("ask");
    expect(await call("create_event", { title: "Lunch", attendees: ["dana@example.com", "evil@example.net"] })).toBe("ask");
    expect(await call("create_event", { title: "Focus" })).toBe("ask");
    expect(await call("update_event", { event_id: "e", start: "2026-10-06T10:00" })).toBe("allow");
    expect(await call("update_event", { event_id: "e", start: "2026-10-06T10:00", notify: true })).toBe("ask");
    expect(await call("update_event", { event_id: "e", add_attendees: ["lee@example.com"] })).toBe("ask");
    // A rule for changes that reach no one never covers dropping a guest.
    expect(await call("update_event", { event_id: "e", remove_attendees: ["boss@example.com"] })).toBe("ask");
    // The rule reads the address mail delivers to, never a lookalike in the display name.
    expect(await call("send_mail", { to: ['"<dana@example.com>" <eve@evil.example>'] })).toBe("ask");
    expect(await call("send_mail", { to: ["dana@example.com <eve@evil.example>"] })).toBe("ask");
    expect(await call("send_mail", { to: ["<dana@example.com> <eve@evil.example>"] })).toBe("ask");
    expect(await call("create_event", { title: "Lunch", attendees: ["Dana <dana@example.com>"] })).toBe("ask");
    // The person sees a doc's new text before it replaces the old, every time.
    expect(await call("replace_doc", { doc: "d", content: "x" })).toBe("ask");
  });

  test("rules: with outside content in view, only rules that reach no one outside the account apply", async () => {
    const gate = withRules(() => "ask", [
      { tool: "send_mail", decision: "allow", match: "dana@example.com" },
      { tool: "create_event", decision: "allow", match: "dana@example.com" },
      { tool: "create_event", decision: "allow", match: "no one" },
      { tool: "archive", decision: "allow" },
      { tool: "label", decision: "refuse" },
    ], () => true);
    const call = async (name: string, input: Record<string, unknown>) => {
      const decided = await gate({ id: "c", name, input, risk: "write" });
      return typeof decided === "string" ? decided : decided.verdict;
    };
    expect(await call("send_mail", { to: ["dana@example.com"] })).toBe("ask");
    expect(await call("create_event", { title: "Lunch", attendees: ["dana@example.com"] })).toBe("ask");
    expect(await call("create_event", { title: "Focus" })).toBe("allow");
    expect(await call("archive", { thread_ids: ["t"] })).toBe("allow");
    expect(await call("label", { thread_ids: ["t"], add: ["x"] })).toBe("refuse");
  });

  test("an image sent to the assistant is refused in words, never dropped", async () => {
    const { t, user, conversationId } = await setup();
    await expect(t.run(async (ctx) => {
      const image = await ctx.storage.store(new Blob(["x"]));
      await enqueuePendingMessage(ctx, await ctx.db.get(conversationId), user, { content: "What's this receipt?", image_storage_id: image, human: true });
    })).rejects.toThrow(/can't read images/);
    expect((await state(t, conversationId, user)).pending).toHaveLength(0);
  });

  test("Always allow is offered only where a rule can be narrowed", () => {
    const kind = (name: string, input: Record<string, unknown>) => allowScope({ name, input }).kind;
    expect(kind("fetch_page", { url: "https://example.com" })).toBe("never");
    expect(kind("schedule_routine", { prompt: "x" })).toBe("never");
    expect(kind("update_event", { event_id: "e", notify: true })).toBe("never");
    expect(kind("update_event", { event_id: "e", remove_attendees: ["lee@example.com"] })).toBe("never");
    expect(kind("send_mail", { to: ["lee@example.com <eve@evil.example>"] })).toBe("never");
    expect(allowScope({ name: "send_mail", input: { to: ['"<lee@example.com>" <eve@evil.example>'] } })).toMatchObject({ match: "eve@evil.example" });
    expect(kind("some_new_tool", {})).toBe("never");
    expect(kind("replace_doc", { doc: "d", content: "x" })).toBe("never");
    expect(kind("create_event", { attendees: ["lee@example.com"], notify: true })).toBe("never");
    expect(kind("write_doc", { doc: "d", content: "x" })).toBe("tool");
    expect(allowScope({ name: "send_mail", input: { to: ['"Lee, Q" <Lee@Example.com>', "dana@example.com"], cc: ["DANA@example.com"] } })).toMatchObject({
      kind: "match",
      match: "dana@example.com, lee@example.com",
    });
    expect(allowScope({ name: "create_event", input: { attendees: ["Lee@Example.com", "dana@example.com"] } })).toMatchObject({
      kind: "match",
      match: "dana@example.com, lee@example.com",
      covers: "Add events with dana@example.com, lee@example.com as the guests, without emailing them",
    });
    expect(allowScope({ name: "create_event", input: {} })).toMatchObject({ kind: "match", match: "no one" });
  });

  test("a whole-tool Always allow names the tool, not this call", () => {
    const covers = (name: string, input: Record<string, unknown>) => alwaysCovers({ name }, allowScope({ name, input }));
    // Each rule lets every later call of the tool run, for any note or anyone.
    expect(covers("write_doc", { title: "Packing list", content: "x" })).toBe("Write a note");
    expect(covers("create_draft", { to: ["dana@example.com"], body: "x" })).toBe("Draft a reply");
    expect(covers("create_event", { attendees: ["dana@example.com"] })).toBe("Add events with dana@example.com as the guests, without emailing them");
  });

  test("the card shows every field literally, long text whole", () => {
    const md = approvalContext({
      to: ["a@x.com", "b@x.com"],
      subject: "Hi *there*",
      description: "[Agenda](https://attacker.example/?d=secret)",
      location: "`Room` 4",
      body: "Line one\nLine two with ``` fence",
      notify: false,
    });
    expect(md).toContain("**To:** `a@x.com, b@x.com`");
    expect(md).toContain("**Subject:** `Hi *there*`");
    expect(md).toContain("**Description:** `[Agenda](https://attacker.example/?d=secret)`");
    expect(md).toContain("**Location:** `` `Room` 4 ``");
    expect(md).toContain("**Notify:** No");
    expect(md).toContain("````text\nLine one\nLine two with ``` fence\n````");
  });

  test("calls nobody will answer are found, the harness's own recovery left alone", () => {
    const call = (id: string) => ({ id, name: "send_mail", input: "{}" });
    const rows: any[] = [
      { role: "user", content: "a" },
      { role: "assistant", tool_calls: [call("old")] },
      { role: "user", content: "b" },
      { role: "assistant", tool_calls: [call("last")] },
    ];
    expect(strandedCalls(rows).map((c) => c.id)).toEqual(["old"]);
    expect(strandedCalls([...rows, { role: "user", content: "c" }]).map((c) => c.id)).toEqual(["old", "last"]);
  });

  test("the system prompt carries the person, the date in their zone, and the connection note", () => {
    const prompt = systemPrompt({ name: "Dana", timezone: "America/Los_Angeles", now: Date.UTC(2026, 9, 5, 18), note: "Google is not connected." });
    expect(prompt).toContain("working for Dana");
    expect(prompt).toContain("Monday, October 5, 2026");
    expect(prompt).toContain("America/Los_Angeles");
    expect(prompt).toContain("11 AM");
    expect(prompt).toContain("Google is not connected.");
    expect(systemPrompt({ timezone: "Not/AZone", now: 0, note: "" })).toContain("UTC");
  });
});
