import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import {
  DEVICE_ONLINE_MS,
  pathUnderRoot,
  pickOwnerDevice,
  type RoutableDevice,
} from "./deviceRouting";
import { normalizeProjectPath } from "./projectPaths";

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
 * DB-backed wrapper around {@link pickOwnerDevice}: loads the user's devices and
 * delegates the (pure) routing decision. Used to target `start_session` at one
 * machine instead of letting every daemon race it.
 */
export async function resolveOwnerDevice(
  ctx: { db: any },
  userId: Id<"users">,
  opts: { projectPath?: string | null; gitRoot?: string | null; ownerDeviceId?: string | null },
): Promise<string | null> {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  return pickOwnerDevice(devices as RoutableDevice[], opts, Date.now());
}

/**
 * Union of `local_project_roots` across the user's currently-online devices.
 *
 * Replaces the legacy per-user `users.local_project_roots`, which every daemon
 * overwrote on each heartbeat — so a multi-machine user (e.g. a local Mac plus a
 * remote one) saw the field flip-flop every 30s, and the recent-projects filter
 * flickered with it. Per-device roots are stable, so unioning the online ones
 * gives every machine's real checkouts at once.
 *
 * Returns [] when no device is online / reporting — callers treat that as
 * "don't filter" (show unfiltered rather than nothing).
 */
export async function getOnlineLocalRoots(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<string[]> {
  const now = Date.now();
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const roots = new Set<string>();
  for (const d of devices) {
    // A remote box's roots are its own $HOME work dirs — surfacing them as
    // project suggestions invites blank/new sessions onto the remote. New
    // sessions belong to local checkouts; the remote is reached by explicit move.
    if (d.is_remote) continue;
    if (now - d.last_seen >= DEVICE_ONLINE_MS) continue;
    for (const r of d.local_project_roots ?? []) roots.add(r);
  }
  return Array.from(roots);
}

type ClaimDevice = { is_remote?: boolean; last_seen?: number } | null | undefined;

export function planConversationOwnershipClaim(opts: {
  ownerDeviceId?: string | null;
  claimantDeviceId: string;
  ownerDevice?: ClaimDevice;
  claimantDevice?: ClaimDevice;
  claimantIsRemote?: boolean;
  now: number;
}): { won: true } | { won: false; owner?: string } {
  const owner = opts.ownerDeviceId ?? undefined;
  if (owner && owner !== opts.claimantDeviceId) {
    const ownerOnline =
      opts.ownerDevice &&
      !opts.ownerDevice.is_remote &&
      typeof opts.ownerDevice.last_seen === "number" &&
      opts.now - opts.ownerDevice.last_seen < DEVICE_ONLINE_MS;
    if (ownerOnline) return { won: false, owner };
  }
  const claimantIsRemote = opts.claimantIsRemote ?? !!opts.claimantDevice?.is_remote;
  if (owner !== opts.claimantDeviceId && claimantIsRemote) {
    return { won: false, owner };
  }
  return { won: true };
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
    // Per-session launch overrides (shared-contract option key + effort level).
    // The daemon maps them to agent flags (claude --model/--effort, codex -m/-c);
    // they ride the payload so old daemons just ignore them.
    model?: string;
    effort?: string;
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
  if (opts.model) args.model = opts.model;
  if (opts.effort) args.effort = opts.effort;

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
 * commands for conversations owned by another LIVE LOCAL device.
 *
 * Also reports whether that owner is a remote box (and whether it's online), so a
 * local daemon can tell the difference between "another laptop owns this, back
 * off" and "a remote owns this but can only serve an explicitly-moved session —
 * if I have the checkout I should reclaim it" (the auto-claim self-heal).
 */
export const getConversationOwner = query({
  args: { api_token: v.optional(v.string()), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) return null;
    const owner = (conv as any).owner_device_id ?? null;
    let owner_is_remote = false;
    let owner_online = false;
    if (owner) {
      const ownerDevice = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", owner))
        .first();
      owner_is_remote = !!ownerDevice?.is_remote;
      owner_online = !!ownerDevice && Date.now() - ownerDevice.last_seen < DEVICE_ONLINE_MS;
    }
    return { owner_device_id: owner, owner_is_remote, owner_online };
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

/**
 * One-time self-heal for the auto-claim deadlock: clear `owner_device_id` on any
 * conversation a REMOTE device owns but cannot legitimately serve, so routing
 * re-resolves it to the local machine. A conversation is reclaimed when EITHER:
 *
 *   (a) its `project_path` is under some LOCAL device's `local_project_roots`
 *       (it demonstrably belongs to a laptop/desktop), OR
 *   (b) its `project_path` is junk — `normalizeProjectPath` returns null (a bare
 *       home dir like /Users/m1, or a temp dir). A real move always points at a
 *       worktree under the remote's home (/Users/m1/work/<repo>), never bare home,
 *       so a bare-home owner is always the resume-$HOME-fallback mislabel.
 *
 * Legitimately moved sessions (project_path = a real path under the remote's home)
 * match neither rule and are left untouched.
 *
 * Run: npx convex run devices:reclaimAutoClaimedRemoteSessions '{"user_id":"<id>"}'
 */
export const reclaimAutoClaimedRemoteSessions = internalMutation({
  args: { dry_run: v.optional(v.boolean()), user_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scopeUser = args.user_id ? ctx.db.normalizeId("users", args.user_id) : null;
    const devices = await ctx.db.query("devices").collect();
    // Per-user union of local (non-remote) project roots, and the remote devices.
    const localRoots = new Map<string, string[]>(); // userId -> roots
    const remotes: any[] = [];
    for (const d of devices) {
      if (scopeUser && d.user_id.toString() !== scopeUser.toString()) continue;
      const uid = d.user_id.toString();
      if (d.is_remote) {
        remotes.push(d);
      } else {
        const cur = localRoots.get(uid) ?? [];
        for (const r of d.local_project_roots ?? []) cur.push(r);
        localRoots.set(uid, cur);
      }
    }

    const cleared: Array<{ conversation: string; from_device: string; project_path: string | null; rule: string }> = [];
    for (const remote of remotes) {
      const roots = localRoots.get(remote.user_id.toString()) ?? [];
      const owned = await ctx.db
        .query("conversations")
        .withIndex("by_owner_device", (q: any) =>
          q.eq("user_id", remote.user_id).eq("owner_device_id", remote.device_id),
        )
        .collect();
      for (const conv of owned) {
        const p = conv.project_path as string | undefined;
        const belongsLocal = !!p && roots.some((r) => pathUnderRoot(p, r));
        const junkPath = !p || normalizeProjectPath(p) === null;
        if (!belongsLocal && !junkPath) continue;
        cleared.push({
          conversation: conv.short_id ?? conv._id,
          from_device: remote.device_id.slice(0, 8),
          project_path: p ?? null,
          rule: belongsLocal ? "belongs-local" : "junk-path",
        });
        if (!args.dry_run) {
          await ctx.db.patch(conv._id, { owner_device_id: undefined, session_error: undefined });
        }
      }
    }
    return { cleared_count: cleared.length, dry_run: !!args.dry_run, cleared };
  },
});

/**
 * Explicitly (re)assign which device runs a conversation, then resume it there.
 * Powers the web/mobile "Run on this device" / "Bring back here" controls — the
 * user-driven counterpart to auto-routing. Stamps owner_device_id, clears any
 * stale session_error, and enqueues a resume_session targeted at that device so
 * only it acts. Use moveToRemote for a remote box (it also transfers the worktree);
 * this is for re-homing ownership to a device that already has the checkout.
 */
export const reassignToDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) throw new Error("Unknown device");

    await ctx.db.patch(args.conversation_id, {
      owner_device_id: args.device_id,
      session_error: undefined,
      status: "active" as const,
      updated_at: Date.now(),
    });

    const agentType =
      conv.agent_type === "codex" ? "codex" : conv.agent_type === "gemini" ? "gemini" : "claude";
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "resume_session" as const,
      args: JSON.stringify({
        session_id: conv.session_id,
        agent_type: agentType,
        conversation_id: args.conversation_id,
        ...(conv.project_path ? { project_path: conv.project_path } : {}),
      }),
      created_at: Date.now(),
      target_device_id: args.device_id,
    });
    return { ok: true, command_id: commandId, device_id: args.device_id, label: device.label };
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
        settings: d.settings ?? undefined,
        online: now - d.last_seen < ONLINE_MS,
      }))
      .sort((a: any, b: any) => b.last_seen - a.last_seen);
  },
});

/**
 * Web "Agent Features" page changed a setting for one device. Enqueue a
 * device-targeted `apply_snippet` command (the daemon runs `cast install <slug>`
 * / `--disable`, or `cast stable <mode>` for the stable hook, then heartbeats the
 * new state back) and optimistically patch the device's `settings` so every
 * viewer reflects the change instantly — the next heartbeat reconciles to the
 * device's real state either way.
 *
 * The command carries a 5-min TTL, so a change only "lands" on a device that
 * comes online within that window; the web gates the controls on `device.online`.
 *
 * Two shapes:
 *   - a boolean snippet: `{ snippet, enabled }`
 *   - the stable hook: `{ snippet: "stable", mode: "solo"|"team"|"off", global }`
 *     (tri-state, so it carries a mode instead of a bare boolean).
 */
export const setDeviceSnippet = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    snippet: v.string(),
    enabled: v.boolean(),
    // Stable-only: the injection mode and whether it spans all projects.
    mode: v.optional(v.union(v.literal("solo"), v.literal("team"), v.literal("off"))),
    global: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) throw new Error("Unknown device");

    const isStable = args.snippet === "stable";
    const mode = args.mode ?? (args.enabled ? "solo" : "off");

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "apply_snippet" as const,
      args: JSON.stringify(
        isStable
          ? { snippet: "stable", enabled: mode !== "off", mode, global: args.global === true }
          : { snippet: args.snippet, enabled: args.enabled },
      ),
      created_at: Date.now(),
      target_device_id: args.device_id,
    });

    // Optimistic mirror: keep the daemon as source of truth, but show the change
    // immediately rather than waiting a heartbeat cycle.
    const prev = (device as any).settings ?? {};
    const next = isStable
      ? { ...prev, stable_mode: mode, stable_global: args.global === true }
      : { ...prev, snippets: { ...(prev.snippets ?? {}), [args.snippet]: args.enabled } };
    await ctx.db.patch(device._id, { settings: next });

    return { command_id: commandId };
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
      // A live LOCAL owner blocks the claim. A remote owner does not: a local
      // daemon that resolved a checkout is the rightful owner over a remote that
      // can't serve the session (mirrors registerManagedSession's reclaim rule).
      const ownerOnline =
        ownerDevice && !ownerDevice.is_remote && Date.now() - ownerDevice.last_seen < DEVICE_ONLINE_MS;
      if (ownerOnline) return { won: false as const, owner }; // another live daemon owns it
      // Owner offline, or owner is a remote box → reclaim.
    }
    // A REMOTE device may never auto-claim a session it doesn't already own — the
    // remote only runs sessions explicitly moved to it (which stamp ownership up
    // front, so owner === device_id and we never reach here). This stops a remote
    // from winning a broadcast start_session and stranding it (the core deadlock).
    if (owner !== args.device_id) {
      const me = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) =>
          q.eq("user_id", userId).eq("device_id", args.device_id),
        )
        .first();
      if (me?.is_remote) return { won: false as const, owner };
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
