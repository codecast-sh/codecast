"use client";
// The same past cases answered twice (line-workspace.md LW3): what the step
// said, beside what an edited step says. Ported from the chat's replay object:
// a score line on top (how many kept their outcome, how many answers moved,
// which outcomes flipped), rows that kept the same answer folded into one,
// and rows still running marked as running. The rows are data: a Try fills
// them as answers land, an agent's reply carries them in a `line` fence.
import { useMemo, useState } from "react";
import type { StepKind } from "../../../lib/line/lineModel";
import { KindTag, OutcomeTag } from "./parts";

export type Answer = { outcome: string | null; words: string };
export type BeforeAfterRow = {
  id: string;
  caseTitle: string;
  caseRef?: string | null;
  /** Why this case is in the set ("your example", "marked wrong"). */
  note?: string | null;
  before: Answer;
  /** Null while the new answer is still coming. */
  after: Answer | null;
  /** Whether the new answer is the right one, when someone labeled the case. */
  verdict?: "better" | "worse" | null;
};

export type BeforeAfterProps = {
  rows: ReadonlyArray<BeforeAfterRow>;
  label?: string;
  kind?: StepKind;
  title?: string;
  beforeLabel?: string;
  afterLabel?: string;
  /** Rows that kept their answer start folded. */
  foldSame?: boolean;
};

const same = (a: Answer, b: Answer) => (a.outcome ?? "") === (b.outcome ?? "") && a.words.trim() === b.words.trim();

/** The score line: how many kept their outcome, how many moved, which flipped. */
export function beforeAfterScore(rows: ReadonlyArray<BeforeAfterRow>) {
  const done = rows.filter((r) => r.after);
  const kept = done.filter((r) => (r.before.outcome ?? "") === (r.after!.outcome ?? "")).length;
  const moved = done.filter((r) => !same(r.before, r.after!)).length;
  const flips = done.filter((r) => (r.before.outcome ?? "") !== (r.after!.outcome ?? ""));
  const better = done.filter((r) => r.verdict === "better").length;
  const worse = done.filter((r) => r.verdict === "worse").length;
  return { done: done.length, total: rows.length, kept, moved, flips, better, worse };
}

export function BeforeAfterTable({ rows, label, kind = "agent", title, beforeLabel = "It said", afterLabel = "It says now", foldSame = true }: BeforeAfterProps) {
  const [showSame, setShowSame] = useState(!foldSame);
  const score = useMemo(() => beforeAfterScore(rows), [rows]);
  const sameRows = rows.filter((r) => r.after && same(r.before, r.after));
  const shown = showSame ? rows : rows.filter((r) => !r.after || !same(r.before, r.after));
  const running = score.done < score.total;

  return (
    <div className="lw-obj" data-line-widget="before-after">
      <div className="lw-obj-head">
        {label && <KindTag kind={kind}>{label}</KindTag>}
        <span className="lw-obj-title">{title ?? `On ${rows.length} past ${rows.length === 1 ? "case" : "cases"}`}</span>
        <span className="lw-spacer" />
        {running && <span className="lw-obj-meta"><span className="lw-spin" aria-hidden /> {score.done} of {score.total} answered</span>}
      </div>
      <div className="lw-score" aria-live="polite">
        <div><b>{score.kept} of {score.done || score.total}</b>kept their outcome</div>
        <div><b>{score.moved}</b>{score.moved === 1 ? "answer moved" : "answers moved"}</div>
        {(score.better > 0 || score.worse > 0) && (
          <div><b><span className="lw-up">{score.better}</span> / <span className="lw-down">{score.worse}</span></b>better / worse on labeled cases</div>
        )}
        {score.flips.length > 0 && (
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: "var(--lw-fs-base)" }}>{[...new Set(score.flips.map((f) => `${f.before.outcome ?? "none"} → ${f.after!.outcome ?? "none"}`))].join(", ")}</b>
            {score.flips.map((f) => f.caseRef ?? f.caseTitle).join(", ")}
          </div>
        )}
      </div>
      <table className="lw-ba">
        <thead>
          <tr><th style={{ width: "28%" }}>Case</th><th>{beforeLabel}</th><th>{afterLabel}</th></tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const moved = r.after && !same(r.before, r.after);
            return (
              <tr key={r.id} data-pending={r.after ? undefined : ""} data-moved={moved ? r.verdict ?? "" : undefined}>
                <td className="lw-ba-case">{r.caseTitle}<small>{[r.caseRef, r.note].filter(Boolean).join(" · ")}</small></td>
                <td>{r.before.outcome && <div><OutcomeTag outcome={r.before.outcome} /></div>}{r.before.words}</td>
                <td className="lw-ba-after">
                  {!r.after ? <span><span className="lw-spin" aria-hidden /> running</span>
                    : !moved ? <span style={{ color: "var(--lw-ink-3)" }}>Same answer</span>
                    : <>{r.after.outcome && <div><OutcomeTag outcome={r.after.outcome} /></div>}{r.after.words}</>}
                </td>
              </tr>
            );
          })}
          {foldSame && sameRows.length > 0 && (
            <tr className="lw-ba-fold">
              <td colSpan={3}>
                <button type="button" className="lw-link" onClick={() => setShowSame((v) => !v)}>
                  {showSame ? "Fold the unchanged answers" : `${sameRows.length} kept the same answer, show them`}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
