import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";

type TableConfig =
  | {
      kind: "collection";
      ownerField: string;
      immutable: Set<string>;
      beforePatch?: (doc: any, safe: Record<string, any>) => Record<string, any>;
    }
  | {
      kind: "singleton";
      ownerField: string;
      lookupIndex: string;
      immutable: Set<string>;
    };

const TABLE_CONFIG: Record<string, TableConfig> = {
  conversations: {
    kind: "collection",
    ownerField: "user_id",
    immutable: new Set([
      "_id", "_creationTime", "user_id", "session_id", "team_id",
      "started_at", "message_count", "short_id", "share_token",
      "is_private", "team_visibility", "auto_shared", "status", "agent_type",
    ]),
    beforePatch: (doc, safe) => {
      if (safe.inbox_dismissed_at && typeof safe.inbox_dismissed_at === "number") {
        safe.inbox_dismissed_at = Math.max(Date.now(), doc.updated_at + 1);
      }
      return safe;
    },
  },
  client_state: {
    kind: "singleton",
    ownerField: "user_id",
    lookupIndex: "by_user_id",
    immutable: new Set(["_id", "_creationTime", "user_id"]),
  },
};

export const dispatch = mutation({
  args: { action: v.string(), args: v.any(), patches: v.optional(v.any()) },
  handler: async (ctx, { action, args: actionArgs, patches }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (patches && typeof patches === "object") {
      await applyPatches(ctx, userId, patches);
    }

    const sideEffect = SIDE_EFFECTS[action];
    if (sideEffect) {
      return sideEffect(ctx, userId, actionArgs);
    }
  },
});

type HandlerCtx = { db: any; storage?: any };
type HandlerFn = (ctx: HandlerCtx, userId: Id<"users">, args: any) => Promise<any>;

async function applyPatches(
  ctx: HandlerCtx,
  userId: Id<"users">,
  patches: Record<string, Record<string, Record<string, any>>>
) {
  for (const [table, docs] of Object.entries(patches)) {
    const config = TABLE_CONFIG[table];
    if (!config) continue;

    for (const [docKey, fields] of Object.entries(docs)) {
      const safe: Record<string, any> = {};
      for (const [k, val] of Object.entries(fields)) {
        if (!config.immutable.has(k)) safe[k] = val === null ? undefined : val;
      }
      if (Object.keys(safe).length === 0) continue;

      if (config.kind === "collection") {
        const doc = await ctx.db.get(docKey as Id<any>);
        if (!doc || (doc as any)[config.ownerField] !== userId) continue;
        const finalSafe = config.beforePatch ? config.beforePatch(doc, { ...safe }) : safe;
        await ctx.db.patch(docKey as Id<any>, finalSafe);
      } else {
        const existing = await ctx.db
          .query(table as any)
          .withIndex(config.lookupIndex, (q: any) =>
            q.eq(config.ownerField, userId)
          )
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, { ...safe, updated_at: Date.now() });
        } else {
          await ctx.db.insert(table as any, {
            [config.ownerField]: userId,
            ...safe,
            updated_at: Date.now(),
          });
        }
      }
    }
  }
}

const SIDE_EFFECTS: Record<string, HandlerFn> = {
  switchProject: async (ctx, userId, [convId, path]: [string, string]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id !== userId) throw new Error("Not authorized");
    const now = Date.now();
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "kill_session" as const,
      args: JSON.stringify({ conversation_id: convId }),
      created_at: now,
    });
    const agentType = conv.agent_type || "claude_code";
    const daemonType = agentType === "codex" ? "codex" : agentType === "gemini" ? "gemini" : "claude";
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_session" as const,
      args: JSON.stringify({ agent_type: daemonType, project_path: path, conversation_id: convId }),
      created_at: now + 1,
    });
  },

  createSession: async (ctx, userId, [opts]: [{ agent_type?: string; project_path?: string; git_root?: string; session_id?: string }]) => {
    await checkRateLimit(ctx as any, userId, "createConversation");
    const now = Date.now();
    const sessionId = opts.session_id || crypto.randomUUID();
    const agentType = (opts.agent_type || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";

    const user = await ctx.db.get(userId);
    let resolvedTeamId = user?.active_team_id || user?.team_id;
    let isPrivate = true;
    let autoShared = false;

    const conversationPath = opts.git_root || opts.project_path;
    if (conversationPath) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();

      let bestMatch: { teamId: Id<"teams">; pathLength: number; autoShare: boolean } | null = null;
      for (const mapping of mappings) {
        if (conversationPath === mapping.path_prefix || conversationPath.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = { teamId: mapping.team_id, pathLength: mapping.path_prefix.length, autoShare: mapping.auto_share };
          }
        }
      }

      if (bestMatch) {
        resolvedTeamId = bestMatch.teamId;
        if (bestMatch.autoShare) { isPrivate = false; autoShared = true; }
      }
    }

    if (!autoShared && user?.team_share_paths && user.team_share_paths.length > 0 && resolvedTeamId && conversationPath) {
      for (const sharePath of user.team_share_paths) {
        if (conversationPath === sharePath || conversationPath.startsWith(sharePath + "/")) {
          isPrivate = false;
          autoShared = true;
          break;
        }
      }
    }

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      team_id: resolvedTeamId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: opts.project_path,
      git_root: opts.git_root,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      status: "active" as const,
    });

    await ctx.db.patch(conversationId, { short_id: conversationId.toString().slice(0, 7) });

    const daemonType = agentType === "codex" ? "codex" : agentType === "gemini" ? "gemini" : "claude";
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_session" as const,
      args: JSON.stringify({ agent_type: daemonType, project_path: opts.project_path || opts.git_root, conversation_id: conversationId }),
      created_at: now,
    });

    return conversationId;
  },

  sendMessage: async (ctx, userId, [convId, content, imageIds]: [string, string, string[] | undefined]) => {
    const conversation = await ctx.db.get(convId as Id<"conversations">);
    if (!conversation || conversation.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    const messageId = await ctx.db.insert("pending_messages", {
      conversation_id: convId as Id<"conversations">,
      from_user_id: userId,
      content,
      image_storage_ids: imageIds as any,
      status: "pending" as const,
      created_at: Date.now(),
      retry_count: 0,
    });
    const now = Date.now();
    await ctx.db.patch(convId as Id<"conversations">, {
      updated_at: now,
      has_pending_messages: true,
      ...(conversation.status === "completed" ? { status: "active" as const } : {}),
      ...(conversation.inbox_dismissed_at ? { inbox_dismissed_at: undefined } : {}),
    });
    return messageId;
  },

  resumeSession: async (ctx, userId, [convId]: [string]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    const agentType = conv.agent_type === "codex" ? "codex" : conv.agent_type === "gemini" ? "gemini" : "claude";
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "resume_session" as const,
      args: JSON.stringify({
        session_id: conv.session_id,
        agent_type: agentType,
        conversation_id: convId,
        project_path: conv.project_path || conv.git_root,
      }),
      created_at: Date.now(),
    });
    return { command_id: commandId };
  },

  sendEscape: async (ctx, userId, [convId]: [string]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id !== userId) throw new Error("Not authorized");
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "escape" as const,
      args: JSON.stringify({ conversation_id: convId }),
      created_at: Date.now(),
    });
  },
};
