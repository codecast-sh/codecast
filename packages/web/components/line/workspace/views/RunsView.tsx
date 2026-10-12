"use client";
// Runs (line-workspace.md LW1): every run of the process in view, one row a
// problem, newest first: its attempts as a strip of dots colored by how each
// ended, and the newest one's status, the step it stopped at and why (a red
// chip). A problem tried more than once opens to its attempts. j and k move,
// Enter opens the newest, o opens the attempts; a run (`run` in the URL) opens
// its detail, the Replay (ReplayView): the run played step by step.
import { Fragment, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { ageShort } from "../../../../lib/lineFlow";
import { runEndTone, runEndWords, runStop } from "../../../../lib/line/replay";
import { lineVisitOutput, visitOutputWords } from "../../../../lib/line/visitOutput";
import { failCause, type FailCause } from "../../../../lib/line/runReport";
import { sourceChipWords } from "../../../../lib/line/stepRuns";
import { dayWords, durationWords, NavLink } from "../../widgets";
import { ReplayView } from "./ReplayView";
import { TrialWait, useWaitingTrialCards } from "./trialCards";
import type { LineViewProps } from "./types";

export function RunsView(props: LineViewProps) {
  if (props.selection.run) return <ReplayView {...props} />;
  return <RunList {...props} />;
}

type Run = LineViewProps["model"]["runs"][number];
/** One problem's runs, newest last: the list's row, its attempts the strip of dots and, opened, its rows. */
type RunGroup = { key: string; runs: Run[]; newest: Run };

function RunList({ model, workspace, select, href, drawerOpen }: LineViewProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const active = useTabActive();
  const sources = workspace.sources;
  const trialWaits = useWaitingTrialCards();
  const projectOf = useMemo(() => {
    const titles = new Map(workspace.projects.map((p) => [p._id, p.title]));
    return new Map(workspace.rows.tasks.map((t) => [t._id, (t as { project_id?: string | null }).project_id ? titles.get((t as { project_id: string }).project_id) ?? "" : ""]));
  }, [workspace.projects, workspace.rows.tasks]);
  const rawById = useMemo(() => new Map(workspace.rows.runs.map((r) => [r._id, r])), [workspace.rows.runs]);
  const runs = model.runs;
  // The same problem tried again is the pattern to see: one row a problem, newest problem first, its attempts oldest first.
  const groups = useMemo<RunGroup[]>(() => {
    const by = new Map<string, Run[]>();
    for (const r of runs) {
      const k = r.caseId ?? `run:${r.id}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by].map(([key, list]) => {
      const sorted = [...list].sort((a, b) => a.at - b.at);
      return { key, runs: sorted, newest: sorted[sorted.length - 1] };
    }).sort((a, b) => b.newest.at - a.newest.at);
  }, [runs]);
  /** Why a run ended, short (failCause), for a run that failed or stuck. */
  const reasonOf = (r: Run): FailCause | null => {
    const end = runEndWords(r);
    const raw = rawById.get(r.id);
    return (end === "failed" || end === "stuck") && raw ? failCause(raw as unknown as Parameters<typeof failCause>[0]) : null;
  };
  const toggle = (k: string) => setOpened((was) => { const next = new Set(was); if (!next.delete(k)) next.add(k); return next; });
  const at = cursor ? groups.findIndex((g) => g.key === cursor) : -1;
  const open = (id: string, caseId: string | null) => select({ run: id }, caseId);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || drawerOpen || !groups.length || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    const move = (to: number) => {
      const g = groups[Math.max(0, Math.min(groups.length - 1, to))];
      e.preventDefault();
      setCursor(g.key);
      document.querySelector(`[data-line-run-group="${g.key}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "j" || e.key === "ArrowDown") move(at + 1);
    else if (e.key === "k" || e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Enter" && at >= 0) { e.preventDefault(); open(groups[at].newest.id, groups[at].newest.caseId); }
    else if ((e.key === "o" || e.key === "ArrowRight" || e.key === "ArrowLeft") && at >= 0 && groups[at].runs.length > 1) { e.preventDefault(); toggle(groups[at].key); }
  });

  if (!runs.length) return <div className="lw-empty" data-line-runs="empty"><b>No runs</b>Nothing has run on this process yet.</div>;
  const showProject = !workspace.project;

  /** How a run ended and where: its status, the step, and why (a red chip) when it failed. */
  const endCells = (r: Run) => {
    const end = runEndWords(r);
    const trial = trialWaits.get(r.id);
    const stop = runStop(model, r);
    const why = reasonOf(r);
    const said = stop.visit ? visitOutputWords(lineVisitOutput(stop.visit, r)) : null;
    return (
      <>
        <td title={trial || r.verdict ? undefined : r.outcome.text}>{trial ? <TrialWait card={trial} onOpen={(card) => select({ view: "inbox", card })} /> : <span className="lw-oc" data-tone={runEndTone(end)}>{end}</span>}</td>
        <td className="lw-list-dim lw-atstep" title={why?.raw ?? said ?? undefined}>
          {stop.label && <span className="lw-atstep-in">
            <span className="lw-atstep-step">{stop.label}</span>
            {why && <span className="lw-why" data-tone="bad">{why.label}</span>}
            {why?.check?.preExisting && <span className="lw-why" data-tone="warn" title={why.check.files.join(", ")}>pre-existing</span>}
          </span>}
        </td>
      </>
    );
  };

  return (
    <div className="lw-list-wrap" data-line-runs={runs.length} data-line-run-groups={groups.length}>
      <table className="lw-list lw-runs">
        <thead>
          <tr>
            <th>Problem</th><th>Title</th><th>Source</th>{showProject && <th>Project</th>}<th>Attempts</th><th>Status</th><th>At step</th>
            <th className="lw-r">Steps</th><th className="lw-r">Took</th><th className="lw-r">Started</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const r = g.newest;
            const src = r.caseId ? sources.get(r.caseId) : undefined;
            const runHref = href({ run: r.id, view: "runs" }, r.caseId);
            const many = g.runs.length > 1;
            const isOpen = many && opened.has(g.key);
            return (
              <Fragment key={g.key}>
                <tr onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) open(r.id, r.caseId); }} onMouseEnter={() => setCursor(g.key)} data-cursor={g.key === cursor ? "" : undefined} aria-selected={g.key === cursor} data-line-run={r.id} data-line-run-group={g.key}>
                  <td className="lw-mono">
                    {many
                      ? <button type="button" className="lw-run-caret" aria-expanded={isOpen} aria-label={isOpen ? "Hide attempts" : "Show attempts"} onClick={(e) => { e.stopPropagation(); toggle(g.key); }}><ChevronRight aria-hidden /></button>
                      : <span className="lw-run-caret" aria-hidden />}
                    {r.caseRef ?? ""}
                  </td>
                  <td className="lw-list-text">
                    <NavLink className="lw-rowlink" href={runHref} onOpen={() => {}} title={r.caseTitle}>{r.caseTitle}</NavLink>
                  </td>
                  <td>{src ? <span className="lw-srcchip">{sourceChipWords(src)}</span> : null}</td>
                  {showProject && <td className="lw-list-dim">{r.caseId ? projectOf.get(r.caseId) ?? "" : ""}</td>}
                  <td>
                    <span className="lw-attempts" aria-label={`${g.runs.length} attempts`}>
                      {g.runs.map((x, i) => {
                        const end = runEndWords(x);
                        return <button key={x.id} type="button" className="lw-attempt-dot" data-tone={runEndTone(end)} title={`#${i + 1} ${end}${reasonOf(x) ? `: ${reasonOf(x)!.label}` : ""}`} onClick={(e) => { e.stopPropagation(); open(x.id, x.caseId); }} data-line-attempt={`${i + 1}`} />;
                      })}
                      {many && <span className="lw-num lw-attempt-n">{g.runs.length}</span>}
                    </span>
                  </td>
                  {endCells(r)}
                  <td className="lw-r lw-num">{r.visits.length}</td>
                  <td className="lw-r lw-num">{r.durationMs != null ? durationWords(r.durationMs) : ""}</td>
                  <td className="lw-r lw-num">{ageShort(workspace.now - r.at)}</td>
                </tr>
                {isOpen && [...g.runs].reverse().map((x) => (
                  <tr key={x.id} className="lw-run-attempt" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) open(x.id, x.caseId); }} data-line-run={x.id}>
                    <td className="lw-mono lw-list-dim"><span className="lw-run-caret" aria-hidden />#{g.runs.indexOf(x) + 1}</td>
                    <td className="lw-list-dim">{dayWords(x.at)}</td>
                    <td />
                    {showProject && <td />}
                    <td />
                    {endCells(x)}
                    <td className="lw-r lw-num">{x.visits.length}</td>
                    <td className="lw-r lw-num">{x.durationMs != null ? durationWords(x.durationMs) : ""}</td>
                    <td className="lw-r lw-num">{ageShort(workspace.now - x.at)}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
