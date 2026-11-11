// A1 addressing for sheets: column letters, cell and range references, and
// the element keys cells, columns and rows are stored under. Pure; shared by
// the formula engine, the web grid, the CLI verbs and the server.

/** 1-based column index from letters: A -> 1, Z -> 26, AA -> 27. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Letters for a 1-based column index. */
export function colLetters(index: number): string {
  let s = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export type CellAddr = { col: number; row: number };
/** An inclusive rectangle, 1-based. */
export type Rect = { c0: number; r0: number; c1: number; r1: number };

export function a1(col: number, row: number): string {
  return `${colLetters(col)}${row}`;
}

/** "B2" -> {col:2,row:2}; tolerates $ anchors. */
export function parseA1(text: string): CellAddr | null {
  const m = text.toUpperCase().replace(/\$/g, "").match(/^([A-Z]{1,3})(\d{1,7})$/);
  if (!m) return null;
  const row = Number(m[2]);
  const col = colIndex(m[1]);
  return row >= 1 && row <= 1_000_000 && col <= 18_278 ? { col, row } : null;
}

export function normRect(r: Rect): Rect {
  return { c0: Math.min(r.c0, r.c1), r0: Math.min(r.r0, r.r1), c1: Math.max(r.c0, r.c1), r1: Math.max(r.r0, r.r1) };
}

export function rectA1(r: Rect): string {
  const n = normRect(r);
  const a = a1(n.c0, n.r0), b = a1(n.c1, n.r1);
  return a === b ? a : `${a}:${b}`;
}

/** "A1:C4" or "B2" -> Rect. */
export function parseRectA1(text: string): Rect | null {
  const [a, b] = text.split(":");
  const p = parseA1(a);
  const q = b === undefined ? p : parseA1(b);
  if (!p || !q) return null;
  return normRect({ c0: p.col, r0: p.row, c1: q.col, r1: q.row });
}

export function rectContains(r: Rect, col: number, row: number): boolean {
  return col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1;
}

export function rectSize(r: Rect): { cols: number; rows: number } {
  return { cols: r.c1 - r.c0 + 1, rows: r.r1 - r.r0 + 1 };
}

// ── Tab names in formulas ───────────────────────────────────────────────────

/** How a tab name appears in a formula: bare when it is a plain word, quoted otherwise. */
export function quoteTabName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseA1(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * "Historical!B2:C4", "'Q4 plan'!A1" or "B2" -> the tab NAME (or undefined
 * for the current tab) and the rect.
 */
export function parseQualifiedRange(text: string): { tab?: string; rect: Rect } | null {
  const t = text.trim();
  const bang = t.lastIndexOf("!");
  let tab: string | undefined;
  let rest = t;
  if (bang > 0) {
    let name = t.slice(0, bang);
    if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replace(/''/g, "'");
    tab = name;
    rest = t.slice(bang + 1);
  }
  const rect = parseRectA1(rest);
  return rect ? { tab, rect } : null;
}

// ── Element keys ────────────────────────────────────────────────────────────
// Cells, columns and rows are keyed by TAB ID, not tab name, so renaming a tab
// rewrites nothing but formulas that name it. Key charset: [A-Za-z0-9_:.!$/-].

export const DEFAULT_TAB = "Sheet1";

export function cellKey(tabId: string, col: number, row: number): string {
  return `c:${tabId}!${a1(col, row)}`;
}

export function colKey(tabId: string, col: number): string {
  return `col:${tabId}!${colLetters(col)}`;
}

export function rowKey(tabId: string, row: number): string {
  return `row:${tabId}!${row}`;
}

export function tabKey(tabId: string): string {
  return `tab:${tabId}`;
}

export type ParsedKey =
  | { type: "cell"; tab: string; col: number; row: number }
  | { type: "col"; tab: string; col: number }
  | { type: "row"; tab: string; row: number }
  | { type: "tab"; tab: string };

const CELL_KEY = /^c:([^!]+)!([A-Z]{1,3})(\d+)$/;
const COL_KEY = /^col:([^!]+)!([A-Z]{1,3})$/;
const ROW_KEY = /^row:([^!]+)!(\d+)$/;

export function parseKey(key: string): ParsedKey | null {
  let m = key.match(CELL_KEY);
  if (m) return { type: "cell", tab: m[1], col: colIndex(m[2]), row: Number(m[3]) };
  m = key.match(COL_KEY);
  if (m) return { type: "col", tab: m[1], col: colIndex(m[2]) };
  m = key.match(ROW_KEY);
  if (m) return { type: "row", tab: m[1], row: Number(m[2]) };
  if (key.startsWith("tab:")) return { type: "tab", tab: key.slice(4) };
  return null;
}

/** A fresh tab id that is a valid key segment. */
export function newTabId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (let i = 1; ; i++) {
    const id = `t${i}`;
    if (!taken.has(id)) return id;
  }
}
