// The one decision point for "does this chat write go to Slack?", plus the two
// row lookups every Slack surface starts from. chat.ts calls the decision after
// a message lands, an edit or delete is applied, or a reaction toggles; it reads
// the channel's link and the link's controls and schedules the push action or
// does nothing. It lives apart from slackSync.ts so chat.ts and slack.ts can
// import it without a cycle (slackSync imports chat's insert helpers, and
// slack.ts owns the OAuth flow slackSync reads its base URL from).
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { linkSendsOutbound, slackSendAuth, type SlackSendAuth } from "./slackMirror";

export type SlackLink = Doc<"slack_channel_links">;
// A reader, so a query context and a mutation context both fit.
type ReadCtx = { db: QueryCtx["db"] };

export async function slackLinksWithSendAuth(ctx: ReadCtx, links: SlackLink[], userId: Id<"users">) {
  const auth = new Map<string, SlackSendAuth>();
  for (const link of links) {
    if (link.kind !== "dm" || auth.has(link.installation_id)) continue;
    const token = await ctx.db.query("slack_user_tokens")
      .withIndex("by_installation_user", (q) => q.eq("installation_id", link.installation_id).eq("user_id", userId))
      .first();
    auth.set(link.installation_id, slackSendAuth(token));
  }
  return links.map((link) => link.kind === "dm"
    ? { ...link, viewer_user_id: userId, viewer_slack_auth: auth.get(link.installation_id)! }
    : link);
}

export async function slackLinkForChannel(
  ctx: ReadCtx,
  chatChannelId: Id<"chat_channels">,
): Promise<SlackLink | null> {
  return await ctx.db
    .query("slack_channel_links")
    .withIndex("by_chat_channel", (q: any) => q.eq("chat_channel_id", chatChannelId))
    .first();
}

/** The Slack workspace a team installed: one per team, serving its anchor and
 *  every channel mirror alike. */
export async function installationForTeam(
  ctx: ReadCtx,
  teamId: Id<"teams">,
): Promise<Doc<"slack_installations"> | null> {
  return await ctx.db
    .query("slack_installations")
    .withIndex("by_team", (q: any) => q.eq("team_id", teamId))
    .first();
}

// The direction questions are pure and the web asks them too (the composer's
// keep-local switch, the "Share to Slack" item), so they live in the shared
// module and are re-exported here for the server's callers.
export { linkReceivesInbound, linkSendsOutbound } from "./slackMirror";

export function isAgentLine(message: Doc<"chat_messages">): boolean {
  return message.author_kind === "agent" || message.origin === "agent";
}

/** Why a message will not be mirrored, or null when it will. Pure, so the
 *  composer and the message menu can show the same answer the server gives. */
export function outboundSkipReason(link: SlackLink, message: Doc<"chat_messages">): string | null {
  if (!linkSendsOutbound(link)) return link.paused ? "paused" : "direction";
  if (message.external) return message.external.direction === "inbound" ? "from_slack" : "already_sent";
  if (message.sync_local_only) return "local_only";
  if (message.deleted_at) return "deleted";
  if (message.voice || message.call) return "voice";
  if (message.agent_status && message.agent_status !== "done") return "agent_pending";
  if (message.thread_root_id && !link.options.threads) return "threads_off";
  if (isAgentLine(message) && !link.options.agent_lines) return "agent_lines_off";
  if (!message.content.trim() && !(message.attachments?.length)) return "empty";
  return null;
}

type Op =
  | { op: "message"; message: Doc<"chat_messages"> }
  | { op: "edit"; message: Doc<"chat_messages"> }
  | { op: "delete"; message: Doc<"chat_messages"> }
  | { op: "reaction"; message: Doc<"chat_messages">; emoji: string; add: boolean };

/** Schedule the Slack side of a chat write, when the channel's link says so.
 *  Never throws: the chat write must land whatever Slack's state is. */
export async function queueSlackOutbound(ctx: MutationCtx, args: Op): Promise<string | null> {
  try {
    const link = await slackLinkForChannel(ctx, args.message.channel_id);
    if (!link) return "no_link";
    if (args.op === "message") {
      const skip = outboundSkipReason(link, args.message);
      if (skip) return skip;
      await ctx.scheduler.runAfter(0, internal.slackSync.pushMessage, { message_id: args.message._id });
      return null;
    }
    if (!linkSendsOutbound(link)) return link.paused ? "paused" : "direction";
    const ext = args.message.external;
    if (args.op === "reaction") {
      if (!link.options.reactions) return "reactions_off";
      if (!ext) return "not_mirrored";
      await ctx.scheduler.runAfter(0, internal.slackSync.pushReaction, {
        message_id: args.message._id,
        emoji: args.emoji,
        add: args.add,
      });
      return null;
    }
    // Edits and deletes: only for lines the bot itself posted. Slack refuses
    // chat.update / chat.delete on anybody else's message.
    if (!link.options.edits) return "edits_off";
    if (!ext || ext.direction !== "outbound") return "not_ours";
    await ctx.scheduler.runAfter(
      0,
      args.op === "edit" ? internal.slackSync.pushEdit : internal.slackSync.pushDelete,
      { message_id: args.message._id },
    );
    return null;
  } catch (error) {
    console.error("[slackSync] queueSlackOutbound failed", error);
    return "error";
  }
}
