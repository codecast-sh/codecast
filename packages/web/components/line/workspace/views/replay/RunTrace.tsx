"use client";
// A run's steps in the order it visited them (line-workspace.md LW1), like a
// debugger's trace: number, kind, step, what it concluded, how long, what it
// decided. One row is selected; ↑ ↓ (and j k) move it.
import { memo, useLayoutEffect, useRef } from "react";
import { outcomeLabel, type TraceStep } from "../../../../../lib/line/runTrace";
import { durationWords, outcomeTone } from "../../../widgets";

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
        const tone = s.inferred ? "none" : outcomeTone(s.outcome ?? (s.status === "failed" ? "failed" : null), s.status);
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
              </span>
              <span className="rd-row-gist">{s.inferred ? "earlier round" : s.gist ?? ""}</span>
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
