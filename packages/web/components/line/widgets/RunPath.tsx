"use client";
// A run as the path it took (line-workspace.md LW3): every visit in order,
// numbered, colored by who did the step, failed and waiting visits marked,
// and a step reached again shown as the loop it is. Compact, it is Studio's
// thin trail of bars for a list row; framed, it carries the run's case and
// how it ended, the chat's run object.
import { Fragment, memo } from "react";
import type { LineRunModel } from "../../../lib/line/lineModel";
import { outcomeToneClass } from "../RunReport";
import { NavLink, dayWords, durationWords, useLineNav } from "./parts";

export type RunPathProps = {
  run: LineRunModel;
  /** The step the workspace has selected: its visits are marked. */
  selectedStep?: string | null;
  compact?: boolean;
  framed?: boolean;
  /** What a click on a visit does; by default it opens the step. */
  onVisit?: (stepId: string, index: number) => void;
};

/** Studio's trail: one bar per visit, for a run in a list. */
export const RunTrail = memo(function RunTrail({ run }: { run: LineRunModel }) {
  return (
    <span className="lw-trail" aria-label={`${run.visits.length} steps`}>
      {run.visits.map((v) => <i key={v.index} data-kind={v.kind} data-status={v.status} />)}
    </span>
  );
});

export const RunPath = memo(function RunPath({ run, selectedStep, compact, framed, onVisit }: RunPathProps) {
  const nav = useLineNav();
  if (compact) return <RunTrail run={run} />;
  const seen = new Set<string>();
  const path = (
    <div className="lw-path" data-line-widget="run-path">
      {run.visits.map((v, i) => {
        const again = seen.has(v.node);
        seen.add(v.node);
        return (
          <Fragment key={v.index}>
            {i > 0 && (again ? <span className="lw-visit-loop">back to</span> : <span className="lw-visit-arrow" aria-hidden>→</span>)}
            <button
              type="button"
              className="lw-visit"
              data-kind={v.kind}
              data-status={v.status}
              data-inferred={v.inferred ? "" : undefined}
              aria-current={selectedStep === v.node ? "step" : undefined}
              title={[v.decided.words, durationWords(v.durationMs)].filter(Boolean).join(" · ")}
              onClick={() => (onVisit ? onVisit(v.node, i) : nav.openStep(v.node))}
            >
              <span className="lw-visit-n">{i + 1}</span>
              {v.label}
            </button>
          </Fragment>
        );
      })}
      {run.live && <span className="lw-visit-arrow" aria-label="running"><span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)", display: "inline-block" }} /></span>}
    </div>
  );
  if (!framed) return path;
  return (
    <div className="lw-obj" data-line-widget="run">
      <div className="lw-obj-head">
        <span className="lw-obj-title">{run.caseTitle}</span>
        {run.caseRef && <span className="lw-obj-meta">{run.caseRef}</span>}
        <span className="lw-spacer" />
        <span className="lw-obj-meta">{[dayWords(run.at), durationWords(run.durationMs)].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="lw-obj-body">
        <p className={outcomeToneClass(run.outcome.tone)} style={{ margin: "0 0 10px", fontSize: "var(--lw-fs-md)" }}>{run.outcome.text}</p>
        {path}
      </div>
      <div className="lw-obj-foot">
        <NavLink className="lw-act" href={nav.runHref(run.id, run.caseId)} onOpen={() => nav.openRun(run.id, run.caseId)}>Replay this run</NavLink>
      </div>
    </div>
  );
});
