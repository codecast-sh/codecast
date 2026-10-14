"use client";
// One problem as a card (line-workspace.md LW1 Timeline, LW5), the `problem`
// widget: where it stands, its life on a compact timeline (occurrences, every
// attempt colored by how it ended, each close marked, what came back after it
// shaded), and what was already tried. A chat answer about a case and the
// card for a new attempt show it, so the earlier attempts sit beside the new one.
import { useCallback } from "react";
import type { LineIssue, LineModel } from "../../../lib/line/lineModel";
import { problemLine, problemState, PROBLEM_STATE_WORDS } from "../../../lib/line/timeline";
import { TimelineChart, TimeRangeSeg, useTimelineDomain, type TimelinePick } from "../workspace/views/timeline/TimelineChart";
import { AlreadyTried } from "./AlreadyTried";
import { NavLink, useLineNav } from "./parts";
import "../workspace/views/timeline/timeline.css";

export function ProblemCard({ model, issue, now, exceptRunId, title }: {
  model: LineModel;
  issue: LineIssue;
  now: number;
  /** The attempt the surface is about (an attempt's card): left out of what was tried. */
  exceptRunId?: string;
  title?: string | null;
}) {
  const nav = useLineNav();
  const h = issue.history;
  const state = problemState(h, issue.status);
  const labelOf = useCallback((id: string) => model.steps[id]?.label, [model.steps]);
  const { range, pickRange, domain, onZoom, onReset } = useTimelineDomain(h, now);
  const onPick = useCallback((p: TimelinePick) => {
    if (p.kind === "attempt") nav.openRun(p.runId, issue.id);
    else nav.openCase?.(issue.id);
  }, [nav, issue.id]);
  const caseHref = nav.caseHref?.(issue.id) ?? null;

  return (
    <div className="lw-obj lwt-vars lwt-card-w" data-line-widget="problem" data-line-problem={issue.id} data-state={state}>
      <div className="lw-obj-head">
        <span className="lwt-state" data-state={state}>{PROBLEM_STATE_WORDS[state]}</span>
        {issue.ref && <span className="lwt-ref">{issue.ref}</span>}
        <span className="lw-obj-title">{title ?? issue.title}</span>
        <span className="lw-spacer" />
        <TimeRangeSeg range={range} pick={pickRange} />
      </div>
      <p className="lwt-card-line">{problemLine(issue, labelOf)}</p>
      <TimelineChart history={h} labelOf={labelOf} domain={domain} now={now} selectedRun={exceptRunId ?? null} pick={null} onPick={onPick} onZoom={onZoom} onReset={onReset} />
      <div className="lwt-card-tried">
        <div className="lw-lbl">Already tried</div>
        <AlreadyTried h={h} exceptRunId={exceptRunId} bare />
        {!h.attempts.some((a) => !a.live && a.runId !== exceptRunId) && <p className="lwt-quiet">No earlier attempt on this problem.</p>}
      </div>
      {(caseHref || nav.openCase) && (
        <div className="lw-obj-foot"><NavLink className="lw-act" href={caseHref} onOpen={() => nav.openCase?.(issue.id)}>Open its timeline</NavLink></div>
      )}
    </div>
  );
}
