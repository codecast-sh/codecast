"use client";
// The Notebook view (line-workspace.md LW1): the line as one calm document, a
// step at a time. Placeholder: each step's card in reading order until the
// Notebook's own typography and flow land here.
import { StepCard } from "../../widgets";
import type { LineViewProps } from "./types";

export function NotebookView({ model }: LineViewProps) {
  return (
    <div style={{ padding: "var(--lw-s5)", maxWidth: 820, margin: "0 auto", display: "grid", gap: "var(--lw-s4)" }} data-line-view="notebook">
      {model.order.map((id) => <StepCard key={id} model={model} stepId={id} recent={3} />)}
    </div>
  );
}
