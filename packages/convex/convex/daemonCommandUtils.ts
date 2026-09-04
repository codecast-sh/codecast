import type { Doc, Id } from "./_generated/dataModel";
import { fromConvexAgentType } from "@codecast/shared/contracts";
import { resetConversationPendingMessages } from "./pendingMessages";

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

/**
 * Ask the session's daemon to park the pane: kill the tmux session and its
 * process tree, keep the transcript, stamp the agent "hibernated". The next
 * message wakes it through the ordinary auto-resume path, so this is a cheap,
 * fully reversible way to give the machine its resources back.
 *
 * There is no matching enqueueWakeSession. Waking IS a resume, and
 * enqueueResumeSession already does every part of it, so `cast wake` routes to
 * the resume mutation instead of earning a second name for one behavior.
 *
 * Runner-addressed like every other session command: the daemon holding the
 * pane polls by conv.user_id.
 */
export async function enqueueHibernateSession(
  ctx: DbCtx,
  conv: Pick<Doc<"conversations">, "_id" | "user_id" | "session_id">,
): Promise<{ deduplicated: boolean; command_id?: Id<"daemon_commands"> }> {
  const pendingCommands = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined))
    .collect();

  if (hasRecentPendingDaemonCommand(pendingCommands as any, {
    conversationId: conv._id.toString(),
    command: "hibernate_session",
  })) {
    return { deduplicated: true };
  }

  const command_id = await ctx.db.insert("daemon_commands", {
    user_id: conv.user_id,
    command: "hibernate_session" as const,
    args: JSON.stringify({
      session_id: conv.session_id,
      conversation_id: conv._id,
    }),
    created_at: Date.now(),
  });
  return { deduplicated: false, command_id };
}

// Authorize a session command and return its live target. A session may be
// commanded by its RUNNER (conv.user_id — the account whose daemon executes
// commands) or its second-party owner (conv.owner_user_id — e.g. a Mr-Bot-run
// session assigned to a human). Callers MUST stamp the resulting
// daemon_commands row with conv.user_id: daemons poll by their own account, so
// an actor-stamped row lands on the actor's machines and fails "No session
// found" (the 2026-07-13 model-switch loop). killSession/restartSession
// keep their own variants — they must proceed on ghost rows this rejects.
// A missing row is its own error: the web resume path escalates
// "Conversation not found" to the ghost-restore restart.
export async function requireSessionCommandTarget(
  ctx: DbCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<Doc<"conversations">> {
  const conv = await ctx.db.get(conversationId);
  if (!conv) throw new Error("Conversation not found");
  if (conv.user_id !== userId && conv.owner_user_id !== userId) {
    throw new Error("Not authorized");
  }
  return conv;
}

/**
 * The gentle resume (re-attach + redeliver) — the ONE core behind
 * users.resumeSession, dispatch.resumeSession and convCommand("resumeSession").
 * Runner or second-party owner may call it; the command is runner-addressed.
 */
export async function resumeConversationSession(
  ctx: DbCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<
  | { skipped: true; reason: "fresh_session_no_messages" }
  | { deduplicated: true }
  | { command_id: Id<"daemon_commands"> }
> {
  const conversation = await requireSessionCommandTarget(ctx, userId, conversationId);
  if (!conversation.session_id) {
    throw new Error("No session ID on this conversation");
  }

  // Skip resume for fresh 0-message sessions. The inline new-session flow
  // (DashboardLayout.handleQuickCreate, ContextChatInput.handleSubmit)
  // stamps a 10-char nanoid as session_id before any Claude process exists,
  // so a `claude --resume <nanoid>` would fail every time. The UI's
  // stuck-banner auto-resume kept firing this for brand-new sessions,
  // triggering kill → repair → reconstitute → start-fresh churn on the
  // daemon. tryStartedTmux on the daemon side already delivers the first
  // message via the pane, so a no-op here is safe.
  if ((conversation.message_count ?? 0) === 0) {
    return { skipped: true, reason: "fresh_session_no_messages" };
  }

  const { deduplicated, command_id } = await enqueueResumeSession(ctx, conversation);

  // Re-queue any stranded messages so the resume actually delivers them. A message that
  // failed to reach a dead session sits as injected/failed/undeliverable; without this it
  // stays stuck and the user has to manually resend. restartSession already does this — the
  // missing call here was the asymmetry that left "Force resume" doing nothing visible.
  // Runs on the dedup path too: the queued resume still needs its messages back.
  await resetConversationPendingMessages(ctx, conversationId);
  return deduplicated ? { deduplicated: true } : { command_id: command_id! };
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
