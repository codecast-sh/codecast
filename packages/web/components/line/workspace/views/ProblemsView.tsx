"use client";
// Problems (line-workspace.md LW1): every problem on the process in view, one
// row each: its ref, title, findings, runs and where it stands. A problem
// (`case` in the URL) opens its timeline (TimelineView), the way an error
// tracker opens an issue.
import { ageShort } from "../../../../lib/lineFlow";
import { TimelineView } from "./TimelineView";
import type { LineViewProps } from "./types";

export function ProblemsView(props: LineViewProps) {
  const { model, workspace, selection, select } = props;
  if (selection.case) return <TimelineView {...props} />;
  const issues = [...model.issues].sort((a, b) => b.lastRunAt - a.lastRunAt);
  if (!issues.length) return <div className="lw-empty" data-line-problems="empty"><b>No problems</b>Nothing has reached this process.</div>;
  return (
    <div className="lw-list-wrap" data-line-problems={issues.length}>
      <table className="lw-list">
        <thead><tr><th>Ref</th><th>Problem</th><th className="lw-r">Findings</th><th className="lw-r">Runs</th><th>Where</th><th className="lw-r">Last run</th></tr></thead>
        <tbody>
          {issues.map((i) => (
            <tr key={i.id} onClick={() => select({ case: i.id, run: null })} data-line-problem={i.ref ?? i.id}>
              <td className="lw-mono">{i.ref ?? ""}</td>
              <td className="lw-list-text">{i.title}</td>
              <td className="lw-r lw-num">{i.findings}</td>
              <td className="lw-r lw-num">{i.runs.length}</td>
              <td data-tone={i.where.tone}>{i.where.text}</td>
              <td className="lw-r lw-num">{i.lastRunAt ? ageShort(workspace.now - i.lastRunAt) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
