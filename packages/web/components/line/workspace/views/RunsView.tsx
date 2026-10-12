"use client";
// Runs (line-workspace.md LW1): every run of the process in view, newest
// first: the problem it worked, where it came from, how it ended, the step it
// stopped at with what that step produced, how long, how many steps. j and k move, Enter opens; a run (`run`
// in the URL) opens its detail, the Replay (ReplayView): the run played step
// by step like a debugger.
import { useMemo, useState } from "react";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { ageShort } from "../../../../lib/lineFlow";
import { runEndTone, runEndWords, runStop } from "../../../../lib/line/replay";
import { lineVisitOutput } from "../../../../lib/line/visitOutput";
import { sourceChipWords } from "../../../../lib/line/stepRuns";
import { durationWords, NavLink } from "../../widgets";
import { VisitOutputView } from "../../widgets/VisitOutput";
import { ReplayView } from "./ReplayView";
import { TrialWait, useWaitingTrialCards } from "./trialCards";
import type { LineViewProps } from "./types";

export function RunsView(props: LineViewProps) {
  if (props.selection.run) return <ReplayView {...props} />;
  return <RunList {...props} />;
}

function RunList({ model, workspace, select, href, drawerOpen }: LineViewProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const active = useTabActive();
  const sources = workspace.sources;
  const trialWaits = useWaitingTrialCards();
  const projectOf = useMemo(() => {
    const titles = new Map(workspace.projects.map((p) => [p._id, p.title]));
    return new Map(workspace.rows.tasks.map((t) => [t._id, (t as { project_id?: string | null }).project_id ? titles.get((t as { project_id: string }).project_id) ?? "" : ""]));
  }, [workspace.projects, workspace.rows.tasks]);
  const runs = model.runs;
  // A problem worked more than once: each run's attempt, oldest first, so its rows tell apart.
  const attempt = useMemo(() => {
    const byCase = new Map<string, typeof runs>();
    for (const r of runs) if (r.caseId) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
    const out = new Map<string, { n: number; of: number }>();
    for (const list of byCase.values()) [...list].sort((a, b) => a.at - b.at).forEach((r, i) => out.set(r.id, { n: i + 1, of: list.length }));
    return out;
  }, [runs]);
  const at = cursor ? runs.findIndex((r) => r.id === cursor) : -1;
  const open = (id: string, caseId: string | null) => select({ run: id }, caseId);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || drawerOpen || !runs.length || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    const move = (to: number) => {
      const r = runs[Math.max(0, Math.min(runs.length - 1, to))];
      e.preventDefault();
      setCursor(r.id);
      document.querySelector(`[data-line-run="${r.id}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "j" || e.key === "ArrowDown") move(at + 1);
    else if (e.key === "k" || e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Enter" && at >= 0) { e.preventDefault(); open(runs[at].id, runs[at].caseId); }
  });

  if (!runs.length) return <div className="lw-empty" data-line-runs="empty"><b>No runs</b>Nothing has run on this process yet.</div>;
  const showProject = !workspace.project;
  return (
    <div className="lw-list-wrap" data-line-runs={runs.length}>
      <table className="lw-list lw-runs">
        <thead>
          <tr>
            <th>Problem</th><th>Title</th><th>Source</th>{showProject && <th>Project</th>}<th>Status</th><th>At step</th>
            <th className="lw-r">Steps</th><th className="lw-r">Took</th><th className="lw-r">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const end = runEndWords(r);
            const src = r.caseId ? sources.get(r.caseId) : undefined;
            const stop = runStop(model, r);
            const try_ = attempt.get(r.id);
            const runHref = href({ run: r.id, view: "runs" }, r.caseId);
            const trial = trialWaits.get(r.id);
            return (
              <tr key={r.id} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) open(r.id, r.caseId); }} onMouseEnter={() => setCursor(r.id)} data-cursor={r.id === cursor ? "" : undefined} aria-selected={r.id === cursor} data-line-run={r.id}>
                <td className="lw-mono">{r.caseRef ?? ""}{try_ && try_.of > 1 && <span className="lw-attempt" title={`Run ${try_.n} of ${try_.of} on this problem`}>#{try_.n}</span>}</td>
                <td className="lw-list-text">
                  <NavLink className="lw-rowlink" href={runHref} onOpen={() => {}} title={r.caseTitle}>{r.caseTitle}</NavLink>
                </td>
                <td>{src ? <span className="lw-srcchip">{sourceChipWords(src)}</span> : null}</td>
                {showProject && <td className="lw-list-dim">{r.caseId ? projectOf.get(r.caseId) ?? "" : ""}</td>}
                <td title={trial || r.verdict ? undefined : r.outcome.text}>{trial ? <TrialWait card={trial} /> : <span className="lw-oc" data-tone={runEndTone(end)}>{end}</span>}</td>
                <td className="lw-list-dim lw-atstep">
                  {stop.label && <span className="lw-atstep-in"><span className="lw-atstep-step">{stop.label}</span><VisitOutputView out={stop.visit ? lineVisitOutput(stop.visit, r) : null} /></span>}
                </td>
                <td className="lw-r lw-num">{r.visits.length}</td>
                <td className="lw-r lw-num">{r.durationMs != null ? durationWords(r.durationMs) : ""}</td>
                <td className="lw-r lw-num">{ageShort(workspace.now - r.at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
