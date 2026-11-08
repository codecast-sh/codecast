import { REWIND_FILES_OPS } from "@codecast/shared/contracts";
import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { noteWriteCause } from "./lifecycleEvents";
import { canReadSessionCommand, enqueueHibernateSession, extractDaemonCommandConversationId, requireSessionCommandTarget, findSessionCommandByRequest, validateSessionCommandRequestId, sessionCommandRow, recentConversationCommands } from "./daemonCommandUtils";

// The commands a web store action can bind a request id to (hibernate, a
// restart's resume, a device move, an account switch, an edit of a line's
// file, a Claude backend switch), plus the kill that opens a restart and a
// stop (Escape).
const STORE_COMMANDS = new Set(["escape", "hibernate_session", "switch_claude_backend", "resume_session", "kill_session", "move_to_device", "switch_account", "line_profile_edit", "line_graph_edit", "line_deploy", "rewind_files"]);

export const hibernate = mutation({
  args: { conversation_id: v.id("conversations"), session_id: v.string(), owner_device_id: v.string(), request_id: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx);
    if (!user) throw new Error("Not authenticated");
    validateSessionCommandRequestId(args.request_id);
    const conv = await requireSessionCommandTarget(ctx, user, args.conversation_id);
    if (conv.user_id !== user) throw new Error("Only your own idle sessions can be parked in bulk");
    if (conv.session_id !== args.session_id || conv.owner_device_id !== args.owner_device_id) throw new Error("Session identity or owning device changed");
    return enqueueHibernateSession(ctx, conv, args.request_id);
  },
});

/**
 * Move a Claude conversation between the terminal (tmux) and the Agent SDK,
 * keeping its session id and transcript. The runner's daemon does the move
 * (switch_claude_backend, cli/src/claudeSdk/switchBackend.ts) and reports on
 * the request's row: it refuses while a turn runs unless `interrupt` says the
 * person agreed to stop it. A newer click replaces one no daemon took yet.
 */
export const switchBackend = mutation({
  args: {
    conversation_id: v.id("conversations"),
    backend: v.union(v.literal("sdk"), v.literal("tmux")),
    interrupt: v.optional(v.boolean()),
    request_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx);
    if (!user) throw new Error("Not authenticated");
    validateSessionCommandRequestId(args.request_id);
    const conv = await requireSessionCommandTarget(ctx, user, args.conversation_id);
    if ((conv.agent_type || "claude_code") !== "claude_code") throw new Error("Only Claude sessions have a backend to switch");
    if (!conv.session_id) throw new Error("This session has not started yet");
    const existing = await findSessionCommandByRequest(ctx, conv.user_id, args.request_id);
    if (existing) {
      if (existing.command !== "switch_claude_backend" || extractDaemonCommandConversationId(existing.args) !== conv._id.toString()) {
        throw new Error("Request ID is already bound to a different command or target");
      }
      return { deduplicated: true, command_id: existing._id };
    }
    noteWriteCause(ctx, "switch_claude_backend");
    const pending = await ctx.db.query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined)).collect();
    for (const c of pending) {
      if (c.command === "switch_claude_backend" && !c.claimed_by && extractDaemonCommandConversationId(c.args) === conv._id.toString()) {
        await ctx.db.delete(c._id);
      }
    }
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "switch_claude_backend",
      request_id: args.request_id,
      // The machine running the session moves it; no other daemon holds its pane or host.
      target_device_id: conv.owner_device_id ?? undefined,
      args: JSON.stringify({
        conversation_id: conv._id,
        session_id: conv.session_id,
        project_path: conv.project_path ?? conv.git_root,
        backend: args.backend,
        interrupt: args.interrupt === true,
      }),
      created_at: Date.now(),
    });
    return { deduplicated: false, command_id: commandId };
  },
});

// "Rewind to here" (cli/src/rewindTree.ts): one step of a rewind of the
// session's checkout, sent to the machine that owns the session and bound to
// the web's sessionCommands row by request id. Only the session's runner may
// ask: the files are on their machine. An outbox retry of the same request
// answers the command already queued.
export const rewindFiles = mutation({
  args: {
    conversation_id: v.id("conversations"),
    request_id: v.string(),
    op: v.union(...REWIND_FILES_OPS.map((op) => v.literal(op))),
    message_ts: v.optional(v.number()),
    fingerprint: v.optional(v.string()),
    overwrite: v.optional(v.boolean()),
    path: v.optional(v.string()),
    staged_id: v.optional(v.string()),
    discard_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx);
    if (!user) throw new Error("Not authenticated");
    validateSessionCommandRequestId(args.request_id);
    const conv = await requireSessionCommandTarget(ctx, user, args.conversation_id);
    if (conv.user_id !== user) throw new Error("Only the person whose machine runs this session can rewind its files");
    if ((args.op === "plan" || args.op === "diff" || args.op === "stage") && args.message_ts === undefined) throw new Error("A rewind names the message it goes back to");
    const existing = await findSessionCommandByRequest(ctx, user, args.request_id);
    if (existing) {
      if (existing.command !== "rewind_files") throw new Error("Request ID is already bound to a different command");
      return { command_id: existing._id };
    }
    const { request_id, ...rest } = args;
    const command_id = await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "rewind_files",
      request_id,
      args: JSON.stringify(rest),
      created_at: Date.now(),
      ...(conv.owner_device_id ? { target_device_id: conv.owner_device_id } : {}),
    });
    return { command_id };
  },
});

export const results = query({
  args: { request_ids: v.optional(v.array(v.string())), command_ids: v.optional(v.array(v.id("daemon_commands"))), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx) ?? (args.api_token ? (await verifyApiToken(ctx, args.api_token))?.userId : null);
    if (!user) return [];
    if ((args.request_ids?.length ?? 0) + (args.command_ids?.length ?? 0) > 100) throw new Error("At most 100 command results at once");
    const byRequest = await Promise.all((args.request_ids ?? []).map(id => findSessionCommandByRequest(ctx, user, id)));
    const byId = await Promise.all((args.command_ids ?? []).map(id => ctx.db.get(id)));
    const rows = [];
    for (const command of [...byRequest, ...byId]) {
      if (!command || !STORE_COMMANDS.has(command.command)) continue;
      if (!(await canReadSessionCommand(ctx, user, command))) continue;
      if (command.request_id !== undefined && byId.includes(command)) {
        await findSessionCommandByRequest(ctx, command.user_id, command.request_id);
      }
      rows.push(sessionCommandRow(command));
    }
    return rows;
  },
});

// One conversation's recent restart/move commands, in the same row shape as
// results: the second feed of the web's sessionCommands collection, mounted
// while a restart or move is in flight for the open conversation.
export const forConversation = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx);
    if (!user) return [];
    return (await recentConversationCommands(ctx, user, args.conversation_id)).map(sessionCommandRow);
  },
});
