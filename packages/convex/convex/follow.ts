import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { canAccessConversation } from "./lib/access";

// Follow mode: one person mirrors another's view until they stop.
//
// Two facts, two tables. The FOLLOW is a lease the follower holds on the
// leader (view_follows): started by `follow`, renewed while the follower's
// window is on it, ended by `unfollow` or by silence. The VIEW is the leader's
// place in the app (view_states): written only while someone holds a lease,
// so a person nobody follows writes nothing, the same gate composer presence
// uses. A view names a conversation only to a follower who could open it
// themselves; otherwise the follower learns that the leader is somewhere they
// cannot go, and nothing more.

/** A lease older than this is dead: the follower's window closed or slept. */
export const FOLLOW_LEASE_MS = 30_000;
/** The follower renews at this cadence, well inside the lease. */
export const FOLLOW_RENEW_MS = 10_000;

async function requireAuth(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

async function liveFollowers(ctx: any, leaderId: Id<"users">, now: number) {
  const rows = await ctx.db
    .query("view_follows")
    .withIndex("by_leader", (q: any) => q.eq("leader_id", leaderId).gt("updated_at", now - FOLLOW_LEASE_MS))
    .collect();
  return rows as Array<{ _id: Id<"view_follows">; follower_id: Id<"users">; leader_id: Id<"users">; updated_at: number }>;
}

async function myFollowRow(ctx: any, followerId: Id<"users">) {
  return (await ctx.db
    .query("view_follows")
    .withIndex("by_follower", (q: any) => q.eq("follower_id", followerId))
    .first()) as { _id: Id<"view_follows">; leader_id: Id<"users">; updated_at: number } | null;
}

/** Start or renew following `leader_id`. One leader per follower: a new
 *  leader replaces the old lease. Following yourself is a no op. */
export const follow = mutation({
  args: { leader_id: v.id("users") },
  handler: async (ctx, args) => {
    const me = await requireAuth(ctx);
    if (args.leader_id === me) return;
    const now = Date.now();
    const existing = await myFollowRow(ctx, me);
    if (existing) {
      await ctx.db.patch(existing._id, { leader_id: args.leader_id, updated_at: now });
    } else {
      await ctx.db.insert("view_follows", { follower_id: me, leader_id: args.leader_id, updated_at: now });
    }
  },
});

export const unfollow = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireAuth(ctx);
    const existing = await myFollowRow(ctx, me);
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** The leader's place. Refused (silently) when nobody holds a live lease on
 *  them, so a client that reports on a stale belief writes nothing. */
export const reportView = mutation({
  args: {
    path: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    anchor: v.optional(v.object({ message_id: v.string(), offset: v.number() })),
  },
  handler: async (ctx, args) => {
    const me = await requireAuth(ctx);
    const now = Date.now();
    const followers = await liveFollowers(ctx, me, now);
    if (followers.length === 0) return { written: false };
    const row = {
      path: args.path.slice(0, 512),
      conversation_id: args.conversation_id,
      anchor: args.anchor ? { message_id: args.anchor.message_id.slice(0, 128), offset: Math.min(1, Math.max(0, args.anchor.offset)) } : undefined,
      updated_at: now,
    };
    const existing = await ctx.db.query("view_states").withIndex("by_user", (q: any) => q.eq("user_id", me)).first();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("view_states", { user_id: me, ...row });
    return { written: true };
  },
});

/** Who holds a live lease on me, with names for the pill. */
export const followersOf = query({
  args: {},
  returns: v.array(v.object({ user_id: v.id("users"), name: v.string(), image: v.optional(v.string()) })),
  handler: async (ctx) => {
    const me = await requireAuth(ctx);
    const rows = await liveFollowers(ctx, me, Date.now());
    const out: Array<{ user_id: Id<"users">; name: string; image?: string }> = [];
    for (const r of rows) {
      const u = await ctx.db.get(r.follower_id);
      if (!u) continue;
      out.push({ user_id: r.follower_id, name: u.name || u.email || "Someone", image: u.image || u.github_avatar_url || undefined });
    }
    return out;
  },
});

/** My own lease, if live: the leader I follow. */
export const following = query({
  args: {},
  returns: v.union(v.null(), v.object({ leader_id: v.id("users") })),
  handler: async (ctx) => {
    const me = await requireAuth(ctx);
    const row = await myFollowRow(ctx, me);
    if (!row || row.updated_at <= Date.now() - FOLLOW_LEASE_MS) return null;
    return { leader_id: row.leader_id };
  },
});

/**
 * The leader's view, for a live follower only. A conversation the caller
 * cannot open is withheld along with its path (the path names the id), and
 * `withheld` says so, so the follower's app can say "somewhere you can't go"
 * instead of jumping.
 */
export const viewOf = query({
  args: { leader_id: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({
      path: v.string(),
      conversation_id: v.optional(v.id("conversations")),
      anchor: v.optional(v.object({ message_id: v.string(), offset: v.number() })),
      updated_at: v.number(),
      withheld: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await requireAuth(ctx);
    const lease = await myFollowRow(ctx, me);
    if (!lease || lease.leader_id !== args.leader_id || lease.updated_at <= Date.now() - FOLLOW_LEASE_MS) return null;
    const state = await ctx.db.query("view_states").withIndex("by_user", (q: any) => q.eq("user_id", args.leader_id)).first();
    if (!state) return null;
    if (state.conversation_id) {
      const conversation = await ctx.db.get(state.conversation_id);
      const ok = !!conversation && (await canAccessConversation(ctx, me, conversation as any));
      if (!ok) return { path: "", updated_at: state.updated_at, withheld: true };
    }
    return { path: state.path, conversation_id: state.conversation_id, anchor: state.anchor, updated_at: state.updated_at, withheld: false };
  },
});
