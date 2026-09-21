// Where a chat card clicks through: the channel, positioned on a message when
// one is known. Mirrors convex/chatText.ts chatPermalink.
export function chatHref(channelId?: string, messageId?: string): string | null {
  if (!channelId) return null;
  return messageId ? `/chat/${channelId}?m=${messageId}` : `/chat/${channelId}`;
}
