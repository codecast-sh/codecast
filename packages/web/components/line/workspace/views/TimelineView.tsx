"use client";
// The Timeline view (line-workspace.md LW1): each problem's life over time,
// occurrences beside every fix attempt, ship, deploy, watch and regression
// (lineModel LineIssue.history). Placeholder: the problems, newest activity
// first, until the Timeline's histogram and attempt lanes land here.
import { outcomeToneClass } from "../../RunReport";
import type { LineViewProps } from "./types";

export function TimelineView({ model, select }: LineViewProps) {
  if (!model.issues.length) return <div className="lw-empty"><b>No problems yet</b>Each problem this line works shows here with its history.</div>;
  return (
    <div style={{ padding: "var(--lw-s5)", maxWidth: 980, margin: "0 auto" }} data-line-view="timeline">
      <div className="lw-obj">
        <div className="lw-drows" style={{ border: 0, borderRadius: 0 }}>
          {model.issues.map((i) => (
            <button key={i.id} type="button" className="lw-drow" onClick={() => select({ case: i.id })} data-line-issue={i.id}>
              <span className="lw-drow-m">{i.ref ?? ""}</span>
              <span className="lw-drow-t">{i.title}</span>
              <span className={`lw-drow-m ${outcomeToneClass(i.where.tone)}`}>{i.history.regressed ? "regressed" : `${i.history.attempts.length} ${i.history.attempts.length === 1 ? "attempt" : "attempts"}`}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
