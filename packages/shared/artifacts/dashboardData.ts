// Data dashboards: how a block's bound query becomes the number, chart or
// table it shows, and whether that number is verified. Pure, so the web view,
// the CLI (`cast data check`) and the server compute the same thing from the
// same rows.
//
// A block binds to a QUERY: a source (one of the page-data readers, or a
// sheet) plus its args. The server runs each distinct query once per
// dashboard and caches its rows; the block then shapes them: a KPI folds one
// column into one value (sum, last, top...), a chart pivots columns into
// series, a table picks and sorts columns. Every shaping step records which
// rows it used, so the check behind a number can show exactly those rows.

import type { Json } from "./core";

// ── queries ──

/** A block's binding: which source to read and with what args. */
export type DataQuery = { source: string; args?: { [k: string]: Json }; refresh?: string };

/** The sources a block can bind to: the page-data readers plus sheets. */
export const DATA_SOURCES = [
  { id: "usage", label: "Token spend", group: "codecast", args: "days, group_by none|person", columns: "day, [person], tokens, spend" },
  { id: "sessions", label: "Sessions", group: "codecast", args: "days, group_by none|person|agent, subagents", columns: "day, [group], sessions" },
  { id: "tasks", label: "Tasks", group: "codecast", args: "view status|project|assignee|done_per_day|created_per_day, days, project, board human|all", columns: "per view" },
  { id: "prs", label: "Pull requests", group: "codecast", args: "days, repository", columns: "day, opened, merged" },
  { id: "signals", label: "Signals", group: "codecast", args: "days, group_by kind|source|none, source", columns: "day, [group], signals" },
  { id: "events", label: "Events", group: "product", args: "days, group_by, kind, source", columns: "day, [group], events" },
  { id: "event_groups", label: "Issues", group: "product", args: "view series|top, bucket day|hour, days, source, kind, status", columns: "per view" },
  { id: "metric", label: "Metric watch", group: "product", args: "watch mw-N", columns: "at, value" },
  { id: "hogql", label: "PostHog (HogQL)", group: "connector", args: "source, query", columns: "as returned" },
  { id: "connector", label: "Connector reader", group: "connector", args: "source, reader, args", columns: "as returned" },
  { id: "sheet", label: "Sheet range", group: "sheet", args: "doc <sheet doc id>, range Tab!A1:D20, header true|false", columns: "the header row" },
] as const;

export type DataSourceId = (typeof DATA_SOURCES)[number]["id"];

/** One argument of a source as a control: how a person sets it without writing JSON. */
export type SourceParam = { name: string; label: string; kind: "days" | "enum" | "text" | "sheet" | "watch" | "bool"; options?: readonly string[]; placeholder?: string };

const DAYS: SourceParam = { name: "days", label: "Days", kind: "days" };

export const SOURCE_PARAMS: Record<DataSourceId, readonly SourceParam[]> = {
  usage: [DAYS, { name: "group_by", label: "Split by", kind: "enum", options: ["none", "person"] }],
  sessions: [DAYS, { name: "group_by", label: "Split by", kind: "enum", options: ["none", "person", "agent"] }],
  tasks: [{ name: "view", label: "View", kind: "enum", options: ["status", "project", "assignee", "done_per_day", "created_per_day"] }, DAYS, { name: "board", label: "Board", kind: "enum", options: ["human", "all"] }, { name: "project", label: "Project", kind: "text", placeholder: "any" }],
  prs: [DAYS, { name: "repository", label: "Repository", kind: "text", placeholder: "all" }],
  signals: [DAYS, { name: "group_by", label: "Split by", kind: "enum", options: ["none", "kind", "source"] }, { name: "source", label: "Source", kind: "text", placeholder: "all" }],
  events: [DAYS, { name: "group_by", label: "Split by", kind: "enum", options: ["none", "kind", "source"] }, { name: "source", label: "Source", kind: "text", placeholder: "all" }],
  event_groups: [{ name: "view", label: "View", kind: "enum", options: ["top", "series"] }, { name: "bucket", label: "Bucket", kind: "enum", options: ["day", "hour"] }, DAYS],
  metric: [{ name: "watch", label: "Watch", kind: "watch" }],
  hogql: [{ name: "source", label: "PostHog source", kind: "text" }, { name: "query", label: "HogQL", kind: "text", placeholder: "select ..." }],
  connector: [{ name: "source", label: "Connector", kind: "text" }, { name: "reader", label: "Reader", kind: "text" }],
  sheet: [{ name: "doc", label: "Sheet", kind: "sheet" }, { name: "range", label: "Range", kind: "text", placeholder: "Sheet1!A1:D20" }, { name: "header", label: "First row names columns", kind: "bool" }],
};

export function isDataSource(id: unknown): id is DataSourceId {
  return typeof id === "string" && DATA_SOURCES.some((s) => s.id === id);
}

/** JSON with object keys sorted, so the same query always serializes the same way. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

/** FNV-1a over the string, as 13 base-36 chars: a short stable id. */
function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
  }
  return h1.toString(36).padStart(7, "0") + h2.toString(36).padStart(7, "0").slice(0, 6);
}

/** The id the server caches a query's rows under. Same source + args → same key, whatever the block. */
export function queryKey(q: DataQuery): string {
  return `q_${hash(stableJson({ source: q.source, args: q.args ?? {} }))}`;
}

/** A block's query, if it has a usable one. */
export function blockQuery(block: object): DataQuery | null {
  const q = (block as { query?: unknown }).query as DataQuery | undefined;
  if (!q || typeof q !== "object" || !isDataSource(q.source)) return null;
  return q;
}

const REFRESH_UNIT: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const refreshMs = (r: string | undefined) => {
  const m = r?.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  return m ? Number(m[1]) * REFRESH_UNIT[m[2].toLowerCase()] : Infinity;
};

/** The distinct queries a set of blocks binds to, keyed. Blocks sharing a query share its reads, at the fastest interval any of them asks for. */
export function dashboardQueries(blocks: readonly object[]): Map<string, DataQuery> {
  const out = new Map<string, DataQuery>();
  for (const b of blocks) {
    const q = blockQuery(b);
    if (!q) continue;
    const k = queryKey(q);
    const prev = out.get(k);
    if (!prev || refreshMs(q.refresh) < refreshMs(prev.refresh)) out.set(k, q);
  }
  return out;
}

// ── results ──

/** One cached query answer, as the server keeps it. */
export type DataResult = {
  qkey: string;
  columns: string[];
  rows: unknown[][];
  /** When the rows were read; 0 before the first read lands. */
  refreshed_at: number;
  refresh_ms: number;
  /** The reader's own words for what ran. */
  query_text: string;
  source: string;
  args: Record<string, unknown>;
  workspace: string;
  error?: string;
  truncated?: boolean;
  refreshing?: boolean;
};

// ── formats ──

export type NumberFormat = "number" | "compact" | "usd" | "percent" | "text";

export function formatValue(value: unknown, format: NumberFormat = "number"): string {
  if (value === null || value === undefined || value === "") return "–";
  if (format === "text" || typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  // Below 10 of a unit the decimal stays even when it's zero: "4.0B" never reads as "48" beside a "47.9B".
  const scaled = (x: number, unit: string) => `${Math.abs(x) < 10 ? x.toFixed(1) : trim(x.toFixed(1))}${unit}`;
  const compact = (n: number) => {
    if (Math.abs(n) >= 1e9) return scaled(n / 1e9, "B");
    if (Math.abs(n) >= 1e6) return scaled(n / 1e6, "M");
    if (Math.abs(n) >= 1e4) return scaled(n / 1e3, "K");
    return grouped(n, Math.abs(n) < 10 && !Number.isInteger(n) ? 2 : Math.abs(n) < 100 && !Number.isInteger(n) ? 1 : 0);
  };
  switch (format) {
    case "usd":
      return `${value < 0 ? "-" : ""}$${abs >= 1e4 ? compact(abs) : grouped(abs, abs < 100 && !Number.isInteger(abs) ? 2 : 0, true)}`;
    case "percent":
      return `${trim((value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0))}%`;
    case "compact":
      return compact(value);
    default:
      return grouped(value, Number.isInteger(value) ? 0 : abs < 10 ? 2 : 1);
  }
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Thousands separators; trailing fraction zeros dropped unless `cents` (money keeps $12.50). */
function grouped(n: number, digits: number, cents = false): string {
  const fixed = n.toFixed(digits);
  const [int, rawFrac] = fixed.split(".");
  const frac = rawFrac && !cents ? rawFrac.replace(/0+$/, "") : rawFrac;
  const sign = int.startsWith("-") ? "-" : "";
  const body = (sign ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${body}${frac && Number(frac) !== 0 ? `.${frac}` : ""}`;
}

// ── shaping rows ──

export type Where = { [column: string]: Json };

function columnIndex(result: DataResult, name: string | undefined): number {
  return name ? result.columns.indexOf(name) : -1;
}

/** Row indices that pass the block's filter, or a problem naming the missing column. */
export function filterRows(result: DataResult, where: Where | undefined): { rows: number[] } | { problem: string } {
  const tests: Array<[number, Json]> = [];
  for (const [col, want] of Object.entries(where ?? {})) {
    const i = columnIndex(result, col);
    if (i < 0) return { problem: missing(result, col) };
    tests.push([i, want]);
  }
  const rows: number[] = [];
  result.rows.forEach((r, idx) => {
    if (tests.every(([i, want]) => String(r[i]) === String(want))) rows.push(idx);
  });
  return { rows };
}

function missing(result: DataResult, col: string): string {
  return `the source has no column "${col}" (it has ${result.columns.join(", ") || "none"})`;
}

/**
 * A cell as a number: null when blank, "invalid" when it holds something that
 * is not a number (text, a formula error like "#DIV/0!"). "17%" is 0.17 and
 * "$1,200" is 1200, the way a sheet shows them.
 */
function cellNumber(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : "invalid";
  if (typeof v === "boolean") return v ? 1 : 0;
  const t = String(v).trim();
  if (t === "") return null;
  const n = Number(t.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n) || !/^[-+−$\d.,%\s]+$/.test(t)) return "invalid";
  return t.endsWith("%") ? n / 100 : n;
}

function num(v: unknown): number | null {
  const n = cellNumber(v);
  return n === "invalid" ? null : n;
}

/** Rows whose value in a column is not a number: the reason a total can't be trusted. */
function invalidCells(result: DataResult, rows: number[], fi: number): number[] {
  return rows.filter((r) => cellNumber(result.rows[r][fi]) === "invalid");
}

function invalidProblem(result: DataResult, bad: number[], fi: number): string {
  return `${bad.length} ${bad.length === 1 ? "row holds" : "rows hold"} no number in ${result.columns[fi]} (${JSON.stringify(String(result.rows[bad[0]][fi]))} in row ${bad[0] + 1})`;
}

export const KPI_AGGS = ["sum", "last", "first", "avg", "min", "max", "count", "top"] as const;
export type KpiAgg = (typeof KPI_AGGS)[number];

/** Fold the column over the rows. `top` returns the label of the row with the largest value. */
export function aggregate(result: DataResult, rows: number[], agg: KpiAgg, field?: string, label?: string): { value: number | string | null; used: number[]; how: string } | { problem: string } {
  if (agg === "count") return { value: rows.length, used: rows, how: `count of ${rows.length} rows` };
  if (!field) return { problem: `"${agg}" needs a field (a column to fold)` };
  const fi = columnIndex(result, field);
  if (fi < 0) return { problem: missing(result, field) };
  const bad = invalidCells(result, rows, fi);
  if (bad.length) return { problem: invalidProblem(result, bad, fi) };
  const vals = rows.map((r) => ({ r, v: num(result.rows[r][fi]) })).filter((x): x is { r: number; v: number } => x.v !== null);
  if (!vals.length) return { value: null, used: [], how: `no numeric ${field} in ${rows.length} rows` };
  switch (agg) {
    case "sum":
      return { value: round(vals.reduce((s, x) => s + x.v, 0)), used: vals.map((x) => x.r), how: `sum of ${field} over ${vals.length} rows` };
    case "avg":
      return { value: round(vals.reduce((s, x) => s + x.v, 0) / vals.length), used: vals.map((x) => x.r), how: `average ${field} over ${vals.length} rows` };
    case "last":
      return { value: vals[vals.length - 1].v, used: [vals[vals.length - 1].r], how: `${field} in the last row` };
    case "first":
      return { value: vals[0].v, used: [vals[0].r], how: `${field} in the first row` };
    case "min":
    case "max":
    case "top": {
      let best = vals[0];
      for (const x of vals) if (agg === "min" ? x.v < best.v : x.v > best.v) best = x;
      if (agg !== "top") return { value: best.v, used: [best.r], how: `${agg} ${field} across ${vals.length} rows` };
      const li = label ? columnIndex(result, label) : result.columns.findIndex((_, i) => i !== fi && typeof result.rows[best.r][i] === "string");
      if (label && li < 0) return { problem: missing(result, label) };
      if (li < 0) return { problem: `"top" needs a label column naming the row` };
      return { value: String(result.rows[best.r][li]), used: [best.r], how: `the ${result.columns[li]} with the most ${field} across ${vals.length} rows` };
    }
  }
}

/** Sums carry float noise (0.1 + 0.2); keep what a person would write. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ── KPI ──

export type KpiBlock = {
  title?: string;
  caption?: string;
  query?: unknown;
  field?: string;
  agg?: KpiAgg;
  label?: string;
  format?: NumberFormat;
  where?: Where;
  /** What the delta compares against: "prev" (the previous row), "halves" (the window's earlier half), or a column name. */
  compare?: string;
  /** Which direction is good news; spend going up is not. */
  good?: "up" | "down";
  /** A value typed by hand, shown when the block has no query. Never verified. */
  value?: Json;
};

export type Delta = { value: number; ratio: number | null; display: string; caption: string; dir: "up" | "down" | "flat"; good: boolean | null };

export type KpiEval =
  | { state: "ok"; value: number | string | null; display: string; delta?: Delta; used: number[]; how: string }
  | { state: "problem"; problem: string }
  | { state: "loading" }
  | { state: "unbound"; display: string };

export function evaluateKpi(block: KpiBlock, result: DataResult | undefined): KpiEval {
  const q = blockQuery(block);
  if (!q) return { state: "unbound", display: block.value === undefined || block.value === null ? "–" : formatValue(block.value, block.format) };
  if (!result || (!result.refreshed_at && !result.error)) return { state: "loading" };
  if (result.error && !result.refreshed_at) return { state: "problem", problem: result.error };
  const filtered = filterRows(result, block.where);
  if ("problem" in filtered) return { state: "problem", problem: filtered.problem };
  const agg = block.agg ?? (block.field ? "sum" : "count");
  const main = aggregate(result, filtered.rows, agg, block.field, block.label);
  if ("problem" in main) return { state: "problem", problem: main.problem };
  const format = agg === "top" ? "text" : block.format ?? "number";
  const out: KpiEval = { state: "ok", value: main.value, display: formatValue(main.value, format), used: main.used, how: main.how };
  if (block.compare && typeof main.value === "number") {
    const d = kpiDelta(result, filtered.rows, block, agg, main.value);
    // A comparison that can't be computed is a broken claim, not a missing decoration: text may quote it.
    if (d && "problem" in d) return { state: "problem", problem: `the comparison: ${d.problem}` };
    if (d) out.delta = d;
  }
  return out;
}

const TIME_COLUMNS = ["day", "date", "week", "month", "hour", "at", "time"];

/** The window's rows split into its earlier and later halves: by distinct dates when there is a date column (grouped rows share a day), else by row. */
function halves(result: DataResult, rows: number[]): { early: number[]; late: number[]; n: number; unit: string } | null {
  const ti = result.columns.findIndex((c) => TIME_COLUMNS.includes(c));
  if (ti < 0) {
    if (rows.length < 2) return null;
    const mid = Math.floor(rows.length / 2);
    return { early: rows.slice(0, mid), late: rows.slice(rows.length - mid), n: mid, unit: mid === 1 ? "row" : "rows" };
  }
  const keys: string[] = [];
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const k = String(result.rows[r][ti]);
    if (!byKey.has(k)) {
      byKey.set(k, []);
      keys.push(k);
    }
    byKey.get(k)!.push(r);
  }
  // Fewer than four dates make a "trend" out of two points; no comparison is better than a misleading one.
  if (keys.length < 4) return null;
  const mid = Math.floor(keys.length / 2);
  const col = result.columns[ti];
  const unit = col === "day" || col === "date" ? "d" : ` ${col}${mid === 1 ? "" : "s"}`;
  return { early: keys.slice(0, mid).flatMap((k) => byKey.get(k)!), late: keys.slice(keys.length - mid).flatMap((k) => byKey.get(k)!), n: mid, unit };
}

function kpiDelta(result: DataResult, rows: number[], block: KpiBlock, agg: KpiAgg, current: number): Delta | { problem: string } | undefined {
  let before: number | null = null;
  let against = "";
  let thisValue = current;
  const fmt = block.format ?? "number";
  if (block.compare === "prev") {
    // The last row against the one before it: today vs yesterday, this week vs last.
    const fi = columnIndex(result, block.field);
    if (rows.length < 2 || fi < 0) return undefined;
    const a = num(result.rows[rows[rows.length - 1]][fi]);
    const b = num(result.rows[rows[rows.length - 2]][fi]);
    if (a === null || b === null) return undefined;
    thisValue = a;
    before = b;
    against = result.columns.includes("day") ? "the day before" : "the row before";
  } else if (block.compare === "halves") {
    const h = halves(result, rows);
    if (!h) return undefined;
    const a = aggregate(result, h.early, agg, block.field);
    const b = aggregate(result, h.late, agg, block.field);
    if ("problem" in a) return a;
    if ("problem" in b) return b;
    if (typeof a.value !== "number" || typeof b.value !== "number") return undefined;
    thisValue = b.value;
    before = a.value;
    against = `last ${h.n}${h.unit} vs prior ${h.n}${h.unit}`;
  } else {
    if (columnIndex(result, block.compare) < 0) return { problem: missing(result, block.compare!) };
    const other = aggregate(result, rows, agg === "count" ? "sum" : agg, block.compare);
    if ("problem" in other) return other;
    if (typeof other.value !== "number") return undefined;
    before = other.value;
    against = block.compare!.replace(/_/g, " ");
  }
  if (before === null) return undefined;
  const diff = round(thisValue - before);
  const ratio = before !== 0 ? diff / Math.abs(before) : null;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  const display = ratio !== null ? `${sign}${formatValue(Math.abs(ratio), "percent")}` : `${sign}${formatValue(Math.abs(diff), fmt)}`;
  return {
    value: diff,
    ratio,
    display,
    caption: block.compare === "halves" ? `${against}: ${sign}${formatValue(Math.abs(diff), fmt)}` : `${sign}${formatValue(Math.abs(diff), fmt)} vs ${against}`,
    dir,
    good: dir === "flat" || !block.good ? null : (dir === "up") === (block.good === "up"),
  };
}

// ── charts ──

export const CHART_TYPES = ["line", "area", "bar", "stacked", "hbar"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export type ChartBlock = {
  title?: string;
  caption?: string;
  query?: unknown;
  chart?: ChartType;
  x?: string;
  /** One column, or several comma-separated, each its own series. */
  y?: string;
  /** Split one y column into a series per value of this column. */
  series?: string;
  where?: Where;
  /** Running total along x. */
  cumulative?: boolean;
  /** Keep the largest n categories (bars) or series. */
  limit?: number;
  format?: NumberFormat;
};

export type ChartSeries = { name: string; values: Array<number | null> };
export type ChartEval =
  | { state: "ok"; type: ChartType; x: string[]; series: ChartSeries[]; used: number[]; how: string; format: NumberFormat; total: number }
  | { state: "problem"; problem: string }
  | { state: "loading" }
  | { state: "unbound" };

export function evaluateChart(block: ChartBlock, result: DataResult | undefined): ChartEval {
  if (!blockQuery(block)) return { state: "unbound" };
  if (!result || (!result.refreshed_at && !result.error)) return { state: "loading" };
  if (result.error && !result.refreshed_at) return { state: "problem", problem: result.error };
  const filtered = filterRows(result, block.where);
  if ("problem" in filtered) return { state: "problem", problem: filtered.problem };
  const xName = block.x ?? result.columns[0];
  const xi = columnIndex(result, xName);
  if (xi < 0) return { state: "problem", problem: missing(result, xName ?? "x") };
  const ys = (block.y ? block.y.split(",").map((s) => s.trim()).filter(Boolean) : result.columns.filter((c, i) => i !== xi && typeof result.rows[0]?.[i] === "number").slice(0, block.series ? 1 : 4));
  if (!ys.length) return { state: "problem", problem: `pick a y column (the source has ${result.columns.join(", ")})` };
  const yis = ys.map((y) => columnIndex(result, y));
  const bad = ys.find((_, i) => yis[i] < 0);
  if (bad) return { state: "problem", problem: missing(result, bad) };
  const si = block.series ? columnIndex(result, block.series) : -1;
  if (block.series && si < 0) return { state: "problem", problem: missing(result, block.series) };
  for (const yi of yis) {
    const bad = invalidCells(result, filtered.rows, yi);
    if (bad.length) return { state: "problem", problem: invalidProblem(result, bad, yi) };
  }
  if (si >= 0 && ys.length > 1) return { state: "problem", problem: `a split by ${block.series} takes one value column, not ${ys.join(", ")}` };
  if ((block.chart ?? "line") === "hbar" && (ys.length > 1 || si >= 0)) return { state: "problem", problem: "ranked bars take one value column and no split; use bar or stacked for more" };

  const xs: string[] = [];
  const xPos = new Map<string, number>();
  const bySeries = new Map<string, Map<number, number>>();
  for (const r of filtered.rows) {
    const row = result.rows[r];
    const xv = String(row[xi] ?? "");
    if (!xPos.has(xv)) {
      xPos.set(xv, xs.length);
      xs.push(xv);
    }
    const at = xPos.get(xv)!;
    const names = si >= 0 ? [String(row[si] ?? "(none)")] : ys;
    names.forEach((name, n) => {
      const v = num(row[si >= 0 ? yis[0] : yis[n]]);
      if (v === null) return;
      const m = bySeries.get(name) ?? new Map<number, number>();
      m.set(at, (m.get(at) ?? 0) + v);
      bySeries.set(name, m);
    });
  }
  let series: ChartSeries[] = [...bySeries.entries()].map(([name, m]) => ({ name, values: xs.map((_, i) => (m.has(i) ? round(m.get(i)!) : si >= 0 ? 0 : null)) }));
  if (block.cumulative) {
    series = series.map((s) => {
      let run = 0;
      return { name: s.name, values: s.values.map((v) => (v === null ? null : (run = round(run + v)))) };
    });
  }
  const type = block.chart ?? "line";
  if (filtered.rows.length && !series.length) return { state: "problem", problem: `no numbers in ${ys.join(", ")}` };
  let x = xs;
  const sumOf = (s: ChartSeries) => s.values.reduce<number>((a, v) => a + (v ?? 0), 0);
  if (si >= 0 && block.limit && series.length > block.limit) series = [...series].sort((a, b) => sumOf(b) - sumOf(a)).slice(0, block.limit);
  if (type === "hbar" && series.length === 1) {
    // A ranking: largest first, top n.
    const order = x.map((_, i) => i).sort((a, b) => (series[0].values[b] ?? 0) - (series[0].values[a] ?? 0));
    const keep = block.limit ? order.slice(0, block.limit) : order;
    x = keep.map((i) => xs[i]);
    series = [{ name: series[0].name, values: keep.map((i) => series[0].values[i]) }];
  }
  const total = round(series.reduce((a, s) => a + sumOf(s), 0));
  const how = `${ys.join(", ")} by ${xName}${si >= 0 ? `, one series per ${block.series}` : ""}${block.cumulative ? ", running total" : ""} over ${filtered.rows.length} rows`;
  return { state: "ok", type, x, series, used: filtered.rows, how, format: block.format ?? "number", total };
}

// ── tables ──

export type TableBlock = { title?: string; caption?: string; query?: unknown; columns?: string; sort?: string; limit?: number; where?: Where; format?: NumberFormat };

export type TableEval =
  | { state: "ok"; columns: string[]; rows: unknown[][]; used: number[]; total: number; how: string }
  | { state: "problem"; problem: string }
  | { state: "loading" }
  | { state: "unbound" };

export function evaluateTable(block: TableBlock, result: DataResult | undefined): TableEval {
  if (!blockQuery(block)) return { state: "unbound" };
  if (!result || (!result.refreshed_at && !result.error)) return { state: "loading" };
  if (result.error && !result.refreshed_at) return { state: "problem", problem: result.error };
  const filtered = filterRows(result, block.where);
  if ("problem" in filtered) return { state: "problem", problem: filtered.problem };
  const cols = block.columns ? block.columns.split(",").map((s) => s.trim()).filter(Boolean) : result.columns;
  const idx = cols.map((c) => columnIndex(result, c));
  const bad = cols.find((_, i) => idx[i] < 0);
  if (bad) return { state: "problem", problem: missing(result, bad) };
  let used = filtered.rows;
  if (block.sort) {
    const desc = block.sort.startsWith("-");
    const name = block.sort.replace(/^[-+]/, "");
    const si = columnIndex(result, name);
    if (si < 0) return { state: "problem", problem: missing(result, name) };
    used = [...used].sort((a, b) => compareCells(result.rows[a][si], result.rows[b][si]) * (desc ? -1 : 1));
  }
  const total = used.length;
  if (block.limit && block.limit > 0) used = used.slice(0, block.limit);
  return {
    state: "ok",
    columns: cols,
    rows: used.map((r) => idx.map((i) => result.rows[r][i])),
    used,
    total,
    how: `${cols.length} columns, ${used.length}${total > used.length ? ` of ${total}` : ""} rows${block.sort ? `, sorted by ${block.sort.replace(/^-/, "")}${block.sort.startsWith("-") ? " descending" : ""}` : ""}`,
  };
}

function compareCells(a: unknown, b: unknown): number {
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

// ── text with live numbers ──

/** A text block's pieces: literal text, and {b_key} / {b_key.delta} references to a KPI's live value. */
export type TextPart = { text: string } | { ref: string; part: "value" | "delta" };

export function parseText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /\{(b_[A-Za-z0-9_]+)(?:\.(value|delta))?\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ ref: m[1], part: (m[2] as "value" | "delta") ?? "value" });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Numbers typed into the literal text rather than referenced: they trace to no source. */
export function typedNumbers(text: string): string[] {
  const literal = parseText(text)
    .map((p) => ("text" in p ? p.text : " "))
    .join("");
  return literal.match(/[$+−-]?\d[\d,]*(\.\d+)?[%KMB]?/g)?.filter((n) => /\d{2,}|%|\$/.test(n)) ?? [];
}

// ── verification ──

export type CheckState = "verified" | "refreshing" | "stale" | "partial" | "broken" | "typed" | "loading";

export type Check = { state: CheckState; label: string; detail?: string };

/**
 * Whether a block's number is backed by its source right now. Verified: the
 * shown value was computed from the source's rows on its last read, and that
 * read is current. Broken: the source can no longer produce it (the query
 * fails, a column it folds is gone). Typed: a value with no source at all.
 */
export function checkBlock(kind: string, block: Record<string, unknown>, result: DataResult | undefined, now: number): Check | null {
  if (kind === "section") return null;
  if (kind === "text") {
    const typed = typedNumbers(String(block.text ?? ""));
    return typed.length ? { state: "typed", label: "Typed numbers", detail: `${typed.join(", ")} ${typed.length === 1 ? "is" : "are"} typed, not read from a source` } : null;
  }
  const q = blockQuery(block);
  if (!q) return kind === "kpi" && block.value !== undefined ? { state: "typed", label: "Typed by hand", detail: "This number has no source" } : null;
  if (!result || (!result.refreshed_at && !result.error)) return { state: "loading", label: "Reading" };
  const ev = kind === "kpi" ? evaluateKpi(block as KpiBlock, result) : kind === "chart" ? evaluateChart(block as ChartBlock, result) : evaluateTable(block as TableBlock, result);
  if (ev.state === "problem") return { state: "broken", label: "Can't reproduce", detail: ev.problem };
  if (result.error) return { state: "stale", label: "Last read failed", detail: `Showing the read from ${ago(now - result.refreshed_at)}; the latest read failed: ${result.error}` };
  if (result.truncated) return { state: "partial", label: "Partial rows", detail: "The source returned more rows than a dashboard keeps; totals may be low" };
  const age = now - result.refreshed_at;
  if (result.refreshing) return { state: "refreshing", label: "Refreshing", detail: `Showing the read from ${ago(age)} while a new one runs` };
  if (age > Math.max(result.refresh_ms, 60_000) * 3) return { state: "stale", label: `Read ${ago(age)}`, detail: "No fresh read lately; open the check to re-run it" };
  return { state: "verified", label: "Verified", detail: `Computed from ${q.source} rows read ${ago(age)}` };
}

export function ago(ms: number): string {
  if (ms < 45_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * What a block shows, twice: `exact` (the values at full precision, every
 * category and series) is what a re-run must reproduce; `shown` is how the
 * page writes it.
 */
export function blockValue(kind: string, block: Record<string, unknown>, result: DataResult | undefined): { exact: string; shown: string } | null {
  if (kind === "kpi") {
    const ev = evaluateKpi(block as KpiBlock, result);
    return ev.state === "ok" ? { exact: stableJson([ev.value, ev.delta?.value ?? null, ev.delta?.ratio ?? null]), shown: `${ev.display}${ev.delta ? ` ${ev.delta.display}` : ""}` } : null;
  }
  if (kind === "chart") {
    const ev = evaluateChart(block as ChartBlock, result);
    return ev.state === "ok" ? { exact: stableJson([ev.x, ev.series]), shown: `${ev.x.length} points, total ${formatValue(ev.total, ev.format)}` } : null;
  }
  if (kind === "table") {
    const ev = evaluateTable(block as TableBlock, result);
    return ev.state === "ok" ? { exact: stableJson([ev.columns, ev.rows]), shown: `${ev.rows.length} rows` } : null;
  }
  return null;
}

/** Back-compat name for the shown form. */
export function blockFingerprint(kind: string, block: Record<string, unknown>, result: DataResult | undefined): string | null {
  return blockValue(kind, block, result)?.shown ?? null;
}

/** A fresh re-run against what the dashboard shows: does the source still give exactly the same values? */
export function compareRerun(kind: string, block: Record<string, unknown>, shown: DataResult | undefined, fresh: DataResult): { same: boolean; before: string | null; after: string | null; problem?: string } {
  const was = blockValue(kind, block, shown);
  if (fresh.error) return { same: false, before: was?.shown ?? null, after: null, problem: fresh.error };
  // Matching the rows a dashboard keeps is not reproducing a number computed over rows it dropped.
  if (fresh.truncated) return { same: false, before: was?.shown ?? null, after: blockValue(kind, block, fresh)?.shown ?? null, problem: "the source returned more rows than a dashboard keeps, so the number can't be fully reproduced" };
  const now = blockValue(kind, block, fresh);
  if (!now) {
    const ev = kind === "kpi" ? evaluateKpi(block as KpiBlock, fresh) : kind === "chart" ? evaluateChart(block as ChartBlock, fresh) : evaluateTable(block as TableBlock, fresh);
    return { same: false, before: was?.shown ?? null, after: null, problem: ev.state === "problem" ? ev.problem : "the source returned nothing to compute from" };
  }
  const same = !!was && was.exact === now.exact;
  // Same words, different values (a reordered chart, a rounding): say what moved without pretending the text changed.
  const after = !same && was && was.shown === now.shown ? `${now.shown} (values differ)` : now.shown;
  return { same, before: was?.shown ?? null, after };
}

// ── sheets as a source ──

type Cell = number | string | boolean | null;
// A sheet range's evaluated values come from the Sheets engine (readSheetRange in ./sheet).

/** Values as a table: the first row names the columns, or columns are A, B, C. */
export function sheetTable(values: Cell[][], header: boolean, firstCol = 1): { columns: string[]; rows: Cell[][] } {
  const width = Math.max(0, ...values.map((r) => r.length));
  const letters = (i: number) => {
    let s = "";
    for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  if (!header || !values.length) return { columns: Array.from({ length: width }, (_, i) => letters(firstCol + i)), rows: values };
  const taken = new Set<string>();
  const columns = Array.from({ length: width }, (_, i) => {
    const base = String(values[0][i] ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || letters(firstCol + i).toLowerCase();
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    return name;
  });
  return { columns, rows: values.slice(1) };
}
