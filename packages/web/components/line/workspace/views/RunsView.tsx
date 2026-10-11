"use client";
// Runs (line-workspace.md LW1): every run of the process in view, newest
// first: the problem it worked, how it ended, how long, how many steps. A run
// (`run` in the URL) opens its detail, the Replay (ReplayView): the run played
// step by step like a debugger.
import { ageShort } from "../../../../lib/lineFlow";
import { durationWords } from "../../widgets";
import { ReplayView } from "./ReplayView";
import type { LineViewProps } from "./types";

export function RunsView(props: LineViewProps) {
  const { model, workspace, selection, select } = props;
  if (selection.run) return <ReplayView {...props} />;
  if (!model.runs.length) return <div className="lw-empty" data-line-runs="empty"><b>No runs</b>Nothing has run on this process yet.</div>;
  return (
    <div className="lw-list-wrap" data-line-runs={model.runs.length}>
      <table className="lw-list">
        <thead><tr><th>Problem</th><th>Title</th><th>Ended</th><th className="lw-r">Steps</th><th className="lw-r">Took</th><th className="lw-r">Started</th></tr></thead>
        <tbody>
          {model.runs.map((r) => (
            <tr key={r.id} onClick={() => select({ run: r.id }, r.caseId)} data-line-run={r.id}>
              <td className="lw-mono">{r.caseRef ?? ""}</td>
              <td className="lw-list-text">{r.caseTitle}</td>
              <td data-tone={r.outcome.tone}>{r.live ? "Running" : r.outcome.text}</td>
              <td className="lw-r lw-num">{r.visits.length}</td>
              <td className="lw-r lw-num">{r.durationMs != null ? durationWords(r.durationMs) : ""}</td>
              <td className="lw-r lw-num">{ageShort(workspace.now - r.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
