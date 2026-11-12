// The account pool (ct-73280). Two separate things share one table:
//
// - The personal pool. Every Claude account one of a person's machines holds
//   with a setup-token reaches all of their machines by default, cloud hosts
//   included: a personal account_shares row (no team) that
//   ensurePersonalShares writes with no step from them. Its device_ids
//   narrows it to chosen machines (setAccountDevices).
// - Team pools. A person opens an account to a team the way device_shares
//   opens a machine: one row per account per team, written as a whole set by
//   setAccountShares, counted only while the contributor is on the team. It
//   reaches teammates' machines, and with the "line" label the line hosts.
//
// One of the owner's machines draws an account through exactly one row
// (servingRow), so it never holds two copies of it.
//
// The account's minted setup-token is the shared credential: a fixed one-year
// bearer that never rotates, so any number of machines can hold it without
// stranding a login. It never reaches the server in plain text. The holder
// (any of the contributor's machines that keeps the token, sealerFor) seals a
// copy to each drawing machine's provider_key_pubkey (account_pool_copies); that machine
// opens it and keeps the account as a `pool-…` profile, so the fleet store,
// pins and auto-switch treat it as one more saved account. Usage has one
// home, the holder's heartbeat; a copy carries none, and every read of a pool
// profile's meter goes through poolUsageOverlay.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { isTeamMember } from "./privacy";
import { profileHasSetupToken } from "./ccAccountsShared";
import { normalizeEmail } from "./lib/sessionAccount";
export { normalizeEmail };
import { dayStartUtc } from "./lib/userSend";

type Ctx = { db: any };
type Share = Doc<"account_shares">;

/** A machine that has not been seen for this long gets no copy. */
export const POOL_DEVICE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** The per-person split covers this many trailing days. */
export const POOL_SPLIT_DAYS = 7;
/** A holder unseen this long stops sealing; another of the owner's machines with the token takes over. */
export const SEALER_STALE_MS = 3 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;


/** The profile name a pool copy takes on a teammate's machine. The daemon
 *  suffixes it when the name is already taken there. */
export function poolProfileName(email: string): string {
  const local = normalizeEmail(email).split("@")[0].replace(/[^a-z0-9._-]/g, "") || "account";
  return `pool-${local}`.slice(0, 41);
}

/** The pool label that opens a share to the team's line hosts. */
export const LINE_POOL = "line";
/** Every label a share may carry. */
export const POOL_LABELS: readonly string[] = [LINE_POOL];

type HoldingDevice = Pick<Doc<"devices">, "device_id" | "is_remote" | "line_slots" | "user_id">;

const runsLineWork = (device: Pick<Doc<"devices">, "is_remote" | "line_slots">) => !!device.is_remote && !!device.line_slots?.length;
const oldest = (rows: Share[]) => [...rows].sort((a, b) => a._creationTime - b._creationTime)[0];

/**
 * The one row of an account that puts it on one of its owner's machines: the
 * personal row when it reaches the machine (no device list, or the machine on
 * it); else, on a host running line work, the oldest line-labelled team row.
 * An account with no personal row yet (shared before the personal pool
 * existed) reaches the owner's machines through its oldest team row until
 * ensurePersonalShares writes one. `rows` is every row of the account's.
 */
export function servingRow(rows: Share[], device: HoldingDevice): Share | undefined {
  const personal = rows.find((r) => !r.team_id);
  if (personal) {
    if (!personal.device_ids || personal.device_ids.includes(device.device_id)) return personal;
  } else if (!runsLineWork(device)) {
    return oldest(rows);
  }
  if (!runsLineWork(device)) return undefined;
  return oldest(rows.filter((r) => r.team_id && r.pools?.includes(LINE_POOL)));
}

/** May this machine hold a copy of the share? One of the owner's through
 *  servingRow (`ownerRows`: every row of the account's). A teammate's: every
 *  personal machine of a team share, and a cloud host only when the share is
 *  in the line pool and the host runs line work. A personal row reaches no
 *  one else. */
export function deviceMayHold(share: Share, device: HoldingDevice, ownerRows: Share[] = [share]): boolean {
  if (String(device.user_id) === String(share.user_id)) return servingRow(ownerRows, device)?._id === share._id;
  if (!share.team_id) return false;
  if (!device.is_remote) return true;
  return !!share.pools?.includes(LINE_POOL) && runsLineWork(device);
}

/** One account in one pool, as the web keys it before the server row exists. */
export const poolShareKey = (email: string, teamId?: string | null) => `${normalizeEmail(email)}|${teamId ?? "personal"}`;

/** A team share counts while its contributor is still on its team; a personal one always. */
export async function shareCounts(ctx: Ctx, share: Share): Promise<boolean> {
  return !share.team_id || isTeamMember(ctx, share.user_id, share.team_id);
}

/** May `userId`'s machines draw on this share? The owner's always; a
 *  teammate's while both people are on the team. */
export async function mayDraw(ctx: Ctx, share: Share, userId: Id<"users">): Promise<boolean> {
  if (String(userId) === String(share.user_id)) return true;
  if (!share.team_id) return false;
  return (await shareCounts(ctx, share)) && (await isTeamMember(ctx, userId, share.team_id));
}

/** Every row of one account: what servingRow decides between. */
async function accountRows(ctx: Ctx, userId: Id<"users">, email: string): Promise<Share[]> {
  return ctx.db.query("account_shares").withIndex("by_user_email", (q: any) => q.eq("user_id", userId).eq("email", email)).collect();
}

/** The holder's own profile for the shared account, or undefined. */
function holderProfile(holder: Doc<"devices"> | null, email: string) {
  return holder?.cc_accounts?.profiles.find((p) => !p.pool_share_id && p.email && normalizeEmail(p.email) === email);
}

/** A share by the id a heartbeat reported, or null for one that is gone or malformed. */
async function shareById(ctx: Ctx, id: string): Promise<Share | null> {
  try {
    const row = await ctx.db.get(id as Id<"account_shares">);
    return row && "holder_device_id" in row ? row : null;
  } catch {
    return null;
  }
}

async function ownerDevices(ctx: Ctx, userId: Id<"users">): Promise<Doc<"devices">[]> {
  return ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
}

/**
 * The machine that seals a share's copies, and whose meter is the account's:
 * the stored holder while it keeps a live setup-token and was seen lately,
 * else the owner's machine with one that was seen most recently, else the
 * stored holder (its copies stand; nobody can reseal). An account is never
 * stranded on one laptop.
 */
export function sealerFor(share: Pick<Share, "email" | "holder_device_id">, devices: Doc<"devices">[], now: number): Doc<"devices"> | null {
  const fresh = devices
    .filter((d) => profileHasSetupToken(holderProfile(d, share.email), now) && now - (d.last_seen ?? 0) < SEALER_STALE_MS)
    .sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
  return fresh.find((d) => d.device_id === share.holder_device_id) ?? fresh[0] ?? devices.find((d) => d.device_id === share.holder_device_id) ?? null;
}

async function holderDevice(ctx: Ctx, share: Share, now = Date.now()): Promise<Doc<"devices"> | null> {
  return sealerFor(share, await ownerDevices(ctx, share.user_id), now);
}

/**
 * The machines that should hold a copy of a share: every machine that may hold
 * it (deviceMayHold: the owner's through servingRow, a teammate's while
 * the share counts), can receive a sealed secret and was seen recently. Not a
 * machine that keeps the account as its own login, the sealer included.
 */
export async function eligibleTargets(ctx: Ctx, share: Share, now: number): Promise<Doc<"devices">[]> {
  const rows = await accountRows(ctx, share.user_id, share.email);
  const userIds = new Set<string>([String(share.user_id)]);
  if (share.team_id && (await shareCounts(ctx, share))) {
    const members = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", share.team_id))
      .collect();
    for (const m of members) userIds.add(String(m.user_id));
  }
  const out: Doc<"devices">[] = [];
  for (const uid of userIds) {
    const devices = await ownerDevices(ctx, uid as Id<"users">);
    for (const d of devices) {
      if (!deviceMayHold(share, d, rows) || !d.provider_key_pubkey || now - (d.last_seen ?? 0) > POOL_DEVICE_STALE_MS) continue;
      if (holderProfile(d, share.email)) continue;
      out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sharing (Settings → Claude Accounts pill, `cast accounts share`)
// ---------------------------------------------------------------------------

/**
 * Open one of the caller's accounts to exactly `teamIds` (empty closes it),
 * kept on `deviceId`. Same contract as performSetDeviceShares: the whole set
 * is written, so a toggle is idempotent and a retried dispatch lands the same
 * state. The account must be a saved profile on that machine with a live
 * setup-token, because the token is what travels. Closing deletes the team's
 * copies; each machine drops its profile on its next pool pass. The personal
 * row is not this function's: the owner's machines keep the account through
 * every change here. `pools` sets the
 * labels of the named teams' shares (POOL_LABELS; an empty list clears them);
 * a team it does not name keeps the labels it has.
 */
export async function performSetAccountShares(
  ctx: any,
  userId: Id<"users">,
  deviceId: string,
  emailIn: string,
  teamIds: string[],
  pools: Record<string, string[]> = {},
) {
  const email = normalizeEmail(emailIn);
  const wanted = new Set(teamIds);
  for (const labels of Object.values(pools)) {
    const unknown = labels.filter((l) => !POOL_LABELS.includes(l));
    if (unknown.length) throw new Error(`Unknown pool ${unknown.join(", ")} (known: ${POOL_LABELS.join(", ")})`);
  }
  const labelsFor = (teamId: string) => {
    const labels = [...new Set(pools[teamId] ?? [])].sort();
    return labels.length ? labels : undefined;
  };
  const existing = (await accountRows(ctx, userId, email)).filter((r) => r.team_id);
  if (wanted.size > 0) {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId))
      .first();
    if (!device) throw new Error("Unknown device");
    const profile = holderProfile(device, email);
    if (!profile) throw new Error(`${email} is not a saved account on that machine`);
    if (!profileHasSetupToken(profile, Date.now())) {
      throw new Error(`${email} has no live setup-token on that machine. Mint one first (Settings → Claude Accounts → token)`);
    }
    for (const teamId of wanted) {
      if (!(await isTeamMember(ctx, userId, teamId as Id<"teams">))) {
        throw new Error("You can only share an account with a team you are on");
      }
    }
  }
  const have = new Set<string>();
  for (const row of existing) {
    const key = String(row.team_id);
    if (!wanted.has(key) || have.has(key)) {
      await deleteShare(ctx, row);
      continue;
    }
    have.add(key);
    await settleRow(ctx, row, { holder_device_id: deviceId, ...(key in pools ? { pools: labelsFor(key) } : {}) });
  }
  const now = Date.now();
  for (const teamId of wanted) {
    if (have.has(teamId)) continue;
    await ctx.db.insert("account_shares", {
      user_id: userId,
      provider: "claude",
      email,
      holder_device_id: deviceId,
      team_id: teamId as Id<"teams">,
      ...(labelsFor(teamId) ? { pools: labelsFor(teamId) } : {}),
      shared_at: now,
    });
  }
  return { email, shared_team_ids: [...wanted].sort() };
}

/** Patch a kept row. A holder change keeps every copy (the new holder
 *  reseals on its next pass when the stored time differs); a team or label
 *  change takes copies off machines that may no longer hold it. */
async function settleRow(ctx: any, row: Share, patch: Partial<Pick<Share, "holder_device_id" | "pools" | "device_ids">>) {
  const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => JSON.stringify(row[k] ?? null) !== JSON.stringify(patch[k] ?? null));
  if (!changed.length) return;
  await ctx.db.patch(row._id, Object.fromEntries(changed.map((k) => [k, patch[k]])));
  if (changed.some((k) => k !== "holder_device_id")) await dropCopiesNoLongerHeld(ctx, { ...row, ...patch });
}

/** A label or device taken off a share takes its copies off the machines that
 *  may no longer hold it; each drops the profile on its next pool pass. */
async function dropCopiesNoLongerHeld(ctx: any, share: Share) {
  const rows = (await accountRows(ctx, share.user_id, share.email)).map((r) => (r._id === share._id ? share : r));
  const copies = await ctx.db.query("account_pool_copies").withIndex("by_share", (q: any) => q.eq("share_id", share._id)).collect();
  for (const c of copies) {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", c.user_id).eq("device_id", c.device_id))
      .first();
    if (device && !deviceMayHold(share, device, rows)) await ctx.db.delete(c._id);
  }
}

/**
 * Narrow one of the caller's accounts to `deviceIds` among their own
 * machines, or open it to all of them again (null). An empty list keeps it
 * only on the machines that hold it themselves. Teams and the line pool are
 * untouched: they are separate grants (setAccountShares). Copies on machines
 * taken off the list go now; each drops its profile on its next pool pass.
 */
export async function performSetAccountDevices(ctx: any, userId: Id<"users">, emailIn: string, deviceIds: string[] | null) {
  const email = normalizeEmail(emailIn);
  const personal = (await accountRows(ctx, userId, email)).find((r) => !r.team_id);
  if (!personal) throw new Error(`${email} is not in your pool: none of your machines holds it with a setup-token`);
  let next: string[] | undefined;
  if (deviceIds) {
    const mine = new Set((await ownerDevices(ctx, userId)).map((d) => d.device_id));
    const unknown = deviceIds.filter((id) => !mine.has(id));
    if (unknown.length) throw new Error(`Not your machine: ${unknown.join(", ")}`);
    next = [...new Set(deviceIds)].sort();
  }
  await settleRow(ctx, personal, { device_ids: next });
  return { email, device_ids: next ?? null };
}

/** `cast accounts devices`: the web writes the same fact through the store's
 *  setAccountDevices dispatch. */
export const setAccountDevices = mutation({
  args: { api_token: v.optional(v.string()), email: v.string(), device_ids: v.union(v.array(v.string()), v.null()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performSetAccountDevices(ctx, userId, args.email, args.device_ids);
  },
});

async function deleteShare(ctx: any, share: Share) {
  const copies = await ctx.db.query("account_pool_copies").withIndex("by_share", (q: any) => q.eq("share_id", share._id)).collect();
  for (const c of copies) await ctx.db.delete(c._id);
  await ctx.db.delete(share._id);
}

/** `cast accounts share`: the web writes the same fact through the store's
 *  setAccountShares dispatch. */
export const setAccountShares = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    email: v.string(),
    team_ids: v.array(v.string()),
    // Team id -> pool labels for that team's share (performSetAccountShares).
    pools: v.optional(v.record(v.string(), v.array(v.string()))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performSetAccountShares(ctx, userId, args.device_id, args.email, args.team_ids, args.pools);
  },
});

// ---------------------------------------------------------------------------
// The daemon's pool pass
// ---------------------------------------------------------------------------

/**
 * What one machine must do for the pool, asked each pass: as the sealer of an
 * account (sealerFor), which machines still need a sealed copy of it (with
 * their public keys); as a drawer, the copies sealed to it. A share it may no
 * longer draw on returns nothing, so the machine drops its copy. Ciphertext
 * is returned only to the machine it was sealed to.
 */
export const poolForDevice = query({
  args: { api_token: v.optional(v.string()), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const now = Date.now();
    const devices = await ownerDevices(ctx, userId);
    const own: Share[] = await ctx.db.query("account_shares").withIndex("by_user_email", (q: any) => q.eq("user_id", userId)).collect();
    const held = own.filter((s) => sealerFor(s, devices, now)?.device_id === args.device_id);
    const rowsOf = (email: string) => own.filter((s) => s.email === email);
    const seal = [];
    for (const share of held) {
      const copies = await ctx.db.query("account_pool_copies").withIndex("by_share", (q: any) => q.eq("share_id", share._id)).collect();
      const targets = (await eligibleTargets(ctx, share, now)).map((d) => ({
        device_id: d.device_id,
        pubkey: d.provider_key_pubkey!,
        // A copy sealed to an older key of the machine counts as missing.
        token_stored_at: copies.find((c: any) => c.device_id === d.device_id && c.user_id === d.user_id && c.pubkey === d.provider_key_pubkey)?.token_stored_at ?? null,
      }));
      seal.push({ share_id: share._id, email: share.email, targets });
    }
    const mine = await ctx.db
      .query("account_pool_copies")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .collect();
    const self = devices.find((d) => d.device_id === args.device_id);
    const copies = [];
    for (const copy of mine) {
      const share: Share | null = await ctx.db.get(copy.share_id);
      if (!share || !(await mayDraw(ctx, share, userId))) continue;
      // A host that stopped running line work, a share taken out of the line
      // pool, a machine taken off the account's device list, or a row of
      // one's own account that no longer serves this machine: drop the copy.
      // Kept while the row now serving the machine has no copy for it yet,
      // so a move between rows never leaves the machine without the account.
      const ownShare = share.user_id === userId;
      if (self && !deviceMayHold(share, self, ownShare ? rowsOf(share.email) : [share])) {
        const serving = ownShare ? servingRow(rowsOf(share.email), self) : undefined;
        if (!serving || mine.some((c: any) => c.share_id === serving._id)) continue;
      }
      const contributor = await ctx.db.get(share.user_id);
      const holder = holderProfile(ownShare ? sealerFor(share, devices, now) : await holderDevice(ctx, share, now), share.email);
      copies.push({
        share_id: share._id,
        email: share.email,
        name: poolProfileName(share.email),
        contributor_name: contributor?.name ?? contributor?.email ?? "a teammate",
        tier: holder?.tier,
        subscription: holder?.subscription,
        token_stored_at: copy.token_stored_at,
        sealed: copy.sealed,
      });
    }
    return { seal, copies };
  },
});

/** The sealer hands over copies it sealed for some of a share's targets, and
 *  becomes the share's stored holder when it took over from another machine. */
export const storePoolCopies = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    share_id: v.id("account_shares"),
    token_stored_at: v.number(),
    copies: v.array(v.object({
      device_id: v.string(),
      sealed: v.object({ provider: v.string(), epk: v.string(), iv: v.string(), ct: v.string() }),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const share: Share | null = await ctx.db.get(args.share_id);
    const now = Date.now();
    if (!share || share.user_id !== userId || sealerFor(share, await ownerDevices(ctx, userId), now)?.device_id !== args.device_id) {
      throw new Error("Not this machine's shared account");
    }
    if (share.holder_device_id !== args.device_id) await ctx.db.patch(share._id, { holder_device_id: args.device_id });
    const targets = new Map((await eligibleTargets(ctx, share, now)).map((d) => [d.device_id, d]));
    const existing = await ctx.db.query("account_pool_copies").withIndex("by_share", (q: any) => q.eq("share_id", share._id)).collect();
    let stored = 0;
    for (const c of args.copies) {
      const device = targets.get(c.device_id);
      if (!device) continue;
      const row = { sealed: c.sealed, token_stored_at: args.token_stored_at, sealed_at: now, pubkey: device.provider_key_pubkey };
      const prior = existing.find((e: any) => e.device_id === c.device_id && e.user_id === device.user_id);
      if (prior) await ctx.db.patch(prior._id, row);
      else await ctx.db.insert("account_pool_copies", { share_id: share._id, user_id: device.user_id, device_id: c.device_id, ...row });
      stored++;
    }
    return { stored };
  },
});

// ---------------------------------------------------------------------------
// Reading the pool
// ---------------------------------------------------------------------------

/**
 * A machine's saved profiles with every pool copy read through its share: the
 * holder's meter in place of none, and copies whose share no longer counts
 * for `userId` left out (the machine has not dropped them yet). Auto-switch
 * and the web read a pool profile's usage only through here.
 */
export async function poolUsageOverlay<P extends { pool_share_id?: string; usage?: any }>(
  ctx: Ctx,
  userId: Id<"users">,
  profiles: readonly P[],
): Promise<P[]> {
  if (!profiles.some((p) => p.pool_share_id)) return [...profiles];
  const out: P[] = [];
  for (const p of profiles) {
    if (!p.pool_share_id) { out.push(p); continue; }
    const share = await shareById(ctx, p.pool_share_id);
    if (!share || !(await mayDraw(ctx, share, userId))) continue;
    const holder = holderProfile(await holderDevice(ctx, share), share.email);
    out.push({ ...p, usage: holder?.usage });
  }
  return out;
}

/**
 * Every account in the pools of the viewer's teams, and the viewer's own
 * accounts in no team's pool (team_id null: their machines alone), with the
 * contributor, the sealer's meter, how many machines hold a copy, and who
 * spent it over the last POOL_SPLIT_DAYS. The per-person split is visible to
 * every member (sd-1687). Feeds the store's accountPool collection.
 */
export const listPool = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
    const cutoff = dayStartUtc(Date.now() - (POOL_SPLIT_DAYS - 1) * 24 * 3600_000);
    const names = new Map<string, string>();
    const nameOf = async (id: Id<"users">) => {
      const key = String(id);
      if (!names.has(key)) {
        const u = await ctx.db.get(id);
        names.set(key, u?.name ?? u?.email ?? "Someone");
      }
      return names.get(key)!;
    };
    const rowFor = async (share: Share, memberIds: Set<string>) => {
      const holder = holderProfile(await holderDevice(ctx, share), share.email);
      const copies = await ctx.db.query("account_pool_copies").withIndex("by_share", (q: any) => q.eq("share_id", share._id)).collect();
      const days = await ctx.db
        .query("account_usage_daily")
        .withIndex("by_email_day", (q: any) => q.eq("email", share.email).gte("day_start", cutoff))
        .collect();
      const byUser = new Map<string, number>();
      for (const d of days) {
        if (!memberIds.has(String(d.user_id))) continue;
        byUser.set(String(d.user_id), (byUser.get(String(d.user_id)) ?? 0) + d.tokens);
      }
      const split = [];
      for (const [uid, tokens] of byUser) split.push({ user_id: uid, name: await nameOf(uid as Id<"users">), tokens });
      split.sort((a, b) => b.tokens - a.tokens);
      return {
        _id: share._id,
        // The natural key the web's optimistic share stub carries (rowKey).
        share_key: poolShareKey(share.email, share.team_id),
        team_id: share.team_id ?? null,
        user_id: share.user_id,
        contributor_name: await nameOf(share.user_id),
        mine: share.user_id === userId,
        email: share.email,
        pools: share.pools ?? [],
        // Personal rows: the machines it is narrowed to, or null for all of them.
        device_ids: share.device_ids ?? null,
        holder_device_id: share.holder_device_id,
        profile_name: holder?.name ?? null,
        tier: holder?.tier ?? null,
        subscription: holder?.subscription ?? null,
        usage: holder?.usage ?? null,
        machines: copies.filter((c: any) => memberIds.has(String(c.user_id))).length,
        shared_at: share.shared_at,
        split,
      };
    };
    const rows = [];
    for (const m of memberships) {
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id)).collect();
      const memberIds = new Set(members.map((x: any) => String(x.user_id)));
      const shares: Share[] = await ctx.db.query("account_shares").withIndex("by_team", (q: any) => q.eq("team_id", m.team_id)).collect();
      for (const share of shares) {
        if (memberIds.has(String(share.user_id))) rows.push(await rowFor(share, memberIds));
      }
    }
    const personal: Share[] = (await ctx.db
      .query("account_shares")
      .withIndex("by_user_email", (q: any) => q.eq("user_id", userId))
      .collect()).filter((s: Share) => !s.team_id);
    for (const share of personal) rows.push(await rowFor(share, new Set([String(userId)])));
    return rows;
  },
});

// ---------------------------------------------------------------------------
// The personal pool: every account on every one of the owner's machines
// ---------------------------------------------------------------------------

type HeartbeatAccounts = { profiles?: Array<{ email?: string; setup_token?: { expires_at: number }; pool_share_id?: string }> } | null | undefined;

/** The accounts a machine keeps as its own with a live setup-token: the ones it can seal. */
function ownTokenEmails(accounts: HeartbeatAccounts, now: number): string[] {
  const out = new Set<string>();
  for (const p of accounts?.profiles ?? []) {
    if (!p.pool_share_id && p.email && profileHasSetupToken(p, now)) out.add(normalizeEmail(p.email));
  }
  return [...out].sort();
}

/**
 * Put every account this machine holds with a live setup-token into its
 * owner's personal pool: an account with no personal row gets one, which
 * seals it to each of the owner's machines (cloud hosts included) with no
 * step from them, whatever teams it is shared with. Runs from the heartbeat when the machine's set of such accounts
 * changes, and once an hour besides, so a row lost some other way (a team
 * deleted with its shares) comes back. Returns the emails it added.
 */
export async function ensurePersonalShares(
  ctx: any,
  userId: Id<"users">,
  deviceId: string,
  accounts: HeartbeatAccounts,
  previous: HeartbeatAccounts,
  lastSeen: number | undefined,
  now: number,
): Promise<string[]> {
  const emails = ownTokenEmails(accounts, now);
  if (!emails.length) return [];
  const changed = emails.join(",") !== ownTokenEmails(previous, now).join(",");
  if (!changed && lastSeen !== undefined && Math.floor(lastSeen / HOUR_MS) === Math.floor(now / HOUR_MS)) return [];
  const rows: Share[] = await ctx.db.query("account_shares").withIndex("by_user_email", (q: any) => q.eq("user_id", userId)).collect();
  const have = new Set(rows.filter((r) => !r.team_id).map((r) => r.email));
  const added = emails.filter((e) => !have.has(e));
  for (const email of added) {
    await ctx.db.insert("account_shares", { user_id: userId, provider: "claude", email, holder_device_id: deviceId, shared_at: now });
  }
  return added;
}
