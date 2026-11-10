"use client";
// A run's steps in the order it took them (line-journeys.md LJ8.4): one
// button a step, with a mark for how it went (done, failed, waiting, running,
// skipped), its name, what it produced in one line and how long it took. The
// selected one is the page's right side. Up and Down move while focus is in
// the list; nothing here takes a key from anywhere else on the page.
import { memo, useLayoutEffect, useRef } from "react";
import type { TraceStep } from "../../../../../lib/line/runTrace";
import { spanShort, type StepMark } from "../../../../../lib/line/runPage";

export type TraceRow = { step: TraceStep; mark: StepMark };

/** What a step produced, in one line of words: its own text or a person's choice. Raw result fields stay on the step. */
const gist = (s: TraceStep): string | null => (s.inferred || !s.produced ? null : s.produced.kind === "text" ? s.produced.text : s.produced.kind === "choice" ? [s.produced.choice, s.produced.note].filter(Boolean).join(": ") : null);

const MARK_WORDS: Record<StepMark, string> = { done: "done", failed: "failed", waiting: "waiting on a person", live: "running", skipped: "no record" };

export const RunTrace = memo(function RunTrace({ rows, cur, onPick }: { rows: ReadonlyArray<TraceRow>; cur: number; onPick: (i: number, cursor?: boolean) => void }) {
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [cur]);
  const move = (to: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, to));
    onPick(i, true);
    list.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus();
  };
  return (
    <ol className="rp-trace" ref={list} aria-label="Steps of this run" data-run-trace={rows.length}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "ArrowDown") { e.preventDefault(); move(cur + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); move(cur - 1); }
        else if (e.key === "Home") { e.preventDefault(); move(0); }
        else if (e.key === "End") { e.preventDefault(); move(rows.length - 1); }
      }}>
      {rows.map(({ step: s, mark }) => (
        <li key={s.i}>
          <button type="button" className="rp-row" data-i={s.i} aria-current={s.i === cur ? "step" : undefined} tabIndex={s.i === cur ? 0 : -1} data-mark={mark} data-kind={s.kind} onClick={() => onPick(s.i)} data-run-step={s.node}>
            <span className="rp-mark" data-mark={mark} role="img" aria-label={s.notRun ? "did not run" : MARK_WORDS[mark]} />
            <span className="rp-row-main">
              <span className="rp-row-label">{s.label}{s.rounds != null && <span className="rp-rounds">{s.rounds} tries</span>}</span>
              {gist(s) && <span className="rp-row-gist">{gist(s)}</span>}
            </span>
            <span className="rp-took">{mark === "live" ? <span className="lw-spin" aria-hidden /> : spanShort(s.tookMs) ?? ""}</span>
          </button>
        </li>
      ))}
    </ol>
  );
});
