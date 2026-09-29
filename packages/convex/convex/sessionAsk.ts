// `cast read <id> --ask "<question>"`: answer a question from ONE session,
// checking whether later messages revised the answer.
//
// The action runs where the model key lives, so the caller's machine needs
// none. It:
//   1. checks the caller may read the session (askHead, the same rule as
//      `cast read`), and rate limits the caller,
//   2. turns the question into search terms (its own words plus the model's),
//   3. scans the whole session in byte-bounded steps (askScan), keeping a
//      clipped line per message and which terms it mentions, so a whale never
//      holds more than one step's rows and never reads file change bodies,
//   4. picks the lines to show under a character budget (selectAskContext:
//      best matches, everything later on the same topic, the human's turns,
//      the tail), and
//   5. asks the model, which answers with `cast read` line citations.

import { internalAction, internalQuery } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { readableConversation, streamMessageRows, isNonEmptyMessage, type ScanCursor } from "./conversations";
import { readFileChangeIndex } from "./fileChangeBodies";
import { callModel, cheapModelCost, CHEAP_MODEL } from "./lib/anthropic";
import {
  ASK_SYSTEM_PROMPT,
  buildAskPrompt,
  buildTermsPrompt,
  citedLines,
  dedupeTerms,
  parseTermsReply,
  questionTerms,
  selectAskContext,
  toAskLine,
  type AskLine,
  type AskMessage,
} from "./lib/sessionAsk";

/** Characters of excerpt the model reads: about 50k tokens, a few cents. */
const ASK_BUDGET_CHARS = 180_000;
/** Scan steps one question may take (each reads at most READ_STEP_BYTES). */
const ASK_MAX_STEPS = 300;
const ASK_RATE = { max: 60, window_ms: 60 * 60 * 1000 };

type AskHead =
  | { error: string }
  | {
      user_id: string;
      conversation: { id: string; short_id: string; title: string };
      /** Files each message changed, from the conversation's change index (no bodies). */
      file_changes: Array<{ message_id: string; path: string }>;
    };

export const askHead = internalQuery({
  args: { api_token: v.string(), conversation_id: v.string() },
  handler: async (ctx, args): Promise<AskHead> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
    if (access.error !== undefined) return { error: access.error };
    const { conv, user } = access;
    const changes = await readFileChangeIndex(ctx, conv._id);
    return {
      user_id: user._id,
      conversation: {
        id: conv._id,
        short_id: conv.short_id ?? conv._id.slice(0, 7),
        title: conv.title || "Untitled session",
      },
      file_changes: changes
        .filter((c) => c.changeType !== "commit")
        .map((c) => ({ message_id: c.messageId, path: c.filePath })),
    };
  },
});

type AskScanStep = { error: string } | { lines: Array<AskLine & { id: string }>; cursor?: ScanCursor };

export const askScan = internalQuery({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    after: v.optional(v.object({ creation_time: v.number(), skip: v.number() })),
    first_line: v.number(),
    terms: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<AskScanStep> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
    if (access.error !== undefined) return { error: access.error };
    const lines: Array<AskLine & { id: string }> = [];
    const cursor = await streamMessageRows(ctx, access.conv._id, args.after, "asc", (m) => {
      if (!isNonEmptyMessage(m)) return;
      lines.push({ id: m._id, ...toAskLine(m as unknown as AskMessage, args.first_line + lines.length, args.terms) });
    });
    return { lines, cursor };
  },
});

export interface AskResult {
  conversation: { id: string; short_id: string; title: string; lines: number };
  question: string;
  answer: string;
  cited_lines: number[];
  terms: string[];
  scanned_lines: number;
  /** False when the session was longer than one question may scan; the tail was not read. */
  scan_complete: boolean;
  shown_lines: number;
  matched_lines: number;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  took_ms: number;
}

const ACCESS_ERRORS: Record<string, string> = {
  Unauthorized: "Unauthorized: run `cast auth`",
  "Conversation not found": "No session found for that id",
  "Access denied": "You do not have access to that session",
};

export const ask = internalAction({
  args: { api_token: v.string(), conversation_id: v.string(), question: v.string() },
  handler: async (ctx, args): Promise<AskResult> => {
    const started = Date.now();
    const question = args.question.trim();
    if (!question) throw new Error("--ask needs a question");

    const head: AskHead = await ctx.runQuery(internal.sessionAsk.askHead, {
      api_token: args.api_token,
      conversation_id: args.conversation_id,
    });
    if ("error" in head) throw new Error(ACCESS_ERRORS[head.error] ?? head.error);
    const limited = await ctx.runMutation(internal.ipRateLimit.bump, {
      key: `read-ask:${head.user_id}`,
      max: ASK_RATE.max,
      window_ms: ASK_RATE.window_ms,
    });
    if (!limited.ok) throw new Error(`Too many questions this hour; retry in ${Math.ceil((limited.retry_after_ms ?? 60_000) / 60_000)} min`);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("The server has no model key configured");

    const usage = { input_tokens: 0, output_tokens: 0 };
    const expansion = await callModel({ prompt: buildTermsPrompt(question), max_tokens: 200, label: "Ask terms" });
    if (expansion) {
      usage.input_tokens += expansion.usage.input_tokens;
      usage.output_tokens += expansion.usage.output_tokens;
    }
    const terms = dedupeTerms([...questionTerms(question), ...parseTermsReply(expansion?.text)]);

    const lines: AskLine[] = [];
    const idToLine = new Map<string, number>();
    let after: ScanCursor | undefined;
    let complete = false;
    for (let step = 0; step < ASK_MAX_STEPS && !complete; step++) {
      const page: AskScanStep = await ctx.runQuery(internal.sessionAsk.askScan, {
        api_token: args.api_token,
        conversation_id: args.conversation_id,
        after,
        first_line: lines.length + 1,
        terms,
      });
      if ("error" in page) throw new Error(ACCESS_ERRORS[page.error] ?? page.error);
      for (const { id, ...line } of page.lines) {
        idToLine.set(id, line.line);
        lines.push(line);
      }
      complete = !page.cursor;
      after = page.cursor;
    }

    const extraFiles = new Map<number, string[]>();
    for (const change of head.file_changes) {
      const line = idToLine.get(change.message_id);
      if (line !== undefined) extraFiles.set(line, [...(extraFiles.get(line) ?? []), change.path]);
    }
    const context = selectAskContext(lines, { budget: ASK_BUDGET_CHARS, termCount: terms.length, extraFiles });

    const reply = await callModel({
      system: ASK_SYSTEM_PROMPT,
      prompt: buildAskPrompt({
        question,
        title: head.conversation.title,
        totalLines: lines.length,
        shownLines: context.shownLines.length,
        excerpts: context.text,
      }),
      max_tokens: 1500,
      label: "Ask answer",
    });
    if (!reply) throw new Error("The model did not answer; retry in a moment");
    usage.input_tokens += reply.usage.input_tokens;
    usage.output_tokens += reply.usage.output_tokens;

    const shown = new Set(context.shownLines);
    return {
      conversation: { ...head.conversation, lines: lines.length },
      question,
      answer: reply.text,
      cited_lines: citedLines(reply.text).filter((l) => shown.has(l)),
      terms,
      scanned_lines: lines.length,
      scan_complete: complete,
      shown_lines: context.shownLines.length,
      matched_lines: context.matchedLines,
      model: CHEAP_MODEL,
      usage: { ...usage, cost_usd: Math.round(cheapModelCost(usage) * 10_000) / 10_000 },
      took_ms: Date.now() - started,
    };
  },
});
