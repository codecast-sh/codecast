// Whether a conversation view draws a reply being written, and where: the
// reply's message id and start, while it is open (not yet in the messages)
// and fresh (pushed recently, by this browser's receipt clock). Re-renders its
// caller when a reply opens, moves to its next message, lands or goes stale,
// never on a push.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useNowWhen } from "./useCoarseNow";
import { replyStreamFresh, replyStreamRowKey, replyStreamSlotSig } from "../lib/replyStreamHandoff";

export type ReplyStreamSlot = { messageId: string; startedAt: number; key: string };

export function useReplyStreamSlot(conversationId: string | undefined, drawable: boolean): ReplyStreamSlot | null {
  const sig = useInboxStore((s) => (drawable && conversationId ? replyStreamSlotSig(s as any, conversationId) : ""));
  // Freshness moves with the clock, not with the store: the coarse clock
  // re-renders only when it flips. A push after a stale spell shows again at
  // the next tick.
  const freshAt = (t: number) => {
    if (!sig || !conversationId) return false;
    const row = useInboxStore.getState().replyStreams[conversationId];
    return !!row && replyStreamFresh(row, t);
  };
  const now = useNowWhen((t) => (freshAt(t) ? "1" : "0"), 2_000);
  const fresh = freshAt(now);
  return useMemo(() => {
    if (!sig || !fresh) return null;
    const at = sig.lastIndexOf(" ");
    const messageId = sig.slice(0, at);
    return { messageId, startedAt: Number(sig.slice(at + 1)), key: replyStreamRowKey(messageId) };
  }, [sig, fresh]);
}
