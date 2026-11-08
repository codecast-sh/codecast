// The excerpt a chat wake quotes, shared by every wake that hands a session or
// the anchor a line from team chat: the anchor's wake, the session relay and a
// round's floor (chatRounds). A leaf, so chatRounds reads it without importing
// chat.ts.

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isSilentAgentRow } from "@codecast/shared/chat";
import { displayName } from "./lib/displayNames";
import { oneLine } from "./chatText";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

// How many thread messages the anchor's wake prompt may carry. The excerpt is
// always confined to ONE thread — never the channel — so mentioning the anchor
// hands it the conversation it was called into and nothing else.
const ANCHOR_THREAD_EXCERPT = 12;

// How many channel-level messages the wake carries as room context. The thread
// is the conversation; the channel excerpt is what the room was talking about
// around it, so a mention like "can you look at what Sam posted above" lands.
const ANCHOR_CHANNEL_CONTEXT = 8;

// The excerpt a chat wake quotes: the thread (root first, newest replies
// last) and a short slice of the room around it — a mention rarely arrives with
// its context inside the thread — never crossing into another channel. Shared
// by the anchor wake and the session relay so both agents read the same room.
export async function collectChatExcerpt(
  ctx: ReadCtx,
  opts: {
    channel: Doc<"chat_channels">;
    root: Doc<"chat_messages"> | null;
    message: Doc<"chat_messages">;
    senderName: string;
    threadRootId?: Id<"chat_messages">;
    /** Rows the READER wrote, quoted back as "You (earlier)". */
    isSelf: (row: Doc<"chat_messages">) => boolean;
    /** A row to leave out (the anchor's own fresh placeholder). */
    skipId?: Id<"chat_messages">;
    /** How many of the thread's newest replies to quote. */
    threadLimit?: number;
  },
): Promise<{
  entries: Array<{ name: string; content: string }>;
  channelEntries: Array<{ name: string; content: string }>;
}> {
  const names = new Map<string, string>();
  // "You (earlier)" is decided PER ROW, never cached by author: a session and
  // its human host share a user_id, so caching the self label under the user
  // would dress the human's own lines (and other sessions') as the reader's.
  const humanName = async (userId: Id<"users">): Promise<string> => {
    const key = userId.toString();
    if (!names.has(key)) names.set(key, displayName(await ctx.db.get(userId)));
    return names.get(key)!;
  };
  // A line a session typed names the session, crediting its human, the way
  // the chat renders it: under the human's name alone, the reader cannot
  // tell a session's answer from the person's own words.
  const nameFor = async (row: Doc<"chat_messages">): Promise<string> => {
    if (opts.isSelf(row)) return "You (earlier)";
    const human = await humanName(row.user_id);
    if (row.origin === "agent" && row.origin_session_id && row.author_kind !== "agent") {
      const title = row.origin_session_title ? `${oneLine(row.origin_session_title, 60)}, ` : "";
      return `${title}session ${row.origin_session_id.slice(0, 7)} via ${human}`;
    }
    return human;
  };
  const entries: Array<{ name: string; content: string }> = [];
  if (opts.root && opts.threadRootId) {
    const thread = await ctx.db
      .query("chat_messages")
      .withIndex("by_thread_created", (q: any) => q.eq("thread_root_id", opts.threadRootId))
      .order("desc")
      .take(opts.threadLimit ?? ANCHOR_THREAD_EXCERPT);
    for (const row of [opts.root, ...thread.reverse()]) {
      if (opts.skipId && row._id.toString() === opts.skipId.toString()) continue;
      if (row.deleted_at || isSilentAgentRow(row)) continue;
      entries.push({ name: await nameFor(row), content: row.content });
    }
  } else {
    entries.push({ name: opts.senderName, content: opts.message.content });
  }
  // The room around it: recent channel-level lines older than this thread's
  // root (a DM room has no threads to speak of, so its recent lines ARE the
  // context). Skipped for the thread's own root, which the thread excerpt opens.
  const rootRow = opts.root ?? opts.message;
  const recentRoots = await ctx.db
    .query("chat_messages")
    .withIndex("by_channel_created", (q: any) =>
      q.eq("channel_id", opts.channel._id).lt("created_at", rootRow.created_at))
    .order("desc")
    .filter((q) => q.eq(q.field("thread_root_id"), undefined))
    .take(ANCHOR_CHANNEL_CONTEXT);
  const channelEntries: Array<{ name: string; content: string }> = [];
  for (const row of recentRoots.reverse()) {
    if (row.deleted_at || isSilentAgentRow(row)) continue;
    channelEntries.push({ name: await nameFor(row), content: row.content });
  }
  return { entries, channelEntries };
}
