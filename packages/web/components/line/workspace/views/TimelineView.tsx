"use client";
// The Timeline view (line-workspace.md LW1): each problem's life over time,
// the way an error tracker shows an issue. Without a case selected it lists the
// project's problems (regressed first, then the newest activity) with a
// sparkline each; with one, it opens that problem's timeline: occurrences,
// fix attempts, merges, deploys, watches and regressions on one axis. The case
// is the workspace's shared selection, so a run opened in Replay opens its
// problem here too.
import { useCallback, useMemo, useRef } from "react";
import { problemRowSig, problemState, sortProblems } from "../../../../lib/line/timeline";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { useEventListener } from "../../../../hooks/useEventListener";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { ProblemList, type ProblemRow } from "./timeline/ProblemList";
import { ProblemTimeline } from "./timeline/ProblemTimeline";
import type { LineViewProps } from "./types";
import "./timeline/timeline.css";

export function TimelineView({ model, workspace, selection, select, href }: LineViewProps) {
  // A model rebuild (a push, the clock) makes every issue anew: a row whose
  // signature held keeps its old object, so the memoized list redraws only
  // the problems that moved. The open problem reads the fresh issue.
  const kept = useRef(new Map<string, ProblemRow & { sig: string }>());
  const rows = useMemo<ProblemRow[]>(() => {
    const next = new Map<string, ProblemRow & { sig: string }>();
    const out = model.issues.map((issue) => {
      const state = problemState(issue.history, issue.status);
      const sig = problemRowSig(issue, state);
      const was = kept.current.get(issue.id);
      const row = was?.sig === sig ? was : { issue, state, sig };
      next.set(issue.id, row);
      return row;
    });
    kept.current = next;
    return sortProblems(out);
  }, [model.issues]);
  const at = selection.case ? rows.findIndex((r) => r.issue.id === selection.case) : -1;
  const row = at >= 0 ? { ...rows[at], issue: model.issues.find((i) => i.id === rows[at].issue.id) ?? rows[at].issue } : null;
  const open = useCallback((id: string | null) => select({ case: id, run: null }), [select]);
  const caseHref = useCallback((id: string) => href({ case: id, run: null }), [href]);
  const active = useTabActive();

  // On a problem: Esc goes back to the list (unless a step is open, which Esc closes), j and k walk the problems.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !row || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    if (e.key === "Escape" && !selection.step) { e.preventDefault(); open(null); }
    else if (e.key === "j" && rows[at + 1]) { e.preventDefault(); open(rows[at + 1].issue.id); }
    else if (e.key === "k" && at > 0) { e.preventDefault(); open(rows[at - 1].issue.id); }
  });

  return (
    <div className="lwt" data-line-view="timeline">
      {row ? (
        <ProblemTimeline
          key={row.issue.id}
          issue={row.issue}
          model={model}
          now={workspace.now}
          workspaceRow={workspace.project as { workspace?: string | null; team_id?: string | null } | null}
          prev={rows[at - 1]?.issue ?? null}
          next={rows[at + 1]?.issue ?? null}
          open={open}
        />
      ) : (
        <ProblemList rows={rows} now={workspace.now} open={open} href={caseHref} />
      )}
    </div>
  );
}
