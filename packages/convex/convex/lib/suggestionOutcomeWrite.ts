// The write behind a composer suggestion's outcome, shared by the mutation
// clients call now (suggestionOutcomes.record) and the name released phone
// builds still call (composerSuggestions.recordSuggestionOutcome). A leaf: it
// defines no functions, so both modules import it without a load-order cycle.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

// One suggestion at most, of a length that is a message, not a pasted wall.
export const MAX_SUGGESTIONS = 1;
export const MAX_SUGGESTION_CHARS = 1000;

/** The vendor the suggester sends to; vendor gates on what it reads ask about this one. */
export function suggestionsProvider(): "anthropic" | "openai" {
  return process.env.SUGGESTIONS_PROVIDER === "openai" ? "openai" : "anthropic";
}

export const outcomeArgs = {
  conversation_id: v.id("conversations"),
  anchor_message_uuid: v.string(),
  suggestion: v.string(),
  outcome: v.union(v.literal("sent"), v.literal("edited"), v.literal("ignored"), v.literal("dismissed")),
  // What was on show for the turn (absent from clients built before it).
  shown: v.optional(v.array(v.string())),
  // How many characters of the sent message the person typed: the composer
  // appends their words after any quotes or answers it folds in, so the
  // transcript's last `typed_length` characters are theirs. A count, never
  // the words.
  typed_length: v.optional(v.number()),
};

type OutcomeArgs = {
  conversation_id: any;
  anchor_message_uuid: string;
  suggestion: string;
  outcome: "sent" | "edited" | "ignored" | "dismissed";
  shown?: string[];
  typed_length?: number;
};

/** Owner-gated, append-only: suggestions are shown to a session's owner only, so only the owner reports on them. */
export async function writeSuggestionOutcome(ctx: any, args: OutcomeArgs): Promise<void> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return;
  const conv = await ctx.db.get(args.conversation_id);
  if (!conv || String(conv.user_id) !== String(userId)) return;
  const cap = (t: string) => t.slice(0, MAX_SUGGESTION_CHARS);
  await ctx.db.insert("suggestion_outcomes", {
    user_id: userId,
    conversation_id: args.conversation_id,
    anchor_message_uuid: args.anchor_message_uuid,
    suggestion: cap(args.suggestion),
    outcome: args.outcome,
    ...(args.shown ? { shown: args.shown.slice(0, MAX_SUGGESTIONS).map(cap) } : {}),
    ...(typeof args.typed_length === "number" && args.typed_length > 0 ? { typed_length: Math.round(args.typed_length) } : {}),
    created_at: Date.now(),
  });
}
