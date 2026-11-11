// The virtualized grid. One native scroller holds four panes laid out with
// position: sticky (frozen corner, frozen rows, frozen columns, the body), so
// headers and frozen panes move on the compositor in step with the scroll,
// never a frame behind. Only the visible window of cells renders; gridlines
// are one line per visible row/column; selections, other people's ranges and
// the fill handle are overlays drawn per pane and clipped to it.
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ArtifactPresence } from "@codecast/shared/artifacts";
import { cellNum, colLetters, type Rect, type TabData, type Workbook } from "@codecast/shared/artifacts/sheets";
import { CursorTag } from "../live/LiveCursors";
import { CursorArrow } from "../presence/CursorArrow";
import { paintCell, tint, type Paint, type PaintContext } from "./cellPaint";
import type { AxisLayout } from "./layout";
import { BOTTOM_ROOM, COL_HEADER_H, ROW_HEADER_W, hitTest, type GridHit } from "./gridGeometry";
import { useWatchEffect } from "../../hooks/useWatchEffect";

const OVERSCAN_PX = 200;

export type Outline = { key: string; rect: Rect; color: string; presence?: ArtifactPresence; dashed?: boolean; fill?: boolean; label?: ReactNode };

export type GridProps = {
  tab: TabData;
  wb: Workbook;
  version: number;
  cols: AxisLayout;
  rows: AxisLayout;
  frozenRows: number;
  frozenCols: number;
  sel: Rect;
  active: { col: number; row: number };
  outlines: Outline[];
  paintCtx: PaintContext;
  filterCols: Set<number>;
  filterRow: number | null;
  /** Cells an agent just wrote ("col:row"), tinted briefly so a watcher sees the sheet fill. */
  flash?: Set<string>;
  readOnly: boolean;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (hit: GridHit, e: React.PointerEvent) => void;
  onDoubleClick: (hit: GridHit) => void;
  onContextMenu: (hit: GridHit, e: React.MouseEvent) => void;
  onResizeStart: (axis: "col" | "row", index: number, e: React.PointerEvent) => void;
  /** Double-click on a column's right edge: fit it to its content. */
  onAutoFit?: (col: number) => void;
  onFillStart: (e: React.PointerEvent) => void;
  onFilterClick: (col: number, e: React.MouseEvent) => void;
  onScroll: () => void;
};

type Win = { r0: number; r1: number; c0: number; c1: number };

/** Where a pane's local (0,0) sits in axis px: local = offset - origin. */
type Pane = { name: "corner" | "top" | "left" | "main"; ox: number; oy: number; rows: [number, number]; cols: [number, number] };

export const SheetGrid = memo(function SheetGrid(p: GridProps) {
  const { cols, rows, frozenRows, frozenCols, scrollerRef } = p;
  const frozenW = cols.offset(frozenCols + 1);
  const frozenH = rows.offset(frozenRows + 1);
  const [win, setWin] = useState<Win>({ r0: 1, r1: 40, c0: 1, c1: 12 });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const vw = el.clientWidth - ROW_HEADER_W - frozenW;
    const vh = el.clientHeight - COL_HEADER_H - frozenH;
    const x0 = frozenW + el.scrollLeft - OVERSCAN_PX, x1 = frozenW + el.scrollLeft + vw + OVERSCAN_PX;
    const y0 = frozenH + el.scrollTop - OVERSCAN_PX, y1 = frozenH + el.scrollTop + vh + OVERSCAN_PX;
    const next: Win = {
      c0: Math.max(frozenCols + 1, cols.indexAt(Math.max(frozenW, x0))),
      c1: cols.indexAt(x1),
      r0: Math.max(frozenRows + 1, rows.indexAt(Math.max(frozenH, y0))),
      r1: rows.indexAt(y1),
    };
    setWin((w) => {
      // Only re-render when the window moves past the overscan margin.
      const inside = next.c0 >= w.c0 && next.c1 <= w.c1 && next.r0 >= w.r0 && next.r1 <= w.r1;
      const far = w.c1 - w.c0 - (next.c1 - next.c0) > 30 || w.r1 - w.r0 - (next.r1 - next.r0) > 60;
      if (inside && !far) return w;
      const pad = (a: number, b: number, n: number, max: number, min: number) => [Math.max(min, a - n), Math.min(max, b + n)] as const;
      const [c0, c1] = pad(next.c0, next.c1, 2, cols.count, frozenCols + 1);
      const [r0, r1] = pad(next.r0, next.r1, 8, rows.count, frozenRows + 1);
      return { c0, c1, r0, r1 };
    });
  }, [scrollerRef, cols, rows, frozenW, frozenH, frozenCols, frozenRows]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useWatchEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      p.onScroll();
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Rigs drive the window directly (a background tab runs no frames).
    (el as HTMLDivElement & { __measure?: () => void }).__measure = measure;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onScroll is read live through props
  }, [scrollerRef, measure, p.onScroll]);

  const panes: Pane[] = useMemo(
    () => [
      { name: "corner", ox: -ROW_HEADER_W, oy: -COL_HEADER_H, rows: [1, frozenRows], cols: [1, frozenCols] },
      { name: "top", ox: frozenW, oy: -COL_HEADER_H, rows: [1, frozenRows], cols: [win.c0, win.c1] },
      { name: "left", ox: -ROW_HEADER_W, oy: frozenH, rows: [win.r0, win.r1], cols: [1, frozenCols] },
      { name: "main", ox: frozenW, oy: frozenH, rows: [win.r0, win.r1], cols: [win.c0, win.c1] },
    ],
    [frozenRows, frozenCols, frozenW, frozenH, win],
  );

  const totalW = cols.total, totalH = rows.total;
  const paneStyle = (pane: Pane): CSSProperties => {
    const w = pane.name === "corner" || pane.name === "left" ? ROW_HEADER_W + frozenW : totalW - frozenW;
    const h = pane.name === "corner" || pane.name === "top" ? COL_HEADER_H + frozenH : totalH - frozenH;
    return { position: "relative", width: w, height: h, overflow: "hidden", flexShrink: 0 };
  };

  const handleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-sheet-resize]") || t.closest("[data-sheet-fill]") || t.closest("[data-sheet-filter]") || t.closest("a")) return;
    const el = scrollerRef.current!;
    p.onPointerDown(hitTest(el, cols, rows, frozenW, frozenH, e.clientX, e.clientY), e);
  };
  const handleDouble = (e: React.MouseEvent) => {
    const el = scrollerRef.current!;
    p.onDoubleClick(hitTest(el, cols, rows, frozenW, frozenH, e.clientX, e.clientY));
  };
  const handleContext = (e: React.MouseEvent) => {
    const el = scrollerRef.current!;
    p.onContextMenu(hitTest(el, cols, rows, frozenW, frozenH, e.clientX, e.clientY), e);
  };

  const renderPane = (pane: Pane) => (
    <div key={pane.name} style={paneStyle(pane)} data-sheet-pane={pane.name} className={pane.name === "corner" || pane.name === "left" ? "sheet-pane-frozen-x" : undefined}>
      <PaneBands pane={pane} cols={cols} rows={rows} paintCtx={p.paintCtx} />
      <PaneLines pane={pane} cols={cols} rows={rows} />
      <PaneCells pane={pane} tab={p.tab} wb={p.wb} version={p.version} cols={cols} rows={rows} paintCtx={p.paintCtx} flash={p.flash} />
      <PaneOverlays pane={pane} {...p} />
      {(pane.name === "corner" || pane.name === "top") && (
        <ColHeaders pane={pane} cols={cols} rows={rows} sel={p.sel} active={p.active} onResizeStart={p.onResizeStart} onAutoFit={p.onAutoFit} />
      )}
      {(pane.name === "corner" || pane.name === "left") && <RowHeaders pane={pane} rows={rows} cols={cols} sel={p.sel} active={p.active} onResizeStart={p.onResizeStart} />}
      {pane.name === "corner" && <div className="sheet-corner" style={{ width: ROW_HEADER_W, height: COL_HEADER_H }} />}
    </div>
  );

  return (
    <div
      ref={scrollerRef}
      className="sheet-scroller"
      data-sheet-scroller
      onPointerDown={handleDown}
      onDoubleClick={handleDouble}
      onContextMenu={handleContext}
    >
      <div style={{ width: ROW_HEADER_W + totalW, height: COL_HEADER_H + totalH + BOTTOM_ROOM, position: "relative" }}>
        <div className="sheet-band-top" style={{ height: COL_HEADER_H + frozenH, width: ROW_HEADER_W + totalW }}>
          <div className="sheet-sticky-left" style={{ zIndex: 4 }}>{renderPane(panes[0])}</div>
          {renderPane(panes[1])}
        </div>
        <div style={{ display: "flex", width: ROW_HEADER_W + totalW }}>
          <div className="sheet-sticky-left" style={{ zIndex: 2 }}>{renderPane(panes[2])}</div>
          {renderPane(panes[3])}
        </div>
      </div>
    </div>
  );
});

// ── Table bands (under the cells, so blank cells inside a table keep their stripe) ──

const PaneBands = memo(function PaneBands({ pane, cols, rows, paintCtx }: { pane: Pane; cols: AxisLayout; rows: AxisLayout; paintCtx: PaintContext }) {
  const [r0, r1] = pane.rows, [c0, c1] = pane.cols;
  if (r1 < r0 || c1 < c0 || !paintCtx.tables.length) return null;
  const out: ReactNode[] = [];
  for (const t of paintCtx.tables) {
    const cs = Math.max(t.rect.c0, c0), ce = Math.min(t.rect.c1, c1);
    if (cs > ce) continue;
    const x = cols.offset(cs) - pane.ox, w = cols.offset(ce + 1) - cols.offset(cs);
    for (let r = Math.max(t.rect.r0, r0); r <= Math.min(t.rect.r1, r1); r++) {
      const head = r === t.rect.r0;
      if (!head && (!t.banded || (r - t.rect.r0) % 2 !== 0)) continue;
      if (rows.sizeOf(r) === 0) continue;
      out.push(<div key={`${t.key}:${r}`} className="sheet-band" style={{ left: x, top: rows.offset(r) - pane.oy, width: w, height: rows.sizeOf(r), background: tint(t.color, head ? 22 : 7) }} />);
    }
  }
  return <>{out}</>;
});

// ── Lines ───────────────────────────────────────────────────────────────────

const PaneLines = memo(function PaneLines({ pane, cols, rows }: { pane: Pane; cols: AxisLayout; rows: AxisLayout }) {
  const out: ReactNode[] = [];
  const [c0, c1] = pane.cols, [r0, r1] = pane.rows;
  if (c1 < c0 || r1 < r0) return null;
  const top = rows.offset(r0) - pane.oy, bottom = rows.offset(r1 + 1) - pane.oy;
  const left = cols.offset(c0) - pane.ox, right = cols.offset(c1 + 1) - pane.ox;
  for (let c = c0; c <= c1; c++) {
    if (cols.sizeOf(c) === 0) continue;
    const x = cols.offset(c + 1) - pane.ox - 1;
    out.push(<div key={`v${c}`} className="sheet-line" style={{ left: x, top, width: 1, height: bottom - top }} />);
  }
  for (let r = r0; r <= r1; r++) {
    if (rows.sizeOf(r) === 0) continue;
    const y = rows.offset(r + 1) - pane.oy - 1;
    out.push(<div key={`h${r}`} className="sheet-line" style={{ left, top: y, width: right - left, height: 1 }} />);
  }
  return <>{out}</>;
});

// ── Cells ───────────────────────────────────────────────────────────────────

type CellBox = { x: number; y: number; w: number; h: number; spill: number };

const Cell = memo(
  function Cell({ box, paint, a1, flash }: { box: CellBox; paint: Paint; a1: string; flash?: boolean }) {
    const style: CSSProperties = {
      left: box.x,
      top: box.y,
      width: box.w + box.spill,
      height: box.h,
      justifyContent: paint.align === "right" ? "flex-end" : paint.align === "center" ? "center" : "flex-start",
      fontWeight: paint.bold ? 600 : undefined,
      fontStyle: paint.italic ? "italic" : undefined,
      textDecoration: paint.underline ? "underline" : undefined,
      color: paint.color,
      whiteSpace: paint.wrap ? "normal" : "pre",
      alignItems: paint.wrap ? "flex-start" : undefined,
      background: paint.fill ?? (box.spill ? "var(--sheet-bg)" : undefined),
      zIndex: box.spill ? 1 : undefined,
      paddingRight: paint.padRight ? 26 : undefined,
      fontSize: paint.check ? "18px" : paint.size ? `${paint.size}px` : undefined,
    };
    if (paint.bd) {
      const b = "1px solid var(--sheet-border-strong)";
      if (paint.bd.includes("t")) style.borderTop = b;
      if (paint.bd.includes("r")) style.borderRight = b;
      if (paint.bd.includes("b")) style.borderBottom = b;
      if (paint.bd.includes("l")) style.borderLeft = b;
    }
    return (
      <div
        className={`sheet-cell${paint.error ? " is-error" : ""}${paint.invalid ? " is-invalid" : ""}${flash ? " is-flash" : ""}`}
        data-a1={a1}
        data-picker={paint.picker}
        style={paint.picker ? { ...style, paddingRight: 22 } : style}
      >
        {paint.chip ? (
          <span className="sheet-chip" style={{ background: paint.chip.fill, color: paint.chip.color }}>
            {paint.text}
          </span>
        ) : (
          <span className="sheet-cell-text">{paint.text}</span>
        )}
        {paint.picker === "list" && <span className="sheet-cell-caret" aria-hidden />}
      </div>
    );
  },
  (a, b) =>
    a.box.x === b.box.x && a.box.y === b.box.y && a.box.w === b.box.w && a.box.h === b.box.h && a.box.spill === b.box.spill && a.a1 === b.a1 && a.flash === b.flash && samePaint(a.paint, b.paint),
);

function samePaint(a: Paint, b: Paint): boolean {
  return (
    a.text === b.text &&
    a.align === b.align &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.size === b.size &&
    a.color === b.color &&
    a.fill === b.fill &&
    a.bd === b.bd &&
    a.wrap === b.wrap &&
    a.error === b.error &&
    a.padRight === b.padRight &&
    a.check === b.check &&
    a.picker === b.picker &&
    a.invalid === b.invalid &&
    a.chip?.fill === b.chip?.fill &&
    a.chip?.color === b.chip?.color
  );
}

const PaneCells = memo(function PaneCells({
  pane,
  tab,
  wb,
  cols,
  rows,
  paintCtx,
  flash,
}: {
  pane: Pane;
  tab: TabData;
  wb: Workbook;
  version: number;
  cols: AxisLayout;
  rows: AxisLayout;
  paintCtx: PaintContext;
  flash?: Set<string>;
}) {
  const [c0, c1] = pane.cols, [r0, r1] = pane.rows;
  if (c1 < c0 || r1 < r0) return null;
  const out: ReactNode[] = [];
  const tabId = tab.meta.id;
  // Sparse tabs: walk the stored cells when there are fewer of them than visible slots.
  const slots = (c1 - c0 + 1) * (r1 - r0 + 1);
  const visit = (col: number, row: number) => {
    if (rows.sizeOf(row) === 0 || cols.sizeOf(col) === 0) return;
    const el = tab.cells.get(cellNum(col, row));
    if (!el) return;
    const info = wb.cell(tabId, col, row);
    const paint = paintCell(el, info?.value ?? null, info?.implied, col, row, paintCtx);
    if (!paint.text && !paint.fill && !paint.bd) return;
    let spill = 0;
    if (paint.align === "left" && !paint.wrap && !paint.chip && paint.text && typeof info?.value === "string") {
      // Text runs on into empty neighbours, like Sheets.
      const approx = paint.text.length * 7.6 * ((paint.size ?? 13) / 13) * (paint.bold ? 1.05 : 1) + 14;
      let c = col + 1;
      while (approx > cols.sizeOf(col) + spill && c <= c1 && c - col < 12) {
        const n = tab.cells.get(cellNum(c, row));
        if (n && (n.input || n.fill)) break;
        spill += cols.sizeOf(c);
        c++;
      }
    }
    out.push(
      <Cell
        key={`${col}:${row}`}
        box={{ x: cols.offset(col) - pane.ox, y: rows.offset(row) - pane.oy, w: cols.sizeOf(col), h: rows.sizeOf(row), spill }}
        paint={paint}
        a1={`${colLetters(col)}${row}`}
        flash={flash?.has(`${col}:${row}`)}
      />,
    );
  };
  if (tab.cells.size < slots) {
    for (const n of tab.cells.keys()) {
      const col = n % 32768, row = Math.floor(n / 32768);
      if (col >= c0 && col <= c1 && row >= r0 && row <= r1) visit(col, row);
    }
  } else {
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) visit(col, row);
  }
  return <>{out}</>;
});

// ── Headers ─────────────────────────────────────────────────────────────────

function ColHeaders({
  pane,
  cols,
  rows,
  sel,
  active,
  onResizeStart,
  onAutoFit,
}: {
  pane: Pane;
  cols: AxisLayout;
  rows: AxisLayout;
  sel: Rect;
  active: { col: number };
  onResizeStart: GridProps["onResizeStart"];
  onAutoFit?: (col: number) => void;
}) {
  const [c0, c1] = pane.cols;
  const out: ReactNode[] = [];
  const fullCol = sel.r0 === 1 && sel.r1 >= rows.count;
  for (let c = c0; c <= c1; c++) {
    const w = cols.sizeOf(c);
    if (w === 0) continue;
    const inSel = c >= sel.c0 && c <= sel.c1;
    out.push(
      <div
        key={c}
        className={`sheet-colhead ${inSel ? (fullCol ? "is-full" : "is-sel") : ""} ${c === active.col ? "is-active" : ""}`}
        style={{ left: cols.offset(c) - pane.ox, width: w, height: COL_HEADER_H }}
      >
        {colLetters(c)}
        <div data-sheet-resize="col" className="sheet-resize-col" onPointerDown={(e) => onResizeStart("col", c, e)} onDoubleClick={(e) => { e.stopPropagation(); onAutoFit?.(c); }} />
      </div>,
    );
  }
  return <>{out}</>;
}

function RowHeaders({ pane, rows, cols, sel, active, onResizeStart }: { pane: Pane; rows: AxisLayout; cols: AxisLayout; sel: Rect; active: { row: number }; onResizeStart: GridProps["onResizeStart"] }) {
  const [r0, r1] = pane.rows;
  const out: ReactNode[] = [];
  const fullRow = sel.c0 === 1 && sel.c1 >= cols.count;
  for (let r = r0; r <= r1; r++) {
    const h = rows.sizeOf(r);
    if (h === 0) continue;
    const inSel = r >= sel.r0 && r <= sel.r1;
    // Rows a filter hides leave a mark where they were, so the gap in the numbers is explained.
    const hiddenAbove = r > 1 && rows.sizeOf(r - 1) === 0;
    out.push(
      <div
        key={r}
        className={`sheet-rowhead ${inSel ? (fullRow ? "is-full" : "is-sel") : ""} ${r === active.row ? "is-active" : ""} ${hiddenAbove ? "has-hidden-above" : ""}`}
        style={{ top: rows.offset(r) - pane.oy, height: h, width: ROW_HEADER_W }}
      >
        {r}
        <div data-sheet-resize="row" className="sheet-resize-row" onPointerDown={(e) => onResizeStart("row", r, e)} />
      </div>,
    );
  }
  return <>{out}</>;
}

// ── Overlays ────────────────────────────────────────────────────────────────

function rectBox(pane: Pane, cols: AxisLayout, rows: AxisLayout, r: Rect) {
  const c1 = Math.min(r.c1, cols.count), r1 = Math.min(r.r1, rows.count);
  const x = cols.offset(r.c0) - pane.ox, y = rows.offset(r.r0) - pane.oy;
  return { x, y, w: cols.offset(c1 + 1) - cols.offset(r.c0), h: rows.offset(r1 + 1) - rows.offset(r.r0) };
}

function PaneOverlays(p: GridProps & { pane: Pane }) {
  const { pane, cols, rows, sel, active, outlines, readOnly } = p;
  const s = rectBox(pane, cols, rows, sel);
  const a = rectBox(pane, cols, rows, { c0: active.col, c1: active.col, r0: active.row, r1: active.row });
  const multi = sel.c0 !== sel.c1 || sel.r0 !== sel.r1;
  return (
    <>
      {outlines.map((o) => {
        const b = rectBox(pane, cols, rows, o.rect);
        const agent = o.presence?.kind === "agent";
        return (
          <div key={o.key} className="sheet-outline" data-sheet-outline={o.key} style={{ left: b.x - 1, top: b.y - 1, width: b.w + 1, height: b.h + 1, borderColor: o.color, borderStyle: o.dashed ? "dashed" : "solid", background: o.fill ? `color-mix(in srgb, ${o.color} 6%, transparent)` : undefined }}>
            {o.presence && !agent && (
              // Above the range's top edge; a range on row 1 has its tag under it instead.
              <span className={`sheet-outline-tag ${o.rect.r0 <= 1 ? "sheet-outline-tag-under" : "sheet-outline-tag-top"}`}>
                <CursorTag p={o.presence} />
              </span>
            )}
            {o.presence && agent && (
              <>
                <span className="sheet-outline-arrow">
                  <CursorArrow color={o.color} />
                </span>
                <span className="sheet-outline-tag sheet-outline-tag-bottom">
                  <CursorTag p={o.presence} />
                </span>
              </>
            )}
          </div>
        );
      })}
      {multi && (
        <div
          className="sheet-sel-fill"
          style={{
            left: s.x,
            top: s.y,
            width: s.w - 1,
            height: s.h - 1,
            // The active cell stays clear inside the tinted range, so you can see where typing lands.
            clipPath: `path(evenodd, "M0 0H${s.w - 1}V${s.h - 1}H0Z M${a.x - s.x} ${a.y - s.y}h${a.w - 1}v${a.h - 1}h${-(a.w - 1)}Z")`,
          }}
        />
      )}
      <div className="sheet-sel" style={{ left: s.x - 1, top: s.y - 1, width: s.w + 1, height: s.h + 1 }} />
      {multi && <div className="sheet-active" style={{ left: a.x, top: a.y, width: a.w - 1, height: a.h - 1 }} />}
      {!readOnly && <div data-sheet-fill className="sheet-fill-handle" style={{ left: s.x + s.w - 4, top: s.y + s.h - 4 }} onPointerDown={p.onFillStart} />}
    </>
  );
}
