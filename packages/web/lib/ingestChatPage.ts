import type { ConvexReactClient } from "convex/react";
import { chatReactionSyncOpts, useInboxStore, type ChatMessageRow } from "../store/inboxStore";
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
