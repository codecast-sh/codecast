// Live data on published pages: the queries a bundle declares in
// cast-data.json, run as the page's publisher inside one workspace, their
// answers cached on page_queries and refreshed when a viewer reads one older
// than its interval. The readers are lib/pageReaders.ts; the HTTP door is the
// page's own serve route (artifactsHttp.ts hands /_data here after the page's
// gates), and the runtime the page loads is lib/castData.ts.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./functions";
import type { ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  PAGE_DATA_LIMITS,
  capResult,
  parsePageDataDeclaration,
  type PageDataResult,
} from "@codecast/shared/contracts/pageData";
import { PAGE_READERS, queryText, type ReaderScope, type FetchDeps, type Table } from "./lib/pageReaders";
import { parseWorkspaceKey, workspaceGrantsAccess } from "./lib/accessKeys";
import { createWorkContext } from "./data";
import { verifyApiToken } from "./apiTokens";
import { runHogql } from "./sources/posthog";
import { appCall } from "./sources/app";

// ── publish: validate, then replace the page's set ──

export type ValidatedQuery = {
  query_id: string;
  position: number;
  title?: string;
  reader: string;
  args_json: string;
  query_text: string;
  refresh_ms: number;
};

/** Whether `owner` may read `workspace`: their own personal key, or a team they belong to. */
async function ownerHolds(ctx: { db: any }, owner: Id<"users">, workspace: string): Promise<boolean> {
  return await workspaceGrantsAccess(ctx, owner, workspace);
}

/**
 * The declaration checked against the registry and the publisher's access.
 * The workspace is the one the file names, else the one the publishing
 * session or the page's directory resolves to (the rule a task create
 * follows). Returns the first problem in words the publisher can act on.
 */
export const validateDeclaration = internalQuery({
  args: {
    owner: v.id("users"),
    declaration: v.any(),
    conversation_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; workspace: string; queries: ValidatedQuery[] } | { ok: false; error: string }> => {
    const parsed = parsePageDataDeclaration(args.declaration);
    if (!parsed.ok) return parsed;
    let workspace = parsed.workspace;
    if (workspace) {
      if (!parseWorkspaceKey(workspace) || !(await ownerHolds(ctx, args.owner, workspace))) {
        return { ok: false, error: `You can't read workspace ${workspace}, so a page of yours can't show it` };
      }
    } else {
      const { db } = await createWorkContext(ctx, { userId: args.owner, conversation_id: args.conversation_id, project_path: args.project_path });
      workspace = db.workspaceKey as string;
    }
    const scope: ReaderScope = { owner: args.owner, workspace };
    const queries: ValidatedQuery[] = [];
    for (const [position, q] of parsed.queries.entries()) {
      const def = PAGE_READERS[q.reader];
      const checked = def.validate(q.args);
      if ("error" in checked) return { ok: false, error: `query "${q.id}" (${q.reader}): ${checked.error}` };
      const problem = def.check ? await def.check(ctx, scope, checked.args) : null;
      if (problem) return { ok: false, error: `query "${q.id}" (${q.reader}): ${problem}` };
      queries.push({
        query_id: q.id,
        position,
        ...(q.title ? { title: q.title } : {}),
        reader: q.reader,
        args_json: JSON.stringify(checked.args),
        query_text: queryText(scope, checked.text),
        refresh_ms: q.refresh_ms,
      });
    }
    return { ok: true, workspace, queries };
  },
});

const validatedQuery = v.object({
  query_id: v.string(),
  position: v.number(),
  title: v.optional(v.string()),
  reader: v.string(),
  args_json: v.string(),
  query_text: v.string(),
  refresh_ms: v.number(),
});

/**
 * A publish's query set becomes the page's whole set. A query whose reader,
 * args, owner and workspace are unchanged keeps its cached answer; anything
 * else starts empty and is refreshed now, so the first viewer finds data.
 */
export const replaceQueries = internalMutation({
  args: { artifact_id: v.id("artifacts"), owner: v.id("users"), workspace: v.string(), queries: v.array(validatedQuery) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing: Doc<"page_queries">[] = await ctx.db.query("page_queries").withIndex("by_artifact", (q) => q.eq("artifact_id", args.artifact_id)).collect();
    const byId = new Map(existing.map((r) => [r.query_id, r]));
    const keep = new Set(args.queries.map((q) => q.query_id));
    for (const row of existing) if (!keep.has(row.query_id)) await ctx.db.delete(row._id);
    for (const q of args.queries) {
      const prev = byId.get(q.query_id);
      const same = prev && prev.reader === q.reader && prev.args_json === q.args_json && prev.workspace === args.workspace && prev.owner_user_id === args.owner;
      if (prev && same) {
        await ctx.db.patch(prev._id, { position: q.position, title: q.title, query_text: q.query_text, refresh_ms: q.refresh_ms, updated_at: now });
        continue;
      }
      const fields = { ...q, owner_user_id: args.owner, workspace: args.workspace, updated_at: now };
      if (prev) {
        await ctx.db.replace(prev._id, { ...fields, artifact_id: args.artifact_id, created_at: prev.created_at });
      } else {
        await ctx.db.insert("page_queries", { ...fields, artifact_id: args.artifact_id, created_at: now });
      }
    }
    await claimStale(ctx, args.artifact_id, null, now);
    return { queries: args.queries.length };
  },
});

// ── refresh on read ──

/** When a row's answer is due again: its interval after the last attempt, or now if never read. */
export function dueAt(row: Pick<Doc<"page_queries">, "refreshed_at" | "attempted_at" | "refresh_ms">): number {
  const last = Math.max(row.refreshed_at ?? 0, row.attempted_at ?? 0);
  return last ? last + Math.max(row.refresh_ms, PAGE_DATA_LIMITS.min_refresh_ms) : 0;
}

/**
 * Lease and schedule one refresh per stale query that has none running. A
 * crowd of viewers lands here together; the first takes the lease inside this
 * transaction and every later one finds it held, so one refresh runs.
 */
async function claimStale(ctx: any, artifactId: Id<"artifacts">, queryId: string | null, now: number): Promise<string[]> {
  const rows: Doc<"page_queries">[] = queryId
    ? await ctx.db.query("page_queries").withIndex("by_artifact", (q: any) => q.eq("artifact_id", artifactId).eq("query_id", queryId)).collect()
    : await ctx.db.query("page_queries").withIndex("by_artifact", (q: any) => q.eq("artifact_id", artifactId)).collect();
  const claimed: string[] = [];
  for (const row of rows) {
    if (dueAt(row) > now) continue;
    if (row.lease_until && row.lease_until > now) continue;
    await ctx.db.patch(row._id, { lease_until: now + PAGE_DATA_LIMITS.lease_ms });
    await ctx.scheduler.runAfter(0, internal.pageData.refresh, { id: row._id });
    claimed.push(row.query_id);
  }
  return claimed;
}

export const claimRefresh = internalMutation({
  args: { artifact_id: v.id("artifacts"), query_id: v.optional(v.string()), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.force) {
      // The owner asked (cast publish data --refresh): due now, but a running refresh still holds.
      const rows = await ctx.db.query("page_queries").withIndex("by_artifact", (q) => (args.query_id ? q.eq("artifact_id", args.artifact_id).eq("query_id", args.query_id) : q.eq("artifact_id", args.artifact_id))).collect();
      for (const row of rows) if (!(row.lease_until && row.lease_until > now)) await ctx.db.patch(row._id, { refreshed_at: undefined, attempted_at: undefined });
    }
    return await claimStale(ctx, args.artifact_id, args.query_id ?? null, now);
  },
});

export const refreshInput = internalQuery({
  args: { id: v.id("page_queries") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    const artifact = await ctx.db.get(row.artifact_id);
    return { row, artifact_alive: !!artifact };
  },
});

/** One page of a database reader, run as the publisher after their access is re-checked. */
export const readPage = internalQuery({
  args: { owner: v.id("users"), workspace: v.string(), reader: v.string(), args_json: v.string(), cursor: v.union(v.string(), v.null()), now: v.number() },
  handler: async (ctx, args) => {
    if (!(await ownerHolds(ctx, args.owner, args.workspace))) throw new Error("The page's publisher can no longer read this workspace");
    const def = PAGE_READERS[args.reader as keyof typeof PAGE_READERS];
    if (!def?.page) throw new Error(`Unknown reader ${args.reader}`);
    return await def.page(ctx, { owner: args.owner, workspace: args.workspace }, JSON.parse(args.args_json), args.cursor, args.now);
  },
});

/** Pages a database reader holds before it gives up: a bound on one refresh's reads. */
const MAX_PAGES = 200;

/** Scope args the source doors take, from a workspace key. */
function sourceScope(scope: ReaderScope) {
  const ws = parseWorkspaceKey(scope.workspace);
  return ws?.type === "team" ? { workspace: "team" as const, team_id: ws.teamId, user_id: scope.owner } : { workspace: "personal" as const, user_id: scope.owner };
}

function fetchDeps(ctx: ActionCtx): FetchDeps {
  return {
    hogql: (scope, source, query) => runHogql(ctx, sourceScope(scope), source, query),
    connector: (scope, source, reader, argsJson) => appCall(ctx, "read", { ...sourceScope(scope), source, name: reader, args_json: argsJson }, fetch),
  };
}

/** Run one query's reader as its publisher: page through the database, or call the outside service. */
export async function runReader(ctx: ActionCtx, row: Pick<Doc<"page_queries">, "reader" | "args_json" | "owner_user_id" | "workspace">, now = Date.now()): Promise<Table> {
  const def = PAGE_READERS[row.reader as keyof typeof PAGE_READERS];
  if (!def) throw new Error(`Unknown reader ${row.reader}`);
  const scope: ReaderScope = { owner: row.owner_user_id, workspace: row.workspace };
  const args = JSON.parse(row.args_json);
  if (def.fetch) {
    if (!(await ctx.runQuery(internal.pageData.ownerStillHolds, scope))) throw new Error("The page's publisher can no longer read this workspace");
    return await def.fetch(fetchDeps(ctx), scope, args);
  }
  const items: unknown[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: { items: unknown[][]; cursor: string | null } = await ctx.runQuery(internal.pageData.readPage, { ...scope, reader: row.reader, args_json: row.args_json, cursor, now });
    items.push(...page.items);
    cursor = page.cursor;
    if (!cursor) return def.fold!(items, args, now);
  }
  throw new Error("This query reads too much; narrow its window");
}

export const ownerStillHolds = internalQuery({
  args: { owner: v.id("users"), workspace: v.string() },
  handler: async (ctx, args) => await ownerHolds(ctx, args.owner, args.workspace),
});

export const refresh = internalAction({
  args: { id: v.id("page_queries") },
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.pageData.refreshInput, { id: args.id });
    if (!input) return;
    if (!input.artifact_alive) {
      await ctx.runMutation(internal.pageData.dropOrphan, { id: args.id });
      return;
    }
    const startedAt = Date.now();
    try {
      const table = await runReader(ctx, input.row, startedAt);
      const capped = capResult(table.columns, table.rows.map(normalizeRow));
      await ctx.runMutation(internal.pageData.storeResult, {
        id: args.id,
        args_json: input.row.args_json,
        result_json: JSON.stringify({ columns: capped.columns, rows: capped.rows }),
        truncated: capped.truncated,
        at: Date.now(),
      });
    } catch (e) {
      await ctx.runMutation(internal.pageData.storeResult, {
        id: args.id,
        args_json: input.row.args_json,
        error: (e instanceof Error ? e.message : String(e)).replace(/^Uncaught (Convex)?Error: /, "").slice(0, 500),
        at: Date.now(),
      });
    }
  },
});

/** Cells a page can show: numbers, strings, booleans and null; anything else as its JSON. */
function normalizeRow(row: unknown[]): unknown[] {
  return row.map((c) => (c === undefined ? null : c === null || ["number", "string", "boolean"].includes(typeof c) ? c : JSON.stringify(c)));
}

export const storeResult = internalMutation({
  args: {
    id: v.id("page_queries"),
    /** The args the refresh ran with: a republish that changed them meanwhile wins. */
    args_json: v.string(),
    result_json: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.args_json !== args.args_json) return;
    if (args.result_json !== undefined) {
      await ctx.db.patch(args.id, { result_json: args.result_json, truncated: args.truncated, refreshed_at: args.at, attempted_at: args.at, error: undefined, lease_until: undefined, updated_at: args.at });
    } else {
      // A failed refresh keeps the last good answer and waits its interval like a good one.
      await ctx.db.patch(args.id, { error: args.error, attempted_at: args.at, lease_until: undefined, updated_at: args.at });
    }
  },
});

export const dropOrphan = internalMutation({
  args: { id: v.id("page_queries") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row && !(await ctx.db.get(row.artifact_id))) await ctx.db.delete(args.id);
  },
});

// ── serving ──

export const forServe = internalQuery({
  args: { artifact_id: v.id("artifacts"), query_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("page_queries")
      .withIndex("by_artifact", (q) => (args.query_id ? q.eq("artifact_id", args.artifact_id).eq("query_id", args.query_id) : q.eq("artifact_id", args.artifact_id)))
      .collect();
    return rows.sort((a, b) => a.position - b.position);
  },
});

/** What a viewer gets for one row: the cached answer, never the args, owner or workspace. */
export function resultView(row: Doc<"page_queries">, now: number): PageDataResult & { id: string; refreshing: boolean } {
  let table: { columns: string[]; rows: unknown[][] } = { columns: [], rows: [] };
  if (row.result_json) {
    try {
      table = JSON.parse(row.result_json);
    } catch {
      /* a corrupt cache reads as empty until the next refresh */
    }
  }
  return {
    id: row.query_id,
    columns: table.columns,
    rows: table.rows,
    refreshed_at: row.refreshed_at ?? 0,
    query_text: row.query_text,
    stale: dueAt(row) <= now,
    refreshing: !!(row.lease_until && row.lease_until > now),
    reader: row.reader,
    refresh_ms: row.refresh_ms,
    ...(row.title ? { title: row.title } : {}),
    ...(row.truncated ? { truncated: true } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

const DATA_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "private, no-store",
  "Access-Control-Allow-Origin": "*",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};

/**
 * GET <page>/_data and <page>/_data/<id>, reached only through the page's
 * serve route after its gates have passed. Serves the cache at once and,
 * when a query is past its interval, starts one leased refresh.
 */
export async function servePageData(ctx: Pick<ActionCtx, "runQuery" | "runMutation">, artifactId: Id<"artifacts">, rest: string): Promise<Response> {
  const queryId = rest.replace(/^\/+|\/+$/g, "") || null;
  if (queryId && !/^[a-z][a-z0-9_-]{0,47}$/.test(queryId)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: DATA_HEADERS });
  const now = Date.now();
  let rows: Doc<"page_queries">[] = await ctx.runQuery(internal.pageData.forServe, { artifact_id: artifactId, ...(queryId ? { query_id: queryId } : {}) });
  if (queryId && !rows.length) return new Response(JSON.stringify({ error: `This page declares no query "${queryId}"` }), { status: 404, headers: DATA_HEADERS });
  if (rows.some((r) => dueAt(r) <= now && !(r.lease_until && r.lease_until > now))) {
    await ctx.runMutation(internal.pageData.claimRefresh, { artifact_id: artifactId, ...(queryId ? { query_id: queryId } : {}) });
    rows = await ctx.runQuery(internal.pageData.forServe, { artifact_id: artifactId, ...(queryId ? { query_id: queryId } : {}) });
  }
  const body = queryId ? resultView(rows[0], now) : { queries: Object.fromEntries(rows.map((r) => [r.query_id, resultView(r, now)])) };
  return new Response(JSON.stringify(body), { status: 200, headers: DATA_HEADERS });
}

// ── the owner's view: cast publish data ──

export const ownerQueries = internalQuery({
  args: { owner: v.id("users"), target: v.string() },
  handler: async (ctx, args) => {
    const bySlug = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", args.target)).first();
    const artifact =
      bySlug && bySlug.user_id === args.owner
        ? bySlug
        : await ctx.db.query("artifacts").withIndex("by_user_path", (q) => q.eq("user_id", args.owner).eq("source_path", args.target)).first();
    if (!artifact) return null;
    const rows = await ctx.db.query("page_queries").withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id)).collect();
    return { artifact_id: artifact._id, slug: artifact.slug, title: artifact.title, rows: rows.sort((a, b) => a.position - b.position) };
  },
});

export const ownerToken = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => (await verifyApiToken(ctx, args.api_token))?.userId ?? null,
});

/**
 * `cast publish data <slug|path> [id] [--refresh]`: the owner's queries with
 * their audit text, workspace and current rows. --refresh runs them now and
 * waits, so an agent can verify a dashboard before sending its link.
 */
export const forCli = action({
  args: { api_token: v.string(), target: v.string(), query_id: v.optional(v.string()), refresh: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<any> => {
    const owner: Id<"users"> | null = await ctx.runQuery(internal.pageData.ownerToken, { api_token: args.api_token });
    if (!owner) throw new Error("Unauthorized");
    const found = await ctx.runQuery(internal.pageData.ownerQueries, { owner, target: args.target });
    if (!found) throw new Error(`No page of yours matches "${args.target}" (cast publish ls)`);
    let rows: Doc<"page_queries">[] = args.query_id ? found.rows.filter((r: Doc<"page_queries">) => r.query_id === args.query_id) : found.rows;
    if (args.query_id && !rows.length) throw new Error(`${found.slug} declares no query "${args.query_id}" (it has: ${found.rows.map((r: Doc<"page_queries">) => r.query_id).join(", ") || "none"})`);
    if (args.refresh) {
      for (const row of rows) {
        const at = Date.now();
        try {
          const table = await runReader(ctx, row, at);
          const capped = capResult(table.columns, table.rows.map(normalizeRow));
          await ctx.runMutation(internal.pageData.storeResult, { id: row._id, args_json: row.args_json, result_json: JSON.stringify({ columns: capped.columns, rows: capped.rows }), truncated: capped.truncated, at: Date.now() });
        } catch (e) {
          await ctx.runMutation(internal.pageData.storeResult, { id: row._id, args_json: row.args_json, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), at: Date.now() });
        }
      }
      const fresh = await ctx.runQuery(internal.pageData.ownerQueries, { owner, target: args.target });
      rows = (fresh?.rows ?? []).filter((r: Doc<"page_queries">) => !args.query_id || r.query_id === args.query_id);
    }
    const now = Date.now();
    return {
      slug: found.slug,
      title: found.title,
      workspace: rows[0]?.workspace ?? null,
      queries: rows.map((r) => ({ ...resultView(r, now), workspace: r.workspace, args: JSON.parse(r.args_json) })),
    };
  },
});
