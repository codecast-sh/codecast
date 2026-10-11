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
import { graphPlaceTitle } from "../../../../lib/line/lineGraphs";
import { problemJudges } from "../../../../lib/line/loopSteps";
import { requestReplayAt } from "../stepDrafts";
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
  const labelOf = useCallback((id: string) => model.steps[id]?.label, [model.steps]);
  const runIds = useMemo(() => new Set(model.runs.map((r) => r.id)), [model.runs]);
  const hasRun = useCallback((id: string) => runIds.has(id), [runIds]);
  // A problem that came back after a step let it go: open that run at that step in Replay, the mark box open.
  // No step in the selection, so the drawer stays shut and the box is in view.
  const markable = useCallback((id: string) => model.steps[id]?.kind === "agent" || model.steps[id]?.kind === "person", [model.steps]);
  const openDecision = useCallback((issueId: string, d: { runId: string; step: string; markable: boolean }) => {
    requestReplayAt(d.runId, d.step, d.markable);
    select({ view: "replay", run: d.runId, step: null }, issueId);
  }, [select]);

  // On a problem: Esc goes back to the list (unless a step is open, which Esc closes), j and k walk the problems.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !row || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    if (e.key === "Escape" && !selection.step) { e.preventDefault(); open(null); }
    else if (e.key === "j" && rows[at + 1]) { e.preventDefault(); open(rows[at + 1].issue.id); }
    else if (e.key === "k" && at > 0) { e.preventDefault(); open(rows[at - 1].issue.id); }
  });

  // The header's "N waiting", split by fix line, so the list's counts add up to it.
  const queue = useMemo(() => {
    const r = workspace.rollup;
    return r ? { total: r.causes, routes: r.graphs.map((g) => ({ title: graphPlaceTitle(g.key, workspace.product), waiting: g.waiting })), neverRun: r.neverRun } : undefined;
  }, [workspace.rollup, workspace.product]);
  // The problems the line will not start: the rollup's one split of the waiting problems (lineFlow waitingReadiness), the same the header and the start switch count.
  const notReadyKey = workspace.rollup?.notReadyIds.join(",") ?? "";
  const notReady = useMemo(() => new Set(notReadyKey ? notReadyKey.split(",") : []), [notReadyKey]);
  // The project's other fix lines, where the not-ready problems this graph never worked are listed.
  const otherGraphs = useMemo(
    () => model.graphs.filter((g) => g.key !== model.graphKey).map((g) => ({ title: graphPlaceTitle(g.key, workspace.product), open: () => select({ graph: g.key }) })),
    [model.graphs, model.graphKey, workspace.product, select],
  );

  const judgesOf = useMemo(() => problemJudges(workspace.loop), [workspace.loop]);

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
        <ProblemList rows={rows} now={workspace.now} open={open} href={caseHref} labelOf={labelOf} graphTitle={graphPlaceTitle(model.graphKey, workspace.product)} hasRun={hasRun} markable={markable} openDecision={openDecision} queue={queue} notReady={notReady} otherGraphs={otherGraphs} judgesOf={judgesOf} />
      )}
    </div>
  );
}
