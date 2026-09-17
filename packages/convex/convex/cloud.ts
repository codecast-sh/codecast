/**
 * Sessions on the cloud host: placement, wake requests, and the web's handoff
 * to a local daemon.
 *
 * A cloud session is an ordinary session whose owner device is the remote
 * Linux box and whose project path is an isolated worktree on that box. The
 * laptop prepares the host over SSH (wake, refresh the checkout, copy the
 * manifest's secret files, `cast ws acquire` there) and then places the row
 * here; from that point every existing rail — start_session routing, pending
 * message delivery, resume on wake — treats it like any other device.
 */

import { action, internalQuery, mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { internal } from "./_generated/api";
import { grantsContentsWrite, installationForRepo } from "./githubApp";
import { Id } from "./_generated/dataModel";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { scheduleCloudWake, serverOwnsCloudWake } from "./cloudWake";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage } from "./pendingMessages";
import { releasePreviousOwner } from "./sessionRelease";
import { checkoutInUseMessage, fromConvexAgentType, isHttpOrigin, parseOwnerRepo, type CloudWorkspaceMode } from "@codecast/shared/contracts";
import { cloudSeedArg, cloudWorkspaceValidator, findSharedCheckoutOccupant } from "./cloudPlacement";

// The park/prepare logic moved to cloudPlacement.ts (a leaf every creator can
// import); re-exported here for older importers.
export { enqueueCloudSpawn } from "./cloudPlacement";

// The occupancy lookup, the mode validator and the seed validators live in
// cloudPlacement.ts (the leaf devices.ts / conversations.ts / dispatch.ts /
// spawn.ts import); this module re-exports them beside the mutations that
// use them.
export { cloudSeedArg, cloudStartFromArg, cloudWorkspaceValidator, findSharedCheckoutOccupant } from "./cloudPlacement";

async function getAuthenticatedUserId(ctx: { db: any }, apiToken?: string): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

type WakeableDevice = {
  user_id?: string;
  device_id: string;
  label?: string;
  last_seen: number;
  is_remote?: boolean;
  wake_requested_at?: number;
};

/**
 * Remote devices that are asleep with work waiting: a wake stamp newer than
 * their last heartbeat. Pure, so the heartbeat can call it per beat and the
 * rule is unit-testable. A stamp older than the last beat was answered by that
 * beat (the device came up and the stamp is cleared there as well).
 */
export function wakeDevicesFor(
  devices: WakeableDevice[],
  now: number,
): Array<{ device_id: string; label: string | null }> {
  return devices
    .filter(
      (d) =>
        d.is_remote === true &&
        !serverOwnsCloudWake(d.user_id ?? "", d.device_id) &&
        typeof d.wake_requested_at === "number" &&
        d.wake_requested_at > d.last_seen &&
        now - d.last_seen >= DEVICE_ONLINE_MS,
    )
    .map((d) => ({ device_id: d.device_id, label: d.label ?? null }));
}

/**
 * Work was queued for a conversation. If its owner is a remote device that is
 * offline — a cloud host that powered itself off — retain wake intent until
 * its next heartbeat. Returns whether a wake is pending.
 * Never stamps a local device: nothing can open a closed laptop.
 */
export async function requestRemoteWake(ctx: { db: any; scheduler?: { runAfter(delay: number, fn: any, args: any): Promise<unknown> } }, conversation: any): Promise<boolean> {
  const owner = conversation?.owner_device_id as string | undefined;
  if (!owner) return false;
  // A row still waiting for a laptop to prepare the host has nothing for the
  // host to do yet: its pending first message is the laptop's work, and
  // `cast cloud start` wakes the box itself (ensureUp).
  if (conversation?.cloud_placement === "pending") return false;
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", conversation.user_id).eq("device_id", owner))
    .first();
  if (!device?.is_remote) return false;
  const now = Date.now();
  const pending = typeof device.wake_requested_at === "number" && device.wake_requested_at > device.last_seen;
  const retryFailed = device.cloud_wake?.status === "failed" && serverOwnsCloudWake(device.user_id, device.device_id);
  const requestAt = pending && !retryFailed ? device.wake_requested_at : Math.max(now, device.last_seen + 1, (device.wake_requested_at ?? 0) + 1);
  if (requestAt !== device.wake_requested_at) await ctx.db.patch(device._id, { wake_requested_at: requestAt });
  await scheduleCloudWake(ctx, device, requestAt);
  return true;
}

/**
 * Place a conversation on the cloud host: the worktree the laptop just
 * acquired there becomes its project path, the host's device its owner, and
 * (for a spawn) the ordinary start_session is routed at that device. Forks
 * and web rows that already carry their first messages pass start=false /
 * true respectively; the seed prompt of a CLI spawn rides `prompt` so it is
 * enqueued only once the row can actually receive it.
 */
export const placeConversation = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    device_id: v.string(),
    project_path: v.string(),
    git_root: v.optional(v.string()),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    worktree_path: v.optional(v.string()),
    start: v.boolean(),
    prompt: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    cc_account: v.optional(v.string()),
    // The token the park stamped (placementTarget.cloud_placement_token). When
    // given, placement is fenced: a row no longer pending, or re-parked since
    // (different token), is refused with placed:false so a late child cannot
    // drag a re-pointed row back. Absent = the unfenced placement older
    // laptops perform.
    expect_token: v.optional(v.string()),
    // Where the session runs on the host. Absent: the row's own stamp, else
    // isolated when a worktree is named. A SHARED placement must follow a
    // claim (claimSharedCheckout) on the same path and is re-checked here
    // against every other alive row (exclude-self), so a placement that lost
    // the race is refused before the start is queued.
    cloud_workspace: v.optional(cloudWorkspaceValidator),
    // What the worktree started from (the laptop checkout's branch/HEAD/dirty
    // state, or origin/main with the reason for an automatic downgrade).
    // Stamped as cloud_seed with the placement time; absent from old CLIs.
    seed: v.optional(cloudSeedArg),
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
    if (!device) throw new Error(`Unknown device ${args.device_id}`);

    const fence = placementFence(conv, args.expect_token);
    if (fence) return { placed: false as const, reason: fence, command_id: null, owner_device_id: conv.owner_device_id ?? null };
    const priorOwner: string | undefined = conv.owner_device_id;
    const mode: CloudWorkspaceMode | undefined = args.cloud_workspace
      ?? (conv.cloud_workspace as CloudWorkspaceMode | undefined)
      ?? (args.worktree_name ? "isolated" : undefined);
    if (mode === "shared") {
      if (conv.cloud_checkout_path !== args.project_path) {
        throw new Error(`place after claimSharedCheckout: the row claimed ${conv.cloud_checkout_path ?? "no checkout"}, not ${args.project_path}`);
      }
      const occupant = await findSharedCheckoutOccupant(ctx, userId, args.device_id, { projectPath: args.project_path, excludeId: args.conversation_id.toString() });
      if (occupant) throw new Error(checkoutInUseMessage(args.project_path, occupant));
    }

    await ctx.db.patch(args.conversation_id, {
      owner_device_id: args.device_id,
      project_path: args.project_path,
      git_root: args.git_root ?? args.project_path,
      ...(args.worktree_name ? { worktree_name: args.worktree_name } : {}),
      ...(args.worktree_branch ? { worktree_branch: args.worktree_branch } : {}),
      ...(args.worktree_path ? { worktree_path: args.worktree_path, worktree_status: "active" as const } : {}),
      ...(mode ? { cloud_workspace: mode } : {}),
      // Only a shared row holds the checkout; an isolated placement after a
      // failed shared attempt must not keep attributing the root to itself.
      ...(mode && mode !== "shared" ? { cloud_checkout_path: undefined } : {}),
      ...(args.seed ? { cloud_seed: { ...args.seed, at: Date.now() } } : {}),
      cloud_placement: undefined,
      cloud_placement_token: undefined,
      cloud_placement_failed_at: undefined,
      session_error: undefined,
      updated_at: Date.now(),
    });
    // The row was owned by another machine before the park (a laptop-owned
    // eager row toggled to the cloud): tell it to tear its copy down.
    if (priorOwner && priorOwner !== args.device_id) {
      await releasePreviousOwner(ctx, {
        queueUserId: userId,
        conversationId: args.conversation_id,
        sessionId: conv.session_id,
        priorDeviceId: priorOwner,
        newDeviceId: args.device_id,
      });
    }

    let commandId: Id<"daemon_commands"> | null = null;
    if (args.start) {
      commandId = await enqueueStartSession(ctx, userId, {
        conversationId: args.conversation_id,
        agentType: fromConvexAgentType(conv.agent_type),
        projectPath: args.project_path,
        gitRoot: args.git_root ?? args.project_path,
        sessionId: conv.session_id,
        model: args.model,
        effort: args.effort,
        ccAccount: args.cc_account,
        targetDeviceId: args.device_id,
      });
    }
    const prompt = (args.prompt ?? "").trim();
    if (prompt) {
      const placed = await ctx.db.get(args.conversation_id);
      await enqueuePendingMessage(ctx, placed, userId, { content: prompt });
    }
    return { placed: true as const, command_id: commandId, owner_device_id: args.device_id };
  },
});

/**
 * Claim the host's main checkout for a parked row BEFORE the laptop touches
 * it. `cast cloud start --workspace shared` runs this right after the wake and
 * before any ssh mutation: two racing shared placements cannot both move the
 * root's HEAD, because the loser is refused here with the winner's short id.
 * Fenced like placeConversation (expect_token): a superseded child never gets
 * to claim. Re-claiming the same row (a retry after a failed preparation)
 * is allowed and clears its session_error.
 */
export const claimSharedCheckout = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    device_id: v.string(),
    /** The host's main checkout (the occupancy key). */
    project_path: v.string(),
    expect_token: v.optional(v.string()),
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
    if (!device) throw new Error(`Unknown device ${args.device_id}`);
    if (conv.cloud_placement !== "pending") return { claimed: false as const, reason: "not_pending" as const };
    const fence = placementFence(conv, args.expect_token);
    if (fence) return { claimed: false as const, reason: fence };
    const occupant = await findSharedCheckoutOccupant(ctx, userId, args.device_id, { projectPath: args.project_path, excludeId: args.conversation_id.toString() });
    if (occupant) throw new Error(checkoutInUseMessage(args.project_path, occupant));
    await ctx.db.patch(args.conversation_id, {
      cloud_workspace: "shared" as const,
      cloud_checkout_path: args.project_path,
      owner_device_id: args.device_id,
      session_error: undefined,
      updated_at: Date.now(),
    });
    return { claimed: true as const };
  },
});

/**
 * Why a fenced placement must be refused, or null to proceed. Pure, so the
 * park→un-park→park race is testable: two children both see "pending", but
 * only the one holding the CURRENT token may place.
 */
export function placementFence(
  conv: { cloud_placement?: string | null; cloud_placement_token?: string | null },
  expectToken: string | undefined,
): "not_pending" | "superseded" | null {
  if (expectToken === undefined) return null;
  if (conv.cloud_placement !== "pending") return "not_pending";
  if (conv.cloud_placement_token !== expectToken) return "superseded";
  return null;
}

/**
 * The laptop's `cast cloud start` for a park failed: record it on the row.
 *
 * Fenced by the park's token, exactly like placeConversation. A child that
 * lost the race — the row was re-parked, re-pointed at a laptop, or another
 * laptop already placed it — reports a failure about a park that is over, and
 * that report must not show on the card or count against the new park. It is
 * ignored, not applied.
 *
 * The stamp is what stops the retry loop: a failed park is not re-issued by
 * the heartbeat when a laptop comes online (reissueStrandedCloudSpawns), so a
 * host that cannot be prepared is woken once, not once per laptop wake.
 */
export const reportPlacementFailure = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    /** The park token the child read from its command args. */
    placement_token: v.optional(v.string()),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) return { recorded: false as const, reason: "not_yours" };
    const fence = placementFence(conv, args.placement_token);
    if (fence) return { recorded: false as const, reason: fence };
    await ctx.db.patch(args.conversation_id, {
      session_error: args.error,
      cloud_placement_failed_at: Date.now(),
      updated_at: Date.now(),
    });
    return { recorded: true as const };
  },
});

/**
 * What `cast cloud start <conversation>` (the daemon's child for a web
 * "run in the cloud") needs to know about the row it is placing.
 */
export const placementTarget = query({
  args: { api_token: v.optional(v.string()), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) return null;
    return {
      project_path: conv.project_path ?? null,
      git_root: conv.git_root ?? null,
      agent_type: conv.agent_type ?? null,
      owner_device_id: conv.owner_device_id ?? null,
      cloud_placement: (conv as any).cloud_placement ?? null,
      cloud_placement_token: (conv as any).cloud_placement_token ?? null,
      cloud_workspace: (conv as any).cloud_workspace ?? null,
      cloud_checkout_path: (conv as any).cloud_checkout_path ?? null,
      cloud_start_from: (conv as any).cloud_start_from ?? null,
      git_remote_url: conv.git_remote_url ?? null,
      worktree_name: conv.worktree_name ?? null,
      model: conv.model ?? null,
      effort: (conv as any).effort ?? null,
      cc_account: (conv as any).cc_account ?? null,
    };
  },
});

/**
 * The sessions a device runs right now, for `cast hosts ls` and the laptop's
 * shared-checkout pre-flight (cloud/prepare.ts fetchRootOccupant): every
 * conversation the device owns that the user has not killed. Worktree names
 * and the workspace mode ride along so the host list can show what each
 * worktree — or the main checkout — is for.
 */
export const hostSessions = query({
  args: { api_token: v.optional(v.string()), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const owned = await ctx.db
      .query("conversations")
      .withIndex("by_owner_device", (q: any) => q.eq("user_id", userId).eq("owner_device_id", args.device_id))
      .collect();
    return owned
      .filter((c: any) => !c.inbox_killed_at && c.status !== "completed")
      .map((c: any) => ({
        conversation_id: c._id,
        short_id: c.short_id ?? c._id.toString().slice(0, 7),
        title: c.title ?? null,
        status: c.status ?? null,
        work_state: c.work_state ?? null,
        project_path: c.project_path ?? null,
        worktree_name: c.worktree_name ?? null,
        worktree_branch: c.worktree_branch ?? null,
        cloud_workspace: c.cloud_workspace ?? null,
        cloud_placement: c.cloud_placement ?? null,
        cloud_checkout_path: c.cloud_checkout_path ?? null,
        // A boolean, never the text: the occupancy rule only asks whether a
        // pending shared row failed, and the message may quote paths.
        session_error: !!c.session_error,
        cloud_seed: c.cloud_seed
          ? { source: c.cloud_seed.source, base: c.cloud_seed.base, branch: c.cloud_seed.branch ?? null, dirty: c.cloud_seed.dirty ?? null, device_id: c.cloud_seed.device_id ?? null, reason: c.cloud_seed.reason ?? null }
          : null,
        updated_at: c.updated_at ?? null,
      }))
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  },
});

// ---------------------------------------------------------------------------
// Browser logins on the host: `cast browser sync <site>` from a cloud session
// ---------------------------------------------------------------------------

type CarrierDevice = { device_id: string; is_remote?: boolean; last_seen: number; label?: string };

/**
 * The laptop that carries a login into the host's browser: the most recently
 * seen ONLINE local device, or the one named by `via` — and then ONLY when it
 * is online and local (never a fallback). Pure, and deliberately separate
 * from enqueueCloudSpawn's preparer ladder: that one may park a row on an
 * offline laptop to be re-issued when it wakes, which for a cookie carry
 * would inject logins an hour after the host CLI gave up on them.
 */
export function pickOnlineLocalDevice(
  devices: CarrierDevice[],
  now: number,
  via?: string,
): { device_id: string; label: string | null } | null {
  const online = devices.filter((d) => !d.is_remote && now - d.last_seen < DEVICE_ONLINE_MS);
  const pick = via ? online.find((d) => d.device_id === via) : [...online].sort((a, b) => b.last_seen - a.last_seen)[0];
  return pick ? { device_id: pick.device_id, label: pick.label ?? null } : null;
}

/** Unanswered carry requests one user may have waiting at a time, counted over the window below. */
export const BROWSER_SYNC_PENDING_CAP = 5;
const BROWSER_SYNC_WINDOW_MS = 5 * 60 * 1000;

/**
 * A cloud session asks the owner's laptop to carry a browser login into the
 * host's Chrome. The row carries ids, a loopback port, an ORIGIN and a flag —
 * never a URL (its query can hold tokens) and never a cookie: the cookies
 * travel laptop -> host inside an SSH port forward (cloud/browserSync.ts).
 * Authorization is the host device: it must be an is_remote device of the
 * caller, so a teammate's laptop never sees the row and cannot place one.
 * Refused outright when no laptop is online — a carry is never parked.
 */
export const requestBrowserSync = mutation({
  args: {
    api_token: v.optional(v.string()),
    /** The cloud host's device id (the requester). */
    device_id: v.string(),
    /** The host Chrome's loopback CDP port. */
    cdp_port: v.number(),
    /** Exactly one of: the site origin, or `all` for the whole jar. */
    origin: v.optional(v.string()),
    all: v.optional(v.boolean()),
    /** Attribution only; must be the caller's row. Dropped (not refused) when it does not run on device_id. */
    conversation_id: v.optional(v.id("conversations")),
    /** Carry via this laptop instead of the most recently seen one. */
    via_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const host = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (!host || host.is_remote !== true) throw new Error(`device ${args.device_id.slice(0, 8)} is not a cloud host of yours`);
    if (!Number.isInteger(args.cdp_port) || args.cdp_port < 1 || args.cdp_port > 65535) throw new Error(`cdp_port ${args.cdp_port} is not a port`);
    const origin = args.origin;
    if ((origin === undefined) === !args.all) throw new Error("name exactly one of: origin, all");
    if (origin !== undefined && !isHttpOrigin(origin)) throw new Error(`${origin} is not an http(s) origin (scheme + host only)`);
    // The id is attribution, never authorization (the host device is). A
    // conversation that moved off the host, or an id inherited from another
    // session's shell, must not block the carry: keep the ownership check and
    // drop the id when the row does not run on this host.
    let conversationId = args.conversation_id;
    if (conversationId) {
      const conv = await ctx.db.get(conversationId);
      if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
      if (conv.owner_device_id !== args.device_id) conversationId = undefined;
    }
    const now = Date.now();
    // A cap on requests the laptop has not answered yet: every carry opens an
    // ssh forward, and a looping session on the host must not queue them.
    const unanswered = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined))
      .filter((q: any) => q.and(q.eq(q.field("command"), "cloud_browser_sync"), q.gt(q.field("created_at"), now - BROWSER_SYNC_WINDOW_MS)))
      .take(BROWSER_SYNC_PENDING_CAP);
    if (unanswered.length >= BROWSER_SYNC_PENDING_CAP) {
      throw new Error(`${BROWSER_SYNC_PENDING_CAP} browser sync requests are already waiting for your laptop — wait for them to finish and retry`);
    }
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const preparer = pickOnlineLocalDevice(devices, now, args.via_device_id);
    if (!preparer) {
      throw new Error(
        args.via_device_id
          ? `device ${args.via_device_id.slice(0, 8)} is not one of your online laptops`
          : "No online laptop can carry your logins — start the codecast daemon on your laptop (or wake it) and retry",
      );
    }
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "cloud_browser_sync" as const,
      args: JSON.stringify({
        host_device_id: args.device_id,
        cdp_port: args.cdp_port,
        origin: origin ?? null,
        all: !!args.all,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
      created_at: now,
      target_device_id: preparer.device_id,
    });
    return { command_id: commandId, device_id: preparer.device_id, label: preparer.label };
  },
});

/**
 * The outcome of one browser-sync request, for the host CLI's poll. The
 * host authenticates with its api token (users.getCommandResult is session
 * only), and the query exposes only this feature's rows.
 */
export const commandOutcome = query({
  args: { api_token: v.optional(v.string()), command_id: v.id("daemon_commands") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const cmd = await ctx.db.get(args.command_id);
    if (!cmd || cmd.user_id.toString() !== userId.toString() || cmd.command !== "cloud_browser_sync") return null;
    return {
      executed_at: cmd.executed_at ?? null,
      result: cmd.result ?? null,
      error: cmd.error ?? null,
      claimed_device: cmd.claimed_device ?? null,
      target_device_id: cmd.target_device_id ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Git push access from the host: a GitHub App installation token
// ---------------------------------------------------------------------------

/**
 * What the host's git credential helper prints, or why it cannot.
 *
 * A cloud host has no GitHub credential of its own until a human grants its
 * device key on GitHub. The codecast GitHub App is already installed on the
 * repositories these sessions work in, and an installation token pushes over
 * https, so the host can ask for one per fetch and per push instead. The
 * token is short lived (GitHub expires it within the hour), is scoped to the
 * installation's repositories, and is never stored on the host: `cast
 * git-credential` prints it to git on stdout and exits.
 */
export type HostGitCredential = {
  username: "x-access-token";
  password: string;
  expires_at: number;
  installation_id: number;
};

export type HostGitCredentialRefusal = { reason: string };

/**
 * The installation whose token lets `device_id` push `repository`, or the
 * reason it cannot have one.
 *
 * Two questions, both of them the caller's own: is this device a cloud host of
 * theirs (an is_remote device — a laptop has the human's own credentials and
 * needs none of this), and does a GitHub App installation THEY can reach cover
 * that repository. The second is githubApp.installationForRepo, the same rule
 * issue sync and the PR paths resolve through.
 *
 * That rule alone is wider than a push credential may be. A team's
 * installation covers every repository the team installed the app on, and any
 * member of that team reaches it here, including one who cannot push to the
 * repository on GitHub. So this answer carries `personal`: true when the
 * installation is the caller's OWN, and false when it is a team's. The action
 * mints on a personal installation at once, and on a team's only after GitHub
 * itself says this person may push (hostGitCredential).
 */
export async function hostGitInstallationFor(
  ctx: { db: any; auth?: any },
  userId: Id<"users">,
  args: { device_id: string; repository: string; host?: string },
): Promise<{ installation_id: number; account_login: string; personal: boolean; repository: string } | HostGitCredentialRefusal> {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
    .first();
  if (!device || device.is_remote !== true) {
    return { reason: `device ${args.device_id.slice(0, 8)} is not a cloud host of yours` };
  }
  if (args.host !== undefined && args.host !== "github.com") {
    return { reason: `${args.host} is not github.com — the codecast app only holds GitHub credentials` };
  }
  const repository = parseOwnerRepo(args.repository);
  if (!repository) return { reason: `${args.repository} is not an owner/name repository` };
  const installation = await installationForRepo(ctx as any, { repository, user_id: userId });
  if (!installation) {
    return {
      reason:
        `the codecast GitHub App is not installed on ${repository} for you — install it on that repository ` +
        `(codecast settings, integrations), or grant this host's device key: cast hosts key`,
    };
  }
  return {
    installation_id: installation.installation_id,
    account_login: installation.account_login,
    personal: !!installation.scope_user_id && String(installation.scope_user_id) === String(userId),
    repository,
  };
}

/** The wire spelling of the rule above; the action below is its only caller. */
export const hostGitInstallation = internalQuery({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    repository: v.string(),
    host: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<HostGitInstallationAnswer | HostGitCredentialRefusal> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const resolved = await hostGitInstallationFor(ctx, userId, args);
    if ("reason" in resolved) return resolved;
    // The caller's own GitHub credential, so the action can ask GitHub whether
    // this person may push. Internal only: it never leaves the server.
    const user = await ctx.db.get(userId);
    return {
      ...resolved,
      viewer_github_token: user?.github_access_token ?? null,
      viewer_github_login: user?.github_username ?? null,
    };
  },
});

export type HostGitInstallationAnswer = {
  installation_id: number;
  account_login: string;
  personal: boolean;
  repository: string;
  viewer_github_token: string | null;
  viewer_github_login: string | null;
};

/**
 * Does GitHub say the owner of `token` may push to `repository`? A repository
 * read with the person's own OAuth token answers it: `permissions.push` is
 * what GitHub grants THEM, whatever the installation covers. null when the
 * question could not be asked (no token, GitHub unreachable), which the caller
 * treats as a refusal.
 */
export async function viewerCanPush(
  repository: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  if (!token) return null;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repository}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return r.status === 403 || r.status === 404 ? false : null;
    const body: any = await r.json();
    return body?.permissions?.push === true;
  } catch {
    return null;
  }
}

/**
 * The credential `cast git-credential` prints on the host: the username and
 * password of a GitHub App installation token for one repository.
 *
 * The token is minted through githubApp.getInstallationToken, which is the one
 * mint path and holds the shared cache (github_installation_tokens), so a host
 * fetching every minute costs GitHub one token an hour. It is minted for the
 * ONE repository git asked about and for push access only, so what leaks if
 * the host is compromised is a push to that repository, not to every
 * repository the installation covers. It is returned and never logged:
 * nothing here prints it, and the CLI writes it only to git's stdin protocol.
 *
 * What this does NOT narrow: anyone holding the caller's api_token can ask for
 * any repository the caller's OWN installations cover, one repository at a
 * time. A team's installation is wider than one person's access, so before
 * minting from one this asks GitHub, with the person's own OAuth credential,
 * whether they may push to that repository (viewerCanPush).
 *
 * A refusal is an answer, not an error — the helper exits quietly and git
 * falls through to its next credential helper (the device key over ssh, or the
 * laptop's agent bridge).
 */
export const hostGitCredential = action({
  args: {
    api_token: v.optional(v.string()),
    /** The cloud host's device id (the requester). */
    device_id: v.string(),
    /** `owner/name` of the repository git is authenticating for. */
    repository: v.string(),
    /** The git host; only github.com has an installation to mint from. */
    host: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<HostGitCredential | HostGitCredentialRefusal> => {
    const resolved: HostGitInstallationAnswer | HostGitCredentialRefusal =
      await ctx.runQuery(internal.cloud.hostGitInstallation, {
        ...(args.api_token ? { api_token: args.api_token } : {}),
        device_id: args.device_id,
        repository: args.repository,
        ...(args.host ? { host: args.host } : {}),
      });
    if ("reason" in resolved) return resolved;
    // A team's installation covers repositories this person may not be able to
    // push to on GitHub, so GitHub decides, with their own credential. Their
    // own installation needs no second opinion: it is their access already.
    if (!resolved.personal) {
      const allowed = await viewerCanPush(resolved.repository, resolved.viewer_github_token);
      if (allowed !== true) {
        const who = resolved.viewer_github_login ? ` (${resolved.viewer_github_login})` : "";
        return {
          reason: allowed === false
            ? `your GitHub account${who} cannot push to ${resolved.repository}, so the ${resolved.account_login} installation will not push for you`
            : `the ${resolved.account_login} installation covers ${resolved.repository}, but GitHub could not confirm that you may push there — link your GitHub account in codecast settings and retry`,
        };
      }
    }
    // Scoped to the repository git named, and to push access. GitHub refuses
    // (422) when the installation does not hold that permission, so a mint
    // that throws is a refusal the helper can print, not a crash.
    let minted: { token: string; expires_at: number; permissions?: Record<string, string> };
    try {
      minted = await ctx.runAction(internal.githubApp.getInstallationToken, {
        installation_id: resolved.installation_id,
        repository: args.repository,
      });
    } catch (e) {
      return {
        reason:
          `the codecast GitHub App on ${resolved.account_login} could not mint a push token for ${args.repository}: ` +
          `${(e as Error)?.message ?? "no reason given"}`,
      };
    }
    // Push access has to be PROVEN here, not assumed: this answer decides
    // whether the host reports itself as able to push, and a yes it cannot
    // back turns every push into a 403 nobody can explain. An unknown
    // permission map is therefore a refusal, and the device key carries on.
    if (grantsContentsWrite(minted.permissions) !== true) {
      return {
        reason:
          `the codecast GitHub App on ${resolved.account_login} cannot write to ${args.repository} ` +
          `(its contents permission is ${minted.permissions?.contents ?? "unknown"}) — re-install it with write access`,
      };
    }
    return {
      username: "x-access-token" as const,
      password: minted.token,
      expires_at: minted.expires_at,
      installation_id: resolved.installation_id,
    };
  },
});
