// PR · CI · Review · Merge and where the change stands in words: one drawing for a Ship run's card and an open pull
// request's card on the Deploys page, and for the shipping strip on the pull request's own page, so the two places
// never say it differently (lib/deploys/board: stepper and runState for a run, prStepper and prState for a PR).
import type { ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { STEPS, type RunState, type StepState } from "../../lib/deploys/board";
import "./deploys.css";

export function ShipTrack({ steps, state, word }: {
  steps: StepState[];
  state: RunState;
  /** The state's words as something to act on (the decision it waits on); plain words otherwise. */
  word?: ReactNode;
}) {
  return (
    <div className="dpp-track">
      <ol className="dpp-stepper" aria-label={state.word}>
        {STEPS.map((s, i) => (
          <li key={s.word} className="dpp-step" data-state={steps[i]}>
            <i aria-hidden>{steps[i] === "done" ? <Check strokeWidth={3} /> : steps[i] === "failed" ? <X strokeWidth={3} /> : steps[i] === "active" ? <Loader2 className="animate-spin" /> : null}</i>{s.word}
          </li>
        ))}
      </ol>
      <span className="dpp-run-now" data-tone={state.tone} data-deploy-run-state>{word ?? state.word}</span>
      {state.detail ? <span className="dpp-run-detail">{state.detail}</span> : null}
    </div>
  );
}
