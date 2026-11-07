// `cast read <id> --ask "<question>"`: answer a question from ONE session,
// checking whether later messages revised the answer.
//
// The action runs where the model key lives, so the caller's machine needs
// none. It:
//   1. checks the question's length, the caller's access (askHead, the same
//      rule as `cast read`) and the caller's rate, before any heavy read,
//   2. turns the question into search terms (its own words plus the model's),
//   3. scans the session in byte-bounded steps (askScan), keeping a clipped
//      line per message and which terms it mentions, so a whale never holds
//      more than one step's rows and never reads file change bodies. The
//      newest lines are read first (readSession): a session too long for the
//      budget loses a stretch of its middle, never its end, and the prompt
//      and the result say which stretch,
//   4. picks the lines to show under a character budget (selectAskContext:
//      best matches, everything later on the same topic, the human's turns,
//      the tail), and
//   5. asks the model, which answers with `cast read` line citations.
// Both model calls are built by askTermsRequest and askAnswerRequest
// (lib/sessionAsk.ts), the same builders the evals replay.

import { action, internalAction, internalQuery } from "./functions";
import type { ActionCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { AskResult } from "@codecast/shared/contracts";
import { internal } from "./_generated/api";
import { readableConversation, readableConversationAs, streamMessageRows, isNonEmptyMessage } from "./conversations";
import type { QueryCtx } from "./_generated/server";
import { readFileChangeIndex } from "./fileChangeBodies";
import { callModel, callModelMetered, cheapModelCost, CHEAP_MODEL } from "./lib/anthropic";
import { requireVendorAllowed } from "./lib/vendorGuard";
import type { Id } from "./_generated/dataModel";
import {
  ASK_MAX_QUESTION_CHARS,
  askAnswerRequest,
  askTerms,
  askTermsRequest,
  citationTargets,
  readSession,
  toAskLine,
  type AskMessage,
  type AskScanLine,
} from "./lib/sessionAsk";
/** Scan steps one question may take (each reads at most READ_STEP_BYTES). */
const ASK_MAX_STEPS = 300;
/** Wall time the scan may take. With the two model calls' own limits this
 *  stays inside the CLI's 300s wait, so the server never runs on for nobody. */
const ASK_SCAN_MS = 120_000;
const ASK_TERMS_MS = 20_000;
const ASK_ANSWER_MS = 90_000;
export const ASK_RATE = { max: 60, window_ms: 60 * 60 * 1000 };
/** The hourly window one person's questions spend from (the CLI, the web and side answers share it). */
export const askRateKey = (userId: string) => `read-ask:${userId}`;

/** Who is reading: a token (CLI, or "" for a signed-in web caller), or a user id
 *  a server-side caller already checked (the side-answer action). */
const callerArgs = { api_token: v.string(), user_id: v.optional(v.id("users")), conversation_id: v.string() };
type Caller = { api_token: string; user_id?: Id<"users">; conversation_id: string };
const readFor = (ctx: QueryCtx, a: Caller) =>
  a.user_id ? readableConversationAs(ctx, a.user_id, a.conversation_id) : readableConversation(ctx, a.api_token, a.conversation_id);

type AskHead =
  | { error: string }
  | { user_id: string; conversation: { id: string; short_id: string; title: string } };

/** Who is asking and whether they may read the session. Cheap: no message rows. */
export const askHead = internalQuery({
  args: callerArgs,
  handler: async (ctx, args): Promise<AskHead> => {
    const access = await readFor(ctx, args);
    if (access.error !== undefined) return { error: access.error };
    const { conv, user } = access;
    return {
      user_id: user._id,
      conversation: {
        id: conv._id,
        short_id: conv.short_id ?? conv._id.slice(0, 7),
        title: conv.title || "Untitled session",
      },
    };
  },
});

/** Files each message changed, from the conversation's change index (no bodies). */
export const askFileChanges = internalQuery({
  args: callerArgs,
  handler: async (ctx, args): Promise<{ error: string } | { changes: Array<{ message_id: string; path: string }> }> => {
    const access = await readFor(ctx, args);
    if (access.error !== undefined) return { error: access.error };
    const changes = await readFileChangeIndex(ctx, access.conv._id);
    return {
      changes: changes
        .filter((c) => c.changeType !== "commit")
        .map((c) => ({ message_id: c.messageId, path: c.filePath })),
    };
  },
});

type AskScanStep =
  | { error: string }
  | { lines: AskScanLine[]; cursor?: { creation_time: number; skip: number }; reached?: boolean };

export const askScan = internalQuery({
  args: {
    ...callerArgs,
    order: v.union(v.literal("asc"), v.literal("desc")),
    after: v.optional(v.object({ creation_time: v.number(), skip: v.number() })),
    // Oldest-first steps stop before any row created after this (the tail already read it).
    stop_after: v.optional(v.number()),
    terms: v.array(v.string()),
    // Smaller steps than the byte bound, to exercise a long read on a shorter session.
    max_rows: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AskScanStep> => {
    const access = await readFor(ctx, args);
    if (access.error !== undefined) return { error: access.error };
    const lines: AskScanLine[] = [];
    let reached = false;
    const cursor = await streamMessageRows(ctx, access.conv._id, args.after, args.order, (m) => {
      if (args.stop_after !== undefined && m._creationTime > args.stop_after) return (reached = true);
      if (!isNonEmptyMessage(m)) return;
      lines.push({ id: m._id, creation_time: m._creationTime, ...toAskLine(m as unknown as AskMessage, 0, args.terms) });
      if (args.max_rows !== undefined && lines.length >= args.max_rows) return true;
    });
    return { lines, cursor: reached ? undefined : cursor, reached: reached || undefined };
  },
});

export const askRateMessage = (retryAfterMs: number | undefined) =>
  `You have asked a lot this hour. Try again in ${Math.ceil((retryAfterMs ?? 60_000) / 60_000)} min`;

/** The access refusals, as coded errors cliRoute answers with 401/403/404. */
const ACCESS_ERRORS: Record<string, { code: string; message: string }> = {
  Unauthorized: { code: "UNAUTHENTICATED", message: "Unauthorized: run `cast auth`" },
  "User not found": { code: "UNAUTHENTICATED", message: "Unauthorized: run `cast auth`" },
  "Conversation not found": { code: "NOT_FOUND", message: "No session found for that id" },
  "Access denied": { code: "FORBIDDEN", message: "You do not have access to that session" },
};

function accessError(error: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError(ACCESS_ERRORS[error] ?? { code: "FORBIDDEN", message: error });
}

const debugArgs = v.optional(v.object({
  max_steps: v.optional(v.number()),
  rows_per_step: v.optional(v.number()),
  include_prompt: v.optional(v.boolean()),
}));

interface AskArgs {
  /** The CLI's token; empty when `user_id` names the caller. */
  api_token: string;
  /** Set by a server-side caller that acts for a known person (sideAnswers.answer). */
  user_id?: Id<"users">;
  conversation_id: string;
  question: string;
  debug?: { max_steps?: number; rows_per_step?: number; include_prompt?: boolean };
}

/** The one implementation behind the CLI route and the web's side answers (sideAnswers.answer). */
export async function answerQuestion(ctx: ActionCtx, args: AskArgs): Promise<AskResult> {
  const started = Date.now();
  const question = args.question.trim();
  if (!question) throw new ConvexError({ code: "INVALID", message: "Ask needs a question" });
  if (question.length > ASK_MAX_QUESTION_CHARS) {
    throw new ConvexError({ code: "INVALID", message: `The question is ${question.length} characters; keep it under ${ASK_MAX_QUESTION_CHARS}` });
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("The server has no model key configured");

  const who: Caller = { api_token: args.api_token, conversation_id: args.conversation_id, ...(args.user_id ? { user_id: args.user_id } : {}) };
  const head: AskHead = await ctx.runQuery(internal.sessionAsk.askHead, who);
  if ("error" in head) throw accessError(head.error);
  // A regulated team's session is read to Anthropic only once it holds a BAA: refused here, with its one line.
  const gate = { ctx, scope: { conversationId: head.conversation.id as Id<"conversations">, apiToken: args.api_token || undefined } };
  await requireVendorAllowed(ctx, gate.scope, "anthropic");
  const limited = await ctx.runMutation(internal.ipRateLimit.bump, {
    key: askRateKey(head.user_id),
    max: ASK_RATE.max,
    window_ms: ASK_RATE.window_ms,
  });
  if (!limited.ok) throw new ConvexError({ code: "RATE_LIMITED", message: askRateMessage(limited.retry_after_ms), retryable: true });

  const usage = { input_tokens: 0, output_tokens: 0 };
  const expansion = await callModel({ ...askTermsRequest(question), label: "Ask terms", timeout_ms: ASK_TERMS_MS, gate });
  if (expansion) {
    usage.input_tokens += expansion.usage.input_tokens;
    usage.output_tokens += expansion.usage.output_tokens;
  }
  const terms = askTerms(question, expansion?.text);

  const read = await readSession(async ({ order, after, stop_after }) => {
    const page: AskScanStep = await ctx.runQuery(internal.sessionAsk.askScan, {
      ...who,
      order,
      after,
      stop_after,
      terms,
      max_rows: args.debug?.rows_per_step,
    });
    if ("error" in page) throw accessError(page.error);
    return page;
  }, { maxSteps: args.debug?.max_steps ?? ASK_MAX_STEPS, maxMs: ASK_SCAN_MS });
  const lines = read.lines;

  const files = await ctx.runQuery(internal.sessionAsk.askFileChanges, who);
  if ("error" in files) throw accessError(files.error);
  const idToLine = new Map(lines.map((l) => [l.id, l.line]));
  const extraFiles = new Map<number, string[]>();
  for (const change of files.changes) {
    const line = idToLine.get(change.message_id);
    if (line !== undefined) extraFiles.set(line, [...(extraFiles.get(line) ?? []), change.path]);
  }
  const { context, request } = askAnswerRequest({ question, title: head.conversation.title, read, termCount: terms.length, extraFiles });
  const answer = await callModelMetered({ ...request, label: "Ask answer", timeout_ms: ASK_ANSWER_MS, gate });
  const reply = answer.reply;
  // Name the API's own reason: an empty credit balance or a refused request
  // will not clear on retry, and the caller has to know that to stop retrying.
  if (!reply) throw new ConvexError({ code: "MODEL_FAILED", message: `The model did not answer (${answer.error ?? "no reason given"})` });
  usage.input_tokens += reply.usage.input_tokens;
  usage.output_tokens += reply.usage.output_tokens;

  const shown = new Set(context.shownLines);
  const citations = citationTargets(reply.text, lines, shown);
  return {
    conversation: { ...head.conversation, lines: lines.length },
    question,
    answer: reply.text,
    cited_lines: citations.map((c) => c.line),
    citations,
    terms,
    scanned_lines: lines.length,
    scan_complete: read.complete,
    ...(read.complete ? {} : { unread: { after: read.headLines, before: -read.tailLines } }),
    shown_lines: context.shownLines.length,
    matched_lines: context.matchedLines,
    model: CHEAP_MODEL,
    usage: { ...usage, cost_usd: Math.round(cheapModelCost(usage) * 10_000) / 10_000 },
    took_ms: Date.now() - started,
    ...(args.debug?.include_prompt ? { prompt: request.prompt } : {}),
  };
}

export const ask = internalAction({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    question: v.string(),
    // Evaluation knobs, never sent by the route: a smaller scan budget (the
    // long-session path on a session that would otherwise fit), and the exact
    // prompt in the result, so a prompt change can be ablated on fixed input.
    debug: debugArgs,
  },
  handler: (ctx, args): Promise<AskResult> => answerQuestion(ctx, args),
});

/** The web's former "Ask this session" call. Web now asks through side answers
 *  (sideAnswers.ts); this stays one release so tabs still on the old build
 *  keep answering after the backend deploys. Remove after the next release. */
export const askFromWeb = action({
  args: { conversation_id: v.string(), question: v.string() },
  handler: async (ctx, args): Promise<AskResult> => {
    if (!(await ctx.auth.getUserIdentity())) throw accessError("Unauthorized");
    return answerQuestion(ctx, { api_token: "", conversation_id: args.conversation_id, question: args.question });
  },
});
