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
import { mutation, internalMutation } from "../functions";
import type { Id } from "../_generated/dataModel";
import { startHostedConversationFor } from "./start";
import { wakeCauseValidator } from "../assistantSchema";
import { leaseTurn } from "./turns";

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
 *  reconcile instead of showing twice. The title and the first message are
 *  bounded (HOSTED_TITLE_MAX_CHARS, and HOSTED_INPUT_MAX_CHARS through
 *  enqueuePendingMessage like every send). */
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
    return startHostedConversationFor(ctx, userId, args);
  },
});

export { startHostedConversationFor, type HostedStartArgs } from "./start";

/** Something gave a hosted conversation new input: a message, a routine, an
 *  answered approval, or the engine itself when input arrived during a turn.
 *  Scheduled by wakeHostedConversation (pendingMessages.ts) whenever a row
 *  becomes pending: an enqueue, a Retry, and the retryStuckMessages backstop
 *  (cause "continue") when a row sat pending past the in-flight window. Never
 *  for a safety-stopped conversation, and only the owner can enqueue.
 *
 *  The cause is a scheduling hint, never consent. A pending_call executes
 *  only when its session_decisions row is "answered", answered_by.kind is
 *  "user" and the answerer is the conversation's owner, read from that row
 *  when the next turn begins (turns.ts begin).
 *
 *  Duplicate wakes are expected (the backstop, a send during a turn), and the
 *  lease makes a second one a no-op: turns.ts leaseTurn starts a turn only
 *  when none is running and there is input, reserving its ceiling from the
 *  wallet in this same mutation, queues it behind the person's other running
 *  turns past their plan's limit, or ends it at once for budget. Input that
 *  arrives while a turn runs waits as "pending" and the turn's finish wakes
 *  the conversation again. */
export const wake = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    cause: wakeCauseValidator,
  },
  handler: async (ctx, args): Promise<null> => {
    await leaseTurn(ctx, args.conversation_id);
    return null;
  },
});
