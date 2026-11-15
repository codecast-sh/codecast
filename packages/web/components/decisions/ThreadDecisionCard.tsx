"use client";

import { useCallback, useMemo, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { type DecisionStepper } from "../../hooks/useDecisionQueue";
import { type QueueItem } from "../../lib/decisionQueue";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { SessionDecisionCard, type Size } from "../SessionDecisionCard";

/**
 * A thread's card: the ask picked from it while that ask is still open, else
 * the first of the thread's asks (blocking before advisory), else the one the
 * queue hands in for a terminal question. Picking brings an ask up at the
 * size the person was reading, once: the size is spent as soon as the card
 * has drawn with it, so a card drawn again later (the person folded it, left
 * and came back) opens the way that ask opens by itself. The pick belongs to
 * the visit it was made in: the pane outlives the thread it shows, so leaving
 * the thread drops it and a return starts from the first ask, as ever.
 *
 * A permission ask (`cast decide --run`) is never one of the asks stepped to
 * here: in a thread it is its own card in the transcript, with the command it
 * runs, and it comes up there once the asks ahead of it are answered.
 */
export function ThreadDecisionCard({ conversationId, asks, fallback, stepper, targetNonce, scrollToMessage }: {
  conversationId: string;
  /** The thread's open `cast decide` asks, in the order they are answered. */
  asks: readonly QueueItem[];
  /** The queue's own item, shown when the thread has no authored ask. */
  fallback?: QueueItem | null;
  stepper: DecisionStepper | null;
  targetNonce?: number;
  scrollToMessage?: (messageId: string) => void;
}) {
  const [picked, setPicked] = useState<{ key: string; size?: Size } | null>(null);
  // The rows past the first few, once opened, stay open while the person moves between the thread's asks.
  const [allRows, setAllRows] = useState(false);
  useWatchEffect(() => { setPicked(null); setAllRows(false); }, [conversationId]);
  useWatchEffect(() => { if (picked?.size) setPicked({ key: picked.key }); }, [picked]);
  const pick = useCallback((key: string, size: Size) => setPicked({ key, size }), []);
  const showAllRows = useCallback(() => setAllRows(true), []);
  const runKeys = useInboxStore((s) => asks.filter((a) => !!a.decisionId && !!s.sessionDecisions[a.decisionId]?.run).map((a) => a.key).join("\u0001"));
  const steppable = useMemo(() => { const run = new Set(runKeys.split("\u0001")); return asks.filter((a) => !run.has(a.key)); }, [asks, runKeys]);
  const shown = steppable.find((a) => a.key === picked?.key) ?? asks[0] ?? fallback ?? null;
  if (!shown) return null;
  return (
    <SessionDecisionCard key={shown.key} item={shown} stepper={stepper} asks={steppable.some((a) => a.key === shown.key) ? steppable : undefined} onPick={pick}
      startSize={picked?.key === shown.key ? picked.size : undefined} allRows={allRows} onAllRows={showAllRows} targetNonce={targetNonce} scrollToMessage={scrollToMessage} />
  );
}
