import { mutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { resolveCreationPrivacy } from "./privacy";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage } from "./pendingMessages";
import { fromConvexAgentType } from "@codecast/shared/contracts";
import { findConversationByAnyRef } from "./conversationSessionLookup";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

/**
 * Resolve a `cast spawn --device <value>` selector against the user's devices.
 * The value is whatever the human typed: a device_id, or the label they see in
 * the UI (matched case-insensitively, so `--device nose` finds "Nose").
 * device_id wins outright — a label that happens to equal another machine's id
 * must not shadow the id.
 *
 * Throws on an unknown value rather than falling back to auto-routing: a typo'd
 * `--device` silently starting the session on the laptop is exactly the failure
 * the flag exists to prevent.
 */
export function resolveDeviceSelector(
  devices: { device_id: string; label?: string }[],
  value: string,
): string {
  const wanted = value.trim();
  const byId = devices.find((d) => d.device_id === wanted);
  if (byId) return byId.device_id;
  const byLabel = devices.find((d) => (d.label ?? "").toLowerCase() === wanted.toLowerCase());
  if (byLabel) return byLabel.device_id;
  const known = devices.map((d) => d.label || d.device_id).join(", ") || "(none registered)";
  throw new Error(`Unknown device "${wanted}". Your devices: ${known}`);
}

/**
 * Resolve a `cast spawn --subagent [parent]` ref to the parent conversation.
 * The ref is whatever the calling session has on hand — its session UUID
 * (detectCurrentSessionId), a short_id, or a full conversation id — resolved
 * own-only: nesting a session under someone else's row would hide it from its
 * own spawner and surface it in a teammate's inbox tree.
 *
 * Throws on an unresolved ref instead of falling back to a first-class spawn:
 * the caller asked for a subagent, and silently landing a loose inbox card is
 * exactly the failure the flag exists to prevent.
 */
export async function resolveSpawnParent(
  ctx: { db: any },
  userId: Id<"users">,
  parentRef: string,
): Promise<{ parent_conversation_id: Id<"conversations">; is_subagent: true }> {
  const parent = await findConversationByAnyRef(ctx, parentRef, userId);
  if (!parent) {
    throw new Error(`Parent session "${parentRef}" not found among your sessions`);
  }
  // Presence of parent_conversation_id alone marks a row a subagent for the
  // client (isSubagentConversation); is_subagent makes the row self-identify
  // even before links resolve, same as the daemon's transcript-asserted flag.
  return { parent_conversation_id: parent._id, is_subagent: true };
}

// createSessionFromCli — start a fresh, inbox-visible session and optionally
// seed its first turn. The backend for `cast spawn`.
//
// This is the api_token-authenticated sibling of conversations.createQuickSession
// (the UI's "New Session" path): same team/privacy resolution + start_session
// enqueue, but it authenticates a CLI caller and delivers a first prompt so a
// running session can hand fresh work to the human's inbox. By default it does
// NOT set is_subagent / parent_conversation_id — that absence is what makes the
// new session land in the inbox as a first-class card. With `parent_session`
// (`cast spawn --subagent`) it stamps both, so the new session nests in the UI
// as a subagent row under its parent — a worker the parent session manages —
// while still running on any agent backend (codex, gemini, …).
export const createSessionFromCli = mutation({
  args: {
    api_token: v.optional(v.string()),
    prompt: v.optional(v.string()),
    agent_type: v.optional(
      v.union(
        v.literal("claude_code"),
        v.literal("codex"),
        v.literal("cursor"),
        v.literal("gemini"),
        v.literal("opencode"),
        v.literal("pi"),
      ),
    ),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    model: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
    // A device_id or label; routes start_session at that machine (see
    // resolveDeviceSelector).
    device: v.optional(v.string()),
    // Any ref to one of the caller's own sessions (session UUID, short_id, or
    // conversation id). When set, the new session is created as a subagent row
    // nested under it (see resolveSpawnParent).
    parent_session: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const agentType = args.agent_type || "claude_code";

    let targetDeviceId: string | null = null;
    if (args.device) {
      const devices = await ctx.db
        .query("devices")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      targetDeviceId = resolveDeviceSelector(devices, args.device);
    }

    const privacy = await resolveCreationPrivacy(ctx, userId, args.git_root || args.project_path);

    const subagentFields = args.parent_session
      ? await resolveSpawnParent(ctx, userId, args.parent_session)
      : null;

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: args.project_path,
      git_root: args.git_root,
      started_at: now,
      updated_at: now,
      message_count: 0,
      ...privacy,
      ...(subagentFields ?? {}),
      status: "active",
    });

    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    const daemonAgentType = fromConvexAgentType(agentType);
    await enqueueStartSession(ctx, userId, {
      conversationId,
      agentType: daemonAgentType,
      projectPath: args.project_path || args.git_root,
      sessionId,
      isolated: args.isolated,
      worktreeName: args.worktree_name,
      model: args.model,
      createdAt: now,
      targetDeviceId,
    });

    // Seed the first turn as a plain user message (raw, not wrapped as a
    // session-message) over the same pending-message rail the UI uses for a new
    // session's first message — delivered once the daemon spawns and the agent
    // is ready.
    const prompt = (args.prompt ?? "").trim();
    if (prompt) {
      const conversation = await ctx.db.get(conversationId);
      await enqueuePendingMessage(ctx, conversation, userId, { content: prompt });
    }

    return {
      conversation_id: conversationId,
      short_id: conversationId.toString().slice(0, 7),
      parent_short_id: subagentFields
        ? subagentFields.parent_conversation_id.toString().slice(0, 7)
        : undefined,
    };
  },
});
