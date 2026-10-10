"use client";
// The Replay view (line-workspace.md LW1): a real case played through the
// line, a step at a time, with a scrubber. Placeholder: the selected run's
// path, else the newest runs, until Replay's scrubber and timeline land here.
import { RunPath } from "../../widgets";
import type { LineViewProps } from "./types";

export function ReplayView({ model, selection }: LineViewProps) {
  const picked = selection.run ? model.runs.find((r) => r.id === selection.run) : null;
  const runs = picked ? [picked] : model.runs.slice(0, 12);
  if (!runs.length) return <div className="lw-empty"><b>No runs yet</b>A run of this line shows here once one starts.</div>;
  return (
    <div style={{ padding: "var(--lw-s5)", maxWidth: 980, margin: "0 auto" }} data-line-view="replay">
      {runs.map((r) => <RunPath key={r.id} run={r} framed selectedStep={selection.step} />)}
    </div>
  );
}
