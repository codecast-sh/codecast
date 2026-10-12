"use client";
// Trial cards in the line app: a trial run (a project with line_trial set)
// pauses at its gates without asking anyone, and each gate is a card
// (hooks/useSyncTrial, fed by useLineWorkspace). The Inbox lists the waiting
// ones; the runs list and a run's detail name the card a paused run waits on.
// A card opens on /trial, which draws it with the queue's own components.
import { useMemo } from "react";
import Link from "next/link";
import { useTrialCards, type TrialCardRow } from "../../../../hooks/useSyncTrial";
import "./trialCards.css";

/** Where one trial card opens. */
export const trialCardHref = (ref: string) => `/trial?card=${encodeURIComponent(ref)}`;

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
export function TrialWait({ card, long }: { card: TrialCardRow; long?: boolean }) {
  return (
    <Link className="lw-oc lwt-wait" data-tone="person" href={trialCardHref(card.short_id)} onClick={(e) => e.stopPropagation()} title={card.card?.headline || card.question} data-line-trial-wait={card.short_id}>
      {long ? "Waiting on trial card " : "Waiting on "}<b>{card.short_id}</b>
    </Link>
  );
}
