// A change's steps and where it stands in words: one drawing for a Ship run's card and an open pull request's card on
// the Deploys page, and for the shipping strip on the pull request's own page, so the two places never say it
// differently (lib/deploys/board: stepper and runState for a run, prStepper and prState for a PR). The step set is the
// change's own track: a run's from stepsFor (PR · CI · Review · Merge, or Check · Review · Land), a pull request no run
// carries CHANGE_STEPS.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { RunState, Step, StepState } from "../../lib/deploys/board";
import "./deploys.css";

export function ShipTrack({ track, steps, state, word }: {
  /** The steps drawn, in order. */
  track: readonly Step[];
  /** Each step's state, as `track` orders them. */
  steps: StepState[];
  state: RunState;
  /** The state's words as something to act on (the decision it waits on); plain words otherwise. */
  word?: ReactNode;
}) {
  return (
    <div className="dpp-track">
      <ol className="dpp-stepper" aria-label={state.word}>
        {track.map((s, i) => (
          <li key={s.word} className="dpp-step" data-state={steps[i]}>
            <i aria-hidden>{steps[i] === "done" ? <Check strokeWidth={3} /> : steps[i] === "failed" ? <X strokeWidth={3} /> : steps[i] === "active" ? <Loader2 className="animate-spin" /> : null}</i>{s.word}
          </li>
        ))}
      </ol>
      <span className="dpp-run-now" data-tone={state.tone} data-deploy-run-state>{word ?? state.word}</span>
      {state.detail ? <Detail text={state.detail} /> : null}
    </div>
  );
}

/** Where a stopped change stands, in its own words: folded to three lines until the reader asks for the rest (a stopped
 *  run's reason can be a whole review). Measured, not guessed: a short one shows whole with no toggle. */
function Detail({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <span className="dpp-run-detail" data-deploy-run-detail>
      <span ref={ref} className="dpp-run-detail-text" data-clamped={open ? undefined : ""}>{text}</span>
      {overflows || open ? <button type="button" className="dpp-run-detail-more" aria-expanded={open} onClick={() => setOpen(!open)} data-deploy-run-detail-more>{open ? "Show less" : "Show all"}</button> : null}
    </span>
  );
}
