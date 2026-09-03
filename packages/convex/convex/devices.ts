import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { AgentClientId } from "@codecast/shared/contracts";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { canAccessConversation } from "./lib/access";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import {
  DEVICE_ONLINE_MS,
  pathUnderRoot,
  pickOwnerDevice,
  type RoutableDevice,
} from "./deviceRouting";
import { normalizeProjectPath } from "./projectPaths";
import { activeTokenProfile } from "./ccAccountsShared";
import { bucketTs } from "./presenceState";
import { checkConversationAccess, isTeamAdmin, isTeamMember } from "./privacy";
import { isSessionOwner } from "./sessionOwners";
import { fromConvexAgentType, findModelOption } from "@codecast/shared/contracts";

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
  opts: {
    projectPath?: string | null;
    gitRoot?: string | null;
    ownerDeviceId?: string | null;
    targetDeviceId?: string | null;
  },
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

/**
 * One device's `local_project_roots`, or null if the user has no such device.
 *
 * Deliberately ignores `last_seen`: roots are stored state, and a session
 * targeted at a sleeping machine still routes (rung 6) or falls back to a live
 * one, so an offline machine's directories stay pickable.
 */
export async function getDeviceLocalRoots(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId: string,
): Promise<string[] | null> {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId))
    .first();
  if (!device) return null;
  return device.local_project_roots ?? [];
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
    agentType: AgentClientId;
    projectPath?: string | null;
    gitRoot?: string | null;
    // The machine the user picked by hand. Honoured when it's online, otherwise
    // routing falls back to whatever is alive and has the checkout.
    targetDeviceId?: string | null;
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
    // Saved Claude account profile to launch on (the daemon sources its
    // setup-token file; a name with no token file falls back to the keychain).
    ccAccount?: string;
    // Stable-context launch prefs from the new-session page: override the
    // machine's stable mode for this session ("off" suppresses injection) and
    // drop specific feed cards. Same ride-along contract as model/effort.
    stableMode?: string;
    stableExclude?: string[];
  },
): Promise<Id<"daemon_commands">> {
  const conv = await ctx.db.get(opts.conversationId);
  // A quiescing/fenced conversation's runtime belongs to the execution
  // coordinator; emitting a legacy start here would spawn a second, unmanaged
  // runtime beside the coordinator's binding (split-brain via the start
  // channel). The daemon re-checks on delivery for commands that were already
  // queued when the fence transitioned.
  if (conv?.execution_protocol_state) {
    throw new Error(
      `EXECUTION_PROTOCOL_LEGACY_START_REFUSED: conversation is ${conv.execution_protocol_state}`,
    );
  }
  const projectPath = opts.projectPath ?? conv?.project_path ?? null;
  const gitRoot = opts.gitRoot ?? conv?.git_root ?? null;

  const target = await resolveOwnerDevice(ctx, userId, {
    projectPath,
    gitRoot,
    ownerDeviceId: conv?.owner_device_id ?? null,
    targetDeviceId: opts.targetDeviceId ?? null,
  });

  // Keep ownership in lockstep with routing: the machine we route to becomes the
  // owner, which also lets a live device reclaim a session whose prior owner went
  // offline (resolveOwnerDevice already skips offline owners).
  if (target && conv && conv.owner_device_id !== target) {
    await ctx.db.patch(opts.conversationId, { owner_device_id: target });
  }

  // Codecast-owned model default: a launch with no explicit per-session pick
  // falls back to the user's default for this client (users.default_models),
  // so every managed session gets an explicit launch flag and the agent's own
  // saved default — a file any /model one-shot can rewrite — never decides
  // what a codecast session runs. Resolved here, the single start_session
  // chokepoint, so web creates, task assigns, spawns and triggers all inherit
  // it. Only launchable options qualify (cliAlias); resumes are unaffected —
  // the daemon re-derives a resumed session's model from its transcript.
  let model = opts.model;
  if (!model) {
    const userRow = await ctx.db.get(userId);
    const preferred = userRow?.default_models?.[opts.agentType];
    if (preferred && findModelOption(opts.agentType, preferred)?.cliAlias) {
      model = preferred;
      // Stamp the badge like dispatch does for explicit picks, but never
      // clobber a model the conversation already knows (an explicit pick's
      // stamp, or a prior session's rollup).
      if (conv && !conv.model) {
        await ctx.db.patch(opts.conversationId, {
          model: opts.agentType === "claude" ? `claude-${preferred}` : preferred,
        });
      }
    }
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
  if (model) args.model = model;
  if (opts.effort) args.effort = opts.effort;
  // Per-session accounts: with the device flag on, a Claude launch that names
  // no account is pinned to the profile covering that machine's current login
  // (when it has a live setup-token). Stamped on the row too, so the pin
  // survives every resume. Resolved here, the single start chokepoint.
  let ccAccount = opts.ccAccount;
  if (!ccAccount && opts.agentType === "claude" && target) {
    const targetDevice = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", target))
      .first();
    if (targetDevice?.cc_session_tokens === true) {
      ccAccount = activeTokenProfile(targetDevice.cc_accounts, Date.now());
      if (ccAccount && conv && conv.cc_account !== ccAccount) {
        await ctx.db.patch(opts.conversationId, { cc_account: ccAccount });
      }
    }
  }
  if (ccAccount) args.cc_account = ccAccount;
  if (opts.stableMode) args.stable_mode = opts.stableMode;
  if (opts.stableExclude?.length) args.stable_exclude = opts.stableExclude;

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
    if (!conv) return null;
    // Access, not identity. A session you OWN but did not author — one assigned
    // to you from another account — is still yours to resolve. The bare user_id
    // comparison this replaced returned null for those, and every caller reads
    // null as "unowned" and carries on, so the guard that stops one machine from
    // running a session another machine already owns failed open on exactly the
    // sessions two accounts share.
    if ((await checkConversationAccess(ctx, userId, conv as any)) === "denied") return null;
    return await resolveOwnerDeviceView(ctx, conv as any);
  },
});

/**
 * Owner device id of a conversation plus whether that device is a remote box and
 * currently online. Split out from the query so the scoping rule is testable.
 *
 * The device row is looked up under the conversation's AUTHOR, never the caller.
 * owner_device_id is always claimed by the account that runs the session, so for
 * a session one account runs and another owns, a lookup scoped to the caller
 * finds nothing — and a missing row reads as offline, reporting a live owner as
 * dead. Callers treat that as "unowned" and proceed, which is the opposite of
 * what the guard is for.
 */
export async function resolveOwnerDeviceView(
  ctx: { db: any },
  conv: { user_id: any; owner_device_id?: string | null },
  now: number = Date.now(),
): Promise<{ owner_device_id: string | null; owner_is_remote: boolean; owner_online: boolean }> {
  const owner = conv.owner_device_id ?? null;
  if (!owner) return { owner_device_id: null, owner_is_remote: false, owner_online: false };
  const ownerDevice = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) =>
      q.eq("user_id", conv.user_id).eq("device_id", owner),
    )
    .first();
  return {
    owner_device_id: owner,
    owner_is_remote: !!ownerDevice?.is_remote,
    owner_online: !!ownerDevice && now - ownerDevice.last_seen < DEVICE_ONLINE_MS,
  };
}

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
/**
 * Tell the machine that USED to run a conversation to tear its copy down.
 *
 * Every ownership flip needs this, whichever path flipped it: without it the
 * old machine's tmux + agent keep running, answer delivered messages in
 * parallel (split-brain), and — on a cloud box that stops itself when idle —
 * hold the machine awake indefinitely, which is a bill. Found live: a session
 * moved to EC2 and back left a claude running there after the return.
 *
 * The command goes in the PRE-MOVE runner's queue (`queueUserId`): a daemon
 * only polls its own user's queue, and across an account boundary that user
 * is not the caller. Best-effort: an offline previous owner never picks it up
 * and the command expires after the TTL.
 */
async function releasePreviousOwner(
  ctx: { db: any },
  opts: {
    queueUserId: Id<"users">;
    conversationId: Id<"conversations">;
    sessionId: string | undefined;
    priorDeviceId: string | undefined;
    newDeviceId: string;
  },
): Promise<void> {
  if (!opts.priorDeviceId || opts.priorDeviceId === opts.newDeviceId) return;
  await ctx.db.insert("daemon_commands", {
    user_id: opts.queueUserId,
    command: "release_session" as const,
    args: JSON.stringify({
      conversation_id: opts.conversationId,
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    }),
    created_at: Date.now(),
    target_device_id: opts.priorDeviceId,
  });
}

/**
 * The CLI transfer flip (`cast remote move` / `back`): the files are already
 * on the destination, so this only re-homes ownership, resumes there, and
 * releases the source. Exported for tests; the mutation below is the wrapper.
 */
export async function performMoveSessionToDevice(
  ctx: { db: any },
  userId: Id<"users">,
  args: { conversation_id: Id<"conversations">; owner_device_id: string; project_path: string; resume?: boolean },
): Promise<{ ok: true; command_id: string | undefined; owner_device_id: string }> {
  const conv = await ctx.db.get(args.conversation_id);
  if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
  const priorDeviceId = conv.owner_device_id as string | undefined;

  await ctx.db.patch(args.conversation_id, {
    owner_device_id: args.owner_device_id,
    project_path: args.project_path,
    status: "active" as const,
    updated_at: Date.now(),
  });

  let commandId: string | undefined;
  if (args.resume !== false) {
    const agentType = fromConvexAgentType(conv.agent_type);
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
      // Targeted, so only the destination acts: untargeted, every daemon of
      // the user's fetched it and had to decline via the owner guard.
      target_device_id: args.owner_device_id,
    });
    commandId = id;
  }
  await releasePreviousOwner(ctx, {
    queueUserId: userId,
    conversationId: args.conversation_id,
    sessionId: conv.session_id,
    priorDeviceId,
    newDeviceId: args.owner_device_id,
  });
  return { ok: true, command_id: commandId, owner_device_id: args.owner_device_id };
}

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
    return performMoveSessionToDevice(ctx, userId, args);
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
    // Any conversation ref — see reassignToDevice.
    conversation_id: v.string(),
    to_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await findConversationByAnyRefWhere(ctx, args.conversation_id, (candidate: any) =>
      candidate.user_id.toString() === userId.toString());
    if (!conv) throw new Error("not your conversation");

    const now = Date.now();
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const online = devices.filter((d: any) => now - d.last_seen < DEVICE_ONLINE_MS);

    // The destination may be ASLEEP: a cloud box's normal idle state is
    // "stopped, costs only its disk", and the SOURCE daemon's move command
    // wakes it (ensureUp) before transferring — so requiring the destination
    // to be online here would make the cheapest configuration unusable. Only
    // remotes get this grace; a local laptop cannot be woken by anyone.
    const mostRecent = (a: any, b: any) => b.last_seen - a.last_seen;
    const dest = args.to_device_id
      ? devices.find((d: any) => d.device_id === args.to_device_id)
      : online.find((d: any) => d.is_remote) ??
        [...devices].sort(mostRecent).find((d: any) => d.is_remote);
    if (!dest) throw new Error("No destination device (provision one: cast browser hosts provision)");
    const destOnline = online.some((d: any) => d.device_id === dest.device_id);
    if (!destOnline && !dest.is_remote) throw new Error("That device is offline and cannot be woken remotely");

    const ownerOnline = (conv as any).owner_device_id && online.some((d: any) => d.device_id === (conv as any).owner_device_id);
    const source = ownerOnline ? (conv as any).owner_device_id : (online.find((d: any) => !d.is_remote)?.device_id ?? null);
    if (!source) throw new Error("No online source device to perform the move");
    if (source === dest.device_id) throw new Error("Session is already on that device");

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "move_to_device" as const,
      args: JSON.stringify({ conversation_id: conv._id, session_id: conv.session_id, to_device_id: dest.device_id }),
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
 * When the caller owns the session but a teammate runs it, the move takes the
 * cross-user reparent path (performReparentSessionToDevice) instead: account
 * follows device, and the destination clones the repo if it isn't local.
 */
export async function performReassignToDevice(
  ctx: { db: any },
  userId: Id<"users">,
  args: { conversation_id: Id<"conversations">; device_id: string },
): Promise<{ ok: true; command_id: any; device_id: string; label: string; cross_user?: boolean }> {
  const conv = await ctx.db.get(args.conversation_id);
  if (!conv) throw new Error("not your conversation");
  // A session the caller OWNS but a teammate RUNS can't be re-homed by a plain
  // device restamp — the destination daemon runs under the caller's account, so
  // the account must follow the device. Route it through the cross-user
  // reparent, which authorizes runner-or-owner and rejects non-owners itself.
  if (conv.user_id.toString() !== userId.toString()) {
    return performReparentSessionToDevice(ctx, userId, {
      session_id: args.conversation_id,
      device_id: args.device_id,
    });
  }
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
    .first();
  if (!device) throw new Error("Unknown device");

  const prevOwner = (conv as any).owner_device_id as string | undefined;

  await ctx.db.patch(args.conversation_id, {
    owner_device_id: args.device_id,
    session_error: undefined,
    status: "active" as const,
    updated_at: Date.now(),
  });

  const agentType = fromConvexAgentType(conv.agent_type);
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

  await releasePreviousOwner(ctx, {
    queueUserId: userId,
    conversationId: args.conversation_id,
    sessionId: conv.session_id,
    priorDeviceId: prevOwner,
    newDeviceId: args.device_id,
  });
  return { ok: true, command_id: commandId, device_id: args.device_id, label: device.label };
}

// Resolve the target of a device move/pull. Two passes because the accept
// predicate decides WHICH conversation a colliding short id resolves to, and a
// pull is destructive (account flip + source-machine teardown): sessions the
// caller runs or owns always win the collision (strict pass), and only on a
// complete miss may a HUMAN teammate's ref resolve to a team-visible session.
// Team access suffices there because any teammate may already claim a visible
// session (cast own) and owners may pull — accepting team just composes those
// two allowed steps into one, instead of dead-ending the web's "Run on this
// device" with "not your conversation" (ct-44344). Billing still follows the
// puller, who consents by pulling onto their own machine. Bot accounts can
// never claim ownership, so they don't get the team path either; a bare share
// link never grants a pull.
async function findPullableConversation(
  ctx: { db: any },
  userId: Id<"users">,
  ref: string,
): Promise<any> {
  const own = await findConversationByAnyRefWhere(ctx, ref, async (candidate: any) =>
    (await checkConversationAccess(ctx, userId, candidate)) === "owner");
  if (own) return own;
  const caller = await ctx.db.get(userId);
  if (!caller || caller.is_bot) return null;
  return findConversationByAnyRefWhere(ctx, ref, async (candidate: any) =>
    (await checkConversationAccess(ctx, userId, candidate)) === "team");
}

export const reassignToDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    // Any conversation ref — convex id, short id, or session UUID. The web can
    // legitimately hold only a session UUID here: a fork page is keyed by the
    // fork's client-minted session id until the create resolves, and a
    // v.id() validator rejected those reassigns outright (ct-40176).
    conversation_id: v.string(),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    // Runs-or-owns-or-team (findPullableConversation), matching
    // performReparentSessionToDevice's rule: runners restamp in place, everyone
    // else falls through to the cross-user reparent (which re-authorizes
    // itself).
    const conv = await findPullableConversation(ctx, userId, args.conversation_id);
    if (!conv) {
      throw new Error(
        "not your conversation (you can only move a session you run or own, or one visible to your team)",
      );
    }
    return performReassignToDevice(ctx, userId, {
      conversation_id: conv._id,
      device_id: args.device_id,
    });
  },
});

// Cross-user device reparent — the device axis across accounts. Unlike
// reassignToDevice (same-user "run on this device"), the caller may pull a
// session RUN BY A TEAMMATE onto their OWN machine, provided they run it, own
// it, or can see it via their team. Account follows device: the session then
// runs and bills under the caller (user_id -> caller), and the immutable author
// is pinned (author_user_id) so it survives the user_id rewrite. Owners are
// untouched — the device axis and the owner axis move independently.
//
// Narrow by design: you may only pull onto YOUR OWN device. Moving a session
// onto a third party's machine would need their consent and credential, which we
// never transfer. Factored out so tests can drive it with an explicit userId.
// The destination daemon can only clone the repo if it knows the git remote —
// but git_remote_url stamping is unreliable (ct-38666: daemon-created
// conversations often lack it). Resolve it at pull time from the best source:
// the conversation itself, else any SIBLING conversation of the same runner in
// the same git_root that did get stamped, else the caller's explicit
// --remote override.
async function resolveRemoteForReparent(
  ctx: { db: any },
  conv: any,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  if (conv.git_remote_url) return conv.git_remote_url;
  if (!conv.git_root) return undefined;
  const siblings = await ctx.db
    .query("conversations")
    .withIndex("by_user_git_root", (q: any) =>
      q.eq("user_id", conv.user_id).eq("git_root", conv.git_root))
    .take(50);
  return siblings.find((s: any) => s.git_remote_url)?.git_remote_url;
}

export async function performReparentSessionToDevice(
  ctx: { db: any },
  userId: Id<"users">,
  args: { session_id: string; device_id: string; remote_url?: string },
): Promise<{ ok: true; command_id: any; device_id: string; label: string; cross_user: boolean }> {
  // Authorization is folded into resolution: the caller must RUN it (user_id),
  // OWN it (owner set / cached primary), or be a HUMAN teammate who can SEE it
  // — see findPullableConversation for the rule and why own sessions always
  // win a colliding short id. Accepts any ref (short id, session UUID, or
  // conversation id) like cast own.
  const conv = await findPullableConversation(ctx, userId, args.session_id);
  if (!conv) {
    throw new Error(
      `No session found for "${args.session_id}" that you run or own, or that is visible to your team`,
    );
  }
  const isRunner = conv.user_id.toString() === userId.toString();

  // The target device must be the CALLER's own — you pull onto your machine.
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
    .first();
  if (!device) throw new Error("Unknown device (you can only reparent onto your own device)");

  const crossUser = !isRunner; // account actually changes hands

  // Facts for the destination's reorientation notice (sessionMoveNotice.ts).
  // The destination composes that notice from what it can verify locally — its
  // own cwd, branch, clone freshness — but it cannot see the machine the
  // session left, and across an account boundary it has no access to it at all.
  // Only the server knows the account changed hands and what to call the user
  // and device it came from, so those facts ride the command. All optional: an
  // older daemon ignores them and simply sends a thinner notice.
  //
  // Read BEFORE the patch below, which overwrites user_id and owner_device_id —
  // these describe where the session came FROM.
  const priorDeviceId: string | undefined = conv.owner_device_id;
  const deviceChanged = !priorDeviceId || priorDeviceId !== args.device_id;
  const priorDevice = priorDeviceId && deviceChanged
    ? await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) =>
          q.eq("user_id", conv.user_id).eq("device_id", priorDeviceId),
        )
        .first()
    : null;
  const nameOf = (u: any): string | undefined => u?.name || u?.email || undefined;
  const fromUser = crossUser ? nameOf(await ctx.db.get(conv.user_id)) : undefined;
  const toUser = crossUser ? nameOf(await ctx.db.get(userId)) : undefined;

  const patch: any = {
    owner_device_id: args.device_id,
    session_error: undefined,
    status: "active" as const,
    updated_at: Date.now(),
  };
  if (crossUser) {
    // Account follows device: the caller now runs + bills it. Pin the author
    // (the pre-move runner) the first time it crosses accounts so it survives.
    if (!conv.author_user_id) patch.author_user_id = conv.user_id;
    patch.user_id = userId;
  }
  await ctx.db.patch(conv._id, patch);

  // Hand over the managed-session row with the conversation. The source
  // machine's daemon keeps heartbeating its row after the move (its tmux pane
  // is still alive), and a fresh cross-account row both hides the session's
  // tmux/liveness from the new runner (the web joins managed rows by the
  // viewer's user_id) and blocks the destination daemon's register behind the
  // cross-user reclaim guard. The reparent is the authoritative handover
  // moment, so drop the stale rows here — the destination daemon inserts its
  // own on resume.
  const staleManaged = new Map<string, any>();
  if (conv.session_id) {
    for (const row of await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", conv.session_id))
      .collect()) staleManaged.set(row._id.toString(), row);
  }
  for (const row of await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .collect()) staleManaged.set(row._id.toString(), row);
  for (const row of staleManaged.values()) await ctx.db.delete(row._id);

  // Resume on the caller's daemon: the command goes in the CALLER's queue
  // (user_id: userId), targeted at their device. A teammate's daemon polls its
  // own user's queue, so this reaches the right machine. The destination daemon
  // resolves its own local checkout (clones if missing) — the source machine's
  // project_path is only a hint. `reparented` marks it so the daemon takes the
  // fresh-machine resume path (clone + transcript from Convex) rather than
  // assuming the local worktree + JSONL already exist.
  const agentType = fromConvexAgentType(conv.agent_type);
  // Resolve the git remote NOW and embed it in the command, so the destination
  // daemon can clone without depending on the conversation's own (often
  // missing) git_remote_url — see resolveRemoteForReparent.
  const remoteUrl = await resolveRemoteForReparent(ctx, conv, args.remote_url);
  const commandId = await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "resume_session" as const,
    args: JSON.stringify({
      session_id: conv.session_id,
      agent_type: agentType,
      conversation_id: conv._id,
      ...(conv.project_path ? { project_path: conv.project_path } : {}),
      ...(remoteUrl ? { git_remote_url: remoteUrl } : {}),
      reparented: true,
      device_changed: deviceChanged,
      ...(priorDevice?.label ? { from_device: priorDevice.label } : {}),
      ...(crossUser ? { cross_user: true } : {}),
      ...(fromUser ? { from_user: fromUser } : {}),
      ...(toUser ? { to_user: toUser } : {}),
    }),
    created_at: Date.now(),
    target_device_id: args.device_id,
  });

  // conv is the pre-patch snapshot, so conv.user_id is the pre-move runner —
  // whose queue the release must land in.
  if (deviceChanged) {
    await releasePreviousOwner(ctx, {
      queueUserId: conv.user_id,
      conversationId: conv._id,
      sessionId: conv.session_id,
      priorDeviceId,
      newDeviceId: args.device_id,
    });
  }

  return { ok: true, command_id: commandId, device_id: args.device_id, label: device.label, cross_user: crossUser };
}

export const reparentSessionToDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    // Any ref: short_id (jx…), Claude session UUID, or conversation _id.
    session_id: v.string(),
    device_id: v.string(),
    // Explicit git remote for the destination clone (cast pull --remote) when
    // neither the conversation nor a sibling has one recorded.
    remote_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performReparentSessionToDevice(ctx, userId, {
      session_id: args.session_id,
      device_id: args.device_id,
      remote_url: args.remote_url,
    });
  },
});

/** List the user's devices (for the web UI + `cast remote hosts`). */
export const listDevices = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    return rows
      .map((d: any) => ({
        device_id: d.device_id,
        label: d.label,
        platform: d.platform,
        hostname: d.hostname ?? undefined,
        ssh_host: d.ssh_host ?? undefined,
        // Bucketed to the minute: every device beats every 30s, and the raw
        // value re-pushed this whole roster — each row carrying a model
        // inventory of several KB. The clients render it as a relative age and
        // already quantize it to the same minute (quantizePresence in the web
        // store), so nothing they show moves. Invalidation is unchanged, and
        // `online` below still reads the raw timestamp.
        last_seen: bucketTs(d.last_seen)!,
        is_remote: d.is_remote ?? false,
        local_project_roots: d.local_project_roots ?? [],
        settings: d.settings ?? undefined,
        model_inventory: d.model_inventory ?? undefined,
        // Managed provider keys (pl-207): the ECDH public key the web seals a key
        // to, and which providers have a key on this device (ids only).
        provider_key_pubkey: d.provider_key_pubkey ?? undefined,
        managed_provider_ids: d.managed_provider_ids ?? [],
        // Git-plane health + the device's public git key (grant-access flow).
        git_plane: d.git_plane ?? undefined,
        git_pubkey: d.git_pubkey ?? undefined,
        // Per-device daemon health (web: useDaemonHealth).
        daemon_started_at: d.daemon_started_at ?? undefined,
        loop_freeze_ms: d.loop_freeze_ms ?? undefined,
        // Rounded again on the way out. The daemon already rounds before it
        // beats, and that is what keeps the row itself from churning; this is
        // the guard for any future writer that sends raw milliseconds, since a
        // moving number here re-renders every viewer's roster.
        loop_freeze_1h_ms:
          d.loop_freeze_1h_ms === undefined ? undefined : Math.round(d.loop_freeze_1h_ms / 5000) * 5000,
        loop_freeze_max_ms: d.loop_freeze_max_ms ?? undefined,
        loop_freeze_top: d.loop_freeze_top ?? undefined,
        pending_sync_count: d.pending_sync_count ?? undefined,
        oldest_pending_ms: d.oldest_pending_ms ?? undefined,
        pending_sync_messages: d.pending_sync_messages ?? undefined,
        pending_sync_conversations: d.pending_sync_conversations ?? undefined,
        online: now - d.last_seen < DEVICE_ONLINE_MS,
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
/**
 * Which machine a conversation's agent actually runs on, for the attach pill.
 *
 * Deliberately its own query rather than a field on the inbox row: `last_seen`
 * is rewritten on every heartbeat, so reading the devices table inside
 * enrichInboxSessionRow would re-invalidate the entire inbox subscription every
 * beat — precisely the cost the INBOX_LIVENESS_FIELDS split exists to avoid.
 * One open conversation reads one device. The returned shape holds no
 * heartbeat-varying field, so Convex's result-diffing means the routine beats
 * re-execute this and push nothing.
 *
 * `ssh_host` is returned ONLY for the viewer's own machines. A session running
 * on a teammate's box (a second-party-owned row: conv.user_id is the running
 * account, not the viewer) resolves to a name and nothing else, so the UI
 * cannot offer an attach command for a machine the viewer may not reach. That
 * guarantee lives here, not in the component.
 */
/**
 * The device a conversation's agent runs on, looked up under the account whose
 * daemon stamped it (conv.user_id): that pair is exactly the by_user_device
 * index, so no device_id-only index is needed, and a legacy cloned device id
 * under another user can't shadow the real machine.
 */
async function runnerDeviceOf(ctx: { db: any }, conv: any) {
  const deviceId = conv.owner_device_id as string | undefined;
  if (!deviceId) return null;
  return await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) =>
      q.eq("user_id", conv.user_id).eq("device_id", deviceId),
    )
    .first();
}

/**
 * May the viewer treat the machine a conversation runs on as their own — for
 * the attach command, the terminal split and the pane relay? Two ways in:
 *
 *   - the viewer runs the session (conv.user_id), so the device is theirs;
 *   - the session runs under a BOT account's daemon — an agent box, like the
 *     team's Mac mini that Mr Bot signs into — and the viewer owns the session
 *     and belongs to the bot's team.
 *
 * A teammate's machine stays out of reach: relaying a pane means writing into
 * the device owner's daemon queue, which for a person is a real boundary. A bot
 * has no person behind it; its daemon exists to run the team's sessions, and
 * the owner of one of those sessions is exactly who it runs them for.
 *
 * Returns the device row and the account whose daemon queue and frame rows the
 * device answers under (the runner), or null when the machine is genuinely
 * someone else's. Exported so the relay (terminalStream.ts) applies the same
 * rule as the pill: one predicate, never two that drift.
 */
export async function resolveReachableRunnerDevice(
  ctx: { db: any },
  userId: Id<"users">,
  conv: any,
): Promise<{ device: any; runnerUserId: Id<"users">; via_bot: boolean } | null> {
  const device = await runnerDeviceOf(ctx, conv);
  if (!device) return null;
  if (conv.user_id.toString() === userId.toString()) {
    return { device, runnerUserId: userId, via_bot: false };
  }
  const runner = await ctx.db.get(conv.user_id);
  if (!runner?.is_bot || !runner.team_id) return null;
  const owns =
    conv.owner_user_id?.toString() === userId.toString() ||
    (await isSessionOwner(ctx, conv._id, userId));
  if (!owns) return null;
  if (!(await isTeamMember(ctx, userId, runner.team_id))) return null;
  return { device, runnerUserId: conv.user_id, via_bot: true };
}

export const getConversationMachine = query({
  args: { conversation_id: v.id("conversations"), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    if (!(await canAccessConversation(ctx, userId, conv))) return null;

    const device = await runnerDeviceOf(ctx, conv);
    if (!device) return null;

    const reach = await resolveReachableRunnerDevice(ctx, userId, conv);
    return {
      device_id: device.device_id,
      label: device.label,
      platform: device.platform,
      is_remote: device.is_remote ?? false,
      // "Yours" in the sense that matters here: a command or a relay from you
      // can reach it. True for your own machines and for an agent box running
      // a session you own.
      is_mine: !!reach,
      // The pane lives under the bot's daemon, not a daemon you can reach on
      // loopback — so the split should relay straight away instead of
      // discovering first.
      via_bot: reach?.via_bot ?? false,
      ssh_host: reach ? (device.ssh_host ?? null) : null,
    };
  },
});

/** Longest ssh target we accept — comfortably fits "user@some.long.host.name". */
const MAX_SSH_HOST_LENGTH = 128;

/**
 * Validate an SSH target, or return null for "no target".
 *
 * This string is concatenated into a shell command the user is invited to copy
 * and paste into their own terminal, so an ALLOWLIST is the only safe policy:
 * a blocklist of `;`/`$`/backtick/quote would still let through newlines,
 * `&&`, `|`, `<(…)` and the rest. Everything a real ssh target needs —
 * `user@host`, `host.example.com`, an IPv4/IPv6 literal, a `~/.ssh/config`
 * alias, an optional `:port` — is covered by letters, digits, and
 * `. - _ @ : [ ]`. Nothing in that set can end an argument or start a new
 * command, so the copied line means exactly what it reads as.
 *
 * Exported for direct unit testing: this is the only thing standing between a
 * hand-typed settings field and a command the user runs without reading.
 */
export function sanitizeSshHost(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SSH_HOST_LENGTH) return null;
  if (!/^[A-Za-z0-9._@:\-[\]]+$/.test(trimmed)) return null;
  // A leading "-" would be read by ssh as a flag rather than a destination.
  if (trimmed.startsWith("-")) return null;
  return trimmed;
}

/**
 * The agent boxes the viewer can reach: devices whose daemon signs in as a bot
 * account on one of the viewer's teams (Settings → Devices lists them under
 * their own heading, with the SSH host editable by a team admin). Display
 * fields only — the same projection getConversationMachine hands out.
 */
export const listAgentBoxes = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const now = Date.now();
    const out: Array<{
      device_id: string;
      owner_user_id: Id<"users">;
      bot_name: string | null;
      team_id: Id<"teams">;
      can_edit: boolean;
      label: string;
      hostname: string | undefined;
      platform: string;
      is_remote: boolean;
      ssh_host: string | undefined;
      online: boolean;
      last_seen: number;
    }> = [];
    for (const m of memberships) {
      const bots = await ctx.db
        .query("users")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id))
        .collect();
      for (const bot of bots) {
        if (!(bot as any).is_bot) continue;
        const devices = await ctx.db
          .query("devices")
          .withIndex("by_user_id", (q: any) => q.eq("user_id", bot._id))
          .collect();
        for (const d of devices) {
          out.push({
            device_id: d.device_id,
            owner_user_id: bot._id,
            bot_name: (bot as any).name ?? null,
            team_id: m.team_id,
            can_edit: m.role === "admin",
            label: d.label,
            hostname: d.hostname ?? undefined,
            platform: d.platform,
            is_remote: d.is_remote ?? false,
            ssh_host: d.ssh_host ?? undefined,
            online: now - d.last_seen < DEVICE_ONLINE_MS,
            last_seen: bucketTs(d.last_seen)!,
          });
        }
      }
    }
    return out.sort((a, b) => b.last_seen - a.last_seen);
  },
});

/**
 * Set (or clear, with an empty string) how to reach a device over SSH. Web-set
 * only — an ssh alias resolves against the viewer's ~/.ssh/config, which the
 * daemon on the target machine has no way to know. Scoped to the caller's own
 * devices by the by_user_device lookup, so nobody can annotate a teammate's
 * machine with an ssh target that then gets rendered as copyable.
 */
export const setDeviceSshHost = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    ssh_host: v.string(),
    // An agent box: the device belongs to a bot account, which has no settings
    // page of its own, so an admin of the bot's team annotates it instead.
    owner_user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const ownerId = args.owner_user_id ?? userId;
    if (ownerId.toString() !== userId.toString()) {
      const owner = await ctx.db.get(ownerId);
      if (!owner?.is_bot || !owner.team_id || !(await isTeamAdmin(ctx, userId, owner.team_id))) {
        throw new Error("Only an admin of the bot's team can set an agent box's SSH host");
      }
    }
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", ownerId).eq("device_id", args.device_id))
      .first();
    if (!device) throw new Error("Unknown device");

    const cleaned = sanitizeSshHost(args.ssh_host);
    // Distinguish "cleared" from "rejected": an empty input means the user wants
    // no target (a legitimate state — the pill falls back to a bare attach),
    // whereas a non-empty input that failed validation is a typo worth surfacing.
    if (cleaned === null && args.ssh_host.trim()) {
      throw new Error(
        "Invalid SSH host. Use letters, digits, and . - _ @ : only — e.g. \"nose\" or \"m1@10.0.0.4\".",
      );
    }
    await ctx.db.patch(device._id, { ssh_host: cleaned ?? undefined });
    return { ssh_host: cleaned };
  },
});

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
 * Web set/removed a managed provider API key for a device (pl-207). For "set" the
 * key arrives already SEALED to the device's ECDH public key (the web read
 * provider_key_pubkey from listDevices and encrypted with Web Crypto) — Convex only
 * ever holds this ciphertext, transiently, until the daemon consumes the command.
 * Routes a `set_provider_key` command to the device, which decrypts, stores, and
 * fans out to remotes. Optimistically mirrors managed_provider_ids so the UI
 * reflects the change immediately; the heartbeat reconciles to the device's truth.
 */
export const enqueueProviderKeyCommand = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    op: v.union(v.literal("set"), v.literal("remove")),
    provider: v.string(),
    // Present for "set" — the encrypted payload from Web Crypto.
    payload: v.optional(v.object({
      provider: v.string(),
      epk: v.string(),
      iv: v.string(),
      ct: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!device) throw new Error("Unknown device");
    if (args.op === "set" && !args.payload) throw new Error("set requires an encrypted payload");

    const commandArgs = args.op === "set"
      ? { op: "set", payload: args.payload }
      : { op: "remove", provider: args.provider };
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "set_provider_key" as const,
      args: JSON.stringify(commandArgs),
      created_at: Date.now(),
      target_device_id: args.device_id,
    });

    // Optimistic mirror of the id list (never the key) — reconciled by heartbeat.
    const prev: string[] = (device as any).managed_provider_ids ?? [];
    const next = args.op === "set"
      ? Array.from(new Set([...prev, args.provider])).sort()
      : prev.filter((p) => p !== args.provider);
    await ctx.db.patch(device._id, { managed_provider_ids: next });

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

/**
 * Resolve the device a conversation RUNS ON for display, across account
 * boundaries. `listDevices` is strictly per-user, so a session owned by
 * another account's machine (e.g. the shared agent box: its daemon
 * authenticates as the bot account while the session is assigned to a
 * founder) rendered as "Unassigned" in the web pill even though it has an
 * owner device. Access is gated on the CONVERSATION (checkConversationAccess)
 * — never on device ownership — and only display fields are returned. The
 * device row is looked up under the conversation's RUNNER account
 * (conv.user_id): the daemon that stamped owner_device_id authenticates as
 * that account, so legacy shared/cloned device ids under other users can't
 * shadow the real machine.
 */
export const ownerDeviceDisplay = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    // Owner/team ONLY — deliberately NOT `!== "denied"`. checkConversationAccess
    // grants "shared" on the mere EXISTENCE of a share_token (privacy.ts) without
    // the caller presenting it, so a `!== "denied"` gate would hand any
    // authenticated user who learns a share-linked conversation's id this
    // cross-account device projection (hostname via label, liveness). The pill
    // this feeds only renders for owners, so the strict gate costs nothing.
    const access = await checkConversationAccess(ctx, userId, conv as any);
    if (access !== "owner" && access !== "team") return null;
    const ownerDeviceId = (conv as any).owner_device_id as string | undefined;
    if (!ownerDeviceId) return null;
    const row = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) =>
        q.eq("user_id", (conv as any).user_id).eq("device_id", ownerDeviceId),
      )
      .first();
    if (!row) return null;
    // This projection CROSSES ACCOUNTS — it reads the conversation owner's device
    // row. Never add `last_input_at` or anything derived from it here: that field
    // is when a HUMAN last touched the keyboard, a different category from the
    // machine liveness this returns, and it is currently readable only by its
    // own owner (pushRouter.readPresence). `last_seen` is bucketed to the hour —
    // the UI renders "online" or a coarse "3h ago", and a precise cross-account
    // heartbeat timestamp is a tracking primitive we don't want to mint.
    //
    // The runner identity (whose account the daemon authenticates as) lets the
    // UI say "agent box" vs "<name>'s machine" instead of a flat "shared" —
    // owner/team viewers are exactly who OwnersBadge already shows names to.
    const runnerUser = await ctx.db.get((conv as any).user_id);
    const runner = runnerUser
      ? {
          name: (runnerUser as any).name ?? null,
          is_bot: (runnerUser as any).is_bot ?? false,
        }
      : null;
    const HOUR_MS = 60 * 60 * 1000;
    return {
      device_id: row.device_id,
      label: row.label,
      platform: row.platform,
      is_remote: row.is_remote ?? false,
      last_seen: Math.floor(row.last_seen / HOUR_MS) * HOUR_MS,
      online: Date.now() - row.last_seen < DEVICE_ONLINE_MS,
      is_mine: row.user_id.toString() === userId.toString(),
      runner,
    };
  },
});
