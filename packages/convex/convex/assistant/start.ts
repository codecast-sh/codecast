// How a hosted conversation starts (plan pl-840, build spec
// docs/architecture/hosted-assistant.md "The turn"). A leaf beside entry.ts,
// which also wakes the turn engine, so a module the engine's tools import
// (agentTasks, for a routine's home) can start one without importing the
// engine back.
import { HOSTED_AGENT_TYPE, HOSTED_TITLE_MAX_CHARS } from "@codecast/shared/contracts/assistant";
import { isHostedAgentType } from "@codecast/shared/contracts";
import type { MutationCtx } from "../functions";
import type { Doc, Id } from "../_generated/dataModel";
import { insertStartedConversation } from "../conversations";
import { ensureHostedManagedSession } from "../managedSessions";
import { enqueuePendingMessage } from "../pendingMessages";
import { checkRateLimit } from "../rateLimit";

export type HostedStartArgs = {
  title?: string;
  firstMessage?: string;
  session_id?: string;
  first_message_client_id?: string;
};

/** The hosted start itself, for entry.startConversation, for the web's
 *  createSession dispatch (a stub whose agent is the hosted assistant), and
 *  for a routine armed from the routines page, whose home it is. */
export async function startHostedConversationFor(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: HostedStartArgs,
): Promise<{ conversation_id: Id<"conversations">; short_id: string }> {
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
  if (title && title.length > HOSTED_TITLE_MAX_CHARS) {
    throw new Error(`A title can be at most ${HOSTED_TITLE_MAX_CHARS} characters`);
  }
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
}

function shortIdOf(conversation: Doc<"conversations">): string {
  return conversation.short_id ?? String(conversation._id).slice(0, 7);
}
