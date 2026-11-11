// Data dashboards (ct-91886): the queries a dashboard's blocks bind to, run
// through the published-page readers (lib/pageReaders.ts), one cached answer
// per distinct query per doc.
//
// The open dashboard drives freshness: on mount and every minute it calls
// `want` with the queries its blocks bind to; `want` records new ones and
// leases one refresh for each answer older than its interval, so a crowd of
// viewers starts one read. `results` is the store's feed. `rerun` is the
// check behind a number: it runs the query again now, stores the answer, and
// hands it back so the page can compare it with what it showed.
//
// A query runs as the person who first bound it, inside the doc's workspace,
// and refuses once that person can no longer read the workspace: the rule a
// published page's queries follow.

import { v, ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery, query } from "./functions";
import type { ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { PAGE_DATA_LIMITS, capResult, parseRefresh } from "@codecast/shared/contracts/pageData";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { PAGE_READERS, queryText, type ReaderScope } from "./lib/pageReaders";
import { runReader, normalizeRow, dueAt } from "./pageData";
import { requireAccessibleDoc } from "./lib/access";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { readLiveElements } from "./liveArtifacts";

type DataResult = dashboard.DataResult;
const { queryKey, DATA_SOURCES, isDataSource, checkBlock, evaluateKpi, evaluateChart, evaluateTable, orderedBlocks, compareRerun, formatValue, parseFlags } = dashboard;

/** Dashboards read at least this often by default; a block may ask for slower (refresh "1h"). */
const DEFAULT_REFRESH_MS = 5 * 60_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000;
/** A viewer's `want` re-stamps wanted_at at most this often, so open tabs don't churn the row. */
const WANT_STAMP_MS = 30 * 60_000;
const MAX_QUERIES = 64;

const vQuery = v.object({ source: v.string(), args: v.optional(v.any()), refresh: v.optional(v.string()) });

export async function dashboardDoc(ctx: any, userId: Id<"users">, docId: Id<"docs">): Promise<Doc<"docs">> {
  const doc = await requireAccessibleDoc(ctx, userId, docId);
  if (doc.doc_type !== "dashboard") throw new ConvexError(`${doc.title} is not a dashboard`);
  return doc;
}

function workspaceOf(doc: Doc<"docs">): string {
  return doc.workspace ?? `user:${doc.user_id}`;
}

/** A query checked against its reader: the normalized args and audit text, or the reader's complaint. */
async function validated(ctx: any, scope: ReaderScope, q: dashboard.DataQuery): Promise<{ args_json: string; query_text: string; refresh_ms: number; error?: string }> {
  const refresh = q.refresh ? parseRefresh(q.refresh) : DEFAULT_REFRESH_MS;
  const refresh_ms = typeof refresh === "number" ? refresh : DEFAULT_REFRESH_MS;
  const raw = JSON.stringify(q.args ?? {});
  if (!isDataSource(q.source)) return { args_json: raw, query_text: `unknown source ${q.source}`, refresh_ms, error: `unknown source "${q.source}"` };
  const def = PAGE_READERS[q.source as keyof typeof PAGE_READERS];
  if (raw.length > PAGE_DATA_LIMITS.args_bytes) return { args_json: raw, query_text: q.source, refresh_ms, error: "the query's args are too long" };
  const checked = def.validate((q.args ?? {}) as Record<string, unknown>);
  if ("error" in checked) return { args_json: raw, query_text: q.source, refresh_ms, error: checked.error };
  const problem = def.check ? await def.check(ctx, scope, checked.args) : null;
  const query_text = queryText(scope, checked.text);
  if (problem) return { args_json: JSON.stringify(checked.args), query_text, refresh_ms, error: problem };
  if (typeof refresh !== "number") return { args_json: JSON.stringify(checked.args), query_text, refresh_ms, error: refresh.error };
  return { args_json: JSON.stringify(checked.args), query_text, refresh_ms };
}

/**
 * Record the queries a dashboard's blocks bind to and start a refresh for
 * each one past its interval. New queries run as `userId`. Returns the keys
 * it leased.
 */
export async function wantCore(ctx: any, userId: Id<"users">, doc: Doc<"docs">, queries: dashboard.DataQuery[], now: number): Promise<string[]> {
  const workspace = workspaceOf(doc);
  const rows: Doc<"data_queries">[] = await ctx.db.query("data_queries").withIndex("by_doc_qkey", (q: any) => q.eq("doc_id", doc._id)).collect();
  const byKey = new Map(rows.map((r) => [r.qkey, r]));
  // Blocks that share a query share its reads; the shortest interval any of them asks for wins.
  const wanted = new Map<string, dashboard.DataQuery>();
  const cadence = new Map<string, number>();
  if (queries.length > MAX_QUERIES) throw new ConvexError(`A dashboard reads at most ${MAX_QUERIES} distinct queries; this one binds ${queries.length}`);
  for (const q of queries) {
    const k = queryKey(q);
    wanted.set(k, q);
    const r = q.refresh ? parseRefresh(q.refresh) : DEFAULT_REFRESH_MS;
    const ms = typeof r === "number" ? r : DEFAULT_REFRESH_MS;
    cadence.set(k, Math.min(cadence.get(k) ?? Infinity, ms));
  }
  const leased: string[] = [];
  for (const [qkey, q] of wanted) {
    let row = byKey.get(qkey);
    const due = !row || dueAt(row) <= now;
    // A new query, one whose doc moved workspace, or one its reader refused that is due a second look: check it against the reader.
    if (!row || row.workspace !== workspace || (row.invalid && due)) {
      const owner = row && row.workspace === workspace ? row.owner_user_id : userId;
      const checked = await validated(ctx, { owner, workspace }, q);
      const fields = {
        doc_id: doc._id, qkey, source: q.source, args_json: checked.args_json, query_text: checked.query_text,
        owner_user_id: owner, workspace, refresh_ms: cadence.get(qkey) ?? checked.refresh_ms, wanted_at: now,
        ...(checked.error ? { error: checked.error, attempted_at: now, invalid: true } : {}),
      };
      const id: Id<"data_queries"> = row ? (await ctx.db.replace(row._id, { ...fields, created_at: row.created_at }), row._id) : await ctx.db.insert("data_queries", { ...fields, created_at: now });
      row = (await ctx.db.get(id))!;
      if (checked.error) continue;
    } else if (now - row.wanted_at > WANT_STAMP_MS || row.refresh_ms !== cadence.get(qkey)) {
      await ctx.db.patch(row._id, { wanted_at: now, refresh_ms: cadence.get(qkey)! });
      row = (await ctx.db.get(row._id))!;
    }
    if (!row || row.invalid || dueAt(row) > now || (row.lease_until && row.lease_until > now)) continue;
    await ctx.db.patch(row._id, { lease_until: now + PAGE_DATA_LIMITS.lease_ms });
    await ctx.scheduler.runAfter(0, internal.dataQueries.refresh, { id: row._id });
    leased.push(qkey);
  }
  for (const r of rows) if (!wanted.has(r.qkey) && now - r.wanted_at > FORGET_AFTER_MS) await ctx.db.delete(r._id);
  return leased;
}

function toResult(row: Doc<"data_queries">, now: number): DataResult & { _id: Id<"data_queries">; doc_id: Id<"docs"> } {
  let table: { columns: string[]; rows: unknown[][] } = { columns: [], rows: [] };
  if (row.result_json) {
    try {
      table = JSON.parse(row.result_json);
    } catch {
      /* a corrupt cache reads as empty until the next refresh */
    }
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(row.args_json);
  } catch {
    /* args the reader refused may not be JSON-shaped; the error says why */
  }
  return {
    _id: row._id,
    doc_id: row.doc_id,
    qkey: row.qkey,
    columns: table.columns,
    rows: table.rows,
    refreshed_at: row.refreshed_at ?? 0,
    refresh_ms: row.refresh_ms,
    query_text: row.query_text,
    source: row.source,
    args,
    workspace: row.workspace,
    ...(row.error ? { error: row.error } : {}),
    ...(row.truncated ? { truncated: true } : {}),
    ...(row.lease_until && row.lease_until > now ? { refreshing: true } : {}),
  };
}

/**
 * A dashboard's cached answers: the store's feed (dataResults). Readable by
 * anyone who can read the doc, or who holds its share link.
 */
export const results = query({
  args: { doc_id: v.id("docs"), share_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.doc_id);
    if (!doc || doc.doc_type !== "dashboard" || doc.archived_at) return null;
    // A share link sees only what the saved dashboard binds: never a draft's queries or ones a removed block left behind.
    let allowed: Set<string> | null = null;
    if (args.share_token && doc.share_token === args.share_token) {
      allowed = new Set(dashboard.dashboardQueries((await readLiveElements(ctx, doc._id, "main")) as ArtifactElement[]).keys());
    } else {
      const userId = await getAuthUserId(ctx);
      if (!userId) return null;
      try {
        await dashboardDoc(ctx, userId, args.doc_id);
      } catch {
        return null;
      }
    }
    const workspace = workspaceOf(doc);
    const rows = await ctx.db.query("data_queries").withIndex("by_doc_qkey", (q) => q.eq("doc_id", args.doc_id)).collect();
    const now = Date.now();
    // Rows read under another workspace (the doc moved) are not this audience's to see; the next want re-reads them here.
    return rows.filter((r) => r.workspace === workspace && (!allowed || allowed.has(r.qkey))).map((r) => toResult(r, now));
  },
});

// ── running ──

export const refreshInput = internalQuery({
  args: { id: v.id("data_queries") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    const doc = await ctx.db.get(row.doc_id);
    return { row, alive: !!doc && !doc.archived_at };
  },
});

/** Run one row's reader as its owner and store the answer (or the error, keeping the last good rows). Returns what this run read. */
async function runAndStore(ctx: ActionCtx, row: Doc<"data_queries">): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean; at: number } | { error: string; at: number }> {
  const started = Date.now();
  const stamp = { id: row._id, args_json: row.args_json, workspace: row.workspace, owner_user_id: row.owner_user_id, started };
  if (row.invalid) {
    // A query its reader refused never runs, scheduled or by hand; `want` re-checks it on its interval.
    return { error: row.error ?? "the source refused this query", at: started };
  }
  try {
    const table = await runReader(ctx, { reader: row.source, args_json: row.args_json, owner_user_id: row.owner_user_id, workspace: row.workspace }, started);
    const capped = capResult(table.columns, table.rows.map(normalizeRow));
    const at = Date.now();
    await ctx.runMutation(internal.dataQueries.storeResult, { ...stamp, result_json: JSON.stringify({ columns: capped.columns, rows: capped.rows }), truncated: capped.truncated, at });
    return { columns: capped.columns, rows: capped.rows, truncated: capped.truncated, at };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).replace(/^Uncaught (Convex)?Error: /, "").slice(0, 500);
    const at = Date.now();
    await ctx.runMutation(internal.dataQueries.storeResult, { ...stamp, error, at });
    return { error, at };
  }
}

export const refresh = internalAction({
  args: { id: v.id("data_queries") },
  handler: async (ctx, args): Promise<void> => {
    const input: { row: Doc<"data_queries">; alive: boolean } | null = await ctx.runQuery(internal.dataQueries.refreshInput, { id: args.id });
    if (!input) return;
    if (!input.alive) {
      await ctx.runMutation(internal.dataQueries.drop, { id: args.id });
      return;
    }
    await runAndStore(ctx, input.row);
  },
});

export const storeResult = internalMutation({
  args: {
    id: v.id("data_queries"),
    /** What the run read with: a row since rebound (new args, workspace or owner) is not this run's to write. */
    args_json: v.string(),
    workspace: v.string(),
    owner_user_id: v.id("users"),
    /** When the run started: a slower, older run never overwrites a newer answer. */
    started: v.number(),
    result_json: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.id);
    if (!row || row.args_json !== args.args_json || row.workspace !== args.workspace || row.owner_user_id !== args.owner_user_id) return false;
    // Runs are ordered by when they started: whichever finishes last, the latest-started one's outcome stands.
    if ((row.run_started ?? 0) > args.started) return false;
    if (args.result_json !== undefined) {
      await ctx.db.patch(args.id, { result_json: args.result_json, truncated: args.truncated, refreshed_at: args.at, attempted_at: args.at, error: undefined, lease_until: undefined, run_started: args.started });
    } else {
      await ctx.db.patch(args.id, { error: args.error, attempted_at: args.at, lease_until: undefined, run_started: args.started });
    }
    return true;
  },
});

export const drop = internalMutation({
  args: { id: v.id("data_queries") },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.delete(args.id);
  },
});

export const rowForUser = internalQuery({
  args: { user_id: v.id("users"), doc_id: v.id("docs"), qkey: v.string() },
  handler: async (ctx, args): Promise<Doc<"data_queries"> | null> => {
    const doc = await dashboardDoc(ctx, args.user_id, args.doc_id);
    const row = await ctx.db.query("data_queries").withIndex("by_doc_qkey", (q) => q.eq("doc_id", args.doc_id).eq("qkey", args.qkey)).first();
    // A row read under the doc's old workspace isn't this audience's: it re-reads under the new one through `want`.
    return row && row.workspace === workspaceOf(doc) ? row : null;
  },
});

export const rowById = internalQuery({
  args: { id: v.id("data_queries") },
  handler: async (ctx, args): Promise<Doc<"data_queries"> | null> => await ctx.db.get(args.id),
});

export const authedUser = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"users"> | null> => await getAuthUserId(ctx),
});

/**
 * The check behind a number: run its query again now, as its owner, store
 * the answer, and return it, so the page can show whether the source still
 * gives the number it showed.
 */
export const rerun = action({
  args: { doc_id: v.id("docs"), qkey: v.string() },
  handler: async (ctx, args): Promise<DataResult & { ran_ms: number }> => {
    const userId: Id<"users"> | null = await ctx.runQuery(internal.dataQueries.authedUser, {});
    if (!userId) throw new ConvexError("Not authenticated");
    return await rerunAs(ctx, userId, args.doc_id, args.qkey);
  },
});

async function rerunAs(ctx: ActionCtx, userId: Id<"users">, docId: Id<"docs">, qkey: string): Promise<DataResult & { ran_ms: number }> {
  const row: Doc<"data_queries"> | null = await ctx.runQuery(internal.dataQueries.rowForUser, { user_id: userId, doc_id: docId, qkey });
  if (!row) throw new ConvexError("This query isn't on the dashboard any more");
  const started = Date.now();
  // The answer handed back is this run's own read, whatever another run stores meanwhile.
  const out = await runAndStore(ctx, row);
  const { _id, doc_id, ...base } = toResult(row, started);
  const ran_ms = Date.now() - started;
  if ("error" in out) return { ...base, columns: [], rows: [], refreshed_at: 0, error: out.error, refreshing: false, ran_ms };
  return { ...base, columns: out.columns, rows: out.rows, truncated: out.truncated || undefined, refreshed_at: out.at, error: undefined, refreshing: false, ran_ms };
}

// ── the data sources panel ──

export type SourceRow = { _id: string; doc_id: string; group: string; source: string; label: string; detail: string; args?: Record<string, unknown>; columns?: string };

async function sourcesFor(ctx: any, doc: Doc<"docs">): Promise<SourceRow[]> {
  const workspace = workspaceOf(doc);
  const out: SourceRow[] = DATA_SOURCES.filter((s) => s.group === "codecast").map((s) => ({
    _id: `${doc._id}:${s.id}`, doc_id: doc._id, group: "codecast", source: s.id, label: s.label, detail: s.args, columns: s.columns,
  }));
  const watches: Doc<"metric_watches">[] = await ctx.db.query("metric_watches").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(200);
  for (const w of watches) {
    out.push({ _id: `${doc._id}:metric:${w.short_id}`, doc_id: doc._id, group: "metrics", source: "metric", label: w.name, detail: w.short_id, args: { watch: w.short_id }, columns: "at, value" });
  }
  const sources: Doc<"event_sources">[] = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace)).take(200);
  for (const s of sources) {
    const provider = String(s.provider);
    if (provider === "posthog") out.push({ _id: `${doc._id}:hogql:${s.name}`, doc_id: doc._id, group: "connectors", source: "hogql", label: s.name, detail: "PostHog · HogQL", args: { source: s.name, query: "" } });
    else if (provider === "app") out.push({ _id: `${doc._id}:connector:${s.name}`, doc_id: doc._id, group: "connectors", source: "connector", label: s.name, detail: "Connector readers", args: { source: s.name, reader: "" } });
    out.push({ _id: `${doc._id}:events:${s.name}`, doc_id: doc._id, group: "product", source: "events", label: `${s.name} events`, detail: provider, args: { days: 30, source: s.name }, columns: "day, events" });
  }
  const sheets: Doc<"docs">[] = (await ctx.db.query("docs").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).order("desc").take(500)).filter((d: Doc<"docs">) => d.doc_type === "sheet" && !d.archived_at);
  for (const s of sheets.slice(0, 50)) {
    out.push({ _id: `${doc._id}:sheet:${s._id}`, doc_id: doc._id, group: "sheets", source: "sheet", label: s.title || "Untitled sheet", detail: "Sheet", args: { doc: s._id, range: "A1:F50" } });
  }
  return out;
}

/** What a dashboard's blocks can bind to: the store's feed (dataSources). */
export const sources = query({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args): Promise<SourceRow[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const doc = await dashboardDoc(ctx, userId, args.doc_id);
    return await sourcesFor(ctx, doc);
  },
});

/**
 * Preview a query before binding a block to it: run it as the viewer in the
 * doc's workspace and return its first rows. Nothing is stored.
 */
export const preview = action({
  args: { doc_id: v.id("docs"), query: vQuery },
  handler: async (ctx, args): Promise<{ columns: string[]; rows: unknown[][]; total: number; query_text: string; error?: string }> => {
    const userId: Id<"users"> | null = await ctx.runQuery(internal.dataQueries.authedUser, {});
    if (!userId) throw new ConvexError("Not authenticated");
    return await previewAs(ctx, userId, args.doc_id, args.query as dashboard.DataQuery);
  },
});

export const checkQuery = internalQuery({
  args: { user_id: v.id("users"), doc_id: v.id("docs"), query: vQuery },
  handler: async (ctx, args): Promise<{ workspace: string; args_json: string; query_text: string; error?: string }> => {
    const doc = await dashboardDoc(ctx, args.user_id, args.doc_id);
    const workspace = workspaceOf(doc);
    const checked = await validated(ctx, { owner: args.user_id, workspace }, args.query as dashboard.DataQuery);
    return { workspace, args_json: checked.args_json, query_text: checked.query_text, ...(checked.error ? { error: checked.error } : {}) };
  },
});

async function previewAs(ctx: ActionCtx, userId: Id<"users">, docId: Id<"docs">, q: dashboard.DataQuery): Promise<{ columns: string[]; rows: unknown[][]; total: number; query_text: string; error?: string }> {
  const checked: { workspace: string; args_json: string; query_text: string; error?: string } = await ctx.runQuery(internal.dataQueries.checkQuery, { user_id: userId, doc_id: docId, query: q });
  if (checked.error) return { columns: [], rows: [], total: 0, query_text: checked.query_text, error: checked.error };
  try {
    const table = await runReader(ctx, { reader: q.source, args_json: checked.args_json, owner_user_id: userId, workspace: checked.workspace });
    return { columns: table.columns, rows: table.rows.slice(0, 200).map(normalizeRow), total: table.rows.length, query_text: checked.query_text };
  } catch (e) {
    return { columns: [], rows: [], total: 0, query_text: checked.query_text, error: (e instanceof Error ? e.message : String(e)).replace(/^Uncaught (Convex)?Error: /, "") };
  }
}

// ── CLI remote verbs: cast data sources | query | check ──

const vRemote = { user_id: v.id("users"), actor: v.string(), actor_name: v.string(), doc_id: v.optional(v.id("docs")), args: v.array(v.string()), stdin: v.optional(v.string()) };

export const sourcesForUser = internalQuery({
  args: { user_id: v.id("users"), doc_id: v.id("docs") },
  handler: async (ctx, args): Promise<SourceRow[]> => sourcesFor(ctx, await dashboardDoc(ctx, args.user_id, args.doc_id)),
});

export const cliSources = internalAction({
  args: vRemote,
  handler: async (ctx, args): Promise<{ text: string; json: unknown }> => {
    const rows: SourceRow[] = await ctx.runQuery(internal.dataQueries.sourcesForUser, { user_id: args.user_id, doc_id: args.doc_id! });
    const lines: string[] = [];
    let group = "";
    for (const r of rows) {
      if (r.group !== group) lines.push(`${lines.length ? "\n" : ""}${(group = r.group)}`);
      const args = r.args ? ` --args '${JSON.stringify(r.args)}'` : "";
      lines.push(`  ${r.source.padEnd(12)} ${r.label}${r.detail ? ` (${r.detail})` : ""}${args}${r.columns ? `  → ${r.columns}` : ""}`);
    }
    lines.push("", "Run one: cast data query <doc> <source> --args '<json>'");
    return { text: lines.join("\n"), json: rows };
  },
});

function table(columns: string[], rows: unknown[][], max = 30): string {
  const shown = rows.slice(0, max).map((r) => r.map((c) => (c === null || c === undefined ? "" : typeof c === "number" ? formatValue(c) : String(c))));
  const widths = columns.map((c, i) => Math.min(40, Math.max(c.length, ...shown.map((r) => (r[i] ?? "").length))));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").slice(0, 40).padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...shown.map(line), ...(rows.length > max ? [`… ${rows.length - max} more rows`] : [])].join("\n");
}

export const cliQuery = internalAction({
  args: vRemote,
  handler: async (ctx, args): Promise<{ text: string; json: unknown }> => {
    const f = parseFlags(args.args);
    const source = f.pos[0];
    if (!source || !isDataSource(source)) throw new ConvexError(`usage: cast data query <doc> <source> --args '<json>'  (sources: ${DATA_SOURCES.map((s) => s.id).join(", ")})`);
    let qargs: Record<string, unknown> = {};
    if (typeof f.flags.args === "string") {
      try {
        qargs = JSON.parse(f.flags.args);
      } catch {
        throw new ConvexError(`--args must be a JSON object, like '{"days":30}'`);
      }
    }
    const out = await previewAs(ctx, args.user_id, args.doc_id!, { source, args: qargs as any });
    if (out.error) return { text: `${out.query_text}\nerror: ${out.error}`, json: out };
    return { text: [out.query_text, `${out.total} rows · columns: ${out.columns.join(", ")}`, "", table(out.columns, out.rows)].join("\n"), json: out };
  },
});

export const blocksForUser = internalQuery({
  args: { user_id: v.id("users"), doc_id: v.id("docs") },
  handler: async (ctx, args): Promise<{ title: string; elements: ArtifactElement[] }> => {
    const doc = await dashboardDoc(ctx, args.user_id, args.doc_id);
    return { title: doc.title, elements: (await readLiveElements(ctx, args.doc_id, "merged")) as ArtifactElement[] };
  },
});

export const wantAs = internalMutation({
  args: { user_id: v.id("users"), doc_id: v.id("docs"), queries: v.array(vQuery) },
  handler: async (ctx, args): Promise<string[]> => {
    const doc = await dashboardDoc(ctx, args.user_id, args.doc_id);
    return await wantCore(ctx, args.user_id, doc, args.queries as dashboard.DataQuery[], Date.now());
  },
});

export const resultsForUser = internalQuery({
  args: { user_id: v.id("users"), doc_id: v.id("docs") },
  handler: async (ctx, args): Promise<DataResult[]> => {
    await dashboardDoc(ctx, args.user_id, args.doc_id);
    const now = Date.now();
    const rows = await ctx.db.query("data_queries").withIndex("by_doc_qkey", (q) => q.eq("doc_id", args.doc_id)).collect();
    return rows.map((r) => {
      const { _id, doc_id, ...rest } = toResult(r, now);
      return rest;
    });
  },
});

/** What a chart says at a glance, for an agent that can't see it: the largest categories or series and their totals. */
function chartLeaders(ev: Extract<dashboard.ChartEval, { state: "ok" }>): string {
  const fmt = (n: number) => formatValue(n, ev.format === "number" ? "compact" : ev.format);
  // Categories (a ranking): the largest. A line over time: where each series ends (a running total's last point, not a sum of sums). Bars over time: each series' total.
  if (ev.type === "hbar" || (ev.series.length === 1 && ev.type !== "line" && ev.type !== "area")) {
    const top = ev.x.map((x, i): [string, number] => [x, ev.series[0].values[i] ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return `top: ${top.map(([n, v]) => `${n} ${fmt(v)}`).join(", ")}`;
  }
  if (ev.type === "line" || ev.type === "area") {
    return `latest (${ev.x[ev.x.length - 1]}): ${ev.series.slice(0, 5).map((s) => `${s.name} ${fmt([...s.values].reverse().find((v) => v !== null) ?? 0)}`).join(", ")}`;
  }
  const totals = ev.series.map((s): [string, number] => [s.name, s.values.reduce<number>((a, v) => a + (v ?? 0), 0)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `totals: ${totals.map(([n, v]) => `${n} ${fmt(v)}`).join(", ")}`;
}

const MARK: Record<string, string> = { verified: "✓", refreshing: "…", loading: "…", stale: "!", partial: "!", broken: "✗", typed: "?" };

/**
 * Every block's value and check, as the page shows them. Runs any query that
 * has no answer yet (or every one, with --rerun) first and waits for it, so
 * an agent can verify the dashboard before handing it back.
 */
export const cliCheck = internalAction({
  args: vRemote,
  handler: async (ctx, args): Promise<{ text: string; json: unknown }> => {
    const f = parseFlags(args.args, ["rerun"]);
    const docId = args.doc_id!;
    const { title, elements }: { title: string; elements: ArtifactElement[] } = await ctx.runQuery(internal.dataQueries.blocksForUser, { user_id: args.user_id, doc_id: docId });
    const blocks = orderedBlocks(elements);
    const queries = dashboard.dashboardQueries(blocks);
    const leased: string[] = await ctx.runMutation(internal.dataQueries.wantAs, { user_id: args.user_id, doc_id: docId, queries: [...queries.values()] });
    let results: DataResult[] = await ctx.runQuery(internal.dataQueries.resultsForUser, { user_id: args.user_id, doc_id: docId });
    // An agent's check gives a settled verdict: anything due (or missing) is read now and waited for, not left "refreshing".
    for (const [qkey] of queries) {
      const r = results.find((x) => x.qkey === qkey);
      if (f.flags.rerun || leased.includes(qkey) || !r || (!r.refreshed_at && !r.error)) await rerunAs(ctx, args.user_id, docId, qkey).catch(() => null);
    }
    results = await ctx.runQuery(internal.dataQueries.resultsForUser, { user_id: args.user_id, doc_id: docId });
    const byKey = new Map(results.map((r) => [r.qkey, r]));
    const now = Date.now();
    const out = blocks.map((b) => {
      const q = dashboard.blockQuery(b);
      const result = q ? byKey.get(queryKey(q)) : undefined;
      const check = checkBlock(b.kind, b, result, now);
      let value = "";
      if (b.kind === "kpi") {
        const ev = evaluateKpi(b as any, result);
        value = ev.state === "ok" ? `${ev.display}${ev.delta ? ` (${ev.delta.caption})` : ""}  · ${ev.how}` : ev.state === "unbound" ? ev.display : ev.state === "problem" ? ev.problem : "";
      } else if (b.kind === "chart") {
        const ev = evaluateChart(b as any, result);
        value = ev.state === "ok" ? `${ev.series.length} series × ${ev.x.length} points · ${chartLeaders(ev)} · ${ev.how}` : ev.state === "problem" ? ev.problem : "";
      } else if (b.kind === "table") {
        const ev = evaluateTable(b as any, result);
        value = ev.state === "ok" ? ev.how : ev.state === "problem" ? ev.problem : "";
      } else if (b.kind === "text") value = String(b.text ?? "").slice(0, 80);
      return { key: b.key, kind: b.kind, title: b.title ?? null, value, check: check ?? null };
    });
    const lines = out.map((o) => `${o.check ? MARK[o.check.state] ?? " " : " "} ${o.key} ${o.kind}${o.title ? ` "${o.title}"` : ""}  ${o.value}${o.check && o.check.state !== "verified" ? `  [${o.check.label}${o.check.detail ? `: ${o.check.detail}` : ""}]` : ""}`);
    const counts = out.reduce<Record<string, number>>((acc, o) => (o.check ? ((acc[o.check.state] = (acc[o.check.state] ?? 0) + 1), acc) : acc), {});
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "no checked blocks";
    return { text: [`${title}: ${summary}`, ...lines].join("\n"), json: { title, blocks: out, results: results.map((r) => ({ ...r, rows: r.rows.length })) } };
  },
});
