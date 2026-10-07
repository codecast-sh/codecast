// A hosted conversation's history past the newest rows a turn replays
// (HISTORY_MAX_ROWS). Without it a long conversation silently loses its
// beginning. tidemark (@platform/tidemark) keeps it instead:
//
// - Each message that leaves the replayed window is logged as one line in
//   tidemark's log (logBeyondWindow, from the turn's begin). One scope per
//   conversation, one partition per person.
// - A scheduled pass (compress) summarizes stretches of that log into leaves
//   and merges leaves pairwise into coarser blocks, under a deadline, a
//   per-pass and a per-day spend cap, and a breaker for a failing model.
// - Each turn reads the cover (historyContext): raw lines since the newest
//   summary, then summaries back to the conversation's first message, in the
//   system prompt ahead of the replayed rows; and gets read_history to open
//   any summary down to the original messages.
//
// Only the conversation's own scope is readable from its turns: the viewer
// names that one scope in its owner's partition, so a handle or a scope from
// another conversation reads as one that does not exist.
import { v } from "convex/values";
import type { Tool } from "@platform/agent";
import { untrusted } from "@platform/agent";
import {
  createHistory,
  formatStamp,
  promptSummarizer,
  scopedViewer,
  type CompressConfig,
  type CompressReport,
  type EventRenderer,
  type NewActivity,
  type ReadBudget,
  type Scope,
  type Summarizer,
} from "@platform/tidemark";
import { historyTools } from "@platform/tidemark/agent";
import { convexStore } from "@platform/tidemark/stores/convex";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../functions";
import { callModelMetered, cheapModelCost, estimatedUsage } from "../lib/anthropic";
import { isRefusalProse } from "../idleSummary";
import { actionStore } from "../tidemark";
import { isNoticeUuid, type WindowStart } from "./history";
import { allOutsideToolNames } from "./tools";

export const SCOPE_TYPE = "conversation";
export const AGENT_ID = "assistant";

export const scopeOf = (conversationId: Id<"conversations"> | string): Scope => ({ type: SCOPE_TYPE, id: String(conversationId) });
export const partitionOf = (userId: Id<"users"> | string): string => `user:${userId}`;

/** Most messages one mutation logs; the rest follow in the next. */
export const LOG_BATCH = 50;
/** Most message bytes one logging mutation reads (tool results can be large),
 *  well inside Convex's per-function read limit. */
export const LOG_BYTES = 4_000_000;
/** The one line a message shows as in a read. */
export const LINE_CHARS = 300;
/** The text an opened entry shows: the original message, up to this. */
export const TEXT_CHARS = 4000;

/**
 * Compression for conversations. Only messages already out of the replayed
 * window are logged, so nothing waits on age; a leaf is written once 40 have
 * gathered, and every merge is built as soon as its two halves exist.
 */
export const COMPRESS: Partial<CompressConfig> = {
  minAgeMs: 0,
  minActivities: 40,
  maxActivities: 50,
  concurrency: 4,
  rawWindowMs: 0,
  merges: "complete",
};

/** What the turn's system prompt spends on the cover. Raw lines are only
 *  those since the newest summary (the replayed rows are not in the log).
 *  tidemark never cuts the first block, the conversation's beginning: over
 *  budget a cover coarsens, then cuts from the middle. Each summary part
 *  still has room for every cover line at the longest a summary can be
 *  (summaryMaxTokens plus its frame), so neither normally happens. */
export const CONTEXT_BUDGET: ReadBudget = {
  coverLines: 8,
  tokens: 12_000,
  split: { raw: 40, recent: 30, older: 30 },
  rawWindow: { kind: "age", ms: 0 },
};

/** What one read_history call may spend. */
export const TOOL_BUDGET: ReadBudget = { coverLines: 16, maxCoverLines: 64, tokens: 12_000, rawWindow: { kind: "age", ms: 0 } };

/** The summary pass: how often, how long, and what it may spend; and the
 *  store a turn reads through. Tests replace these. */
export const historyDeps = {
  call: callModelMetered,
  store: actionStore,
  passDeadlineMs: 4 * 60_000,
  passCapUsd: 0.5,
  /** Across everyone, per UTC day. */
  dayCapUsd: 5,
  /** Per person per UTC day, so one long conversation cannot take the day from everyone else. */
  userDayCapUsd: 0.5,
  /** Failed summary calls in a row that end a pass (the model is down or refusing). */
  failuresToStop: 3,
  summaryMaxTokens: 300,
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The one log entry a message becomes, or null when it says nothing (a stop
 * notice, an empty row). Tool results carry outside text: their line names
 * them and no more, so a summary never repeats what a page or an email said,
 * and the opened entry fences them as outside content.
 */
export function entryOf(doc: Doc<"messages">, outside: ReadonlySet<string>): (Omit<NewActivity, "scope" | "partition"> & { outside: boolean }) | null {
  if (isNoticeUuid(doc.message_uuid)) return null;
  const text = doc.is_encrypted ? "" : (doc.content ?? "").trim();
  const ref = { table: "messages", id: doc._id };
  if (doc.tool_results?.length) {
    const body = doc.tool_results.map((r) => r.content).join("\n\n");
    return { kind: "tool_result", summary: `${doc.tool_results.length === 1 ? "a tool result" : `${doc.tool_results.length} tool results`} came back`, data: { text: clip(body, TEXT_CHARS) }, ref, outside: false };
  }
  if (doc.role === "assistant") {
    const calls = (doc.tool_calls ?? []).map((c) => c.name);
    if (!text && calls.length === 0) return null;
    const called = calls.length ? ` [called ${calls.join(", ")}]` : "";
    return {
      kind: text ? "assistant" : "tool_call",
      summary: `${clip(oneLine(text), LINE_CHARS)}${called}`.trim(),
      data: { text: clip(text, TEXT_CHARS), ...(calls.length ? { tools: calls } : {}) },
      ref,
      outside: calls.some((name) => outside.has(name)),
    };
  }
  if (!text) return null;
  return { kind: doc.role === "user" ? "person" : doc.role, summary: clip(oneLine(text), LINE_CHARS), data: { text: clip(text, TEXT_CHARS) }, ref, outside: false };
}

/** Lines as a read shows them; an opened entry shows the original message. */
export const renderer: EventRenderer<undefined> = {
  line: (a, _h, ctx) => ({ text: `[${formatStamp(a.atMs, ctx.zone)}] ${a.kind}: ${a.summary}` }),
  full: (a, _h, ctx) => {
    const head = `[${formatStamp(a.atMs, ctx.zone)}] ${a.kind}`;
    const text = typeof a.data?.text === "string" ? a.data.text : a.summary;
    return a.kind === "tool_result" ? `${head}:\n${untrusted("tool output", text)}` : `${head}:\n${text}`;
  },
  foreign: (a) => a.kind === "tool_result",
};

const before = (a: WindowStart, b: WindowStart) => a.timestamp < b.timestamp || (a.timestamp === b.timestamp && a.creationTime < b.creationTime);

/**
 * Logs the messages that have left the replayed window and are not logged
 * yet, oldest first, LOG_BATCH at a time; a longer backlog continues in a
 * scheduled mutation. A batch never splits messages that share a timestamp
 * (they share a log cursor, and a summary must hold all of them or none),
 * and the window's own first timestamp is left for a later turn for the
 * same reason. Returns the conversation's history row, or null when nothing
 * is logged.
 */
export async function logBeyondWindow(ctx: MutationCtx, conversation: Doc<"conversations">, start: WindowStart | null): Promise<Doc<"assistant_history"> | null> {
  const state = await ctx.db
    .query("assistant_history")
    .withIndex("by_conversation", (q) => q.eq("conversation_id", conversation._id))
    .unique();
  if (!start) return state;
  const from: WindowStart | null = state ? { timestamp: state.logged_ts, creationTime: state.logged_ct } : null;
  if (from && from.timestamp >= start.timestamp) return state;
  const query = ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q) => {
      const mine = q.eq("conversation_id", conversation._id);
      return (from ? mine.gte("timestamp", from.timestamp) : mine).lt("timestamp", start.timestamp);
    });
  const batch: Array<Doc<"messages">> = [];
  let more = false;
  let bytes = 0;
  for await (const doc of query) {
    const at = { timestamp: doc.timestamp, creationTime: doc._creationTime };
    if (from && !before(from, at)) continue;
    const full = batch.length >= LOG_BATCH || bytes >= LOG_BYTES;
    if (full && doc.timestamp !== batch[batch.length - 1].timestamp) {
      more = true;
      break;
    }
    batch.push(doc);
    bytes += JSON.stringify(doc).length;
  }
  if (batch.length === 0) return state;

  const store = convexStore(ctx.db);
  const outsideNames = allOutsideToolNames();
  const scope = scopeOf(conversation._id);
  const partition = partitionOf(conversation.user_id);
  let outside = state?.outside ?? false;
  let logged = 0;
  for (const doc of batch) {
    const entry = entryOf(doc, outsideNames);
    if (!entry) continue;
    const { outside: readsOutside, ...activity } = entry;
    await store.append({ ...activity, scope, partition, at: store.cursorAt(doc.timestamp) });
    outside ||= readsOutside;
    logged++;
  }
  const last = batch[batch.length - 1];
  const fields = { logged_ts: last.timestamp, logged_ct: last._creationTime, logged: (state?.logged ?? 0) + logged, outside };
  const id = state ? (await ctx.db.patch(state._id, fields), state._id) : await ctx.db.insert("assistant_history", { conversation_id: conversation._id, user_id: conversation.user_id, ...fields });
  if (more) await ctx.scheduler.runAfter(0, internal.assistant.longHistory.logWindow, { conversation_id: conversation._id, timestamp: start.timestamp, creation_time: start.creationTime });
  return await ctx.db.get(id);
}

/** Logs what has left a turn's replayed window (logBeyondWindow), in its own
 *  transaction so a turn never fails for it; also each next batch of a long
 *  backlog. Returns what the turn needs to read the result. */
export const logWindow = internalMutation({
  args: { conversation_id: v.id("conversations"), timestamp: v.number(), creation_time: v.number() },
  handler: async (ctx, args): Promise<LongHistory | null> => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    return longHistoryOf(await logBeyondWindow(ctx, conversation, { timestamp: args.timestamp, creationTime: args.creation_time }));
  },
});

/** The conversation's long history as logged so far, for a turn's begin. */
export async function historyState(ctx: QueryCtx, conversationId: Id<"conversations">): Promise<LongHistory | null> {
  return longHistoryOf(await ctx.db.query("assistant_history").withIndex("by_conversation", (q) => q.eq("conversation_id", conversationId)).unique());
}

/** What a turn needs to read its conversation's longer history. */
export interface LongHistory {
  partition: string;
  /** A logged row called a tool that reads outside content. */
  outside: boolean;
}

export function longHistoryOf(state: Doc<"assistant_history"> | null): LongHistory | null {
  return state && state.logged > 0 ? { partition: partitionOf(state.user_id), outside: state.outside } : null;
}

type ActionLike = { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> };

function historyFor(ctx: ActionLike, summarizer?: Summarizer) {
  return createHistory({ store: historyDeps.store(ctx), scopes: [{ type: SCOPE_TYPE, inGlobalFeed: false }], renderer, summarizer, compress: COMPRESS });
}

/**
 * The cover as a system prompt section, and read_history, for one turn.
 * The viewer may read this conversation's scope in its owner's partition
 * and nothing else.
 */
export async function historyContext(
  ctx: ActionLike,
  args: { conversationId: Id<"conversations">; long: LongHistory; turnId: string; timezone?: string },
): Promise<{ section: string | null; tools: Tool[] }> {
  const history = historyFor(ctx);
  const scope = scopeOf(args.conversationId);
  const viewer = scopedViewer(AGENT_ID, scope, args.long.partition);
  const run = { runId: args.turnId, agentId: AGENT_ID, scope, partition: args.long.partition, reason: "turn" };
  const tools = historyTools(history, { run, viewer, zone: args.timezone, build: false, profile: { id: AGENT_ID, history: TOOL_BUDGET } });
  const view = await history.view({ select: { scope }, viewer, budget: CONTEXT_BUDGET, run, zone: args.timezone });
  if (!view.text.trim()) return { section: null, tools };
  const cut = view.truncated
    ? "\n\n(Some of the earlier part did not fit here. read_history with from and to reads any stretch of it.)"
    : "";
  // Once outside content (mail, pages) reached this conversation, the
  // assistant's own earlier words may quote it, and so may summaries of them:
  // the log is then fenced as outside text, never read as instructions.
  const body = args.long.outside ? untrusted("earlier conversation", view.text + cut) : view.text + cut;
  return {
    section:
      "## Earlier in this conversation\n" +
      "The conversation began before the messages you can see. Below is that earlier part as a log: lines just before them, then AI-written summaries reaching back to its first message. " +
      "Use read_history to read more of it or to open any summary down to the original messages.\n\n" +
      body,
    tools,
  };
}

/**
 * Everything a turn's run needs from the long history: logs what has left
 * its window, then reads the cover and builds read_history. Never fails the
 * turn: a failure to log leaves the history as it was, and a failure to read
 * runs the turn without it, as before long history existed.
 */
export async function earlierHistory(
  ctx: ActionLike,
  args: { conversationId: Id<"conversations">; start: WindowStart | null; long: LongHistory | null; turnId: string; timezone?: string },
): Promise<{ section: string | null; tools: Tool[]; outside: boolean }> {
  let long = args.long;
  if (args.start) {
    try {
      long = (await ctx.runMutation(internal.assistant.longHistory.logWindow, { conversation_id: args.conversationId, timestamp: args.start.timestamp, creation_time: args.start.creationTime })) ?? long;
    } catch (error) {
      console.error("[assistant] logging the long history failed", args.conversationId, error);
    }
  }
  if (!long) return { section: null, tools: [], outside: false };
  try {
    return { ...(await historyContext(ctx, { conversationId: args.conversationId, long, turnId: args.turnId, timezone: args.timezone })), outside: long.outside };
  } catch (error) {
    console.error("[assistant] reading the long history failed", args.conversationId, error);
    return { section: null, tools: [], outside: long.outside };
  }
}

// ------------------------------------------------- deleted conversations

/** Rows one forget mutation deletes. */
export const FORGET_BATCH = 500;
/** Conversations each summary pass checks are still there. */
export const CHECKS_PER_PASS = 50;

/** Deletes a gone conversation's log, leaves and blocks, in batches, then its history row. */
export const forget = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("assistant_history")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    if (!state) return null;
    const { done } = await convexStore(ctx.db).dropLog(scopeOf(args.conversation_id), partitionOf(state.user_id), FORGET_BATCH);
    if (done) await ctx.db.delete(state._id);
    else await ctx.scheduler.runAfter(0, internal.assistant.longHistory.forget, args);
    return null;
  },
});

/** Checks the conversations checked longest ago and forgets the ones that
 *  were deleted. A conversation is deleted down many paths; this one sweep
 *  catches them all. */
export const forgetDeleted = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const due = await ctx.db.query("assistant_history").withIndex("by_checked").take(CHECKS_PER_PASS);
    let gone = 0;
    for (const state of due) {
      if (await ctx.db.get(state.conversation_id)) {
        await ctx.db.patch(state._id, { checked_at: Date.now() });
      } else {
        gone++;
        await ctx.scheduler.runAfter(0, internal.assistant.longHistory.forget, { conversation_id: state.conversation_id });
      }
    }
    return gone;
  },
});

/** Schedules forget for a conversation id read back from a log's scope. */
export const forgetLater = internalMutation({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    if (id) await ctx.scheduler.runAfter(0, internal.assistant.longHistory.forget, { conversation_id: id });
    return null;
  },
});

/** Whose conversation a log belongs to, or null when it is gone. */
export const conversationOwner = internalQuery({
  args: { conversation_id: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    const conversation = id ? await ctx.db.get(id) : null;
    return conversation ? String(conversation.user_id) : null;
  },
});

// ---------------------------------------------------------- the summaries

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The spend row for everyone. */
const EVERYONE = "all";

export const spentToday = internalQuery({
  args: { day: v.string(), who: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const row = await ctx.db.query("assistant_history_spend").withIndex("by_day_who", (q) => q.eq("day", args.day).eq("who", args.who ?? EVERYONE)).unique();
    return row?.usd ?? 0;
  },
});

/** One summary call's cost, on the day's row for everyone and for the person. */
export const recordSpend = internalMutation({
  args: { day: v.string(), who: v.optional(v.string()), usd: v.number(), failed: v.boolean() },
  handler: async (ctx, args) => {
    for (const who of new Set([EVERYONE, args.who ?? EVERYONE])) {
      const row = await ctx.db.query("assistant_history_spend").withIndex("by_day_who", (q) => q.eq("day", args.day).eq("who", who)).unique();
      const add = { usd: args.usd, calls: 1, failures: args.failed ? 1 : 0 };
      if (row) await ctx.db.patch(row._id, { usd: row.usd + add.usd, calls: row.calls + add.calls, failures: row.failures + add.failures });
      else await ctx.db.insert("assistant_history_spend", { day: args.day, who, ...add });
    }
    return null;
  },
});

/**
 * One summary pass over the conversations with history to summarize. Stops
 * starting calls at its deadline, at its own spend cap, at the day's cap for
 * everyone, or after `failuresToStop` failed calls in a row; a person past
 * their own day's cap waits for tomorrow while everyone else goes on. A
 * failed call (an error, a timeout, an empty reply, a refusal, a summary cut
 * off at summaryMaxTokens) writes nothing: its stretch stays raw (the cover
 * still shows it, bounded) and the next pass tries again. Every call is
 * billed, a failed one too: the usage the API reported, else an estimate
 * from the prompt, so the caps never undercount when calls fail. A deleted
 * conversation is forgotten, never summarized.
 */
export const compress = internalAction({
  args: {},
  handler: async (ctx): Promise<CompressReport & { spentUsd: number; stoppedForFailures: boolean }> => {
    await ctx.runMutation(internal.assistant.longHistory.forgetDeleted, {});
    const day = utcDay(Date.now());
    const dayBefore: number = await ctx.runQuery(internal.assistant.longHistory.spentToday, { day });
    let spent = 0;
    let failingInRow = 0;
    const owners = new Map<string, Promise<string | null>>();
    const userSpent = new Map<string, Promise<number>>();
    const call = async (scope: Scope, system: string, prompt: string) => {
      if (!owners.has(scope.id)) owners.set(scope.id, ctx.runQuery(internal.assistant.longHistory.conversationOwner, { conversation_id: scope.id }));
      const who = await owners.get(scope.id)!;
      if (!who) {
        await ctx.runMutation(internal.assistant.longHistory.forgetLater, { conversation_id: scope.id });
        throw new Error("the conversation was deleted");
      }
      if (!userSpent.has(who)) userSpent.set(who, ctx.runQuery(internal.assistant.longHistory.spentToday, { day, who }));
      if ((await userSpent.get(who)!) >= historyDeps.userDayCapUsd) throw new Error("this person's summaries are at today's cap");
      const { reply, usage } = await historyDeps.call({ system, prompt, max_tokens: historyDeps.summaryMaxTokens, label: "History summary", timeout_ms: 60_000 });
      const usd = cheapModelCost(usage ?? estimatedUsage(system, prompt));
      // A refusal and a summary cut off at its limit are billed like any
      // reply but are no summary. tidemark refuses to store a truncated one.
      const refused = !!reply && isRefusalProse(reply.text);
      const truncated = reply?.stop_reason === "max_tokens";
      const failed = !reply || refused || truncated;
      spent += usd;
      userSpent.set(who, userSpent.get(who)!.then((before) => before + usd));
      failingInRow = failed ? failingInRow + 1 : 0;
      await ctx.runMutation(internal.assistant.longHistory.recordSpend, { day, who, usd, failed });
      if (!reply || refused) throw new Error(reply ? "the summary call refused" : "the summary call failed");
      return { text: reply.text, truncated };
    };
    const summarizer: Summarizer = {
      leaf: (input) => promptSummarizer((system, prompt) => call(input.scope, system, prompt)).leaf(input),
      merge: (input) => promptSummarizer((system, prompt) => call(input.scope, system, prompt)).merge(input),
    };
    const report = await historyFor(ctx, summarizer).compressOnce({
      deadlineAt: Date.now() + historyDeps.passDeadlineMs,
      budgetCheck: () => failingInRow < historyDeps.failuresToStop && spent < historyDeps.passCapUsd && dayBefore + spent < historyDeps.dayCapUsd,
    });
    return { ...report, spentUsd: spent, stoppedForFailures: failingInRow >= historyDeps.failuresToStop };
  },
});
