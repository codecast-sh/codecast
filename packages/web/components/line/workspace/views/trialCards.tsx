"use client";
// Trial cards in the line app: a trial run (a project with line_trial set)
// pauses at its gates without asking anyone, and each gate is a card
// (hooks/useSyncTrial, fed by useLineWorkspace). The Inbox lists the waiting
// ones; the runs list and a run's detail name the card a paused run waits on.
// A card opens in the Inbox's card panel (TrialCardPanel), inside the app.
import { useMemo } from "react";
import Link from "next/link";
import { useTrialCards, type TrialCardRow } from "../../../../hooks/useSyncTrial";
import { useInboxStore } from "../../../../store/inboxStore";
import { trialCardWaits } from "../../../../lib/line/lineInbox";
import "./trialCards.css";

/** Where one trial card opens: the Inbox with the card beside it. */
export const trialCardHref = (ref: string) => `/line?view=inbox&card=${encodeURIComponent(ref)}`;

/** The trial decisions' statuses as the viewer's own decision rows hold them ("id:status,..."), the rows an answer lands on first. */
const liveSig = (rows: Record<string, { _id: string; status: string; trial?: boolean }> | undefined) => {
  let out = "";
  for (const d of Object.values(rows ?? {})) if (d.trial) out += `${d._id}:${d.status},`;
  return out;
};

/** Each trial decision's status as its own row says it, when the store holds that row: an answer given a moment ago. */
export function useLiveTrialDecisionStatus(): ReadonlyMap<string, string> {
  const sig = useInboxStore((s) => liveSig(s.sessionDecisions as unknown as Record<string, { _id: string; status: string; trial?: boolean }>));
  return useMemo(() => new Map(sig.split(",").filter(Boolean).map((x) => x.split(":") as [string, string])), [sig]);
}

/** The waiting trial card each paused run sits on, by run id (lib/line/lineInbox trialCardWaits, the Inbox's reading). */
export function useWaitingTrialCards(): Map<string, TrialCardRow> {
  const cards = useTrialCards();
  const live = useLiveTrialDecisionStatus();
  return useMemo(() => {
    const out = new Map<string, TrialCardRow>();
    // Newest first, so a run that paused twice names the gate it sits at now.
    for (const c of cards) if (!out.has(c.run_id) && trialCardWaits(c, c.decision ? live.get(c.decision._id) : null)) out.set(c.run_id, c);
    return out;
  }, [cards, live]);
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
