// Two way mirroring between a codecast chat channel and a Slack channel.
//
// Shape: one `slack_channel_links` row per mirrored pair carries the direction
// and every content control. Slack events arrive at /api/webhooks/slack, are
// deduped and queued by `ingestEvent` (one fast mutation, so Slack gets its ack
// inside three seconds), and processed by `processEvent` (an action: it fetches
// profiles and files, then applies through internal mutations that insert via
// chat.postChatMessage — so a Slack line gets mentions, read marks,
// notifications and the anchor wake by exactly the rules a typed line does).
// Chat writes call lib/slackOutbound.queueSlackOutbound, which schedules the
// push actions below; a pushed row is stamped with its Slack ts, and that stamp
// plus the bot identity check at the door is what stops the echo.
//
// Identity: a Slack person whose email matches a teammate IS that teammate
// (when the link allows it); anyone else speaks through the installation's
// bridge identity with an `external_author` snapshot of their name and face.
// The bot never speaks as itself into chat, and the bridge never speaks into
// Slack.
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthenticatedUserId } from "./pendingMessages";
import { isTeamAdmin, isTeamMember } from "./privacy";
import { canAccessChannel } from "./chatAccess";
import {
  chatFail,
  findByClientId,
  loadChannel,
  mayManageChannel,
  maybeWakeAnchor,
  patchChat,
  postChatMessage,
  requireCaller,
  resolveChannelAnchor,
  tombstoneChatMessage,
  wakeMentionedParties,
} from "./chat";
import { resolveChatMentions, teamRoster } from "./lib/mentionResolve";
import { isValidEmoji, MAX_CHAT_CONTENT, oneLine } from "./chatText";
import { botHandle, memberHandle } from "@codecast/shared/chat";
import {
  emojiToShortcode,
  markdownToSlack,
  shortcodeToEmoji,
  slackAttachmentsToMarkdown,
  slackDisplayName,
  slackToMarkdown,
  type SlackInboundResolver,
} from "./lib/slackText";
import {
  installationForTeam,
  isAgentLine,
  linkReceivesInbound,
  linkSendsOutbound,
  outboundSkipReason,
  slackLinkForChannel,
} from "./lib/slackOutbound";
import { DIRECTION_FLOW, DIRECTION_SENTENCE, LINK_DEFAULTS, mergeLinkOptions } from "./lib/slackMirror";
import { webBaseUrl } from "./slack";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type Link = Doc<"slack_channel_links">;
type Install = Doc<"slack_installations">;

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BACKFILL_MAX_MESSAGES = 500;
const JOB_MAX_ATTEMPTS = 3;
// The canonical dedupe and lookup key for a Slack line mirrored into chat.
export function slackClientId(workspace: string, channel: string, ts: string): string {
  return `slack:${workspace}:${channel}:${ts}`;
}
const NOTICE_CLIENT_ID_PREFIX = "slack-notice:";

// The chat row a Slack ts names, whichever way it crossed: an inbound line by
// its derived client id, an outbound line by the ts stamped after the post.
async function findMirroredRow(ctx: ReadCtx, link: Link, ts: string): Promise<Doc<"chat_messages"> | null> {
  const inbound = await findByClientId(ctx, link.chat_channel_id, slackClientId(link.workspace_id, link.slack_channel_id, ts));
  if (inbound) return inbound;
  const outbound = await ctx.db
    .query("chat_messages")
    .withIndex("by_channel_external_ts", (q: any) => q.eq("channel_id", link.chat_channel_id).eq("external.ts", ts))
    .first();
  if (outbound && outbound.external?.channel === link.slack_channel_id && outbound.external?.workspace === link.workspace_id) {
    return outbound;
  }
  return null;
}

const directionValidator = v.union(
  v.literal("both"),
  v.literal("slack_to_codecast"),
  v.literal("codecast_to_slack"),
);
const optionsValidator = v.object({
  threads: v.optional(v.boolean()),
  reactions: v.optional(v.boolean()),
  edits: v.optional(v.boolean()),
  files: v.optional(v.boolean()),
  bot_messages: v.optional(v.boolean()),
  system_messages: v.optional(v.boolean()),
  agent_lines: v.optional(v.boolean()),
  match_people_by_email: v.optional(v.boolean()),
});
const backfillValidator = v.union(v.literal("none"), v.literal("1d"), v.literal("7d"), v.literal("30d"));
const BACKFILL_MS: Record<string, number> = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

// ── Slack Web API ────────────────────────────────────────────────────────────

type SlackResp = { ok: boolean; error?: string; [k: string]: any };

// JSON only for the write methods that accept it (`blocks` needs it); form
// encoding for everything else, including chat.getPermalink, which is a read
// and rejects a JSON body.
const JSON_METHODS = new Set([
  "chat.postMessage", "chat.update", "chat.delete", "reactions.add", "reactions.remove",
]);

async function slackApi(token: string, method: string, params: Record<string, unknown> = {}): Promise<SlackResp> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string;
  if (JSON_METHODS.has(method)) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(params);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const [k, val] of Object.entries(params)) {
      if (val === undefined || val === null) continue;
      form.set(k, typeof val === "string" ? val : JSON.stringify(val));
    }
    body = form.toString();
  }
  try {
    const resp = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers, body });
    return (await resp.json()) as SlackResp;
  } catch (error) {
    return { ok: false, error: `network: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function slackTsToMs(ts: string): number {
  const n = Number(ts);
  return Number.isFinite(n) ? Math.round(n * 1000) : Date.now();
}

function safeInstall(install: Install) {
  return {
    _id: install._id,
    workspace_id: install.workspace_id,
    workspace_name: install.workspace_name ?? null,
    bot_user_id: install.bot_user_id,
    app_id: install.app_id ?? null,
    installed_by_user_id: install.installed_by_user_id,
    created_at: install.created_at,
    scopes: install.scopes ?? null,
  };
}

// ── Lookups ──────────────────────────────────────────────────────────────────

async function linkByWorkspaceChannel(ctx: ReadCtx, workspace: string, channel: string): Promise<Link | null> {
  return await ctx.db
    .query("slack_channel_links")
    .withIndex("by_workspace_channel", (q: any) => q.eq("workspace_id", workspace).eq("slack_channel_id", channel))
    .first();
}

async function slackUserRow(ctx: ReadCtx, workspace: string, user: string): Promise<Doc<"slack_users"> | null> {
  return await ctx.db
    .query("slack_users")
    .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", workspace).eq("slack_user_id", user))
    .first();
}

// The codecast teammate a Slack email belongs to, if they are in this team.
// Primary email by index, then each teammate's alternate_emails (the same rule
// tasks.ts uses for assignee resolution).
async function teammateByEmail(ctx: ReadCtx, teamId: Id<"teams">, email: string | undefined): Promise<Id<"users"> | null> {
  if (!email) return null;
  const lower = email.toLowerCase();
  const candidates = await ctx.db
    .query("users")
    .withIndex("email", (q: any) => q.eq("email", lower))
    .collect();
  for (const u of candidates) {
    if (u.is_bot) continue;
    if (await isTeamMember(ctx as any, u._id, teamId)) return u._id;
  }
  for (const u of await teamRoster(ctx, teamId)) {
    if (u.is_bot) continue;
    if ((u.alternate_emails ?? []).some((e: string) => e.toLowerCase() === lower)) return u._id;
  }
  return null;
}

// The bridge identity a workspace speaks through. Minted once per installation
// and made a team member so the roster and the author lookup both know it.
async function ensureBridgeUser(ctx: MutationCtx, install: Install): Promise<Id<"users">> {
  if (install.bridge_user_id) {
    const existing = await ctx.db.get(install.bridge_user_id);
    if (existing) return existing._id;
  }
  const now = Date.now();
  const name = `${install.workspace_name ?? "Slack"} (Slack)`;
  const id = await ctx.db.insert("users", {
    name,
    is_bot: true,
    bot_kind: "slack",
    created_at: now,
    team_id: install.team_id,
    active_team_id: install.team_id,
  } as any);
  if (install.team_id) {
    await ctx.db.insert("team_memberships", {
      user_id: id,
      team_id: install.team_id,
      role: "member",
      joined_at: now,
      visibility: "hidden",
    } as any);
  }
  await ctx.db.patch(install._id, { bridge_user_id: id, updated_at: now });
  return id;
}

// A line in the chat room, in the workspace's own voice, about the mirror
// itself — linked, unlinked, or a Slack message that could not cross. Always
// local: the Slack side gets its own notice, and echoing this one back would
// read as the mirror talking to itself.
async function postBridgeNotice(
  ctx: MutationCtx,
  opts: { channel: Doc<"chat_channels">; install: Install; content: string; clientId: string },
): Promise<void> {
  const bridge = await ensureBridgeUser(ctx, opts.install);
  await postChatMessage(ctx, {
    channel: opts.channel,
    root: null,
    authorId: bridge,
    content: opts.content,
    attachments: [],
    clientId: `${NOTICE_CLIENT_ID_PREFIX}${opts.clientId}`,
    externalAuthor: { name: "Slack", is_bot: true },
    syncLocalOnly: true,
  });
}

// Slack has no length limit a chat row shares, so a long line is cut with an
// ellipsis rather than refused: the reader sees most of it and knows there is
// more in Slack.
function capContent(content: string): string {
  return content.length > MAX_CHAT_CONTENT ? `${content.slice(0, MAX_CHAT_CONTENT - 2)}…` : content;
}

function nowTs(): string {
  return (Date.now() / 1000).toFixed(6);
}

// ── Reading the state (settings surfaces) ───────────────────────────────────

// Installation + links for a team the caller belongs to. The token never leaves.
export const getTeamSlack = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    if (!(await isTeamMember(ctx, userId, args.team_id))) return null;
    const install = await installationForTeam(ctx, args.team_id);
    const links = await ctx.db
      .query("slack_channel_links")
      .withIndex("by_team", (q: any) => q.eq("team_id", args.team_id))
      .collect();
    const visible: Link[] = [];
    for (const link of links) {
      const channel = await ctx.db.get(link.chat_channel_id);
      if (channel && (await canAccessChannel(ctx, userId, channel))) visible.push(link);
    }
    return {
      installation: install ? safeInstall(install) : null,
      is_admin: await isTeamAdmin(ctx, userId, args.team_id),
      links: visible,
      pending_jobs: await countQueued(ctx, visible),
    };
  },
});

async function countQueued(ctx: ReadCtx, links: Link[]): Promise<number> {
  let n = 0;
  for (const link of links) {
    const rows = await ctx.db
      .query("slack_sync_events")
      .withIndex("by_link_created", (q: any) => q.eq("link_id", link._id))
      .order("desc")
      .take(20);
    n += rows.filter((r) => r.status === "queued").length;
  }
  return n;
}

// Recent job ledger for one link, for the settings dialog's status strip.
export const linkActivity = query({
  args: { api_token: v.optional(v.string()), link_id: v.id("slack_channel_links") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const link = await ctx.db.get(args.link_id);
    if (!link) return null;
    const channel = await ctx.db.get(link.chat_channel_id);
    if (!channel || !(await canAccessChannel(ctx, userId, channel))) return null;
    const jobs = await ctx.db
      .query("slack_sync_events")
      .withIndex("by_link_created", (q: any) => q.eq("link_id", link._id))
      .order("desc")
      .take(12);
    return jobs.map((j) => ({
      _id: j._id,
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      error: j.error ?? null,
      created_at: j.created_at,
      processed_at: j.processed_at ?? null,
    }));
  },
});

// ── Link management ──────────────────────────────────────────────────────────

export const resolveLinkAuth = internalQuery({
  args: { api_token: v.optional(v.string()), chat_channel_id: v.id("chat_channels") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { ok: false as const, error: "Authentication failed" };
    const channel = await ctx.db.get(args.chat_channel_id);
    if (!channel || !(await canAccessChannel(ctx, userId, channel))) {
      return { ok: false as const, error: "Channel not found" };
    }
    if (channel.kind === "dm") return { ok: false as const, error: "A direct message cannot be mirrored to Slack" };
    if (channel.archived_at) return { ok: false as const, error: "This channel is archived" };
    if (!(await mayManageChannel(ctx, userId, channel))) {
      return { ok: false as const, error: "Only the channel's creator or a team admin can set up a Slack mirror" };
    }
    const install = await installationForTeam(ctx, channel.team_id);
    if (!install) return { ok: false as const, error: "Connect a Slack workspace for this team first" };
    const existing = await slackLinkForChannel(ctx, channel._id);
    return {
      ok: true as const,
      user_id: userId,
      team_id: channel.team_id,
      bot_token: install.bot_token,
      workspace_id: install.workspace_id,
      existing_link_id: existing?._id ?? null,
    };
  },
});

export const commitLink = internalMutation({
  args: {
    api_token: v.optional(v.string()),
    chat_channel_id: v.id("chat_channels"),
    slack_channel_id: v.string(),
    slack_channel_name: v.optional(v.string()),
    slack_channel_private: v.optional(v.boolean()),
    direction: v.optional(directionValidator),
    options: v.optional(optionsValidator),
    since_ts: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const channel = await loadChannel(ctx, userId, args.chat_channel_id);
    if (!(await mayManageChannel(ctx, userId, channel))) chatFail("FORBIDDEN", "Not allowed to manage this channel");
    const install = await installationForTeam(ctx, channel.team_id);
    if (!install) chatFail("INVALID", "Connect a Slack workspace for this team first");
    // Both uniqueness rules, inside the one transaction. A link whose
    // installation was removed (app uninstalled) is a leftover, not a mirror:
    // it is dropped here so a reinstall can link again.
    const byChat = await slackLinkForChannel(ctx, channel._id);
    if (byChat) {
      const stillInstalled = await ctx.db.get(byChat.installation_id);
      if (stillInstalled) chatFail("INVALID", "This channel already mirrors a Slack channel");
      await ctx.db.delete(byChat._id);
    }
    const bySlack = await linkByWorkspaceChannel(ctx, install.workspace_id, args.slack_channel_id);
    if (bySlack) {
      const other = await ctx.db.get(bySlack.chat_channel_id);
      chatFail("INVALID", `That Slack channel already mirrors #${other?.name ?? "another channel"}`);
    }
    const now = Date.now();
    const id = await ctx.db.insert("slack_channel_links", {
      team_id: channel.team_id,
      installation_id: install._id,
      workspace_id: install.workspace_id,
      slack_channel_id: args.slack_channel_id,
      slack_channel_name: args.slack_channel_name,
      slack_channel_private: args.slack_channel_private,
      chat_channel_id: channel._id,
      direction: args.direction ?? "both",
      options: mergeLinkOptions(LINK_DEFAULTS, args.options),
      since_ts: args.since_ts,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    // One notice in chat so the room knows where the new faces come from.
    const actor = await ctx.db.get(userId);
    const flow = DIRECTION_FLOW[args.direction ?? "both"];
    await postBridgeNotice(ctx, {
      channel,
      install,
      content: `Linked to Slack #${args.slack_channel_name ?? args.slack_channel_id} (${flow}) by ${actor?.name ?? "a teammate"}.`,
      clientId: `${id}:linked`,
    });
    return { link_id: id, chat_channel_name: channel.name, actor_name: actor?.name ?? null };
  },
});

// Link a chat channel to a Slack channel. Probes the Slack side with the
// workspace token (joins a public channel the app is not yet in), then writes
// atomically. Optionally backfills recent history.
export const linkChannel = action({
  args: {
    api_token: v.optional(v.string()),
    chat_channel_id: v.id("chat_channels"),
    slack_channel_id: v.string(),
    direction: v.optional(directionValidator),
    options: v.optional(optionsValidator),
    backfill: v.optional(backfillValidator),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; link_id?: Id<"slack_channel_links"> }> => {
    const auth = await ctx.runQuery(internal.slackSync.resolveLinkAuth, {
      api_token: args.api_token,
      chat_channel_id: args.chat_channel_id,
    });
    if (!auth.ok) return { ok: false, error: auth.error };
    if (auth.existing_link_id) return { ok: false, error: "This channel already mirrors a Slack channel" };
    const token = auth.bot_token;

    let info = await slackApi(token, "conversations.info", { channel: args.slack_channel_id });
    if (!info.ok) return { ok: false, error: `Slack: ${info.error}` };
    let ch = info.channel ?? {};
    if (ch.is_archived) return { ok: false, error: "That Slack channel is archived" };
    if (ch.is_im || ch.is_mpim) return { ok: false, error: "Only channels can be mirrored, not direct messages" };
    if (!ch.is_member) {
      if (ch.is_private) {
        return { ok: false, error: "The app is not in that private channel. In Slack, run /invite @Codecast there, then try again." };
      }
      const joined = await slackApi(token, "conversations.join", { channel: args.slack_channel_id });
      if (!joined.ok) return { ok: false, error: `Slack would not let the app join: ${joined.error}` };
      info = await slackApi(token, "conversations.info", { channel: args.slack_channel_id });
      ch = info.channel ?? ch;
    }

    const backfill = args.backfill ?? "none";
    const sinceMs = backfill === "none" ? Date.now() : Date.now() - BACKFILL_MS[backfill];
    const sinceTs = (sinceMs / 1000).toFixed(6);
    let committed: { link_id: Id<"slack_channel_links">; chat_channel_name: string; actor_name: string | null };
    try {
      committed = await ctx.runMutation(internal.slackSync.commitLink, {
        api_token: args.api_token,
        chat_channel_id: args.chat_channel_id,
        slack_channel_id: args.slack_channel_id,
        slack_channel_name: ch.name,
        slack_channel_private: !!ch.is_private,
        direction: args.direction,
        options: args.options,
        since_ts: sinceTs,
      });
    } catch (error: any) {
      return { ok: false, error: error?.data?.message ?? error?.message ?? "Could not save the link" };
    }

    const flow = DIRECTION_SENTENCE[args.direction ?? "both"];
    const by = committed.actor_name ? ` Set up by ${committed.actor_name}.` : "";
    await slackApi(token, "chat.postMessage", {
      channel: args.slack_channel_id,
      text: `:link: This channel is now mirrored with codecast #${committed.chat_channel_name}. ${flow}${by}`,
    });

    if (backfill !== "none") {
      await ctx.scheduler.runAfter(0, internal.slackSync.backfill, { link_id: committed.link_id, oldest_ts: sinceTs });
    }
    return { ok: true, link_id: committed.link_id };
  },
});

export const updateLink = mutation({
  args: {
    api_token: v.optional(v.string()),
    link_id: v.id("slack_channel_links"),
    direction: v.optional(directionValidator),
    options: v.optional(optionsValidator),
    paused: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const link = await ctx.db.get(args.link_id);
    if (!link) chatFail("NOT_FOUND", "Link not found");
    const channel = await loadChannel(ctx, userId, link.chat_channel_id);
    if (!(await mayManageChannel(ctx, userId, channel))) chatFail("FORBIDDEN", "Not allowed to manage this channel");
    const patch: Partial<Link> = { updated_at: Date.now() };
    if (args.direction) patch.direction = args.direction;
    if (args.options) patch.options = mergeLinkOptions(link.options, args.options);
    if (typeof args.paused === "boolean") {
      patch.paused = args.paused;
      if (!args.paused) {
        patch.last_error = undefined;
        patch.last_error_at = undefined;
      }
    }
    await ctx.db.patch(link._id, patch);
    return { link_id: link._id };
  },
});

export const unlinkChannel = mutation({
  args: { api_token: v.optional(v.string()), link_id: v.id("slack_channel_links") },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const link = await ctx.db.get(args.link_id);
    if (!link) return { removed: false };
    const channel = await loadChannel(ctx, userId, link.chat_channel_id);
    if (!(await mayManageChannel(ctx, userId, channel))) chatFail("FORBIDDEN", "Not allowed to manage this channel");
    await ctx.db.delete(link._id);
    const actor = await ctx.db.get(userId);
    const install = await ctx.db.get(link.installation_id);
    if (install) {
      await postBridgeNotice(ctx, {
        channel,
        install,
        content: `Slack mirror with #${link.slack_channel_name ?? link.slack_channel_id} turned off by ${actor?.name ?? "a teammate"}.`,
        clientId: `${link._id}:unlinked`,
      });
      await ctx.scheduler.runAfter(0, internal.slackSync.postNotice, {
        installation_id: install._id,
        slack_channel_id: link.slack_channel_id,
        text: `:link: The mirror with codecast #${channel.name} was turned off${actor?.name ? ` by ${actor.name}` : ""}.`,
      });
    }
    return { removed: true };
  },
});

// Share one line that was kept local (or predates the link) into Slack.
export const shareMessageToSlack = mutation({
  args: { api_token: v.optional(v.string()), message_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const message = await ctx.db.get(args.message_id);
    if (!message) chatFail("NOT_FOUND", "Message not found");
    const channel = await loadChannel(ctx, userId, message.channel_id);
    const mine = message.user_id.toString() === userId.toString();
    if (!mine && !(await mayManageChannel(ctx, userId, channel))) {
      chatFail("FORBIDDEN", "Only the author or a channel manager can share a line to Slack");
    }
    const link = await slackLinkForChannel(ctx, channel._id);
    if (!link) chatFail("INVALID", "This channel has no Slack mirror");
    if (!linkSendsOutbound(link)) chatFail("INVALID", link.paused ? "The Slack mirror is paused" : "This mirror only flows from Slack");
    if (message.external) chatFail("INVALID", message.external.direction === "inbound" ? "That line came from Slack" : "That line is already in Slack");
    if (message.sync_local_only) await patchChat(ctx, message._id, { sync_local_only: undefined });
    const fresh = await ctx.db.get(message._id);
    const skip = fresh ? outboundSkipReason(link, fresh) : "missing";
    if (skip) chatFail("INVALID", `Cannot share this line (${skip})`);
    await ctx.scheduler.runAfter(0, internal.slackSync.pushMessage, { message_id: message._id });
    return { message_id: message._id };
  },
});

// The Slack channels the app can see in a team's workspace, marked with which
// ones are already mirrored, for the picker.
export const listSlackChannels = action({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams") },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; channels?: Array<{
    id: string; name: string; is_private: boolean; is_member: boolean; num_members: number | null;
    topic: string | null; purpose: string | null; linked_chat_channel_id: string | null; linked_chat_channel_name: string | null;
  }> }> => {
    const ctxRow = await ctx.runQuery(internal.slackSync.teamSlackContext, { api_token: args.api_token, team_id: args.team_id });
    if (!ctxRow.ok) return { ok: false, error: ctxRow.error };
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const resp = await slackApi(ctxRow.bot_token, "conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
        cursor,
      });
      if (!resp.ok) return { ok: false, error: `Slack: ${resp.error}` };
      for (const c of resp.channels ?? []) {
        const linked = ctxRow.links.find((l: { slack_channel_id: string }) => l.slack_channel_id === c.id);
        out.push({
          id: c.id,
          name: c.name,
          is_private: !!c.is_private,
          is_member: !!c.is_member,
          num_members: typeof c.num_members === "number" ? c.num_members : null,
          topic: c.topic?.value || null,
          purpose: c.purpose?.value || null,
          linked_chat_channel_id: linked?.chat_channel_id ?? null,
          linked_chat_channel_name: linked?.chat_channel_name ?? null,
        });
      }
      cursor = resp.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, channels: out };
  },
});

export const teamSlackContext = internalQuery({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { ok: false as const, error: "Authentication failed" };
    if (!(await isTeamMember(ctx, userId, args.team_id))) return { ok: false as const, error: "Not a member of this team" };
    const install = await installationForTeam(ctx, args.team_id);
    if (!install) return { ok: false as const, error: "Connect a Slack workspace for this team first" };
    const links = await ctx.db
      .query("slack_channel_links")
      .withIndex("by_team", (q: any) => q.eq("team_id", args.team_id))
      .collect();
    const withNames: Array<{ slack_channel_id: string; chat_channel_id: string; chat_channel_name: string }> = [];
    for (const l of links) {
      const c = await ctx.db.get(l.chat_channel_id);
      withNames.push({ slack_channel_id: l.slack_channel_id, chat_channel_id: l.chat_channel_id, chat_channel_name: c?.name ?? "" });
    }
    return { ok: true as const, bot_token: install.bot_token, workspace_id: install.workspace_id, links: withNames };
  },
});

export const postNotice = internalAction({
  args: { installation_id: v.id("slack_installations"), slack_channel_id: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const install = await ctx.runQuery(internal.slackSync.installationById, { id: args.installation_id });
    if (!install) return;
    await slackApi(install.bot_token, "chat.postMessage", { channel: args.slack_channel_id, text: args.text });
  },
});

export const installationById = internalQuery({
  args: { id: v.id("slack_installations") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

// ── Inbound: ingest ──────────────────────────────────────────────────────────

const HANDLED_MESSAGE_SUBTYPES = new Set([
  undefined, "file_share", "thread_broadcast", "bot_message", "message_changed", "message_deleted",
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "pinned_item",
]);

function eventChannelId(event: any): string | null {
  if (typeof event?.channel === "string") return event.channel;
  if (typeof event?.channel?.id === "string") return event.channel.id;
  if (typeof event?.item?.channel === "string") return event.item.channel;
  return null;
}

// Dedupe, route to the link, queue. Returns "no_link" WITHOUT recording the
// event so the legacy anchor path (http.ts) can still take a mention or DM.
export const ingestEvent = internalMutation({
  args: { event_id: v.string(), workspace: v.string(), event: v.any() },
  handler: async (ctx, args) => {
    const event = args.event ?? {};
    const type = String(event.type ?? "");
    const seen = await ctx.db
      .query("slack_events")
      .withIndex("by_event_id", (q: any) => q.eq("event_id", args.event_id))
      .first();
    if (seen) return { status: "duplicate" as const };
    const record = async () => {
      await ctx.db.insert("slack_events", { event_id: args.event_id, created_at: Date.now() });
    };

    // Workspace-level events: no channel to route by.
    if (type === "user_change" && event.user?.id) {
      await record();
      const cached = await slackUserRow(ctx, args.workspace, event.user.id);
      if (cached) await ctx.db.patch(cached._id, { ...profileFields(event.user), fetched_at: 0 });
      return { status: "profile" as const };
    }
    if (type === "app_uninstalled" || type === "tokens_revoked") {
      await record();
      const install = await ctx.db
        .query("slack_installations")
        .withIndex("by_workspace", (q: any) => q.eq("workspace_id", args.workspace))
        .first();
      if (install) {
        const links = await ctx.db
          .query("slack_channel_links")
          .withIndex("by_installation", (q: any) => q.eq("installation_id", install._id))
          .collect();
        for (const l of links) {
          await ctx.db.patch(l._id, { paused: true, last_error: "The Slack app was removed from the workspace", last_error_at: Date.now(), updated_at: Date.now() });
        }
        if (type === "app_uninstalled") await ctx.db.delete(install._id);
      }
      return { status: "uninstalled" as const };
    }

    const channelId = eventChannelId(event);
    if (!channelId) return { status: "no_link" as const };
    const link = await linkByWorkspaceChannel(ctx, args.workspace, channelId);
    if (!link) return { status: "no_link" as const };
    await record();
    // Our own posts, edits and reactions come back as events too. Drop them
    // here rather than paying a job and an action to find out.
    const install = await ctx.db.get(link.installation_id);
    if (install && (isOwnBotEvent(install, event) || isOwnBotEvent(install, event.message ?? {}))) {
      return { status: "own_bot" as const };
    }

    // Channel lifecycle: always applied, they are about the link itself.
    if (type === "channel_rename") {
      await ctx.db.patch(link._id, { slack_channel_name: event.channel?.name ?? link.slack_channel_name, updated_at: Date.now() });
      return { status: "renamed" as const };
    }
    if (type === "channel_archive" || type === "channel_deleted") {
      await ctx.db.patch(link._id, {
        paused: true,
        last_error: type === "channel_deleted" ? "The Slack channel was deleted" : "The Slack channel was archived",
        last_error_at: Date.now(),
        updated_at: Date.now(),
      });
      return { status: "paused" as const };
    }
    if (type === "channel_unarchive") {
      await ctx.db.patch(link._id, { paused: false, last_error: undefined, last_error_at: undefined, updated_at: Date.now() });
      return { status: "resumed" as const };
    }
    // The mention event is a duplicate of the message event in a mirrored
    // channel; the mirrored line's @mention wakes the anchor through chat.
    if (type === "app_mention") return { status: "handled_by_mirror" as const };
    if (!linkReceivesInbound(link)) return { status: "skipped" as const };

    let kind = type;
    if (type === "message") {
      if (!HANDLED_MESSAGE_SUBTYPES.has(event.subtype)) return { status: "skipped" as const };
      kind = event.subtype ? `message.${event.subtype}` : "message";
    } else if (type !== "reaction_added" && type !== "reaction_removed" && type !== "member_joined_channel" && type !== "member_left_channel") {
      return { status: "skipped" as const };
    }
    const jobId = await ctx.db.insert("slack_sync_events", {
      event_id: args.event_id,
      link_id: link._id,
      kind,
      payload: event,
      status: "queued",
      attempts: 0,
      created_at: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.slackSync.processEvent, { job_id: jobId });
    return { status: "queued" as const, job_id: jobId };
  },
});

// ── Inbound: process ─────────────────────────────────────────────────────────

export const jobContext = internalQuery({
  args: { job_id: v.id("slack_sync_events") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job) return null;
    const link = await ctx.db.get(job.link_id);
    const install = link ? await ctx.db.get(link.installation_id) : null;
    const channel = link ? await ctx.db.get(link.chat_channel_id) : null;
    const anchor = channel ? await resolveChannelAnchor(ctx, channel) : null;
    const anchorBot = anchor ? await ctx.db.get(anchor.bot_user_id) : null;
    return {
      job,
      link,
      install,
      channel,
      anchor_handle: anchorBot ? botHandle(anchorBot.name) : null,
    };
  },
});

export const markJob = internalMutation({
  args: {
    job_id: v.id("slack_sync_events"),
    status: v.union(v.literal("queued"), v.literal("done"), v.literal("failed"), v.literal("skipped")),
    error: v.optional(v.string()),
    bump_attempts: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job) return;
    await ctx.db.patch(job._id, {
      status: args.status,
      error: args.error,
      attempts: job.attempts + (args.bump_attempts ? 1 : 0),
      processed_at: args.status === "queued" ? undefined : Date.now(),
    });
    if (args.status === "failed" && args.error) {
      const link = await ctx.db.get(job.link_id);
      const now = Date.now();
      await ctx.db.patch(job.link_id, { last_error: args.error.slice(0, 300), last_error_at: now, updated_at: now });
      // A line Slack already acked and we could not mirror is otherwise
      // invisible. Say so once an hour, in the room where someone would notice.
      if (link && (!link.last_error_at || now - link.last_error_at > 3_600_000)) {
        const channel = await ctx.db.get(link.chat_channel_id);
        const install = await ctx.db.get(link.installation_id);
        if (channel && install && !channel.archived_at) {
          await postBridgeNotice(ctx, {
            channel,
            install,
            content: `A Slack message could not be mirrored here (${oneLine(args.error, 120)}). Open the Slack mirror settings for details.`,
            clientId: `${link._id}:failed:${Math.floor(now / 3_600_000)}`,
          });
        }
      }
    }
  },
});

function profileFields(u: any) {
  const profile = u?.profile ?? {};
  const display = String(profile.display_name || profile.real_name || u?.real_name || u?.name || "Someone").trim();
  return {
    name: display.slice(0, 80),
    handle: u?.name ? String(u.name).slice(0, 80) : undefined,
    real_name: profile.real_name ? String(profile.real_name).slice(0, 80) : undefined,
    avatar_url: profile.image_192 || profile.image_72 || profile.image_48 || undefined,
    email: profile.email ? String(profile.email).toLowerCase() : undefined,
    is_bot: !!u?.is_bot || u?.id === "USLACKBOT",
    deleted: !!u?.deleted,
  };
}

export const upsertSlackUser = internalMutation({
  args: {
    workspace_id: v.string(),
    slack_user_id: v.string(),
    team_id: v.optional(v.id("teams")),
    profile: v.any(),
  },
  handler: async (ctx, args) => {
    const fields = profileFields(args.profile);
    const mapped = args.team_id ? await teammateByEmail(ctx, args.team_id, fields.email) : null;
    const existing = await slackUserRow(ctx, args.workspace_id, args.slack_user_id);
    const row = { ...fields, codecast_user_id: mapped ?? undefined, fetched_at: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return { ...existing, ...row };
    }
    const id = await ctx.db.insert("slack_users", { workspace_id: args.workspace_id, slack_user_id: args.slack_user_id, ...row });
    return (await ctx.db.get(id))!;
  },
});

export const getSlackUser = internalQuery({
  args: { workspace_id: v.string(), slack_user_id: v.string() },
  handler: async (ctx, args) => await slackUserRow(ctx, args.workspace_id, args.slack_user_id),
});

type ResolvedPerson = {
  slack_user_id: string;
  codecast_user_id: Id<"users"> | null;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  is_bot: boolean;
};

async function resolvePerson(ctx: ActionCtx, install: Install, slackUserId: string): Promise<ResolvedPerson> {
  let row = await ctx.runQuery(internal.slackSync.getSlackUser, { workspace_id: install.workspace_id, slack_user_id: slackUserId });
  if (!row || Date.now() - row.fetched_at > PROFILE_TTL_MS) {
    const resp = await slackApi(install.bot_token, "users.info", { user: slackUserId });
    if (resp.ok && resp.user) {
      row = await ctx.runMutation(internal.slackSync.upsertSlackUser, {
        workspace_id: install.workspace_id,
        slack_user_id: slackUserId,
        team_id: install.team_id,
        profile: resp.user,
      });
    }
  }
  return {
    slack_user_id: slackUserId,
    codecast_user_id: row?.codecast_user_id ?? null,
    name: row?.name ?? "Someone",
    handle: row?.handle ?? null,
    avatar_url: row?.avatar_url ?? null,
    is_bot: !!row?.is_bot,
  };
}

// The handle a mapped teammate answers to in chat, so `<@U>` becomes a real
// mention of them.
export const teammateHandles = internalQuery({
  args: { user_ids: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const out: Record<string, string | null> = {};
    for (const id of args.user_ids) {
      const u = await ctx.db.get(id);
      out[id] = u ? memberHandle({ github_username: u.github_username, email: u.email, name: u.name, is_bot: u.is_bot }) : null;
    }
    return out;
  },
});

// The codecast teammate a Slack person counts AS in this channel: only when the
// email matched somebody and the link is set to honour that match. The one rule
// behind the author of a line, the owner of a reaction and a real @mention.
function mappedTeammate(person: ResolvedPerson | null, link: Link): Id<"users"> | null {
  if (!person?.codecast_user_id || !link.options.match_people_by_email) return null;
  return person.codecast_user_id;
}

// Who a Slack line is BY, in chat's terms. A Slack person whose email matches a
// teammate IS that teammate, when the link allows it; anyone else speaks through
// the workspace's bridge identity with a snapshot of their own name and face.
// One answer for every inbound line — a message, a topic change, a join notice.
function inboundAuthorFields(person: ResolvedPerson | null, link: Link): {
  author_user_id?: Id<"users">;
  external_author?: Doc<"chat_messages">["external_author"];
} {
  if (!person) return {};
  const teammate = mappedTeammate(person, link);
  if (teammate) return { author_user_id: teammate };
  return {
    external_author: {
      name: person.name,
      handle: person.handle ?? undefined,
      avatar_url: person.avatar_url ?? undefined,
      is_bot: person.is_bot || undefined,
    },
  };
}

async function buildInboundResolver(
  ctx: ActionCtx,
  install: Install,
  link: Link,
  anchorHandle: string | null,
  text: string,
): Promise<SlackInboundResolver> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(m[1]);
  const people = new Map<string, ResolvedPerson>();
  for (const id of ids) {
    if (id === install.bot_user_id) continue;
    people.set(id, await resolvePerson(ctx, install, id));
  }
  const mappedIds = [...people.values()].map((p) => p.codecast_user_id).filter((x): x is Id<"users"> => !!x);
  const handles = mappedIds.length > 0 && link.options.match_people_by_email
    ? await ctx.runQuery(internal.slackSync.teammateHandles, { user_ids: mappedIds })
    : {};
  return {
    user: (id) => {
      if (id === install.bot_user_id) return anchorHandle ? { handle: anchorHandle, name: "Codecast" } : { name: "Codecast" };
      const p = people.get(id);
      if (!p) return null;
      const teammate = mappedTeammate(p, link);
      return { handle: teammate ? handles[teammate] ?? null : null, name: p.name };
    },
  };
}

function isOwnBotEvent(install: Install, event: any): boolean {
  if (event?.user && event.user === install.bot_user_id) return true;
  const appId = event?.bot_profile?.app_id ?? event?.app_id ?? event?.message?.bot_profile?.app_id;
  return !!(install.app_id && appId && appId === install.app_id);
}

type InboundFile = { storage_id: Id<"_storage">; name?: string; mime?: string; width?: number; height?: number };

async function mirrorFiles(ctx: ActionCtx, install: Install, files: any[]): Promise<{ attachments: InboundFile[]; extra: string[] }> {
  const attachments: InboundFile[] = [];
  const extra: string[] = [];
  for (const f of files ?? []) {
    if (!f || f.mode === "tombstone" || f.mode === "hidden_by_limit") continue;
    const mime = String(f.mimetype ?? "");
    const isImage = mime.startsWith("image/");
    const size = Number(f.size ?? 0);
    const url = f.url_private_download || f.url_private;
    if (isImage && url && size > 0 && size <= MAX_FILE_BYTES) {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${install.bot_token}` } });
        if (resp.ok) {
          const blob = await resp.blob();
          const storageId = await ctx.storage.store(new Blob([await blob.arrayBuffer()], { type: mime }));
          attachments.push({
            storage_id: storageId,
            name: f.name ? String(f.name).slice(0, 120) : undefined,
            mime,
            width: typeof f.original_w === "number" ? f.original_w : undefined,
            height: typeof f.original_h === "number" ? f.original_h : undefined,
          });
          continue;
        }
      } catch {
        // fall through to a link line
      }
    }
    const label = f.title || f.name || "file";
    if (f.permalink) extra.push(`📎 [${label}](${f.permalink})`);
  }
  return { attachments, extra };
}

// One Slack message (root, reply, broadcast, bot card, file share) to a chat line.
async function mirrorMessage(
  ctx: ActionCtx,
  c: { install: Install; link: Link; anchor_handle: string | null },
  msg: any,
  opts: { live: boolean },
): Promise<{ status: string; message_id?: Id<"chat_messages"> }> {
  const { install, link } = c;
  if (!msg?.ts) return { status: "no_ts" };
  if (isOwnBotEvent(install, msg)) return { status: "own_bot" };
  const isBot = !!msg.bot_id || msg.subtype === "bot_message" || (!msg.user && !!msg.bot_profile);
  if (isBot && !link.options.bot_messages) return { status: "bot_off" };
  if (Number(msg.ts) < Number(link.since_ts)) return { status: "before_link" };
  const isReply = !!msg.thread_ts && msg.thread_ts !== msg.ts;
  if (isReply && !link.options.threads && msg.subtype !== "thread_broadcast") return { status: "threads_off" };

  // Author. A Slack app has no profile to resolve: its bot card carries the
  // name and face it posts under.
  let author: ReturnType<typeof inboundAuthorFields>;
  if (msg.user && !isBot) {
    author = inboundAuthorFields(await resolvePerson(ctx, install, msg.user), link);
  } else {
    const bp = msg.bot_profile ?? {};
    author = {
      external_author: {
        name: String(bp.name || msg.username || "Slack app").slice(0, 80),
        avatar_url: bp.icons?.image_72 || bp.icons?.image_48 || undefined,
        is_bot: true,
      },
    };
  }

  // Body.
  const rawText = String(msg.text ?? "");
  const resolver = await buildInboundResolver(ctx, install, link, c.anchor_handle, rawText);
  const parts: string[] = [];
  const body = slackToMarkdown(rawText, resolver);
  if (body) parts.push(body);
  const cards = slackAttachmentsToMarkdown(msg.attachments, resolver);
  if (cards) parts.push(cards);
  let attachments: InboundFile[] = [];
  if (Array.isArray(msg.files) && msg.files.length > 0) {
    if (link.options.files) {
      const mirrored = await mirrorFiles(ctx, install, msg.files);
      attachments = mirrored.attachments;
      if (mirrored.extra.length > 0) parts.push(mirrored.extra.join("\n"));
    } else {
      parts.push(msg.files.map((f: any) => `📎 ${f.title || f.name || "file"}`).join("\n"));
    }
  }
  const content = capContent(parts.join("\n\n").trim());
  if (!content && attachments.length === 0) return { status: "empty" };

  // A reply whose root is not here yet (older than the link, or lost): bring
  // the root first so the thread has its shape.
  let rootTs: string | undefined = isReply ? msg.thread_ts : undefined;
  if (rootTs) {
    const rootRow = await ctx.runQuery(internal.slackSync.findMirrored, { link_id: link._id, ts: rootTs });
    if (!rootRow) {
      const hist = await slackApi(install.bot_token, "conversations.history", {
        channel: link.slack_channel_id, latest: rootTs, oldest: rootTs, inclusive: "true", limit: "1",
      });
      const root = hist.ok ? hist.messages?.[0] : null;
      if (root && root.ts === rootTs) {
        const bypass = { ...link, since_ts: "0", options: { ...link.options, bot_messages: true } };
        await mirrorMessage(ctx, { ...c, link: bypass }, root, { live: false });
      }
      const again = await ctx.runQuery(internal.slackSync.findMirrored, { link_id: link._id, ts: rootTs });
      if (!again) rootTs = undefined;
    }
  }

  const permalink = await permalinkFor(install, link.slack_channel_id, msg.ts);
  return await ctx.runMutation(internal.slackSync.applyInboundMessage, {
    link_id: link._id,
    ts: msg.ts,
    thread_ts: rootTs,
    broadcast: msg.subtype === "thread_broadcast" || undefined,
    slack_user: msg.user ?? undefined,
    ...author,
    content,
    attachments,
    permalink: permalink ?? undefined,
    created_at: opts.live ? undefined : slackTsToMs(msg.ts),
    live: opts.live,
  });
}

async function permalinkFor(install: Install, channel: string, ts: string): Promise<string | null> {
  const resp = await slackApi(install.bot_token, "chat.getPermalink", { channel, message_ts: ts });
  return resp.ok && typeof resp.permalink === "string" ? resp.permalink : null;
}

export const findMirrored = internalQuery({
  args: { link_id: v.id("slack_channel_links"), ts: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return null;
    return await findMirroredRow(ctx, link, args.ts);
  },
});

export const processEvent = internalAction({
  args: { job_id: v.id("slack_sync_events") },
  // Annotated because the handler schedules ITSELF on retry, which would
  // otherwise make its inferred type circular.
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.runQuery(internal.slackSync.jobContext, { job_id: args.job_id });
    if (!c?.job || c.job.status !== "queued") return;
    const { job, link, install, channel } = c;
    if (!link || !install || !channel) {
      await ctx.runMutation(internal.slackSync.markJob, { job_id: job._id, status: "skipped", error: "link gone" });
      return;
    }
    if (channel.archived_at) {
      await ctx.runMutation(internal.slackSync.markJob, { job_id: job._id, status: "skipped", error: "chat channel archived" });
      return;
    }
    const event = job.payload ?? {};
    const finish = (status: "done" | "skipped" | "failed", error?: string): Promise<void> =>
      ctx.runMutation(internal.slackSync.markJob, { job_id: job._id, status, error, bump_attempts: true }).then(() => undefined);
    try {
      const type = String(event.type ?? "");
      if (type === "message") {
        const sub = event.subtype as string | undefined;
        if (sub === undefined || sub === "file_share" || sub === "thread_broadcast" || sub === "bot_message") {
          const res = await mirrorMessage(ctx, { install, link, anchor_handle: c.anchor_handle }, event, { live: true });
          await finish(res.message_id ? "done" : "skipped", res.message_id ? undefined : res.status);
          return;
        }
        if (sub === "message_changed") {
          if (!link.options.edits) return await finish("skipped", "edits_off");
          const m = event.message ?? {};
          if (isOwnBotEvent(install, m)) return await finish("skipped", "own_bot");
          const resolver = await buildInboundResolver(ctx, install, link, c.anchor_handle, String(m.text ?? ""));
          const parts = [slackToMarkdown(String(m.text ?? ""), resolver), slackAttachmentsToMarkdown(m.attachments, resolver)].filter(Boolean);
          const res = await ctx.runMutation(internal.slackSync.applyInboundEdit, {
            link_id: link._id, ts: String(m.ts ?? event.previous_message?.ts ?? ""), content: parts.join("\n\n").trim(),
          });
          await finish(res.status === "edited" ? "done" : "skipped", res.status === "edited" ? undefined : res.status);
          return;
        }
        if (sub === "message_deleted") {
          if (!link.options.edits) return await finish("skipped", "edits_off");
          const res = await ctx.runMutation(internal.slackSync.applyInboundDelete, { link_id: link._id, ts: String(event.deleted_ts ?? "") });
          await finish(res.status === "deleted" ? "done" : "skipped", res.status === "deleted" ? undefined : res.status);
          return;
        }
        // System notices.
        if (!link.options.system_messages) return await finish("skipped", "system_off");
        const who = event.user ? await resolvePerson(ctx, install, event.user) : null;
        const line = systemNoticeLine(sub, who?.name ?? "Someone", event);
        if (!line) return await finish("skipped", sub);
        const res = await ctx.runMutation(internal.slackSync.applyInboundMessage, {
          link_id: link._id,
          ts: String(event.ts),
          slack_user: event.user ?? undefined,
          ...inboundAuthorFields(who, link),
          content: `*${line}*`,
          attachments: [],
          live: false,
        });
        await finish(res.message_id ? "done" : "skipped", res.message_id ? undefined : res.status);
        return;
      }
      if (type === "reaction_added" || type === "reaction_removed") {
        if (!link.options.reactions) return await finish("skipped", "reactions_off");
        if (event.user === install.bot_user_id) return await finish("skipped", "own_bot");
        const emoji = shortcodeToEmoji(String(event.reaction ?? ""));
        if (!emoji) return await finish("skipped", `unknown_emoji:${event.reaction}`);
        const person = await resolvePerson(ctx, install, String(event.user));
        const res = await ctx.runMutation(internal.slackSync.applyInboundReaction, {
          link_id: link._id,
          ts: String(event.item?.ts ?? ""),
          emoji,
          add: type === "reaction_added",
          user_id: mappedTeammate(person, link) ?? undefined,
        });
        await finish(res.status === "applied" ? "done" : "skipped", res.status === "applied" ? undefined : res.status);
        return;
      }
      if (type === "member_joined_channel" || type === "member_left_channel") {
        if (event.user === install.bot_user_id) {
          // The app was removed from the channel: the mirror cannot work.
          if (type === "member_left_channel") {
            await ctx.runMutation(internal.slackSync.pauseLink, { link_id: link._id, error: "The app was removed from the Slack channel" });
          }
          return await finish("done");
        }
        if (!link.options.system_messages) return await finish("skipped", "system_off");
        const who = await resolvePerson(ctx, install, String(event.user));
        const res = await ctx.runMutation(internal.slackSync.applyInboundMessage, {
          link_id: link._id,
          ts: String(event.event_ts ?? nowTs()),
          slack_user: event.user,
          ...inboundAuthorFields(who, link),
          content: `*${who.name} ${type === "member_joined_channel" ? "joined" : "left"} the Slack channel*`,
          attachments: [],
          live: false,
        });
        await finish(res.message_id ? "done" : "skipped", res.message_id ? undefined : res.status);
        return;
      }
      await finish("skipped", type);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (job.attempts + 1 < JOB_MAX_ATTEMPTS) {
        await ctx.runMutation(internal.slackSync.markJob, { job_id: job._id, status: "queued", error: msg, bump_attempts: true });
        await ctx.scheduler.runAfter(15_000 * (job.attempts + 1), internal.slackSync.processEvent, { job_id: job._id });
      } else {
        await finish("failed", msg);
      }
    }
  },
});

// What Slack's own housekeeping reads as in chat. Null for a subtype worth no
// line at all, which the caller records as a skip.
function systemNoticeLine(subtype: string | undefined, who: string, event: any): string | null {
  const plain = (raw: unknown) => slackToMarkdown(String(raw ?? ""), { user: () => null });
  switch (subtype) {
    case "channel_join": return `${who} joined the Slack channel`;
    case "channel_leave": return `${who} left the Slack channel`;
    case "channel_topic": return `${who} set the Slack topic: ${plain(event.topic)}`;
    case "channel_purpose": return `${who} set the Slack purpose: ${plain(event.purpose)}`;
    case "channel_name": return `${who} renamed the Slack channel to #${event.name ?? ""}`;
    case "pinned_item": return `${who} pinned a message in Slack`;
    default: return null;
  }
}

export const pauseLink = internalMutation({
  args: { link_id: v.id("slack_channel_links"), error: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return;
    await ctx.db.patch(link._id, { paused: true, last_error: args.error, last_error_at: Date.now(), updated_at: Date.now() });
  },
});

// ── Inbound: apply ───────────────────────────────────────────────────────────

export const applyInboundMessage = internalMutation({
  args: {
    link_id: v.id("slack_channel_links"),
    ts: v.string(),
    thread_ts: v.optional(v.string()),
    broadcast: v.optional(v.boolean()),
    slack_user: v.optional(v.string()),
    author_user_id: v.optional(v.id("users")),
    external_author: v.optional(v.object({
      name: v.string(),
      handle: v.optional(v.string()),
      avatar_url: v.optional(v.string()),
      is_bot: v.optional(v.boolean()),
    })),
    content: v.string(),
    attachments: v.array(v.object({
      storage_id: v.id("_storage"),
      name: v.optional(v.string()),
      mime: v.optional(v.string()),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    })),
    permalink: v.optional(v.string()),
    created_at: v.optional(v.number()),
    live: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ status: string; message_id?: Id<"chat_messages"> }> => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return { status: "no_link" };
    const channel = await ctx.db.get(link.chat_channel_id);
    if (!channel || channel.archived_at) return { status: "no_channel" };
    const install = await ctx.db.get(link.installation_id);
    if (!install) return { status: "no_install" };
    const clientId = slackClientId(link.workspace_id, link.slack_channel_id, args.ts);
    const dup = await findByClientId(ctx, channel._id, clientId);
    if (dup) return { status: "duplicate", message_id: dup._id };

    let root: Doc<"chat_messages"> | null = null;
    if (args.thread_ts) {
      root = await findMirroredRow(ctx, link, args.thread_ts);
      if (root?.thread_root_id) root = (await ctx.db.get(root.thread_root_id)) ?? root;
    }
    const authorId = args.author_user_id ?? (await ensureBridgeUser(ctx, install));
    // A backfilled line must not sort after live lines it predates, and must
    // not collide with a stamp already in the channel.
    let createdAt = args.created_at;
    if (createdAt !== undefined) {
      const clash = await ctx.db
        .query("chat_messages")
        .withIndex("by_channel_created", (q: any) => q.eq("channel_id", channel._id).eq("created_at", createdAt))
        .first();
      if (clash) createdAt += 1;
    }
    const posted = await postChatMessage(ctx, {
      channel,
      root,
      authorId,
      content: args.content,
      attachments: args.attachments,
      clientId,
      broadcast: args.broadcast,
      external: {
        provider: "slack",
        direction: "inbound",
        workspace: link.workspace_id,
        channel: link.slack_channel_id,
        ts: args.ts,
        thread_ts: args.thread_ts,
        user: args.slack_user,
        permalink: args.permalink,
        synced_at: Date.now(),
      },
      externalAuthor: args.external_author,
      createdAt,
    });
    await ctx.db.patch(link._id, {
      last_inbound_at: Date.now(),
      inbound_count: (link.inbound_count ?? 0) + 1,
      updated_at: Date.now(),
    });
    // A live line wakes what it names, by the chat rules. A backfilled one is
    // history and wakes nobody.
    if (args.live) {
      const message = await ctx.db.get(posted.messageId);
      if (message) {
        try {
          await maybeWakeAnchor(ctx, {
            channel, message, root, senderId: authorId, senderName: posted.actorName, mentions: posted.mentions,
          });
        } catch (error) {
          console.warn("[slackSync] anchor wake skipped", error instanceof Error ? error.message : error);
        }
        if (posted.roles.length > 0 || posted.sessions.length > 0) {
          try {
            await wakeMentionedParties(ctx, {
              channel, message, root, senderId: authorId, senderName: posted.actorName, roles: posted.roles, sessions: posted.sessions,
            });
          } catch (error) {
            console.warn("[slackSync] mention wake skipped", error instanceof Error ? error.message : error);
          }
        }
      }
    }
    return { status: "posted", message_id: posted.messageId };
  },
});

export const applyInboundEdit = internalMutation({
  args: { link_id: v.id("slack_channel_links"), ts: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return { status: "no_link" };
    const row = await findMirroredRow(ctx, link, args.ts);
    if (!row) return { status: "not_mirrored" };
    // Slack also reports OUR chat.update as message_changed: never loop that back.
    if (row.external?.direction !== "inbound") return { status: "not_inbound" };
    if (row.deleted_at) return { status: "deleted" };
    const content = capContent(args.content);
    if (!content.trim() && !(row.attachments?.length)) return { status: "empty" };
    if (content === row.content) return { status: "unchanged" };
    const resolved = await resolveChatMentions(ctx, row.team_id, content, row.user_id);
    await patchChat(ctx, row._id, {
      content,
      mentions: resolved.refs.length > 0 ? (resolved.refs as any) : undefined,
      edited_at: Date.now(),
      external: { ...row.external, synced_at: Date.now() },
    });
    return { status: "edited", message_id: row._id };
  },
});

export const applyInboundDelete = internalMutation({
  args: { link_id: v.id("slack_channel_links"), ts: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return { status: "no_link" };
    const row = await findMirroredRow(ctx, link, args.ts);
    if (!row) return { status: "not_mirrored" };
    if (row.deleted_at) return { status: "already" };
    if (row.external?.direction !== "inbound") {
      // Somebody deleted the bot's copy in Slack. The codecast line stays; it
      // just no longer has a Slack twin.
      await patchChat(ctx, row._id, { external: undefined });
      return { status: "detached" };
    }
    await tombstoneChatMessage(ctx, row._id);
    return { status: "deleted", message_id: row._id };
  },
});

export const applyInboundReaction = internalMutation({
  args: {
    link_id: v.id("slack_channel_links"),
    ts: v.string(),
    emoji: v.string(),
    add: v.boolean(),
    user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return { status: "no_link" };
    if (!isValidEmoji(args.emoji)) return { status: "bad_emoji" };
    const row = await findMirroredRow(ctx, link, args.ts);
    if (!row || row.deleted_at) return { status: "not_mirrored" };
    const install = await ctx.db.get(link.installation_id);
    if (!install) return { status: "no_install" };
    const userId = args.user_id ?? (await ensureBridgeUser(ctx, install));
    const existing = await ctx.db
      .query("chat_reactions")
      .withIndex("by_message_user_emoji", (q: any) => q.eq("message_id", row._id).eq("user_id", userId).eq("emoji", args.emoji))
      .first();
    if (args.add && !existing) {
      await ctx.db.insert("chat_reactions", {
        message_id: row._id,
        channel_id: row.channel_id,
        user_id: userId,
        emoji: args.emoji,
        created_at: Date.now(),
      });
      await patchChat(ctx, row._id, {});
      return { status: "applied" };
    }
    if (!args.add && existing) {
      await ctx.db.delete(existing._id);
      await patchChat(ctx, row._id, {});
      return { status: "applied" };
    }
    return { status: "noop" };
  },
});

// ── Backfill ─────────────────────────────────────────────────────────────────

export const backfill = internalAction({
  args: { link_id: v.id("slack_channel_links"), oldest_ts: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.runQuery(internal.slackSync.linkContext, { link_id: args.link_id });
    if (!c?.link || !c.install) return;
    const { link, install } = c;
    const messages: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5 && messages.length < BACKFILL_MAX_MESSAGES; page++) {
      const resp = await slackApi(install.bot_token, "conversations.history", {
        channel: link.slack_channel_id, oldest: args.oldest_ts, limit: "200", cursor, inclusive: "true",
      });
      if (!resp.ok) {
        await ctx.runMutation(internal.slackSync.pauseLink, { link_id: link._id, error: `Backfill failed: ${resp.error}` });
        return;
      }
      messages.push(...(resp.messages ?? []));
      cursor = resp.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    // History is newest first; apply oldest first so stamps ascend.
    messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    const ctxRow = { install, link: { ...link, since_ts: args.oldest_ts }, anchor_handle: c.anchor_handle };
    for (const m of messages.slice(0, BACKFILL_MAX_MESSAGES)) {
      if (m.subtype && m.subtype !== "file_share" && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message") continue;
      await mirrorMessage(ctx, ctxRow, m, { live: false });
      if (link.options.threads && m.reply_count > 0) {
        let replyCursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const replies = await slackApi(install.bot_token, "conversations.replies", {
            channel: link.slack_channel_id, ts: m.ts, limit: "200", cursor: replyCursor,
          });
          if (!replies.ok) break;
          for (const r of (replies.messages ?? []).filter((x: any) => x.ts !== m.ts)) {
            await mirrorMessage(ctx, ctxRow, r, { live: false });
          }
          replyCursor = replies.response_metadata?.next_cursor || undefined;
          if (!replyCursor) break;
        }
      }
    }
  },
});

export const linkContext = internalQuery({
  args: { link_id: v.id("slack_channel_links") },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return null;
    const install = await ctx.db.get(link.installation_id);
    const channel = await ctx.db.get(link.chat_channel_id);
    const anchor = channel ? await resolveChannelAnchor(ctx, channel) : null;
    const anchorBot = anchor ? await ctx.db.get(anchor.bot_user_id) : null;
    return { link, install, channel, anchor_handle: anchorBot ? botHandle(anchorBot.name) : null };
  },
});

// ── Outbound ─────────────────────────────────────────────────────────────────

// Everything one push needs, read in a single query so the action makes exactly
// one db round trip before it talks to Slack. Named, because composeOutbound
// takes it and a query handler's inferred type cannot be referenced.
type PushContext = {
  message: Doc<"chat_messages">;
  link: Link;
  install: Install;
  channel: Doc<"chat_channels">;
  root_ts: string | null;
  author: { name: string; image: string | null; isAgent: boolean; via: string | null };
  handle_to_slack: Record<string, string>;
  attachments: Array<{ url: string; name: string | null; mime: string | null }>;
};

export const pushContext = internalQuery({
  args: { message_id: v.id("chat_messages") },
  handler: async (ctx, args): Promise<PushContext | null> => {
    const message = await ctx.db.get(args.message_id);
    if (!message) return null;
    const link = await slackLinkForChannel(ctx, message.channel_id);
    if (!link) return null;
    const install = await ctx.db.get(link.installation_id);
    const channel = await ctx.db.get(message.channel_id);
    if (!install || !channel) return null;
    const author = await ctx.db.get(message.user_id);
    const root = message.thread_root_id ? await ctx.db.get(message.thread_root_id) : null;
    // Mentions written in the line, mapped to Slack people where we know them.
    const handleToSlack: Record<string, string> = {};
    for (const ref of message.mentions ?? []) {
      if (typeof ref !== "string") continue;
      const u = await ctx.db.get(ref as Id<"users">);
      if (!u) continue;
      const handle = memberHandle({ github_username: u.github_username, email: u.email, name: u.name, is_bot: u.is_bot });
      if (!handle) continue;
      const rows = await ctx.db
        .query("slack_users")
        .withIndex("by_codecast_user", (q: any) => q.eq("codecast_user_id", u._id))
        .collect();
      const inWorkspace = rows.find((r) => r.workspace_id === link.workspace_id);
      if (inWorkspace) handleToSlack[handle] = inWorkspace.slack_user_id;
    }
    let via: string | null = null;
    let name = author?.name || author?.github_username || author?.email || "Someone";
    if (message.origin === "agent" && message.origin_session_title) {
      via = name;
      name = message.origin_session_title;
    }
    const attachmentUrls: Array<{ url: string; name: string | null; mime: string | null }> = [];
    for (const a of message.attachments ?? []) {
      const url = await ctx.storage.getUrl(a.storage_id);
      if (url) attachmentUrls.push({ url, name: a.name ?? null, mime: a.mime ?? null });
    }
    return {
      message,
      link,
      install,
      channel,
      root_ts: root?.external?.ts ?? null,
      author: {
        name: oneLine(name, 80),
        image: author?.image ?? null,
        isAgent: isAgentLine(message),
        via,
      },
      handle_to_slack: handleToSlack,
      attachments: attachmentUrls,
    };
  },
});

function outboundResolver(handleToSlack: Record<string, string>) {
  const base = webBaseUrl();
  return {
    handleToSlackUser: (handle: string) => handleToSlack[handle] ?? null,
    entityUrl: (id: string) => {
      if (id.startsWith("ct-")) return `${base}/tasks/${id}`;
      if (id.startsWith("pl-")) return `${base}/plans/${id}`;
      if (id.startsWith("tr-")) return `${base}/triggers/${id}`;
      return null;
    },
  };
}

function composeOutbound(c: PushContext) {
  const text = markdownToSlack(c.message.content, outboundResolver(c.handle_to_slack));
  const blocks: any[] = [];
  const images = c.link.options.files ? c.attachments.filter((a) => a.mime?.startsWith("image/")) : [];
  const others = c.link.options.files ? c.attachments.filter((a) => !a.mime?.startsWith("image/")) : [];
  let body = text;
  if (others.length > 0) {
    body = [body, ...others.map((a) => `<${a.url}|${a.name ?? "file"}>`)].filter(Boolean).join("\n");
  }
  if (images.length > 0) {
    if (body) blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
    for (const img of images) {
      blocks.push({ type: "image", image_url: img.url, alt_text: img.name ?? "image" });
    }
  }
  const fallback = body || (images.length > 0 ? `${images.length === 1 ? "an image" : `${images.length} images`}` : "");
  return { text: fallback, blocks: blocks.length > 0 ? blocks : undefined };
}

async function recoverNotInChannel(install: Install, link: Link, error: string | undefined): Promise<boolean> {
  if (error !== "not_in_channel" || link.slack_channel_private) return false;
  const joined = await slackApi(install.bot_token, "conversations.join", { channel: link.slack_channel_id });
  return !!joined.ok;
}

// The push context for a line the mirror may still act on in Slack, or null.
// `ours` demands a line the bot itself posted: Slack refuses chat.update and
// chat.delete on anybody else's message.
async function pushableContext(
  ctx: ActionCtx,
  messageId: Id<"chat_messages">,
  opts: { option: "edits" | "reactions"; ours: boolean },
): Promise<PushContext | null> {
  const c = await ctx.runQuery(internal.slackSync.pushContext, { message_id: messageId });
  if (!c || !c.message.external) return null;
  if (opts.ours && c.message.external.direction !== "outbound") return null;
  if (!linkSendsOutbound(c.link) || !c.link.options[opts.option]) return null;
  return c;
}

// One place the link's error strip learns a push went wrong.
async function noteOutboundFailure(ctx: ActionCtx, link: Link, error: string): Promise<void> {
  await ctx.runMutation(internal.slackSync.recordOutboundFailure, { link_id: link._id, error });
}

export const pushMessage = internalAction({
  args: { message_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const c = await ctx.runQuery(internal.slackSync.pushContext, { message_id: args.message_id });
    if (!c) return;
    const skip = outboundSkipReason(c.link, c.message);
    if (skip) return;
    // A reply whose root never reached Slack has no thread to land in; posting
    // it at the top level would read as a non sequitur. Leave it home.
    if (c.message.thread_root_id && !c.root_ts) return;
    const { text, blocks } = composeOutbound(c);
    if (!text && !blocks) return;
    const params: Record<string, unknown> = {
      channel: c.link.slack_channel_id,
      text,
      blocks,
      username: slackDisplayName(c.author),
      icon_url: c.author.image ?? undefined,
      thread_ts: c.message.thread_root_id ? c.root_ts ?? undefined : undefined,
      reply_broadcast: c.message.thread_root_id && c.message.broadcast && c.root_ts ? true : undefined,
      unfurl_links: false,
      unfurl_media: true,
    };
    let resp = await slackApi(c.install.bot_token, "chat.postMessage", params);
    if (!resp.ok && (await recoverNotInChannel(c.install, c.link, resp.error))) {
      resp = await slackApi(c.install.bot_token, "chat.postMessage", params);
    }
    if (!resp.ok && (resp.error === "missing_scope" || resp.error === "invalid_arguments") && params.username) {
      // An older install without chat:write.customize: post plainly, prefixed.
      const { username, icon_url, ...plain } = params;
      plain.text = `*${username}:* ${text}`;
      resp = await slackApi(c.install.bot_token, "chat.postMessage", plain);
    }
    if (!resp.ok) {
      await noteOutboundFailure(ctx, c.link, String(resp.error ?? "unknown"));
      return;
    }
    const permalink = await permalinkFor(c.install, c.link.slack_channel_id, String(resp.ts));
    await ctx.runMutation(internal.slackSync.stampOutbound, {
      message_id: c.message._id,
      link_id: c.link._id,
      ts: String(resp.ts),
      thread_ts: typeof params.thread_ts === "string" ? params.thread_ts : undefined,
      permalink: permalink ?? undefined,
    });
  },
});

export const pushEdit = internalAction({
  args: { message_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const c = await pushableContext(ctx, args.message_id, { option: "edits", ours: true });
    if (!c) return;
    const { text, blocks } = composeOutbound(c);
    const resp = await slackApi(c.install.bot_token, "chat.update", {
      channel: c.link.slack_channel_id, ts: c.message.external!.ts, text, blocks: blocks ?? [],
    });
    if (!resp.ok) await noteOutboundFailure(ctx, c.link, `edit: ${resp.error}`);
  },
});

export const pushDelete = internalAction({
  args: { message_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const c = await pushableContext(ctx, args.message_id, { option: "edits", ours: true });
    if (!c) return;
    const resp = await slackApi(c.install.bot_token, "chat.delete", { channel: c.link.slack_channel_id, ts: c.message.external!.ts });
    if (!resp.ok && resp.error !== "message_not_found") {
      await noteOutboundFailure(ctx, c.link, `delete: ${resp.error}`);
    }
  },
});

export const pushReaction = internalAction({
  args: { message_id: v.id("chat_messages"), emoji: v.string(), add: v.boolean() },
  handler: async (ctx, args) => {
    const c = await pushableContext(ctx, args.message_id, { option: "reactions", ours: false });
    if (!c) return;
    const name = emojiToShortcode(args.emoji);
    if (!name) return;
    const resp = await slackApi(c.install.bot_token, args.add ? "reactions.add" : "reactions.remove", {
      channel: c.link.slack_channel_id, timestamp: c.message.external!.ts, name,
    });
    if (!resp.ok && resp.error !== "already_reacted" && resp.error !== "no_reaction" && resp.error !== "invalid_name") {
      await noteOutboundFailure(ctx, c.link, `reaction: ${resp.error}`);
    }
  },
});

export const stampOutbound = internalMutation({
  args: {
    message_id: v.id("chat_messages"),
    link_id: v.id("slack_channel_links"),
    ts: v.string(),
    thread_ts: v.optional(v.string()),
    permalink: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.message_id);
    const link = await ctx.db.get(args.link_id);
    if (!message || !link) return;
    if (message.external) return; // a race posted twice; keep the first stamp
    await patchChat(ctx, message._id, {
      external: {
        provider: "slack",
        direction: "outbound",
        workspace: link.workspace_id,
        channel: link.slack_channel_id,
        ts: args.ts,
        thread_ts: args.thread_ts,
        permalink: args.permalink,
        synced_at: Date.now(),
      },
    });
    await ctx.db.patch(link._id, {
      last_outbound_at: Date.now(),
      outbound_count: (link.outbound_count ?? 0) + 1,
      last_error: undefined,
      last_error_at: undefined,
      updated_at: Date.now(),
    });
  },
});

export const recordOutboundFailure = internalMutation({
  args: { link_id: v.id("slack_channel_links"), error: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return;
    const fatal = ["channel_not_found", "is_archived", "account_inactive", "token_revoked", "invalid_auth"];
    const patch: Partial<Link> = { last_error: args.error.slice(0, 300), last_error_at: Date.now(), updated_at: Date.now() };
    if (fatal.some((f) => args.error.includes(f))) patch.paused = true;
    await ctx.db.patch(link._id, patch);
  },
});

// ── Maintenance ──────────────────────────────────────────────────────────────

export const sweepSyncEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let deleted = 0;
    for (const [status, ageMs] of [["done", 86_400_000], ["skipped", 86_400_000], ["failed", 7 * 86_400_000]] as const) {
      const cutoff = now - ageMs;
      const stale = await ctx.db
        .query("slack_sync_events")
        .withIndex("by_status_created", (q: any) => q.eq("status", status).lt("created_at", cutoff))
        .take(500);
      for (const row of stale) await ctx.db.delete(row._id);
      deleted += stale.length;
    }
    // A job stuck in "queued" past an hour lost its action; requeue once.
    const stuck = await ctx.db
      .query("slack_sync_events")
      .withIndex("by_status_created", (q: any) => q.eq("status", "queued").lt("created_at", now - 3_600_000))
      .take(50);
    for (const job of stuck) {
      if (job.attempts >= JOB_MAX_ATTEMPTS) {
        await ctx.db.patch(job._id, { status: "failed", error: "gave up", processed_at: now });
      } else {
        await ctx.scheduler.runAfter(0, internal.slackSync.processEvent, { job_id: job._id });
      }
    }
    return { deleted, requeued: stuck.length };
  },
});
