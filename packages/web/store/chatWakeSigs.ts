// Chat's wake signatures (store/wakeSig.ts). chatMessages and chatReactions
// carry a `transform`, which bypasses syncTable's no-change early return, so
// every push hands back a new collection ref even when nothing changed. Every
// chat reader subscribes to a signature of the fields it renders and reads the
// raw collection in its body (hooks/useChatSync.ts).

import { makeCollectionSig } from "./wakeSig";
import { mentionKey, mentionUserIds } from "@codecast/shared/chat";
import type { ChatChannelRow, ChatMessageRow, ChatRailRow, ChatReactionRow, ChatReadRow, ChatSlackLinkRow } from "./inboxStore";

/** Cheap content digest. Included so a same-length edit still wakes the reader;
 *  the raw string is not, because a channel of 8k-character messages would
 *  rebuild a 400KB signature on every push. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** Everything a TRANSCRIPT renders, message text included. Only the chat page's
 *  own readers subscribe to this.
 *
 *  `voice` and `attachments` are in here because a walkie burst finalizes by
 *  changing ONLY those: status live -> done, the duration, and the recording
 *  arriving as an attachment. The words stream into `content` while the key is
 *  still down, so at release the content hash usually does not move — leaving
 *  them out hashed a finished burst identically to a live one and left the
 *  sender's own bubble pulsing "talking…" until a reload.
 *
 *  `voice.transcribing` is in here for the same reason, one step later. When the
 *  live recognizer heard nothing, the sender's own optimistic row has ALREADY
 *  flipped status to done and written the duration, so the server echo that
 *  turns transcribing on changes that one field and nothing else. Without it in
 *  the hash the echo is a no-op, the bubble never repaints, and "getting the
 *  words" — the whole point of the state — is unreachable on the screen that
 *  needs it most. Verified live: the flag reached the store and the bubble
 *  still read "no words" until the words themselves landed. */
export const messagesSig = makeCollectionSig<ChatMessageRow>(
  (m) =>
    `${m._id}|${m.channel_id}|${m.thread_root_id ?? ""}|${m.user_id}|${m.author_kind ?? ""}` +
    `|${m.created_at}|${m.edited_at ?? 0}|${m.deleted_at ?? 0}|${m.agent_status ?? ""}` +
    // Each mention by its key: a role or session entry is an object, and a
    // plain join would print two different ones as the same "[object Object]".
    // The fold flag is rendered too (the "folded" marker).
    `|${m._failedAt ?? 0}|${m.mention_scope ?? ""}|${(m.mentions ?? []).map(mentionKey).join(",")}|${m.mention_folded ? 1 : 0}` +
    `|${m.content.length}:${hash(m.content)}` +
    `|${m.voice ? `${m.voice.status}:${m.voice.duration_ms ?? 0}:${m.voice.room_key ?? ""}:${m.voice.transcribing ? 1 : 0}` : ""}` +
    `|${(m.attachments ?? []).map((a) => a.storage_id).join(",")}` +
    // The Slack mark: direction + permalink arrive after the post, on their own
    // patch, so they must wake the row that shows them.
    `|${m.external ? `${m.external.direction}:${m.external.ts}:${m.external.permalink ? 1 : 0}` : ""}` +
    `|${m.sync_local_only ? 1 : 0}|${m.external_author?.name ?? ""}:${m.external_author?.avatar_url ?? ""}`,
);

/** What the RAIL counts, and nothing else.
 *
 *  The rail's readers — the sidebar row and the tab title badge — are mounted on
 *  every page of the app, and neither renders a single character of message
 *  text. Folding the content hash into their wake signature made an agent
 *  streaming an answer into a channel nobody is looking at re-render both of
 *  them per chunk and re-tally every message in the store. Subscribe to the
 *  fields you branch on: that is the whole rule (see CLAUDE.md).
 *
 *  `voice.status` IS a field the rail branches on: tallyUnread skips live
 *  voice rows (the badge waits for the release), so a burst that finalizes by
 *  flipping only voice.status changes the unread count. Leaving it out froze
 *  the badge until unrelated activity touched the channel. Status only — the
 *  rail renders neither the duration nor the recording. */
export const railMessagesSig = makeCollectionSig<ChatMessageRow>(
  (m) =>
    `${m._id}|${m.channel_id}|${m.user_id}|${m.created_at}|${m.deleted_at ?? 0}` +
    // People only: the rail's mention count is about the viewer, and a role or
    // session entry can never be them.
    `|${m.mention_scope ?? ""}|${mentionUserIds(m.mentions).join(",")}|${m.voice?.status ?? ""}`,
);

/** What a session PERSONA on a chat line renders (chatViews sessionAuthorFor):
 *  the session's current title and agent, keyed by session id. Sessions
 *  heartbeat about once a second, so the transcript must never subscribe to the
 *  raw collection — this wakes it only when a session is renamed, retyped, or
 *  appears. */
export const sessionOriginSig = makeCollectionSig<any>(
  (s) => `${s.session_id ?? ""}|${s.display_title || s.title || ""}|${s.agent_type ?? ""}`,
);

/** Role seats: what a role's standing agent's chat lines show (seatAuthorFor). */
export const seatSig = makeCollectionSig<any>(
  (a) => `${a.bot_user_id ?? ""}|${a.status}|${a.team_name ?? ""}|${a.role ? `${a.role.short_id}|${a.role.name}|${a.role.handle}|${a.role.avatar ?? ""}|${a.role.given_name ?? ""}|${a.role.assistant?.reach ?? ""}` : ""}`,
);

/** Slack mirrors: everything the header pill and the settings dialog branch on. */
export const slackLinksSig = makeCollectionSig<ChatSlackLinkRow>(
  (l) =>
    `${l._id}|${l.chat_channel_id}|${l.slack_channel_id}|${l.slack_channel_name ?? ""}|${l.direction}|${l.paused ? 1 : 0}` +
    `|${l.kind ?? ""}|${l.team_id}|${l.viewer_user_id ?? ""}|${l.viewer_slack_auth ?? ""}` +
    `|${Object.entries(l.options ?? {}).map(([k, val]) => `${k}=${val ? 1 : 0}`).join(",")}` +
    `|${l.last_inbound_at ?? 0}|${l.last_outbound_at ?? 0}|${l.inbound_count ?? 0}|${l.outbound_count ?? 0}|${l.last_error ?? ""}` +
    `|${l.backfill ? `${l.backfill.status}:${l.backfill.fetched}:${l.backfill.capped ? 1 : 0}` : ""}` +
    `|${l.member_writer ?? ""}|${(l.slack_member_ids ?? []).join(",")}|${l.member_error?.at ?? 0}`,
);

export const channelsSig = makeCollectionSig<ChatChannelRow>(
  (c) => `${c._id}|${c.client_id ?? ""}|${c.name}|${c.topic ?? ""}|${c.archived_at ?? 0}|${c.created_at}`,
);

export const readsSig = makeCollectionSig<ChatReadRow>(
  (r) => `${r._id}|${r.channel_id}|${r.last_read_at}|${r.notify_level}|${r.joined_at ?? 0}`,
);

export const reactionsSig = makeCollectionSig<ChatReactionRow>(
  (r) => `${r._id}|${r.message_id}|${r.user_id}|${r.emoji}`,
);

export function railSig(rail: ChatRailRow[]): string {
  let out = "";
  for (const r of rail ?? []) {
    // The rosters too: the member panel paints the people and agents in a room from these rows.
    const agents = (r.agents ?? []).map((a) => (a.kind === "role" ? a.role_id : a.conversation_id)).join(",");
    out += `${r.channel_id}|${r.sort_at}|${r.unread}|${r.unread_mentions}|${r.notify_level}|${r.joined}|${r.last_message?._id ?? ""}|${(r.member_ids ?? []).join(",")}|${agents};`;
  }
  return out;
}
