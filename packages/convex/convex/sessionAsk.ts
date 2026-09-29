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

import { action, internalAction, internalQuery } from "./functions";
import type { ActionCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { readableConversation, streamMessageRows, isNonEmptyMessage } from "./conversations";
import { readFileChangeIndex } from "./fileChangeBodies";
import { callModel, cheapModelCost, CHEAP_MODEL } from "./lib/anthropic";
import {
  ASK_MAX_QUESTION_CHARS,
  ASK_SYSTEM_PROMPT,
  buildAskPrompt,
  buildTermsPrompt,
  citationTargets,
  dedupeTerms,
  parseTermsReply,
  questionTerms,
  readSession,
  selectAskContext,
  toAskLine,
  type AskMessage,
  type AskScanLine,
} from "./lib/sessionAsk";

/** Characters of excerpt the model reads: about 50k tokens, a few cents. */
const ASK_BUDGET_CHARS = 180_000;
/** Scan steps one question may take (each reads at most READ_STEP_BYTES). */
const ASK_MAX_STEPS = 300;
/** Wall time the scan may take. With the two model calls' own limits this
 *  stays inside the CLI's 300s wait, so the server never runs on for nobody. */
const ASK_SCAN_MS = 120_000;
const ASK_TERMS_MS = 20_000;
const ASK_ANSWER_MS = 90_000;
const ASK_RATE = { max: 60, window_ms: 60 * 60 * 1000 };

type AskHead =
  | { error: string }
  | { user_id: string; conversation: { id: string; short_id: string; title: string } };

/** Who is asking and whether they may read the session. Cheap: no message rows. */
export const askHead = internalQuery({
  args: { api_token: v.string(), conversation_id: v.string() },
  handler: async (ctx, args): Promise<AskHead> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
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
  args: { api_token: v.string(), conversation_id: v.string() },
  handler: async (ctx, args): Promise<{ error: string } | { changes: Array<{ message_id: string; path: string }> }> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
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
    api_token: v.string(),
    conversation_id: v.string(),
    order: v.union(v.literal("asc"), v.literal("desc")),
    after: v.optional(v.object({ creation_time: v.number(), skip: v.number() })),
    // Oldest-first steps stop before any row created after this (the tail already read it).
    stop_after: v.optional(v.number()),
    terms: v.array(v.string()),
    // Smaller steps than the byte bound, to exercise a long read on a shorter session.
    max_rows: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AskScanStep> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
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

export interface AskResult {
  conversation: { id: string; short_id: string; title: string; lines: number };
  question: string;
  answer: string;
  /** `cast read` numbers; negative ones count back from the end (-1 is the last). */
  cited_lines: number[];
  /** The message row behind each cited line, so a reader can open it without
   *  re-deriving `cast read` numbering. */
  citations: Array<{ line: number; message_id: string }>;
  terms: string[];
  scanned_lines: number;
  /** False when the session was too long to read whole within the budget. */
  scan_complete: boolean;
  /** When incomplete: every message between msg `after` and msg `before` was not read. */
  unread?: { after: number; before: number };
  shown_lines: number;
  matched_lines: number;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  took_ms: number;
  /** Only with debug.include_prompt. */
  prompt?: string;
}

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
  /** Empty for a signed-in web caller: the access check reads the session's auth first. */
  api_token: string;
  conversation_id: string;
  question: string;
  debug?: { max_steps?: number; rows_per_step?: number; include_prompt?: boolean };
}

/** The one implementation behind the CLI route and the web action. */
async function answerQuestion(ctx: ActionCtx, args: AskArgs): Promise<AskResult> {
  const started = Date.now();
  const question = args.question.trim();
  if (!question) throw new ConvexError({ code: "INVALID", message: "Ask needs a question" });
  if (question.length > ASK_MAX_QUESTION_CHARS) {
    throw new ConvexError({ code: "INVALID", message: `The question is ${question.length} characters; keep it under ${ASK_MAX_QUESTION_CHARS}` });
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("The server has no model key configured");

  const who = { api_token: args.api_token, conversation_id: args.conversation_id };
  const head: AskHead = await ctx.runQuery(internal.sessionAsk.askHead, who);
  if ("error" in head) throw accessError(head.error);
  const limited = await ctx.runMutation(internal.ipRateLimit.bump, {
    key: `read-ask:${head.user_id}`,
    max: ASK_RATE.max,
    window_ms: ASK_RATE.window_ms,
  });
  if (!limited.ok) {
    const minutes = Math.ceil((limited.retry_after_ms ?? 60_000) / 60_000);
    throw new ConvexError({ code: "RATE_LIMITED", message: `Too many questions this hour; retry in ${minutes} min`, retryable: true });
  }

  const usage = { input_tokens: 0, output_tokens: 0 };
  const expansion = await callModel({ prompt: buildTermsPrompt(question), max_tokens: 200, label: "Ask terms", timeout_ms: ASK_TERMS_MS });
  if (expansion) {
    usage.input_tokens += expansion.usage.input_tokens;
    usage.output_tokens += expansion.usage.output_tokens;
  }
  const terms = dedupeTerms([...questionTerms(question), ...parseTermsReply(expansion?.text)]);

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
  const unreadAfter = read.complete ? undefined : read.headLines;
  const context = selectAskContext(lines, { budget: ASK_BUDGET_CHARS, termCount: terms.length, extraFiles, unreadAfter });

  const prompt = buildAskPrompt({
    question,
    title: head.conversation.title,
    totalLines: lines.length,
    shownLines: context.shownLines.length,
    excerpts: context.text,
    unread: read.complete ? undefined : { headLines: read.headLines, tailLines: read.tailLines },
  });
  const reply = await callModel({
    system: ASK_SYSTEM_PROMPT,
    prompt,
    max_tokens: 1500,
    label: "Ask answer",
    timeout_ms: ASK_ANSWER_MS,
  });
  if (!reply) throw new Error("The model did not answer; retry in a moment");
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
    ...(args.debug?.include_prompt ? { prompt } : {}),
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

/** "Ask this session" in the web: the same answer for a signed-in viewer, under
 *  the same access rule (readableConversation) and the same hourly rate. */
export const askFromWeb = action({
  args: { conversation_id: v.string(), question: v.string() },
  handler: async (ctx, args): Promise<AskResult> => {
    if (!(await ctx.auth.getUserIdentity())) throw accessError("Unauthorized");
    return answerQuestion(ctx, { api_token: "", conversation_id: args.conversation_id, question: args.question });
  },
});
