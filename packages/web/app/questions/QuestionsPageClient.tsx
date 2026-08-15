"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { DecisionQueue } from "../../components/DecisionQueue";

// The queue owns its whole canvas (see lib/pageLayout FULL_WIDTH_PATTERNS):
// one decision at a time, nothing else on screen.
export function QuestionsPageClient() {
  const router = useRouter();

  const exit = useCallback(() => {
    router.push("/inbox");
  }, [router]);

  return (
    <div className="h-full bg-sol-bg">
      <DecisionQueue onExit={exit} />
    </div>
  );
}
