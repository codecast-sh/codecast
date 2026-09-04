"use client";

import { useCallback, useMemo, useState } from "react";
// The real conversation pane the inbox uses — same component, same data hooks,
// so the queue IS the session view: the decision card renders inside it
// (SessionDecisionCard, mounted by ConversationView), and the queue only adds
// the stepper through DecisionStepperContext.
import { InboxConversation } from "../app/inbox/QueuePageClient";
import { useDecisionQueue, DecisionStepperContext, type DecisionStepper } from "../hooks/useDecisionQueue";
import { useInboxStore } from "../store/inboxStore";
import { KeyCap } from "./KeyboardShortcutsHelp";

import { useWatchEffect } from "../hooks/useWatchEffect";
// One decision at a time, full width, keyboard driven: answer and it advances;
// when the queue empties, say so and get out of the way. Ranking (which
// decision is "current") lives in lib/decisionQueue.
//
// The queue holds NO shadow state about what is answered: every resolution —
// a `cast decide` row flipping, a poll answer, a dismissal — lands in the
// store (answerDecision / resolveSessionQuestion), so the item leaves `queue`
// in the same commit, and the rail's QUESTIONS section reads the identical
// predicate. The only local state is WHICH item you are looking at, tracked
// by key, never by index: a live re-sort (a session's tier flipping, a new
// ask arriving) can reorder the array under you, and an index would silently
// swap the question mid-read.
export function DecisionQueue({ onExit, initialConversationId }: { onExit?: () => void; initialConversationId?: string | null }) {
  const queue = useDecisionQueue();
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  // How many were resolved in this visit — only for the empty screen's copy.
  const [resolvedCount, setResolvedCount] = useState(0);

  // Entering from a specific card (the rail's Questions section) starts on
  // THAT session's question; answering then walks the rest of the queue.
  // Only a fallback: the moment the user answers or skips, anchorKey owns
  // the position, so a resolved entry question can't drag us back to it.
  const anchorIdx = anchorKey
    ? queue.findIndex((i) => i.key === anchorKey)
    : initialConversationId
      ? queue.findIndex((i) => i.conversationId === initialConversationId)
      : -1;
  const position = anchorIdx >= 0 ? anchorIdx : 0;
  const current = queue[position];

  // Called with the key of an item that is LEAVING (answered/dismissed/evicted):
  // re-anchor on whatever follows it, before the store removal re-renders us.
  const advance = useCallback((leavingKey: string) => {
    setResolvedCount((n) => n + 1);
    const i = queue.findIndex((it) => it.key === leavingKey);
    const next = queue.find((it, j) => j > i && it.key !== leavingKey) ?? null;
    setAnchorKey(next?.key ?? null);
  }, [queue]);

  const onSkip = useCallback(() => {
    if (queue.length === 0) return;
    setAnchorKey(queue[(position + 1) % queue.length]?.key ?? null);
  }, [queue, position]);

  const stepper = useMemo<DecisionStepper | null>(() => current ? {
    position: position + 1,
    total: queue.length,
    onDone: () => advance(current.key),
    onSkip,
    onExit,
    item: current.source === "decide" ? undefined : current,
  } : null, [current, position, queue.length, advance, onSkip, onExit]);

  // Keep the rail's highlight on the question you are reading. Off the inbox
  // the rail highlights sidePanelSessionId (sessionFocusKind → "panel"), and
  // that pointer opens nothing on its own — it is purely the highlight — so
  // publishing the queue's current item is exactly "light up this card". The
  // `?s=` anchor cannot do this job: answering advances the queue without
  // touching the URL, and the highlight has to follow the advance. The layout's
  // leave-the-inbox carry-over stands down for this page (pageOwnsRailHighlight)
  // so its default cannot land on top of this write in the same commit.
  const currentId = current?.conversationId;
  useWatchEffect(() => {
    if (!currentId) return;
    const store = useInboxStore.getState();
    // selectPanelSession toggles the pointer off when handed the id it already
    // holds (the panel's click-to-exit gesture), so only write on a change.
    if (store.sidePanelSessionId !== currentId) store.selectPanelSession(currentId);
  }, [currentId]);

  if (!current || !stepper) return <QueueEmpty resolved={resolvedCount} onExit={onExit} />;

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

function QueueEmpty({ resolved, onExit }: { resolved: number; onExit?: () => void }) {
  // Nothing to render means nothing to claim keys for, except the way out.
  useWatchEffect(() => {
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
        {resolved > 0
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
