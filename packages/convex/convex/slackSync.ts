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
import { api, internal } from "./_generated/api";
import { getAuthenticatedUserId } from "./pendingMessages";
import { isTeamAdmin, isTeamMember } from "./privacy";
import { canAccessChannel } from "./chatAccess";
import {
  ensureDmRoom,
  displayName,
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
import { resolveChatMentions, slackPersonForHandle, teamRoster } from "./lib/mentionResolve";
import { isValidEmoji, MAX_CHAT_CONTENT, normalizeChannelName, oneLine } from "./chatText";
import { botHandle, dmKeyFor, extractMentionHandles, memberHandle } from "@codecast/shared/chat";
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
import {
  type BackfillWindow, DIRECTION_FLOW, DIRECTION_SENTENCE, LINK_DEFAULTS, mergeLinkOptions } from "./lib/slackMirror";
import { tokenCanPost, tokenHasDmScopes, webBaseUrl } from "./slack";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type Link = Doc<"slack_channel_links">;
type Install = Doc<"slack_installations">;

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// One import brings over at most this many lines (roots and replies): a
// ceiling so "everything" on a years old, bot heavy channel cannot run for
// hours, high enough that a busy team channel's whole history fits. The link
// records when it was hit.
const BACKFILL_MAX_TOTAL = 25_000;
// One import run stops taking new roots after this long and hands the rest to
// the next scheduled run, so a page of long threads with files never nears the
// action's own time limit. Progress lands on the link between runs.
const BACKFILL_RUN_BUDGET_MS = 40_000;
const BACKFILL_PAGE = 100;
// An import that has not reported in this long lost its action (a deploy mid
// run, a killed action). A run reports in within about two minutes even with a
// long thread, so five minutes of silence is a stall; the hourly sweep marks it
// stopped, and a Run again is allowed past the "still running" check.
const BACKFILL_STALL_MS = 5 * 60_000;
function importStalled(link: Link, now = Date.now()): boolean {
  const b = link.backfill;
  return !!b && b.status === "running" && (b.heartbeat_at ?? b.started_at) < now - BACKFILL_STALL_MS;
}
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

// A mirrored channel wears the Slack channel's name: one name for one room,
// on both sides, with the Slack mark as the label. Applied when the link is
// made and again when Slack renames. Best effort: a name another chat channel
// in the team already holds is left alone rather than colliding.
async function adoptSlackName(ctx: MutationCtx, channel: Doc<"chat_channels">, slackName: string | undefined): Promise<string> {
  const name = normalizeChannelName(slackName ?? "");
  if (!name || name === channel.name) return channel.name;
  const taken = await ctx.db
    .query("chat_channels")
    .withIndex("by_team_name", (q: any) => q.eq("team_id", channel.team_id).eq("name", name))
    .first();
  if (taken && taken._id.toString() !== channel._id.toString()) return channel.name;
  await patchChat(ctx, channel._id, { name });
  return name;
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
const backfillValidator = v.union(
  v.literal("none"), v.literal("1d"), v.literal("7d"), v.literal("30d"), v.literal("90d"), v.literal("all"),
);
const BACKFILL_MS: Record<string, number> = {
  "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000,
};
/** The Slack ts floor for a window: now for none, "0" for all. Slack's
 *  history call rejects oldest=0, so a zero floor means "send no oldest". */
export function backfillSinceTs(window: BackfillWindow, now = Date.now()): string {
  if (window === "all") return "0";
  const sinceMs = window === "none" ? now : now - BACKFILL_MS[window];
  return (sinceMs / 1000).toFixed(6);
}

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

// The person's own Slack token for this installation, if they connected their
// account. Used only to see and open the private channels they are in.
async function userTokenFor(ctx: ReadCtx, installationId: Id<"slack_installations">, userId: Id<"users">): Promise<Doc<"slack_user_tokens"> | null> {
  return await ctx.db
    .query("slack_user_tokens")
    .withIndex("by_installation_user", (q: any) => q.eq("installation_id", installationId).eq("user_id", userId))
    .first();
}

// A channel is read and written as the app. A direct message is the owner's:
// only their token can see it, so the install handed to the mirror code
// carries their token in the app's place. One substitution, every reader.
async function installForLink(ctx: ReadCtx, link: Link, install: Install): Promise<Install | null> {
  if (link.kind !== "dm") return install;
  if (!link.owner_user_id) return null;
  const token = await userTokenFor(ctx, install._id, link.owner_user_id);
  if (!token) return null;
  return { ...install, bot_token: token.token };
}

async function slackUserRow(ctx: ReadCtx, workspace: string, user: string): Promise<Doc<"slack_users"> | null> {
  return await ctx.db
    .query("slack_users")
    .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", workspace).eq("slack_user_id", user))
    .first();
}

async function teammateByEmail(ctx: ReadCtx, teamId: Id<"teams">, email: string | undefined): Promise<Id<"users"> | null> {
  if (!email) return null;
  const lower = email.trim().toLowerCase();
  const candidates = await ctx.db
    .query("users")
    .withIndex("email", (q: any) => q.eq("email", lower))
    .collect();
  const verified = [];
  for (const user of candidates) {
    if (user.is_bot) continue;
    const accounts = typeof user.emailVerificationTime === "number" ? [] : await ctx.db.query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id)).collect();
    if (typeof user.emailVerificationTime === "number" || accounts.some((account) =>
      account.emailVerified?.trim().toLowerCase() === lower)) verified.push(user);
  }
  if (verified.length !== 1) return null;
  return await isTeamMember(ctx as any, verified[0]._id, teamId) ? verified[0]._id : null;
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
    const myToken = install ? await userTokenFor(ctx, install._id, userId) : null;
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
      // The caller connected their own Slack account: private channels they
      // are in can be added without a manual /invite.
      you_connected: !!myToken,
      dm_ready: !!myToken && tokenHasDmScopes(myToken.scopes),
      dm_sync: myToken?.dm_sync ?? null,
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
      bot_user_id: install.bot_user_id,
      user_token: (await userTokenFor(ctx, install._id, userId))?.token ?? null,
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
    backfill_window: v.optional(backfillValidator),
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
      backfill: args.backfill_window && args.backfill_window !== "none"
        ? { window: args.backfill_window, status: "running" as const, fetched: 0, started_at: now, heartbeat_at: now }
        : undefined,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    // Learn who is in the workspace now, rather than one profile at a time as
    // people speak: a mention written in codecast can only page a Slack person
    // this table already knows.
    await ctx.scheduler.runAfter(0, internal.slackSync.syncWorkspacePeople, { installation_id: install._id });
    const chatName = await adoptSlackName(ctx, channel, args.slack_channel_name);
    // One notice in chat so the room knows where the new faces come from.
    const actor = await ctx.db.get(userId);
    const flow = DIRECTION_FLOW[args.direction ?? "both"];
    await postBridgeNotice(ctx, {
      channel,
      install,
      content: `Linked to Slack #${args.slack_channel_name ?? args.slack_channel_id} (${flow}) by ${actor?.name ?? "a teammate"}.`,
      clientId: `${id}:linked`,
    });
    return { link_id: id, chat_channel_name: chatName, slack_channel_name: args.slack_channel_name ?? null, actor_name: actor?.name ?? null };
  },
});

// Link a chat channel to a Slack channel. Probes the Slack side with the
// workspace token (joins a public channel the app is not yet in), then writes
// atomically. Optionally backfills history.
//
// Two ways in. With `chat_channel_id`, an existing room becomes the mirror.
// Without it (the channel browser), the room is CREATED from the Slack channel:
// same name, Slack's purpose as the topic, so bringing a Slack channel over is
// one gesture and the two sides match from the first line.
export const linkChannel = action({
  args: {
    api_token: v.optional(v.string()),
    chat_channel_id: v.optional(v.id("chat_channels")),
    team_id: v.optional(v.id("teams")),
    slack_channel_id: v.string(),
    direction: v.optional(directionValidator),
    options: v.optional(optionsValidator),
    backfill: v.optional(backfillValidator),
  },
  handler: async (ctx, args): Promise<{
    ok: boolean; error?: string; link_id?: Id<"slack_channel_links">;
    // The names as they stand after the link: the chat channel now wears the
    // Slack channel's name, so a caller can print what really happened.
    chat_channel_id?: Id<"chat_channels">; chat_channel_name?: string; slack_channel_name?: string | null;
  }> => {
    let token: string;
    let botUserId: string;
    let userToken: string | null;
    let chatChannelId = args.chat_channel_id;
    if (chatChannelId) {
      const auth = await ctx.runQuery(internal.slackSync.resolveLinkAuth, { api_token: args.api_token, chat_channel_id: chatChannelId });
      if (!auth.ok) return { ok: false, error: auth.error };
      if (auth.existing_link_id) return { ok: false, error: "This channel already mirrors a Slack channel" };
      token = auth.bot_token;
      botUserId = auth.bot_user_id;
      userToken = auth.user_token;
    } else {
      if (!args.team_id) return { ok: false, error: "Name the team the new channel belongs to" };
      const team = await ctx.runQuery(internal.slackSync.teamSlackContext, { api_token: args.api_token, team_id: args.team_id });
      if (!team.ok) return { ok: false, error: team.error };
      if (team.links.some((l: { slack_channel_id: string }) => l.slack_channel_id === args.slack_channel_id)) {
        return { ok: false, error: "That Slack channel is already mirrored" };
      }
      token = team.bot_token;
      botUserId = team.bot_user_id;
      userToken = team.user_token;
    }

    // Probe as the app; a private channel the app is not in answers
    // channel_not_found, so fall back to the person's own view of it.
    let info = await slackApi(token, "conversations.info", { channel: args.slack_channel_id });
    if (!info.ok && userToken) info = await slackApi(userToken, "conversations.info", { channel: args.slack_channel_id });
    if (!info.ok) return { ok: false, error: `Slack: ${info.error}` };
    let ch = info.channel ?? {};
    if (ch.is_archived) return { ok: false, error: "That Slack channel is archived" };
    if (ch.is_im || ch.is_mpim) return { ok: false, error: "Only channels can be mirrored, not direct messages" };
    // Is the APP in it? The user token's view reports the person's membership,
    // so ask the app directly.
    const appIn = await slackApi(token, "conversations.info", { channel: args.slack_channel_id });
    if (!(appIn.ok && appIn.channel?.is_member)) {
      if (ch.is_private) {
        // The person invites the app in, as themselves. Needs their token
        // (groups:write) and their own membership; without either, the manual
        // /invite is the only way.
        const invited = userToken
          ? await slackApi(userToken, "conversations.invite", { channel: args.slack_channel_id, users: botUserId })
          : { ok: false, error: "no_user_token" };
        if (!invited.ok && invited.error !== "already_in_channel") {
          return {
            ok: false,
            error: userToken
              ? `Slack would not let the app into that private channel (${invited.error}). In Slack, run /invite @Codecast there, then try again.`
              : "The app is not in that private channel. Connect your Slack account to add private channels you are in, or run /invite @Codecast there.",
          };
        }
      } else {
        const joined = await slackApi(token, "conversations.join", { channel: args.slack_channel_id });
        if (!joined.ok) return { ok: false, error: `Slack would not let the app join: ${joined.error}` };
      }
      info = await slackApi(token, "conversations.info", { channel: args.slack_channel_id });
      ch = info.channel ?? ch;
    }

    if (!chatChannelId) {
      // The room is made through chat's own create, so the name rules, the
      // per team cap and the rate limit apply exactly as for a typed name.
      // A retried import lands on the same row through the client id.
      try {
        const made = await ctx.runMutation(api.chat.createChannel, {
          api_token: args.api_token,
          team_id: args.team_id,
          name: ch.name,
          topic: (ch.purpose?.value || ch.topic?.value || undefined)?.slice(0, 200),
          client_id: `slack:${ch.id}`,
        });
        chatChannelId = made.channel_id;
      } catch (error: any) {
        return { ok: false, error: error?.data?.message ?? error?.message ?? "Could not create the channel" };
      }
    }

    const backfill = args.backfill ?? "none";
    const sinceTs = backfillSinceTs(backfill);
    let committed: { link_id: Id<"slack_channel_links">; chat_channel_name: string; slack_channel_name: string | null; actor_name: string | null };
    try {
      committed = await ctx.runMutation(internal.slackSync.commitLink, {
        api_token: args.api_token,
        chat_channel_id: chatChannelId,
        slack_channel_id: args.slack_channel_id,
        slack_channel_name: ch.name,
        slack_channel_private: !!ch.is_private,
        direction: args.direction,
        options: args.options,
        since_ts: sinceTs,
        backfill_window: backfill,
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
    return {
      ok: true,
      link_id: committed.link_id,
      chat_channel_id: chatChannelId,
      chat_channel_name: committed.chat_channel_name,
      slack_channel_name: committed.slack_channel_name,
    };
  },
});

export const updateLink = mutation({
  args: {
    api_token: v.optional(v.string()),
    link_id: v.id("slack_channel_links"),
    direction: v.optional(directionValidator),
    options: v.optional(optionsValidator),
    paused: v.optional(v.boolean()),
    // Run the history import again from the link's floor. Lines already here
    // dedupe on their Slack ts, so this only ever adds what was missing.
    reimport: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const link = await ctx.db.get(args.link_id);
    if (!link) chatFail("NOT_FOUND", "Link not found");
    const channel = await loadChannel(ctx, userId, link.chat_channel_id);
    if (!(await mayManageChannel(ctx, userId, channel))) chatFail("FORBIDDEN", "Not allowed to manage this channel");
    const patch: Partial<Link> = { updated_at: Date.now() };
    if (args.direction) patch.direction = args.direction;
    let restartImport = !!args.reimport;
    if (args.options) {
      patch.options = mergeLinkOptions(link.options, args.options);
      // Turning a kind of line ON after the import ran means history is
      // missing those lines: run it again so the room fills in, rather than
      // leaving the past with holes only new lines avoid.
      const turnedOn = (key: "bot_messages" | "threads" | "system_messages" | "files") =>
        !link.options[key] && patch.options![key];
      if (link.backfill && link.backfill.status !== "running" && (turnedOn("bot_messages") || turnedOn("threads") || turnedOn("system_messages") || turnedOn("files"))) {
        restartImport = true;
      }
    }
    if (typeof args.paused === "boolean") {
      patch.paused = args.paused;
      if (!args.paused) {
        patch.last_error = undefined;
        patch.last_error_at = undefined;
        // Resuming after a failed history import runs the import again.
        if (link.backfill?.status === "failed") restartImport = true;
      }
    }
    if (restartImport) {
      if (link.backfill?.status === "running" && !importStalled(link)) chatFail("INVALID", "The history import is still running");
      const now = Date.now();
      patch.backfill = {
        window: link.backfill?.window ?? "all",
        status: "running",
        fetched: 0,
        skipped: undefined,
        capped: undefined,
        error: undefined,
        finished_at: undefined,
        started_at: now,
        heartbeat_at: now,
      };
    }
    await ctx.db.patch(link._id, patch);
    if (restartImport) await ctx.scheduler.runAfter(0, internal.slackSync.backfill, { link_id: link._id, oldest_ts: link.since_ts });
    return { link_id: link._id, reimport: restartImport };
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
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; can_add_private?: boolean; channels?: Array<{
    id: string; name: string; is_private: boolean; is_member: boolean; is_general: boolean; num_members: number | null;
    // The CALLER is in this private channel (seen through their own token), so
    // the app can be invited in for them.
    you_are_in: boolean;
    created: number | null; // Slack's creation time, ms; the browser turns it into "since <month year>"
    topic: string | null; purpose: string | null; linked_chat_channel_id: string | null; linked_chat_channel_name: string | null;
  }> }> => {
    const ctxRow = await ctx.runQuery(internal.slackSync.teamSlackContext, { api_token: args.api_token, team_id: args.team_id });
    if (!ctxRow.ok) return { ok: false, error: ctxRow.error };
    const byId = new Map<string, any>();
    const row = (c: any, youAreIn: boolean) => {
      const linked = ctxRow.links.find((l: { slack_channel_id: string }) => l.slack_channel_id === c.id);
      return {
        id: c.id,
        name: c.name,
        is_private: !!c.is_private,
        is_member: !!c.is_member,
        is_general: !!c.is_general,
        you_are_in: youAreIn,
        num_members: typeof c.num_members === "number" ? c.num_members : null,
        created: typeof c.created === "number" ? c.created * 1000 : null,
        topic: c.topic?.value || null,
        purpose: c.purpose?.value || null,
        linked_chat_channel_id: linked?.chat_channel_id ?? null,
        linked_chat_channel_name: linked?.chat_channel_name ?? null,
      };
    };
    // What the app sees: every public channel, and the private ones it is in.
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const resp = await slackApi(ctxRow.bot_token, "conversations.list", {
        types: "public_channel,private_channel", exclude_archived: "true", limit: "200", cursor,
      });
      if (!resp.ok) return { ok: false, error: `Slack: ${resp.error}` };
      for (const c of resp.channels ?? []) byId.set(c.id, row(c, false));
      cursor = resp.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    // What the PERSON sees: the private channels they are in, through their
    // own token. Those the app is not in yet appear too, addable, because the
    // link step can invite the app for them.
    if (ctxRow.user_token) {
      cursor = undefined;
      for (let page = 0; page < 5; page++) {
        const resp = await slackApi(ctxRow.user_token, "conversations.list", {
          types: "private_channel", exclude_archived: "true", limit: "200", cursor,
        });
        if (!resp.ok) break; // a revoked token costs the private list, not the whole browser
        for (const c of resp.channels ?? []) {
          const seen = byId.get(c.id);
          if (seen) seen.you_are_in = true;
          else byId.set(c.id, { ...row(c, true), is_member: false });
        }
        cursor = resp.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    }
    const out = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, can_add_private: !!ctxRow.user_token, channels: out };
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
    return {
      ok: true as const,
      bot_token: install.bot_token,
      bot_user_id: install.bot_user_id,
      user_token: (await userTokenFor(ctx, install._id, userId))?.token ?? null,
      workspace_id: install.workspace_id,
      links: withNames,
    };
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
  args: {
    event_id: v.string(),
    workspace: v.string(),
    event: v.any(),
    // Slack's `authorizations`: the users on whose behalf a user event was
    // delivered. A DM event names its owner here.
    authed_users: v.optional(v.array(v.string())),
  },
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
    if (!link) {
      // A direct message with no room yet: if one of the people it was
      // delivered for has their DMs on, the room is made and the event
      // replayed into it. Anything else is left for the anchor path.
      const isDm = event.channel_type === "im" || event.channel_type === "mpim";
      if (isDm && type === "message" && !event.subtype) {
        const owner = await dmOwnerFor(ctx, args.workspace, args.authed_users ?? []);
        if (owner) {
          await ctx.scheduler.runAfter(0, internal.slackSync.adoptDm, {
            token_id: owner._id, slack_channel_id: channelId, event_id: args.event_id, event,
          });
          return { status: "adopting" as const };
        }
      }
      return { status: "no_link" as const };
    }
    await record();
    // Our own posts, edits and reactions come back as events too. Drop them
    // here rather than paying a job and an action to find out.
    const install = await ctx.db.get(link.installation_id);
    if (install && (isOwnBotEvent(install, event) || isOwnBotEvent(install, event.message ?? {}))) {
      return { status: "own_bot" as const };
    }

    // Channel lifecycle: always applied, they are about the link itself.
    if (type === "channel_rename") {
      const slackName = event.channel?.name ?? link.slack_channel_name;
      await ctx.db.patch(link._id, { slack_channel_name: slackName, updated_at: Date.now() });
      const chatChannel = await ctx.db.get(link.chat_channel_id);
      if (chatChannel && !chatChannel.archived_at) await adoptSlackName(ctx, chatChannel, slackName);
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

// ── Direct messages ──────────────────────────────────────────────────────────
//
// A connected person can switch their DMs on. Every DM of theirs becomes the
// codecast DM between the same people: a mapped teammate as themselves, anyone
// else through a shadow identity carrying their Slack name and face. The link
// row is the ordinary mirror row with kind "dm" and the owner named, so the
// import, the live events, edits, reactions and progress are the channel
// machinery unchanged; only the token differs (installForLink) and outbound
// goes out as the author (pushContext).

const DM_SCAN_PAGE = 100;

/** Among the users a user event was delivered for, one whose DMs are on. */
async function dmOwnerFor(ctx: ReadCtx, workspace: string, authedUsers: string[]): Promise<Doc<"slack_user_tokens"> | null> {
  if (authedUsers.length === 0) return null;
  const install = await ctx.db
    .query("slack_installations")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspace))
    .first();
  if (!install) return null;
  const tokens = await ctx.db
    .query("slack_user_tokens")
    .withIndex("by_installation_user", (q: any) => q.eq("installation_id", install._id))
    .collect();
  return tokens.find((t) => t.dm_sync?.enabled && authedUsers.includes(t.slack_user_id)) ?? null;
}

/** The identity a Slack person speaks through in a DM room: the mapped
 *  teammate, else their own shadow user (minted once). */
async function personIdentity(ctx: MutationCtx, install: Install, row: Doc<"slack_users">): Promise<Id<"users">> {
  if (row.codecast_user_id) return row.codecast_user_id;
  if (row.shadow_user_id) {
    const existing = await ctx.db.get(row.shadow_user_id);
    if (existing) return existing._id;
  }
  const now = Date.now();
  const id = await ctx.db.insert("users", {
    name: row.real_name || row.name,
    image: row.avatar_url,
    is_bot: true,
    bot_kind: "slack",
    created_at: now,
    team_id: install.team_id,
    active_team_id: install.team_id,
  } as any);
  if (install.team_id) {
    await ctx.db.insert("team_memberships", {
      user_id: id, team_id: install.team_id, role: "member", joined_at: now, visibility: "hidden",
    } as any);
  }
  await ctx.db.patch(row._id, { shadow_user_id: id });
  return id;
}

/** Switch a person's DMs on or off. On: a scan lists their DMs and links each
 *  one that has anything in the window. Off: the DM links pause (rooms and
 *  lines stay; nothing is deleted). */
export const setDmSync = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.id("teams"),
    enabled: v.boolean(),
    window: v.optional(backfillValidator),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    if (!(await isTeamMember(ctx, userId, args.team_id))) chatFail("FORBIDDEN", "Not a member of this team");
    const install = await installationForTeam(ctx, args.team_id);
    if (!install) chatFail("INVALID", "Connect a Slack workspace for this team first");
    const token = await userTokenFor(ctx, install._id, userId);
    if (!token) chatFail("INVALID", "Connect your Slack account first");
    if (args.enabled && !tokenHasDmScopes(token.scopes)) chatFail("INVALID", "reconnect");
    const now = Date.now();
    const window = args.window ?? token.dm_sync?.window ?? "30d";
    await ctx.db.patch(token._id, {
      dm_sync: args.enabled
        ? { enabled: true, window, enabled_at: now, status: "scanning", conversations: 0, error: undefined }
        : { ...(token.dm_sync ?? { window, enabled_at: now }), enabled: false, status: "done" },
      updated_at: now,
    });
    const mine = (await ctx.db.query("slack_channel_links").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).collect())
      .filter((l) => l.kind === "dm" && l.owner_user_id?.toString() === userId.toString());
    for (const l of mine) await ctx.db.patch(l._id, { paused: !args.enabled, updated_at: now });
    if (args.enabled) await ctx.scheduler.runAfter(0, internal.slackSync.scanDms, { token_id: token._id });
    return { ok: true, enabled: args.enabled, window };
  },
});

export const dmScanContext = internalQuery({
  args: { token_id: v.id("slack_user_tokens") },
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.token_id);
    if (!token) return null;
    const install = await ctx.db.get(token.installation_id);
    if (!install) return null;
    return { token, install };
  },
});

export const patchDmScan = internalMutation({
  args: {
    token_id: v.id("slack_user_tokens"),
    status: v.union(v.literal("scanning"), v.literal("done"), v.literal("failed")),
    conversations: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.token_id);
    if (!token?.dm_sync) return;
    await ctx.db.patch(token._id, {
      dm_sync: { ...token.dm_sync, status: args.status, conversations: args.conversations, error: args.error },
      updated_at: Date.now(),
    });
  },
});

/** The other people in a Slack DM, by the owner's token. */
async function dmOthers(token: Doc<"slack_user_tokens">, conv: any): Promise<string[]> {
  const members: string[] = conv.is_mpim
    ? ((await slackApi(token.token, "conversations.members", { channel: conv.id, limit: "50" })).members ?? [])
    : conv.user ? [conv.user] : [];
  return members.filter((u) => u !== token.slack_user_id && u !== "USLACKBOT");
}

// List the person's DMs one page per run and link every one with something in
// the window. Empty rooms are not made: a DM that was opened once and never
// used should not appear here; a live line later adopts it (adoptDm).
export const scanDms = internalAction({
  args: { token_id: v.id("slack_user_tokens"), cursor: v.optional(v.string()), linked: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.runQuery(internal.slackSync.dmScanContext, { token_id: args.token_id });
    if (!c?.token.dm_sync?.enabled) return;
    const { token, install } = c;
    const window = (token.dm_sync?.window || "30d") as BackfillWindow;
    const sinceTs = backfillSinceTs(window);
    let linked = args.linked ?? 0;
    try {
      const resp = await slackApi(token.token, "conversations.list", {
        types: "im,mpim", exclude_archived: "true", limit: String(DM_SCAN_PAGE), cursor: args.cursor,
      });
      if (!resp.ok) throw new Error(`Slack: ${resp.error}`);
      for (const conv of resp.channels ?? []) {
        if (conv.is_user_deleted) continue;
        const others = await dmOthers(token, conv);
        if (others.length === 0) continue; // a note to self, or Slackbot
        // Anything in the window? One line is enough to know.
        const probe = await slackApi(token.token, "conversations.history", {
          channel: conv.id, limit: "1", ...(Number(sinceTs) > 0 ? { oldest: sinceTs, inclusive: "true" } : {}),
        });
        if (!probe.ok || !(probe.messages ?? []).length) continue;
        // The people, known before the room is made (their names and faces
        // name the shadow identities).
        for (const u of others) await resolvePerson(ctx, install, u);
        const made = await ctx.runMutation(internal.slackSync.commitDmLink, {
          token_id: token._id, slack_channel_id: conv.id, member_slack_ids: others, since_ts: sinceTs, window,
        });
        if (made?.link_id) {
          linked++;
          if (made.created) await ctx.scheduler.runAfter(0, internal.slackSync.backfill, { link_id: made.link_id, oldest_ts: sinceTs });
        }
      }
      const next = resp.response_metadata?.next_cursor || undefined;
      await ctx.runMutation(internal.slackSync.patchDmScan, { token_id: token._id, status: next ? "scanning" : "done", conversations: linked });
      if (next) await ctx.scheduler.runAfter(0, internal.slackSync.scanDms, { token_id: token._id, cursor: next, linked });
    } catch (error: any) {
      console.error("[slackSync] DM scan failed", token.slack_user_id, error);
      await ctx.runMutation(internal.slackSync.patchDmScan, { token_id: token._id, status: "failed", conversations: linked, error: String(error?.message ?? error).slice(0, 200) });
    }
  },
});

// The room and the link for one DM. Members are the owner plus each other
// person's identity here. Idempotent on the Slack channel id.
export const commitDmLink = internalMutation({
  args: {
    token_id: v.id("slack_user_tokens"),
    slack_channel_id: v.string(),
    member_slack_ids: v.array(v.string()),
    since_ts: v.string(),
    window: backfillValidator,
  },
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.token_id);
    if (!token) return null;
    const install = await ctx.db.get(token.installation_id);
    if (!install?.team_id) return null;
    const existing = await linkByWorkspaceChannel(ctx, install.workspace_id, args.slack_channel_id);
    if (existing) {
      if (existing.paused && token.dm_sync?.enabled) await ctx.db.patch(existing._id, { paused: false, updated_at: Date.now() });
      return { link_id: existing._id, chat_channel_id: existing.chat_channel_id, created: false };
    }
    const identities: Id<"users">[] = [token.user_id];
    for (const u of args.member_slack_ids) {
      const row = await slackUserRow(ctx, install.workspace_id, u);
      if (!row) continue;
      identities.push(await personIdentity(ctx, install, row));
    }
    if (identities.length < 2) return null;
    const room = await ensureDmRoom(ctx, install.team_id, identities, token.user_id);
    const now = Date.now();
    const id = await ctx.db.insert("slack_channel_links", {
      team_id: install.team_id,
      installation_id: install._id,
      workspace_id: install.workspace_id,
      slack_channel_id: args.slack_channel_id,
      slack_channel_private: true,
      chat_channel_id: room.channel._id,
      kind: "dm",
      owner_user_id: token.user_id,
      direction: "both",
      options: mergeLinkOptions(LINK_DEFAULTS, { system_messages: false }),
      since_ts: args.since_ts,
      backfill: args.window !== "none"
        ? { window: args.window, status: "running" as const, fetched: 0, started_at: now, heartbeat_at: now }
        : undefined,
      created_by: token.user_id,
      created_at: now,
      updated_at: now,
    });
    return { link_id: id, chat_channel_id: room.channel._id, created: true };
  },
});

// A live line in a DM that has no room yet: make the room (from now, no
// history) and replay the event into it.
export const adoptDm = internalAction({
  args: { token_id: v.id("slack_user_tokens"), slack_channel_id: v.string(), event_id: v.string(), event: v.any() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.runQuery(internal.slackSync.dmScanContext, { token_id: args.token_id });
    if (!c?.token.dm_sync?.enabled) return;
    const { token, install } = c;
    const info = await slackApi(token.token, "conversations.info", { channel: args.slack_channel_id });
    if (!info.ok) return;
    const others = await dmOthers(token, info.channel ?? {});
    if (others.length === 0) return;
    for (const u of others) await resolvePerson(ctx, install, u);
    const made = await ctx.runMutation(internal.slackSync.commitDmLink, {
      token_id: token._id, slack_channel_id: args.slack_channel_id, member_slack_ids: others,
      since_ts: backfillSinceTs("none"), window: "none",
    });
    if (!made) return;
    await ctx.runMutation(internal.slackSync.ingestEvent, {
      event_id: args.event_id, workspace: install.workspace_id, event: args.event, authed_users: [token.slack_user_id],
    });
  },
});

// When a Slack person's identity here changes (mapped to a teammate, or
// released), every DM room they sit in follows: the room is re-keyed to the
// new identity, or merged into the room that already exists for that pair.
export const retargetPersonRooms = internalMutation({
  args: { team_id: v.id("teams"), from_user_id: v.id("users"), to_user_id: v.id("users") },
  handler: async (ctx, args): Promise<void> => {
    if (args.from_user_id.toString() === args.to_user_id.toString()) return;
    const links = (await ctx.db.query("slack_channel_links").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).collect())
      .filter((l) => l.kind === "dm");
    for (const link of links) {
      const room = await ctx.db.get(link.chat_channel_id);
      if (!room?.dm_key) continue;
      const ids = room.dm_key.split(":").slice(1);
      if (!ids.includes(args.from_user_id.toString())) continue;
      const nextIds = ids.map((id) => (id === args.from_user_id.toString() ? args.to_user_id.toString() : id));
      const nextKey = dmKeyFor(String(args.team_id), nextIds);
      const target = await ctx.db.query("chat_channels").withIndex("by_dm_key", (q: any) => q.eq("dm_key", nextKey)).first();
      const now = Date.now();
      const members = await ctx.db.query("chat_channel_members").withIndex("by_channel", (q: any) => q.eq("channel_id", room._id)).collect();
      if (target && target._id.toString() !== room._id.toString()) {
        // Merge: the lines move, the link points at the surviving room, the
        // shadow room goes.
        const lines = await ctx.db.query("chat_messages").withIndex("by_channel_external_ts", (q: any) => q.eq("channel_id", room._id)).collect();
        for (const m of lines) await ctx.db.patch(m._id, { channel_id: target._id });
        await ctx.db.patch(link._id, { chat_channel_id: target._id, updated_at: now });
        // The same forwarding address an optimistic create uses: whoever holds
        // the room id that just went away is sent to the room that absorbed it.
        await patchChat(ctx, target._id, { client_id: room._id.toString() });
        for (const mem of members) await ctx.db.delete(mem._id);
        await ctx.db.delete(room._id);
      } else {
        await patchChat(ctx, room._id, { dm_key: nextKey });
        for (const mem of members) {
          if (mem.user_id.toString() === args.from_user_id.toString()) await ctx.db.patch(mem._id, { user_id: args.to_user_id });
        }
      }
    }
  },
});

// ── Inbound: process ─────────────────────────────────────────────────────────


export const jobContext = internalQuery({
  args: { job_id: v.id("slack_sync_events") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job) return null;
    const link = await ctx.db.get(job.link_id);
    const rawInstall = link ? await ctx.db.get(link.installation_id) : null;
    const install = link && rawInstall ? await installForLink(ctx, link, rawInstall) : null;
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
    const existing = await slackUserRow(ctx, args.workspace_id, args.slack_user_id);
    // A mapping a teammate chose outlives every profile refresh; only the
    // email rule is recomputed.
    const manual = existing?.mapped_by === "manual";
    const mapped = manual ? existing!.codecast_user_id ?? null : args.team_id ? await teammateByEmail(ctx, args.team_id, fields.email) : null;
    const row = {
      ...fields,
      codecast_user_id: mapped ?? undefined,
      mapped_by: manual ? ("manual" as const) : mapped ? ("email" as const) : undefined,
      fetched_at: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return { ...existing, ...row };
    }
    const id = await ctx.db.insert("slack_users", { workspace_id: args.workspace_id, slack_user_id: args.slack_user_id, ...row });
    return (await ctx.db.get(id))!;
  },
});

// The workspace's people, fetched from Slack rather than waited for.
//
// slack_users used to fill only as people SPOKE in a mirrored channel, so a
// mention of somebody who had not posted yet resolved to nobody and went to
// Slack as plain text. This walks users.list once (the `users:read` scope the
// app already holds) and upserts every member, humans and bots alike, so a
// handle written in codecast can be resolved the first time anybody uses it.
// One page per run, the next scheduled after it, so no run exceeds its budget.
export const syncWorkspacePeople = internalAction({
  args: {
    installation_id: v.id("slack_installations"),
    cursor: v.optional(v.string()),
    page: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ status: string; seen?: number }> => {
    const install = await ctx.runQuery(internal.slackSync.installationById, { id: args.installation_id });
    if (!install) return { status: "no_install" };
    const page = args.page ?? 0;
    if (page >= MAX_PEOPLE_PAGES) return { status: "capped" };
    const resp = await slackApi(install.bot_token, "users.list", { limit: 200, cursor: args.cursor });
    if (!resp.ok) return { status: `error:${resp.error ?? "unknown"}` };
    const members: any[] = Array.isArray((resp as any).members) ? (resp as any).members : [];
    for (const member of members) {
      if (!member?.id) continue;
      await ctx.runMutation(internal.slackSync.upsertSlackUser, {
        workspace_id: install.workspace_id,
        slack_user_id: String(member.id),
        team_id: install.team_id ?? undefined,
        profile: member,
      });
    }
    const next = (resp as any).response_metadata?.next_cursor;
    if (next) {
      await ctx.scheduler.runAfter(0, internal.slackSync.syncWorkspacePeople, {
        installation_id: args.installation_id, cursor: String(next), page: page + 1,
      });
    }
    return { status: "ok", seen: members.length };
  },
});

/** Pages of users.list one sync may walk: 200 people each, so 20 covers any
 *  workspace this product meets and bounds a runaway cursor. */
const MAX_PEOPLE_PAGES = 20;

// Every workspace the product mirrors, for the nightly roster refresh.
export const listInstallations = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("slack_installations").take(500)).map((i) => i._id),
});

// The cron's entry point: refresh every workspace's people.
export const refreshAllWorkspacePeople = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const ids: Array<Id<"slack_installations">> = await ctx.runQuery(internal.slackSync.listInstallations, {});
    for (const id of ids) {
      await ctx.scheduler.runAfter(0, internal.slackSync.syncWorkspacePeople, { installation_id: id });
    }
  },
});

export const getSlackUser = internalQuery({
  args: { workspace_id: v.string(), slack_user_id: v.string() },
  handler: async (ctx, args) => await slackUserRow(ctx, args.workspace_id, args.slack_user_id),
});

type ResolvedPerson = {
  slack_user_id: string;
  codecast_user_id: Id<"users"> | null;
  mapped_by: "email" | "manual" | null;
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
    mapped_by: row?.mapped_by ?? null,
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
  if (!person?.codecast_user_id) return null;
  // A mapping somebody chose by hand holds whatever the email switch says.
  if (person.mapped_by === "manual") return person.codecast_user_id;
  if (!link.options.match_people_by_email) return null;
  return person.codecast_user_id;
}

// ── People mapping ───────────────────────────────────────────────────────────
//
// Who a Slack person is in codecast. The email rule gets most of them; the rest
// (a different address in Slack, a shared account, a contractor) are set by a
// teammate from the People popup. A change re-attributes every line that
// person has already sent into the team's mirrored channels, so the room reads
// as if it had been right from the start.

export const listSlackPeople = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    if (!(await isTeamMember(ctx, userId, args.team_id))) return null;
    const install = await installationForTeam(ctx, args.team_id);
    if (!install) return { people: [], is_admin: false };
    const rows = await ctx.db
      .query("slack_users")
      .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", install.workspace_id))
      .collect();
    const people = [];
    for (const r of rows) {
      if (r.is_bot || r.deleted) continue;
      const teammate = r.codecast_user_id ? await ctx.db.get(r.codecast_user_id) : null;
      people.push({
        slack_user_id: r.slack_user_id,
        name: r.name,
        handle: r.handle ?? null,
        real_name: r.real_name ?? null,
        avatar_url: r.avatar_url ?? null,
        email: r.email ?? null,
        codecast_user_id: r.codecast_user_id ?? null,
        codecast_user_name: teammate ? displayName(teammate) : null,
        mapped_by: r.mapped_by ?? null,
      });
    }
    people.sort((a, b) => Number(!!a.codecast_user_id) - Number(!!b.codecast_user_id) || a.name.localeCompare(b.name));
    return { people, is_admin: await isTeamAdmin(ctx, userId, args.team_id) };
  },
});

export const mapSlackPerson = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.id("teams"),
    slack_user_id: v.string(),
    // The teammate this Slack person IS; null pins "nobody, show the Slack
    // name" against the email rule. The CLI may name the teammate instead
    // (@handle, email or name), resolved here against the team roster.
    codecast_user_id: v.optional(v.union(v.id("users"), v.null())),
    teammate_ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    if (!(await isTeamMember(ctx, userId, args.team_id))) chatFail("FORBIDDEN", "Not a member of this team");
    const install = await installationForTeam(ctx, args.team_id);
    if (!install) chatFail("INVALID", "Connect a Slack workspace for this team first");
    const row = await slackUserRow(ctx, install.workspace_id, args.slack_user_id);
    if (!row) chatFail("NOT_FOUND", "That Slack person has not been seen yet");
    if (args.teammate_ref !== undefined) {
      const ref = args.teammate_ref.replace(/^@/, "").trim().toLowerCase();
      if (!ref || ref === "none") args = { ...args, codecast_user_id: null };
      else {
        const hit = (await teamRoster(ctx, args.team_id)).find((u: any) =>
          !u.is_bot && (
            u._id.toString() === args.teammate_ref ||
            (memberHandle({ github_username: u.github_username, email: u.email, name: u.name, is_bot: u.is_bot }) ?? "").toLowerCase() === ref ||
            (u.email ?? "").toLowerCase() === ref ||
            (u.name ?? "").toLowerCase() === ref));
        if (!hit) chatFail("NOT_FOUND", `No teammate matches ${args.teammate_ref}`);
        args = { ...args, codecast_user_id: hit._id };
      }
    }
    if (args.codecast_user_id === undefined) chatFail("INVALID", "Say which teammate, or none");
    // Attribution is team wide, so an admin may map anyone; a member may claim
    // a Slack person as themselves, or release one that points at them.
    const admin = await isTeamAdmin(ctx, userId, args.team_id);
    const self = userId.toString();
    const claimsSelf = args.codecast_user_id?.toString() === self;
    const releasesSelf = args.codecast_user_id === null && row.codecast_user_id?.toString() === self;
    if (!admin && !claimsSelf && !releasesSelf) chatFail("FORBIDDEN", "Only a team admin can map a Slack person to someone else");
    if (!admin && claimsSelf) {
      const emailOwner = await teammateByEmail(ctx, args.team_id, row.email);
      const token = await ctx.db.query("slack_user_tokens")
        .withIndex("by_installation_user", (q: any) => q.eq("installation_id", install._id).eq("user_id", userId))
        .first();
      if (emailOwner?.toString() !== self &&
        !(token?.workspace_id === install.workspace_id && token.slack_user_id === row.slack_user_id)) {
        chatFail("FORBIDDEN", "Sign in with Slack or verify the matching email before claiming this person");
      }
    }
    if (args.codecast_user_id) {
      const target = await ctx.db.get(args.codecast_user_id);
      if (!target || target.is_bot || !(await isTeamMember(ctx, args.codecast_user_id, args.team_id))) {
        chatFail("INVALID", "Map to a human member of this team");
      }
    }
    await assignSlackPerson(ctx, { teamId: args.team_id, row, codecastUserId: args.codecast_user_id });
    return { ok: true, slack_user_id: args.slack_user_id, codecast_user_id: args.codecast_user_id };
  },
});

// Pin who a Slack person is (or that they are nobody here) and re-author their
// past lines. "manual" because somebody or something CHOSE it: the People
// popup, or the person proving their Slack identity by signing in with it.
// A profile refresh leaves a chosen mapping alone (upsertSlackUser).
async function assignSlackPerson(
  ctx: MutationCtx,
  opts: { teamId: Id<"teams">; row: Doc<"slack_users">; codecastUserId: Id<"users"> | null },
): Promise<void> {
  const install = await installationForTeam(ctx, opts.teamId);
  const before: Id<"users"> | null = opts.row.codecast_user_id ?? opts.row.shadow_user_id ?? null;
  await ctx.db.patch(opts.row._id, { codecast_user_id: opts.codecastUserId ?? undefined, mapped_by: "manual" });
  // Their DM rooms follow the identity: to the teammate, or back to a shadow.
  if (install) {
    const after: Id<"users"> = opts.codecastUserId ?? (await personIdentity(ctx, install, { ...opts.row, codecast_user_id: undefined }));
    if (before && before.toString() !== after.toString()) {
      await ctx.scheduler.runAfter(0, internal.slackSync.retargetPersonRooms, { team_id: opts.teamId, from_user_id: before, to_user_id: after });
    }
  }
  await ctx.scheduler.runAfter(0, internal.slackSync.reattributeSlackPerson, {
    team_id: opts.teamId, slack_user_id: opts.row.slack_user_id, link_index: 0,
  });
}

export const claimSlackPeopleByEmail = internalMutation({
  args: { user_id: v.id("users"), email: v.string() },
  handler: async (ctx, args): Promise<{ claimed: number }> => {
    const email = args.email.trim().toLowerCase();
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .collect();
    let claimed = 0;
    for (const m of memberships) {
      if ((await teammateByEmail(ctx, m.team_id, email))?.toString() !== args.user_id.toString()) continue;
      const install = await installationForTeam(ctx, m.team_id);
      if (!install) continue;
      const rows = await ctx.db
        .query("slack_users")
        .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", install.workspace_id))
        .collect();
      for (const row of rows) {
        if ((row.email ?? "").toLowerCase() !== email) continue;
        if (row.mapped_by === "manual") continue;
        if (row.codecast_user_id?.toString() === args.user_id.toString()) continue;
        await assignSlackPerson(ctx, { teamId: m.team_id, row, codecastUserId: args.user_id });
        claimed++;
      }
    }
    return { claimed };
  },
});

// A teammate signed in to Slack from codecast (slack.ts storeUserToken): Slack
// itself just said which Slack user they are, which beats any email rule. The
// one case left alone is a mapping a teammate already chose by hand that
// points at THIS person — nothing to change. A first sight of the person
// (no profile row yet) seeds one under the teammate's name; the next line
// they write refreshes the face from users.info (fetched_at 0 = stale).
export const linkSignedInPerson = internalMutation({
  args: { installation_id: v.id("slack_installations"), user_id: v.id("users"), slack_user_id: v.string() },
  handler: async (ctx, args) => {
    const install = await ctx.db.get(args.installation_id);
    const user = await ctx.db.get(args.user_id);
    // A personal-scope install mirrors no team channels: nothing to re-author.
    // (Held in its own const: TypeScript does not carry an optional-chain
    // check on install?.team_id over to later uses of install.team_id.)
    const teamId = install?.team_id;
    if (!install || !teamId || !user || user.is_bot) return { status: "skipped" as const };
    let row = await slackUserRow(ctx, install.workspace_id, args.slack_user_id);
    if (row?.codecast_user_id?.toString() === args.user_id.toString()) return { status: "already" as const };
    if (!row) {
      const id = await ctx.db.insert("slack_users", {
        workspace_id: install.workspace_id,
        slack_user_id: args.slack_user_id,
        name: oneLine(displayName(user), 80),
        avatar_url: user.image ?? undefined,
        email: user.email?.toLowerCase(),
        fetched_at: 0,
      });
      row = (await ctx.db.get(id))!;
    }
    await assignSlackPerson(ctx, { teamId, row, codecastUserId: args.user_id });
    return { status: "linked" as const };
  },
});

// Re-author every inbound line by one Slack person across the team's mirrored
// channels. One channel page per run, so a big room never exceeds one
// mutation's budget; a mapping change on a quiet person costs one run.
export const reattributeSlackPerson = internalMutation({
  args: {
    team_id: v.id("teams"),
    slack_user_id: v.string(),
    link_index: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const install = await installationForTeam(ctx, args.team_id);
    if (!install) return;
    const row = await slackUserRow(ctx, install.workspace_id, args.slack_user_id);
    if (!row) return;
    const links = await ctx.db
      .query("slack_channel_links")
      .withIndex("by_team", (q: any) => q.eq("team_id", args.team_id))
      .collect();
    const link = links[args.link_index];
    if (!link) return;
    const page = await ctx.db
      .query("chat_messages")
      .withIndex("by_channel_external_ts", (q: any) => q.eq("channel_id", link.chat_channel_id))
      .paginate({ numItems: 300, cursor: args.cursor ?? null });
    const teammate = row.codecast_user_id ?? null;
    let bridge: Id<"users"> | null = null;
    for (const m of page.page) {
      if (m.external?.provider !== "slack" || m.external.direction !== "inbound" || m.external.user !== args.slack_user_id) continue;
      if (teammate) {
        if (m.user_id.toString() === teammate.toString() && !m.external_author) continue;
        await ctx.db.patch(m._id, { user_id: teammate, external_author: undefined });
      } else {
        bridge ??= await ensureBridgeUser(ctx, install);
        await ctx.db.patch(m._id, {
          user_id: bridge,
          external_author: { name: row.name, handle: row.handle ?? undefined, avatar_url: row.avatar_url ?? undefined, is_bot: row.is_bot || undefined },
        });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.slackSync.reattributeSlackPerson, { ...args, cursor: page.continueCursor });
    } else if (args.link_index + 1 < links.length) {
      await ctx.scheduler.runAfter(0, internal.slackSync.reattributeSlackPerson, { team_id: args.team_id, slack_user_id: args.slack_user_id, link_index: args.link_index + 1 });
    }
  },
});

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

export async function buildInboundResolver(
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
    // A line codecast posted into a DM as the person carries no bot id, so
    // Slack hands it back as an ordinary user event: the outbound stamp is
    // what says it is ours.
    const ours = await findMirroredRow(ctx, link, args.ts);
    if (ours) return { status: "duplicate", message_id: ours._id };

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
      // Only a live line is something somebody just said. The import (and a
      // root fetched to give a live reply its thread) is history: kept, but
      // announced to nobody — see postChatMessage.
      history: !args.live,
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

// The history import, in runs. Slack pages the window with its own cursor
// (with both bounds given it walks newest first; with only `oldest` it walks
// from the oldest end, which is why the cursor and not a ts is the position).
// Each run reads one page, applies as many roots (with their replies) as fit
// in its time budget, and schedules the next run: the same page with a resume
// point when it ran out of time, the next page otherwise. `latest` is pinned
// to the moment the import started so live lines landing meanwhile never
// shift the pages. A line that fails to convert is counted and skipped, never
// allowed to end the import. Backfilled lines keep Slack's time, so the room
// reads right whatever order they land in.
export const backfill = internalAction({
  args: {
    link_id: v.id("slack_channel_links"),
    oldest_ts: v.string(),
    latest_ts: v.optional(v.string()),
    cursor: v.optional(v.string()),
    // Inside a page: lines at or above this ts were applied by the run that
    // ran out of time; the next run skips them and carries on down the page.
    resume_below_ts: v.optional(v.string()),
    fetched: v.optional(v.number()),
    skipped: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.runQuery(internal.slackSync.linkContext, { link_id: args.link_id });
    if (!c?.link || !c.install) return;
    const { link, install } = c;
    if (link.backfill && link.backfill.status !== "running") return; // cancelled by an unlink, a failure, or the stall sweep
    const runStarted = Date.now();
    const latestTs = args.latest_ts ?? (runStarted / 1000).toFixed(6);
    try {
      await backfillRun(ctx, { link, install, anchor_handle: c.anchor_handle }, args, runStarted, latestTs);
    } catch (error: any) {
      // Anything the per line guard did not catch (Slack unreachable mid run,
      // a bad page) ends the import as stopped, not as a silent stall.
      console.error("[slackSync] backfill run failed", link.slack_channel_id, error);
      await ctx.runMutation(internal.slackSync.patchBackfill, {
        link_id: link._id, fetched: args.fetched ?? 0, skipped: args.skipped ?? 0, status: "failed",
        error: String(error?.message ?? error).slice(0, 200),
      });
    }
  },
});

async function backfillRun(
  ctx: ActionCtx,
  c: { link: Link; install: Install; anchor_handle: string | null },
  args: { link_id: Id<"slack_channel_links">; oldest_ts: string; latest_ts?: string; cursor?: string; resume_below_ts?: string; fetched?: number; skipped?: number },
  runStarted: number,
  latestTs: string,
): Promise<void> {
    const { link, install } = c;
    const resp = await slackApi(install.bot_token, "conversations.history", {
      channel: link.slack_channel_id,
      ...(Number(args.oldest_ts) > 0 ? { oldest: args.oldest_ts, inclusive: "true" } : {}),
      latest: latestTs,
      limit: String(BACKFILL_PAGE),
      cursor: args.cursor,
    });
    if (!resp.ok) {
      await ctx.runMutation(internal.slackSync.patchBackfill, {
        link_id: link._id, fetched: args.fetched ?? 0, skipped: args.skipped ?? 0, status: "failed", error: `Slack: ${resp.error}`,
      });
      await ctx.runMutation(internal.slackSync.pauseLink, { link_id: link._id, error: `Backfill failed: ${resp.error}` });
      return;
    }
    const messages: any[] = [...(resp.messages ?? [])]
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .filter((m) => !args.resume_below_ts || Number(m.ts) < Number(args.resume_below_ts));
    const ctxRow = { install, link: { ...link, since_ts: args.oldest_ts }, anchor_handle: c.anchor_handle };
    let fetched = args.fetched ?? 0;
    let skipped = args.skipped ?? 0;
    let capped = false;
    let outOfTime = false;
    let lastTs: string | undefined;
    const mirrorOne = async (m: any) => {
      try {
        const r = await mirrorMessage(ctx, ctxRow, m, { live: false });
        if (r.message_id) fetched++;
      } catch (error) {
        skipped++;
        console.error("[slackSync] backfill: line skipped", link.slack_channel_id, m?.ts, error);
      }
    };
    for (const m of messages) {
      if (fetched >= BACKFILL_MAX_TOTAL) { capped = true; break; }
      if (Date.now() - runStarted > BACKFILL_RUN_BUDGET_MS) { outOfTime = true; break; }
      lastTs = m.ts;
      if (m.subtype && m.subtype !== "file_share" && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message") continue;
      await mirrorOne(m);
      if (link.options.threads && m.reply_count > 0) {
        // A long thread is applied whole, so the next run never revisits the
        // root; the budget is generous (thrice the root budget) but bounded,
        // and a thread that still overruns it is cut, counted, and logged
        // rather than allowed to outlive the action.
        let replyCursor: string | undefined;
        let cut = false;
        for (let page = 0; page < 5 && fetched < BACKFILL_MAX_TOTAL; page++) {
          const replies = await slackApi(install.bot_token, "conversations.replies", {
            channel: link.slack_channel_id, ts: m.ts, limit: "200", cursor: replyCursor,
          });
          if (!replies.ok) break;
          for (const reply of (replies.messages ?? []).filter((x: any) => x.ts !== m.ts)) {
            if (fetched >= BACKFILL_MAX_TOTAL) break;
            if (Date.now() - runStarted > BACKFILL_RUN_BUDGET_MS * 3) { cut = true; break; }
            await mirrorOne(reply);
          }
          if (cut) break;
          replyCursor = replies.response_metadata?.next_cursor || undefined;
          if (!replyCursor) break;
        }
        if (cut) {
          skipped++;
          console.error("[slackSync] backfill: thread cut short by the run budget", link.slack_channel_id, m.ts);
        }
      }
    }
    const nextCursor = resp.response_metadata?.next_cursor || undefined;
    const more = !capped && (outOfTime || !!nextCursor);
    await ctx.runMutation(internal.slackSync.patchBackfill, {
      link_id: link._id, fetched, skipped, status: more ? "running" : "done", capped: capped || undefined,
    });
    if (more) {
      await ctx.scheduler.runAfter(0, internal.slackSync.backfill, outOfTime
        // Same page, below the last line applied.
        ? { link_id: link._id, oldest_ts: args.oldest_ts, latest_ts: latestTs, cursor: args.cursor, resume_below_ts: lastTs, fetched, skipped }
        : { link_id: link._id, oldest_ts: args.oldest_ts, latest_ts: latestTs, cursor: nextCursor, fetched, skipped });
    }
}

export const patchBackfill = internalMutation({
  args: {
    link_id: v.id("slack_channel_links"),
    fetched: v.number(),
    skipped: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    capped: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return;
    const now = Date.now();
    const prev = link.backfill ?? { window: "all", status: "running" as const, fetched: 0, started_at: now };
    await ctx.db.patch(link._id, {
      backfill: {
        ...prev,
        fetched: args.fetched,
        skipped: args.skipped || undefined,
        status: args.status,
        capped: args.capped ?? prev.capped,
        error: args.error,
        finished_at: args.status === "running" ? undefined : now,
        heartbeat_at: now,
      },
      updated_at: now,
    });
  },
});

export const linkContext = internalQuery({
  args: { link_id: v.id("slack_channel_links") },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return null;
    const raw = await ctx.db.get(link.installation_id);
    const install = raw ? await installForLink(ctx, link, raw) : null;
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
  // When the author connected their Slack account this carries THEIR token in
  // the app's place and the post goes out as them, plain (no borrowed name or
  // face). `app_token` is the app's own, kept for the fallback.
  install: Install;
  as_person?: boolean;
  app_token?: string;
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
    let install = await ctx.db.get(link.installation_id);
    const channel = await ctx.db.get(message.channel_id);
    if (!install || !channel) return null;
    const author = await ctx.db.get(message.user_id);
    // Speak as the author when they have connected their own Slack account:
    // the line lands in Slack under their real name and face, not the app's
    // wearing their name. A DM has no other way to be said at all, so there the
    // missing token keeps the line home; in a channel the app says it for them.
    //
    // Never for an agent's line. A session or the anchor writing in somebody's
    // room must not appear in Slack as that person typing; those keep going as
    // the app, named "… (agent)", which is the whole point of that naming.
    let asPerson = false;
    const byHand = !isAgentLine(message);
    const token = byHand ? await userTokenFor(ctx, install._id, message.user_id) : null;
    if (token && tokenCanPost(token.scopes)) {
      install = { ...install, bot_token: token.token };
      asPerson = true;
    } else if (link.kind === "dm" && byHand) {
      return null;
    } else if (link.kind === "dm") {
      // An agent line in a mirrored DM: the app is not in that conversation and
      // must not borrow the person's account, so it stays here.
      return null;
    }
    const appToken = (await ctx.db.get(link.installation_id))!.bot_token;
    const root = message.thread_root_id ? await ctx.db.get(message.thread_root_id) : null;
    // Mentions written in the line, mapped to Slack people where we know them.
    const handleToSlack: Record<string, string> = {};
    for (const ref of message.mentions ?? []) {
      // A Slack-only person: the resolver already knows who they are there.
      if (typeof ref === "object" && ref.kind === "slack") {
        handleToSlack[ref.handle.toLowerCase()] = ref.user;
        continue;
      }
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
    // A handle the stored refs did not answer is looked up in the workspace
    // roster now: the line may have been written before that person was known
    // here, and a mention of a Slack agent or bot carries no codecast ref at
    // all. Whatever still misses stays as the `@name` the author typed, which
    // reads as a name in Slack instead of a broken token.
    for (const written of extractMentionHandles(message.content)) {
      if (handleToSlack[written]) continue;
      const person = await slackPersonForHandle(ctx, link.workspace_id, written);
      if (person) handleToSlack[written] = person.slack_user_id;
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
      as_person: asPerson || undefined,
      app_token: asPerson ? appToken : undefined,
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
      username: c.as_person ? undefined : slackDisplayName(c.author),
      icon_url: c.as_person ? undefined : c.author.image ?? undefined,
      thread_ts: c.message.thread_root_id ? c.root_ts ?? undefined : undefined,
      reply_broadcast: c.message.thread_root_id && c.message.broadcast && c.root_ts ? true : undefined,
      unfurl_links: false,
      unfurl_media: true,
    };
    let resp = await slackApi(c.install.bot_token, "chat.postMessage", params);
    // Posting as the author needs THEM in the Slack channel. When they are not
    // (they read it here, never joined there), the app says it in their name
    // instead of dropping the line.
    if (!resp.ok && c.as_person && c.app_token && (resp.error === "not_in_channel" || resp.error === "channel_not_found")) {
      const named = { ...params, username: slackDisplayName(c.author), icon_url: c.author.image ?? undefined };
      resp = await slackApi(c.app_token, "chat.postMessage", named);
      if (!resp.ok && (await recoverNotInChannel({ ...c.install, bot_token: c.app_token }, c.link, resp.error))) {
        resp = await slackApi(c.app_token, "chat.postMessage", named);
      }
    }
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
    // A history import that has not reported in for a while lost its action.
    // Mark it stopped (the link keeps mirroring live lines) so the dialog
    // offers to run it again. The heartbeat is the import's own, because
    // updated_at also moves when a live line lands.
    const running = await ctx.db.query("slack_channel_links").withIndex("by_team").collect();
    for (const link of running) {
      if (importStalled(link, now) && link.backfill) {
        await ctx.db.patch(link._id, {
          backfill: { ...link.backfill, status: "failed", error: "The import stopped without finishing", finished_at: now },
          updated_at: now,
        });
      }
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
