import type { Doc, Id } from "./_generated/dataModel";
import { fromConvexAgentType } from "@codecast/shared/contracts";

/**
 * Just the database handle, which is all the writers below touch. Narrower than
 * MutationCtx on purpose: the store's dispatch handlers run with a reduced
 * context (`{ db, storage?, runMutation? }`), so demanding the full mutation
 * context here would lock them out of these shared writers.
 */
type DbCtx = { db: any };

export type PendingDaemonCommand = {
  command: string;
  args?: string | null;
  _creationTime?: number;
};

export function extractDaemonCommandConversationId(args: string | null | undefined): string | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed?.conversation_id === "string" ? parsed.conversation_id : null;
  } catch {
    return null;
  }
}

/**
 * Ask the session's daemon to bring its agent back up, without killing anything
 * first. The one writer for every resume-only caller: the web's Resume button
 * (users.resumeSession), the store dispatch (dispatch.resumeSession), and
 * `cast resume --tmux`. Kill-then-resume is a different gesture and keeps its
 * own writer (enqueueKillAndResume in conversations.ts).
 *
 * This is idempotent by design at both ends. Here, a resume already queued for
 * this conversation in the last 30s dedups instead of stacking. On the daemon,
 * the resume reuses a pane whose agent is already healthy
 * (resolveLiveTmuxTarget) rather than replacing it — so calling this for a live
 * session costs nothing and returns the pane the session is already in.
 *
 * Always addressed to the RUNNER (conv.user_id), never the caller: daemon
 * commands are polled per user, so a second-party owner's resume has to reach
 * the machine actually running the session.
 */
export async function enqueueResumeSession(
  ctx: DbCtx,
  conv: Pick<Doc<"conversations">, "_id" | "user_id" | "session_id" | "project_path" | "git_root" | "agent_type">,
): Promise<{ deduplicated: boolean; command_id?: Id<"daemon_commands"> }> {
  const pendingCommands = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined))
    .collect();

  if (hasRecentPendingDaemonCommand(pendingCommands as any, {
    conversationId: conv._id.toString(),
    command: "resume_session",
  })) {
    return { deduplicated: true };
  }

  const command_id = await ctx.db.insert("daemon_commands", {
    user_id: conv.user_id,
    command: "resume_session" as const,
    args: JSON.stringify({
      session_id: conv.session_id,
      agent_type: fromConvexAgentType(conv.agent_type),
      conversation_id: conv._id,
      project_path: conv.project_path || conv.git_root,
    }),
    created_at: Date.now(),
  });
  return { deduplicated: false, command_id };
}

export function hasRecentPendingDaemonCommand(
  commands: PendingDaemonCommand[],
  {
    conversationId,
    command,
    now = Date.now(),
    dedupeWindowMs = 30_000,
  }: {
    conversationId: string;
    command: string;
    now?: number;
    dedupeWindowMs?: number;
  }
): boolean {
  return commands.some((entry) => {
    if (entry.command !== command) return false;
    if (extractDaemonCommandConversationId(entry.args) !== conversationId) return false;
    if (!entry._creationTime) return true;
    return now - entry._creationTime < dedupeWindowMs;
  });
}
