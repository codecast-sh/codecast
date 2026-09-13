"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DecisionQueue } from "../../components/DecisionQueue";
import { DecisionQueueList } from "../../components/decisions/DecisionQueueList";

// The queue owns its whole canvas (see lib/pageLayout FULL_WIDTH_PATTERNS).
// Two modes. The default is the grouped list (docs/architecture/decisions-as-
// documents.md D5): stacks, scopes, "with a lead", "Handled without you",
// compact cards that link to each decision's page. `?s=<conversationId>` —
// set by clicking a card in the rail's Questions section — and `?mode=step`
// open the one-at-a-time stepper on the session's own pane, which is the only
// place a terminal question (AskUserQuestion, a permission prompt) can be
// answered. Keying the stepper on the anchor means clicking another card
// while it is open re-anchors cleanly instead of fighting stale state.
export function QuestionsPageClient() {
  const router = useRouter();
  const params = useSearchParams();
  const anchor = params.get("s");
  const step = anchor || params.get("mode") === "step";

  const exit = useCallback(() => {
    router.push("/questions");
  }, [router]);

  return (
    <div className="h-full bg-sol-bg">
      {step ? <DecisionQueue key={anchor ?? "all"} onExit={exit} initialConversationId={anchor} /> : <DecisionQueueList />}
    </div>
  );
}
