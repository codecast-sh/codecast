import { mutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { enqueueStartSession } from "./devices";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { resolveTeamForPath, buildShareUpdate } from "./privacy";
import { hasRecentPendingDaemonCommand } from "./daemonCommandUtils";
import { nextShortId } from "./counters";
import { resolveAssigneeStr, resolveAssigneeToUserId, recalcPlanProgress, notifySubscribers, subscribeUser, resolveWorkerParentConversation, resolveTaskGitContext } from "./tasks";
import { api, internal } from "./_generated/api";
import { AGENT_MODEL_CONFIG, findModelOption, modelAgentKey } from "@codecast/shared/contracts";
import { conversationHasNoWork, reapEmptyConversation, enqueueKillSessionCommand } from "./cleanup";
import { canAccessDoc } from "./docs";
import { enqueuePendingMessage } from "./pendingMessages";
import { findConversationBySessionReference } from "./conversationSessionLookup";
import { createBucketForUser, assignConversationToBucketForUser } from "./buckets";

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
      // Anchor invariants are server-owned (set by provisionAnchor / cleared by
      // decommissionAnchor) — a client must not flip these via a generic patch.
      "persistent", "acting_user_id", "anchor_id",
    ]),
    // No beforePatch hook: dismiss is an absolute flag, so the server has no
    // reason to rewrite the client's `inbox_dismissed_at`. A previous hook
    // stamped `Date.now()` here (vestige of the `inbox_dismissed_at >=
    // updated_at` era) and the resulting client/server value drift kept the
    // local pending-field override alive forever — a cross-tab unstash could
    // never converge.
  },
  client_state: {
    kind: "singleton",
    ownerField: "user_id",
    lookupIndex: "by_user_id",
    immutable: new Set(["_id", "_creationTime", "user_id"]),
  },
  // Bucket field edits (rename / color / sort_order / archived_at) ride the
  // generic patch path. Creation and assignment need inserts/upserts, so they
  // live in SIDE_EFFECTS (createBucket / assignSessionToBucket).
  inbox_buckets: {
    kind: "collection",
    ownerField: "user_id",
    immutable: new Set(["_id", "_creationTime", "user_id", "created_at"]),
  },
  // Comment content edits ride the generic patch path; everything structural is
  // immutable. Creation, deletion and the agent-reply ask need inserts/forks, so
  // they live in SIDE_EFFECTS (addComment / deleteComment / askAgentInThread).
  comments: {
    kind: "collection",
    ownerField: "user_id",
    immutable: new Set([
      "_id", "_creationTime", "user_id", "conversation_id", "message_id", "created_at",
      "parent_comment_id", "author_kind", "agent_status", "fork_conversation_id", "client_id",
    ]),
  },
};

export const dispatch = mutation({
  args: { action: v.string(), args: v.any(), patches: v.optional(v.any()), result: v.optional(v.any()) },
  handler: async (ctx, { action, args: actionArgs, patches, result }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (patches && typeof patches === "object") {
      await applyPatches(ctx, userId, patches);
    }

    const sideEffect = SIDE_EFFECTS[action];
    if (sideEffect) {
      return sideEffect(ctx, userId, actionArgs, result);
    }
  },
});

type HandlerCtx = { db: any; storage?: any; runMutation?: any };
type HandlerFn = (ctx: HandlerCtx, userId: Id<"users">, args: any, result?: any) => Promise<any>;

function deepMergeField(existing: any, incoming: any): any {
  if (
    incoming && typeof incoming === "object" && !Array.isArray(incoming) &&
    existing && typeof existing === "object" && !Array.isArray(existing)
  ) {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (v !== null && v !== undefined) result[k] = v;
    }
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null || v === undefined) delete result[k];
      else result[k] = v;
    }
    return result;
  }
  return incoming;
}

// Pure decision for the conversation hide-transition hook (exported for tests).
//
//  "reap" — a never-prompted EMPTY pre-warm got hidden (dismissed OR stashed).
//           Quick-create eagerly boots a real agent per summon; a 0-message
//           pre-warm has nothing to preserve — leaving it running leaks a
//           zombie tmux that keeps the conversation is_connected and
//           re-surfaces it as a phantom "New session" card.
//           reapEmptyConversation kills the agent and then deletes the row.
//  "kill" — dismiss = kill. Stash is the keep-alive set-aside; dismiss retires
//           the session: tear the agent down and mark it completed (mirrors the
//           explicit killSession mutation). Gated on the TRANSITION (`doc` is
//           the pre-patch row) so a re-asserted dismiss can't re-kill, and an
//           undo (dismissed → null) never reaches here. Stays resumable.
//  "none" — a stash of a session with real work (the whole point of stash), or
//           a re-asserted dismiss.
export function classifyHideTransition(
  patch: { inbox_dismissed_at?: any; inbox_stashed_at?: any },
  doc: { inbox_dismissed_at?: number | null },
  hasNoWork: boolean,
): "reap" | "kill" | "none" {
  if (!patch.inbox_dismissed_at && !patch.inbox_stashed_at) return "none";
  if (hasNoWork) return "reap";
  if (patch.inbox_dismissed_at && !doc.inbox_dismissed_at) return "kill";
  return "none";
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
        // Lifecycle hooks on the DATA transition (a conversation patch setting
        // inbox_dismissed_at / inbox_stashed_at), not any one action, so every
        // dismiss/stash path funnels through here — the inbox shortcuts, the
        // palette, the /sessions toggle (patchConversation), and any future one.
        if (table === "conversations" && ((finalSafe as any).inbox_dismissed_at || (finalSafe as any).inbox_stashed_at)) {
          const action = classifyHideTransition(finalSafe, doc as any, await conversationHasNoWork(ctx, doc));
          if (action === "reap") {
            await reapEmptyConversation(ctx, doc as any);
          } else if (action === "kill") {
            await enqueueKillSessionCommand(ctx, doc as any);
            // A persistent anchor never auto-completes on a dismiss/kill — it goes
            // dormant, not retired (only decommissionAnchor clears `persistent`).
            const killPatch: Record<string, any> = { inbox_killed_at: Date.now() };
            if (!(doc as any)?.persistent) killPatch.status = "completed";
            await ctx.db.patch(docKey as Id<any>, killPatch);
          }
        }
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
    await enqueueStartSession(ctx, userId, {
      conversationId: convId as Id<"conversations">,
      agentType: daemonType,
      projectPath: path,
      gitRoot: path,
      createdAt: now + 1,
    });
  },

  createSession: async (ctx, userId, [opts]: [{ agent_type?: string; project_path?: string; git_root?: string; session_id?: string; linked_object?: { type: string; id: string }; model?: string; effort?: string; isolated?: boolean; worktree_name?: string }]) => {
    const sessionId = opts.session_id || crypto.randomUUID();
    // Idempotent on (user, session_id). The optimistic web client keys a New
    // Session by a client-minted stub id and passes it as session_id, then
    // waits for this conversation to sync back and supersede the stub. That
    // create can legitimately arrive more than once for the same session_id:
    // the dispatch outbox re-fires across reloads (MAX_OUTBOX_BOOT_ATTEMPTS),
    // and the client's stuck-stub heal re-issues it when the first attempt was
    // given up. Returning the existing row instead of inserting a duplicate
    // avoids stranding twin conversations (the fork-resume doppelganger class)
    // and is what makes client-side re-create safe. Skips the rate limit too —
    // reviving an already-created session shouldn't count against the quota.
    if (opts.session_id) {
      const existing = await findConversationBySessionReference(ctx, sessionId, userId);
      if (existing) return existing._id;
    }
    await checkRateLimit(ctx as any, userId, "createConversation");
    const now = Date.now();
    const agentType = (opts.agent_type || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();

    // Resolve project_path from linked task (or its team mapping) before falling back to client-supplied path.
    let resolvedProjectPath = opts.project_path;
    let resolvedGitRoot = opts.git_root;
    let resolvedGitRemoteUrl: string | undefined = undefined;
    let linkedTask: any = null;
    if (opts.linked_object?.type === "task" && opts.linked_object.id) {
      try {
        linkedTask = await ctx.db.get(opts.linked_object.id as Id<"tasks">);
      } catch { linkedTask = null; }
      if (linkedTask) {
        const hasAccess = linkedTask.user_id.toString() === userId.toString()
          || (linkedTask.team_id && !!(await ctx.db
              .query("team_memberships")
              .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", linkedTask.team_id))
              .first()));
        if (!hasAccess) {
          linkedTask = null;
        } else {
          // Resolve project_path/git_root/git_remote_url from the task. Shared
          // with tasks.assignToAgent so both task-launch paths route identically.
          const resolved = await resolveTaskGitContext(ctx, userId, linkedTask, mappings, {
            project_path: resolvedProjectPath,
            git_root: resolvedGitRoot,
          });
          resolvedProjectPath = resolved.project_path;
          resolvedGitRoot = resolved.git_root;
          resolvedGitRemoteUrl = resolved.git_remote_url;
        }
      }
    }

    const conversationPath = resolvedGitRoot || resolvedProjectPath;
    const { teamId: resolvedTeamId, isPrivate, autoShared } = resolveTeamForPath(
      mappings,
      conversationPath,
      linkedTask?.team_id
    );

    // Nest orchestration workers under their plan's creator session so they
    // don't clutter the top-level inbox. The plan is found via a linked task
    // or a directly-linked plan; resolveWorkerParentConversation only returns
    // a parent that the inbox will actually render the child under.
    const workerPlanId: Id<"plans"> | undefined =
      (linkedTask?.plan_id as Id<"plans"> | undefined) ??
      (opts.linked_object?.type === "plan" && opts.linked_object.id
        ? (opts.linked_object.id as Id<"plans">)
        : undefined);
    const parentConversationId = await resolveWorkerParentConversation(ctx, userId, workerPlanId);

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      team_id: resolvedTeamId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: resolvedProjectPath,
      git_root: resolvedGitRoot,
      ...(resolvedGitRemoteUrl ? { git_remote_url: resolvedGitRemoteUrl } : {}),
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      status: "active" as const,
      ...(linkedTask ? { active_task_id: linkedTask._id } : {}),
      // Stamp the plan so the inbox can group plan workers even without a viable
      // parent session to nest under (the grouping fallback).
      ...(workerPlanId ? { active_plan_id: workerPlanId } : {}),
      ...(parentConversationId
        ? { parent_conversation_id: parentConversationId, is_subagent: true }
        : {}),
    });

    await ctx.db.patch(conversationId, { short_id: conversationId.toString().slice(0, 7) });

    if (linkedTask) {
      const existing = linkedTask.conversation_ids || [];
      if (!existing.some((id: any) => id.toString() === conversationId.toString())) {
        await ctx.db.patch(linkedTask._id, {
          conversation_ids: [...existing, conversationId],
        });
      }
    }

    const daemonType = agentType === "codex" ? "codex" : agentType === "gemini" ? "gemini" : "claude";
    // Per-session model/effort (validated against the shared contract; "default"
    // = omit). Stamped on the conversation so the badge is right from t=0 — the
    // rollup confirms/corrects from the first turn's switch echo or model field.
    const modelOpt = opts.model ? findModelOption(agentType, opts.model) : undefined;
    const effortOk = opts.effort && AGENT_MODEL_CONFIG[modelAgentKey(agentType)]?.efforts.includes(opts.effort);
    const requestedModel = modelOpt?.cliAlias ? modelOpt.key : undefined;
    if (requestedModel || effortOk) {
      await ctx.db.patch(conversationId, {
        ...(requestedModel ? { model: daemonType === "claude" ? `claude-${requestedModel}` : requestedModel } : {}),
        ...(effortOk ? { effort: opts.effort } : {}),
      });
    }
    await enqueueStartSession(ctx, userId, {
      conversationId,
      agentType: daemonType,
      projectPath: resolvedProjectPath || resolvedGitRoot,
      gitRoot: resolvedGitRoot,
      createdAt: now,
      // Isolated-worktree sessions: forward the launch flag so the daemon's
      // start_session creates the git worktree up front. This is the SAME path
      // reconfigureSession/createQuickSession use; without it the "isolated
      // worktree" toggle silently did nothing until a later project switch.
      ...(opts.isolated ? { isolated: true } : {}),
      ...(opts.worktree_name ? { worktreeName: opts.worktree_name } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(effortOk ? { effort: opts.effort } : {}),
    });

    return conversationId;
  },

  sendMessage: async (ctx, userId, [convId, content, imageIds, clientId]: [string, string, string[] | undefined, string | undefined]) => {
    const conversation = await ctx.db.get(convId as Id<"conversations">);
    // Distinct error for a deleted row: the client may be sending into a cached
    // ghost (never-prune cache) and needs to surface "restore session", not a
    // baffling auth failure.
    if (!conversation) throw new Error("conversation_deleted");
    if (conversation.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");

    // Single canonical writer: dedups on client_id, stamps owner_user_id for the daemon's
    // delivery poll, and wakes the conversation (un-dismiss, completed→active). The web composer
    // only ever sends into the user's own conversation (enforced above), so owner == sender.
    return await enqueuePendingMessage(ctx, conversation, userId, {
      content,
      image_storage_ids: imageIds?.length ? (imageIds as any) : undefined,
      client_id: clientId,
    });
  },

  resumeSession: async (ctx, userId, [convId]: [string]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    const agentType = conv.agent_type === "codex" ? "codex" : conv.agent_type === "gemini" ? "gemini" : "claude";
    const pendingCommands = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined))
      .collect();
    if (hasRecentPendingDaemonCommand(pendingCommands as any, {
      conversationId: convId,
      command: "resume_session",
    })) {
      return { deduplicated: true };
    }
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

  // Web-triggered "move to remote": enqueue a move_to_device command targeted
  // at the session's CURRENT owner device (the machine that has the checkout +
  // credential). That daemon performs the local-only transfer (git/jsonl/cred),
  // then flips ownership + resumes on the destination device.
  // args: [conversationId, toDeviceId?]  (toDeviceId defaults to the online remote device)
  moveToRemote: async (ctx, userId, [convId, toDeviceId]: [string, string | undefined]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");

    const now = Date.now();
    const ONLINE = 2 * 60 * 1000;
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const online = devices.filter((d: any) => now - d.last_seen < ONLINE);

    // Destination: explicit, else the online remote device.
    const dest = toDeviceId
      ? online.find((d: any) => d.device_id === toDeviceId)
      : online.find((d: any) => d.is_remote);
    if (!dest) throw new Error("No online destination device (start the remote daemon)");

    // Source daemon = current owner if online, else the online local device.
    const ownerOnline = conv.owner_device_id && online.some((d: any) => d.device_id === conv.owner_device_id);
    const source = ownerOnline
      ? conv.owner_device_id
      : (online.find((d: any) => !d.is_remote)?.device_id ?? null);
    if (!source) throw new Error("No online source device to perform the move");
    if (source === dest.device_id) throw new Error("Session is already on that device");

    const pendingCommands = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined))
      .collect();
    if (hasRecentPendingDaemonCommand(pendingCommands as any, { conversationId: convId, command: "move_to_device" })) {
      return { deduplicated: true };
    }

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "move_to_device" as const,
      args: JSON.stringify({
        conversation_id: convId,
        session_id: conv.session_id,
        to_device_id: dest.device_id,
      }),
      created_at: now,
      target_device_id: source, // only the source daemon executes the transfer
    });
    return { command_id: commandId, source, dest: dest.device_id };
  },

  linkConversation: async (ctx, userId, [objectType, objectId, conversationId]: [string, string, string]) => {
    const conv = await ctx.db.get(conversationId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");

    if (objectType === "doc") {
      const doc = await ctx.db.get(objectId as Id<"docs">);
      if (!doc || doc.user_id.toString() !== userId.toString()) return;
      const existing = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
      if (!existing.some((id: any) => id.toString() === conversationId)) {
        await ctx.db.patch(objectId as Id<"docs">, {
          related_conversation_ids: [...existing, conversationId as Id<"conversations">],
        });
      }
    } else if (objectType === "task") {
      const task = await ctx.db.get(objectId as Id<"tasks">);
      if (!task) return;
      if (task.user_id.toString() !== userId.toString()) {
        if (!task.team_id) return;
        const membership = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
          .first();
        if (!membership) return;
      }
      const existing = task.conversation_ids || [];
      if (!existing.some((id: any) => id.toString() === conversationId)) {
        await ctx.db.patch(objectId as Id<"tasks">, {
          conversation_ids: [...existing, conversationId as Id<"conversations">],
        });
      }
      await ctx.db.patch(conversationId as Id<"conversations">, {
        active_task_id: objectId as Id<"tasks">,
      });
    } else if (objectType === "plan") {
      const plan = await ctx.db.get(objectId as Id<"plans">);
      if (!plan || plan.user_id.toString() !== userId.toString()) return;
      const existing = plan.session_ids || [];
      if (!existing.some((id: any) => id.toString() === conversationId)) {
        await ctx.db.patch(objectId as Id<"plans">, {
          session_ids: [...existing, conversationId as Id<"conversations">],
        });
      }
    }
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

  // Mirror of conversations.setPrivacy — these two fields are immutable in
  // applyPatches because flipping them re-resolves team sharing, so the write
  // happens here while the client optimistically updates local state.
  setPrivacy: async (ctx, userId, [convId, isPrivate]: [string, boolean]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv) throw new Error("Conversation not found");
    if (conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    // Sharing must guarantee a team_id (buildShareUpdate); locking forces the
    // private visibility marker. Never let is_private:false and team_id diverge.
    const updates = isPrivate
      ? { is_private: true as const, team_visibility: "private" as const }
      : await buildShareUpdate(ctx, conv, userId);
    await ctx.db.patch(convId as Id<"conversations">, updates);
  },

  setTeamVisibility: async (ctx, userId, [convId, visibility]: [string, "summary" | "full" | null]) => {
    const conv = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");
    // Setting any team visibility shares the conversation, so guarantee a
    // team_id alongside it (else it's shared-with-nobody).
    const updates = await buildShareUpdate(ctx, conv, userId);
    await ctx.db.patch(convId as Id<"conversations">, {
      ...updates,
      team_visibility: visibility ?? undefined,
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
    const trackFields: [string, any, any][] = [];

    for (const [key, val] of Object.entries(fields)) {
      if (key === "status") {
        updates.status = val;
        if (val === "done" || val === "dropped") updates.closed_at = now;
        if (val === "in_progress") {
          updates.attempt_count = (task.attempt_count || 0) + 1;
          updates.last_attempted_at = now;
        }
        if (val !== task.status) trackFields.push(["status", task.status, val]);
      } else if (key === "priority" && val !== task.priority) {
        updates.priority = val;
        trackFields.push(["priority", task.priority, val]);
      } else if (key === "title" && val !== task.title) {
        updates.title = val;
        trackFields.push(["title", task.title, val]);
      } else if (key === "description") {
        updates.description = val;
      } else if (key === "labels") {
        updates.labels = val;
      } else if (key === "assignee") {
        updates.assignee = val === "me" ? userId : val;
        if (updates.assignee !== task.assignee) trackFields.push(["assignee", task.assignee || "", updates.assignee || ""]);
      } else if (key === "triage_status") {
        updates.triage_status = val;
        if (val === "active") updates.promoted = true;
      } else if (key === "execution_status") {
        updates.execution_status = val || undefined;
        if (val !== (task.execution_status || "")) trackFields.push(["execution_status", task.execution_status || "", val || ""]);
      } else if (key === "project_id") {
        updates.project_id = val || undefined;
      } else if (key === "project_path") {
        updates.project_path = val || undefined;
      }
    }

    for (const [field, oldVal, newVal] of trackFields) {
      await ctx.db.insert("task_history", {
        task_id: task._id, user_id: userId, actor_type: "user" as const,
        action: "updated", field, old_value: String(oldVal), new_value: String(newVal),
        created_at: now,
      });
    }

    await ctx.db.patch(task._id, updates);

    if (fields.status && fields.status !== task.status) {
      if (task.plan_id) {
        await recalcPlanProgress(ctx, task.plan_id, task._id, fields.status);
      }
      await notifySubscribers(ctx, "task_status_changed", userId, task as any, `changed ${task.short_id} to ${fields.status}`);
    }

    if (fields.assignee !== undefined && updates.assignee !== task.assignee) {
      const assigneeUserId = await resolveAssigneeToUserId(ctx, updates.assignee || "", task.team_id);
      if (assigneeUserId && assigneeUserId.toString() !== userId.toString()) {
        await subscribeUser(ctx, assigneeUserId, task._id, "assignee");
        await ctx.runMutation(internal.notificationRouter.emit, {
          event_type: "task_assigned",
          actor_user_id: userId,
          entity_type: "task",
          entity_id: task._id.toString(),
          message: `assigned ${task.short_id} to you`,
        });
      }
    }
  },

  createTask: async (ctx, userId, [opts]: [any]) => {
    let teamId: Id<"teams"> | undefined;
    if (opts.team_id) {
      teamId = opts.team_id as Id<"teams">;
    } else {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      // Fall back to user's active team if no directory mapping matches —
      // mirrors session creation so tasks land on the same team as the
      // session that spawned them.
      const user = await ctx.db.get(userId);
      const fallbackTeam = (user?.active_team_id || (user as any)?.team_id) as Id<"teams"> | undefined;
      teamId = resolveTeamForPath(mappings, opts.project_path, fallbackTeam).teamId;
    }

    const shortId = await nextShortId(ctx.db, "ct");

    let projectId;
    if (opts.project_id) {
      const p = await ctx.db.query("projects").filter((q: any) => q.eq(q.field("_id"), opts.project_id)).first();
      if (p) projectId = p._id;
    }

    const resolvedAssignee = await resolveAssigneeStr(ctx, opts.assignee, userId);

    let planId: Id<"plans"> | undefined;
    if (opts.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", opts.plan_id))
        .first();
      if (plan) planId = plan._id;
    }

    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      user_id: userId,
      team_id: teamId,
      project_id: projectId,
      plan_id: planId,
      short_id: shortId,
      title: opts.title,
      description: opts.description,
      task_type: opts.task_type || "task",
      status: opts.status || "open",
      priority: opts.priority || "medium",
      labels: opts.labels,
      assignee: resolvedAssignee,
      source: "human" as const,
      attempt_count: 0,
      retry_count: 0,
      max_retries: 3,
      created_at: now,
      updated_at: now,
    });

    if (planId) {
      const plan = await ctx.db.get(planId);
      if (plan) {
        const taskIds = plan.task_ids || [];
        await ctx.db.patch(planId, { task_ids: [...taskIds, id], updated_at: now });
      }
    }

    await ctx.db.insert("task_history", {
      task_id: id,
      user_id: userId,
      actor_type: "user" as const,
      action: "created",
      created_at: now,
    });

    return { id, short_id: shortId };
  },

  // Delegate to tasks.webAddComment so the local-first path keeps image
  // attachments, the canAccessTask check, and subscriber notifications — none of
  // which the old inline insert had. Same ctx.runMutation reuse as updatePlan.
  addTaskComment: async (ctx, userId, [shortId, text, commentType, imageIds]: [string, string, string?, string[]?]) => {
    await (ctx as any).runMutation(api.tasks.webAddComment, {
      short_id: shortId,
      text,
      comment_type: commentType || undefined,
      image_storage_ids: imageIds && imageIds.length ? imageIds : undefined,
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

  updateDoc: async (ctx, userId, [docId, fields]: [string, { content?: string; title?: string; doc_type?: string; labels?: string[] }]) => {
    const doc = await ctx.db.get(docId as Id<"docs">);
    if (!doc) throw new Error("Doc not found");
    if (!(await canAccessDoc(ctx, userId, doc))) throw new Error("Unauthorized");
    const updates: any = { updated_at: Date.now() };
    if (fields.content !== undefined) updates.content = fields.content;
    if (fields.title !== undefined) updates.title = fields.title;
    if (fields.doc_type !== undefined) updates.doc_type = fields.doc_type;
    if (fields.labels !== undefined) updates.labels = fields.labels;
    await ctx.db.patch(doc._id, updates);
  },

  // Plans/projects carry server-side logic (plan progress recalc, doc-title
  // sync, access checks) that already lives in their public mutations. Rather
  // than duplicate it, the side-effect delegates via ctx.runMutation in the
  // same transaction — same identity, atomic. The client mutates plans[]/
  // projects[] optimistically; this performs the authoritative write.
  updatePlan: async (ctx, userId, [shortId, fields]: [string, Record<string, any>]) => {
    await (ctx as any).runMutation(api.plans.webUpdate, { short_id: shortId, ...fields });
  },

  updateProject: async (ctx, userId, [id, fields]: [string, Record<string, any>]) => {
    await (ctx as any).runMutation(api.projects.webUpdate, { id, ...fields });
  },

  toggleBookmark: async (ctx, userId, [conversationId, messageId]: [string, string]) => {
    return await (ctx as any).runMutation(api.bookmarks.toggleBookmark, {
      conversation_id: conversationId,
      message_id: messageId,
    });
  },

  markNotificationRead: async (ctx, userId, [id]: [string]) => {
    return await (ctx as any).runMutation(api.notifications.markAsRead, { notificationId: id });
  },
  markAllNotificationsRead: async (ctx, userId) => {
    return await (ctx as any).runMutation(api.notifications.markAllAsRead, {});
  },

  // Creates delegate to the existing webCreate mutations (which own short-id
  // allocation, team resolution, history, etc.) and return their {id,...} so
  // the awaiting caller can navigate to the new record.
  createBucket: async (ctx, userId, [opts]: [{ name: string; color?: string }]) => {
    // Shared with the CLI's `cast label create` — see buckets.createBucketForUser.
    return await createBucketForUser(ctx as any, userId, opts);
  },

  // Teammate comment create/delete/agent-ask delegate to the public comment
  // mutations (which carry the notification / mention / fork logic). The store
  // optimistic stub already painted; the real row supersedes it via client_id.
  addComment: async (ctx, _userId, _args, result) => {
    const r = result as { conversationId: string; content: string; messageId?: string; parentCommentId?: string; clientId: string };
    return ctx.runMutation!(api.comments.addComment, {
      conversation_id: r.conversationId as Id<"conversations">,
      content: r.content,
      message_id: r.messageId ? (r.messageId as Id<"messages">) : undefined,
      parent_comment_id: r.parentCommentId ? (r.parentCommentId as Id<"comments">) : undefined,
      client_id: r.clientId,
    });
  },
  deleteComment: async (ctx, _userId, _args, result) => {
    const r = result as { commentId: string };
    // A stub id (optimistic create not yet landed) has nothing to delete server-side.
    if (!r.commentId || r.commentId.startsWith("commentstub")) return;
    return ctx.runMutation!(api.comments.deleteComment, { comment_id: r.commentId as Id<"comments"> });
  },
  askAgentInThread: async (ctx, _userId, _args, result) => {
    const r = result as { conversationId: string; messageId?: string; clientId: string };
    return ctx.runMutation!(api.comments.askAgentInThread, {
      conversation_id: r.conversationId as Id<"conversations">,
      message_id: r.messageId ? (r.messageId as Id<"messages">) : undefined,
      client_id: r.clientId,
    });
  },

  // Exclusive per-user filing: upsert the single (user, conversation) row.
  // bucketId null = unassign (tombstone row, never deleted — delta sync).
  // Returns the gate it stopped at (or "ok") so a silent no-op is debuggable
  // from the client (`await store.assignSessionToBucket(...)`).
  assignSessionToBucket: async (ctx, userId, [convId, bucketId]: [string, string | null]) => {
    let conv: any = null;
    let convErr: string | null = null;
    try {
      conv = await ctx.db.get(convId as Id<"conversations">);
    } catch (e: any) {
      convErr = String(e?.message || e);
    }
    if (!conv) return { gate: "conv_not_found", convErr };
    if (String(conv.user_id) !== String(userId)) return { gate: "conv_not_owned" };
    if (bucketId) {
      const bucket = await ctx.db.get(bucketId as Id<"inbox_buckets">).catch(() => null);
      if (!bucket || String((bucket as any).user_id) !== String(userId)) return { gate: "bucket_not_owned" };
    }
    // Shared with the CLI's `cast label set/clear` — see buckets.assignConversationToBucketForUser.
    await assignConversationToBucketForUser(
      ctx as any,
      userId,
      convId as Id<"conversations">,
      (bucketId ?? null) as Id<"inbox_buckets"> | null
    );
    return { gate: "ok" };
  },

  createDoc: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.docs.webCreate, opts);
  },
  createPlan: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.plans.webCreate, opts);
  },
  createProject: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.projects.webCreate, opts);
  },
  promoteDocToPlan: async (ctx, userId, [docId]: [string]) => {
    return await (ctx as any).runMutation(api.docs.webPromoteToPlan, { doc_id: docId });
  },
  ensurePlanDoc: async (ctx, userId, [planId]: [string]) => {
    return await (ctx as any).runMutation(api.plans.ensureDoc, { plan_id: planId });
  },
  publishToDirectory: async (ctx, userId, [opts]: [any]) => {
    return await (ctx as any).runMutation(api.conversations.publishToDirectory, opts);
  },
  moveDoc: async (ctx, userId, [id, parentId, sortOrder]: [string, string?, number?]) => {
    return await (ctx as any).runMutation(api.docs.webMoveDoc, {
      id,
      parent_id: parentId ?? undefined,
      sort_order: sortOrder ?? undefined,
    });
  },

  // Generic session daemon-command dispatch: delegates to the existing mutation
  // so all its dedup / pending-reset / multi-command logic is reused verbatim.
  // The store's convCommand action routes every kill/restart/repair/reconfigure/
  // rewind/fork/sendKeys/sendEscape/resume here. Every target takes
  // conversation_id as its first arg; per-command extras ride extraArgs.
  convCommand: async (ctx, userId, [convId, command, extraArgs]: [string, string, Record<string, any>?]) => {
    const fn = (SESSION_COMMANDS as Record<string, any>)[command];
    if (!fn) throw new Error(`convCommand: unknown command ${command}`);
    return await (ctx as any).runMutation(fn, {
      conversation_id: convId,
      ...(extraArgs || {}),
    });
  },
};

const SESSION_COMMANDS = {
  killSession: api.conversations.killSession,
  restartSession: api.conversations.restartSession,
  repairSession: api.conversations.repairSession,
  reconfigureSession: api.conversations.reconfigureSession,
  rewindSession: api.conversations.rewindSession,
  forkFromMessage: api.conversations.forkFromMessage,
  sendKeysToSession: api.conversations.sendKeysToSession,
  setSessionModel: api.conversations.setSessionModel,
  sendEscapeToSession: api.conversations.sendEscapeToSession,
  resumeSession: api.users.resumeSession,
};
