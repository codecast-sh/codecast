import type { ChatSlackLinkRow } from "../store/chatSlice";
import "../components/chat/chat.css";

/** An https link, not slack://: the desktop app only hands http(s) to the OS,
 *  and a browser without the Slack app does nothing with the custom scheme.
 *  Slack's redirect opens the app when installed and the web client otherwise. */
export function slackChannelUrl(workspaceId: string, channelId: string): string {
  return `https://slack.com/app_redirect?team=${encodeURIComponent(workspaceId)}&channel=${encodeURIComponent(channelId)}`;
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
