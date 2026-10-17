import { useTrackedStore } from "../store/inboxStore";
import type { ChatSlackLinkRow } from "../store/chatSlice";
import { slackLinksSig } from "../store/chatWakeSigs";
import "../components/chat/chat.css";
import { slackLinkForChannel } from "../lib/slackChannelLink";

export function useChannelSlackLink(channelId: string | null | undefined): ChatSlackLinkRow | null {
  const s = useTrackedStore([(st) => slackLinksSig(st.chatSlackLinks as any)]);
  return slackLinkForChannel(s.chatSlackLinks as any, channelId);
}
