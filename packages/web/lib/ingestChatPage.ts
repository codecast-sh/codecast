import type { ConvexReactClient } from "convex/react";
import { useInboxStore } from "../store/inboxStore";
import type { ChatMessageRow, ChatReactionRow } from "../store/chatSlice";
import { isConvexId } from "./entityLinks";
import { prefetchStorageImageUrls } from "../hooks/useStorageImageUrl";

/** One page of a channel, at the server's own default. The live page and the
 *  background prefetch ask with the same args, so the client can answer one
 *  from the other's result. */
export const CHAT_PAGE_SIZE = 50;

/** A chat read's answer (listMessages, getThread, getMessage) into the store,
 *  and its image attachments warmed (id to URL mapping and bytes) so the rows
 *  paint their images from local cache. Audio stays out: a recording resolves
 *  its URL when its play button mounts. Returns the message rows. */
export function ingestChatPage(data: any, convex: ConvexReactClient): ChatMessageRow[] {
  if (!data || data.unavailable) return [];
  const messages: ChatMessageRow[] = data.messages ?? [
    ...(data.message ? [data.message] : []),
    ...(data.root ? [data.root] : []),
    ...(data.replies ?? []),
  ];
  const { syncTable } = useInboxStore.getState();
  if (messages.length) syncTable("chatMessages", messages);
  if (data.authors) syncTable("chatAuthors", data.authors);
  if (data.reactions) syncTable("chatReactions", data.reactions, chatReactionSyncOpts(messages.map(row => row._id)));
  // The server's per-root reply rollups. Without them a thread this client
  // never opened shows no affordance at all.
  if (data.threads) syncTable("chatThreadSummaries", data.threads.map((thread: any) => ({ ...thread, _id: String(thread.root_id) })));
  const images = messages.flatMap(m => (m.attachments ?? []).filter(a => a.storage_id && !a.mime?.startsWith("audio/")).map(a => a.storage_id));
  if (images.length) prefetchStorageImageUrls(convex, images);
  return messages;
}

/**
 * Sync options for a reaction push whose payload is the COMPLETE server set for
 * a known group of messages — which is what chat.listMessages and chat.getThread
 * return alongside their page.
 *
 * Three things happen that a plain delta cannot do:
 *   - a row absent from the page is a real removal (someone took their reaction
 *     back), so it is pruned rather than kept forever;
 *   - the exclude tombstone from this viewer's own optimistic un-react has done
 *     its job once the server agrees, so it is retired instead of accumulating
 *     one dead entry per reaction ever removed;
 *   - an optimistic stub whose real row has arrived is dropped, which is the
 *     supersede a client_id altKey would do if the table had one.
 */
export function chatReactionSyncOpts(messageIds: Iterable<string>) {
  const scope = new Set<string>();
  for (const id of messageIds) scope.add(String(id));
  return {
    isDelta: true,
    pruneAbsentScope: (row: any) => scope.has(String(row?.message_id)),
    transform: (draft: any, table: Record<string, ChatReactionRow>, incoming: ChatReactionRow[]) => {
      const confirmed = new Set<string>();
      for (const row of incoming) {
        confirmed.add(`${row.message_id}\x1f${row.user_id}\x1f${row.emoji}`);
      }
      for (const id of Object.keys(table)) {
        const row = table[id];
        if (!row || !scope.has(String(row.message_id))) continue;
        if (isConvexId(id)) continue;
        // A stub whose server twin is in this authoritative page.
        if (confirmed.has(`${row.message_id}\x1f${row.user_id}\x1f${row.emoji}`)) {
          delete table[id];
          delete draft.pending[`chatReactions:${id}`];
        }
      }
      // Retire tombstones the server has now confirmed. The row is already out of
      // `table` (pruned above, or never re-added), and prev no longer holds it, so
      // nothing can bring it back.
      const prefix = "chatReactions:";
      for (const key of Object.keys(draft.pending)) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (id.includes(":")) continue; // a field entry, not a record tombstone
        if (table[id]) continue;
        delete draft.pending[key];
      }
    },
  };
}
