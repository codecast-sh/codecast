"use client";
// A run's steps in the order it visited them (line-workspace.md LW1), like a
// debugger's trace: number, kind, step, what it produced (visitOutput), how
// long, what it decided. One row is selected; ↑ ↓ (and j k) move it.
import { memo, useLayoutEffect, useRef } from "react";
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
        const tone = s.inferred ? "none" : s.outcome && !isAnswerKey(s.outcome) ? outcomeTone(s.outcome) : outcomeTone(s.status === "failed" ? "failed" : null, s.status);
        return (
          <li
            key={s.i}
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
              <span className="rd-row-gist">{s.inferred ? "earlier round" : <VisitOutputView out={s.produced} />}</span>
            </span>
            <span className="rd-took">{s.status === "live" ? "" : durationWords(s.tookMs) ?? ""}</span>
            <span className="rd-oc" data-tone={tone}>
              {s.status === "live" && <span className="lw-spin" aria-hidden />}
              {outcomeLabel(s)}
            </span>
          </li>
        );
      })}
    </ol>
  );
});
