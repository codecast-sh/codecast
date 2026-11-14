// Column widths that fit their content, for the grid's double-click on a
// column edge and for an agent's write. Re-exported from ./ops.
import type { ArtifactOp } from "../core";
import type { Workbook } from "./engine";
import { colKey } from "./refs";
import { cellNum, inheritedFormat, styleOf, type SheetModel } from "./model";
import { formatValue } from "./format";

/** Rough px width of a cell's shown text in the grid font (13px mono, bold a touch wider). */
export function textWidth(text: string, fs = 13, bold = false): number {
  return text.length * 7.6 * (fs / 13) * (bold ? 1.05 : 1) + 22;
}

/**
 * Widths that fit each column's shown values (headers included), capped at
 * 360px. `onlyUnset` leaves columns someone sized alone and never narrows
 * below the default width: that is what an agent's write uses, so its
 * headers and numbers are not clipped.
 */
export function fitWidthOps(model: SheetModel, wb: Workbook, tabId: string, cols: number[], opts: { onlyUnset?: boolean; defaultWidth?: number } = {}): ArtifactOp[] {
  const t = model.byId.get(tabId);
  if (!t) return [];
  const want = new Set(cols);
  const widest = new Map<number, number>();
  for (const [n, el] of t.cells) {
    const col = n % 32768;
    if (!want.has(col)) continue;
    const row = Math.floor(n / 32768);
    const info = wb.cell(tabId, col, row);
    if (!info) continue;
    const implied = info.formula && !el.nf ? (inheritedFormat(model, tabId, info.input) ?? info.implied) : info.implied;
    const text = formatValue(info.value, styleOf(el), implied);
    widest.set(col, Math.max(widest.get(col) ?? 0, textWidth(text, typeof el.fs === "number" ? el.fs : 13, !!el.b)));
  }
  // Values an array formula spills into cells with no input of their own count too.
  for (const sp of wb.spillRects(tabId))
    for (let col = sp.c0; col <= sp.c1; col++) {
      if (!want.has(col)) continue;
      for (let row = sp.r0; row <= sp.r1; row++) {
        if (t.cells.has(cellNum(col, row))) continue;
        const text = formatValue(wb.value(tabId, col, row), undefined);
        widest.set(col, Math.max(widest.get(col) ?? 0, textWidth(text, 13, false)));
      }
    }
  const def = opts.defaultWidth ?? 104;
  const ops: ArtifactOp[] = [];
  for (const col of cols) {
    const w = widest.get(col);
    if (w === undefined) continue;
    if (opts.onlyUnset && t.colWidths.has(col)) continue;
    const fit = Math.round(Math.max(opts.onlyUnset ? def : 48, Math.min(360, w)));
    if (opts.onlyUnset && fit <= def) continue;
    ops.push({ k: colKey(tabId, col), put: { kind: "col", w: fit } });
  }
  return ops;
}
