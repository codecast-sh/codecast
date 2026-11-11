// Grid geometry shared by the grid and the sheet view: header sizes, hit
// testing a pointer against the panes, and a cell's rect in the viewport.
import type { AxisLayout } from "./layout";

export const ROW_HEADER_W = 46;
export const COL_HEADER_H = 24;
/** Space under the last row, so the floating format bar never sits on data you scroll to. */
export const BOTTOM_ROOM = 64;

export type GridHit =
  | { zone: "cell"; col: number; row: number }
  | { zone: "colHeader"; col: number }
  | { zone: "rowHeader"; row: number }
  | { zone: "corner" };

export function hitTest(scroller: HTMLDivElement, cols: AxisLayout, rows: AxisLayout, frozenW: number, frozenH: number, clientX: number, clientY: number): GridHit {
  const r = scroller.getBoundingClientRect();
  const vx = clientX - r.left, vy = clientY - r.top;
  const inColHeader = vy < COL_HEADER_H;
  const inRowHeader = vx < ROW_HEADER_W;
  if (inColHeader && inRowHeader) return { zone: "corner" };
  const xPx = vx < ROW_HEADER_W + frozenW ? vx - ROW_HEADER_W : vx - ROW_HEADER_W + scroller.scrollLeft;
  const yPx = vy < COL_HEADER_H + frozenH ? vy - COL_HEADER_H : vy - COL_HEADER_H + scroller.scrollTop;
  const col = cols.indexAt(Math.max(0, xPx));
  const row = rows.indexAt(Math.max(0, yPx));
  if (inColHeader) return { zone: "colHeader", col };
  if (inRowHeader) return { zone: "rowHeader", row };
  return { zone: "cell", col, row };
}

/** A cell's rect in viewport px (relative to the scroller's top-left). */
export function cellViewportRect(scroller: HTMLDivElement, cols: AxisLayout, rows: AxisLayout, frozenCols: number, frozenRows: number, col: number, row: number) {
  const frozenW = cols.offset(frozenCols + 1), frozenH = rows.offset(frozenRows + 1);
  const x = ROW_HEADER_W + cols.offset(col) - (col > frozenCols ? scroller.scrollLeft : 0);
  const y = COL_HEADER_H + rows.offset(row) - (row > frozenRows ? scroller.scrollTop : 0);
  const visible =
    (col <= frozenCols || x >= ROW_HEADER_W + frozenW - 1) && (row <= frozenRows || y >= COL_HEADER_H + frozenH - 1);
  return { x, y, w: cols.sizeOf(col), h: rows.sizeOf(row), visible };
}
