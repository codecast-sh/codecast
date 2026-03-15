import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { resolveTeamForPath } from "./privacy";

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

function deepMergeField(existing: any, incoming: any): any {
  if (
    incoming && typeof incoming === "object" && !Array.isArray(incoming) &&
    existing && typeof existing === "object" && !Array.isArray(existing)
  ) {
    const result = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      result[k] = v;
    }
    return result;
  }
  return incoming;
}

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
          const merged: Record<string, any> = {};
          for (const [k, v] of Object.entries(safe)) {
            merged[k] = deepMergeField((existing as any)[k], v);
          }
          await ctx.db.patch(existing._id, { ...merged, updated_at: Date.now() });
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
    await ctx.db.patch(convId as Id<"conversations">, {
      project_path: path,
      git_root: path,
    });
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
    const conversationPath = opts.git_root || opts.project_path;
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();

    const { teamId: resolvedTeamId, isPrivate, autoShared } = resolveTeamForPath(
      mappings,
      conversationPath,
      user?.team_share_paths,
      user?.active_team_id || user?.team_id
    );

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

  sendMessage: async (ctx, userId, [convId, content, imageIds, clientId]: [string, string, string[] | undefined, string | undefined]) => {
    const conversation = await ctx.db.get(convId as Id<"conversations">);
    if (!conversation || conversation.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");

    if (clientId) {
      const existing = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q: any) =>
          q.eq("conversation_id", convId as Id<"conversations">)
        )
        .filter((q: any) => q.eq(q.field("client_id"), clientId))
        .first();
      if (existing) return existing._id;
    }

    const messageId = await ctx.db.insert("pending_messages", {
      conversation_id: convId as Id<"conversations">,
      from_user_id: userId,
      content,
      image_storage_ids: imageIds as any,
      client_id: clientId,
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

  updateTaskStatus: async (ctx, userId, [shortId, newStatus]: [string, string]) => {
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
    if (!task) throw new Error("Task not found");
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    if (task.user_id !== userId && task.team_id !== teamId) throw new Error("Not authorized");

    const now = Date.now();
    const updates: any = { status: newStatus, updated_at: now };
    if (newStatus === "done" || newStatus === "dropped") updates.closed_at = now;
    if (newStatus === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
    }

    if (newStatus !== task.status) {
      await ctx.db.insert("task_history", {
        task_id: task._id,
        user_id: userId,
        actor_type: "user" as const,
        action: "updated",
        field: "status",
        old_value: task.status,
        new_value: newStatus,
        created_at: now,
      });
    }
    await ctx.db.patch(task._id, updates);
  },

  updateTask: async (ctx, userId, [shortId, fields]: [string, Record<string, any>]) => {
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
    if (!task) throw new Error("Task not found");
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    if (task.user_id !== userId && task.team_id !== teamId) throw new Error("Not authorized");

    const now = Date.now();
    const updates: any = { updated_at: now };
    for (const [key, val] of Object.entries(fields)) {
      if (key === "status") {
        updates.status = val;
        if (val === "done" || val === "dropped") updates.closed_at = now;
        if (val === "in_progress") {
          updates.attempt_count = (task.attempt_count || 0) + 1;
          updates.last_attempted_at = now;
        }
        if (val !== task.status) {
          await ctx.db.insert("task_history", {
            task_id: task._id, user_id: userId, actor_type: "user" as const,
            action: "updated", field: "status", old_value: task.status, new_value: val,
            created_at: now,
          });
        }
      } else if (key === "priority" && val !== task.priority) {
        updates.priority = val;
        await ctx.db.insert("task_history", {
          task_id: task._id, user_id: userId, actor_type: "user" as const,
          action: "updated", field: "priority", old_value: task.priority, new_value: val,
          created_at: now,
        });
      } else if (key === "title" && val !== task.title) {
        updates.title = val;
        await ctx.db.insert("task_history", {
          task_id: task._id, user_id: userId, actor_type: "user" as const,
          action: "updated", field: "title", old_value: task.title, new_value: val,
          created_at: now,
        });
      } else if (key === "description") {
        updates.description = val;
      } else if (key === "labels") {
        updates.labels = val;
      }
    }
    await ctx.db.patch(task._id, updates);
  },

  createTask: async (ctx, userId, [opts]: [any]) => {
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    let shortId = "ct-";
    for (let i = 0; i < 4; i++) shortId += chars[Math.floor(Math.random() * chars.length)];

    let projectId;
    if (opts.project_id) {
      const p = await ctx.db.query("projects").filter((q: any) => q.eq(q.field("_id"), opts.project_id)).first();
      if (p) projectId = p._id;
    }

    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      user_id: userId,
      team_id: teamId,
      project_id: projectId,
      short_id: shortId,
      title: opts.title,
      description: opts.description,
      task_type: opts.task_type || "task",
      status: opts.status || "open",
      priority: opts.priority || "medium",
      labels: opts.labels,
      source: "human" as const,
      attempt_count: 0,
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("task_history", {
      task_id: id,
      user_id: userId,
      actor_type: "user" as const,
      action: "created",
      created_at: now,
    });

    return { id, short_id: shortId };
  },

  addTaskComment: async (ctx, userId, [shortId, text, commentType]: [string, string, string?]) => {
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
    if (!task) throw new Error("Task not found");
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    if (task.user_id !== userId && task.team_id !== teamId) throw new Error("Not authorized");

    await ctx.db.insert("task_comments", {
      task_id: task._id,
      author: user?.name || "unknown",
      text,
      comment_type: (commentType || "note") as any,
      created_at: Date.now(),
    });
  },

  pinDoc: async (ctx, userId, [docId, pinned]: [string, boolean]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    if (doc.user_id !== userId && doc.team_id !== teamId) throw new Error("Not authorized");
    await ctx.db.patch(doc._id, { pinned, updated_at: Date.now() });
  },

  archiveDoc: async (ctx, userId, [docId]: [string]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    const user = await ctx.db.get(userId);
    const teamId = user?.active_team_id || user?.team_id;
    if (doc.user_id !== userId && doc.team_id !== teamId) throw new Error("Not authorized");
    await ctx.db.patch(doc._id, { archived_at: Date.now(), updated_at: Date.now() });
  },
};
