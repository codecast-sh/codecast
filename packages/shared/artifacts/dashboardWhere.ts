// Dashboard row filters: the conditions a block's `where` and the dashboard's
// own filter bar hold, how rows are tested against them, and how the filter
// bar's choices travel in the URL. Pure, shared by web, CLI and server.
import type { Json } from "./core";
import type { DataResult } from "./dashboardData";

/**
 * A row filter: per column, a value the cell must equal, or a condition
 * object. `{"person":"ada"}` keeps ada's rows; `{"day":{"gte":"2026-11-01"}}`
 * keeps November; `{"agent":{"in":["claude","codex"]}}` keeps either. Several
 * columns, and several operators on one column, must all hold.
 */
export type Where = { [column: string]: Json };

export const WHERE_OPS = ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains"] as const;
export type WhereOp = (typeof WHERE_OPS)[number];
/** One condition, the form a filter builder edits. */
export type WhereClause = { column: string; op: WhereOp; value: Json };

const isCondition = (v: Json): v is { [op: string]: Json } => !!v && typeof v === "object" && !Array.isArray(v);

/** A filter as a flat list of conditions, in column order. */
export function whereClauses(where: Where | undefined): WhereClause[] {
  const out: WhereClause[] = [];
  for (const [column, want] of Object.entries(where ?? {})) {
    if (isCondition(want)) for (const [op, value] of Object.entries(want)) out.push({ column, op: op as WhereOp, value });
    else out.push({ column, op: Array.isArray(want) ? "in" : "eq", value: want });
  }
  return out;
}

/** Conditions back into the stored filter: plain equality stays the short `{"col":"value"}` form. Empty → undefined. */
export function whereFrom(clauses: readonly WhereClause[]): Where | undefined {
  const out: Where = {};
  for (const c of clauses) {
    if (!c.column) continue;
    const prev = out[c.column];
    const solo = prev === undefined && c.op === "eq" && !isCondition(c.value);
    if (solo) {
      out[c.column] = c.value;
      continue;
    }
    const cond: { [op: string]: Json } = prev === undefined ? {} : isCondition(prev) ? { ...prev } : { eq: prev };
    cond[c.op] = c.value;
    out[c.column] = cond;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Problems with a filter before it is stored: unknown operators, list operators without a list. */
export function whereProblem(where: unknown): string | null {
  if (where === undefined || where === null) return null;
  if (typeof where !== "object" || Array.isArray(where)) return "a filter is an object of column → value or condition";
  for (const c of whereClauses(where as Where)) {
    if (!(WHERE_OPS as readonly string[]).includes(c.op)) return `"${c.op}" on ${c.column} is not an operator (use ${WHERE_OPS.join(", ")})`;
    if ((c.op === "in" || c.op === "nin") && !Array.isArray(c.value)) return `"${c.op}" on ${c.column} takes a list`;
  }
  return null;
}

export function cellMatches(cell: unknown, op: WhereOp, want: Json): boolean {
  if (op === "in" || op === "nin") {
    const hit = Array.isArray(want) && want.some((w) => String(cell ?? "") === String(w));
    return op === "in" ? hit : !hit;
  }
  if (op === "eq") return String(cell ?? "") === String(want ?? "");
  if (op === "ne") return String(cell ?? "") !== String(want ?? "");
  if (op === "contains") return String(cell ?? "").toLowerCase().includes(String(want ?? "").toLowerCase());
  if (cell === null || cell === undefined || cell === "") return false;
  // Numbers compare as numbers; dates and other text compare as text, which orders ISO dates correctly.
  const a = num(cell);
  const b = num(want);
  const cmp = a !== null && b !== null ? a - b : String(cell).localeCompare(String(want));
  return op === "gt" ? cmp > 0 : op === "gte" ? cmp >= 0 : op === "lt" ? cmp < 0 : cmp <= 0;
}

/**
 * A cell as a number: null when blank, "invalid" when it holds something that
 * is not a number (text, a formula error like "#DIV/0!"). "17%" is 0.17 and
 * "$1,200" is 1200, the way a sheet shows them.
 */
export function cellNumber(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : "invalid";
  if (typeof v === "boolean") return v ? 1 : 0;
  const t = String(v).trim();
  if (t === "") return null;
  const n = Number(t.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n) || !/^[-+−$\d.,%\s]+$/.test(t)) return "invalid";
  return t.endsWith("%") ? n / 100 : n;
}

export function num(v: unknown): number | null {
  const n = cellNumber(v);
  return n === "invalid" ? null : n;
}

// ── dashboard filters ──

/** Columns a dashboard offers as filters when any of its sources carries them. */
export const FILTER_COLUMNS = ["person", "author", "agent", "project", "repository", "assignee", "status", "kind", "source", "model", "group"] as const;
const DATE_COLUMNS = ["day", "date"];

/** One filter a dashboard can offer. A date filter knows the days the sources hold (`days`, counted the way the filter counts them), so it never offers a range the data can't fill. */
export type FilterDimension = { column: string; kind: "time" | "category"; values: string[]; first?: string; last?: string; days?: number };

/** The filters a dashboard can offer: a date range when a source has days, and each shared category with its values. */
export function filterDimensions(results: readonly (DataResult | undefined)[]): FilterDimension[] {
  const values = new Map<string, Map<string, number>>();
  let time: string | null = null;
  // The narrowest span every dated source covers: a "last 90 days" is only true if each source reaches back that far.
  let first = "";
  let last = "";
  for (const r of results) {
    if (!r) continue;
    r.columns.forEach((c, i) => {
      if (DATE_COLUMNS.includes(c)) {
        time ??= c;
        const days = r.rows.map((row) => String(row[i] ?? "")).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).sort();
        if (days.length) {
          if (!first || days[0] > first) first = days[0];
          if (!last || days[days.length - 1] > last) last = days[days.length - 1];
        }
      }
      if (!(FILTER_COLUMNS as readonly string[]).includes(c)) return;
      const m = values.get(c) ?? new Map<string, number>();
      for (const row of r.rows) {
        const v = row[i];
        if (v !== null && v !== undefined && v !== "") m.set(String(v), (m.get(String(v)) ?? 0) + 1);
      }
      values.set(c, m);
    });
  }
  const span = first && last ? Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1 : undefined;
  const out: FilterDimension[] = time ? [{ column: time, kind: "time", values: [], ...(first ? { first, last, days: span } : {}) }] : [];
  for (const c of FILTER_COLUMNS) {
    const m = values.get(c);
    if (m && m.size > 1) out.push({ column: c, kind: "category", values: [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v) });
  }
  return out;
}

/** A date range as the URL keeps it: "7d" (the last 7 days, today included) or "2026-11-01..2026-11-09" (either end open). */
export function dateRangeWhere(spec: string, today: string): { gte?: string; lte?: string } | null {
  const rel = spec.match(/^(\d{1,3})d$/);
  if (rel) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (Number(rel[1]) - 1));
    return { gte: d.toISOString().slice(0, 10), lte: today };
  }
  const m = spec.match(/^(\d{4}-\d\d-\d\d)?\.\.(\d{4}-\d\d-\d\d)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return { ...(m[1] ? { gte: m[1] } : {}), ...(m[2] ? { lte: m[2] } : {}) };
}

/** The dashboard's filter from its URL params (`f.day=30d`, `f.person=ada,bo`): the scope every block's rows pass through. */
export function scopeFromParams(params: Iterable<[string, string]>, today: string): Where | undefined {
  const out: Where = {};
  for (const [k, v] of params) {
    if (!k.startsWith("f.") || !v) continue;
    const col = k.slice(2);
    if (DATE_COLUMNS.includes(col)) {
      const r = dateRangeWhere(v, today);
      if (r) out[col] = r;
    } else {
      // Each pick is its own param (f.person=ada&f.person=bo); they gather into one list.
      const prev = out[col] as { in?: Json[] } | undefined;
      out[col] = { in: [...(prev?.in ?? []), v] };
    }
  }
  return Object.keys(out).length ? out : undefined;
}
