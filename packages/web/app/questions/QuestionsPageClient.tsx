"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DecisionQueue } from "../../components/DecisionQueue";

// The queue owns its whole canvas (see lib/pageLayout FULL_WIDTH_PATTERNS):
// one decision at a time, nothing else on screen. `?s=<conversationId>` —
// set by clicking a card in the rail's Questions section — anchors the queue
// on that session's question; keying on it means clicking another card while
// the queue is open re-anchors cleanly instead of fighting stale state.
export function QuestionsPageClient() {
  const router = useRouter();
  const anchor = useSearchParams().get("s");

  const exit = useCallback(() => {
    router.push("/inbox");
  }, [router]);

  return (
    <div className="h-full bg-sol-bg">
      <DecisionQueue key={anchor ?? "all"} onExit={exit} initialConversationId={anchor} />
    </div>
  );
}
