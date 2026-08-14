// The decision queue's backend: explicit questions agents hand to their human.
//
// `cast decide` posts a row here (via /cli/decide in http.ts). The web queue
// subscribes with listForUser, and answering happens local-first on the client:
// the store marks the row answered (answer mutation) AND sends the chosen
// option into the session as a normal user message through the existing send
// pipeline. This module never delivers anything to a session itself.
import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

const optionValidator = v.object({
  label: v.string(),
  description: v.optional(v.string()),
});

// Resolved rows stay in the subscription window briefly so an answer made on
// one device reconciles on others instead of the row just vanishing.
const RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;

export const ask = mutation({
  args: {
    api_token: v.string(),
    session_id: v.string(),
    question: v.string(),
    options: v.array(optionValidator),
    context_md: v.optional(v.string()),
    report_slug: v.optional(v.string()),
    blocking: v.optional(v.boolean()),
    default_option: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };

    if (args.question.trim().length === 0) return { error: "Empty question" };
    if (args.options.length < 2) return { error: "At least two options required" };
    if (args.options.length > 9) return { error: "At most nine options (they map to keys 1-9)" };
    if (
      args.default_option !== undefined &&
      (args.default_option < 0 || args.default_option >= args.options.length)
    ) {
      return { error: "default_option out of range" };
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first();
    if (!conversation) return { error: "Session not found" };
    if (conversation.user_id.toString() !== auth.userId.toString()) {
      return { error: "Unauthorized: not your session" };
    }

    const now = Date.now();

    // Re-asking the same question from the same session updates the open row
    // instead of stacking duplicates (an agent may retry after a crash).
    const openRows = await ctx.db
      .query("session_decisions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", conversation._id).eq("status", "pending")
      )
      .collect();
    const existing = openRows.find((r) => r.question === args.question);
    if (existing) {
      await ctx.db.patch(existing._id, {
        options: args.options,
        context_md: args.context_md,
        report_slug: args.report_slug,
        blocking: args.blocking ?? true,
        default_option: args.default_option,
        created_at: now,
      });
      return { id: existing._id, updated: true };
    }

    const id = await ctx.db.insert("session_decisions", {
      conversation_id: conversation._id,
      session_id: args.session_id,
      user_id: conversation.user_id,
      question: args.question,
      context_md: args.context_md,
      options: args.options,
      report_slug: args.report_slug,
      blocking: args.blocking ?? true,
      default_option: args.default_option,
      status: "pending",
      created_at: now,
    });
    return { id, updated: false };
  },
});

export const resolve = mutation({
  args: {
    decision_id: v.id("session_decisions"),
    status: v.union(v.literal("answered"), v.literal("dismissed")),
    answer_index: v.optional(v.number()),
    answer_text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const row = await ctx.db.get(args.decision_id);
    if (!row) throw new Error("Decision not found");
    if (row.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: not your decision");
    }
    // Answering an already-resolved row is a no-op, not an error — two devices
    // can race and the first resolution wins.
    if (row.status !== "pending") return { already_resolved: true };

    await ctx.db.patch(args.decision_id, {
      status: args.status,
      answer_index: args.answer_index,
      answer_text: args.answer_text,
      resolved_at: Date.now(),
      resolved_by: userId,
    });
    return { already_resolved: false };
  },
});

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const pending = await ctx.db
      .query("session_decisions")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "pending"))
      .collect();

    const cutoff = Date.now() - RESOLVED_WINDOW_MS;
    const answered = await ctx.db
      .query("session_decisions")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "answered"))
      .collect();
    const dismissed = await ctx.db
      .query("session_decisions")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "dismissed"))
      .collect();
    const recentResolved = [...answered, ...dismissed].filter(
      (r) => (r.resolved_at ?? 0) >= cutoff
    );

    return [...pending, ...recentResolved];
  },
});
