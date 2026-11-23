// Direct-message helpers split out of chat.ts: which anchor a DM room belongs
// to, and whether a person's line at the top of a DM answers a session's line.
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { channelAgentRows, channelMemberIds } from "./chatAccess";
import { isSilentAgentRow } from "@codecast/shared/chat";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

// The anchor that is a member of a DM room, if any. Shared by wake routing and
// by access (the anchor's host may read the rooms its anchor is in).
export async function dmAnchorFor(
  ctx: ReadCtx,
  channel: Doc<"chat_channels">,
): Promise<Doc<"anchors"> | null> {
  if (channel.kind !== "dm") return null;
  for (const memberId of await channelMemberIds(ctx, channel._id)) {
    const member = await ctx.db.get(memberId);
    if (!member?.is_bot) continue;
    const anchor = await ctx.db
      .query("anchors")
      .withIndex("by_bot_user", (q: any) => q.eq("bot_user_id", memberId))
      .first();
    if (anchor && anchor.status === "active") return anchor;
  }
  return null;
}

// A person's line at the top of a direct message answers whatever the other
// side said last there. When that was a session's line (`cast chat dm`), the
// line goes back to that session, the way a reply in that line's thread does:
// a DM reads as one conversation, and nobody answers a question in its thread.
// A DM with a role's bot is the anchor's (every line there wakes it), a DM
// with agent members reaches them as members, and a person's own session asked
// the other side: none of those is answered here.
const DM_ANSWER_SCAN = 20;
export async function dmSessionLineAnswered(
  ctx: MutationCtx,
  channel: Doc<"chat_channels">,
  message: Doc<"chat_messages">,
): Promise<Doc<"chat_messages"> | null> {
  if (channel.kind !== "dm" || message.thread_root_id || message.origin === "agent" || message.author_kind === "agent") return null;
  // A session's own DM room (or any room with agent members) hands every line
  // to its members already (deliverToChannelAgents).
  if (await dmAnchorFor(ctx, channel) || (await channelAgentRows(ctx, channel._id)).length > 0) return null;
  const recent = await ctx.db
    .query("chat_messages")
    .withIndex("by_channel_created", (q: any) => q.eq("channel_id", channel._id).lt("created_at", message.created_at))
    .order("desc")
    .filter((q) => q.eq(q.field("thread_root_id"), undefined))
    .take(DM_ANSWER_SCAN);
  for (const row of recent) {
    if (row.deleted_at || row.agent_status || isSilentAgentRow(row)) continue;
    const sessionLine = row.origin === "agent" && !!row.origin_session_id && row.author_kind !== "agent";
    // The sender's own earlier lines ("hm", then "do it") answer the same line.
    if (String(row.user_id) === String(message.user_id) && !sessionLine) continue;
    return sessionLine && String(row.user_id) !== String(message.user_id) ? row : null;
  }
  return null;
}

export async function dmExchange(
  ctx: MutationCtx,
  channel: Doc<"chat_channels">,
  asked: Doc<"chat_messages">,
  answer: Doc<"chat_messages">,
  isSelf: (row: Doc<"chat_messages">) => boolean,
  senderName: string,
): Promise<Array<{ name: string; content: string }>> {
  const rows = await ctx.db
    .query("chat_messages")
    .withIndex("by_channel_created", (q: any) =>
      q.eq("channel_id", channel._id).gte("created_at", asked.created_at).lte("created_at", answer.created_at))
    .filter((q) => q.eq(q.field("thread_root_id"), undefined))
    .take(DM_ANSWER_SCAN + 2);
  return rows
    .filter((row) => !row.deleted_at && !row.agent_status && !isSilentAgentRow(row))
    .map((row) => ({ name: isSelf(row) ? "You (earlier)" : senderName, content: row.content }));
}
