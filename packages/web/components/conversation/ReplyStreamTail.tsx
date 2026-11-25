"use client";

import { memo } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { GROUP_WINDOW_MS } from "@codecast/shared/chat";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncReplyStream } from "../../hooks/useSyncReplyStream";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { replyStreamFresh, replyStreamHandedOff, type StoredReplyStream } from "../../lib/replyStreamHandoff";
import type { MessageFeedDensity } from "./types";
import { AssistantBlock } from "./blocks/turnBlocks";

// Live replies: the text Claude Code is writing, drawn after the last message
// as the assistant row that will replace it (contract:
// @codecast/shared/contracts/replyStream, rules: lib/replyStreamHandoff).

/** Feeds the open conversation's reply stream into the store. Renders nothing;
 *  subscribes only where the conversation's workspace has the feature on. */
export function ReplyStreamFeeder({ conversationId, teamId }: { conversationId: string; teamId?: string | null }) {
  const on = useInboxStore((s) => workspaceFeatureEnabled(s.teams || [], teamId ?? null, "reply_streaming"));
  useSyncReplyStream(conversationId, on);
  return null;
}

/**
 * The reply being written, as the AssistantBlock its message will draw once it
 * lands, so header, spacing and density match at the hand-off. Re-renders on a
 * push (the row is a new object only when it changed), on the hand-off and on
 * going stale; nothing else in the conversation does.
 */
export const ReplyStreamTail = memo(function ReplyStreamTail({
  conversationId,
  density,
  prevAssistantAt,
  agentType,
  model,
  agentNameToChildMap,
}: {
  conversationId: string;
  density: MessageFeedDensity;
  /** When the assistant row the reply would continue was written, or null when
   *  the row before it is not the agent's (the reply then opens with its name). */
  prevAssistantAt: number | null;
  agentType?: string;
  model?: string;
  agentNameToChildMap?: Record<string, string>;
}) {
  const row = useInboxStore((s) => s.replyStreams[conversationId] as StoredReplyStream | undefined);
  const handedOff = useInboxStore((s) => {
    const r = s.replyStreams[conversationId] as StoredReplyStream | undefined;
    return !r || replyStreamHandedOff(r, s.messages[conversationId]);
  });
  const now = useNowWhen((t) => (row && replyStreamFresh(row, t) ? "1" : "0"), 10_000);
  if (!row || handedOff || !replyStreamFresh(row, now)) return null;
  const showHeader = prevAssistantAt === null || row.started_at - prevAssistantAt > GROUP_WINDOW_MS;
  // The top padding is the gap a row of its own gets from the row wrappers
  // (ConversationView: bottom of the row above plus top of its own), and the
  // slide-in is the one a new message gets: the hand-off moves nothing.
  return (
    <div key={row.message_id} className={`animate-message-in ${density === "condensed" ? "pt-0.5" : "pt-1 sm:pt-2"}`}>
      <AssistantBlock
        content={row.text}
        timestamp={row.started_at}
        messageId={`reply-stream-${row.message_id}`}
        conversationId={conversationId as Id<"conversations">}
        density={density}
        showHeader={showHeader}
        agentType={agentType}
        model={model}
        agentNameToChildMap={agentNameToChildMap}
        live
      />
    </div>
  );
});
