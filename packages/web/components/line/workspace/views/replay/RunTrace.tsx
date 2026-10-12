"use client";
// A run's steps in the order it visited them (line-workspace.md LW1), like a
// debugger's trace: number, kind, step, what it produced (visitOutput), how
// long, what it decided. One row is selected; ↑ ↓ (and j k) move it.
import { Fragment, memo, useLayoutEffect, useRef } from "react";
import { outcomeLabel, type TraceStep } from "../../../../../lib/line/runTrace";
import { durationWords, outcomeTone } from "../../../widgets";
import { VisitOutputView } from "../../../widgets/VisitOutput";
import { isAnswerKey } from "../../../../../lib/line/visitOutput";

const KIND = { agent: "agent", script: "script", person: "person", end: "end" } as const;

export const RunTrace = memo(function RunTrace({ steps, cur, wrong, drafted, onPick }: {
  steps: ReadonlyArray<TraceStep>;
  cur: number;
  wrong: ReadonlySet<string>;
  drafted: ReadonlySet<string>;
  onPick: (i: number) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [cur]);
  return (
    <ol className="rd-trace" ref={list} role="listbox" aria-label="Steps of this run">
      {steps.map((s) => {
        // The outcome word carries its own color (a build that built is not red); the cap is marked apart.
        const base = s.inferred || s.unanswered ? "none" : s.outcome && !isAnswerKey(s.outcome) ? outcomeTone(s.outcome) : outcomeTone(s.status === "failed" ? "failed" : null, s.status);
        // What it said outranks a bare exit: a step that passed but reported errors, or a reviewer that asked for changes, is amber.
        const said = s.produced?.kind === "text" ? s.produced.tone : undefined;
        const tone = said && base !== "bad" ? "warn" : base;
        return (
          <Fragment key={s.i}>
          <li
            data-i={s.i}
            role="option"
            aria-selected={s.i === cur}
            className="rd-row"
            data-kind={KIND[s.kind]}
            data-status={s.status}
            data-inferred={s.inferred ? "" : undefined}
            onClick={() => onPick(s.i)}
            data-run-step={s.node}
          >
            <span className="rd-n">{s.n}</span>
            <span className="rd-glyph" aria-hidden />
            <span className="rd-row-main">
              <span className="rd-row-label">
                {s.label}
                {wrong.has(s.node) && <span className="rd-mark" data-verdict="wrong" title="Marked wrong">✕</span>}
                {drafted.has(s.node) && <span className="rd-mark" data-verdict="edit" title="Prompt edited, not saved">●</span>}
                {s.rounds != null && <span className="rd-rounds" title={`Ran ${s.rounds} times; the run keeps only the newest`}>×{s.rounds}</span>}
                {s.capped && <span className="rd-cap" title="This step hit its visit cap and stopped the run">visit cap</span>}
              </span>
              <span className="rd-row-gist" data-tone={said}>{s.inferred ? "earlier round" : <VisitOutputView out={s.produced} />}</span>
            </span>
            <span className="rd-took">{s.status === "live" ? "" : durationWords(s.tookMs) ?? ""}</span>
            <span className="rd-oc" data-tone={tone}>
              {s.status === "live" && <span className="lw-spin" aria-hidden />}
              {outcomeLabel(s)}
            </span>
          </li>
          {s.owed && <li className="rd-owed" role="presentation" data-run-evals-owed={s.owed.select}><span className="rd-owed-ring" aria-hidden /><span><b>Evals owed</b> {s.owed.select}, {s.owed.files} {s.owed.files === 1 ? "file" : "files"}, not run</span></li>}
          </Fragment>
        );
      })}
    </ol>
  );
});
