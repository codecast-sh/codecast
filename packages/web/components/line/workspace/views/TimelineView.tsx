"use client";
// One problem's timeline (line-workspace.md LW1 Problems), the way an error
// tracker opens an issue: occurrences, fix attempts, merges, deploys, watches
// and regressions on one axis. The Problems table opens it on the shared `case`
// selection and passes its own order, so j and k walk the rows as listed.
import { useCallback, useMemo } from "react";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { useEventListener } from "../../../../hooks/useEventListener";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { ProblemTimeline } from "./timeline/ProblemTimeline";
import type { LineViewProps } from "./types";
import "./timeline/timeline.css";

export function TimelineView({ model, workspace, selection, select, order }: LineViewProps & { order?: ReadonlyArray<string> }) {
  const ids = useMemo(() => order ?? model.issues.map((i) => i.id), [order, model.issues]);
  const at = selection.case ? ids.indexOf(selection.case) : -1;
  const issue = selection.case ? model.issues.find((i) => i.id === selection.case) ?? null : null;
  const byId = useCallback((id: string | undefined) => (id ? model.issues.find((i) => i.id === id) ?? null : null), [model.issues]);
  const prev = at > 0 ? byId(ids[at - 1]) : null;
  const next = at >= 0 ? byId(ids[at + 1]) : null;
  const open = useCallback((id: string | null) => select({ case: id, run: null }), [select]);
  const active = useTabActive();

  // Esc closes the problem (unless a step is open, which Esc closes first); j and k walk the problems.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !issue || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    if (e.key === "Escape" && !selection.step) { e.preventDefault(); open(null); }
    else if (e.key === "j" && next) { e.preventDefault(); open(next.id); }
    else if (e.key === "k" && prev) { e.preventDefault(); open(prev.id); }
  });

  if (!issue) return <div className="lw-empty" data-line-view="timeline"><b>Not in this process</b><button type="button" className="lw-act" onClick={() => open(null)}>All problems</button></div>;
  const projectId = (workspace.rows.tasks.find((t) => t._id === issue.id) as { project_id?: string | null } | undefined)?.project_id ?? null;
  const project = projectId ? workspace.projects.find((p) => p._id === projectId) ?? null : null;
  return (
    <div className="lwt" data-line-view="timeline">
      <ProblemTimeline
        key={issue.id}
        issue={issue}
        model={model}
        now={workspace.now}
        projectTitle={workspace.project ? null : project?.title ?? null}
        signals={workspace.rows.signals}
        prev={prev}
        next={next}
        open={open}
        select={select}
      />
    </div>
  );
}
