import { mutation, query, internalMutation, internalQuery, action } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthenticatedUserId } from "./pendingMessages";
import { deliverToAnchor, userCanAccessAnchor, visibleAnchorsForUser } from "./anchors";

// The Slack adapter. Workspaces connect via the "Add to Slack" OAuth flow, which
// stores a per-workspace bot token in `slack_installations` (replacing the single
// app-level SLACK_BOT_TOKEN env var). A channel maps to its Anchor in
// `anchor_channels`; an @mention wakes the anchor (inbound), and the anchor replies
// as the bot (outbound, server-side so the token never reaches the session). Every
// act path authorizes against the caller's anchors — authentication alone is never
// enough (multi-tenant boundary). SLACK_SIGNING_SECRET (app-level) still verifies
// inbound webhooks; SLACK_BOT_TOKEN is honored as a fallback for a manual setup.

const BOT_SCOPES = "app_mentions:read,chat:write,im:history,channels:read,groups:read,users:read";

function convexSiteUrl(): string {
  return process.env.SLACK_REDIRECT_BASE || process.env.CONVEX_SITE_URL || "https://convex.codecast.sh";
}

// ── OAuth state signing (CSRF + binding integrity) ──────────────────────────
// The install `state` names which codecast anchor/user the install binds to, so
// it must be tamper-proof: sign it with the app secret and check freshness on the
// callback. Without this, a forged state could bind someone's workspace to the
// attacker's anchor.
async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signState(payload: Record<string, unknown>): Promise<string> {
  const secret = process.env.SLACK_CLIENT_SECRET || "";
  const body = btoa(JSON.stringify(payload));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyState(state: string): Promise<Record<string, any> | null> {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const secret = process.env.SLACK_CLIENT_SECRET || "";
  const expected = await hmacHex(secret, body);
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const payload = JSON.parse(atob(body));
    if (typeof payload.ts === "number" && Date.now() - payload.ts > 15 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Scope / installation resolution ─────────────────────────────────────────

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

// The Slack workspace an anchor posts through: the installation bound to the
// anchor's codecast scope (its team, or the user for a personal anchor).
async function installationForAnchor(ctx: { db: any }, anchor: any): Promise<any | null> {
  if (!anchor) return null;
  if (anchor.team_id) {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_team", (q: any) => q.eq("team_id", anchor.team_id))
      .first();
  }
  if (anchor.scope_user_id) {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", anchor.scope_user_id))
      .first();
  }
  return null;
}

// Channel ids are only unique within a workspace; resolve with the workspace when
// we have it (inbound events carry team_id), falling back to the global lookup.
async function channelRow(ctx: { db: any }, channel: string, workspace?: string) {
  if (workspace) {
    const scoped = await ctx.db
      .query("anchor_channels")
      .withIndex("by_workspace_channel", (q: any) =>
        q.eq("surface", "slack").eq("workspace_key", workspace).eq("channel_key", channel),
      )
      .first();
    if (scoped) return scoped;
  }
  return await ctx.db
    .query("anchor_channels")
    .withIndex("by_surface_channel", (q: any) => q.eq("surface", "slack").eq("channel_key", channel))
    .first();
}

// ── Add to Slack (OAuth v2) ─────────────────────────────────────────────────

// resolveInstallScope — auth the caller and resolve the anchor the install binds
// to (internal; the getInstallUrl action can't touch the db directly).
export const resolveInstallScope = internalQuery({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ user_id: string; anchor_id: string; team_id?: string; scope_user_id?: string } | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const anchor = await callerAnchor(ctx, userId, args.scope_type, args.team_id);
    if (!anchor) return null;
    return {
      user_id: userId.toString(),
      anchor_id: anchor._id.toString(),
      team_id: anchor.team_id?.toString(),
      scope_user_id: anchor.scope_user_id?.toString(),
    };
  },
});

// getInstallUrl — the "Add to Slack" button calls this and redirects the browser
// to the returned Slack authorize URL. State binds the install to the caller's
// anchor and is signed so it can't be forged.
export const getInstallUrl = action({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) return { ok: false, error: "Slack app not configured (SLACK_CLIENT_ID)" };
    const scope = await ctx.runQuery(internal.slack.resolveInstallScope, args);
    if (!scope) return { ok: false, error: "No anchor to connect — create one first" };
    const state = await signState({ ...scope, ts: Date.now() });
    const redirect = `${convexSiteUrl()}/api/slack/oauth/callback`;
    const url =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(BOT_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&state=${encodeURIComponent(state)}`;
    return { ok: true, url };
  },
});

// storeInstallation — upsert the per-workspace bot token, bound to the codecast
// scope from the (verified) state. Called by the OAuth callback (http.ts).
export const storeInstallation = internalMutation({
  args: {
    workspace_id: v.string(),
    workspace_name: v.optional(v.string()),
    bot_user_id: v.string(),
    bot_token: v.string(),
    scopes: v.optional(v.string()),
    app_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    scope_user_id: v.optional(v.string()),
    installed_by: v.string(),
  },
  handler: async (ctx, args) => {
    const teamId = args.team_id ? ctx.db.normalizeId("teams", args.team_id) ?? undefined : undefined;
    const scopeUserId = args.scope_user_id
      ? ctx.db.normalizeId("users", args.scope_user_id) ?? undefined
      : undefined;
    const installedBy = ctx.db.normalizeId("users", args.installed_by);
    if (!installedBy) throw new Error("bad installer id");
    const now = Date.now();
    const existing = await ctx.db
      .query("slack_installations")
      .withIndex("by_workspace", (q: any) => q.eq("workspace_id", args.workspace_id))
      .first();
    const fields = {
      workspace_id: args.workspace_id,
      workspace_name: args.workspace_name,
      bot_user_id: args.bot_user_id,
      bot_token: args.bot_token,
      scopes: args.scopes,
      app_id: args.app_id,
      team_id: teamId,
      scope_user_id: scopeUserId,
      updated_at: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("slack_installations", {
      ...fields,
      installed_by_user_id: installedBy,
      created_at: now,
    });
  },
});

// ── Channel linking ─────────────────────────────────────────────────────────

// resolveLinkContext — auth + the caller's anchor + its workspace token, so the
// linkChannel action can probe Slack and stamp the workspace on the mapping.
export const resolveLinkContext = internalQuery({
  args: {
    api_token: v.optional(v.string()),
    team: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; error?: string; bot_token?: string; workspace_id?: string }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { ok: false, error: "Authentication failed" };
    const anchor = await callerAnchor(ctx, userId, args.team ? "team" : "user", args.team_id);
    if (!anchor) return { ok: false, error: "No anchor to link — create one first" };
    const install = await installationForAnchor(ctx, anchor);
    return { ok: true, bot_token: install?.bot_token, workspace_id: install?.workspace_id };
  },
});

// commitLinkChannel — auth + resolve anchor + re-point ownership check + write, in
// ONE transaction (no TOCTOU window). Stamps the workspace so inbound routing and
// post-back resolve the right installation.
export const commitLinkChannel = internalMutation({
  args: {
    api_token: v.optional(v.string()),
    channel: v.string(),
    team: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; replaced?: boolean }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { ok: false, error: "Authentication failed" };
    const anchor = await callerAnchor(ctx, userId, args.team ? "team" : "user", args.team_id);
    if (!anchor) return { ok: false, error: "No anchor to link — create one first" };
    const existing = await channelRow(ctx, args.channel, args.workspace);
    if (existing) {
      const current = await ctx.db.get(existing.anchor_id as Id<"anchors">);
      if (!(await userCanAccessAnchor(ctx, userId, current))) {
        return { ok: false, error: "That channel is already linked to an anchor you don't control" };
      }
      await ctx.db.patch(existing._id, {
        anchor_id: anchor._id,
        workspace_key: args.workspace,
        project_path: args.project_path,
      });
      return { ok: true, replaced: true };
    }
    await ctx.db.insert("anchor_channels", {
      anchor_id: anchor._id,
      surface: "slack",
      channel_key: args.channel,
      workspace_key: args.workspace,
      project_path: args.project_path,
      created_at: Date.now(),
    });
    return { ok: true, replaced: false };
  },
});

// linkChannel — map a Slack channel to the caller's anchor. Gate: the BOT must
// already be a member of the channel (read-only conversations.info probe with the
// workspace's token), so a channel can only be claimed after the bot was invited.
// (Verifies the bot's membership, not the caller's — see runbook.) The
// authorization + write happen atomically in commitLinkChannel.
export const linkChannel = action({
  args: {
    api_token: v.optional(v.string()),
    channel: v.string(),
    team: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; error?: string; channel: string; replaced?: boolean }> => {
    const lc = await ctx.runQuery(internal.slack.resolveLinkContext, {
      api_token: args.api_token,
      team: args.team,
      team_id: args.team_id,
    });
    if (!lc.ok) return { ok: false, error: lc.error, channel: args.channel };
    const token = lc.bot_token || process.env.SLACK_BOT_TOKEN;
    if (!token) return { ok: false, error: "Connect Slack first (Add to Slack)", channel: args.channel };

    const resp = await fetch(
      `https://slack.com/api/conversations.info?channel=${encodeURIComponent(args.channel)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await resp.json()) as { ok: boolean; error?: string; channel?: { is_member?: boolean } };
    if (!data.ok) return { ok: false, error: `Slack: ${data.error}`, channel: args.channel };
    if (!data.channel?.is_member) {
      return { ok: false, error: "The bot isn't in that channel — /invite it in Slack first", channel: args.channel };
    }

    const res = await ctx.runMutation(internal.slack.commitLinkChannel, {
      api_token: args.api_token,
      channel: args.channel,
      team: args.team,
      team_id: args.team_id,
      workspace: lc.workspace_id,
      project_path: args.project_path,
    });
    return { ok: res.ok, error: res.error, channel: args.channel, replaced: res.replaced };
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

// ── Inbound (wake) ──────────────────────────────────────────────────────────

// wakeFromSlackEvent — dedup + resolve channel→anchor + deliver, in ONE
// transaction, so a wake failure rolls back the dedup row and Slack's retry can
// re-drive it. Resolves the channel within its workspace (channel ids collide
// across workspaces).
export const wakeFromSlackEvent = internalMutation({
  args: {
    event_id: v.string(),
    channel: v.string(),
    workspace: v.optional(v.string()),
    user: v.optional(v.string()),
    text: v.string(),
    thread: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("slack_events")
      .withIndex("by_event_id", (q: any) => q.eq("event_id", args.event_id))
      .first();
    if (seen) return { status: "duplicate" as const };

    const row = await channelRow(ctx, args.channel, args.workspace);
    const anchor = row ? await ctx.db.get(row.anchor_id as Id<"anchors">) : null;
    if (!anchor || anchor.status === "decommissioned") {
      await ctx.db.insert("slack_events", { event_id: args.event_id, created_at: Date.now() });
      return { status: "no_anchor" as const };
    }

    const thread = args.thread ?? "";
    const cleaned = String(args.text).replace(/<@[A-Z0-9]+>/g, "").trim();
    const wake = [
      `[Slack message in channel ${args.channel}${thread ? `, thread ${thread}` : ""}]`,
      `<@${args.user ?? "someone"}> said: "${cleaned}"`,
      "",
      "Reply in this Slack thread by running:",
      `  cast anchor say --channel ${args.channel}${thread ? ` --thread ${thread}` : ""} "<your reply>"`,
    ].join("\n");
    await deliverToAnchor(ctx, anchor._id, wake);
    await ctx.db.insert("slack_events", { event_id: args.event_id, created_at: Date.now() });
    return { status: "woke" as const, anchor_id: anchor._id };
  },
});

// sweepSlackEvents — drop dedup rows past Slack's retry window so the table can't
// grow unbounded (cron).
export const sweepSlackEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (let i = 0; i < 16; i++) {
      const stale = await ctx.db
        .query("slack_events")
        .withIndex("by_created_at", (q: any) => q.lt("created_at", cutoff))
        .take(500);
      if (stale.length === 0) break;
      for (const row of stale) await ctx.db.delete(row._id);
      deleted += stale.length;
      if (stale.length < 500) break;
    }
    return { deleted };
  },
});

// ── Outbound (post-back) ────────────────────────────────────────────────────

// resolvePostContext — authorize the caller for the channel and hand back the
// workspace's bot token (internal; the postMessage action can't read the db).
export const resolvePostContext = internalQuery({
  args: { api_token: v.optional(v.string()), channel: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; bot_token?: string }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { ok: false };
    const row = await channelRow(ctx, args.channel);
    if (!row) return { ok: false };
    const anchor = await ctx.db.get(row.anchor_id as Id<"anchors">);
    if (!anchor || anchor.status === "decommissioned") return { ok: false };
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) return { ok: false };
    const install = await installationForAnchor(ctx, anchor);
    return { ok: true, bot_token: install?.bot_token };
  },
});

// postMessage — outbound reply as the bot, server-side so the token never reaches
// the anchor's session. Uses the channel's workspace installation token.
export const postMessage = action({
  args: {
    api_token: v.optional(v.string()),
    channel: v.string(),
    thread_ts: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const pc = await ctx.runQuery(internal.slack.resolvePostContext, {
      api_token: args.api_token,
      channel: args.channel,
    });
    if (!pc.ok) return { ok: false, error: "Not authorized to post to this channel" };
    const token = pc.bot_token || process.env.SLACK_BOT_TOKEN;
    if (!token) return { ok: false, error: "No Slack token for this workspace — reconnect Slack" };
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: args.channel, thread_ts: args.thread_ts, text: args.text }),
    });
    const data = (await resp.json()) as { ok: boolean; error?: string };
    return { ok: data.ok, error: data.error };
  },
});
