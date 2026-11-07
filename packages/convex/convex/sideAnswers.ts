// Side answers: `/btw <question>` in a conversation's composer. The person gets
// an answer about the session without interrupting the agent or adding a line
// to its transcript.
//
// The composer writes an optimistic row and the askSideQuestion dispatch side
// effect lands here (askCore): it checks the question and the asker's access,
// inserts a pending row keyed by the composer's client id, and schedules
// `answer`. The answer is the same no-tools, cheap-model read as
// `cast read <id> --ask` (sessionAsk.answerQuestion), run for the asker by
// user id, and it patches the row answered or failed. The web reads the rows
// through listForConversation into the sideAnswers store collection.
//
// Rows are private to the asker and readable only while the asker can still
// read the conversation (the conversation's own access rule).

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { readableConversationAs } from "./conversations";
import { windowSpent } from "./ipRateLimit";
import { getAuthenticatedUserId } from "./pendingMessages";
import { answerQuestion, ASK_RATE, askRateKey, askRateMessage } from "./sessionAsk";
import { ASK_MAX_QUESTION_CHARS } from "./lib/sessionAsk";
import type { SideAnswerRow } from "@codecast/shared/contracts";

/** How many of a person's side answers on one conversation the panel holds. */
export const SIDE_ANSWERS_LIMIT = 50;

const project = (r: Doc<"side_answers">): SideAnswerRow => ({
  _id: r._id,
  conversation_id: r.conversation_id,
  client_id: r.client_id,
  question: r.question,
  status: r.status,
  ...(r.answer !== undefined ? { answer: r.answer } : {}),
  ...(r.citations ? { citations: r.citations } : {}),
  ...(r.unread ? { unread: r.unread } : {}),
  ...(r.error_code ? { error_code: r.error_code } : {}),
  ...(r.error_message ? { error_message: r.error_message } : {}),
  created_at: r.created_at,
  ...(r.answered_at ? { answered_at: r.answered_at } : {}),
});

/** The viewer's side answers on one conversation, oldest first. */
export const listForConversation = query({
  args: { conversation_id: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SideAnswerRow[]> => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) return [];
    const access = await readableConversationAs(ctx, userId, args.conversation_id);
    if (access.error !== undefined) return [];
    const conv = access.conv;
    const rows = await ctx.db
      .query("side_answers")
      .withIndex("by_conversation_user", (q) => q.eq("conversation_id", conv._id).eq("user_id", userId))
      .order("desc")
      .take(SIDE_ANSWERS_LIMIT);
    return rows.reverse().map(project);
  },
});

/** Ask a side question. A refusal is returned, not thrown: the outbox would redrive a throw forever. */
export async function askCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: { conversation_id: string; question: string; client_id: string },
): Promise<{ ok: true; id: Id<"side_answers"> } | { error: string }> {
  const question = (args.question ?? "").trim();
  if (!question) return { error: "Ask needs a question" };
  if (question.length > ASK_MAX_QUESTION_CHARS) return { error: `Keep the question under ${ASK_MAX_QUESTION_CHARS} characters` };
  if (!args.client_id) return { error: "Missing client id" };
  // A redriven send finds its own row and stops there.
  const existing = await ctx.db.query("side_answers").withIndex("by_client_id", (q) => q.eq("client_id", args.client_id)).first();
  if (existing) return String(existing.user_id) === String(userId) ? { ok: true, id: existing._id } : { error: "That id is taken" };
  const access = await readableConversationAs(ctx, userId, args.conversation_id);
  if (access.error !== undefined) return { error: access.error === "Conversation not found" ? "This session could not be found" : "You do not have access to read this session" };
  const conv = access.conv;
  // Refused here, not in the scheduled answer, so a spent hour costs no row and no job.
  const wait = await windowSpent(ctx.db, askRateKey(userId), ASK_RATE.max, ASK_RATE.window_ms);
  if (wait !== null) return { error: askRateMessage(wait) };
  const id = await ctx.db.insert("side_answers", {
    conversation_id: conv._id,
    user_id: userId,
    client_id: args.client_id,
    question,
    status: "pending",
    created_at: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.sideAnswers.answer, { id });
  return { ok: true, id };
}

export const row = internalQuery({
  args: { id: v.id("side_answers") },
  handler: (ctx, args) => ctx.db.get(args.id),
});

export const settle = internalMutation({
  args: {
    id: v.id("side_answers"),
    answer: v.optional(v.string()),
    citations: v.optional(v.array(v.object({ line: v.number(), message_id: v.string() }))),
    unread: v.optional(v.object({ after: v.number(), before: v.number() })),
    error_code: v.optional(v.string()),
    error_message: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...result }) => {
    // The conversation may have been deleted, and its rows purged, mid-answer.
    if (!(await ctx.db.get(id))) return;
    await ctx.db.patch(id, { ...result, status: result.answer !== undefined ? "answered" : "failed", answered_at: Date.now() });
  },
});

/** Answer one pending row for the person who asked it. */
export const answer = internalAction({
  args: { id: v.id("side_answers") },
  handler: async (ctx, args) => {
    const r = await ctx.runQuery(internal.sideAnswers.row, args);
    if (!r || r.status !== "pending") return;
    try {
      const result = await answerQuestion(ctx, {
        api_token: "",
        user_id: r.user_id,
        conversation_id: r.conversation_id,
        question: r.question,
      });
      await ctx.runMutation(internal.sideAnswers.settle, {
        id: args.id,
        answer: result.answer,
        citations: result.citations,
        ...(result.unread ? { unread: result.unread } : {}),
      });
    } catch (error) {
      const data = error instanceof ConvexError ? (error.data as { code?: string; message?: string }) : undefined;
      await ctx.runMutation(internal.sideAnswers.settle, {
        id: args.id,
        error_code: data?.code ?? "FAILED",
        ...(data?.message ? { error_message: data.message } : {}),
      });
    }
  },
});
