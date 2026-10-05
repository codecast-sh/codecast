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
import { mutation, internalMutation } from "../functions";
import type { Id } from "../_generated/dataModel";
import { insertStartedConversation } from "../conversations";
import { ensureHostedManagedSession } from "../managedSessions";
import { enqueuePendingMessage } from "../pendingMessages";
import { checkRateLimit } from "../rateLimit";
import { wakeCauseValidator } from "../assistantSchema";

/** Start a hosted conversation for the signed-in person, optionally with its
 *  first message, which is queued like any composer send and so wakes the
 *  conversation's first turn. */
export const startConversation = mutation({
  args: {
    title: v.optional(v.string()),
    firstMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ conversation_id: Id<"conversations">; short_id: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await checkRateLimit(ctx, userId, "createConversation");

    const title = args.title?.trim();
    const conversationId = await insertStartedConversation(ctx, userId, {
      agent_type: HOSTED_AGENT_TYPE,
      session_id: crypto.randomUUID(),
      started_at: Date.now(),
      extra: title ? { title } : undefined,
    });
    const conversation = (await ctx.db.get(conversationId))!;
    // The inbox reads a conversation's work state off its managed row.
    await ensureHostedManagedSession(ctx, conversation);

    const firstMessage = args.firstMessage?.trim();
    if (firstMessage) {
      await enqueuePendingMessage(ctx, conversation, userId, { content: firstMessage, human: true });
    }
    return { conversation_id: conversationId, short_id: conversation.short_id ?? conversationId.slice(0, 7) };
  },
});

/** Something gave a hosted conversation new input: a message, a routine, an
 *  answered approval, or the engine itself when input arrived during a turn.
 *  Scheduled by enqueuePendingMessage for every non-held row.
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
