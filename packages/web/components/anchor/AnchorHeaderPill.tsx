"use client";

// In a conversation header's facts strip: when the open conversation IS a
// workspace agent's (the workspace agent or a role's seat), say which
// workspace, as one quiet fact like the inbox card's meta line. The header's
// own mark already shows who the agent is, so no face here. Reads the store,
// so it works on the stage, in the slide-over and on the /anchor page alike,
// and costs a one-string subscription for every other conversation.

import { useInboxStore } from "../../store/inboxStore";
import { useAnchorIdentity } from "../../hooks/useSyncAnchors";
import { AnchorScopePill } from "./AnchorIdentity";

export function AnchorHeaderFact({ conversationId }: { conversationId: string }) {
  const anchorId = useInboxStore((s) => {
    const row: any = s.sessions[conversationId] ?? s.conversations[conversationId];
    return (row?.anchor_id as string | null | undefined) ?? null;
  });
  const identity = useAnchorIdentity(anchorId);
  if (!anchorId || !identity) return null;
  return <AnchorScopePill anchor={identity} quiet className="flex-shrink-0" />;
}
