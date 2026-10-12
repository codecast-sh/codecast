"use client";
// Trial cards in the line app: a trial run (a project with line_trial set)
// pauses at its gates without asking anyone, and each gate is a card
// (hooks/useSyncTrial, fed by useLineWorkspace). The Inbox lists the waiting
// ones; the runs list and a run's detail name what a paused run waits on. A
// card its station posted as a decision is named by the decision (sd-N), the
// one id the Inbox, the Problems list and the decision page use, and opens as
// that decision where the reader is; a card no station posted keeps its own
// ref (tc-N) and opens in the Inbox's card panel (TrialCardPanel).
import { useMemo } from "react";
import Link from "next/link";
import { useTrialCards, type TrialCardRow } from "../../../../hooks/useSyncTrial";
import { useInboxStore } from "../../../../store/inboxStore";
import { reaskWhy, trialCardAnswerable, trialCardWaits } from "../../../../lib/line/lineInbox";
import { wouldLabel } from "../../../../lib/line/fixDecision";
import "./trialCards.css";

/** Where one trial card opens: the Inbox with the card beside it, on its own process when the caller knows it. */
export const trialCardHref = (ref: string, graph?: string | null) => `/line?view=inbox${graph ? `&graph=${encodeURIComponent(graph)}` : ""}&card=${encodeURIComponent(ref)}`;
/** Where a card's decision opens from outside the app: the Inbox with the decision beside it. */
const trialDecisionHref = (ref: string, graph?: string | null) => `/line?view=inbox${graph ? `&graph=${encodeURIComponent(graph)}` : ""}&decision=${encodeURIComponent(ref)}`;

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

/**
 * What a run waits on, as a link to it: "Decide sd-N" for a card its station posted as a decision (opened in place by
 * `onDecide`), "Waiting on tc-N" for one no station posted (opened by `onOpen`), "Re-ask" when no answer can land yet.
 * `long` says it in a run's detail; `graph` is the run's process, carried by the link so it opens on that process.
 */
export function TrialWait({ card, long, onOpen, onDecide, settled, graph }: { card: TrialCardRow; long?: boolean; onOpen?: (ref: string) => void; onDecide?: (ref: string) => void; settled?: boolean; graph?: string | null }) {
  // A card answered, or one whose run has ended, waits on nobody: its ref, gray.
  const done = settled || !!card.answer;
  // A waiting card nobody can answer yet (no session asked it, or its step left the line) waits on a re-ask, never on you.
  const live = useLiveTrialDecisionStatus();
  const reask = !done && !trialCardAnswerable(card, card.decision ? live.get(card.decision._id) : null);
  // One id for one decision: the decision's own wherever the card has one.
  const decision = card.decision ? card.decision.short_id ?? card.decision._id : null;
  const ref = decision ?? card.short_id;
  const open = decision ? onDecide ?? onOpen : onOpen;
  return (
    <Link className="lw-oc lwt-wait" data-tone={done ? "none" : reask ? "warn" : "person"} data-line-trial-reask={reask ? reaskWhy(card) : undefined} href={decision ? trialDecisionHref(decision, graph) : trialCardHref(card.short_id, graph)} onClick={(e) => {
      e.stopPropagation();
      // Inside the app it opens in place, keeping the process and the project.
      if (open && !e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); open(decision && onDecide ? decision : card.short_id); }
    }} title={reask ? `Cannot take an answer (${reaskWhy(card)}): its run has to be asked again\n${card.card?.headline || card.question}` : card.card?.headline || card.question} data-line-trial-wait={card.short_id} data-line-trial-decision={decision ?? undefined}>
      {done ? (card.answer ? `${wouldLabel(card.answer.label)} on ` : "") : reask ? "Re-ask " : decision ? (long ? "Waiting on your decision " : "Decide ") : long ? "Waiting on trial card " : "Waiting on "}<b>{ref}</b>
    </Link>
  );
}
