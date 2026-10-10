"use client";
// The Graph view (line-workspace.md LW1): the steps as a graph, Studio's
// drawing. Placeholder: the thin widget drawing until the Graph view's full
// drawing (pan and zoom, essence and all steps, keyboard walk) lands here.
import { LineGraphWidget } from "../../widgets";
import type { LineViewProps } from "./types";

export function GraphView({ model, selection }: LineViewProps) {
  const run = selection.run ? model.runs.find((r) => r.id === selection.run) ?? null : null;
  return (
    <div style={{ padding: "var(--lw-s5)" }} data-line-view="graph">
      <LineGraphWidget model={model} run={run} selectedStep={selection.step} />
    </div>
  );
}
