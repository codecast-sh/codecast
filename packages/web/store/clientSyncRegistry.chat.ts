// Team chat's collections (convex/chat.ts), registered in
// CLIENT_SYNC_REGISTRY by spread (store/clientSyncRegistry.ts).
import { deliverableAttachments } from "../lib/pendingUploads";
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const CHAT_SYNC_COLLECTIONS = {
  // Team chat. Persisted so a channel opens with its last page already on screen
  // and an unsent message survives a reload, and deferred because a chat page is
  // never the first paint.
  //
  // Deliberately NOT localFirst. Auto-pending protects a field until the server
  // echoes the identical value, and chat's interesting fields are server clock
  // stamps (created_at / edited_at / deleted_at) the client cannot predict — a
  // pending entry over one of those can never retire, so it would mask the real
  // row forever. Chat reconciles by delta overlay + a client_id supersede
  // instead, and plants its two real deletion tombstones by hand
  // (store/chatSlice.ts explains both).
  chatChannels: {
    writtenBy: ["chat"],
    persistence: { kind: "collection", key: "chatChannels" },
    hydration: { phase: "deferred" },
  },
  chatMessages: {
    writtenBy: ["chat"],
    persistence: { kind: "collection", key: "chatMessages" },
    hydration: { phase: "deferred" },
    // A channel (or a thread) reads off disk without scanning every message
    // the client ever cached.
    indexes: "_id, channel_id, thread_root_id",
    // A row must know which channel it belongs to; anything else is a foreign
    // document that would render as a message with no home.
    validRow: (row: any) => typeof row?.channel_id === "string" && typeof row?.content === "string",
    // A send painted while its images uploaded (chatSlice sendChatMessage) had
    // no outbox entry yet, and the reload took the upload and its blob with
    // it: show it as a failed send carrying what can still be delivered.
    hydrateRow: (row: any) => {
      if (!row?.attachments?.some((a: any) => !a.storage_id) || row._failedAt) return row;
      return {
        ...row,
        attachments: deliverableAttachments(row.attachments),
        _failedAt: Date.now(),
        _failReason: "The image upload was interrupted",
      };
    },
  },
  chatReactions: {
    persistence: { kind: "collection", key: "chatReactions" },
    hydration: { phase: "deferred" },
    indexes: "_id, message_id",
  },
  chatReads: {
    persistence: { kind: "collection", key: "chatReads" },
    hydration: { phase: "deferred" },
    indexes: "_id, channel_id",
  },
  // Slack mirrors (slack_channel_links): which chat channels mirror a Slack
  // channel, which way, and with what controls. Rides chat.listChannels, whose
  // payload is the COMPLETE set for the team, so a plain snapshot sync: an
  // unlinked row disappears on the next push.
  chatSlackLinks: {
    persistence: { kind: "collection", key: "chatSlackLinks" },
    hydration: { phase: "deferred" },
    indexes: "_id, chat_channel_id, team_id",
  },
  // The team's Slack people (slack_users via slackSync.listSlackPeople): the
  // composer offers the unmatched ones as @mention targets, the People popup
  // lists them all. The query serves the complete set, so a snapshot sync.
  chatSlackPeople: {
    persistence: { kind: "collection", key: "chatSlackPeople" },
    hydration: { phase: "deferred" },
    indexes: "_id, team_id, codecast_user_id",
    feeds: ["slackSync.listSlackPeople"],
  },
  // Who wrote each line, for a reader whose roster does not hold the author:
  // a community room (chat.listCommunityChannels) is read by visitors and by
  // members of other teams, and the team roster is the ONLY name source
  // otherwise, so every line would say "Someone". chat.listMessages and
  // chat.getThread already return the authors of the page they serve; this
  // keeps them. Delta: a page names only its own authors and must not evict
  // the rest. Lookup only — never a mention target or a roster.
  chatAuthors: {
    persistence: { kind: "collection", key: "chatAuthors" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;
