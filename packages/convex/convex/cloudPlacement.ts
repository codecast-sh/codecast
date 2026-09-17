/**
 * Parking a session on the cloud host: the leaf every creator goes through.
 *
 * A cloud session starts nowhere yet — the browser cannot SSH, so an online
 * LOCAL daemon prepares the host (wake, refresh the checkout, acquire a
 * worktree) and then places the row (cloud.placeConversation). Until then the
 * row is `cloud_placement: "pending"`, owned by the host, and no daemon may
 * deliver into it. This module owns: which laptop prepares (enqueueCloudSpawn),
 * the park itself with its idempotency and its per-park token
 * (parkOnCloudHost), the ONE rule deciding whether a launch aimed at the host
 * needs preparing at all (cloudPlacementNeeded, on the shared
 * cloudPlacementFor predicate), and the catch-up a laptop runs when it comes
 * back online (reissueStrandedCloudSpawns).
 *
 * Imports only deviceRouting, sessionRelease and the shared contracts, so
 * devices.ts / conversations.ts / dispatch.ts can all import it.
 */
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { DEVICE_ONLINE_MS, pathUnderRoot } from "./deviceRouting";
import { releasePreviousOwner } from "./sessionRelease";
import {
  cloudPlacementFor,
  deviceDisplayName,
  deviceWakesOnUse,
  normalizeCloudStartFrom,
  normalizeCloudWorkspace,
  sharedCheckoutOccupant,
  type CheckoutMatch,
  type CheckoutOccupantRow,
  type CloudStartFrom,
  type CloudWorkspaceMode,
} from "@codecast/shared/contracts";

/** The daemon poll's command TTL (users.daemonHeartbeat expires older ones). */
export const COMMAND_TTL_MS = 5 * 60 * 1000;
/**
 * How long one `cast cloud start` may run (the daemon's child timeout: a cold
 * EC2 boot, a clone and an install). A claimed cloud_spawn stays LIVE this
 * long from its claim, well past the 5-minute poll TTL that would otherwise
 * let a second child start beside the first.
 */
export const CLOUD_SPAWN_RUN_MS = 25 * 60 * 1000;

type Ctx = { db: any };

/** The wire form of CloudWorkspaceMode (@codecast/shared). Absent = isolated. */
export const cloudWorkspaceValidator = v.union(v.literal("isolated"), v.literal("shared"));

/** The wire form of CloudStartFrom (@codecast/shared). Absent = checkout. */
export const cloudStartFromArg = v.union(v.literal("checkout"), v.literal("origin_main"));

/** conversations.cloud_seed minus `at` (the server stamps the time). */
export const cloudSeedArg = v.object({
  source: cloudStartFromArg,
  base: v.string(),
  branch: v.optional(v.string()),
  dirty: v.optional(v.boolean()),
  laptop_root: v.optional(v.string()),
  device_id: v.optional(v.string()),
  reason: v.optional(v.string()),
});

/**
 * The start_from a park records and forwards: the caller's choice, else the
 * row's stamp, else checkout. A SHARED row never seeds from a laptop tree —
 * the host's main checkout is moved to origin/main — so shared forces
 * origin_main whatever was asked.
 */
export function effectiveStartFrom(workspace: CloudWorkspaceMode | undefined, requested: unknown, rowValue: unknown): CloudStartFrom {
  if (workspace === "shared") return "origin_main";
  return normalizeCloudStartFrom(requested ?? rowValue);
}

/**
 * The alive row holding a checkout on `deviceId`, judged by the shared
 * occupancy rule over every row the device owns. The claim, the placement
 * re-check, both move refusals and the create-time basename check all read
 * through here, so "in use" means one thing.
 */
export async function findSharedCheckoutOccupant(
  ctx: Ctx,
  userId: Id<"users">,
  deviceId: string,
  match: CheckoutMatch,
): Promise<CheckoutOccupantRow | null> {
  const owned = await ctx.db
    .query("conversations")
    .withIndex("by_owner_device", (q: any) => q.eq("user_id", userId).eq("owner_device_id", deviceId))
    .collect();
  const rows: CheckoutOccupantRow[] = owned.map((c: any) => ({
    conversation_id: c._id.toString(),
    short_id: c.short_id ?? null,
    title: c.title ?? null,
    status: c.status ?? null,
    inbox_killed_at: c.inbox_killed_at ?? null,
    cloud_workspace: c.cloud_workspace ?? null,
    cloud_placement: c.cloud_placement ?? null,
    cloud_checkout_path: c.cloud_checkout_path ?? null,
    project_path: c.project_path ?? null,
    session_error: c.session_error ?? null,
  }));
  return sharedCheckoutOccupant(rows, match);
}


/**
 * The caller's own wake-on-use device, or a throw. Validated under the OWNER
 * (the account that runs the session): a team agent box is another user's
 * device and a bot cannot own a cloud park.
 */
export async function resolveCloudDevice(ctx: Ctx, ownerUserId: Id<"users">, deviceId: string): Promise<any> {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", ownerUserId).eq("device_id", deviceId))
    .first();
  const owner = await ctx.db.get(ownerUserId);
  if (!device || !deviceWakesOnUse(device) || owner?.is_bot) {
    throw new Error("Not a cloud host you own");
  }
  return device;
}

function parseArgs(c: any): any {
  try { return c.args ? JSON.parse(c.args) : {}; } catch { return {}; }
}

/**
 * Is a cloud_spawn still being worked on? Unclaimed: inside the poll TTL (a
 * daemon may still pick it up). Claimed: a `cast cloud start` child is running
 * for up to CLOUD_SPAWN_RUN_MS from the claim — including after the heartbeat
 * stamped it `expired_ttl` at minute five (the child keeps running; its
 * reportCommandResult overwrites the stamp with a result when it finishes).
 */
export function cloudSpawnLive(c: any, now: number): boolean {
  if (c.command !== "cloud_spawn") return false;
  if (c.claimed_at !== undefined) {
    if (c.result !== undefined) return false;
    if (c.executed_at !== undefined && c.error !== "expired_ttl") return false;
    return now - c.claimed_at < CLOUD_SPAWN_RUN_MS;
  }
  return c.executed_at === undefined && now - (c.created_at ?? c._creationTime ?? 0) < COMMAND_TTL_MS;
}

/**
 * The LIVE cloud_spawn for a row (cloudSpawnLive). Two reads: the user's
 * pending commands (small) and the ones executed inside the run window, which
 * is where a claimed child past the poll TTL sits. No new index needed.
 */
export async function liveCloudSpawnFor(ctx: Ctx, userId: Id<"users">, conversationId: Id<"conversations">): Promise<any | null> {
  const now = Date.now();
  const pending = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined))
    .collect();
  const recent = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).gte("executed_at", now - CLOUD_SPAWN_RUN_MS))
    .collect();
  return [...pending, ...recent].find((c: any) =>
    cloudSpawnLive(c, now) && parseArgs(c).conversation_id === conversationId) ?? null;
}

/** Retire every live cloud_spawn for a row (an un-park, a re-park). */
export async function supersedeCloudSpawns(ctx: Ctx, userId: Id<"users">, conversationId: Id<"conversations">): Promise<number> {
  const now = Date.now();
  const pending = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", userId).eq("executed_at", undefined))
    .collect();
  let n = 0;
  for (const c of pending) {
    if (c.command !== "cloud_spawn" || parseArgs(c).conversation_id !== conversationId) continue;
    await ctx.db.patch(c._id, { executed_at: now, error: "superseded" });
    n++;
  }
  return n;
}

const byRecency = (a: any, b: any) => b.last_seen - a.last_seen;

/**
 * Which laptop prepares the host, and the cloud_spawn that asks it to.
 *
 * Preparer order: an online local whose roots cover the path (it has the
 * checkout to seed from) → the online local the caller nominated (the
 * heartbeat re-issue names the laptop that just came back) → the online local
 * seen most recently → the local seen most recently even if OFFLINE. The last
 * case parks the row with a "waiting" session_error rather than failing the
 * create: that laptop's next heartbeat (users.daemonHeartbeat's offline→online
 * transition) re-issues the command, so a 5-minute command TTL cannot strand
 * the row. Throws only for an account with no local device at all — nothing
 * could ever prepare the host.
 */
export async function enqueueCloudSpawn(
  ctx: Ctx,
  userId: Id<"users">,
  opts: {
    conversationId: Id<"conversations">;
    cloudDeviceId: string;
    projectPath?: string | null;
    gitRoot?: string | null;
    token?: string;
    /**
     * The laptop that just came online (the heartbeat re-issue). Preferred
     * among the ONLINE locals once none holds the checkout: a laptop that has
     * the repo can prepare, one that merely woke up may not.
     */
    preparerDeviceId?: string;
    /** Isolated worktree (absent) or the host's main checkout; rides the args JSON to `cast cloud start --workspace`. */
    workspace?: CloudWorkspaceMode;
    /** What the worktree starts from; rides the args JSON to `cast cloud start --from`. */
    startFrom?: CloudStartFrom;
  },
): Promise<{ commandId: Id<"daemon_commands">; preparerOnline: boolean; preparer: any }> {
  const now = Date.now();
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const locals = devices.filter((d: any) => !d.is_remote);
  if (locals.length === 0) {
    throw new Error("No laptop can prepare the cloud host — run the codecast daemon on a machine that has the repo");
  }
  const online = locals.filter((d: any) => now - d.last_seen < DEVICE_ONLINE_MS).sort(byRecency);
  const paths = [opts.gitRoot, opts.projectPath].filter((p): p is string => !!p);
  const holdsCheckout = (d: any) => (d.local_project_roots ?? []).some((r: string) => paths.some((p) => pathUnderRoot(p, r)));
  const preparer = online.find(holdsCheckout)
    || (opts.preparerDeviceId && online.find((d: any) => d.device_id === opts.preparerDeviceId))
    || online[0]
    || [...locals].sort(byRecency)[0];
  const commandId = await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "cloud_spawn" as const,
    args: JSON.stringify({
      conversation_id: opts.conversationId,
      cloud_device_id: opts.cloudDeviceId,
      ...(opts.token ? { placement_token: opts.token } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      ...(opts.startFrom ? { start_from: opts.startFrom } : {}),
    }),
    created_at: now,
    target_device_id: preparer.device_id,
  });
  return { commandId, preparerOnline: now - preparer.last_seen < DEVICE_ONLINE_MS, preparer };
}

export function waitingForPreparerError(preparer: { label?: string; platform?: string; is_remote?: boolean }): string {
  const name = preparer.label ? deviceDisplayName({ label: preparer.label, platform: preparer.platform ?? "", is_remote: preparer.is_remote }) : "your laptop";
  return `Waiting for ${name} to come online to prepare the cloud host`;
}

/**
 * Park a row on the cloud host and ask a laptop to prepare it.
 *
 * Idempotent only against a LIVE cloud_spawn: a row already pending on this
 * host with a live command is a no-op (null) unless `force` says the folder
 * changed; otherwise — the command expired, `cast cloud start` failed, or the
 * folder moved — it re-enqueues with a FRESH token and clears the previous
 * error, which is what makes "re-pick Cloud Linux" a retry. A prior different
 * owner is released so no laptop keeps a copy running.
 *
 * A PATHLESS park (cloud toggled on before any folder) has nothing to
 * prepare: the row parks tokenless with no cloud_spawn — nobody is preparing
 * it, so the heartbeat re-issue leaves it alone and the folder pick that
 * follows (another park, through here) is what asks a laptop. Enqueueing here
 * would only make `cast cloud start` fail with "not on this machine" seconds
 * after the toggle.
 */
export async function parkOnCloudHost(
  ctx: Ctx,
  userId: Id<"users">,
  conv: any,
  cloudDeviceId: string,
  opts: { projectPath?: string | null; gitRoot?: string | null; force?: boolean; workspace?: CloudWorkspaceMode; startFrom?: CloudStartFrom } = {},
): Promise<Id<"daemon_commands"> | null> {
  const projectPath = opts.projectPath ?? conv.project_path ?? null;
  const gitRoot = opts.gitRoot ?? conv.git_root ?? null;
  // The mode the row was created with rides every re-park (a folder re-pick,
  // a retry) unless the caller changes it; the child reads it from the args.
  const workspace: CloudWorkspaceMode | undefined = opts.workspace ?? (conv.cloud_workspace === "shared" ? "shared" : conv.cloud_workspace === "isolated" ? "isolated" : undefined);
  // Likewise the seed choice: the caller's, else the row's, else checkout;
  // a shared row is always origin_main.
  const startFrom = effectiveStartFrom(workspace, opts.startFrom, conv.cloud_start_from);
  // Read before the patch: the row handed in may be the live document.
  const priorOwner: string | undefined = conv.owner_device_id;
  const releasePrior = async () => {
    if (priorOwner && priorOwner !== cloudDeviceId) {
      await releasePreviousOwner(ctx, {
        queueUserId: userId,
        conversationId: conv._id,
        sessionId: conv.session_id,
        priorDeviceId: priorOwner,
        newDeviceId: cloudDeviceId,
      });
    }
  };
  if (!projectPath && !gitRoot) {
    await supersedeCloudSpawns(ctx, userId, conv._id);
    await ctx.db.patch(conv._id, {
      owner_device_id: cloudDeviceId,
      cloud_placement: "pending" as const,
      cloud_placement_token: undefined,
      ...(opts.startFrom ? { cloud_start_from: startFrom } : {}),
      session_error: undefined,
      updated_at: Date.now(),
    });
    await releasePrior();
    return null;
  }
  // A workspace or seed change is a re-park like a folder change: the child
  // in flight read its mode and start_from from the args JSON, so it must
  // be superseded.
  const modeChanged = !!workspace && workspace !== normalizeCloudWorkspace(conv.cloud_workspace);
  const seedChanged = startFrom !== effectiveStartFrom(normalizeCloudWorkspace(conv.cloud_workspace), undefined, conv.cloud_start_from);
  if (!opts.force && !modeChanged && !seedChanged && conv.cloud_placement === "pending" && conv.owner_device_id === cloudDeviceId && conv.cloud_placement_token
    && await liveCloudSpawnFor(ctx, userId, conv._id)) {
    return null;
  }
  await supersedeCloudSpawns(ctx, userId, conv._id);
  const token = crypto.randomUUID();
  const { commandId, preparerOnline, preparer } = await enqueueCloudSpawn(ctx, userId, {
    conversationId: conv._id,
    cloudDeviceId,
    projectPath,
    gitRoot,
    token,
    workspace,
    startFrom,
  });
  await ctx.db.patch(conv._id, {
    owner_device_id: cloudDeviceId,
    cloud_placement: "pending" as const,
    cloud_placement_token: token,
    ...(workspace ? { cloud_workspace: workspace } : {}),
    cloud_start_from: startFrom,
    // An isolated park never holds the root: drop a claim a failed shared
    // attempt left behind, so `cast hosts ls` does not attribute it by path.
    ...(workspace === "isolated" ? { cloud_checkout_path: undefined } : {}),
    session_error: preparerOnline ? undefined : waitingForPreparerError(preparer),
    updated_at: Date.now(),
  });
  await releasePrior();
  return commandId;
}

/**
 * The start chokepoint's upgrade rule: a launch that names the runner's own
 * cloud host as its target, from a laptop folder, needs the host prepared.
 * Returns the device to park on, or null to leave the launch alone.
 *
 * Only when the CALLER is the runner: a team agent box's runner is the bot,
 * whose provisioned device heartbeats is_remote+linux too, and parking a
 * teammate's box spawn would strand it. Never for a bot runner, a row already
 * pending or already holding a worktree, an account with no local device
 * (nothing could prepare), or a path the host already holds / nobody claims
 * (cloudPlacementFor !== "park": native starts plainly, ambiguous is left to
 * the explicit cloud_device_id the web sends).
 */
export async function cloudPlacementNeeded(
  ctx: Ctx,
  opts: {
    callerUserId?: Id<"users"> | null;
    runnerUserId: Id<"users">;
    conv: any;
    targetDeviceId?: string | null;
    paths: Array<string | null | undefined>;
  },
): Promise<any | null> {
  if (!opts.callerUserId || opts.callerUserId !== opts.runnerUserId) return null;
  if (!opts.targetDeviceId || !opts.conv) return null;
  if (opts.conv.cloud_placement || opts.conv.worktree_path) return null;
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", opts.runnerUserId))
    .collect();
  const target = devices.find((d: any) => d.device_id === opts.targetDeviceId);
  if (!target || !deviceWakesOnUse(target)) return null;
  const runner = await ctx.db.get(opts.runnerUserId);
  if (runner?.is_bot) return null;
  const locals = devices.filter((d: any) => !d.is_remote);
  if (locals.length === 0) return null;
  return cloudPlacementFor({ target, locals, paths: opts.paths }) === "park" ? target : null;
}

/**
 * A laptop came back online (users.daemonHeartbeat's offline→online
 * transition): every row parked on one of the user's own cloud hosts that
 * nobody is preparing (pending, alive, token present, no live cloud_spawn)
 * gets a fresh cloud_spawn — preferably to THIS laptop, unless another online
 * one holds the checkout — reusing the row's token so an in-flight `cast
 * cloud start` (if any survived) still matches. Rows without a token are not
 * this loop's to re-issue: a pathless park, or an occupancy refusal, waits for
 * an explicit re-pick.
 */
export async function reissueStrandedCloudSpawns(ctx: Ctx, userId: Id<"users">, localDeviceId: string): Promise<number> {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  let reissued = 0;
  for (const host of devices.filter((d: any) => deviceWakesOnUse(d))) {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_owner_device", (q: any) => q.eq("user_id", userId).eq("owner_device_id", host.device_id))
      .collect();
    for (const conv of rows) {
      if (conv.cloud_placement !== "pending" || !conv.cloud_placement_token) continue;
      if (!conv.project_path && !conv.git_root) continue;
      if (conv.inbox_killed_at || conv.status === "completed") continue;
      if (await liveCloudSpawnFor(ctx, userId, conv._id)) continue;
      await enqueueCloudSpawn(ctx, userId, {
        conversationId: conv._id,
        cloudDeviceId: host.device_id,
        projectPath: conv.project_path ?? null,
        gitRoot: conv.git_root ?? null,
        token: conv.cloud_placement_token,
        preparerDeviceId: localDeviceId,
        workspace: conv.cloud_workspace === "shared" ? "shared" : undefined,
        // Only a row stamped with a choice carries one; an older row's
        // re-issue is byte-identical to before (absent = checkout).
        ...(conv.cloud_start_from ? { startFrom: effectiveStartFrom(normalizeCloudWorkspace(conv.cloud_workspace), undefined, conv.cloud_start_from) } : {}),
      });
      if (conv.session_error) await ctx.db.patch(conv._id, { session_error: undefined, updated_at: Date.now() });
      reissued++;
    }
  }
  return reissued;
}
