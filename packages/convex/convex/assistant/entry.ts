// How a hosted conversation starts and wakes (plan pl-840, build spec
// docs/architecture/hosted-assistant.md "The turn"). A hosted conversation is
// an ordinary conversations row with agent_type "codecast": the same privacy,
// team and short id as any session a person starts, but no device ever
// claims it and no daemon command is enqueued. Its turns run in this backend.
//
// Every producer of input (the composer, `cast send`, a routine firing, an
// approval answered) goes through enqueuePendingMessage, which schedules
// `wake` for a hosted conversation. `wake` is the one door into the turn
// engine.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { mutation, internalMutation } from "../functions";
import type { Doc, Id } from "../_generated/dataModel";
import { insertStartedConversation } from "../conversations";
import { ensureHostedManagedSession } from "../managedSessions";
import { enqueuePendingMessage } from "../pendingMessages";
import { checkRateLimit } from "../rateLimit";
import { wakeCauseValidator } from "../assistantSchema";

/** Start a hosted conversation for the signed-in person, optionally with its
 *  first message, which is queued like any composer send and so wakes the
 *  conversation's first turn.
 *
 *  Built for an optimistic create (inboxStore.beginOptimisticSession): the
 *  client passes its stub's id as `session_id`, the server row carries it, and
 *  the store's by_session_id resolver maps the stub onto the row when it
 *  syncs. A retry with the same session_id (an outbox replay) returns the row
 *  the first call made, whose first message that call already queued in the
 *  same transaction. `first_message_client_id` is the client_id of the
 *  store's optimistic pending row for the first message, so the two
 *  reconcile instead of showing twice. */
export const startConversation = mutation({
  args: {
    title: v.optional(v.string()),
    firstMessage: v.optional(v.string()),
    session_id: v.optional(v.string()),
    first_message_client_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ conversation_id: Id<"conversations">; short_id: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const sessionId = args.session_id?.trim() || crypto.randomUUID();
    if (args.session_id) {
      const existing = await ctx.db.query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
        .first();
      if (existing) {
        if (String(existing.user_id) !== String(userId) || !isHostedAgentType(existing.agent_type)) {
          throw new Error("That session id belongs to another conversation");
        }
        return { conversation_id: existing._id, short_id: shortIdOf(existing) };
      }
    }
    await checkRateLimit(ctx, userId, "createConversation");

    const title = args.title?.trim();
    const conversationId = await insertStartedConversation(ctx, userId, {
      agent_type: HOSTED_AGENT_TYPE,
      session_id: sessionId,
      started_at: Date.now(),
      extra: title ? { title } : undefined,
    });
    const conversation = (await ctx.db.get(conversationId))!;
    // The inbox reads a conversation's work state off its managed row.
    await ensureHostedManagedSession(ctx, conversation);

    const firstMessage = args.firstMessage?.trim();
    if (firstMessage) {
      await enqueuePendingMessage(ctx, conversation, userId, {
        content: firstMessage,
        human: true,
        client_id: args.first_message_client_id,
      });
    }
    return { conversation_id: conversationId, short_id: shortIdOf(conversation) };
  },
});

function shortIdOf(conversation: Doc<"conversations">): string {
  return conversation.short_id ?? String(conversation._id).slice(0, 7);
}

/** Something gave a hosted conversation new input: a message, a routine, an
 *  answered approval, or the engine itself when input arrived during a turn.
 *  Scheduled by wakeHostedConversation (pendingMessages.ts) whenever a row
 *  becomes pending: an enqueue, a Retry, and the retryStuckMessages backstop
 *  (cause "continue") when a row sat pending past the in-flight window. Never
 *  for a safety-stopped conversation, and only the owner can enqueue.
 *
 *  The cause is a scheduling hint, never consent. A pending_call executes
 *  only when its session_decisions row is "answered", answered_by.kind is
 *  "user" and the answerer is the conversation's owner, read from that row.
 *
 *  Duplicate wakes are expected (the backstop, a send during a turn), so the
 *  lease must make a second wake a no-op.
 *
 *  A no-op until the turn engine lands (assistant/turns.ts): it will take the
 *  lease here (one running turn per conversation, the wallet reservation in
 *  the same mutation) and schedule the run, or leave the input queued for the
 *  running turn to pick up. The pending rows wait as "pending" meanwhile. */
export const wake = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    cause: wakeCauseValidator,
  },
  handler: async (_ctx, _args): Promise<null> => {
    return null;
  },
});
