// The chat composer's identity: `chat:<channel>` for the channel and
// `chat:<channel>:<root>` for a thread, so a half-written reply and a
// half-written channel message never overwrite each other. MessageInput sees
// only this key, so it parses it back to know which room it is typing into.
export function chatDraftKey(channelId: string, threadRootId?: string): string {
  return threadRootId ? `chat:${channelId}:${threadRootId}` : `chat:${channelId}`;
}

export function parseChatDraftKey(key: string): { channelId: string; threadRootId?: string } | null {
  if (!key.startsWith("chat:")) return null;
  const [channelId, threadRootId] = key.slice(5).split(":");
  return channelId ? { channelId, ...(threadRootId ? { threadRootId } : {}) } : null;
}
