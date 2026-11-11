// Rewriting references inside formula text, in place, so a formula keeps the
// author's spacing and casing. Used by fill and paste (relative shift), by
// insert/delete rows and columns (structural shift, #REF! for deleted cells),
// and by tab rename.
import { MAX_COL, MAX_ROW, isFormula, tokenize, type RefPart, type RefToken } from "./formula";
import { colLetters, quoteTabName } from "./refs";

function partText(p: RefPart, shape: RefToken["shape"]): string {
  const c = `${p.absCol ? "$" : ""}${colLetters(p.col)}`;
  const r = `${p.absRow ? "$" : ""}${p.row}`;
  if (shape === "cols") return c;
  if (shape === "rows") return r;
  return c + r;
}

/** Render a reference token back to text. */
export function refText(t: Pick<RefToken, "tab" | "shape" | "a" | "b">): string {
  const prefix = t.tab !== undefined ? `${quoteTabName(t.tab)}!` : "";
  const a = partText(t.a, t.shape);
  return t.shape === "cell" ? prefix + a : `${prefix}${a}:${partText(t.b!, t.shape)}`;
}

/** Map every reference in a formula; return null from fn to keep it, a string to replace it. */
export function mapFormulaRefs(input: string, fn: (t: RefToken) => string | null): string {
  if (!isFormula(input)) return input;
  const src = input.slice(1);
  let toks;
  try {
    toks = tokenize(src);
  } catch {
    return input;
  }
  let out = "";
  let last = 0;
  for (const t of toks) {
    if (t.type !== "ref") continue;
    const next = fn(t);
    if (next === null) continue;
    out += src.slice(last, t.start) + next;
    last = t.end;
  }
  if (last === 0) return input;
  return "=" + out + src.slice(last);
}

/** Copy/fill: move relative parts by (dCol, dRow); a part pushed off the sheet becomes #REF!. */
export function shiftFormula(input: string, dCol: number, dRow: number): string {
  if (dCol === 0 && dRow === 0) return input;
  return mapFormulaRefs(input, (t) => {
    const move = (p: RefPart): RefPart | null => {
      const col = p.absCol || t.shape === "rows" ? p.col : p.col + dCol;
      const row = p.absRow || t.shape === "cols" ? p.row : p.row + dRow;
      if (col < 1 || row < 1 || col > MAX_COL || row > MAX_ROW) return null;
      return { ...p, col, row };
    };
    const a = move(t.a);
    const b = t.b ? move(t.b) : undefined;
    if (!a || b === null) return "#REF!";
    return refText({ ...t, a, b });
  });
}

export type Structural = {
  /** The tab whose rows/columns change, by name. */
  tabName: string;
  axis: "row" | "col";
  /** First row/column index affected (1-based). */
  at: number;
  /** Positive: inserted before `at`. Negative: deleted starting at `at`. */
  count: number;
};

/**
 * Insert/delete rows or columns: shift every reference into the changed tab.
 * `formulaTab` is the name of the tab the formula lives in (a reference with
 * no tab prefix points there).
 */
export function adjustFormula(input: string, formulaTab: string, s: Structural): string {
  return mapFormulaRefs(input, (t) => {
    const target = t.tab ?? formulaTab;
    if (target.toLowerCase() !== s.tabName.toLowerCase()) return null;
    if (s.axis === "row" && t.shape === "cols") return null;
    if (s.axis === "col" && t.shape === "rows") return null;
    const key = s.axis === "row" ? "row" : "col";
    const get = (p: RefPart) => p[key];
    const with_ = (p: RefPart, v: number): RefPart => ({ ...p, [key]: v });
    if (s.count > 0) {
      const shift = (p: RefPart) => (get(p) >= s.at ? with_(p, get(p) + s.count) : p);
      const a = shift(t.a);
      // A range that spans the insertion point grows; its end shifts with it.
      const b = t.b ? shift(t.b) : undefined;
      if (a === t.a && b === t.b) return null;
      return refText({ ...t, a, b });
    }
    const n = -s.count;
    const lo = s.at, hi = s.at + n - 1;
    if (t.shape === "cell") {
      const v = get(t.a);
      if (v < lo) return null;
      if (v <= hi) return "#REF!";
      return refText({ ...t, a: with_(t.a, v - n) });
    }
    let v0 = get(t.a), v1 = get(t.b!);
    const swap = v0 > v1;
    if (swap) [v0, v1] = [v1, v0];
    if (v1 < lo) return null;
    if (v0 >= lo && v1 <= hi) return "#REF!";
    const nv0 = v0 < lo ? v0 : v0 <= hi ? lo : v0 - n;
    const nv1 = v1 > hi ? v1 - n : lo - 1;
    if (nv0 === v0 && nv1 === v1) return null;
    const [pa, pb] = swap ? [t.b!, t.a] : [t.a, t.b!];
    return refText({ ...t, a: with_(pa, nv0), b: with_(pb, nv1) });
  });
}

/** A tab was renamed: rewrite references that name it. */
export function renameTabInFormula(input: string, oldName: string, newName: string): string {
  return mapFormulaRefs(input, (t) => (t.tab !== undefined && t.tab.toLowerCase() === oldName.toLowerCase() ? refText({ ...t, tab: newName }) : null));
}

/** Shift a range written in A1 ("B2:G6") structurally; null when it was deleted whole. */
export function adjustRangeText(range: string, s: Omit<Structural, "tabName">): string | null {
  const out = adjustFormula(`=${range}`, "_", { ...s, tabName: "_" });
  if (out.includes("#REF!")) return null;
  return out.slice(1);
}
