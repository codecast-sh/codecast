"use client";
// Trial cards in the line app: a trial run (a project with line_trial set)
// pauses at its gates without asking anyone, and each gate is a card
// (hooks/useSyncTrial, fed by useLineWorkspace). The Inbox lists the waiting
// ones; the runs list and a run's detail name the card a paused run waits on.
// A card opens in the Inbox's card panel (TrialCardPanel), inside the app.
import { useMemo } from "react";
import Link from "next/link";
import { useTrialCards, type TrialCardRow } from "../../../../hooks/useSyncTrial";
import "./trialCards.css";

/** Where one trial card opens: the Inbox with the card beside it. */
export const trialCardHref = (ref: string) => `/line?card=${encodeURIComponent(ref)}`;

/** The waiting trial card each paused run sits on, by run id. */
export function useWaitingTrialCards(): Map<string, TrialCardRow> {
  const cards = useTrialCards();
  return useMemo(() => {
    const out = new Map<string, TrialCardRow>();
    // Newest first, so a run that paused twice names the gate it sits at now.
    for (const c of cards) if (c.status === "waiting" && !out.has(c.run_id)) out.set(c.run_id, c);
    return out;
  }, [cards]);
}

/** "Waiting on tc-N": the card a run waits on, as a link to it. `long` names it a trial card (a run's detail). */
export function TrialWait({ card, long, onOpen, settled }: { card: TrialCardRow; long?: boolean; onOpen?: (ref: string) => void; settled?: boolean }) {
  // A card answered, or one whose run has ended, waits on nobody: its ref, gray.
  const done = settled || !!card.answer;
  return (
    <Link className="lw-oc lwt-wait" data-tone={done ? "none" : "person"} href={trialCardHref(card.short_id)} onClick={(e) => {
      e.stopPropagation();
      // Inside the app the card opens in place, keeping the process and the project.
      if (onOpen && !e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); onOpen(card.short_id); }
    }} title={card.card?.headline || card.question} data-line-trial-wait={card.short_id}>
      {done ? (card.answer ? `${card.answer.label.replace(/^\[[^\]]*\]\s*/, "")} on ` : "") : long ? "Waiting on trial card " : "Waiting on "}<b>{card.short_id}</b>
    </Link>
  );
}
