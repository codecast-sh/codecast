"use client";

// In a conversation header: when the open conversation IS an anchor's, say
// which anchor — the scope pill beside the title. Reads the store, so it works
// on the stage, in the slide-over and on the /anchor page alike, and costs a
// one-string subscription for every other conversation.

import { useInboxStore } from "../../store/inboxStore";
import { useAnchorIdentity } from "../../hooks/useSyncAnchors";
import { AnchorGlyph, AnchorScopePill } from "./AnchorIdentity";

export function AnchorHeaderPill({ conversationId }: { conversationId: string }) {
  const anchorId = useInboxStore((s) => {
    const row: any = s.sessions[conversationId] ?? s.conversations[conversationId];
    return (row?.anchor_id as string | null | undefined) ?? null;
  });
  const identity = useAnchorIdentity(anchorId);
  if (!anchorId) return null;
  return (
    <span className="inline-flex items-center gap-1 flex-shrink-0" title="This is an anchor — a standing agent member">
      <AnchorGlyph className="w-3.5 h-3.5 text-sol-cyan" />
      {identity && <AnchorScopePill anchor={identity} />}
    </span>
  );
}
