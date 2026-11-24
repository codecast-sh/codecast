// A role's standing session fails over on its own when its host stops serving
// it while work waits (ct-93807). The sweep reads every active role's standing
// session, judges its host (quiet past ROLE_FAILOVER_QUIET_MS, a cast version
// below the floor, a frozen daemon, a pane that refused input after its
// automatic restart), and when wakes or messages are queued for it, moves it
// to the healthiest always-on machine its owner can run it on, through the
// one move every path uses (orgRoles.performMoveRole). Queued messages follow
// the session's owner_device_id, so they deliver on the new host.
//
// The owner (the person at the top of the role's reporting chain) gets one
// line, and the role carries `failover`, which the role page draws with Move
// back. With no host to move to, the owner gets the line once and nothing
// moves.
import { v } from "convex/values";
import { internalMutation, mutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { isBelowMinimum } from "@platform/flags";
import { cloudHostBootable, deviceWakesOnUse, isReservedDevice } from "@codecast/shared/contracts";
import { chainHeadOf } from "@codecast/shared/contracts/orgAssignee";
import { ROLE_FAILOVER_QUIET_MS, moveBackRefusal, roleFailoverLine, roleHostQuiet, roleMoveBackState, type RoleFailover, type RoleFailoverReason } from "@codecast/shared/contracts/roleFailover";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { LOOP_FREEZE_ALERT_MS } from "./daemonLogs";
import { getSystemConfig } from "./systemConfig";
import { listTeamMachines, resolveSessionLaunchDevice } from "./sessionLaunch";
import { checkConversationAccess } from "./privacy";
import { findPullableConversation } from "./devices";
import { allRolesInBoundary, requireRole, userCanAdminRole } from "./lib/orgAccess";
import { moveStandingSession, performMoveRole, standingConversationOf } from "./orgRoles";
import { emitNotification } from "./notificationRouter";

export { ROLE_FAILOVER_QUIET_MS };

/** After a move, the same role does not move again for this long: a new host
 *  that is slow to come up must not bounce the session around the fleet. */
export const ROLE_FAILOVER_COOLDOWN_MS = 60 * 60 * 1000;

/** The most roles one sweep reads. */
const SWEEP_ROLES_CAP = 1000;

/** A message that has not reached the agent yet. */
const QUEUED_STATUSES = ["pending", "held"] as const;

type Probe = { device_id: string; last_seen: number; is_remote?: boolean; platform?: string; cloud_host?: any; cli_version?: string; loop_freeze_1h_ms?: number; cloud_wake?: { status: string }; reserved_for?: string };

const online = (d: { last_seen: number }, now: number) => now - d.last_seen < DEVICE_ONLINE_MS;
const probesOf = (rows: Probe[], now: number) => rows.map((d) => ({ ...d, online: online(d, now) }));

/**
 * What is wrong with the host a standing session sits on, or null when it
 * serves. Quiet past the threshold is "offline", unless it is a cloud host
 * that queued work boots and whose last wake did not fail. A host that is
 * up but cannot serve: below the version floor, frozen past the alert bar,
 * or a pane refusal since the last failover (conversations.pane_refused_at).
 */
export function hostTrouble(
  device: Probe | null,
  conv: { pane_refused_at?: number },
  opts: { now: number; roster: Probe[]; minCliVersion: string | null; lastFailoverAt: number },
): RoleFailoverReason | null {
  const { now } = opts;
  if (!device) return "offline";
  if (roleHostQuiet(device.last_seen, now)) {
    const probes = probesOf(opts.roster.some((d) => d.device_id === device.device_id) ? opts.roster : [...opts.roster, device], now);
    const self = probes.find((d) => d.device_id === device.device_id)!;
    if (cloudHostBootable(self, probes) && device.cloud_wake?.status !== "failed") return null;
    return "offline";
  }
  if (device.cli_version && isBelowMinimum(device.cli_version, opts.minCliVersion)) return "below_floor";
  if ((device.loop_freeze_1h_ms ?? 0) >= LOOP_FREEZE_ALERT_MS) return "freezing";
  if (conv.pane_refused_at && conv.pane_refused_at > opts.lastFailoverAt) return "pane_refused";
  return null;
}

/**
 * The healthiest always-on machine among the candidates, or null. Always-on
 * is a remote that wakes on use (deviceWakesOnUse): up now, or a cloud host
 * queued work boots. Up beats asleep, a quieter loop beats a busier one, and
 * the latest heartbeat breaks ties. A machine below the floor or frozen is
 * never picked, nor the host being left.
 */
export function pickFailoverHost<T extends Probe>(candidates: T[], fromDeviceId: string, opts: { now: number; minCliVersion: string | null }): T | null {
  const { now } = opts;
  const probes = probesOf(candidates, now);
  const fit = candidates.filter((d, i) =>
    d.device_id !== fromDeviceId
    && !isReservedDevice(d)
    && deviceWakesOnUse(d)
    && (probes[i].online || cloudHostBootable(probes[i], probes))
    && !(d.cli_version && isBelowMinimum(d.cli_version, opts.minCliVersion))
    && (d.loop_freeze_1h_ms ?? 0) < LOOP_FREEZE_ALERT_MS);
  fit.sort((a, b) =>
    Number(online(b, now)) - Number(online(a, now))
    || (a.loop_freeze_1h_ms ?? 0) - (b.loop_freeze_1h_ms ?? 0)
    || b.last_seen - a.last_seen);
  return fit[0] ?? null;
}

/** The person a role answers to: the top of its reporting chain, else its
 *  personal owner, else whoever seated it. */
async function roleOwnerOf(ctx: any, role: any): Promise<Id<"users">> {
  const head = chainHeadOf(role._id, await allRolesInBoundary(ctx, role));
  return (head ?? role.scope_user_id ?? role.host_user_id) as Id<"users">;
}

async function queuedCount(ctx: any, conversationId: Id<"conversations">): Promise<number> {
  let n = 0;
  for (const status of QUEUED_STATUSES) {
    n += (await ctx.db.query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", status))
      .take(100)).length;
  }
  return n;
}

/** The machines `ownerId` may move this session to, each with what the move
 *  would check: their own, and a team machine only for a session they own
 *  (performReparentSessionToDevice refuses the rest). */
async function candidateHosts(ctx: any, ownerId: Id<"users">, conv: any): Promise<any[]> {
  const own = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", ownerId)).collect();
  const ownsIt = (await checkConversationAccess(ctx, ownerId, conv)) === "owner";
  const team = ownsIt ? (await listTeamMachines(ctx, ownerId)).map((m) => m.device) : [];
  return [...own, ...team];
}

const hostOf = (d: any) => ({ device_id: d.device_id as string, label: (d.label as string) || d.device_id, user_id: d.user_id as Id<"users"> });

async function tellOwner(ctx: any, role: any, anchor: any, ownerId: Id<"users">, f: RoleFailover): Promise<void> {
  const runner = f.to && f.to.user_id !== String(ownerId) ? await ctx.db.get(f.to.user_id as Id<"users">) : null;
  const line = roleFailoverLine(role.handle, f, String(ownerId), () => runner?.name || runner?.email || "a teammate");
  await emitNotification(ctx, {
    event_type: "role_moved",
    entity_type: "org_role",
    entity_id: role.short_id,
    direct_recipient_id: ownerId,
    actor_user_id: anchor?.bot_user_id ?? undefined,
    actor_name: role.name,
    message: line,
    push_body: line,
  });
}

export type FailoverOutcome = { role_id: Id<"org_roles">; handle: string; reason: RoleFailoverReason; moved: boolean; to?: string };

/** Judge one role's standing session and act. Returns what it did, or null
 *  when the host serves, nothing waits, or the role moved recently. */
export async function performRoleFailover(ctx: any, role: any, now: number, minCliVersion: string | null): Promise<FailoverOutcome | null> {
  if (role.status !== "active") return null;
  const last: RoleFailover | undefined = role.failover;
  if (last?.to && now - last.at < ROLE_FAILOVER_COOLDOWN_MS) return null;
  const conv = await standingConversationOf(ctx, role);
  if (!conv?.owner_device_id || conv.register_only || conv.status !== "active") return null;
  const roster: Probe[] = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", conv.user_id)).collect();
  const device = roster.find((d) => d.device_id === conv.owner_device_id) ?? null;
  const reason = hostTrouble(device, conv, { now, roster, minCliVersion, lastFailoverAt: last?.at ?? 0 });
  if (!reason) {
    // A stuck line is about the host as it was; once the session's host
    // serves again the role is no longer stuck. A move (with `to`) stays, for
    // its move-back.
    if (last && !last.to) await ctx.db.patch(role._id, { failover: undefined });
    return null;
  }
  if ((await queuedCount(ctx, conv._id)) === 0) return null;

  const ownerId = await roleOwnerOf(ctx, role);
  const mayMove = (await userCanAdminRole(ctx, ownerId, role)) && !!(await findPullableConversation(ctx, ownerId, String(conv._id)));
  const host = mayMove ? pickFailoverHost(await candidateHosts(ctx, ownerId, conv), conv.owner_device_id, { now, minCliVersion }) : null;
  const from = device ? hostOf(device) : { device_id: conv.owner_device_id, label: conv.owner_device_id, user_id: conv.user_id };
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;

  const stuck = !host;
  // Said once per stuck host; a host appearing later still moves it.
  if (stuck && last && !last.to && last.from.device_id === from.device_id) return null;
  const moved = host ? await performMoveRole(ctx, ownerId, { role_id: String(role._id), device_id: host.device_id }) : null;
  const to = host ? hostOf(host) : undefined;
  const stored = { at: now, reason, owner_user_id: ownerId, from, ...(to ? { to } : {}), ...(moved?.cross_user ? { cross_user: true } : {}) };
  await ctx.db.patch(role._id, { failover: stored });
  await tellOwner(ctx, role, anchor, ownerId, asFailover(stored));
  return { role_id: role._id, handle: role.handle, reason, moved: !stuck, ...(to ? { to: to.label } : {}) };
}

/** The stored row as the shared words read it (ids as strings). */
const asFailover = (row: any): RoleFailover => ({
  ...row,
  owner_user_id: String(row.owner_user_id),
  from: { ...row.from, user_id: String(row.from.user_id) },
  ...(row.to ? { to: { ...row.to, user_id: String(row.to.user_id) } } : {}),
});

export async function performRoleFailoverSweep(ctx: any, now = Date.now()): Promise<{ checked: number; outcomes: FailoverOutcome[] }> {
  const roles: any[] = await ctx.db.query("org_roles").filter((q: any) => q.eq(q.field("status"), "active")).take(SWEEP_ROLES_CAP);
  const minCliVersion = await getSystemConfig(ctx, "min_cli_version");
  const outcomes: FailoverOutcome[] = [];
  for (const role of roles) {
    try {
      const out = await performRoleFailover(ctx, role, now, minCliVersion);
      if (out) outcomes.push(out);
    } catch (e) {
      // The move refuses before it writes (authorization, an unknown device),
      // so one role's refusal leaves nothing half done and the rest still run.
      console.error(`[roleFailover] @${role.handle}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: roles.length, outcomes };
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => performRoleFailoverSweep(ctx),
});

/**
 * Move back: the standing session returns to the host the failover took it
 * from, through the same move, always as the caller. A role admin may move it
 * back, and so may the account that ran it there, onto its own machine: that
 * restores its own earlier state and nothing more. A host the caller may
 * not start sessions on is refused with who can (a role admin never places a
 * session on a teammate's unshared machine), and so is a host still past the
 * quiet threshold, which the next sweep would only move it off again.
 */
async function requireSettleableMove(ctx: any, userId: Id<"users">, roleId: string): Promise<{ role: any; f: any }> {
  const role = await requireRole(ctx, userId, roleId, "access");
  const f = role.failover;
  if (!f?.to) throw new Error("This role has no failover to undo");
  const priorRunner = String(f.from.user_id) === String(userId);
  if (!priorRunner && !(await userCanAdminRole(ctx, userId, role))) throw new Error("Only an admin of the role, or whoever ran it there, can move it back");
  return { role, f };
}

export async function performMoveRoleBack(ctx: any, userId: Id<"users">, args: { role_id: string }): Promise<any> {
  const { role, f } = await requireSettleableMove(ctx, userId, args.role_id);
  const device = await resolveSessionLaunchDevice(ctx, userId, f.from.device_id);
  const machines = device ? [{ device_id: device.device_id, user_id: String(device.user_id), last_seen: device.last_seen }] : [];
  const state = roleMoveBackState(asFailover(f), machines, Date.now());
  if (state !== "ok") {
    const runner = await ctx.db.get(f.from.user_id);
    throw new Error(moveBackRefusal(asFailover(f), state, () => runner?.name || runner?.email || "its owner"));
  }
  return moveStandingSession(ctx, userId, role, f.from.device_id);
}

/** Keep here: the session stays on the host the failover moved it to, and the
 *  move's line leaves the role. Same people as Move back. */
export async function performKeepRoleHere(ctx: any, userId: Id<"users">, args: { role_id: string }): Promise<void> {
  const { role } = await requireSettleableMove(ctx, userId, args.role_id);
  await ctx.db.patch(role._id, { failover: undefined });
}

export const keepHere = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performKeepRoleHere(ctx, userId, args);
  },
});

export const moveBack = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performMoveRoleBack(ctx, userId, args);
  },
});
