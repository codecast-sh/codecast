// How a hosted conversation starts and wakes (plan pl-840, build spec
// docs/architecture/hosted-assistant.md "The turn"). A hosted conversation is
// an ordinary conversations row with agent_type "codecast": the same privacy,
// team and short id as any session a person starts, but no device ever
// claims it and no daemon command is enqueued. Its turns run in this backend.
//
// Every producer of input (the composer, `cast send`, a routine firing, an
// approval answered) goes through enqueuePendingMessage, which schedules
// `wake` for a hosted conversation. `wake` is the one door into the turn
// engine. It is scheduled, so it is also only as fast as the scheduler: the
// person's own client therefore calls `kick` right after a send, which runs
// the turn at once, and the scheduled wake and run stay as the fallback.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, mutation, internalMutation } from "../functions";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { startHostedConversationFor } from "./start";
import { wakeCauseValidator } from "../assistantSchema";
import { leaseTurn, leaseExpired, resumeAfterNotice, runTurn, stopRunningTurn } from "./turns";
import { confirmEmailCode, sendEmailCode } from "../lib/emailProof";
import { turnsIn } from "./input";
import { TURN_DEADLINE_MS } from "@codecast/shared/contracts/assistant";

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

/** How long a kick keeps carrying on with the conversation's next turn (input
 *  that came in while one ran): a further turn may take TURN_DEADLINE_MS, and
 *  the whole action must end inside Convex's ten minute action limit. */
export const KICK_CHAIN_MS = 10 * 60_000 - TURN_DEADLINE_MS - 30_000;

/** The person's client calls this right after it gives a hosted conversation
 *  input (a send, a first message, an approval's answer), so the turn starts
 *  in about a second however far behind the scheduler is. It is the same
 *  lease as `wake`, then runs the leased turn in this action instead of
 *  waiting for the scheduled run; whichever of the two begins first claims
 *  the turn (turns.ts begin) and the other stands down. When the turn ends
 *  with the next one leased (input arrived meanwhile), it runs that one too,
 *  while there is time. Nothing to run, or a conversation that is not the
 *  caller's, is a quiet no-op: the scheduled path stays the fallback. */
export const kick = action({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ ran: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const startedAt = Date.now();
    let ran = 0;
    do {
      const turnId = await ctx.runMutation(internal.assistant.entry.wakeNow, { conversation_id: args.conversation_id, user_id: userId });
      if (!turnId || !(await runTurn(ctx, turnId))) break;
      ran++;
    } while (Date.now() - startedAt < KICK_CHAIN_MS);
    return { ran };
  },
});

/** kick's lease: wakes the conversation as `wake` does and returns its
 *  running turn when no run has begun it yet, else null. */
export const wakeNow = internalMutation({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<Id<"assistant_turns"> | null> => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== args.user_id) return null;
    await leaseTurn(ctx, args.conversation_id);
    const now = Date.now();
    const turn = (await turnsIn(ctx, args.conversation_id, "running")).find((t) => t.run_claimed_at === undefined && !leaseExpired(t, now));
    return turn?._id ?? null;
  },
});

/** The person's Stop on a hosted conversation that is working
 *  (turns.ts stopRunningTurn). Only the conversation's owner may stop it;
 *  false when nothing was running. */
export const stop = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<boolean> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== userId) return false;
    return await stopRunningTurn(ctx, args.conversation_id);
  },
});

/** Mails the signed-in person a new code for a conversation stopped on
 *  `verify` (freeGate.ts), replacing the one sent with the stop. */
export const sendEmailProof = mutation({
  args: {},
  handler: async (ctx): Promise<{ sent_to: string }> => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    if (!user) throw new Error("Not authenticated");
    return await sendEmailCode(ctx, user);
  },
});

/** The person entered the mailed code: their email is proven, and the
 *  conversation that stopped on `verify` picks up the ask it stopped on. A
 *  wrong or expired code throws the sentence to show (lib/emailProof). */
export const confirmEmailProof = mutation({
  args: { code: v.string(), conversation_id: v.optional(v.id("conversations")) },
  handler: async (ctx, args): Promise<{ resumed: boolean }> => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    if (!user) throw new Error("Not authenticated");
    await confirmEmailCode(ctx, user, args.code);
    const conversation = args.conversation_id ? await ctx.db.get(args.conversation_id) : null;
    if (!conversation || conversation.user_id !== user._id || conversation.hosted_stop !== "verify") return { resumed: false };
    const outcome = await resumeAfterNotice(ctx, conversation._id);
    return { resumed: outcome === "started" || outcome === "queued" };
  },
});
