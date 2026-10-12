"use client";
// Process (line-workspace.md LW1): the process itself, in two modes over one
// model. Graph draws the steps and how work moves between them; Notebook reads
// them as one document, a step at a time. The mode lives in the URL (`mode`).
import { GraphView } from "./GraphView";
import { NotebookView } from "./NotebookView";
import type { LineViewProps } from "./types";

export function ProcessView(props: LineViewProps) {
  return props.selection.mode === "notebook" ? <NotebookView {...props} /> : <GraphView {...props} />;
}
