import { chatReactionSyncOpts, useInboxStore, type ChatMessageRow } from "../store/inboxStore";

export function ingestChatPage(data: any): ChatMessageRow[] {
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
  if (data.threads) syncTable("chatThreadSummaries", data.threads.map((thread: any) => ({ ...thread, _id: String(thread.root_id) })));
  return messages;
}
