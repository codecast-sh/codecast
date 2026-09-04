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

function matchesSessionTarget(entry: any, conv: { session_id?: string; owner_device_id?: string }): boolean {
  if (entry.target_device_id !== conv.owner_device_id) return false;
  try {
    return JSON.parse(entry.args || "null")?.session_id === conv.session_id;
  } catch {
    return false;
  }
}

export function validateSessionCommandRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128 || /[^A-Za-z0-9_-]/.test(requestId)) {
    throw new Error("Invalid request ID: expected 1-128 letters, digits, underscores or hyphens");
  }
}

export async function findSessionCommandByRequest(ctx: DbCtx, userId: Id<"users">, requestId: string) {
  validateSessionCommandRequestId(requestId);
  return ctx.db.query("daemon_commands")
    .withIndex("by_user_request", (q: any) => q.eq("user_id", userId).eq("request_id", requestId)).unique();
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
  conv: Pick<Doc<"conversations">, "_id" | "user_id" | "session_id" | "project_path" | "git_root" | "agent_type" | "owner_device_id">,
): Promise<{ deduplicated: boolean; command_id?: Id<"daemon_commands"> }> {
  const pendingCommands = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined))
    .collect();

  const existing = pendingCommands.find((entry: any) => matchesSessionTarget(entry, conv) && hasRecentPendingDaemonCommand([entry], {
    conversationId: conv._id.toString(), command: "resume_session",
  }));
  if (existing) return { deduplicated: true, command_id: existing._id };

  const command_id = await ctx.db.insert("daemon_commands", {
    user_id: conv.user_id,
    command: "resume_session" as const,
    target_device_id: conv.owner_device_id,
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
 * Ask the session's daemon to park an idle pane. The daemon independently
 * verifies exact ownership and safety and may refuse; enqueueing is no proof
 * of parking. A confirmed park preserves the transcript and resumes on send.
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
  conv: Pick<Doc<"conversations">, "_id" | "user_id" | "session_id" | "owner_device_id">,
  requestId?: string,
): Promise<{ deduplicated: boolean; command_id: Id<"daemon_commands"> }> {
  if (requestId !== undefined) validateSessionCommandRequestId(requestId);
  if (!conv.session_id || !conv.owner_device_id) throw new Error("Session has no confirmed owning device");
  const managed = await ctx.db.query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).first();
  if (!managed || managed.session_id !== conv.session_id || managed.user_id !== conv.user_id) {
    throw new Error("Managed session identity changed or is unavailable");
  }
  if (requestId !== undefined) {
    const existing = await findSessionCommandByRequest(ctx, conv.user_id, requestId);
    if (existing) {
      if (existing.command !== "hibernate_session" || !matchesSessionTarget(existing, conv) ||
        extractDaemonCommandConversationId(existing.args) !== conv._id.toString()) {
        throw new Error("Request ID is already bound to a different command or target");
      }
      return { deduplicated: true, command_id: existing._id };
    }
  } else {
    const pending = await ctx.db.query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined)).collect();
    const existing = pending.find((entry: any) => matchesSessionTarget(entry, conv) &&
      hasRecentPendingDaemonCommand([entry], { conversationId: conv._id.toString(), command: "hibernate_session" }));
    if (existing) return { deduplicated: true, command_id: existing._id };
  }
  const command_id = await ctx.db.insert("daemon_commands", {
    user_id: conv.user_id,
    request_id: requestId,
    target_device_id: conv.owner_device_id,
    command: "hibernate_session" as const,
    args: JSON.stringify({ session_id: conv.session_id, conversation_id: conv._id }),
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
