/**
 * Team machines (docs/architecture/team-machines.md): a Linux box a team owns,
 * where each member runs as their own Linux user, daemon and Claude login.
 *
 * Writes come from three places and meet in the perform* functions below:
 * the web (dispatch.ts side effects), the CLI (the token mutations here), and
 * the box itself (the admin daemon's claim/report calls, every daemon's
 * heartbeat through linkTeamHostBeat).
 */
import { v } from "convex/values";
import { mintSetupToken, splitPresentedToken } from "@platform/auth/convex";
import { TEAM_HOST_JOIN_STALE_MS, cpuBusy, isLinuxUserName, pickLinuxUser, type MachineResourceSnapshot } from "@codecast/shared/contracts";
import { mutation, query } from "./functions";
import { requireUserOrToken } from "./lib/auth";
import { verifyApiToken } from "./apiTokens";
import { isTeamAdmin, isTeamMember } from "./privacy";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type Ctx = { db: any };

const NAME_MAX = 64;

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
  if (!n) throw new Error("A team machine needs a name");
  return n;
}

/** A host key is the box's own random id: hex, long enough to be unguessable. */
function isHostKey(key: string): boolean {
  return /^[a-f0-9]{32,64}$/.test(key);
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hostOrThrow(ctx: Ctx, hostId: Id<"team_hosts">): Promise<Doc<"team_hosts">> {
  const host = await ctx.db.get(hostId);
  if (!host) throw new Error("That team machine no longer exists");
  return host;
}

async function membersOf(ctx: Ctx, hostId: Id<"team_hosts">): Promise<Doc<"team_host_members">[]> {
  return ctx.db.query("team_host_members").withIndex("by_host", (q: any) => q.eq("host_id", hostId)).collect();
}

/** May this person change the machine for everyone (rename, remove members)? Its admin, or an admin of its team. */
async function canManage(ctx: Ctx, userId: Id<"users">, host: Doc<"team_hosts">): Promise<boolean> {
  return host.admin_user_id === userId || (await isTeamAdmin(ctx, userId, host.team_id));
}

async function queueMemberCommand(ctx: MutationCtx, host: Doc<"team_hosts">, memberId: Id<"team_host_members">, action: "add" | "remove") {
  await ctx.db.insert("daemon_commands", {
    user_id: host.admin_user_id,
    command: "team_host_member" as const,
    args: JSON.stringify({ member_id: memberId, action }),
    created_at: Date.now(),
    target_device_id: host.admin_device_id,
  });
}

// ---------------------------------------------------------------------------
// Registering a machine (run on the box by its admin: `cast hosts team register`)
// ---------------------------------------------------------------------------

/**
 * Make the calling box a team machine, or update it. The caller is the daemon
 * login of the box's sudoer; its device becomes the admin device. Re-running
 * with the key the box already holds updates the name and address in place.
 */
export const register = mutation({
  args: {
    api_token: v.string(),
    team_id: v.id("teams"),
    name: v.string(),
    device_id: v.string(),
    linux_user: v.string(),
    platform: v.string(),
    address: v.optional(v.string()),
    host_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Authentication required");
    const bound = splitPresentedToken(args.api_token).deviceId;
    if (bound && bound !== args.device_id) throw new Error("This login belongs to another machine");
    if (!(await isTeamMember(ctx, auth.userId, args.team_id))) throw new Error("You are not on that team");
    if (!isLinuxUserName(args.linux_user)) throw new Error(`Not a Linux user name: ${args.linux_user}`);
    const name = cleanName(args.name);
    const address = args.address?.trim() || undefined;
    const existing = args.host_key
      ? await ctx.db.query("team_hosts").withIndex("by_host_key", (q: any) => q.eq("host_key", args.host_key)).first()
      : null;
    if (existing) {
      if (!(await canManage(ctx, auth.userId, existing))) throw new Error("Only the machine's admin can change it");
      if (existing.team_id !== args.team_id) throw new Error("This machine belongs to another team; remove it there first");
      await ctx.db.patch(existing._id, {
        name, address, platform: args.platform,
        admin_user_id: auth.userId, admin_device_id: args.device_id, admin_linux_user: args.linux_user,
      });
      return { host_id: existing._id, host_key: existing.host_key };
    }
    if (args.host_key && !isHostKey(args.host_key)) throw new Error("Not a host key");
    const host_key = args.host_key ?? randomHex(24);
    const host_id = await ctx.db.insert("team_hosts", {
      team_id: args.team_id, name, host_key, address, platform: args.platform,
      admin_user_id: auth.userId, admin_device_id: args.device_id, admin_linux_user: args.linux_user,
      created_at: Date.now(),
    });
    // The admin is the machine's first member: their daemon is already there.
    await ctx.db.insert("team_host_members", {
      host_id, user_id: auth.userId, linux_user: args.linux_user, device_id: args.device_id,
      status: "ready", requested_at: Date.now(), ready_at: Date.now(),
    });
    return { host_id, host_key };
  },
});

// ---------------------------------------------------------------------------
// Joining, leaving, removing, renaming: web (dispatch) and CLI (below)
// ---------------------------------------------------------------------------

export async function performJoinTeamHost(
  ctx: MutationCtx,
  userId: Id<"users">,
  hostId: Id<"team_hosts">,
  opts: { linux_user?: string; ssh_pubkey?: string } = {},
): Promise<{ member_id: Id<"team_host_members">; linux_user: string }> {
  const host = await hostOrThrow(ctx, hostId);
  if (!(await isTeamMember(ctx, userId, host.team_id))) throw new Error("You are not on this machine's team");
  const members = await membersOf(ctx, hostId);
  const mine = members.find((m) => m.user_id === userId);
  if (mine && (mine.status === "ready" || mine.status === "removing")) throw new Error(`You are already on ${host.name} as ${mine.linux_user}`);
  if (mine?.status === "joining" && Date.now() - mine.requested_at < TEAM_HOST_JOIN_STALE_MS) {
    return { member_id: mine._id, linux_user: mine.linux_user };
  }
  const pubkey = opts.ssh_pubkey?.trim();
  if (pubkey && !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\n]{0,200})?$/.test(pubkey)) throw new Error("That is not an ssh public key");
  const user = await ctx.db.get(userId);
  // A failed join keeps its Linux user: the box may already have made it.
  const linux_user = mine?.linux_user ?? pickLinuxUser(
    { requested: opts.linux_user, github: user?.github_username, email: user?.email, name: user?.name },
    [host.admin_linux_user, ...members.filter((m) => m.user_id !== userId).map((m) => m.linux_user)],
  );
  if (opts.linux_user && !mine && linux_user !== opts.linux_user) throw new Error(`The Linux user ${opts.linux_user} is taken on ${host.name}`);
  const { token } = await mintSetupToken(ctx, userId);
  const row = {
    status: "joining" as const, step: "queued", error: undefined, voucher: token,
    ssh_pubkey: pubkey ?? mine?.ssh_pubkey, requested_at: Date.now(),
  };
  let memberId: Id<"team_host_members">;
  if (mine) {
    await ctx.db.patch(mine._id, row);
    memberId = mine._id;
  } else {
    memberId = await ctx.db.insert("team_host_members", { host_id: hostId, user_id: userId, linux_user, ...row });
  }
  await queueMemberCommand(ctx, host, memberId, "add");
  return { member_id: memberId, linux_user };
}

/** Take a member off the machine: yourself, or anyone when you manage it. The admin cannot leave their own machine. */
export async function performRemoveTeamHostMember(ctx: MutationCtx, userId: Id<"users">, memberId: Id<"team_host_members">) {
  const member = await ctx.db.get(memberId);
  if (!member) return { removed: false };
  const host = await hostOrThrow(ctx, member.host_id);
  if (member.user_id !== userId && !(await canManage(ctx, userId, host))) throw new Error("Only the machine's admin can remove someone else");
  if (member.user_id === host.admin_user_id && member.linux_user === host.admin_linux_user) {
    throw new Error("The admin's own user runs the machine; remove the machine instead");
  }
  // A join that never got anywhere has nothing on the box to undo.
  if (member.status === "joining" && member.step === "queued") {
    await ctx.db.delete(memberId);
    return { removed: true };
  }
  await ctx.db.patch(memberId, { status: "removing", step: undefined, error: undefined, voucher: undefined });
  await queueMemberCommand(ctx, host, memberId, "remove");
  return { removed: true };
}

export async function performRenameTeamHost(ctx: MutationCtx, userId: Id<"users">, hostId: Id<"team_hosts">, name: string) {
  const host = await hostOrThrow(ctx, hostId);
  if (!(await canManage(ctx, userId, host))) throw new Error("Only the machine's admin can rename it");
  await ctx.db.patch(hostId, { name: cleanName(name) });
}

/** Stop treating a box as a team machine. Members' daemons keep running until the admin removes them on the box. */
export async function performUnregisterTeamHost(ctx: MutationCtx, userId: Id<"users">, hostId: Id<"team_hosts">) {
  const host = await hostOrThrow(ctx, hostId);
  if (!(await canManage(ctx, userId, host))) throw new Error("Only the machine's admin can remove it");
  for (const m of await membersOf(ctx, hostId)) await ctx.db.delete(m._id);
  await ctx.db.delete(hostId);
}

export const join = mutation({
  args: { api_token: v.optional(v.string()), host_id: v.id("team_hosts"), linux_user: v.optional(v.string()), ssh_pubkey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    return performJoinTeamHost(ctx, userId, args.host_id, { linux_user: args.linux_user, ssh_pubkey: args.ssh_pubkey });
  },
});

export const removeMember = mutation({
  args: { api_token: v.optional(v.string()), member_id: v.id("team_host_members") },
  handler: async (ctx, args) => performRemoveTeamHostMember(ctx, await requireUserOrToken(ctx, args.api_token), args.member_id),
});

export const rename = mutation({
  args: { api_token: v.optional(v.string()), host_id: v.id("team_hosts"), name: v.string() },
  handler: async (ctx, args) => performRenameTeamHost(ctx, await requireUserOrToken(ctx, args.api_token), args.host_id, args.name),
});

export const unregister = mutation({
  args: { api_token: v.optional(v.string()), host_id: v.id("team_hosts") },
  handler: async (ctx, args) => performUnregisterTeamHost(ctx, await requireUserOrToken(ctx, args.api_token), args.host_id),
});

// ---------------------------------------------------------------------------
// The admin daemon's side of a join or removal
// ---------------------------------------------------------------------------

/** The admin daemon's login and device, or a thrown refusal: only that daemon carries out a machine's member changes. */
async function requireAdminDaemon(ctx: Ctx, apiToken: string, host: Doc<"team_hosts">) {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth || auth.userId !== host.admin_user_id) throw new Error("Only the machine's admin daemon may do this");
  const bound = splitPresentedToken(apiToken).deviceId;
  if (bound && bound !== host.admin_device_id) throw new Error("Only the machine's admin daemon may do this");
}

/**
 * The admin daemon takes a queued change. For an add it gets the voucher once:
 * the row forgets it here, so a replayed command cannot sign anyone in twice.
 */
export const claimMember = mutation({
  args: { api_token: v.string(), member_id: v.id("team_host_members") },
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.member_id);
    if (!member) return { action: "gone" as const };
    const host = await hostOrThrow(ctx, member.host_id);
    await requireAdminDaemon(ctx, args.api_token, host);
    const user = await ctx.db.get(member.user_id);
    const base = { linux_user: member.linux_user, user_id: member.user_id, github: user?.github_username ?? undefined, ssh_pubkey: member.ssh_pubkey };
    if (member.status === "removing") return { action: "remove" as const, ...base };
    if (member.status !== "joining") return { action: "done" as const };
    if (!member.voucher) return { action: "claimed" as const };
    await ctx.db.patch(member._id, { voucher: undefined, step: "user" });
    return { action: "add" as const, voucher: member.voucher, ...base };
  },
});

/** A step of the admin daemon's work. `error` fails the join; a finished removal deletes the row and the member's device logins. */
export const reportMember = mutation({
  args: { api_token: v.string(), member_id: v.id("team_host_members"), step: v.optional(v.string()), error: v.optional(v.string()), removed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.member_id);
    if (!member) return null;
    const host = await hostOrThrow(ctx, member.host_id);
    await requireAdminDaemon(ctx, args.api_token, host);
    if (args.removed) {
      if (member.device_id) await revokeDeviceLogins(ctx, member.user_id, member.device_id);
      await ctx.db.delete(member._id);
      return null;
    }
    if (args.error) {
      await ctx.db.patch(member._id, { status: member.status === "removing" ? "removing" : "failed", error: args.error.slice(0, 500) });
      return null;
    }
    if (member.status === "joining" && args.step) await ctx.db.patch(member._id, { step: args.step });
    return null;
  },
});

/** Delete the tokens bound to one of a person's devices, and the device row: a removed member's daemon is signed out for good. */
async function revokeDeviceLogins(ctx: MutationCtx, userId: Id<"users">, deviceId: string) {
  const tokens = await ctx.db.query("api_tokens").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  for (const t of tokens) if (t.device_id === deviceId) await ctx.db.delete(t._id);
  const device = await ctx.db.query("devices").withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId)).first();
  if (device) await ctx.db.delete(device._id);
  await ctx.scheduler.runAfter(0, internal.capabilityState.deleteDeviceState, { user_id: userId, device_id: deviceId });
}

// ---------------------------------------------------------------------------
// Every daemon on the box: the heartbeat link
// ---------------------------------------------------------------------------

/**
 * A daemon beat from a team machine (its marker's key, the Linux user it runs
 * as). The one way a member becomes ready: a joined member's new daemon and a
 * hand-made one on an older box converge on the same row. Returns the
 * machine's name, which the device takes as its label, or null when the key
 * names no machine or the person is not on its team. Writes only on change.
 */
export async function linkTeamHostBeat(
  ctx: MutationCtx,
  userId: Id<"users">,
  deviceId: string,
  beat: { key: string; linux_user: string },
): Promise<{ name: string } | null> {
  if (!isHostKey(beat.key) || !isLinuxUserName(beat.linux_user)) return null;
  const host = await ctx.db.query("team_hosts").withIndex("by_host_key", (q: any) => q.eq("host_key", beat.key)).first();
  if (!host || !(await isTeamMember(ctx, userId, host.team_id))) return null;
  const now = Date.now();
  if (host.admin_user_id === userId && host.admin_linux_user === beat.linux_user && host.admin_device_id !== deviceId) {
    await ctx.db.patch(host._id, { admin_device_id: deviceId });
  }
  const members = await membersOf(ctx, host._id);
  const mine = members.find((m) => m.user_id === userId);
  if (!mine) {
    if (members.some((m) => m.linux_user === beat.linux_user)) return null;
    await ctx.db.insert("team_host_members", {
      host_id: host._id, user_id: userId, linux_user: beat.linux_user, device_id: deviceId,
      status: "ready", requested_at: now, ready_at: now,
    });
  } else if (mine.status !== "removing" && (mine.status !== "ready" || mine.device_id !== deviceId || mine.linux_user !== beat.linux_user)) {
    await ctx.db.patch(mine._id, {
      status: "ready", device_id: deviceId, linux_user: beat.linux_user,
      step: undefined, error: undefined, voucher: undefined, ready_at: mine.ready_at ?? now,
    });
  }
  return { name: host.name };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What one member is running, from their own daemon's last resource report:
 * the agent processes it attributes to their sessions. Rounded, so a report
 * that moved nothing visible leaves the list unchanged for its subscribers.
 */
function memberUsage(snapshot: MachineResourceSnapshot | undefined) {
  if (!snapshot) return null;
  const sessions = new Set<string>();
  let cpu = 0;
  let rss = 0;
  for (const p of snapshot.processes) {
    if (!p.sessionId) continue;
    sessions.add(p.sessionId);
    cpu += p.cpu;
    rss += p.rss;
  }
  return { sessions: sessions.size, cpu: Math.round(cpu / 5) * 5, mem_gb: round1(rss / GB) };
}

/** The whole machine, from the freshest member report: every daemon there samples the same box. */
function machineLoad(rows: Array<{ received_at: number; snapshot: MachineResourceSnapshot }>, now: number) {
  const fresh = rows.filter((r) => now - r.received_at < 5 * 60_000).sort((a, b) => b.received_at - a.received_at)[0];
  if (!fresh) return null;
  const s = fresh.snapshot.sample;
  return {
    cpus: s.logicalCpus,
    cpu_pct: s.cpuPercent === undefined ? undefined : Math.round(s.cpuPercent / 5) * 5,
    mem_free_gb: round1(s.memoryAvailable / GB),
    mem_total_gb: Math.round(s.memoryTotal / GB),
    busy: cpuBusy(s) || s.pressure === "critical" || s.pressure === "elevated",
  };
}

export async function listTeamHostsFor(ctx: QueryCtx, userId: Id<"users">) {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const now = Date.now();
  const out = [];
  for (const membership of memberships) {
    const team = await ctx.db.get(membership.team_id);
    if (!team) continue;
    const hosts = await ctx.db.query("team_hosts").withIndex("by_team", (q: any) => q.eq("team_id", membership.team_id)).collect();
    for (const host of hosts) {
      const members = await membersOf(ctx, host._id);
      const reports: Array<{ received_at: number; snapshot: MachineResourceSnapshot }> = [];
      const rows = [];
      for (const m of members) {
        const person = await ctx.db.get(m.user_id);
        const device = m.device_id
          ? await ctx.db.query("devices").withIndex("by_user_device", (q: any) => q.eq("user_id", m.user_id).eq("device_id", m.device_id)).first()
          : null;
        const report = m.device_id
          ? await ctx.db.query("machine_resources").withIndex("by_user_device", (q: any) => q.eq("user_id", m.user_id).eq("device_id", m.device_id)).first()
          : null;
        if (report) reports.push(report as any);
        const online = !!device && now - device.last_seen < DEVICE_ONLINE_MS;
        rows.push({
          _id: m._id,
          user_id: m.user_id,
          name: person?.name ?? person?.email ?? "Someone",
          image: person?.image ?? undefined,
          linux_user: m.linux_user,
          status: m.status,
          step: m.step ?? undefined,
          error: m.error ?? undefined,
          // A join the box never answered: its daemon is down or the install hung.
          stalled: m.status === "joining" && now - m.requested_at > TEAM_HOST_JOIN_STALE_MS,
          device_id: m.device_id ?? undefined,
          online,
          // Whether their own Claude login is on the box yet (the browser sign-in
          // finishes a join); the account itself only to its owner.
          claude_signed_in: !!device?.cc_accounts?.active_email,
          claude_email: m.user_id === userId ? device?.cc_accounts?.active_email ?? undefined : undefined,
          // The viewer's own Claude sign-in on the box, while one runs: the
          // code-paste page to open and the flow to answer (submitLoginCode).
          login_flow: m.user_id === userId && device?.cc_login_flow
            ? { status: device.cc_login_flow.status, url: device.cc_login_flow.url, started_at: device.cc_login_flow.started_at, reason: device.cc_login_flow.reason }
            : undefined,
          usage: online && report ? memberUsage((report as any).snapshot) : null,
          is_admin: m.user_id === host.admin_user_id && m.linux_user === host.admin_linux_user,
        });
      }
      const admin = rows.find((r) => r.is_admin);
      out.push({
        _id: host._id,
        team_id: host.team_id,
        team_name: team.name,
        name: host.name,
        address: host.address ?? undefined,
        platform: host.platform,
        admin_name: admin?.name ?? "the admin",
        admin_linux_user: host.admin_linux_user,
        // Joins and removals run on the admin daemon: offline, they wait.
        admin_online: admin?.online ?? false,
        can_manage: host.admin_user_id === userId || membership.role === "admin",
        load: machineLoad(reports, now),
        members: rows.sort((a, b) => Number(b.is_admin) - Number(a.is_admin) || a.linux_user.localeCompare(b.linux_user)),
        created_at: host.created_at,
      });
    }
  }
  return out;
}

/** Every team machine on the viewer's teams, with its members and load: the web feeder and `cast hosts team ls`. */
export const list = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token).catch(() => null);
    return userId ? listTeamHostsFor(ctx, userId) : [];
  },
});
