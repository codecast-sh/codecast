"use client";
// The six stages of a problem's newest run as dots, and beside them the one
// line that states where the problem stands (line-journeys.md LJ6.4). The line
// is the only statement of state on the page: nothing else repeats it. A
// reached stage is a button to the run at that stage's last step.
import type { Stage } from "../../../lib/line/stageTrack";
import "./stageTrack.css";

export type StageTrackProps = {
  stages: ReadonlyArray<Stage>;
  /** The state, said once; null when the host says it in its own facts (a closed problem's band). */
  line: { text: string; tone: "you" | "bad" | "warn" | "live" | "ok" | "none" } | null;
  /** Open the run at a stage's last step; without it the dots are marks only. */
  onStage?: (step: string) => void;
};

const MARK_WORDS = { done: "done", current: "now", failed: "failed", none: "not reached" } as const;

export function StageTrack({ stages, line, onStage }: StageTrackProps) {
  // No run has reached any stage: the dots would say nothing, the line says it all.
  const reached = stages.some((s) => s.mark !== "none");
  if (!reached && !line) return null;
  return (
    <div className="st" data-line-stage-track>
      {reached && <ol className="st-dots">
        {stages.map((s) => {
          const body = <><i className="st-dot" aria-hidden />{s.label}</>;
          return (
            <li key={s.key} className="st-stage" data-mark={s.mark} data-stage={s.key}>
              {s.step && onStage
                ? <button type="button" onClick={() => onStage(s.step!)} title={`${s.label}: ${MARK_WORDS[s.mark]}. Open the run at this step`}>{body}</button>
                : <span title={`${s.label}: ${MARK_WORDS[s.mark]}`}>{body}</span>}
            </li>
          );
        })}
      </ol>}
      {line && <span className="st-line" data-tone={line.tone} data-line-state>{line.text}</span>}
    </div>
  );
}
