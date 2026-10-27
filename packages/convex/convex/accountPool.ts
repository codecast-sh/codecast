// The team's shared account pool (ct-73280). A person opens one of their
// Claude accounts to a team the way device_shares opens a machine: one
// account_shares row per account per team, written as a whole set by
// setAccountShares, counted only while the contributor is on the team.
//
// The account's minted setup-token is the shared credential: a fixed one-year
// bearer that never rotates, so any number of machines can hold it without
// stranding a login. It never reaches the server in plain text. The holder
// (the contributor's machine that keeps the token) seals a copy to each
// teammate machine's provider_key_pubkey (account_pool_copies); that machine
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


/** The profile name a pool copy takes on a teammate's machine. The daemon
 *  suffixes it when the name is already taken there. */
export function poolProfileName(email: string): string {
  const local = normalizeEmail(email).split("@")[0].replace(/[^a-z0-9._-]/g, "") || "account";
  return `pool-${local}`.slice(0, 41);
}

/** One account in one team's pool, as the web keys it before the server row exists. */
export const poolShareKey = (email: string, teamId: string) => `${normalizeEmail(email)}|${teamId}`;

/** A share counts while its contributor is still on its team. */
export async function shareCounts(ctx: Ctx, share: Share): Promise<boolean> {
  return isTeamMember(ctx, share.user_id, share.team_id);
}

/** May `userId`'s machines draw on this share? Both people on the team. */
export async function mayDraw(ctx: Ctx, share: Share, userId: Id<"users">): Promise<boolean> {
  return (await shareCounts(ctx, share)) && (await isTeamMember(ctx, userId, share.team_id));
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

async function holderDevice(ctx: Ctx, share: Share): Promise<Doc<"devices"> | null> {
  return ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", share.user_id).eq("device_id", share.holder_device_id))
    .first();
}

/**
 * The machines that should hold a copy of a share: every member's machine
 * that can receive a sealed secret and was seen recently. Not the holder, not
 * a machine that already keeps the account as its own login, and not a cloud
 * host managed by a laptop: a host runs whatever its laptop's fleet store
 * carries, pool accounts included, so it needs no copy of its own.
 */
export async function eligibleTargets(ctx: Ctx, share: Share, now: number): Promise<Doc<"devices">[]> {
  const members = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", share.team_id))
    .collect();
  const out: Doc<"devices">[] = [];
  for (const m of members) {
    const devices: Doc<"devices">[] = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", m.user_id))
      .collect();
    for (const d of devices) {
      if (d.device_id === share.holder_device_id && d.user_id === share.user_id) continue;
      if (d.is_remote || !d.provider_key_pubkey || now - (d.last_seen ?? 0) > POOL_DEVICE_STALE_MS) continue;
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
 * setup-token, because the token is what travels. Closing deletes every copy;
 * each machine drops its profile on its next pool pass.
 */
export async function performSetAccountShares(
  ctx: any,
  userId: Id<"users">,
  deviceId: string,
  emailIn: string,
  teamIds: string[],
) {
  const email = normalizeEmail(emailIn);
  const wanted = new Set(teamIds);
  const existing: Share[] = await ctx.db
    .query("account_shares")
    .withIndex("by_user_email", (q: any) => q.eq("user_id", userId).eq("email", email))
    .collect();
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
    if (row.holder_device_id !== deviceId) {
      // The account moved to another of the person's machines: copies sealed
      // by the old holder stay good (same token or not, the new holder
      // reseals on its next pass when the stored time differs).
      await ctx.db.patch(row._id, { holder_device_id: deviceId });
    }
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
      shared_at: now,
    });
  }
  return { email, shared_team_ids: [...wanted].sort() };
}

async function deleteShare(ctx: any, share: Share) {
  const copies = await ctx.db.query("account_pool_copies").withIndex("by_share", (q: any) => q.eq("share_id", share._id)).collect();
  for (const c of copies) await ctx.db.delete(c._id);
  await ctx.db.delete(share._id);
}

/** `cast accounts share`: the web writes the same fact through the store's
 *  setAccountShares dispatch. */
export const setAccountShares = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), email: v.string(), team_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    return performSetAccountShares(ctx, userId, args.device_id, args.email, args.team_ids);
  },
});

// ---------------------------------------------------------------------------
// The daemon's pool pass
// ---------------------------------------------------------------------------

/**
 * What one machine must do for the pool, asked each heartbeat: as a holder,
 * which teammate machines still need a sealed copy of which account (with
 * their public keys); as a drawer, the copies sealed to it. A share that
 * stopped counting, for either person, returns nothing, so the machine drops
 * its copy. Ciphertext is returned only to the machine it was sealed to.
 */
export const poolForDevice = query({
  args: { api_token: v.optional(v.string()), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const now = Date.now();
    const held: Share[] = (await ctx.db
      .query("account_shares")
      .withIndex("by_user_email", (q: any) => q.eq("user_id", userId))
      .collect()).filter((s: Share) => s.holder_device_id === args.device_id);
    const seal = [];
    for (const share of held) {
      if (!(await shareCounts(ctx, share))) continue;
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
    const copies = [];
    for (const copy of mine) {
      const share: Share | null = await ctx.db.get(copy.share_id);
      if (!share || !(await mayDraw(ctx, share, userId))) continue;
      const contributor = await ctx.db.get(share.user_id);
      const holder = holderProfile(await holderDevice(ctx, share), share.email);
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

/** The holder hands over copies it sealed for some of a share's targets. */
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
    if (!share || share.user_id !== userId || share.holder_device_id !== args.device_id) throw new Error("Not this machine's shared account");
    if (!(await shareCounts(ctx, share))) return { stored: 0 };
    const now = Date.now();
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
 * Every account in the pools of the viewer's teams, with its contributor, the
 * holder's meter, how many machines hold a copy, and who spent it over the
 * last POOL_SPLIT_DAYS. The per-person split is visible to every member
 * (sd-1687). Feeds the store's accountPool collection.
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
    const rows = [];
    for (const m of memberships) {
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id)).collect();
      const memberIds = new Set(members.map((x: any) => String(x.user_id)));
      const shares: Share[] = await ctx.db.query("account_shares").withIndex("by_team", (q: any) => q.eq("team_id", m.team_id)).collect();
      for (const share of shares) {
        if (!memberIds.has(String(share.user_id))) continue;
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
        rows.push({
          _id: share._id,
          // The natural key the web's optimistic share stub carries (rowKey).
          share_key: poolShareKey(share.email, share.team_id),
          team_id: share.team_id,
          user_id: share.user_id,
          contributor_name: await nameOf(share.user_id),
          mine: share.user_id === userId,
          email: share.email,
          holder_device_id: share.holder_device_id,
          profile_name: holder?.name ?? null,
          tier: holder?.tier ?? null,
          subscription: holder?.subscription ?? null,
          usage: holder?.usage ?? null,
          machines: copies.filter((c: any) => memberIds.has(String(c.user_id))).length,
          shared_at: share.shared_at,
          split,
        });
      }
    }
    return rows;
  },
});
