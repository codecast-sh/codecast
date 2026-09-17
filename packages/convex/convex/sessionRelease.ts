/**
 * Leaf module: the one command every ownership flip sends to the machine that
 * used to run a session. Lives apart from devices.ts so cloudPlacement.ts (a
 * leaf devices.ts imports) can call it without a cycle.
 */
import { Id } from "./_generated/dataModel";

/**
 * Tell the machine that USED to run a conversation to tear its copy down.
 *
 * Every ownership flip needs this, whichever path flipped it: without it the
 * old machine's tmux + agent keep running, answer delivered messages in
 * parallel (split-brain), and — on a cloud box that stops itself when idle —
 * hold the machine awake indefinitely, which is a bill. Found live: a session
 * moved to EC2 and back left a claude running there after the return.
 *
 * The command goes in the PRE-MOVE runner's queue (`queueUserId`): a daemon
 * only polls its own user's queue, and across an account boundary that user
 * is not the caller. Best-effort: an offline previous owner never picks it up
 * and the command expires after the TTL.
 */
export async function releasePreviousOwner(
  ctx: { db: any },
  opts: {
    queueUserId: Id<"users">;
    conversationId: Id<"conversations">;
    sessionId: string | undefined;
    priorDeviceId: string | undefined;
    newDeviceId: string;
  },
): Promise<void> {
  if (!opts.priorDeviceId || opts.priorDeviceId === opts.newDeviceId) return;
  await ctx.db.insert("daemon_commands", {
    user_id: opts.queueUserId,
    command: "release_session" as const,
    args: JSON.stringify({
      conversation_id: opts.conversationId,
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    }),
    created_at: Date.now(),
    target_device_id: opts.priorDeviceId,
  });
}

