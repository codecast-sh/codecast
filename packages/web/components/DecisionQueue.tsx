"use client";

import { useCallback, useMemo, useState } from "react";
import type { DecisionAnswerInput, SessionDecisionItem } from "../store/inboxStore";
import { PriorityCardDecision } from "./decisions/PriorityCardDecision";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DecisionDocument } from "./decisions/DecisionDocument";
import { hasOpenModal } from "../shortcuts";
import { keyBelongsElsewhere } from "../shortcuts/keyOwnership";
// The real conversation pane the inbox uses — same component, same data hooks,
// so the queue IS the session view: the decision card renders inside it
// (SessionDecisionCard, mounted by ConversationView), and the queue only adds
// the stepper through DecisionStepperContext.
import { InboxConversation } from "../app/inbox/QueuePageClient";
import { useDecisionQueue, DecisionStepperContext, type DecisionStepper } from "../hooks/useDecisionQueue";
import { useInboxStore } from "../store/inboxStore";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { PreloadPublishedPage } from "./PublishedPageEmbed";

import { useWatchEffect } from "../hooks/useWatchEffect";
import { setDecisionQueueCursor } from "../lib/decisionQueueCursor";
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
export function DecisionQueue({ onExit, initialConversationId, initialKey }: { onExit?: () => void; initialConversationId?: string | null; initialKey?: string | null }) {
  const queue = useDecisionQueue();
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  // The decisions resolved in this visit, oldest first, so Back can return to
  // one to read it whole or change its answer. `back` is the one on screen,
  // an index into it; null is the open queue.
  const [answered, setAnswered] = useState<string[]>([]);
  const [back, setBack] = useState<number | null>(null);

  // Entering from a specific card (the rail's Questions section) starts on
  // THAT session's question; answering then walks the rest of the queue.
  // Only a fallback: the moment the user answers or skips, anchorKey owns
  // the position, so a resolved entry question can't drag us back to it.
  const anchorIdx = anchorKey
    ? queue.findIndex((i) => i.key === anchorKey)
    : initialKey && queue.some((i) => i.key === initialKey)
      ? queue.findIndex((i) => i.key === initialKey)
      : initialConversationId
      ? queue.findIndex((i) => i.conversationId === initialConversationId)
      : -1;
  const position = anchorIdx >= 0 ? anchorIdx : 0;
  const current = queue[position];

  // Called with the key of an item that is LEAVING (answered/dismissed/evicted):
  // re-anchor on whatever follows it, before the store removal re-renders us.
  const advance = useCallback((leavingKey: string) => {
    const i = queue.findIndex((it) => it.key === leavingKey);
    const leaving = queue[i];
    const id = leaving?.shortId ?? leaving?.decisionId;
    if (id) setAnswered((a) => [...a.filter((x) => x !== id), id]);
    const next = queue.find((it, j) => j > i && it.key !== leavingKey) ?? null;
    setAnchorKey(next?.key ?? null);
  }, [queue]);

  const onSkip = useCallback(() => {
    if (queue.length === 0) return;
    setAnchorKey(queue[(position + 1) % queue.length]?.key ?? null);
  }, [queue, position]);

  // Back walks the open queue to its first decision, then the answered ones, newest first.
  const canBack = position > 0 || answered.length > 0 || queue.length > 1;
  const onPrev = useCallback(() => {
    if (position > 0) setAnchorKey(queue[position - 1]?.key ?? null);
    else if (answered.length > 0) setBack(answered.length - 1);
    else if (queue.length > 1) setAnchorKey(queue[queue.length - 1]?.key ?? null);
  }, [queue, position, answered.length]);

  const stepper = useMemo<DecisionStepper | null>(() => current ? {
    position: position + 1,
    total: queue.length,
    onDone: () => advance(current.key),
    onSkip,
    onPrev: canBack ? onPrev : undefined,
    onExit,
    item: current,
  } : null, [current, position, queue.length, advance, onSkip, onPrev, canBack, onExit]);

  // A priority card belongs to its person, not to the session it sits in
  // (isPriorityCard): the stepper draws the card itself, never that session.
  const cardRow = useInboxStore((s) => {
    const d = current?.decisionId ? (s.sessionDecisions as Record<string, SessionDecisionItem | undefined>)[current.decisionId] : undefined;
    return d?.priority_card ? d : null;
  });

  // Keep the rail's highlight on the question you are reading. Off the inbox
  // the rail highlights sidePanelSessionId (sessionFocusKind → "panel"), and
  // that pointer opens nothing on its own — it is purely the highlight — so
  // publishing the queue's current item is exactly "light up this card". The
  // `?s=` anchor cannot do this job: answering advances the queue without
  // touching the URL, and the highlight has to follow the advance. The layout's
  // leave-the-inbox carry-over stands down for this page (pageOwnsRailHighlight)
  // so its default cannot land on top of this write in the same commit.
  const currentId = cardRow ? undefined : current?.conversationId;
  // The inbox panel lights the row this pager names.
  const currentKey = current?.key ?? null;
  useWatchEffect(() => {
    setDecisionQueueCursor(currentKey);
  }, [currentKey]);
  useWatchEffect(() => () => setDecisionQueueCursor(null), []);
  useWatchEffect(() => {
    if (!currentId) return;
    const store = useInboxStore.getState();
    // selectPanelSession toggles the pointer off when handed the id it already
    // holds (the panel's click-to-exit gesture), so only write on a change.
    if (store.sidePanelSessionId !== currentId) store.selectPanelSession(currentId);
  }, [currentId]);

  if (back !== null && answered[back]) {
    return <AnsweredDecision id={answered[back]} at={back} count={answered.length} onStep={setBack} onExit={onExit} />;
  }
  if (!current || !stepper) return <QueueEmpty resolved={answered.length} onBack={answered.length ? () => setBack(answered.length - 1) : undefined} onExit={onExit} />;
  // The decision answering or skipping lands on: its page loads ahead, so it shows at once.
  const next = queue.length > 1 ? queue[(position + 1) % queue.length] : null;

  if (cardRow) return <PriorityCardStep key={cardRow._id} decision={cardRow} stepper={stepper} />;

  return (
    <DecisionStepperContext.Provider value={stepper}>
      {next?.reportSlug && next.source === "decide" && <PreloadPublishedPage slug={next.reportSlug} decision={next.key.replace(/^decide:/, "")} />}
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

// A decision answered in this visit, whole, on its own page: read it, change
// its answer (the new answer goes to the session as a message), or step on.
// ← goes further back, → forward, and past the newest returns to the queue.
function AnsweredDecision({ id, at, count, onStep, onExit }: { id: string; at: number; count: number; onStep: (to: number | null) => void; onExit?: () => void }) {
  const prev = at > 0 ? () => onStep(at - 1) : undefined;
  const next = () => onStep(at + 1 < count ? at + 1 : null);
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.key === "ArrowLeft" && prev) { e.preventDefault(); prev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
      else if (e.key === "Escape") { e.preventDefault(); onStep(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, count, onStep]);
  const btn = "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-card disabled:opacity-30 disabled:hover:bg-transparent";
  const nav = (
    <div className="flex items-center gap-2 text-meta" data-decision-queue-back={`${at + 1}/${count}`}>
      <button type="button" className={btn} disabled={!prev} onClick={prev} aria-label="Earlier answered decision">
        <ChevronLeft className="w-3.5 h-3.5" /><KeyCap size="xs">←</KeyCap>
      </button>
      <span className="tabular-nums text-sol-text-dim">Answered {at + 1} of {count}</span>
      <button type="button" className={btn} onClick={next} aria-label={at + 1 < count ? "Later answered decision" : "Back to the queue"}>
        <KeyCap size="xs">→</KeyCap><ChevronRight className="w-3.5 h-3.5" />
      </button>
      <button type="button" className={`${btn} ml-auto`} onClick={() => onStep(null)} data-decision-queue-return>
        <KeyCap size="xs">esc</KeyCap><span>Back to the queue</span>
      </button>
      {onExit && <button type="button" className={btn} onClick={onExit}>Leave</button>}
    </div>
  );
  return <div className="h-full bg-sol-bg"><DecisionDocument key={id} id={id} pager={false} nav={nav} /></div>;
}

// A priority card in the stepper: the card on its own page, with the
// stepper's way back, on and out. Answering advances first, as the session
// card does, so the next decision shows the moment this one leaves the queue.
function PriorityCardStep({ decision, stepper }: { decision: SessionDecisionItem; stepper: DecisionStepper }) {
  const adoptDecision = useInboxStore((s) => s.adoptDecision);
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const { onDone, onSkip, onPrev, onExit, position, total } = stepper;
  const onAnswer = useCallback((input: DecisionAnswerInput) => {
    onDone();
    adoptDecision(decision._id);
    answerDecision(decision._id, input);
  }, [onDone, adoptDecision, answerDecision, decision._id]);
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.key === "ArrowLeft" && onPrev) { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onSkip(); }
      else if (e.key === "Escape" && onExit) { e.preventDefault(); onExit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onSkip, onExit]);
  // Touch targets on a phone: each control at least 44px, and no key caps where there are no keys.
  const btn = "inline-flex items-center justify-center gap-1.5 rounded px-1.5 py-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-card disabled:opacity-30 disabled:hover:bg-transparent max-[520px]:min-h-11 max-[520px]:min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
  const cap = "max-[520px]:hidden [@media(pointer:coarse)]:hidden";
  return (
    <div className="h-full overflow-y-auto bg-sol-bg" data-decision-queue-card={decision.short_id ?? decision._id}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-16">
        <div className="flex items-center gap-2 text-meta" data-decision-queue-step={`${position}/${total}`}>
          <button type="button" className={btn} disabled={!onPrev} onClick={onPrev} aria-label="Previous decision">
            <ChevronLeft className="w-3.5 h-3.5" /><span className={cap}><KeyCap size="xs">←</KeyCap></span>
          </button>
          <span className="tabular-nums text-sol-text-dim">{position} of {total}</span>
          <button type="button" className={btn} onClick={onSkip} aria-label="Skip to the next decision" data-decision-queue-skip>
            <span className={cap}><KeyCap size="xs">→</KeyCap></span><ChevronRight className="w-3.5 h-3.5" />
          </button>
          {onExit && <button type="button" className={`${btn} ml-auto`} onClick={onExit} data-decision-queue-leave><span className={cap}><KeyCap size="xs">esc</KeyCap></span><span>Leave</span></button>}
        </div>
        <div className="mt-5"><PriorityCardDecision decision={decision} card={decision.priority_card!} onAnswer={onAnswer} /></div>
      </div>
    </div>
  );
}

function QueueEmpty({ resolved, onBack, onExit }: { resolved: number; onBack?: () => void; onExit?: () => void }) {
  // Nothing to render means nothing to claim keys for, except the way back and the way out.
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit?.();
      if (e.key === "ArrowLeft" && onBack && !keyBelongsElsewhere(e.target)) { e.preventDefault(); onBack(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, onBack]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <div className="text-2xl text-sol-text">Nothing needs you.</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        {resolved > 0
          ? "You cleared the queue. New decisions appear here the moment an agent asks."
          : "Your agents are working. You will be interrupted when that changes."}
      </div>
      <div className="mt-2 flex items-center gap-4">
        {onBack && (
          <button onClick={onBack} className="text-xs text-sol-text-dim hover:text-sol-text transition-colors" data-decision-queue-review>
            <KeyCap size="xs">←</KeyCap> <span className="ml-1">review what you answered ({resolved})</span>
          </button>
        )}
        {onExit && (
          <button onClick={onExit} className="text-xs text-sol-text-dim hover:text-sol-text transition-colors">
            <KeyCap size="xs">esc</KeyCap> <span className="ml-1">back to the inbox</span>
          </button>
        )}
      </div>
    </div>
  );
}
