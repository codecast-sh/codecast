// The MCP registry fetch loop. Parsing lives in @codecast/shared/contracts
// (mcpRegistry.ts) so Convex's catalog refresh reads the same bytes with the
// same function; this file is the network half only.

import { cliFetchRead } from "../cliHttp.js";
export {
  MCP_REGISTRY_BASE_URL,
  OFFICIAL_META_KEY,
  parseRegistryServer,
  parseRegistryPage,
  parseRegistryDetail,
  describeServerSurface,
  browsableServers,
  type McpRegistryPage,
  type McpRegistryServer,
  type McpServerSurface,
} from "@codecast/shared/contracts";
import {
  MCP_REGISTRY_BASE_URL,
  parseRegistryPage,
  parseRegistryDetail,
  type McpRegistryPage,
  type McpRegistryServer,
} from "@codecast/shared/contracts";

/* --------------------------------------------------------------------------
 * Fetching
 * -------------------------------------------------------------------------- */

export interface McpRegistryQuery {
  /** RFC3339. Incremental sync: only servers updated since this instant. */
  updatedSince?: string;
  /** Case-insensitive substring over names and descriptions. */
  search?: string;
  /** Rows per page. The registry's own ceiling applies; 100 is its maximum. */
  limit?: number;
  cursor?: string;
}

export interface McpRegistryOptions extends McpRegistryQuery {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests, and the seam any other catalog would arrive through. */
  fetchImpl?: (url: string) => Promise<Response>;
}

/**
 * The URL for one page.
 *
 * `version=latest` is always sent and cannot be overridden — see the note at the
 * top about what happens without it. Pure, so a test can assert the query string
 * without a server.
 */
export function buildServersUrl(opts: McpRegistryOptions = {}): string {
  const base = (opts.baseUrl ?? MCP_REGISTRY_BASE_URL).replace(/\/+$/, "");
  const params = new URLSearchParams({ version: "latest" });
  if (opts.limit !== undefined && Number.isFinite(opts.limit)) {
    params.set("limit", String(Math.max(1, Math.min(100, Math.floor(opts.limit)))));
  }
  if (opts.updatedSince) params.set("updated_since", opts.updatedSince);
  if (opts.search) params.set("search", opts.search);
  if (opts.cursor) params.set("cursor", opts.cursor);
  return `${base}/v0/servers?${params.toString()}`;
}

/** The URL for one server's current version. */
export function buildServerDetailUrl(name: string, opts: McpRegistryOptions = {}): string {
  const base = (opts.baseUrl ?? MCP_REGISTRY_BASE_URL).replace(/\/+$/, "");
  return `${base}/v0/servers/${encodeURIComponent(name)}/versions/latest`;
}

/** Read a URL as JSON, bounded and total. Uses the CLI's own retrying fetch
 *  (`cliHttp.ts:88-93`), which already gives idempotent reads one retry and a
 *  legible message instead of a raw AbortError. */
async function getJson(
  url: string,
  opts: McpRegistryOptions,
): Promise<{ body?: unknown; error?: string }> {
  const doFetch =
    opts.fetchImpl ??
    ((u: string) =>
      cliFetchRead(
        u,
        { headers: { Accept: "application/json" } },
        opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {},
      ));
  try {
    const response = await doFetch(url);
    if (!response.ok) return { error: `registry returned HTTP ${response.status}` };
    return { body: await response.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "registry request failed" };
  }
}

export interface McpRegistryPageResult {
  page: McpRegistryPage;
  error?: string;
}

/** One page. Never throws: a failure is an empty page plus a phrase. */
export async function fetchRegistryPage(opts: McpRegistryOptions = {}): Promise<McpRegistryPageResult> {
  const { body, error } = await getJson(buildServersUrl(opts), opts);
  if (error) return { page: { servers: [] }, error };
  return { page: parseRegistryPage(body) };
}

/** One server's detail record, or null when it cannot be read. */
export async function fetchRegistryServer(
  name: string,
  opts: McpRegistryOptions = {},
): Promise<{ server: McpRegistryServer | null; error?: string }> {
  const { body, error } = await getJson(buildServerDetailUrl(name, opts), opts);
  if (error) return { server: null, error };
  return { server: parseRegistryDetail(body) };
}

export interface McpRegistryListOptions extends McpRegistryOptions {
  /** Stop after this many pages. Bounds a walk of a catalog that grows without
   *  our say-so, and bounds a server that never stops handing back cursors. */
  maxPages?: number;
}

/**
 * Why the walk ended. `complete` is the only one that means the list holds the
 * whole catalog; the rest all mean it is a prefix, and a caller that renders
 * "247 servers" off a prefix is stating something false.
 */
export type McpRegistryStopReason = "complete" | "page_cap" | "repeated_cursor" | "error";

export interface McpRegistryListResult {
  servers: McpRegistryServer[];
  pagesFetched: number;
  stopReason: McpRegistryStopReason;
  /** True whenever the walk ended for any reason other than reaching the end. */
  truncated: boolean;
  /** The cursor to resume from, when there is one worth resuming. */
  nextCursor?: string;
  /** The newest `updatedAt` seen. Store it and pass it as `updatedSince` next
   *  time: that plus `version=latest` makes a refresh cheap and incremental. */
  newestUpdatedAt?: string;
  /** Set when a page failed. Whatever was collected before is still returned —
   *  a partial catalog beats none. */
  error?: string;
}

export const DEFAULT_MAX_PAGES = 20;

/**
 * Walk the catalog, following cursors.
 *
 * Three independent stops, because the registry cannot be trusted to end the
 * walk on its own: no cursor, the page cap, or a cursor we have already used.
 * The last one matters — an unknown cursor is accepted silently and answers from
 * elsewhere in the catalog, so a bad cursor could otherwise loop forever.
 *
 * Rows are deduplicated by name, keeping the first, which is the belt to
 * `version=latest`'s brace: if a future registry ignores that parameter the way
 * it ignores unknown ones, the caller still gets one row per server.
 */
export async function listRegistryServers(
  opts: McpRegistryListOptions = {},
): Promise<McpRegistryListResult> {
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const byName = new Map<string, McpRegistryServer>();
  const usedCursors = new Set<string>();
  let cursor = opts.cursor;
  let pagesFetched = 0;
  let newestUpdatedAt: string | undefined;
  let error: string | undefined;
  let stopReason: McpRegistryStopReason = "page_cap";

  while (pagesFetched < maxPages) {
    const result = await fetchRegistryPage({ ...opts, cursor });
    pagesFetched += 1;
    if (result.error) {
      error = result.error;
      stopReason = "error";
      break;
    }
    for (const server of result.page.servers) {
      if (!byName.has(server.name)) byName.set(server.name, server);
      if (server.updatedAt && (!newestUpdatedAt || server.updatedAt > newestUpdatedAt)) {
        newestUpdatedAt = server.updatedAt;
      }
    }
    if (cursor) usedCursors.add(cursor);
    const next = result.page.nextCursor;
    if (!next) {
      cursor = undefined;
      stopReason = "complete";
      break;
    }
    if (usedCursors.has(next)) {
      // The registry accepts an unknown cursor silently, so a repeat is the only
      // evidence available that following it again would not advance. The cursor
      // is still reported: a caller may retry it later, it just may not loop on
      // it now.
      cursor = next;
      stopReason = "repeated_cursor";
      break;
    }
    cursor = next;
  }

  return {
    servers: [...byName.values()],
    pagesFetched,
    stopReason,
    truncated: stopReason !== "complete",
    ...(cursor ? { nextCursor: cursor } : {}),
    ...(newestUpdatedAt ? { newestUpdatedAt } : {}),
    ...(error ? { error } : {}),
  };
}

/* --------------------------------------------------------------------------
 * The seam for other directories — deliberately empty
 * -------------------------------------------------------------------------- */

/**
 * Directories we know about and do not read, with the reason.
 *
 * This list is the seam: adding one means writing a `fetchImpl`-shaped reader
 * and a parser that produces `McpRegistryServer`, then normalising through the
 * same functions above. Nothing else in the codebase needs to change. It is
 * written down rather than left implicit so the next person does not spend a day
 * rediscovering why the obvious integrations are missing.
 */
export const UNINTEGRATED_MCP_DIRECTORIES = [
  { name: "Smithery", reason: "terms of use unread" },
  { name: "Glama", reason: "terms of use unread" },
  {
    name: "PulseMCP",
    reason: "open endpoint on a published failure schedule reaching 100% in September 2026; its successor is key gated",
  },
  { name: "mcp.so", reason: "no verifiable API" },
] as const;
