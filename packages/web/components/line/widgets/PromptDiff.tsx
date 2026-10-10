"use client";
// Two versions of a step's prompt, line by line (line-workspace.md LW3): what
// was added on green, what went on red and struck through, the unchanged
// stretches folded to a row that opens them. The chat's diff object, in the
// workspace's look.
import { Fragment, useMemo, useState } from "react";
import { diffGapRows, promptDiff, type DiffRow } from "../../../lib/line/promptText";
import { KindTag } from "./parts";
import type { StepKind } from "../../../lib/line/lineModel";

export type PromptDiffProps = {
  before: string;
  after: string;
  /** The step's name and kind for the head; omitted, the diff draws bare (inside another widget). */
  label?: string;
  kind?: StepKind;
  file?: string | null;
  /** "v3 → v4", "now → your edit". */
  versions?: string | null;
  context?: number;
};

function Row({ row }: { row: Exclude<DiffRow, { op: "gap" }> }) {
  return (
    <div className="lw-diff-ln" data-op={row.op}>
      <span>{row.op === "add" ? "+" : row.op === "del" ? "−" : ""}</span>
      <span>{row.text || " "}</span>
    </div>
  );
}

/** The diff's lines alone, for a widget that draws its own frame. */
export function PromptDiffLines({ before, after, context = 2 }: { before: string; after: string; context?: number }) {
  const d = useMemo(() => promptDiff(before, after, context), [before, after, context]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  if (d.added + d.removed === 0) return <p className="lw-obj-body" style={{ margin: 0, color: "var(--lw-ink-3)" }}>The two texts are the same.</p>;
  return (
    <div className="lw-diff" data-line-diff>
      {d.rows.map((r, i) => {
        if (r.op !== "gap") return <Row key={i} row={r} />;
        if (opened.has(r.from)) return <Fragment key={i}>{diffGapRows(before, after, r.from, r.count).map((x, j) => x.op !== "gap" && <Row key={j} row={x} />)}</Fragment>;
        return (
          <button key={i} type="button" className="lw-diff-gap" onClick={() => setOpened((s) => new Set(s).add(r.from))}>
            {r.count} unchanged {r.count === 1 ? "line" : "lines"}
          </button>
        );
      })}
    </div>
  );
}

export function PromptDiff({ before, after, label, kind = "agent", file, versions, context }: PromptDiffProps) {
  const d = useMemo(() => promptDiff(before, after, context), [before, after, context]);
  if (!label) return <PromptDiffLines before={before} after={after} context={context} />;
  return (
    <div className="lw-obj" data-line-widget="diff">
      <div className="lw-obj-head">
        <KindTag kind={kind}>{label}</KindTag>
        {file && <span className="lw-obj-title lw-file">{file.split("/").pop()}</span>}
        {versions && <span className="lw-ver">{versions}</span>}
        <span className="lw-spacer" />
        <span className="lw-stat-add">+{d.added}</span>
        <span className="lw-stat-del">−{d.removed}</span>
      </div>
      <PromptDiffLines before={before} after={after} context={context} />
    </div>
  );
}
