"use client";
// The Find table (line-journeys.md LJ8.5): every finder that filed into the
// drawn process this week, one row each (a product's judges each their own),
// with its findings, how many reached no problem, and how often a
// person marked it wrong. A finder's figures are its own, over every process:
// one finder reads one set of numbers on every process's table. A row opens
// the finder's page, which reads the same rows through useFinders, so a number
// clicked is the number the page lists.
import { useMemo, type ReactNode } from "react";
import { graphKeyOf, type GraphRun } from "../../../../../lib/line/lineGraphs";
import { buildSources, findWindow, findWindowWords, findingAt, findingProcess, findingsOf, finderRows, flatSources, homeJudges, wrongRateWords, type FindingMark, type SourceFinder, type SourceSignal } from "../../../../../lib/line/sourcesView";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import type { LineViewProps } from "../types";
import "./finder.css";

export type FinderSignal = SourceSignal & { short_id?: string; moment?: string; subject?: string; case_of?: string; user_id?: string };

// Every mark: a mark on a run never matches a finding's id, so the rows read only the marks on findings.
const markSig = (m: FindingMark) => `${m.run_id}|${m.verdict}`;

/** Every finder in view (lib/line/sourcesView) with its findings in every process, the marks people put on them, and
 *  the table's rows: the finders that filed into the drawn process (`everyProcess`: any), each counted whole. */
export function useFinders(workspace: LineViewProps["workspace"], opts: { everyProcess?: boolean } = {}) {
  const { rows: scoped, project, projects, now, process } = workspace;
  const graphKey = opts.everyProcess ? null : workspace.graphKey;
  const runs = scoped.runs as unknown as GraphRun[];
  const signals = scoped.signals as unknown as FinderSignal[];
  const finders = useMemo<SourceFinder[]>(
    () => (project ? [project] : projects).flatMap((p) => (p.line_profile?.finders ?? []).map((f) => ({ ...f, projectId: p._id, projectTitle: p.title }))),
    [project, projects],
  );
  const graphNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs) if (r.workflow_name) m.set(graphKeyOf(r), r.workflow_name);
    return m;
  }, [runs]);
  const marks = useCollectionRows<FindingMark>("lineLabels", { sig: markSig });
  // One window for every count a finder shows, here and on its page: the week, or what the floor holds of it.
  const window = useMemo(() => findWindow(now, workspace.heldFrom), [now, workspace.heldFrom]);
  // Under a picked project, this line's own judges are still its finders (homeJudges), counted in the project.
  const everySignals = (workspace.everySignals ?? scoped.signals) as unknown as FinderSignal[];
  const line = workspace.graphKey;
  const { sources, keep, elsewhere } = useMemo(() => {
    const own = buildSources({ signals, finders, runs, now, graphNames });
    if (!project) return { sources: own, keep: new Set<string>(), elsewhere: new Map<string, number>() };
    const allFinders = projects.flatMap((p) => (p.line_profile?.finders ?? []).map((f) => ({ ...f, projectId: p._id, projectTitle: p.title })));
    const every = buildSources({ signals: everySignals, finders: allFinders, runs, now, graphNames });
    const home = homeJudges(own, every, everySignals, window.from, line);
    // What each finder found in the window over every project: a finder empty here says where its findings are.
    const counts = new Map(flatSources(every).map((r) => [r.key, findingsOf(everySignals, r).filter((s) => findingAt(s) >= window.from).length]));
    return { ...home, elsewhere: counts };
  }, [signals, everySignals, finders, project, projects, runs, now, graphNames, window.from, line]);
  // Listed here when it filed into this process (a finding counts in the process its problem belongs to, one with no
  // problem yet by its project: processIndex), and every judge of this line's product; its figures stay its whole.
  const rows = useMemo(
    () => finderRows(sources, signals, marks, window.from, graphKey ? (f) => findingProcess(process, f) === graphKey : undefined, graphKey, keep),
    [sources, signals, marks, window.from, process, graphKey, keep],
  );
  return { sources, signals, finders, marks, rows, window, elsewhere, windowWords: findWindowWords(window, now) };
}

export function FindTable({ workspace, select, href, heading }: Pick<LineViewProps, "workspace" | "select" | "href"> & { heading?: ReactNode }) {
  const { rows, window, windowWords } = useFinders(workspace);
  if (!rows.length) return null;
  const open = (key: string) => select({ view: "line", source: key, step: null, finding: null });
  return (
    <section className="ft" aria-label="Finders" data-line-find-table={rows.length}>
      {heading}
      <table className="ft-table">
        <thead>
          <tr><th scope="col">Finder</th><th scope="col" className="ft-n" title={window.cut ? `The line holds findings from ${new Date(window.from).toLocaleString()}` : undefined}>Findings {windowWords}</th><th scope="col" className="ft-n">Not filed</th><th scope="col" className="ft-n">Marked wrong</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rate = wrongRateWords(r);
            return (
              <tr key={r.row.key} onClick={(e) => { if (!(e.target as Element).closest("a")) open(r.row.key); }} data-line-finder={r.row.key}>
                <th scope="row">
                  <a className="ft-name" href={href({ view: "line", source: r.row.key, step: null, finding: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); open(r.row.key); }}>{r.name}</a>
                  {r.filesHere && <span className="ft-here" title="Another product's judge: it files problems on this line">files here</span>}
                </th>
                <td className="ft-n lw-num">{r.week}</td>
                {/* Not filed opens the finder on those findings, the newest open, each with its way to a problem. */}
                <td className="ft-n lw-num" data-zero={!r.unfiled ? "" : undefined} data-line-finder-unfiled={r.unfiled || undefined}>
                  {r.firstUnfiled ? <a className="ft-cell" href={href({ view: "line", source: r.row.key, step: null, finding: r.firstUnfiled })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "line", source: r.row.key, step: null, finding: r.firstUnfiled }); }}>{r.unfiled}</a> : r.unfiled}
                </td>
                <td className="ft-n lw-num" data-zero={!r.wrong ? "" : undefined}>{r.wrong ? rate : 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
