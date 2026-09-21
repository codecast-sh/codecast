import type { ChatSlackLinkRow } from "../store/chatSlice";
import "../components/chat/chat.css";

export function slackDeepLink(workspaceId: string, channelId: string, ts?: string): string {
  return `slack://channel?team=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(channelId)}${ts ? `&message=${encodeURIComponent(ts)}` : ""}`;
}

/** The mirror row for one channel, out of the store's whole link map. At most
 *  one link per channel (the server enforces it), so the first match is THE
 *  answer. Takes the map rather than reading the store, so a snapshot caller
 *  (the channel menu) and a subscribed one both use this one lookup. */
export function slackLinkForChannel(
  links: Record<string, ChatSlackLinkRow> | undefined,
  channelId: string | null | undefined,
): ChatSlackLinkRow | null {
  if (!channelId || !links) return null;
  for (const id in links) {
    if (links[id].chat_channel_id === channelId) return links[id];
  }
  return null;
}
