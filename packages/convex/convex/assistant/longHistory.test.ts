// A hosted conversation's history past the replayed window (longHistory.ts),
// under convex-test on pi-ai's faux provider: tidemark's store contract on
// this deployment's schema; a conversation longer than HISTORY_MAX_ROWS that
// still shows its first message in the model's context, raw before any
// summary and as a summary after one, with read_history opening the summary
// down to the original message; one conversation's history unreadable from
// another's turn; and the summary pass held by its caps and its breaker.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { storeContract } from "@platform/tidemark/stores/contract";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { enqueuePendingMessage } from "../pendingMessages";
import { allModules as modules, loadPiAi } from "../testModules.testkit";
import { actionStore } from "../tidemark";
import { HISTORY_MAX_ROWS } from "./history";
import { cheapModelCost, estimatedUsage, type ModelReply } from "../lib/anthropic";
import { earlierHistory, historyDeps, LINE_CHARS, partitionOf, scopeOf } from "./longHistory";
import { leaseTurn, turnDeps } from "./turns";

setDefaultTimeout(240_000);

const pi = await loadPiAi();
let faux: any;
const savedTurn = { ...turnDeps };
const savedHistory = { ...historyDeps };

beforeAll(() => {
  faux = pi.registerFauxProvider({ models: [{ id: "claude-haiku-4-5-20251001" }, { id: "claude-sonnet-5-5" }], tokenSize: { min: 3, max: 6 } });
});
afterAll(() => faux.unregister());

/** A call that returned this reply, metered as the API reports it. */
const answered = (reply: ModelReply) => ({ reply, usage: reply.usage });

/** Summary calls the pass made, with their prompts. */
let summaryCalls: string[] = [];

beforeEach(() => {
  faux.setResponses([]);
  summaryCalls = [];
  turnDeps.model = (id: string) => faux.getModel(id) ?? faux.getModel();
  turnDeps.apiKeys = () => undefined;
  turnDeps.leaseMarginMs = 60_000;
  turnDeps.streamEveryMs = 0;
  // A summarizer that keeps the codename when its input has it, so the test
  // can follow the first message through leaves and merges.
  historyDeps.call = async (args: { prompt: string }) => {
    summaryCalls.push(args.prompt);
    const keep = /BLUEHERON/.test(args.prompt) ? " It began with the codename BLUEHERON." : "";
    return answered({ text: `A stretch of the conversation.${keep}`, usage: { input_tokens: 400, output_tokens: 60 }, stop_reason: "end_turn" });
  };
});
afterEach(() => {
  Object.assign(turnDeps, savedTurn);
  Object.assign(historyDeps, savedHistory);
});

const reply = (text: string) => pi.fauxAssistantMessage(text);
const callTool = (name: string, args: Record<string, unknown>, id: string) => pi.fauxAssistantMessage([pi.fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

const FIRST = `The project codename is BLUEHERON. ${"Some context about the plan. ".repeat(14)}TAIL-OK`;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(t: any, forMs = 30_000) {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await t.finishInProgressScheduledFunctions();
    const due = await t.run(async (ctx: any) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job: any) => (job.state.kind === "pending" || job.state.kind === "inProgress") && job.scheduledTime <= Date.now() + 3_000,
      ).length,
    );
    if (due === 0) return;
    await pause(20);
  }
  throw new Error("scheduled work did not settle");
}

/** A person with a hosted conversation already `count` messages long, a minute apart, the first carrying FIRST. */
async function longConversation(t: any, count: number, opts: { line?: (i: number) => string } = {}) {
  const user = (await t.run((ctx: any) => ctx.db.insert("users", { name: "Dana" }))) as Id<"users">;
  const conversationId = (await t.withIdentity({ subject: user }).mutation(api.assistant.entry.startConversation, {})).conversation_id as Id<"conversations">;
  const start = Date.now() - (count + 10) * 60_000;
  await t.run(async (ctx: any) => {
    for (let i = 0; i < count; i++) {
      const content = i === 0 ? FIRST : (opts.line?.(i) ?? `message ${i}`);
      await ctx.db.insert("messages", { conversation_id: conversationId, role: i % 2 === 0 ? "user" : "assistant", content, timestamp: start + i * 60_000 });
    }
  });
  return { user, conversationId };
}

async function say(t: any, conversationId: Id<"conversations">, user: Id<"users">, content: string) {
  await t.run(async (ctx: any) => {
    const conversation = await ctx.db.get(conversationId);
    await enqueuePendingMessage(ctx, conversation, user, { content, human: true });
    await leaseTurn(ctx, conversationId);
  });
}

let asked = 0;

/** One turn whose model answers with `steps`, each seeing the context it was called with. */
async function turn(t: any, conversationId: Id<"conversations">, user: Id<"users">, steps: Array<(context: any) => any>) {
  faux.setResponses(steps.map((step) => (context: any) => step(context)));
  await say(t, conversationId, user, `Where were we? (${++asked})`);
  await settle(t);
}

const lastToolResult = (context: any): string => {
  const results = context.messages.filter((m: any) => m.role === "toolResult");
  const last = results[results.length - 1];
  return (last?.content ?? []).map((c: any) => c.text ?? "").join("");
};
const firstBlockHandle = (text: string): string | null => text.match(/\[block:(\S+) \|/)?.[1] ?? null;

describe("tidemark store contract on this deployment", () => {
  for (const c of storeContract(async () => {
    const t = convexTest(schema, modules);
    const store = actionStore({ runQuery: (ref, args) => t.query(ref, args), runMutation: (ref, args) => t.mutation(ref, args) });
    return { store, addLegacyLeaf: async (...a: Parameters<typeof store.addLegacyLeaf>) => void (await store.addLegacyLeaf(...a)) };
  })) {
    test(c.name, c.run);
  }
});

describe("a conversation longer than the replayed window", () => {
  test("keeps its beginning in context, raw and then summarized, and read_history opens it down to the first message", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await longConversation(t, HISTORY_MAX_ROWS + 200);

    // Turn 1: nothing summarized yet. The 200 rows before the window are logged
    // and the first one reaches the model raw.
    let system = "";
    let tools: string[] = [];
    await turn(t, conversationId, user, [
      (context) => {
        system = context.systemPrompt;
        tools = (context.tools ?? []).map((tool: any) => tool.name);
        return reply("We were planning.");
      },
    ]);
    expect(system).toContain("## Earlier in this conversation");
    expect(system).toContain("The project codename is BLUEHERON");
    expect(tools).toContain("read_history");
    const state = await t.run((ctx: any) => ctx.db.query("assistant_history").collect());
    expect(state).toHaveLength(1);
    expect(state[0].logged).toBeGreaterThanOrEqual(200);

    // The summary pass: four leaves of 50 and every merge over them.
    const report = await t.action(internal.assistant.longHistory.compress, {});
    expect(report.leaves).toBe(4);
    expect(report.merged).toBe(3);
    expect(report.failures).toBe(0);
    expect(report.spentUsd).toBeGreaterThan(0);

    // Turn 2: the beginning now arrives as a summary. The model reads the
    // whole earlier part as one block (lines: 1), then opens the first half
    // of each block until it reaches the raw entries, and sees the first
    // message in full.
    const opened: string[] = [];
    await turn(t, conversationId, user, [
      (context) => {
        system = context.systemPrompt;
        return callTool("read_history", { lines: 1 }, "zoom_0");
      },
      ...[1, 2, 3, 4].map((n) => (context: any) => {
        const result = lastToolResult(context);
        opened.push(result);
        if (/opened: its \d+ raw entries/.test(result)) return reply("Found it.");
        return callTool("read_history", { item: firstBlockHandle(result) }, `zoom_${n}`);
      }),
      () => reply("Found it."),
    ]);
    // One block for the whole stretch, then its two halves, then their halves (the leaves), then the first leaf's entries.
    expect(opened).toHaveLength(4);
    expect(opened[0]).toMatch(/\[block:b:2\.0@/);
    expect(opened[1]).toMatch(/\[block:b:1\.0@/);
    expect(opened[2]).toMatch(/\[block:b:0\.0@/);
    for (const step of opened.slice(0, 3)) expect(step).toContain("codename BLUEHERON");
    expect(system).toContain("codename BLUEHERON");
    expect(system).toMatch(/\[block:/);
    expect(system).not.toContain("TAIL-OK");
    const raw = opened.find((r) => /opened: its \d+ raw entries/.test(r));
    expect(raw).toBeDefined();
    // The opened entry is the original message, past the one-line clip.
    expect(FIRST.length).toBeGreaterThan(LINE_CHARS);
    expect(raw).toContain("TAIL-OK");
  });

  test("one conversation's history cannot be opened from another conversation's turn, the same person's or another's", async () => {
    const t = convexTest(schema, modules);
    const a = await longConversation(t, HISTORY_MAX_ROWS + 120);
    const b = await longConversation(t, HISTORY_MAX_ROWS + 120);
    // The same person's other conversation.
    const c = await t.run(async (ctx: any) => {
      const conversation = await ctx.db.get(b.conversationId);
      const { _id, _creationTime, ...rest } = conversation;
      return ctx.db.insert("conversations", { ...rest, user_id: a.user });
    });
    await t.run(async (ctx: any) => {
      const start = Date.now() - 400 * 60_000;
      for (let i = 0; i < HISTORY_MAX_ROWS + 120; i++) await ctx.db.insert("messages", { conversation_id: c, role: i % 2 === 0 ? "user" : "assistant", content: `other ${i}`, timestamp: start + i * 60_000 });
    });

    let systemA = "";
    await turn(t, a.conversationId, a.user, [(context) => ((systemA = context.systemPrompt), reply("ok"))]);
    await t.action(internal.assistant.longHistory.compress, {});
    await turn(t, a.conversationId, a.user, [(context) => ((systemA = context.systemPrompt), reply("ok"))]);
    const handle = firstBlockHandle(systemA)!;
    expect(handle).toBeTruthy();

    for (const [other, owner] of [[b.conversationId, b.user], [c as Id<"conversations">, a.user]] as const) {
      const results: string[] = [];
      let otherSystem = "";
      await turn(t, other, owner, [
        (context) => ((otherSystem = context.systemPrompt), callTool("read_history", { item: handle }, "leak_1")),
        (context) => (results.push(lastToolResult(context)), callTool("read_history", { scope: `conversation:${a.conversationId}` }, "leak_2")),
        (context) => (results.push(lastToolResult(context)), callTool("read_history", { query: "BLUEHERON", scope: `conversation:${a.conversationId}` }, "leak_3")),
        (context) => (results.push(lastToolResult(context)), reply("nothing")),
      ]);
      // Every conversation in this test opens with BLUEHERON except c, so
      // check the other turn reads nothing of a's: no handle opens, no scope reads.
      expect(results[0]).toContain("is readable from this run");
      expect(results[0]).not.toContain("BLUEHERON");
      expect(results[1]).toContain("is not readable from this run");
      expect(results[2]).toContain("is not readable from this run");
      expect(otherSystem).not.toContain(String(a.conversationId));
    }
  });

  test("a conversation whose earlier rows read outside content keeps counting as tainted after they leave the window", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await longConversation(t, HISTORY_MAX_ROWS + 60);
    await t.run(async (ctx: any) => {
      const second = (await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId)).take(2))[1];
      await ctx.db.patch(second._id, { tool_calls: [{ id: "c1", name: "fetch_page", input: "{}" }] });
    });
    await turn(t, conversationId, user, [() => reply("ok")]);
    const state = await t.run((ctx: any) => ctx.db.query("assistant_history").collect());
    expect(state[0].outside).toBe(true);
  });
});

describe("the summary pass", () => {
  async function backlog(t: any) {
    const { user, conversationId } = await longConversation(t, HISTORY_MAX_ROWS + 200);
    await turn(t, conversationId, user, [() => reply("ok")]);
    return { user, conversationId };
  }

  /** `n` more conversations with a leaf's worth of history each. */
  async function moreConversations(t: any, n: number) {
    for (let i = 0; i < n; i++) {
      const more = await longConversation(t, HISTORY_MAX_ROWS + 60);
      await turn(t, more.conversationId, more.user, [() => reply("ok")]);
    }
  }

  test("spends nothing once the day's cap is reached", async () => {
    const t = convexTest(schema, modules);
    await backlog(t);
    const day = new Date().toISOString().slice(0, 10);
    await t.mutation(internal.assistant.longHistory.recordSpend, { day, usd: historyDeps.dayCapUsd, failed: false });
    const report = await t.action(internal.assistant.longHistory.compress, {});
    expect(summaryCalls).toHaveLength(0);
    expect(report.budgetHit).toBe(true);
    expect(report.leaves).toBe(0);
  });

  test("stops at its own spend cap", async () => {
    const t = convexTest(schema, modules);
    await backlog(t);
    historyDeps.passCapUsd = 0.000001;
    historyDeps.dayCapUsd = 1000;
    const report = await t.action(internal.assistant.longHistory.compress, {});
    // Calls already in flight finish; none starts once the cap is passed.
    expect(summaryCalls.length).toBeLessThanOrEqual(4);
    expect(report.budgetHit).toBe(true);
  });

  test("a failing model writes nothing, is recorded, and stops the pass after failures in a row; the next pass recovers", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await backlog(t);
    await moreConversations(t, 7);
    const working = historyDeps.call;
    historyDeps.call = async (args: { prompt: string }) => {
      summaryCalls.push(args.prompt);
      return { reply: null, usage: null };
    };
    const failed = await t.action(internal.assistant.longHistory.compress, {});
    expect(failed.leaves).toBe(0);
    expect(failed.stoppedForFailures).toBe(true);
    // A failing scope stops at its first failure; past the breaker no call
    // starts, so at most the calls already in flight finish.
    expect(summaryCalls.length).toBeLessThan(8);
    expect(summaryCalls.length).toBeLessThanOrEqual(historyDeps.failuresToStop + 4);
    const spend = await t.run((ctx: any) => ctx.db.query("assistant_history_spend").collect());
    const everyone = spend.find((row: any) => row.who === "all");
    expect(everyone.failures).toBe(summaryCalls.length);
    // No usage came back, so each call is billed at the estimate for its prompt.
    expect(everyone.usd).toBeGreaterThan(0);

    // The turn still shows the beginning, raw.
    let system = "";
    await turn(t, conversationId, user, [(context) => ((system = context.systemPrompt), reply("ok"))]);
    expect(system).toContain("BLUEHERON");

    historyDeps.call = working;
    const recovered = await t.action(internal.assistant.longHistory.compress, {});
    expect(recovered.leaves).toBe(4 + 7);
  });

  test("a person past their own day's cap waits while everyone else is summarized", async () => {
    const t = convexTest(schema, modules);
    const heavy = await backlog(t);
    const light = await longConversation(t, HISTORY_MAX_ROWS + 60);
    await turn(t, light.conversationId, light.user, [() => reply("ok")]);
    const day = new Date().toISOString().slice(0, 10);
    await t.mutation(internal.assistant.longHistory.recordSpend, { day, who: String(heavy.user), usd: historyDeps.userDayCapUsd, failed: false });
    const report = await t.action(internal.assistant.longHistory.compress, {});
    expect(report.leaves).toBe(1);
    expect(summaryCalls).toHaveLength(1);
    expect(report.stoppedForFailures).toBe(false);
  });

  test("a refusal is billed and recorded as a failure, and writes no summary", async () => {
    const t = convexTest(schema, modules);
    await backlog(t);
    historyDeps.call = async (args: { prompt: string }) => {
      summaryCalls.push(args.prompt);
      return answered({ text: "I can't summarize this conversation.", usage: { input_tokens: 400, output_tokens: 10 }, stop_reason: "end_turn" });
    };
    const report = await t.action(internal.assistant.longHistory.compress, {});
    expect(report.leaves).toBe(0);
    expect(report.failures).toBeGreaterThan(0);
    const everyone = (await t.run((ctx: any) => ctx.db.query("assistant_history_spend").collect())).find((row: any) => row.who === "all");
    expect(everyone.failures).toBe(summaryCalls.length);
    expect(everyone.usd).toBeGreaterThan(0);
  });

  test("a summary cut off at its token limit is billed, writes nothing, counts toward the breaker, and is retried", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await backlog(t);
    await moreConversations(t, 4);
    const working = historyDeps.call;
    historyDeps.call = async (args: { prompt: string }) => {
      summaryCalls.push(args.prompt);
      return answered({ text: "The conversation began with a long plan about", usage: { input_tokens: 400, output_tokens: historyDeps.summaryMaxTokens }, stop_reason: "max_tokens" });
    };
    const cut = await t.action(internal.assistant.longHistory.compress, {});
    expect(cut.leaves).toBe(0);
    expect(cut.stoppedForFailures).toBe(true);
    const everyone = (await t.run((ctx: any) => ctx.db.query("assistant_history_spend").collect())).find((row: any) => row.who === "all");
    expect(everyone.failures).toBe(summaryCalls.length);
    expect(everyone.usd).toBeCloseTo(summaryCalls.length * cheapModelCost({ input_tokens: 400, output_tokens: historyDeps.summaryMaxTokens }), 10);
    let system = "";
    await turn(t, conversationId, user, [(context) => ((system = context.systemPrompt), reply("ok"))]);
    expect(system).not.toContain("began with a long plan about");
    historyDeps.call = working;
    expect((await t.action(internal.assistant.longHistory.compress, {})).leaves).toBe(4 + 4);
  });

  test("a failed call bills the usage the API reported, else an estimate from its prompt, and the caps see it", async () => {
    const t = convexTest(schema, modules);
    await backlog(t);
    await moreConversations(t, 7);
    const reported = { input_tokens: 5000, output_tokens: 0 };
    let reportUsage = true;
    const systems: string[] = [];
    historyDeps.call = async (args: { system?: string; prompt: string }) => {
      summaryCalls.push(args.prompt);
      systems.push(args.system ?? "");
      return { reply: null, usage: reportUsage ? reported : null };
    };
    historyDeps.failuresToStop = 1000;
    historyDeps.passCapUsd = cheapModelCost(reported) * 2.5;
    const capped = await t.action(internal.assistant.longHistory.compress, {});
    // The pass cap stops it although every call failed: failures are spent money.
    expect(capped.budgetHit).toBe(true);
    expect(capped.spentUsd).toBeCloseTo(summaryCalls.length * cheapModelCost(reported), 10);
    expect(capped.spentUsd).toBeGreaterThanOrEqual(historyDeps.passCapUsd);

    reportUsage = false;
    summaryCalls = [];
    systems.length = 0;
    historyDeps.passCapUsd = 1000;
    const day = new Date().toISOString().slice(0, 10);
    const before = (await t.run((ctx: any) => ctx.db.query("assistant_history_spend").collect())).find((row: any) => row.who === "all").usd;
    const estimated = await t.action(internal.assistant.longHistory.compress, {});
    const expected = summaryCalls.reduce((sum, prompt, i) => sum + cheapModelCost(estimatedUsage(systems[i], prompt)), 0);
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(estimated.spentUsd).toBeCloseTo(expected, 10);
    // The person's own row is charged too, so their day's cap sees it.
    const rows = await t.run((ctx: any) => ctx.db.query("assistant_history_spend").collect());
    expect(rows.find((row: any) => row.who === "all").usd).toBeCloseTo(before + expected, 10);
    expect(rows.filter((row: any) => row.who !== "all" && row.day === day).reduce((sum: number, row: any) => sum + row.usd, 0)).toBeCloseTo(before + expected, 10);
  });

  test("with summaries at their longest, the cover still holds the conversation's first block", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await longConversation(t, HISTORY_MAX_ROWS + 800);
    await turn(t, conversationId, user, [() => reply("ok")]);
    // Every summary as long as summaryMaxTokens allows.
    historyDeps.call = async (args: { prompt: string }) => {
      summaryCalls.push(args.prompt);
      const keep = /BLUEHERON/.test(args.prompt) ? "It began with the codename BLUEHERON. " : "";
      return answered({ text: (keep + "A stretch of the conversation went by. ".repeat(40)).slice(0, historyDeps.summaryMaxTokens * 4), usage: { input_tokens: 400, output_tokens: 300 }, stop_reason: "end_turn" });
    };
    const report = await t.action(internal.assistant.longHistory.compress, {});
    expect(report.leaves).toBe(16);
    expect(report.merged).toBe(15);
    let system = "";
    await turn(t, conversationId, user, [(context) => ((system = context.systemPrompt), reply("ok"))]);
    expect(system).toContain("codename BLUEHERON");
    expect(system).not.toContain("did not fit here");
  });

  test("once outside content reached the conversation, the earlier part is fenced as outside text", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await longConversation(t, HISTORY_MAX_ROWS + 60);
    await t.run(async (ctx: any) => {
      const second = (await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId)).take(2))[1];
      await ctx.db.patch(second._id, { tool_calls: [{ id: "c1", name: "fetch_page", input: "{}" }] });
    });
    let system = "";
    await turn(t, conversationId, user, [(context) => ((system = context.systemPrompt), reply("ok"))]);
    const section = system.slice(system.indexOf("## Earlier in this conversation"));
    expect(section).toMatch(/<untrusted-[A-Za-z0-9]+/);
    expect(section).toContain("BLUEHERON");
  });

  test("a failure to read the long history runs the turn without it", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await backlog(t);
    historyDeps.store = () => {
      throw new Error("the store is down");
    };
    let system = "";
    let tools: string[] = [];
    await turn(t, conversationId, user, [(context) => ((system = context.systemPrompt), (tools = (context.tools ?? []).map((x: any) => x.name)), reply("Still here."))]);
    expect(system).not.toContain("## Earlier in this conversation");
    expect(tools).not.toContain("read_history");
    const turns = await t.run((ctx: any) => ctx.db.query("assistant_turns").collect());
    expect(turns.every((x: any) => x.status === "done")).toBe(true);
  });

  test("a failure to log what left the window keeps the turn going on what was logged before", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await backlog(t);
    const state = (await t.run((ctx: any) => ctx.db.query("assistant_history").collect()))[0];
    const ctx = {
      runQuery: (ref: any, args: any) => t.query(ref, args),
      runMutation: async () => {
        throw new Error("Too many bytes read in a single function execution");
      },
    };
    const earlier = await earlierHistory(ctx, { conversationId, start: { timestamp: Date.now(), creationTime: Date.now() }, long: { partition: partitionOf(state.user_id), outside: false }, turnId: "t1" });
    expect(earlier.section).toContain("BLUEHERON");
    expect(earlier.tools.map((tool) => tool.name)).toEqual(["read_history"]);
  });

  test("when raw lines overflow the cover's budget, the cover says so and points at read_history", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await longConversation(t, HISTORY_MAX_ROWS + 200, { line: (i) => `message ${i} ${"words ".repeat(120)}` });
    // The first turn logs a batch and the rest follows; the second reads all of it.
    await turn(t, conversationId, user, [() => reply("ok")]);
    let system = "";
    await turn(t, conversationId, user, [(context) => ((system = context.systemPrompt), reply("ok"))]);
    expect(system).toContain("did not fit here");
  });

  test("a deleted conversation is never summarized and its log, summaries and history row are deleted", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await backlog(t);
    const kept = await longConversation(t, HISTORY_MAX_ROWS + 60);
    await turn(t, kept.conversationId, kept.user, [() => reply("ok")]);
    await t.run((ctx: any) => ctx.db.delete(conversationId));
    const report = await t.action(internal.assistant.longHistory.compress, {});
    await settle(t);
    // Only the kept conversation was summarized.
    expect(report.leaves).toBe(1);
    expect(summaryCalls).toHaveLength(1);
    const store = actionStore({ runQuery: (ref, args) => t.query(ref, args), runMutation: (ref, args) => t.mutation(ref, args) });
    expect(await store.activities({ select: { scope: scopeOf(conversationId) }, partition: partitionOf(user), order: "asc", limit: 5 })).toEqual([]);
    expect(await store.treeIndex(scopeOf(conversationId), partitionOf(user), {})).toEqual([]);
    const rows = await t.run((ctx: any) => ctx.db.query("assistant_history").collect());
    expect(rows.map((r: any) => r.conversation_id)).toEqual([kept.conversationId]);
  });

  test("a deleted conversation with nothing left to summarize is found by the sweep", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await backlog(t);
    await t.action(internal.assistant.longHistory.compress, {});
    await settle(t);
    await t.run((ctx: any) => ctx.db.delete(conversationId));
    const calls = summaryCalls.length;
    await t.action(internal.assistant.longHistory.compress, {});
    await settle(t);
    expect(summaryCalls.length).toBe(calls);
    const store = actionStore({ runQuery: (ref, args) => t.query(ref, args), runMutation: (ref, args) => t.mutation(ref, args) });
    expect(await store.treeIndex(scopeOf(conversationId), partitionOf(user), {})).toEqual([]);
    expect(await t.run((ctx: any) => ctx.db.query("assistant_history").collect())).toEqual([]);
  });

  test("the log is partitioned by person", async () => {
    const t = convexTest(schema, modules);
    const { user, conversationId } = await backlog(t);
    const store = actionStore({ runQuery: (ref, args) => t.query(ref, args), runMutation: (ref, args) => t.mutation(ref, args) });
    const mine = await store.activities({ select: { scope: scopeOf(conversationId) }, partition: partitionOf(user), order: "asc", limit: 5 });
    expect(mine[0].summary).toContain("BLUEHERON");
    expect(await store.activities({ select: { scope: scopeOf(conversationId) }, partition: "default", order: "asc", limit: 5 })).toEqual([]);
  });
});
