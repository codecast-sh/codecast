// The vimrc report as the table's rows: every directive of every source, in
// load order, filtered by status and by text. Pure, so the table and its tests
// agree on what a filter shows.

import type { VimConfigReport, VimDirectiveStatus, VimReportCounts } from "../../../lib/code/vim/types";

export interface VimReportRow {
  /** Unique across sources: `<source index>:<line>:<n>`. */
  id: string;
  sourceIndex: number;
  line: number;
  text: string;
  status: VimDirectiveStatus;
  detail: string;
}

export interface VimReportFilter {
  /** Statuses shown; empty shows all. */
  statuses: ReadonlySet<VimDirectiveStatus>;
  /** Case-insensitive, over the directive and what it became. */
  query: string;
  /** Only this source (its index in report.sources); null for all. */
  source: number | null;
}

export const EMPTY_FILTER: VimReportFilter = { statuses: new Set(), query: "", source: null };

export function reportRows(report: Pick<VimConfigReport, "sources">): VimReportRow[] {
  const rows: VimReportRow[] = [];
  report.sources.forEach((src, sourceIndex) => {
    src.directives.forEach((d, n) => rows.push({ id: `${sourceIndex}:${d.line}:${n}`, sourceIndex, line: d.line, text: d.text, status: d.status, detail: d.detail }));
  });
  return rows;
}

/** Counts over what the source and query leave, so each status chip says how
 *  many rows clicking it would show. */
export function countRows(rows: readonly VimReportRow[], filter: Omit<VimReportFilter, "statuses">): VimReportCounts {
  const c: VimReportCounts = { applied: 0, translated: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    if (!matchesScope(r, filter)) continue;
    c[r.status]++;
    c.total++;
  }
  return c;
}

function matchesScope(r: VimReportRow, filter: Omit<VimReportFilter, "statuses">): boolean {
  if (filter.source !== null && r.sourceIndex !== filter.source) return false;
  const q = filter.query.trim().toLowerCase();
  return !q || r.text.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q);
}

export function filterRows(rows: readonly VimReportRow[], filter: VimReportFilter): VimReportRow[] {
  return rows.filter((r) => (filter.statuses.size === 0 || filter.statuses.has(r.status)) && matchesScope(r, filter));
}

/** Toggle one status chip: a lone active chip clicked again shows all. */
export function toggleStatus(statuses: ReadonlySet<VimDirectiveStatus>, status: VimDirectiveStatus): Set<VimDirectiveStatus> {
  const next = new Set(statuses);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return next;
}

/** Lines in a source's text (a trailing newline ends the last line, it does
 *  not start another). */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}
