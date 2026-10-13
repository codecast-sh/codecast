"use client";
// The Find table (line-journeys.md LJ8.5): every finder that filed into the
// drawn process this week, one row each (a product's judges each their own),
// with its findings, how many reached no problem, and how often a
// person marked it wrong. A row opens the finder's page. The Line page mounts
// it under its Steps table; the finder page reads the same rows through
// useFinders, so a number clicked is the number the page lists.
import { useCallback, useMemo, type ReactNode } from "react";
import { graphKeyOf, type GraphRun } from "../../../../../lib/line/lineGraphs";
import { buildSources, filedSources, findingProcess, finderRows, sourceIn, wrongRateWords, type FindingMark, type SourceFinder, type SourceRow, type SourceSignal } from "../../../../../lib/line/sourcesView";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import type { LineViewProps } from "../types";
import "./finder.css";

export type FinderSignal = SourceSignal & { short_id?: string; moment?: string; subject?: string; case_of?: string; user_id?: string };

// Every mark: a mark on a run never matches a finding's id, so the rows read only the marks on findings.
const markSig = (m: FindingMark) => `${m.run_id}|${m.verdict}`;

/** Every finder in view (lib/line/sourcesView), its findings scoped to the drawn process, and the marks people put on them. */
export function useFinders(workspace: LineViewProps["workspace"], opts: { everyProcess?: boolean } = {}) {
  const { rows: scoped, project, projects, now, process } = workspace;
  // A finder named outright (its own page, reached from another process) reads over every process.
  const graphKey = opts.everyProcess ? null : workspace.graphKey;
  const runs = scoped.runs as unknown as GraphRun[];
  // A finding counts in a process when its problem belongs there, one with no problem yet by its project (processIndex).
  const signals = useMemo(() => {
    const all = scoped.signals as unknown as FinderSignal[];
    return graphKey ? all.filter((f) => findingProcess(process, f) === graphKey) : all;
  }, [scoped.signals, process, graphKey]);
  const finders = useMemo<SourceFinder[]>(
    () => (project ? [project] : projects).filter((p) => !graphKey || process.project(p._id) === graphKey).flatMap((p) => (p.line_profile?.finders ?? []).map((f) => ({ ...f, projectId: p._id, projectTitle: p.title }))),
    [project, projects, process, graphKey],
  );
  const graphNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs) if (r.workflow_name) m.set(graphKeyOf(r), r.workflow_name);
    return m;
  }, [runs]);
  const sources = useMemo(() => buildSources({ signals, finders, runs, now, graphNames }), [signals, finders, runs, now, graphNames]);
  const filed = useMemo(() => filedSources(signals, now), [signals, now]);
  const hasFiled = useCallback((r: Pick<SourceRow, "source">) => [...filed].some((src) => sourceIn(r, src)), [filed]);
  const marks = useCollectionRows<FindingMark>("lineLabels", { sig: markSig });
  const rows = useMemo(() => finderRows(sources.filter(hasFiled), signals, marks, now), [sources, hasFiled, signals, marks, now]);
  return { sources, signals, finders, marks, rows };
}

export function FindTable({ workspace, select, href, heading }: Pick<LineViewProps, "workspace" | "select" | "href"> & { heading?: ReactNode }) {
  const { rows } = useFinders(workspace);
  if (!rows.length) return null;
  const open = (key: string) => select({ view: "line", source: key, step: null, finding: null });
  return (
    <section className="ft" aria-label="Finders" data-line-find-table={rows.length}>
      {heading}
      <table className="ft-table">
        <thead>
          <tr><th scope="col">Finder</th><th scope="col" className="ft-n">Findings 7d</th><th scope="col" className="ft-n">Not filed</th><th scope="col" className="ft-n">Marked wrong</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rate = wrongRateWords(r);
            return (
              <tr key={r.row.key} onClick={(e) => { if (!(e.target as Element).closest("a")) open(r.row.key); }} data-line-finder={r.row.key}>
                <th scope="row">
                  <a className="ft-name" href={href({ view: "line", source: r.row.key, step: null, finding: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); open(r.row.key); }}>{r.name}</a>
                </th>
                <td className="ft-n lw-num">{r.week}</td>
                <td className="ft-n lw-num" data-zero={!r.unfiled ? "" : undefined}>{r.unfiled}</td>
                <td className="ft-n lw-num" data-zero={!r.wrong ? "" : undefined}>{r.wrong ? rate : 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
