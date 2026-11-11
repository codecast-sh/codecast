// The rows behind a number, all of them: virtualized so ten thousand rows
// scroll like ten, searchable, sortable by any column, and narrowed to the
// rows the number used (or the rows under a clicked chart point) with one
// switch. Numbers show exactly as the source sent them.
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";

const ROW_H = 30;

const exact = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 20 }) : v === null || v === undefined ? "" : String(v));

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export type RowsScope = { label: string; rows: Set<number> };

/** Money keeps its unit and every cent the source sent; other numbers stay exact. */
const shown = (v: unknown, format?: string) =>
  typeof v === "number" && format === "usd" ? `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 20 })}` : exact(v);

export function CheckRows({ columns: allColumns, rows: allRows, scopes, initialScope = 0, truncated, lead = [], formats = {} }: { columns: string[]; rows: unknown[][]; scopes: RowsScope[]; initialScope?: number; truncated?: boolean; lead?: string[]; formats?: Record<string, string> }) {
  // The columns the number is made of come first, so a narrow panel shows them before it scrolls. Row order (and so every scope's row set) is unchanged.
  const leadSig = lead.join(",");
  const perm = useMemo(() => {
    const first = leadSig.split(",").filter((c) => c && allColumns.includes(c));
    return [...new Set([...first, ...allColumns])].map((c) => allColumns.indexOf(c));
  }, [allColumns, leadSig]);
  const columns = useMemo(() => perm.map((i) => allColumns[i]), [perm, allColumns]);
  const rows = useMemo(() => allRows.map((r) => perm.map((i) => r[i])), [allRows, perm]);
  const [scopeAt, setScopeAt] = useState(initialScope);
  const scope = scopes[scopeAt] as RowsScope | undefined;
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const numeric = useMemo(() => columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || r[i] === undefined || typeof r[i] === "number")), [columns, rows]);
  const highlight = scopes[0]?.rows;

  const order = useMemo(() => {
    let idx = scope ? [...scope.rows].sort((a, b) => a - b) : rows.map((_, i) => i);
    if (q) idx = idx.filter((i) => rows[i].some((v) => v !== null && v !== undefined && exact(v).toLowerCase().includes(q)));
    if (sort) idx = [...idx].sort((a, b) => compare(rows[a][sort.col], rows[b][sort.col]) * (sort.desc ? -1 : 1));
    return idx;
  }, [rows, scope, q, sort]);

  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: order.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 12 });
  const items = v.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = v.getTotalSize() - (items[items.length - 1]?.end ?? 0);

  return (
    <div className="space-y-1.5 min-w-0" data-check-rows>
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sol-text-dim pointer-events-none" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in rows" aria-label="Find in rows" className="w-full h-7 rounded-md bg-sol-bg border border-sol-border/60 pl-7 pr-6 text-xs text-sol-text outline-none focus:border-sol-blue" />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-sol-text-dim hover:text-sol-text">
              <X className="w-3 h-3" />
            </button>
          ) : null}
        </label>
        {scopes.length ? (
          <div className="inline-flex max-w-full overflow-x-auto rounded-md bg-sol-bg-alt p-0.5" role="radiogroup" aria-label="Which rows">
            {[...scopes, null].map((s, i) => {
              const on = s ? i === scopeAt : scopeAt >= scopes.length;
              return (
                <button key={s?.label ?? "all"} type="button" role="radio" aria-checked={on} onClick={() => setScopeAt(i)} className={`h-6 px-2 rounded text-xs tabular-nums whitespace-nowrap ${on ? "bg-sol-bg text-sol-text shadow-sm" : "text-sol-text-dim hover:text-sol-text"}`}>
                  {s ? `${s.label} ${s.rows.size}` : `All ${rows.length}${truncated ? "+" : ""}`}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div ref={scroller} className="overflow-auto rounded-lg border border-sol-border/40 max-h-[420px]">
        <table className="w-full text-[12.5px] tabular-nums border-collapse">
          <thead className="sticky top-0 bg-sol-card z-[1]">
            <tr>
              {columns.map((c, i) => {
                const on = sort?.col === i;
                return (
                  <th key={c} className={`h-8 border-b border-sol-border/40 font-medium whitespace-nowrap ${numeric[i] ? "text-right" : "text-left"}`} aria-sort={on ? (sort!.desc ? "descending" : "ascending") : undefined}>
                    <button
                      type="button"
                      onClick={() => setSort(!on ? { col: i, desc: numeric[i] } : sort!.desc === numeric[i] ? { col: i, desc: !sort!.desc } : null)}
                      className={`w-full h-8 px-3 inline-flex items-center gap-1 ${numeric[i] ? "justify-end" : ""} ${on ? "text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
                    >
                      {c.replace(/_/g, " ")}
                      {on ? sort!.desc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {top > 0 ? <tr style={{ height: top }} /> : null}
            {items.map((it) => {
              const ri = order[it.index];
              const r = rows[ri];
              return (
                <tr key={ri} style={{ height: ROW_H }} className={highlight?.has(ri) && scopeAt >= scopes.length ? "bg-sol-blue/10" : "hover:bg-sol-bg-alt/50"} data-row={ri}>
                  {columns.map((c, i) => (
                    <td key={c} className={`px-3 border-b border-sol-border/20 whitespace-nowrap ${numeric[i] ? "text-right text-sol-text" : "text-sol-text-secondary max-w-[260px] truncate"}`} title={numeric[i] ? undefined : exact(r[i])}>
                      {shown(r[i], formats[c])}
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottom > 0 ? <tr style={{ height: bottom }} /> : null}
            {!order.length ? (
              <tr>
                <td colSpan={columns.length || 1} className="px-3 h-16 text-center text-sol-text-dim">
                  {q ? "No row matches" : "No rows"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {q && order.length ? <div className="text-meta text-sol-text-dim tabular-nums">{order.length} matching</div> : null}
    </div>
  );
}
