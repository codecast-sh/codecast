// A sheet opened from its share link: the saved layer, read only, each tab as
// a plain table painted the way the grid paints it (formats, fills, bold
// totals, tables and conditional colors). No formula bar, selection, cursors
// or editing.
import "./sheet.css";
import "./sharedSheet.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cellNum, colLetters, LiveSheet } from "./sheetCore";
import { paintCell, tint, type PaintContext } from "./cellPaint";
import type { LiveSharedViewProps } from "../live/registry";

const DEF_COL_W = 104;
const DEF_ROW_H = 26;

export default function SharedSheet({ elements }: LiveSharedViewProps) {
  const { model, wb } = useMemo(() => {
    const s = new LiveSheet();
    s.update(elements as any);
    s.refreshClock();
    return { model: s.model, wb: s.wb };
  }, [elements]);
  // Only tabs with something in them; the picked one falls back to the first of those as the sheet changes.
  const tabs = model.tabs.filter((t) => (model.byId.get(t.id)?.cells.size ?? 0) > 0);
  const [picked, setTabId] = useState<string | undefined>(undefined);
  const tabId = tabs.find((t) => t.id === picked)?.id ?? tabs[0]?.id;
  const tab = tabId ? model.byId.get(tabId) : undefined;

  const edges = useScrollEdges(tabId);
  const ctx: PaintContext | null = useMemo(() => {
    if (!tab) return null;
    const id = tab.meta.id;
    const conds = model.conds.filter((c) => c.tab === id);
    const ranges = new Map<string, { min: number; max: number } | null>();
    return {
      tables: model.tables.filter((t) => t.tab === id),
      conds,
      numericAt: (col, row) => typeof wb.value(id, col, row) === "number",
      scaleRange: (key) => {
        if (ranges.has(key)) return ranges.get(key)!;
        const c = conds.find((x) => x.key === key);
        let min = Infinity, max = -Infinity;
        if (c) for (const row of wb.read(id, c.rect)) for (const v of row) if (typeof v === "number") { min = Math.min(min, v); max = Math.max(max, v); }
        const r = Number.isFinite(min) ? { min, max } : null;
        ranges.set(key, r);
        return r;
      },
    };
  }, [model, wb, tab]);

  if (!tab || !ctx) return <div className="py-24 text-center text-sm text-sol-text-dim">Empty sheet</div>;
  const id = tab.meta.id;
  const cols = Array.from({ length: tab.cols }, (_, i) => i + 1);
  const rows = Array.from({ length: tab.rows }, (_, i) => i + 1);

  return (
    <div className="sheet-root sheet-shared" data-shared-sheet>
      {tabs.length > 1 && (
        <div className="sheet-shared-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === id} className={t.id === id ? "is-active" : ""} onClick={() => setTabId(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-shared-frame" data-more-left={edges.left ? "" : undefined} data-more-right={edges.right ? "" : undefined}>
      <div className="sheet-shared-scroll" ref={edges.ref} onScroll={edges.update}>
        <table className="sheet-shared-table">
          <colgroup>
            <col style={{ width: 40 }} />
            {cols.map((c) => <col key={c} style={{ width: tab.colWidths.get(c) ?? DEF_COL_W }} />)}
          </colgroup>
          <thead>
            <tr>
              <th />
              {cols.map((c) => <th key={c}>{colLetters(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r} style={{ height: tab.rowHeights.get(r) ?? DEF_ROW_H }}>
                <th>{r}</th>
                {cols.map((c) => {
                  const el = tab.cells.get(cellNum(c, r));
                  const band = bandAt(ctx, c, r);
                  if (!el) return <td key={c} style={band ? { background: band } : undefined} />;
                  const info = wb.cell(id, c, r);
                  const p = paintCell(el, info?.value ?? null, info?.implied, c, r, ctx);
                  const style: CSSProperties = {
                    textAlign: p.align,
                    fontWeight: p.bold ? 600 : undefined,
                    fontStyle: p.italic ? "italic" : undefined,
                    textDecoration: p.underline ? "underline" : undefined,
                    color: p.color,
                    background: p.fill ?? band,
                    whiteSpace: p.wrap ? "normal" : "nowrap",
                    fontSize: p.size ? `${p.size}px` : undefined,
                  };
                  const b = "1px solid var(--sheet-border-strong)";
                  if (p.bd?.includes("t")) style.borderTop = b;
                  if (p.bd?.includes("r")) style.borderRight = b;
                  if (p.bd?.includes("b")) style.borderBottom = b;
                  if (p.bd?.includes("l")) style.borderLeft = b;
                  return <td key={c} style={style} className={p.error ? "is-error" : undefined} title={p.error}>{p.text}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}

/** A table's stripe under a cell, as the grid paints it: the header row, then every other row when banded. */
function bandAt(ctx: PaintContext, col: number, row: number): string | undefined {
  for (const t of ctx.tables) {
    if (col < t.rect.c0 || col > t.rect.c1 || row < t.rect.r0 || row > t.rect.r1) continue;
    const head = row === t.rect.r0;
    if (head) return tint(t.color, 22);
    if (t.banded && (row - t.rect.r0) % 2 === 0) return tint(t.color, 7);
  }
  return undefined;
}

/** Whether the table runs past the frame on either side, so the frame can fade that edge. */
function useScrollEdges(dep: unknown) {
  const node = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = node.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    node.current = el;
    if (!el) return;
    ro.current = new ResizeObserver(update);
    ro.current.observe(el);
    if (el.firstElementChild) ro.current.observe(el.firstElementChild);
    update();
  }, [update]);
  useEffect(() => update(), [dep, update]);
  return { ...edges, ref, update };
}
