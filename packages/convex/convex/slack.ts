import { mutation, query, internalMutation, internalQuery, action } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthenticatedUserId } from "./pendingMessages";
import { deliverToAnchor, userCanAccessAnchor, visibleAnchorsForUser } from "./anchors";

// The Slack adapter: a workspace maps a channel to its Anchor, so an @mention in
// that channel wakes the anchor (inbound), and the anchor replies as the bot
// (outbound, server-side so the bot token never reaches the anchor's session).
//
// v1 uses a single Slack app: SLACK_SIGNING_SECRET verifies inbound webhooks and
// SLACK_BOT_TOKEN posts replies (both Convex env vars). Channel→anchor mapping is
// per-workspace data in `anchor_channels`. Every act path is authorized against the
// caller's anchors — authentication alone is never enough (multi-tenant boundary).

async function callerAnchor(
  ctx: { db: any },
  userId: Id<"users">,
  scope: "team" | "user",
  teamId?: Id<"teams">,
) {
  if (scope === "team") {
    let resolved = teamId;
    if (!resolved) {
      const host = await ctx.db.get(userId);
      resolved = host?.active_team_id ?? host?.team_id ?? undefined;
    }
    if (!resolved) return null;
    // Only a member may target a team's anchor.
    const member = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", resolved))
      .first();
    if (!member) return null;
    const rows = await ctx.db
      .query("anchors")
      .withIndex("by_team", (q: any) => q.eq("team_id", resolved))
      .collect();
    return rows.find((a: any) => a.status !== "decommissioned") ?? null;
  }
  const rows = await ctx.db
    .query("anchors")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  return rows.find((a: any) => a.status !== "decommissioned") ?? null;
}

async function channelRow(ctx: { db: any }, channel: string) {
  return await ctx.db
    .query("anchor_channels")
    .withIndex("by_surface_channel", (q: any) =>
      q.eq("surface", "slack").eq("channel_key", channel),
    )
    .first();
}

// linkChannel — map a Slack channel to the caller's anchor. If a mapping already
// exists, the caller must already own it (no silent cross-tenant re-pointing).
export const linkChannel = mutation({
  args: {
    api_token: v.optional(v.string()),
    channel: v.string(),
    workspace: v.optional(v.string()),
    team: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await callerAnchor(ctx, userId, args.team ? "team" : "user", args.team_id);
    if (!anchor) throw new Error("No anchor to link. Create one: cast anchor create");

    const existing = await channelRow(ctx, args.channel);
    if (existing) {
      // Re-pointing is only allowed if the caller already controls the current
      // mapping — otherwise this would hijack another anchor's inbound routing.
      const current = await ctx.db.get(existing.anchor_id as Id<"anchors">);
      if (!(await userCanAccessAnchor(ctx, userId, current))) {
        throw new Error("That channel is already linked to an anchor you don't control");
      }
      await ctx.db.patch(existing._id, {
        anchor_id: anchor._id,
        workspace_key: args.workspace,
        project_path: args.project_path,
      });
      return { channel: args.channel, anchor_id: anchor._id, replaced: true };
    }
    await ctx.db.insert("anchor_channels", {
      anchor_id: anchor._id,
      surface: "slack",
      channel_key: args.channel,
      workspace_key: args.workspace,
      project_path: args.project_path,
      created_at: Date.now(),
    });
    return { channel: args.channel, anchor_id: anchor._id, replaced: false };
  },
});

export const unlinkChannel = mutation({
  args: { api_token: v.optional(v.string()), channel: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const row = await channelRow(ctx, args.channel);
    if (!row) return { channel: args.channel, removed: false };
    const anchor = await ctx.db.get(row.anchor_id as Id<"anchors">);
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) {
      throw new Error("That channel is linked to an anchor you don't control");
    }
    await ctx.db.delete(row._id);
    return { channel: args.channel, removed: true };
  },
});

export const listChannels = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const anchors = await visibleAnchorsForUser(ctx, userId);
    const out: any[] = [];
    for (const a of anchors) {
      const chans = await ctx.db
        .query("anchor_channels")
        .withIndex("by_anchor", (q: any) => q.eq("anchor_id", a._id))
        .collect();
      out.push(...chans);
    }
    return out;
  },
});

// callerOwnsChannel — for the postMessage action (actions can't read the db): the
// caller may post to a channel only if they can access the anchor it's mapped to.
export const callerOwnsChannel = internalQuery({
  args: { api_token: v.optional(v.string()), channel: v.string() },
  handler: async (ctx, args): Promise<Id<"users"> | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const row = await channelRow(ctx, args.channel);
    if (!row) return null;
    const anchor = await ctx.db.get(row.anchor_id as Id<"anchors">);
    if (!anchor || anchor.status === "decommissioned") return null;
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) return null;
    return userId;
  },
});

// wakeFromSlackEvent — the whole inbound step in ONE transaction: dedup, resolve
// channel→anchor, and deliver. Because the dedup insert and the wake commit
// together, a wake failure rolls back the dedup row too, so Slack's retry can
// re-drive it (fixes the "mark-seen-before-wake drops the mention" bug).
export const wakeFromSlackEvent = internalMutation({
  args: {
    event_id: v.string(),
    channel: v.string(),
    user: v.optional(v.string()),
    text: v.string(),
    thread: v.string(),
  },
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("slack_events")
      .withIndex("by_event_id", (q: any) => q.eq("event_id", args.event_id))
      .first();
    if (seen) return { status: "duplicate" as const };

    const row = await channelRow(ctx, args.channel);
    const anchor = row ? await ctx.db.get(row.anchor_id as Id<"anchors">) : null;
    if (!anchor || anchor.status === "decommissioned") {
      // Nothing to wake — record the event so Slack stops retrying an unmapped channel.
      await ctx.db.insert("slack_events", { event_id: args.event_id, created_at: Date.now() });
      return { status: "no_anchor" as const };
    }

    const cleaned = String(args.text).replace(/<@[A-Z0-9]+>/g, "").trim();
    const wake = [
      `[Slack message in channel ${args.channel}, thread ${args.thread}]`,
      `<@${args.user ?? "someone"}> said: "${cleaned}"`,
      "",
      "Reply in this Slack thread by running:",
      `  cast anchor say --channel ${args.channel} --thread ${args.thread} "<your reply>"`,
    ].join("\n");
    // Deliver first: if this throws, the whole mutation rolls back (no dedup row
    // written) so Slack's redelivery re-drives the mention.
    await deliverToAnchor(ctx, anchor._id, wake);
    await ctx.db.insert("slack_events", { event_id: args.event_id, created_at: Date.now() });
    return { status: "woke" as const, anchor_id: anchor._id };
  },
});

// sweepSlackEvents — dedup rows only need to outlive Slack's retry window; drop
// the rest so the table can't grow unbounded (cron, see crons.ts).
export const sweepSlackEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = await ctx.db
      .query("slack_events")
      .withIndex("by_created_at", (q: any) => q.lt("created_at", cutoff))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});

// postMessage — outbound reply, server-side so SLACK_BOT_TOKEN never reaches the
// anchor's session. The caller must control the anchor that owns the channel.
export const postMessage = action({
  args: {
    api_token: v.optional(v.string()),
    channel: v.string(),
    thread_ts: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const userId = await ctx.runQuery(internal.slack.callerOwnsChannel, {
      api_token: args.api_token,
      channel: args.channel,
    });
    if (!userId) return { ok: false, error: "Not authorized to post to this channel" };
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not configured" };
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: args.channel, thread_ts: args.thread_ts, text: args.text }),
    });
    const data = (await resp.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error };
  },
});
