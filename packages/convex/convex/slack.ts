import { mutation, query, internalMutation, internalQuery, action } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";

// The Slack adapter: a workspace can map a channel to its Anchor, so an @mention
// in that channel wakes the anchor (inbound), and the anchor replies as the bot
// (outbound, server-side so the bot token never reaches the anchor's session).
//
// v1 uses a single Slack app: SLACK_SIGNING_SECRET verifies inbound webhooks and
// SLACK_BOT_TOKEN posts replies (both Convex env vars). Channel→anchor mapping is
// per-workspace data in `anchor_channels`. Multi-workspace bot tokens are a later
// refinement.

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

// linkChannel — map a Slack channel to the caller's anchor. Backs
// `cast anchor link-channel`.
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
    const anchor = await callerAnchor(
      ctx,
      userId,
      args.team ? "team" : "user",
      args.team_id,
    );
    if (!anchor) throw new Error("No anchor to link. Create one: cast anchor create");

    // One mapping per (surface, channel): replace any existing.
    const existing = await ctx.db
      .query("anchor_channels")
      .withIndex("by_surface_channel", (q: any) =>
        q.eq("surface", "slack").eq("channel_key", args.channel),
      )
      .first();
    if (existing) {
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
    const row = await ctx.db
      .query("anchor_channels")
      .withIndex("by_surface_channel", (q: any) =>
        q.eq("surface", "slack").eq("channel_key", args.channel),
      )
      .first();
    if (row) await ctx.db.delete(row._id);
    return { channel: args.channel, removed: !!row };
  },
});

export const listChannels = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    // Channels mapped to any of the caller's anchors.
    const personal = await ctx.db
      .query("anchors")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
      .collect();
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const teamAnchors: any[] = [];
    for (const m of memberships) {
      const rows = await ctx.db
        .query("anchors")
        .withIndex("by_team", (q: any) => q.eq("team_id", m.team_id))
        .collect();
      teamAnchors.push(...rows);
    }
    const anchorIds = new Set([...personal, ...teamAnchors].map((a) => a._id.toString()));
    const out: any[] = [];
    for (const id of anchorIds) {
      const chans = await ctx.db
        .query("anchor_channels")
        .withIndex("by_anchor", (q: any) => q.eq("anchor_id", id))
        .collect();
      out.push(...chans);
    }
    return out;
  },
});

// resolveAnchorForChannel — inbound webhook lookup: which anchor answers in this
// Slack channel. Internal (the webhook authenticates by signature, not a user).
export const resolveAnchorForChannel = internalQuery({
  args: { channel: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("anchor_channels")
      .withIndex("by_surface_channel", (q: any) =>
        q.eq("surface", "slack").eq("channel_key", args.channel),
      )
      .first();
    if (!row) return null;
    const anchor = await ctx.db.get(row.anchor_id);
    if (!anchor || anchor.status === "decommissioned") return null;
    return { anchor_id: anchor._id, name: anchor.name, channel_project: row.project_path ?? null };
  },
});

// markEventSeen — idempotency: returns true the FIRST time an event_id is seen,
// false on a retry. Slack redelivers on slow acks; a double-wake would double-post.
export const markEventSeen = internalMutation({
  args: { event_id: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("slack_events")
      .withIndex("by_event_id", (q: any) => q.eq("event_id", args.event_id))
      .first();
    if (existing) return false;
    await ctx.db.insert("slack_events", { event_id: args.event_id, created_at: Date.now() });
    return true;
  },
});

// postMessage — outbound reply, server-side so SLACK_BOT_TOKEN never reaches the
// anchor's session. Backs `cast anchor say`. Auth'd by the host's api_token.
export const postMessage = action({
  args: {
    api_token: v.optional(v.string()),
    channel: v.string(),
    thread_ts: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const userId = await ctx.runQuery(internal.slack.whoami, {
      api_token: args.api_token,
    });
    if (!userId) return { ok: false, error: "Not authenticated" };
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not configured" };
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: args.channel,
        thread_ts: args.thread_ts,
        text: args.text,
      }),
    });
    const data = (await resp.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error };
  },
});

// Tiny auth helper exposed to the action layer (actions can't touch the db).
export const whoami = internalQuery({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<"users"> | null> => {
    return await getAuthenticatedUserId(ctx, args.api_token);
  },
});
