// Placing a table read from a file (a CSV, an .xlsx sheet, a pasted web table)
// into a sheet, and importing tables as new tabs. Split out of ops.ts, whose
// cell, tab and width ops these build on.
import { foldOps, toElement, type ArtifactOp, type Json } from "../core";
import { newElementKey } from "../spec";
import { cellKey, rectA1, type Rect } from "./refs";
import { buildModel, cellNum, workbookFor, type CellStyle, type CondRule, type SheetModel, type TabMeta } from "./model";
import { condOps, validationOps } from "./ruleOps";
import { addTabOps, fitWidthOps, gridOps } from "./ops";

type CellFields = Record<string, Json>;

/**
 * Imported tables (a CSV, or each sheet of a workbook) as new tabs after the
 * existing ones, names kept unique, columns fitted to what they hold.
 */
/** A table read from a file: its typed cells, and what an .xlsx also carries (cell styles, merges, dropdown lists). */
export type ImportTable = {
  name: string;
  grid: string[][];
  styles?: Array<{ col: number; row: number; style: CellStyle }>;
  merges?: Rect[];
  lists?: Array<{ rect: Rect; values: string[]; strict?: boolean }>;
  /** Ranges that take a date (a date picker). */
  dates?: Array<{ rect: Rect; strict?: boolean }>;
  /** Conditional colors. */
  conds?: Array<{ rect: Rect; rule: CondRule; value?: string | number; color?: string }>;
};

/**
 * A table written with its top-left at col0,row0: the inputs, then what a file
 * or a pasted web table also carries (cell styles, merges, dropdown lists), all
 * moved to the same place. A styled blank cell (a fill alone) is a new cell.
 */
export function placeTableOps(model: SheetModel, tabId: string, col0: number, row0: number, table: Omit<ImportTable, "name">): ArtifactOp[] {
  const cells = gridOps(model, tabId, col0, row0, table.grid);
  const shift = (r: Rect): Rect => ({ c0: r.c0 + col0 - 1, c1: r.c1 + col0 - 1, r0: r.r0 + row0 - 1, r1: r.r1 + row0 - 1 });
  const t = model.byId.get(tabId);
  const exists = new Set(cells.filter((o) => "put" in o).map((o) => o.k));
  const styled = (table.styles ?? []).map(({ col, row, style }): ArtifactOp => {
    const c = col + col0 - 1, r = row + row0 - 1;
    const k = cellKey(tabId, c, r);
    return exists.has(k) || t?.cells.has(cellNum(c, r)) ? { k, set: style as CellFields } : { k, put: { kind: "cell", ...(style as CellFields) } };
  });
  const merges = (table.merges ?? []).map((rect) => ({ k: newElementKey("mg"), put: { kind: "merge", tab: tabId, range: rectA1(shift(rect)) } }));
  const lists = (table.lists ?? []).flatMap((l) => validationOps(model, tabId, shift(l.rect), "list", l.values.map((v) => ({ v })), l.strict));
  const dates = (table.dates ?? []).flatMap((x) => validationOps(model, tabId, shift(x.rect), "date", [], x.strict));
  // A rule the sheet can't hold (a value it refuses) is skipped rather than failing the whole import.
  const conds = (table.conds ?? []).flatMap((c) => {
    try {
      return condOps(model, tabId, shift(c.rect), c.rule, c.value, c.color, newElementKey("cf"));
    } catch {
      return [];
    }
  });
  return [...cells, ...styled, ...merges, ...lists, ...dates, ...conds];
}

export function importTablesOps(model: SheetModel, tables: ImportTable[]): { ops: ArtifactOp[]; tabIds: string[] } {
  const ops: ArtifactOp[] = [];
  const tabIds: string[] = [];
  let m = model;
  for (const table of tables) {
    const add = addTabOps(m, table.name);
    const first = add.ops[0];
    const name = "put" in first && typeof first.put.name === "string" ? first.put.name : table.name;
    const meta: TabMeta = { id: add.id, name, order: Math.max(-1, ...m.tabs.map((t) => t.order)) + 1, frozenRows: 0, frozenCols: 0 };
    m = { ...m, tabs: [...m.tabs, meta], byId: new Map(m.byId).set(add.id, { meta, cells: new Map(), colWidths: new Map(), rowHeights: new Map(), rows: 0, cols: 0 }) };
    const cells = placeTableOps(m, add.id, 1, 1, table);
    // Fit against the imported cells alone: the new tab holds nothing else yet.
    const alone = buildModel([...foldOps(new Map(), [...add.ops, ...cells])].map(([k, st]) => toElement(k, st)));
    const width = Math.max(0, ...table.grid.map((r) => r.length));
    const fit = fitWidthOps(alone, workbookFor(alone), add.id, Array.from({ length: Math.min(width, 200) }, (_, i) => i + 1));
    ops.push(...add.ops, ...cells, ...fit);
    tabIds.push(add.id);
  }
  return { ops, tabIds };
}
