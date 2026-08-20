"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
// The real conversation pane the inbox uses — same component, same data hooks,
// so the queue IS the session view: the decision card renders inside it
// (SessionDecisionCard, mounted by ConversationView), and the queue only adds
// the stepper through DecisionStepperContext.
import { InboxConversation } from "../app/inbox/QueuePageClient";
import { useDecisionQueue } from "../hooks/useDecisionQueue";
import { DecisionStepperContext, type DecisionStepper } from "./SessionDecisionCard";
import { KeyCap } from "./KeyboardShortcutsHelp";

// One decision at a time, full width, keyboard driven: answer and it advances;
// when the queue empties, say so and get out of the way. Ranking (which
// decision is "current") lives in lib/decisionQueue.
export function DecisionQueue({ onExit }: { onExit?: () => void }) {
  const items = useDecisionQueue();
  const [cursor, setCursor] = useState(0);
  // Keys of items answered in THIS pass. The store row flips instantly
  // (local-first), but keeping an explicit skip set means "skip" also works
  // without mutating anything, and a re-sorted queue can't resurface a card
  // you just cleared.
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());

  const queue = useMemo(() => items.filter((i) => !cleared.has(i.key)), [items, cleared]);
  const current = queue[Math.min(cursor, Math.max(0, queue.length - 1))];

  const advance = useCallback((key: string) => {
    setCleared((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    setCursor((c) => (c > 0 && c >= queue.length - 1 ? c - 1 : c));
  }, [queue.length]);

  const onSkip = useCallback(() => setCursor((c) => (c + 1) % Math.max(1, queue.length)), [queue.length]);

  // A `cast decide` row answered or dismissed from the card resolves in the
  // store, so the item leaves `items` on its own; a poll/permission card has no
  // row, so the card reports done and the key joins the cleared set either way.
  const stepper = useMemo<DecisionStepper | null>(() => current ? {
    position: Math.min(cursor, queue.length - 1) + 1,
    total: queue.length,
    onDone: () => advance(current.key),
    onSkip,
    onExit,
    // Evicting a card the queue should never have offered (a usage/billing
    // interstitial, a permission answered elsewhere) uses the same cleared set
    // as answering — it leaves the queue and the count together.
    onNotADecision: () => advance(current.key),
    item: current.source === "decide" ? undefined : current,
  } : null, [current, cursor, queue.length, advance, onSkip, onExit]);

  if (!current || !stepper) return <QueueEmpty total={items.length} onExit={onExit} />;

  return (
    <DecisionStepperContext.Provider value={stepper}>
      <div className="h-full">
        <InboxConversation
          key={current.conversationId}
          sessionId={current.conversationId}
          isIdle={!!current.session?.is_idle}
          onSendAndAdvance={onSkip}
        />
      </div>
    </DecisionStepperContext.Provider>
  );
}

function QueueEmpty({ total, onExit }: { total: number; onExit?: () => void }) {
  // Nothing to render means nothing to claim keys for, except the way out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <div className="text-2xl text-sol-text">Nothing needs you.</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        {total > 0
          ? "You cleared the queue. New decisions appear here the moment an agent asks."
          : "Your agents are working. You will be interrupted when that changes."}
      </div>
      {onExit && (
        <button onClick={onExit} className="mt-2 text-xs text-sol-text-dim hover:text-sol-text transition-colors">
          <KeyCap size="xs">esc</KeyCap> <span className="ml-1">back to the inbox</span>
        </button>
      )}
    </div>
  );
}
