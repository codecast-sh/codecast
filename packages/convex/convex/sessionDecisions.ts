// The decision queue's backend: explicit questions agents hand to their human.
//
// `cast decide` posts a row here (via /cli/decide in http.ts). The web queue
// subscribes with listForUser, and answering happens local-first on the client:
// the store marks the row answered (answer mutation) AND sends the chosen
// option into the session as a normal user message through the existing send
// pipeline. This module never delivers anything to a session itself.
//
// The agent side has three more verbs (all via /cli/decide with an `action`):
// edit (change the open question in place), withdraw (`cast decide cancel`),
// and listForSession (`cast decide ls`).
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

// The row an agent may act on: it must exist and belong to the token's user.
// A decision id is the handle `cast decide` printed; the session id is only a
// sanity check (an agent must not edit another session's question by id).
async function ownedDecision(
  ctx: any,
  auth: { userId: any },
  decisionId: string,
  sessionId?: string
): Promise<{ row: any } | { error: string }> {
  const id = ctx.db.normalizeId("session_decisions", decisionId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) return { error: "Decision not found" };
  if (row.user_id.toString() !== auth.userId.toString()) return { error: "Unauthorized: not your decision" };
  if (sessionId && row.session_id !== sessionId) return { error: "Decision belongs to another session" };
  return { row };
}

// Every non-pending row explains itself the same way to the CLI: the agent
// learns what happened to the question instead of a bare refusal.
function resolvedSummary(row: any): { status: string; answer_index?: number; answer_text?: string; answer_label?: string } {
  return {
    status: row.status,
    answer_index: row.answer_index,
    answer_text: row.answer_text,
    answer_label: row.answer_index !== undefined ? row.options[row.answer_index]?.label : undefined,
  };
}

// `cast decide edit`: the facts changed, so the open question changes with
// them — in place, keeping its age and its place in the queue — instead of a
// second row that "supersedes" the first. Every field is optional; a field
// that is passed replaces the stored one (options as a whole list).
export const edit = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
    session_id: v.optional(v.string()),
    question: v.optional(v.string()),
    options: v.optional(v.array(optionValidator)),
    context_md: v.optional(v.string()),
    report_slug: v.optional(v.string()),
    blocking: v.optional(v.boolean()),
    default_option: v.optional(v.number()),
    // true clears the default (an advisory ask becoming a blocking one).
    clear_default: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const found = await ownedDecision(ctx, auth, args.decision_id, args.session_id);
    if ("error" in found) return found;
    const { row } = found;
    if (row.status !== "pending") {
      return { error: `Decision is already ${row.status}`, ...resolvedSummary(row) };
    }

    const question = args.question ?? row.question;
    const options = args.options ?? row.options;
    const blocking = args.blocking ?? row.blocking;
    let defaultOption = args.clear_default ? undefined : args.default_option ?? row.default_option;
    if (question.trim().length === 0) return { error: "Empty question" };
    if (options.length < 2) return { error: "At least two options required" };
    if (options.length > 9) return { error: "At most nine options (they map to keys 1-9)" };
    if (defaultOption !== undefined && (defaultOption < 0 || defaultOption >= options.length)) {
      return { error: "default_option out of range" };
    }
    // A blocking ask has no default; an advisory one needs one.
    if (blocking) defaultOption = undefined;
    else if (defaultOption === undefined) return { error: "An advisory decision needs a default option" };

    await ctx.db.patch(row._id, {
      question,
      options,
      context_md: args.context_md ?? row.context_md,
      report_slug: args.report_slug ?? row.report_slug,
      blocking,
      default_option: defaultOption,
      updated_at: Date.now(),
    });
    return { id: row._id, status: "pending" };
  },
});

// `cast decide cancel`: the agent takes its question back. Distinct from the
// human's dismiss so the transcript can say who closed it and why.
export const withdraw = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const found = await ownedDecision(ctx, auth, args.decision_id, args.session_id);
    if ("error" in found) return found;
    const { row } = found;
    if (row.status !== "pending") {
      return { error: `Decision is already ${row.status}`, ...resolvedSummary(row) };
    }
    await ctx.db.patch(row._id, { status: "withdrawn", resolved_at: Date.now() });
    return { id: row._id, status: "withdrawn" };
  },
});

// `cast decide ls`: what this session has asked, newest first, so an agent can
// find the id to edit or cancel and read how an earlier ask was answered.
export const listForSession = mutation({
  args: {
    api_token: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first();
    if (!conversation) return { error: "Session not found" };
    if (conversation.user_id.toString() !== auth.userId.toString()) {
      return { error: "Unauthorized: not your session" };
    }
    const rows: any[] = [];
    for (const status of ["pending", "answered", "dismissed", "withdrawn"] as const) {
      rows.push(
        ...(await ctx.db
          .query("session_decisions")
          .withIndex("by_conversation_status", (q) =>
            q.eq("conversation_id", conversation._id).eq("status", status)
          )
          .collect())
      );
    }
    rows.sort((a, b) => b.created_at - a.created_at);
    return {
      decisions: rows.map((r) => ({
        id: r._id,
        question: r.question,
        options: r.options,
        blocking: r.blocking,
        default_option: r.default_option,
        created_at: r.created_at,
        updated_at: r.updated_at,
        resolved_at: r.resolved_at,
        ...resolvedSummary(r),
      })),
    };
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
    const withdrawn = await ctx.db
      .query("session_decisions")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "withdrawn"))
      .collect();
    const recentResolved = [...answered, ...dismissed, ...withdrawn].filter(
      (r) => (r.resolved_at ?? 0) >= cutoff
    );

    return [...pending, ...recentResolved];
  },
});
