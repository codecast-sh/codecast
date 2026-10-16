import { lazy, Suspense } from "react";
import { MIRROR_STATE_LABEL } from "@codecast/convex/convex/lib/slackMirror";
import { SlackLogo } from "../components/SlackLogo";
import { NavCount } from "../components/sidebar/navPrimitives";
import type { ChatRailChannel } from "../store/chatSlice";
import { chatViewRoomKey, type ChatMember } from "./chatViews";

const OccupancyChip = lazy(() =>
  import("../components/calls/OccupancyChip").then((module) => ({ default: module.OccupancyChip })),
);

/** The live signals a chat row wears wherever it lives — the Chat sublist and
 *  the pinned rail spread this same pair, so the rules can't drift: a huddle
 *  you can walk into first, then a mention count, then the unread dot.
 *
 *  The huddle chip goes in `control` and the counts in `trailing`, because the
 *  two answer to different rules on hover. The counts are information and give
 *  the row's width to the hover actions; the chip is the join button, and
 *  hiding it on hover meant the pointer wiped it out on the way to clicking
 *  it — the one gesture on the row you could never complete with a mouse. */
export function channelSignals(
  channel: ChatRailChannel,
  viewer: string,
  teamMembers: ChatMember[],
): { control: React.ReactNode; trailing: React.ReactNode } {
  return {
    control: (
      <Suspense fallback={null}>
        <OccupancyChip roomKey={chatViewRoomKey(channel, viewer, teamMembers)} className="flex-shrink-0" />
      </Suspense>
    ),
    trailing: (
      <span className="flex items-center gap-1.5">
        {/* A mirrored channel wears the Slack mark as its label: its name is
            the Slack channel's name, so the mark says where the name is from. */}
        {channel.slack && (
          <SlackLogo
            className="nav-slack-mark w-2.5 h-2.5 flex-shrink-0"
            muted={channel.slack.state !== "live"}
            title={`${MIRROR_STATE_LABEL[channel.slack.state]} · #${channel.slack.name}`}
          />
        )}
        {(channel.mentionCount ?? 0) > 0 ? (
          <NavCount n={channel.mentionCount ?? 0} tone="bg-sol-red text-white" small kind="mention" />
        ) : (channel.unreadCount ?? 0) > 0 ? (
          <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan flex-shrink-0" aria-label="Unread" />
        ) : null}
      </span>
    ),
  };
}
