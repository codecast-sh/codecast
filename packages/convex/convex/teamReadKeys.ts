// Team read keys: a team admin mints a named, expiring key in Team settings
// for a server, and the server reads the team's shared session metadata with
// it (lib/teamReadKeyHttp.ts). Minting, revoking and use are authority events,
// so they show in `cast audit` for every member of the team.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTeamAdmin } from "./lib/access";
import { recordAuthorityEvent } from "./lib/authorityEvents";
import { sha256Hex } from "./lib/hash";
import {
  MAX_LIVE_TEAM_READ_KEYS,
  TEAM_READ_KEY_EXPIRY_DAYS,
  TEAM_READ_KEY_PREFIX,
  newTeamReadKey,
} from "./lib/teamReadKey";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Characters of the secret shown in the key list (after the cc_trk_ prefix). */
const KEY_PREFIX_CHARS = 6;

const isLive = (key: Doc<"team_read_keys">, now: number) => !key.revoked_at && key.expires_at > now;

async function requireAdmin(ctx: any, teamId: Id<"teams">): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  await requireTeamAdmin(ctx, userId, teamId);
  return userId;
}

function keysOf(ctx: any, teamId: Id<"teams">): Promise<Doc<"team_read_keys">[]> {
  return ctx.db.query("team_read_keys").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect();
}

/** Admin-only: the team's keys, newest first, without their secrets. Null for anyone else. */
export const list = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .first();
    if (membership?.role !== "admin") return null;
    const keys = await keysOf(ctx, args.team_id);
    const creators = new Map<string, string | null>();
    for (const id of new Set(keys.map((k) => String(k.created_by)))) {
      creators.set(id, (await ctx.db.get(id as Id<"users">))?.name ?? null);
    }
    return keys
      .sort((a, b) => b.created_at - a.created_at)
      .map((k) => ({
        _id: k._id,
        name: k.name,
        prefix: k.prefix,
        created_at: k.created_at,
        created_by_name: creators.get(String(k.created_by)) ?? null,
        expires_at: k.expires_at,
        revoked_at: k.revoked_at ?? null,
        last_used_at: k.last_used_at ?? null,
      }));
  },
});

/** Admin-only: mint a key. The plaintext comes back once and is never stored. */
export const create = mutation({
  args: {
    team_id: v.id("teams"),
    name: v.string(),
    expires_in_days: v.union(...TEAM_READ_KEY_EXPIRY_DAYS.map((d) => v.literal(d))),
  },
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx, args.team_id);
    const team = await ctx.db.get(args.team_id);
    if (!team || team.deleted_at) throw new Error("No such team");
    const now = Date.now();
    if ((await keysOf(ctx, args.team_id)).filter((k) => isLive(k, now)).length >= MAX_LIVE_TEAM_READ_KEYS) {
      throw new ConvexError(`A team can have ${MAX_LIVE_TEAM_READ_KEYS} active read keys. Revoke one to make another.`);
    }
    const key = newTeamReadKey();
    const name = args.name.trim().slice(0, 80) || "Read key";
    const prefix = key.slice(0, TEAM_READ_KEY_PREFIX.length + KEY_PREFIX_CHARS);
    const expiresAt = now + args.expires_in_days * DAY_MS;
    const keyId = await ctx.db.insert("team_read_keys", {
      team_id: args.team_id,
      created_by: userId,
      name,
      key_hash: await sha256Hex(key),
      prefix,
      created_at: now,
      expires_at: expiresAt,
    });
    await recordAuthorityEvent(ctx, {
      kind: "team_read_key_minted",
      actor_user_id: userId,
      team_id: args.team_id,
      detail: { after: { key_id: keyId, name, prefix, expires_at: expiresAt } },
    });
    return { key_id: keyId, key, name, prefix, expires_at: expiresAt };
  },
});

/** Admin-only: the key stops working on its next request. */
export const revoke = mutation({
  args: { key_id: v.id("team_read_keys") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.key_id);
    if (!row) throw new Error("No such key");
    const userId = await requireAdmin(ctx, row.team_id);
    if (row.revoked_at) return;
    await ctx.db.patch(row._id, { revoked_at: Date.now() });
    await recordAuthorityEvent(ctx, {
      kind: "team_read_key_revoked",
      actor_user_id: userId,
      team_id: row.team_id,
      detail: { after: { key_id: row._id, name: row.name, prefix: row.prefix } },
    });
  },
});
