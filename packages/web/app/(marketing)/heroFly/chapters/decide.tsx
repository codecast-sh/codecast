"use client";

/**
 * Chapter 6, Decide: the lead's `cast decide` as the queue's compact card on
 * the desk, every option with its cost and risk. Picking one (the film's tap,
 * or the visitor's click) records the answer on the card.
 */

import { useState } from "react";
import { DecisionCompactCardView } from "@/components/decisions/DecisionCompactCard";
import { DecisionOptionList } from "@/components/decisions/DecisionOptionList";
import type { DecisionAnswerInput } from "@/store/inboxStore";
import { ANSWER, ASKED_AGO, ASKING, DECISION } from "../fixtures/decide";
import { fly, useFilmTime } from "../filmClock";
import { DECIDE_AT } from "./decide.motion";
import type { PartProps } from "./contract";

const noop = () => {};

function DecisionAsk({ now }: PartProps) {
  const [picked, setPicked] = useState<number | null>(null);
  const filmAnswered = useFilmTime((t) => t >= DECIDE_AT.answered);
  const answer = picked ?? (filmAnswered ? ANSWER : null);
  const decision =
    answer === null
      ? { ...DECISION, created_at: now - ASKED_AGO }
      : { ...DECISION, created_at: now - ASKED_AGO, status: "answered" as const, answer_index: answer };
  const onAnswer = (input: DecisionAnswerInput) => {
    if ("index" in input && input.index !== undefined) setPicked(input.index);
  };
  return (
    <div {...fly("desk/decide.card")} data-hero-live="" className="relative m-2 rounded-lg bg-sol-bg shadow-[0_24px_50px_-18px_rgba(0,43,54,0.45)]">
      <DecisionCompactCardView decision={decision} session={ASKING} now={now} onAnswer={onAnswer} onDismiss={noop} onJumpToAsk={noop} />
      {answer !== null && (
        <div {...fly("desk/decide.answer")} className="px-4 pb-3 pt-2">
          <DecisionOptionList options={DECISION.options} compact tone={(n) => (n === answer ? "picked" : "plain")} />
        </div>
      )}
      <span
        {...fly("desk/decide.tap", { left: 40, top: 0, margin: "-24px 0 0 -24px" })}
        aria-hidden
        className="pointer-events-none absolute h-12 w-12 rounded-full border-2 border-sol-yellow bg-sol-yellow/20"
      />
    </div>
  );
}

/** The decision card on the desk's side, from the ask until it clears. A new ask (the next loop) starts fresh. */
export function DecisionCard({ now }: PartProps) {
  const shown = useFilmTime((t) => t >= DECIDE_AT.asked && t < DECIDE_AT.gone);
  return shown ? <DecisionAsk now={now} /> : null;
}
