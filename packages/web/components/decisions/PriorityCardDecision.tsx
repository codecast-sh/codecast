"use client";
// A decision row that carries a priority change card (pl-1131), drawn as the
// card. The ticks live in the decision's draft, so they survive the card
// unmounting (the peek closing, the stepper moving on) and clear on answer;
// the answer is the store's answerDecision, the same action every decision
// surface answers through. Settled, the card reads its record off the row.
import { useCallback } from "react";
import type { PriorityCard } from "@codecast/shared/contracts/priorityCard";
import type { DecisionAnswerInput, SessionDecisionItem } from "../../store/inboxStore";
import { useDecisionDraft } from "../../hooks/useDecisionDraft";
import { firstLine, priorityCardAnswerInput, priorityCardAnswered } from "../../lib/priorityCardDecision";
import { PriorityChangeCard, type PriorityCardAnswer } from "./PriorityChangeCard";

export function PriorityCardDecision({ decision, card, onAnswer }: {
  decision: SessionDecisionItem;
  card: PriorityCard;
  /** The surface's answer path (adopt the row, then answerDecision). */
  onAnswer: (input: DecisionAnswerInput) => void;
}) {
  const [draft, patchDraft] = useDecisionDraft<{ ticked: string[] }>(decision._id);
  const ticked = draft.ticked ?? card.suggested;
  const answer = useCallback((a: PriorityCardAnswer) => onAnswer(priorityCardAnswerInput(card, a)), [card, onAnswer]);
  return (
    <PriorityChangeCard
      card={card}
      ticked={ticked}
      onToggle={(next) => patchDraft({ ticked: next })}
      answered={priorityCardAnswered(decision)}
      onAnswer={answer}
      question={decision.question || undefined}
      context={firstLine(decision.context_md)}
    />
  );
}
