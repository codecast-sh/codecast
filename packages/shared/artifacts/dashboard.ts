// Data dashboards (ct-91886 owns this file). A dashboard is ordered BLOCKS
// keyed b_<id> (kpi, chart, table, text, section) in a 12-column grid, plus
// one `layout` element that says which format the artifact reads as: the
// dashboard itself, a Scrollyteller, or a Visual short. The formats share the
// same blocks and the same data; a story only adds its headline, summary and
// a line of narration per block (say_title, say).
//
// How a block's query turns into what it shows lives in dashboardData.ts.
import type { ArtifactElement, ArtifactOp, Json } from "./core";
import type { ArtifactSpec, ArtifactView, VerbResult } from "./spec";
import { newElementKey } from "./spec";
import { CHART_TYPES, DATA_SOURCES, KPI_AGGS, isDataSource, whereProblem, writtenTextProblem, type DataQuery } from "./dashboardData";
import { readAlert, readSchedule } from "./dashboardWatch";

export * from "./dashboardData";
export * from "./dashboardWatch";
export * from "./dashboardStory";

export const BLOCK_KINDS = ["kpi", "chart", "table", "text", "section"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const LAYOUT_KEY = "layout";

export const STORY_FORMATS = ["dashboard", "scrolly", "short"] as const;
export type StoryFormat = (typeof STORY_FORMATS)[number];

/** Grid widths a block can take, in twelfths. */
export const SPANS = [3, 4, 6, 8, 12] as const;
export const DEFAULT_SPAN: Record<BlockKind, number> = { kpi: 3, chart: 6, table: 12, text: 12, section: 12 };

export function isBlockKind(k: unknown): k is BlockKind {
  return typeof k === "string" && (BLOCK_KINDS as readonly string[]).includes(k);
}

export function blockSpan(b: { kind: string; span?: unknown }): number {
  const s = Number(b.span);
  if ((SPANS as readonly number[]).includes(s)) return s;
  return isBlockKind(b.kind) ? DEFAULT_SPAN[b.kind] : 12;
}

/** How wide the dashboard is drawn: the full 12 columns, two columns, or one. */
export type GridWidth = "wide" | "medium" | "narrow";

/**
 * The spans blocks are drawn at: each span as the width allows (a quarter
 * becomes a third on a medium pane, everything full on a narrow one), then
 * packed into rows in reading order, with a row's leftover columns given to
 * its widest chart or table so no row ends in an empty gap. A number never
 * stretches past half a row (`small`: a big empty card says nothing): a row of
 * numbers shares its leftover evenly up to that, and a lone one keeps the rest
 * as space.
 */
export function packSpans(spans: readonly number[], width: GridWidth, small: readonly boolean[] = []): number[] {
  const fit = spans.map((s) => (width === "narrow" ? 12 : width === "medium" ? (s === 3 ? 4 : s === 4 ? 6 : 12) : s));
  const out = [...fit];
  let row: number[] = [];
  let used = 0;
  const close = () => {
    let left = 12 - used;
    const wide = row.filter((i) => !small[i]);
    if (row.length && left > 0 && wide.length) {
      const widest = wide.reduce((w, i) => (fit[i] >= fit[w] ? i : w), wide[0]);
      out[widest] += left;
      left = 0;
    }
    // Only numbers in the row: each grows by an even share, never past half a row (12 columns on a narrow pane are already full).
    for (let k = 0; left > 0 && k < 12; k++) {
      const growable = row.filter((i) => out[i] < 6);
      if (!growable.length) break;
      for (const i of growable) if (left > 0 && out[i] < 6) (out[i]++, left--);
    }
    row = [];
    used = 0;
  };
  fit.forEach((s, i) => {
    if (used + s > 12) close();
    row.push(i);
    used += s;
  });
  close();
  return out;
}

/** The blocks in reading order: by `order`, then key, so two writers that pick the same order still agree. */
export function orderedBlocks<T extends { key: string; kind: string; order?: Json | undefined }>(elements: readonly T[]): T[] {
  return elements
    .filter((e) => isBlockKind(e.kind))
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** An order that lands right after `afterKey` (or first when null, last when undefined), without renumbering anyone. */
export function orderAfter(blocks: readonly { key: string; order?: Json | undefined }[], afterKey: string | null | undefined): number {
  const sorted = [...blocks].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  if (!sorted.length) return 1;
  if (afterKey === undefined) return Math.floor(Number(sorted[sorted.length - 1].order ?? 0)) + 1;
  if (afterKey === null) return Number(sorted[0].order ?? 0) - 1;
  const i = sorted.findIndex((b) => b.key === afterKey);
  if (i < 0) return Math.floor(Number(sorted[sorted.length - 1].order ?? 0)) + 1;
  const here = Number(sorted[i].order ?? 0);
  const next = sorted[i + 1];
  return next ? (here + Number(next.order ?? 0)) / 2 : here + 1;
}

/** Ops that move one block to `toIndex` in reading order. */
export function moveBlockOps(elements: readonly ArtifactElement[], key: string, toIndex: number): ArtifactOp[] {
  const blocks = orderedBlocks(elements);
  const from = blocks.findIndex((b) => b.key === key);
  if (from < 0) return [];
  const rest = blocks.filter((b) => b.key !== key);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  if (at === from) return [];
  const order = at === 0 ? orderAfter(rest, null) : orderAfter(rest, rest[at - 1].key);
  return [{ k: key, set: { order } }];
}

// ── the layout element and stories ──

export type DashboardLayout = { format: StoryFormat; headline?: string; summary?: string };

export function readLayout(view: { get(key: string): ArtifactElement | undefined }): DashboardLayout {
  const el = view.get(LAYOUT_KEY);
  const format = (STORY_FORMATS as readonly string[]).includes(String(el?.format)) ? (el!.format as StoryFormat) : "dashboard";
  return { format, ...(el?.headline ? { headline: String(el.headline) } : {}), ...(el?.summary ? { summary: String(el.summary) } : {}) };
}

/**
 * The sequence a story walks through. A Scrollyteller and a Visual short both
 * read it: a hero with the headline, then each block in order, KPIs that sit
 * together gathered into one step of numbers, sections as chapter breaks.
 */
export type StoryStep =
  | { kind: "hero"; headline: string; summary?: string; keys: string[] }
  | { kind: "numbers"; keys: string[]; title?: string; say?: string }
  | { kind: "block"; keys: [string]; title?: string; say?: string }
  | { kind: "chapter"; keys: [string]; title: string; say?: string };

export function storySteps(title: string, layout: DashboardLayout, elements: readonly ArtifactElement[]): StoryStep[] {
  const blocks = orderedBlocks(elements).filter((b) => b.in_story !== false);
  const steps: StoryStep[] = [{ kind: "hero", headline: layout.headline || title, ...(layout.summary ? { summary: layout.summary } : {}), keys: [] }];
  for (const b of blocks) {
    const sayTitle = str(b.say_title);
    const say = str(b.say);
    if (b.kind === "kpi") {
      const prev = steps[steps.length - 1];
      // A KPI with no words of its own joins the numbers before it; one with a title or a line is its own step.
      if (prev.kind === "numbers" && !sayTitle && !say) prev.keys.push(b.key);
      else steps.push({ kind: "numbers", keys: [b.key], ...(sayTitle ? { title: sayTitle } : {}), ...(say ? { say } : {}) });
      continue;
    }
    if (b.kind === "section") {
      steps.push({ kind: "chapter", keys: [b.key], title: sayTitle || str(b.title) || "", ...(say || str(b.caption) ? { say: say || str(b.caption) } : {}) });
      continue;
    }
    steps.push({ kind: "block", keys: [b.key], ...(sayTitle || str(b.title) ? { title: sayTitle || str(b.title) } : {}), ...(say || str(b.caption) ? { say: say || str(b.caption) } : {}) });
  }
  return steps;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

// ── describe ──

export function describeQuery(q: unknown): string {
  const query = q as DataQuery | undefined;
  if (!query || !isDataSource(query.source)) return "unbound";
  const args = query.args && Object.keys(query.args).length ? JSON.stringify(query.args) : "{}";
  return `${query.source}${args}`;
}

function describeBlock(b: ArtifactElement): string {
  const head = `${b.key} ${b.kind} span=${blockSpan(b)}${b.title ? ` "${b.title}"` : ""}`;
  const extra: string[] = [];
  if (b.kind === "kpi") {
    if (b.query) extra.push(`= ${b.agg ?? (b.field ? "sum" : "count")}(${b.field ?? ""}) of ${describeQuery(b.query)}`);
    else if (b.value !== undefined) extra.push(`= typed ${JSON.stringify(b.value)} (no source)`);
    for (const f of ["label", "format", "compare", "good"]) if (b[f] !== undefined) extra.push(`${f}=${b[f]}`);
    const alert = readAlert(b);
    if (alert) extra.push(`alert=${[alert.above !== undefined ? `above ${alert.above}` : null, alert.below !== undefined ? `below ${alert.below}` : null].filter(Boolean).join(" or ")}`);
  } else if (b.kind === "chart") {
    extra.push(`${b.chart ?? "line"} of ${describeQuery(b.query)} x=${b.x ?? "?"} y=${b.y ?? "?"}`);
    for (const f of ["series", "cumulative", "limit", "format"]) if (b[f] !== undefined) extra.push(`${f}=${b[f]}`);
  } else if (b.kind === "table") {
    extra.push(`of ${describeQuery(b.query)}`);
    for (const f of ["columns", "sort", "limit"]) if (b[f] !== undefined) extra.push(`${f}=${b[f]}`);
  } else if (b.kind === "text") extra.push(JSON.stringify(b.text ?? ""));
  if (b.where) extra.push(`where=${JSON.stringify(b.where)}`);
  if (b.caption) extra.push(`caption=${JSON.stringify(b.caption)}`);
  if (b.say_title || b.say) extra.push(`story: ${JSON.stringify(b.say_title ?? "")} ${JSON.stringify(b.say ?? "")}`);
  if (b.in_story === false) extra.push("hidden in story");
  return [head, ...extra].join("  ");
}

// ── verbs ──

type Flags = { pos: string[]; flags: Record<string, string | true> };

/** `--name value`, `--name=value` and bare `--flag`; everything else positional. */
export function parseFlags(args: readonly string[], booleans: readonly string[] = []): Flags {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") || a === "--") {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (booleans.includes(name) || i + 1 >= args.length || args[i + 1].startsWith("--")) flags[name] = true;
    else flags[name] = args[++i];
  }
  return { pos, flags };
}

function flagText(f: Flags, name: string): string | undefined {
  const v = f.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagJson(f: Flags, name: string): { [k: string]: Json } | undefined {
  const raw = flagText(f, name);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${name} must be a JSON object, like '{"days":30}'`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`--${name} must be a JSON object`);
  return parsed as { [k: string]: Json };
}

function flagNumber(f: Flags, name: string): number | undefined {
  const raw = flagText(f, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function oneOf<T extends string>(f: Flags, name: string, options: readonly T[]): T | undefined {
  const v = flagText(f, name);
  if (v === undefined) return undefined;
  if (!(options as readonly string[]).includes(v)) throw new Error(`--${name} must be one of ${options.join(", ")}`);
  return v as T;
}

/** The query the flags describe, merged onto the block's current one: --source rebinds, --args alone replaces the args. */
function queryFromFlags(f: Flags, current: unknown): DataQuery | undefined {
  const source = flagText(f, "source");
  const args = flagJson(f, "args");
  const refresh = flagText(f, "refresh");
  if (source === undefined && args === undefined && refresh === undefined) return undefined;
  const prev = current as DataQuery | undefined;
  const src = source ?? prev?.source;
  if (!src) throw new Error("--source is required: one of " + DATA_SOURCES.map((s) => s.id).join(", "));
  if (!isDataSource(src)) throw new Error(`unknown source "${src}" (sources: ${DATA_SOURCES.map((s) => s.id).join(", ")})`);
  const q: DataQuery = { source: src, args: args ?? (source && source !== prev?.source ? {} : prev?.args ?? {}) };
  const r = refresh ?? prev?.refresh;
  if (r) q.refresh = r;
  return q;
}

/** Fields common to every block verb: title, caption, span, where, story lines. */
function commonFields(f: Flags): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const name of ["title", "caption"]) {
    const v = flagText(f, name);
    if (v !== undefined) out[name] = v;
  }
  const span = flagNumber(f, "span");
  if (span !== undefined) {
    if (!(SPANS as readonly number[]).includes(span)) throw new Error(`--span must be one of ${SPANS.join(", ")} (twelfths of the row)`);
    out.span = span;
  }
  const where = flagJson(f, "where");
  if (where) {
    const bad = whereProblem(where);
    if (bad) throw new Error(`--where: ${bad}`);
    out.where = where;
  }
  return out;
}

/** Words a reader takes as fact: refused when they type a number or state a direction the data does not carry. */
/** Every {...} in words must name a KPI on this dashboard with a part the page can draw; anything else would print raw to readers. */
function tokenProblem(view: ArtifactView, text: string): string | null {
  const kpis = orderedBlocks(view.elements).filter((b) => b.kind === "kpi").map((b) => b.key);
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const t = m[1];
    const ok = t.match(/^(b_[A-Za-z0-9_]+)(?:\.(value|delta|trend|vs))?$/);
    if (!ok) return `{${t}} is not a live value: write {b_key}, {b_key.delta}, {b_key.trend} or {b_key.vs}`;
    if (!kpis.includes(ok[1])) return `{${t}} names no KPI on this dashboard (${kpis.length ? `KPIs: ${kpis.join(", ")}` : "it has none yet"})`;
  }
  return null;
}

function checkedWords(what: string, text: string, view: ArtifactView): string {
  const bad = tokenProblem(view, text) ?? writtenTextProblem(text);
  if (bad) throw new Error(`${what}: ${bad}`);
  return text;
}

/**
 * Create a block, or update the one --key names: a new block takes a fresh
 * key and lands after --after (default: the end); an update writes only the
 * fields given, as one `set`.
 */
function writeBlock(view: ArtifactView, kind: BlockKind, f: Flags, fields: Record<string, Json>): VerbResult {
  const key = flagText(f, "key");
  const existing = key ? view.get(key) : undefined;
  if (existing && existing.kind !== kind) throw new Error(`${key} is a ${existing.kind}, not a ${kind}`);
  const query = queryFromFlags(f, existing?.query);
  if (query) fields.query = query as unknown as Json;
  const blocks = orderedBlocks(view.elements);
  const after = flagText(f, "after");
  if (after && !view.get(after)) throw new Error(`no block ${after} (cast data read <doc> lists them)`);
  if (existing) {
    if (after) fields.order = orderAfter(blocks.filter((b) => b.key !== key), after);
    if (!Object.keys(fields).length) throw new Error("nothing to change: pass the flags to update");
    return { ops: [{ k: key!, set: fields }], position: { block: key! }, status: `updated ${key}` };
  }
  const k = key ?? newElementKey("b");
  if (!/^b_[A-Za-z0-9_]+$/.test(k)) throw new Error("block keys look like b_<id>");
  const order = f.flags.first ? orderAfter(blocks, null) : orderAfter(blocks, after);
  return { ops: [{ k, put: { kind, order, ...fields } }], position: { block: k }, status: `added ${kind} ${k}` };
}

const BLOCK_FLAGS = "[--key b_x] [--after b_y|--first] [--title T] [--caption C] [--span 3|4|6|8|12] [--source S --args '{json}'] [--where '{\"col\":\"value\"}']";

const verbs: ArtifactSpec["verbs"] = {
  kpi: {
    summary: "Add or update a KPI tile: one number folded from a source",
    usage: `kpi <doc> --source usage --args '{"days":30}' --field spend --agg sum --format usd [--compare halves|prev|<column>] [--good up|down] [--label <col>] [--value <typed>] [--alert-above N] [--alert-below N | --no-alert] ${BLOCK_FLAGS}\n  --compare halves: the window's later half against its earlier half (last 15 days vs the 15 before, for 30 days). prev: the last row against the row before it (today vs yesterday on daily rows). <column>: the value against the same fold of another column (this_year vs last_year).`,
    run(view, args) {
      const f = parseFlags(args, ["first", "no-alert"]);
      const fields = commonFields(f);
      const field = flagText(f, "field");
      if (field !== undefined) fields.field = field;
      const agg = oneOf(f, "agg", KPI_AGGS);
      if (agg) fields.agg = agg;
      const format = oneOf(f, "format", ["number", "compact", "usd", "percent", "text"] as const);
      if (format) fields.format = format;
      const compare = flagText(f, "compare");
      if (compare !== undefined) fields.compare = compare;
      const good = oneOf(f, "good", ["up", "down"] as const);
      if (good) fields.good = good;
      const label = flagText(f, "label");
      if (label !== undefined) fields.label = label;
      const value = flagText(f, "value");
      if (value !== undefined) fields.value = Number.isFinite(Number(value)) ? Number(value) : value;
      const above = flagNumber(f, "alert-above");
      const below = flagNumber(f, "alert-below");
      if (f.flags["no-alert"]) fields.alert = null;
      else if (above !== undefined || below !== undefined) fields.alert = { ...(above !== undefined ? { above } : {}), ...(below !== undefined ? { below } : {}) };
      return writeBlock(view, "kpi", f, fields);
    },
  },
  chart: {
    summary: "Add or update a chart: line, area, bar, stacked or hbar over a source's rows",
    usage: `chart <doc> --type line|area|bar|stacked|hbar --source usage --args '{"days":30,"group_by":"person"}' --x day --y spend [--series person] [--cumulative] [--limit n] [--format usd] ${BLOCK_FLAGS}`,
    run(view, args) {
      const f = parseFlags(args, ["first", "cumulative"]);
      const fields = commonFields(f);
      const type = oneOf(f, "type", CHART_TYPES);
      if (type) fields.chart = type;
      for (const name of ["x", "y", "series"]) {
        const v = flagText(f, name);
        if (v !== undefined) fields[name] = v;
      }
      if (f.flags.cumulative) fields.cumulative = true;
      if (f.flags["no-cumulative"]) fields.cumulative = null;
      const limit = flagNumber(f, "limit");
      if (limit !== undefined) fields.limit = limit;
      const format = oneOf(f, "format", ["number", "compact", "usd", "percent"] as const);
      if (format) fields.format = format;
      return writeBlock(view, "chart", f, fields);
    },
  },
  table: {
    summary: "Add or update a table of a source's rows",
    usage: `table <doc> --source tasks --args '{"view":"assignee"}' [--columns a,b] [--sort -count] [--limit 10] ${BLOCK_FLAGS}`,
    run(view, args) {
      const f = parseFlags(args, ["first"]);
      const fields = commonFields(f);
      for (const name of ["columns", "sort"]) {
        const v = flagText(f, name);
        if (v !== undefined) fields[name] = v;
      }
      const limit = flagNumber(f, "limit");
      if (limit !== undefined) fields.limit = limit;
      return writeBlock(view, "table", f, fields);
    },
  },
  text: {
    summary: "Add or update a text block; {b_key} shows a KPI's live value, {b_key.delta} its signed change, {b_key.trend} its direction in words, {b_key.vs} what the change compares with",
    usage: `text <doc> "Spend is {b_spend}, {b_spend.delta} on the prior fortnight." [--key b_x] [--after b_y]`,
    run(view, args) {
      const f = parseFlags(args, ["first"]);
      const fields = commonFields(f);
      if (f.pos.length) fields.text = checkedWords("text", f.pos.join(" "), view);
      return writeBlock(view, "text", f, fields);
    },
  },
  section: {
    summary: "Add or update a section header",
    usage: `section <doc> "Spend" [--caption "Last 30 days"] [--key b_x] [--after b_y]`,
    run(view, args) {
      const f = parseFlags(args, ["first"]);
      const fields = commonFields(f);
      if (f.pos.length) fields.title = f.pos.join(" ");
      return writeBlock(view, "section", f, fields);
    },
  },
  move: {
    summary: "Move a block after another, or first",
    usage: "move <doc> <key> --after <key> | --first",
    run(view, args) {
      const f = parseFlags(args, ["first"]);
      const key = f.pos[0];
      if (!key || !view.get(key)) throw new Error("usage: move <doc> <key> --after <key> | --first");
      const blocks = orderedBlocks(view.elements).filter((b) => b.key !== key);
      const after = flagText(f, "after");
      if (!after && !f.flags.first) throw new Error("say where: --after <key> or --first");
      if (after && !view.get(after)) throw new Error(`no block ${after}`);
      return { ops: [{ k: key, set: { order: orderAfter(blocks, f.flags.first ? null : after) } }], position: { block: key }, status: `moved ${key}` };
    },
  },
  story: {
    summary: "Set the format the dashboard reads as (dashboard, scrolly, short) and its headline and summary",
    usage: `story <doc> scrolly|short|dashboard [--headline "Spend is {b_spend.trend}"] [--summary "{b_spend} so far, {b_spend.delta} on the prior fortnight"]`,
    run(view, args) {
      const f = parseFlags(args);
      const format = f.pos[0];
      if (!(STORY_FORMATS as readonly string[]).includes(format)) throw new Error(`usage: story <doc> ${STORY_FORMATS.join("|")} [--headline ..] [--summary ..]`);
      const fields: Record<string, Json> = { format };
      const headline = flagText(f, "headline");
      if (headline !== undefined) fields.headline = checkedWords("--headline", headline, view);
      const summary = flagText(f, "summary");
      if (summary !== undefined) fields.summary = checkedWords("--summary", summary, view);
      const op: ArtifactOp = view.get(LAYOUT_KEY) ? { k: LAYOUT_KEY, set: fields } : { k: LAYOUT_KEY, put: { kind: "layout", ...fields } };
      return { ops: [op], status: `format ${format}` };
    },
  },
  schedule: {
    summary: "Keep the dashboard's numbers fresh while nobody has it open (needed for KPI alerts to fire): hourly, daily, or off",
    usage: "schedule <doc> hourly|daily|off",
    run(view, args) {
      const want = args[0];
      if (want !== "hourly" && want !== "daily" && want !== "off") throw new Error("usage: schedule <doc> hourly|daily|off");
      const refresh = want === "off" ? null : want;
      const op: ArtifactOp = view.get(LAYOUT_KEY) ? { k: LAYOUT_KEY, set: { refresh } } : { k: LAYOUT_KEY, put: { kind: "layout", ...(refresh ? { refresh } : {}) } };
      return { ops: [op], status: want === "off" ? "reads only while open" : `refreshes ${want}` };
    },
  },
  say: {
    summary: "Set the story line a block shows in a Scrollyteller or Visual short, or leave it out of the story",
    usage: `say <doc> <key> "Pre-orders are {b_orders.trend}" ["{b_orders} so far, {b_last} last year"] | say <doc> <key> --skip | --show`,
    run(view, args) {
      const f = parseFlags(args, ["skip", "show"]);
      const [key, title, ...line] = f.pos;
      if (!key || !view.get(key)) throw new Error("usage: say <doc> <key> \"<title>\" [\"<line>\"]");
      const fields: Record<string, Json> = {};
      if (f.flags.skip) fields.in_story = false;
      if (f.flags.show) fields.in_story = null;
      if (title !== undefined) fields.say_title = checkedWords("the story title", title, view);
      if (line.length) fields.say = checkedWords("the story line", line.join(" "), view);
      if (!Object.keys(fields).length) throw new Error("nothing to say: pass a title, a line, --skip or --show");
      return { ops: [{ k: key, set: fields }], position: { block: key }, status: `story line on ${key}` };
    },
  },
};

export const dashboardSpec: ArtifactSpec = {
  type: "dashboard",
  label: "Dashboard",
  cli: "data",
  kinds: [...BLOCK_KINDS, "layout"],
  describe(view) {
    const layout = readLayout(view);
    const blocks = orderedBlocks(view.elements);
    const schedule = readSchedule(view.get(LAYOUT_KEY));
    const head = `dashboard "${view.title}" as ${layout.format}${schedule ? ` refreshes ${schedule}` : " reads while open"}${layout.headline ? ` headline=${JSON.stringify(layout.headline)}` : ""}${layout.summary ? ` summary=${JSON.stringify(layout.summary)}` : ""}`;
    if (!blocks.length) return `${head}: no blocks yet`;
    return [`${head}: ${blocks.length} blocks in reading order`, ...blocks.map(describeBlock)].join("\n");
  },
  presenceFor: (_view, keys) => {
    // A story's headline lives on the layout element; its cursor sits on the heading.
    const k = [...keys].reverse().find((x) => x !== LAYOUT_KEY) ?? keys[keys.length - 1];
    return k ? { block: k } : undefined;
  },
  seed: () => [],
  verbs,
  remote: {
    sources: { summary: "List the data sources a block can bind to: readers, metric watches, connectors, sheets", usage: "sources <doc>", needsDoc: true, action: "dataQueries:cliSources" },
    query: { summary: "Run a query and print its rows, before binding a block to it", usage: `query <doc> <source> [--args '{"days":30}']`, needsDoc: true, action: "dataQueries:cliQuery" },
    check: { summary: "Every block's current value and whether its source still reproduces it", usage: "check <doc> [--rerun]", needsDoc: true, action: "dataQueries:cliCheck" },
  },
  agentGuide: [
    "A dashboard is blocks in reading order in a 12-column grid: kpi (span 3), chart (6), table (12), text (12), section (12).",
    "Every number must come from a source, so a person can open the check behind it. Never type a number into a block or a text.",
    "1. `cast data sources <doc>` lists sources; `cast data query <doc> <source> --args '<json>'` shows a query's columns and rows. Look before you bind.",
    "2. Bind blocks with the verbs: `kpi`, `chart`, `table` take --source and --args plus how to shape the rows (KPI: --field --agg sum|last|avg|min|max|count|top --compare halves|prev|<column> --good up|down; chart: --type --x --y --series --cumulative).",
    "3. Write prose with `text`, referencing live values as {b_key} (the value), {b_key.delta} (the signed change, \"+12%\") and {b_key.trend} (the direction in words, \"up 12%\", \"down 4%\", \"flat\") and {b_key.vs} (what the change compares with, \"the prior 7 days\"; it follows the dashboard's date filter), so the words update with the data and stay verified. The verbs refuse a typed number or a direction stated in words (rose, fell, up 12%): those go wrong the day the data turns.",
    "4. `cast data check <doc>` prints each block's value and check state; fix anything it reports as broken before you hand the dashboard back.",
    "Alerts: `kpi <doc> --key b_x --alert-above N` (or --alert-below) notifies when the KPI crosses the line, and again when it recovers. Numbers refresh only while someone has the dashboard open unless it has a schedule: `schedule <doc> hourly|daily`.",
    "Stories: `story <doc> scrolly|short --headline .. --summary ..` (draft first: `cast data draft <doc> start`), then `say <doc> <key> \"<title>\" \"<line>\"` per block, KPIs first, one idea per step. Keep headlines short and concrete. Headline, summary and story lines take the same tokens and follow the same rule: \"Spend is {b_spend.trend} this fortnight\", never \"Spend rose 12%\".",
    `Sources: ${DATA_SOURCES.map((s) => `${s.id} (${s.args})`).join("; ")}.`,
  ].join("\n"),
};

// ── the Visual short's timeline ──

/** One beat of a Visual short: a story step held on screen from `start` for `duration` ms. */
export type ShortBeat = { step: StoryStep; start: number; duration: number; title: string };

/**
 * The story steps laid end to end as a film: the hook (the headline) is on
 * screen at once, numbers hold long enough to count up and read, and charts
 * (the evidence) get the most time. An end card closes it.
 */
export function shortTimeline(steps: readonly StoryStep[]): { beats: ShortBeat[]; duration: number } {
  const beats: ShortBeat[] = [];
  let at = 0;
  for (const step of steps) {
    const duration =
      step.kind === "hero" ? 3200
      : step.kind === "numbers" ? 1800 + 900 * step.keys.length
      : step.kind === "chapter" ? 2200
      : 5200;
    const title = step.kind === "hero" ? step.headline : step.title ?? (step.kind === "numbers" ? "Numbers" : "");
    beats.push({ step, start: at, duration, title });
    at += duration;
  }
  return { beats, duration: at };
}

/** The beat playing at time t (ms), clamped to the film. */
export function beatAt(beats: readonly ShortBeat[], t: number): number {
  if (!beats.length) return -1;
  for (let i = beats.length - 1; i >= 0; i--) if (t >= beats[i].start) return i;
  return 0;
}

// ── binding a new block to a query ──

/** Args a source starts with in the sources panel. */
export const DEFAULT_ARGS: Record<string, Record<string, Json>> = {
  usage: { days: 30 },
  sessions: { days: 30 },
  tasks: { view: "status", days: 30 },
  prs: { days: 30 },
  signals: { days: 30 },
  events: { days: 30 },
  event_groups: { view: "top", days: 7 },
};

/**
 * A block's shaping fields guessed from a query's columns: the time or label
 * column as x, the first numeric column as the value, a text column between
 * them as the series. A person or agent adjusts from there.
 */
export function suggestFields(kind: "kpi" | "chart" | "table", columns: readonly string[], sample: readonly unknown[] | undefined): Record<string, Json> {
  const numeric = columns.filter((_, i) => typeof sample?.[i] === "number");
  const text = columns.filter((_, i) => typeof sample?.[i] === "string");
  const timeCol = columns.find((c) => /^(day|date|week|month|hour|at|time)$/.test(c));
  const x = timeCol ?? text[0] ?? columns[0];
  const value = numeric.find((c) => c !== x && c !== "at") ?? numeric[0];
  const series = text.find((c) => c !== x);
  if (kind === "kpi") {
    if (!value) return { agg: "count" };
    return { field: value, agg: timeCol ? "sum" : "last", ...(value === "spend" ? { format: "usd" } : {}), ...(timeCol ? { compare: "halves" } : {}) };
  }
  if (kind === "chart") {
    if (!x || !value) return {};
    return { chart: timeCol ? (series ? "stacked" : "area") : "hbar", x, y: value, ...(series && timeCol ? { series } : {}), ...(value === "spend" ? { format: "usd" } : {}) };
  }
  return value ? { sort: `-${value}`, limit: 20 } : { limit: 20 };
}
