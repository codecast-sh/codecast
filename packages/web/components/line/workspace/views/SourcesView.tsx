"use client";
// Sources (line-workspace.md LW1): where problems come from. Each source that
// filed findings in view (Sentry, PostHog, an eval, AgentWatch, a person),
// with how many it filed this week and its newest. Selecting a source
// (`source` in the URL) lists its findings; a finding opens its problem.
import { useMemo } from "react";
import { ageShort } from "../../../../lib/lineFlow";
import { knownName } from "../../../../lib/line/sourceNames";
import type { LineViewProps } from "./types";

const WEEK = 7 * 86_400_000;

export function SourcesView({ workspace, selection, select }: LineViewProps) {
  const { rows, now } = workspace;
  const sources = useMemo(() => {
    const by = new Map<string, { source: string; week: number; total: number; newest: (typeof rows.signals)[number] | null }>();
    for (const s of rows.signals) {
      const row = by.get(s.source) ?? { source: s.source, week: 0, total: 0, newest: null };
      row.total++;
      if (s.created_at >= now - WEEK) row.week++;
      if (!row.newest || s.created_at > row.newest.created_at) row.newest = s;
      by.set(s.source, row);
    }
    return [...by.values()].sort((a, b) => b.week - a.week || b.total - a.total);
  }, [rows.signals, now]);
  const findings = useMemo(() => (selection.source ? rows.signals.filter((s) => s.source === selection.source).sort((a, b) => b.created_at - a.created_at) : []), [rows.signals, selection.source]);

  if (!sources.length) return <div className="lw-empty" data-line-sources="empty"><b>No findings yet</b>Nothing has reported here.</div>;
  return (
    <div className="lw-list-wrap" data-line-sources={sources.length}>
      <table className="lw-list">
        <thead><tr><th>Source</th><th className="lw-r">7d</th><th className="lw-r">All</th><th>Newest</th><th className="lw-r">Seen</th></tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.source} aria-selected={selection.source === s.source} onClick={() => select({ source: selection.source === s.source ? null : s.source })} data-line-source={s.source}>
              <td>{knownName(s.source) ?? s.source}</td>
              <td className="lw-r lw-num">{s.week}</td>
              <td className="lw-r lw-num">{s.total}</td>
              <td className="lw-list-text">{s.newest?.title ?? ""}</td>
              <td className="lw-r lw-num">{s.newest ? ageShort(now - s.newest.created_at) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selection.source && (
        <table className="lw-list" data-line-findings={findings.length}>
          <thead><tr><th>Finding</th><th>Problem</th><th className="lw-r">Seen</th></tr></thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f._id} aria-selected={selection.finding === f._id} onClick={() => select({ view: "problems", case: f.task_id, run: null })} data-line-finding={f._id}>
                <td className="lw-list-text">{f.title}</td>
                <td className="lw-mono">{f.task_id}</td>
                <td className="lw-r lw-num">{ageShort(now - f.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
