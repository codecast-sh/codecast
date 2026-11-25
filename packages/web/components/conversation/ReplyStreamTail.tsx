"use client";

import { memo } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncReplyStream } from "../../hooks/useSyncReplyStream";
import type { StoredReplyStream } from "../../lib/replyStreamHandoff";
import type { MessageFeedDensity } from "./types";
import { AssistantBlock } from "./blocks/turnBlocks";

// Live replies: the text Claude Code is writing, drawn in a feed row of its own
// as the assistant row that will replace it (contract:
// @codecast/shared/contracts/replyStream, rules: lib/replyStreamHandoff; where
// and while the row exists: ConversationView and hooks/useReplyStreamSlot).

/** Feeds the open conversation's reply stream into the store. Renders nothing;
 *  subscribes only where the conversation's workspace has the feature on. */
export function ReplyStreamFeeder({ conversationId, teamId }: { conversationId: string; teamId?: string | null }) {
  const on = useInboxStore((s) => workspaceFeatureEnabled(s.teams || [], teamId ?? null, "reply_streaming"));
  useSyncReplyStream(conversationId, on);
  return null;
}

/**
 * The reply being written, as the AssistantBlock its message will draw once it
 * lands. Re-renders on a push (the row is a new object only when it changed);
 * the feed around it does not.
 */
export const ReplyStreamTail = memo(function ReplyStreamTail({
  conversationId,
  density,
  showHeader,
  agentType,
  model,
  agentNameToChildMap,
}: {
  conversationId: string;
  density: MessageFeedDensity;
  showHeader: boolean;
  agentType?: string;
  model?: string;
  agentNameToChildMap?: Record<string, string>;
}) {
  const row = useInboxStore((s) => s.replyStreams[conversationId] as StoredReplyStream | undefined);
  if (!row) return null;
  return (
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
  );
});
