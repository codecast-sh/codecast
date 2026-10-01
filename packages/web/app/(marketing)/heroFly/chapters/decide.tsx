"use client";

/**
 * Chapter 6, Decide: the lead's `cast decide` as the queue's compact card on
 * the desk, every option with its cost and risk. Picking one (the film's tap,
 * or the visitor's click) records the answer, shown the way the app shows an
 * answered decision (DecisionRecordedAnswer).
 */

import { useState } from "react";
import { DecisionCompactCardView } from "@/components/decisions/DecisionCompactCard";
import { DecisionRecordedAnswer } from "@/components/decisions/DecisionAnswerControls";
import type { DecisionAnswerInput } from "@/store/inboxStore";
import { ANSWER, ASKED_AGO, ASKING, DECISION } from "../fixtures/decide";
import { fly, useFilmTime } from "../filmClock";
import { Veil } from "../film";
import { DECIDE_AT } from "./decide.motion";
import type { PartProps } from "./contract";

const noop = () => {};

/** The card answered: the compact card in its answered state, with the recorded answer under it as the app shows one. */
function Answered({ decision, now, flyIds }: { decision: typeof DECISION; now: number; flyIds: boolean }) {
  return (
    <>
      <DecisionCompactCardView decision={decision} session={ASKING} now={now} onAnswer={noop} onDismiss={noop} onJumpToAsk={noop} />
      <div className="px-4 pb-3 pt-2">
        <div {...(flyIds ? fly("desk/decide.answer") : {})} className="origin-left">
          <DecisionRecordedAnswer decision={decision} />
        </div>
      </div>
    </>
  );
}

function DecisionAsk({ now }: PartProps) {
  const [picked, setPicked] = useState<number | null>(null);
  // From the tap the answered card fades in over the pending one, which stays whole under it: no frame goes without the options or the answer.
  const filmAnswered = useFilmTime((t) => t >= DECIDE_AT.tap);
  const pending = { ...DECISION, created_at: now - ASKED_AGO };
  const answeredWith = (i: number) => ({ ...pending, status: "answered" as const, answer_index: i });
  const onAnswer = (input: DecisionAnswerInput) => {
    if ("index" in input && input.index !== undefined) setPicked(input.index);
  };
  const card = "rounded-lg bg-sol-bg shadow-[0_24px_50px_-18px_rgba(0,43,54,0.45)]";
  // A visitor's own pick lands at once, the way the app records it.
  if (picked !== null) {
    return (
      <div {...fly("desk/decide.card")} className={`relative m-2 ${card}`}>
        <Answered decision={answeredWith(picked)} now={now} flyIds={false} />
      </div>
    );
  }
  return (
    <div {...fly("desk/decide.card")} data-hero-live="" className="relative m-2 grid">
      {/* The pending card fades from under the answered one, which takes only its own height. */}
      <div {...fly("desk/decide.pending")} className={`col-start-1 row-start-1 ${card}`} inert={filmAnswered || undefined}>
        <DecisionCompactCardView decision={pending} session={ASKING} now={now} onAnswer={onAnswer} onDismiss={noop} onJumpToAsk={noop} />
      </div>
      {filmAnswered && (
        <div {...fly("desk/decide.answered")} className={`col-start-1 row-start-1 self-start ${card}`}>
          <Answered decision={answeredWith(ANSWER)} now={now} flyIds />
        </div>
      )}
      {/* The tap, on the first option's number badge (measured in the pending layout). */}
      <span
        {...fly("desk/decide.tap", { left: 38, top: 186, margin: "-24px 0 0 -24px" })}
        aria-hidden
        className="pointer-events-none absolute h-12 w-12 rounded-full border-2 border-sol-yellow bg-sol-yellow/20"
      />
    </div>
  );
}

/** The conversation steps back under the card while the decision is open, as the pair's veil does. */
export function DecideVeil(_: PartProps) {
  return <Veil id="desk/decide.veil" />;
}

/** The decision card on the desk's side, from the ask until it clears. A new ask (the next loop) starts fresh. */
export function DecisionCard({ now }: PartProps) {
  const shown = useFilmTime((t) => t >= DECIDE_AT.asked && t < DECIDE_AT.gone);
  return shown ? <DecisionAsk now={now} /> : null;
}
