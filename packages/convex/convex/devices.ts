import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";

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

const DEVICE_ONLINE_MS = 2 * 60 * 1000; // a device is "online" if seen within 2 min

/** True if `p` is at or below a known project root (`root` or a child of it). */
function pathUnderRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

/**
 * Resolve which device should OWN (and therefore run) a session, deterministically,
 * so `start_session` is routed to one machine instead of raced by every daemon.
 *
 * Priority:
 *   1. The conversation's existing owner, if it's still online (sticky ownership).
 *   2. The online device whose `local_project_roots` contain the project path —
 *      i.e. the machine that actually has the checkout (most-recently-seen wins ties).
 *   3. The only online device, if there's exactly one (single-machine users:
 *      unambiguous even when roots are stale/empty).
 *   4. null — genuinely ambiguous (multiple daemons, none matches). Caller leaves
 *      the command untargeted (broadcast) and the daemon-side guards arbitrate.
 */
export async function resolveOwnerDevice(
  ctx: { db: any },
  userId: Id<"users">,
  opts: { projectPath?: string | null; gitRoot?: string | null; ownerDeviceId?: string | null },
): Promise<string | null> {
  const now = Date.now();
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const online = devices.filter((d: any) => now - d.last_seen < DEVICE_ONLINE_MS);
  if (online.length === 0) return null;

  // 1. Sticky owner, if still online.
  if (opts.ownerDeviceId && online.some((d: any) => d.device_id === opts.ownerDeviceId)) {
    return opts.ownerDeviceId;
  }

  // 2. Device that has the checkout.
  const paths = [opts.gitRoot, opts.projectPath].filter((p): p is string => !!p);
  if (paths.length > 0) {
    const matches = online
      .filter((d: any) =>
        (d.local_project_roots ?? []).some((r: string) =>
          paths.some((p) => pathUnderRoot(p, r)),
        ),
      )
      .sort((a: any, b: any) => b.last_seen - a.last_seen);
    if (matches.length > 0) return matches[0].device_id;
  }

  // 3. Exactly one daemon online — unambiguous.
  if (online.length === 1) return online[0].device_id;

  // 4. Ambiguous.
  return null;
}

/**
 * Enqueue a `start_session` command routed to the device that owns the session,
 * and stamp that ownership on the conversation so it stays in sync with routing.
 * Single chokepoint for every start_session producer — replaces ad-hoc inserts
 * so the targeting/ownership logic can never drift between call sites.
 */
export async function enqueueStartSession(
  ctx: { db: any },
  userId: Id<"users">,
  opts: {
    conversationId: Id<"conversations">;
    agentType: "claude" | "codex" | "cursor" | "gemini";
    projectPath?: string | null;
    gitRoot?: string | null;
    sessionId?: string;
    isolated?: boolean;
    worktreeName?: string;
    prompt?: string;
    createdAt?: number;
  },
): Promise<Id<"daemon_commands">> {
  const conv = await ctx.db.get(opts.conversationId);
  const projectPath = opts.projectPath ?? conv?.project_path ?? null;
  const gitRoot = opts.gitRoot ?? conv?.git_root ?? null;

  const target = await resolveOwnerDevice(ctx, userId, {
    projectPath,
    gitRoot,
    ownerDeviceId: conv?.owner_device_id ?? null,
  });

  // Keep ownership in lockstep with routing: the machine we route to becomes the
  // owner, which also lets a live device reclaim a session whose prior owner went
  // offline (resolveOwnerDevice already skips offline owners).
  if (target && conv && conv.owner_device_id !== target) {
    await ctx.db.patch(opts.conversationId, { owner_device_id: target });
  }

  const args: Record<string, any> = {
    agent_type: opts.agentType,
    conversation_id: opts.conversationId,
  };
  if (projectPath) args.project_path = projectPath;
  if (opts.sessionId) args.session_id = opts.sessionId;
  if (opts.isolated) args.isolated = true;
  if (opts.worktreeName) args.worktree_name = opts.worktreeName;
  if (opts.prompt) args.prompt = opts.prompt;

  return await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "start_session" as const,
    args: JSON.stringify(args),
    created_at: opts.createdAt ?? Date.now(),
    target_device_id: target ?? undefined,
  });
}

/**
 * Upsert this machine's device row. Called by the daemon on heartbeat. Per-
 * device fields (local_project_roots) live here so multiple machines don't
 * clobber each other on the shared user doc.
 */
export const registerDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    label: v.string(),
    platform: v.string(),
    is_remote: v.optional(v.boolean()),
    local_project_roots: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");

    const now = Date.now();
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) =>
        q.eq("user_id", userId).eq("device_id", args.device_id),
      )
      .first();

    const patch = {
      label: args.label,
      platform: args.platform,
      last_seen: now,
      status: "online" as const,
      ...(args.is_remote !== undefined ? { is_remote: args.is_remote } : {}),
      ...(args.local_project_roots !== undefined
        ? { local_project_roots: args.local_project_roots }
        : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { device_id: args.device_id, created: false };
    }
    await ctx.db.insert("devices", { user_id: userId, device_id: args.device_id, ...patch });
    return { device_id: args.device_id, created: true };
  },
});

/**
 * Owner device of a conversation. Used by daemons to enforce the single-owner
 * invariant on session-targeted commands (resume/kill/inject): a daemon skips
 * commands for conversations owned by another device.
 */
export const getConversationOwner = query({
  args: { api_token: v.optional(v.string()), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) return null;
    return { owner_device_id: (conv as any).owner_device_id ?? null };
  },
});

/** Resolve a session_id to its conversation (api_token authed) for the move flow. */
export const resolveConversationBySession = query({
  args: { api_token: v.optional(v.string()), session_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .filter((q: any) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv) return null;
    return {
      _id: conv._id,
      short_id: conv.short_id ?? null,
      owner_device_id: (conv as any).owner_device_id ?? null,
      project_path: conv.project_path ?? null,
      status: conv.status,
      title: conv.title ?? null,
    };
  },
});

/**
 * Server side of `cast remote move`: flip a conversation's owner to the target
 * device, repoint its project_path to the remote worktree, and enqueue a
 * resume_session command (which only the owner device will execute, per the
 * daemon's single-owner guard). One mutation = atomic handoff of ownership.
 */
export const moveSessionToDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    owner_device_id: v.string(),
    project_path: v.string(),
    resume: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");

    await ctx.db.patch(args.conversation_id, {
      owner_device_id: args.owner_device_id,
      project_path: args.project_path,
      status: "active" as const,
      updated_at: Date.now(),
    });

    let commandId: string | undefined;
    if (args.resume !== false) {
      const agentType =
        conv.agent_type === "codex" ? "codex" : conv.agent_type === "gemini" ? "gemini" : "claude";
      const id = await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "resume_session" as const,
        args: JSON.stringify({
          session_id: conv.session_id,
          agent_type: agentType,
          conversation_id: args.conversation_id,
          project_path: args.project_path,
        }),
        created_at: Date.now(),
      });
      commandId = id;
    }
    return { ok: true, command_id: commandId, owner_device_id: args.owner_device_id };
  },
});

/**
 * Web-callable "move to remote": enqueue a move_to_device command targeted at
 * the session's current owner (source) daemon, which performs the local-only
 * transfer then flips ownership + resumes on the destination. Session-authed.
 */
export const moveToRemote = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    to_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");

    const now = Date.now();
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const online = devices.filter((d: any) => now - d.last_seen < DEVICE_ONLINE_MS);

    const dest = args.to_device_id
      ? online.find((d: any) => d.device_id === args.to_device_id)
      : online.find((d: any) => d.is_remote);
    if (!dest) throw new Error("No online destination device (start the remote daemon)");

    const ownerOnline = (conv as any).owner_device_id && online.some((d: any) => d.device_id === (conv as any).owner_device_id);
    const source = ownerOnline ? (conv as any).owner_device_id : (online.find((d: any) => !d.is_remote)?.device_id ?? null);
    if (!source) throw new Error("No online source device to perform the move");
    if (source === dest.device_id) throw new Error("Session is already on that device");

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "move_to_device" as const,
      args: JSON.stringify({ conversation_id: args.conversation_id, session_id: conv.session_id, to_device_id: dest.device_id }),
      created_at: now,
      target_device_id: source,
    });
    return { command_id: commandId, source, dest: dest.device_id };
  },
});

/** List the user's devices (for the web UI + `cast remote hosts`). */
export const listDevices = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const now = Date.now();
    const ONLINE_MS = 2 * 60 * 1000; // online if seen within 2 min
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    return rows
      .map((d: any) => ({
        device_id: d.device_id,
        label: d.label,
        platform: d.platform,
        last_seen: d.last_seen,
        is_remote: d.is_remote ?? false,
        local_project_roots: d.local_project_roots ?? [],
        online: now - d.last_seen < ONLINE_MS,
      }))
      .sort((a: any, b: any) => b.last_seen - a.last_seen);
  },
});

/**
 * Claim a conversation for this device on a successful session start: stamp
 * owner_device_id and clear any stale session_error in one write. This is the
 * first real enforcement of the single-owner invariant — the device that can
 * actually run the session becomes its owner, which self-heals a "clone it
 * first" error written by a different device that lacked the checkout.
 */
export const claimConversation = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id.toString() !== userId.toString()) return;
    await ctx.db.patch(convId, {
      owner_device_id: args.device_id,
      session_error: undefined,
    });
    return { ok: true };
  },
});

/**
 * Atomic pre-spawn ownership claim. A daemon calls this AFTER confirming it can
 * run the session (the checkout resolved) but BEFORE spawning. Compare-and-set on
 * owner_device_id: the claim wins if the conversation is unowned, already owned by
 * this device, or owned by an OFFLINE device. Convex serializes concurrent claims
 * (OCC on the conversation doc), so for a broadcast start_session (target couldn't
 * be resolved → ≥2 daemons receive it) exactly ONE daemon wins and spawns; the rest
 * get { won: false } and skip. This closes the double-spawn tail that device routing
 * leaves when resolveOwnerDevice returns null. Targeted commands already own the
 * conversation (stamped at enqueue), so this is a no-op win for them.
 */
export const claimConversationForStart = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return { won: true as const }; // unknown id — don't block the spawn
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id.toString() !== userId.toString()) return { won: false as const };
    const owner = (conv as any).owner_device_id as string | undefined;
    if (owner && owner !== args.device_id) {
      const ownerDevice = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) =>
          q.eq("user_id", userId).eq("device_id", owner),
        )
        .first();
      const ownerOnline = ownerDevice && Date.now() - ownerDevice.last_seen < DEVICE_ONLINE_MS;
      if (ownerOnline) return { won: false as const, owner }; // another live daemon owns it
      // Owner offline → reclaim.
    }
    await ctx.db.patch(convId, { owner_device_id: args.device_id });
    return { won: true as const };
  },
});

/**
 * Set (or clear) which device owns a conversation. Used by the move flow to
 * flip ownership local <-> remote. Authorizes the caller owns the conversation.
 */
export const setConversationOwner = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    owner_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) throw new Error("conversation not found");
    if (conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    await ctx.db.patch(args.conversation_id, { owner_device_id: args.owner_device_id });
    return { ok: true, owner_device_id: args.owner_device_id ?? null };
  },
});
