import { linkSendsOutbound, type SlackSendAuth } from "@codecast/convex/convex/lib/slackMirror";
import type { ChatSlackLinkRow } from "../store/chatSlice";

export type SlackDelivery = {
  destination: string;
  auth: SlackSendAuth | "checking";
};

export function slackComposerDelivery(
  link: ChatSlackLinkRow | null,
  viewerId: string | undefined,
  isThread = false,
): SlackDelivery | null {
  if (!link || !linkSendsOutbound(link) || (isThread && !link.options.threads)) return null;
  if (link.kind !== "dm") return { destination: `Slack #${link.slack_channel_name ?? link.slack_channel_id}`, auth: "ready" };
  return {
    destination: "Slack",
    auth: viewerId && link.viewer_user_id === viewerId ? link.viewer_slack_auth ?? "checking" : "checking",
  };
}
