// A client for the official MCP registry — the one public catalog worth reading.
//
// `https://registry.modelcontextprotocol.io` is open, needs no credentials, and
// supports incremental sync (`updated_since`) plus cursor pagination. We mirror
// its metadata and keep its provenance block; we never republish it as ours.
//
// The module is split in two on purpose. Everything above "Fetching" is pure
// parsing and normalising, so the shapes can be tested against recorded
// responses with no network at all (`__fixtures__/mcp-registry-page-*.json`).
// Everything below is one bounded fetch and one cursor loop, both total: a slow,
// missing or malformed registry yields an empty list and a phrase saying why.
//
// Verified live, 2026-08-13 (and recorded into the fixtures):
//
//   * `?version=latest` is MANDATORY. Without it the registry returns one row
//     per VERSION: a plain `?limit=100` gave 100 rows holding 65 distinct
//     servers, with duplicates split across page boundaries so per page dedupe
//     would not save it.
//   * Unknown query parameters are IGNORED, not rejected. `?isLatest=true`
//     returns 200 and behaves exactly like a bogus parameter, so a wrong
//     parameter name fails as duplicate rows rather than as an error. The list
//     loop therefore dedupes by name as a belt to that brace, and the tests
//     assert uniqueness.
//   * An invalid cursor is ALSO accepted silently and answers from somewhere
//     else in the catalog, so the loop stops on a repeated cursor and caps its
//     pages rather than trusting the server to end the walk.
//   * `status` is `active` or `deprecated`; the `_meta` key is the full
//     reverse-DNS string and must be looked up literally.
//   * A server may declare `remotes` (a URL), `packages` (something to run), or
//     neither. Nothing may assume a URL exists.
//
// Identity is not minted here, for the same reason as `nativeCatalog.ts`: the
// capability slug is built by the ingest layer from a source it determined
// itself (`formatCapabilitySlug`, `packages/shared/contracts/capabilities.ts`).
// This module reports the registry's own namespaced name, which is the fact.

import { cliFetchRead } from "../cliHttp.js";

export const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

/** The `_meta` block the official registry attaches. A literal key: the leading
 *  segment is a reverse-DNS namespace, and a prefix guess would match a
 *  different registry's block one day. */
const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";

/* --------------------------------------------------------------------------
 * Shapes
 * -------------------------------------------------------------------------- */

/** Publication status. `unknown` covers a value the registry adds later — a new
 *  status must not silently read as `active`. */
export type McpServerStatus = "active" | "deprecated" | "deleted" | "unknown";

/** A way to reach a running server over the network. */
export interface McpRemote {
  /** `streamable-http` or `sse`. */
  type: string;
  url: string;
  /** True when the server declares a header the caller must supply — an API key
   *  in practice. The library shows it before anyone installs, because it is the
   *  difference between "works" and "works once you have an account". */
  requiresAuth: boolean;
}

/** Something the user's machine would install and run locally. */
export interface McpPackage {
  /** `npm`, `pypi`, `oci`, … */
  registryType: string;
  identifier: string;
  version?: string;
  /** `stdio` or a network transport. */
  transport: string;
  /** Names only — the registry publishes descriptions of the variables, never
   *  values, and a name is what a consent screen needs to list. */
  requiredEnv: string[];
}

export interface McpRegistryServer {
  /** The namespaced identity (`ai.smithery/foo`, `io.github.bar/baz`). Stable;
   *  `title` is a label and may be missing. */
  name: string;
  title?: string;
  description?: string;
  version?: string;
  status: McpServerStatus;
  /** Why a deprecated server was deprecated, when the publisher said. */
  statusMessage?: string;
  isLatest: boolean;
  publishedAt?: string;
  updatedAt?: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  remotes: McpRemote[];
  packages: McpPackage[];
}

export interface McpRegistryPage {
  servers: McpRegistryServer[];
  /** Absent on the last page. A `name:version` string, not opaque. */
  nextCursor?: string;
}

/* --------------------------------------------------------------------------
 * Parsing
 * -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function statusOf(value: unknown): McpServerStatus {
  return value === "active" || value === "deprecated" || value === "deleted" ? value : "unknown";
}

function parseRemotes(value: unknown): McpRemote[] {
  if (!Array.isArray(value)) return [];
  const out: McpRemote[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const url = text(raw.url);
    if (!url) continue;
    const headers = Array.isArray(raw.headers) ? raw.headers : [];
    out.push({
      type: text(raw.type) ?? "streamable-http",
      url,
      requiresAuth: headers.some((h) => isRecord(h) && (h.isRequired === true || h.isSecret === true)),
    });
  }
  return out;
}

function parsePackages(value: unknown): McpPackage[] {
  if (!Array.isArray(value)) return [];
  const out: McpPackage[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const identifier = text(raw.identifier);
    if (!identifier) continue;
    const env = Array.isArray(raw.environmentVariables) ? raw.environmentVariables : [];
    const transport = isRecord(raw.transport) ? text(raw.transport.type) : undefined;
    const version = text(raw.version);
    out.push({
      registryType: text(raw.registryType) ?? "unknown",
      identifier,
      ...(version ? { version } : {}),
      transport: transport ?? "stdio",
      requiredEnv: env
        .map((e) => (isRecord(e) ? text(e.name) : undefined))
        .filter((n): n is string => n !== undefined),
    });
  }
  return out;
}

/**
 * One `{server, _meta}` entry. Returns null when it carries no usable identity,
 * so one broken row drops instead of breaking a page.
 */
export function parseRegistryServer(raw: unknown): McpRegistryServer | null {
  if (!isRecord(raw)) return null;
  const server = isRecord(raw.server) ? raw.server : undefined;
  if (!server) return null;
  const name = text(server.name);
  if (!name) return null;

  const meta = isRecord(raw._meta) && isRecord(raw._meta[OFFICIAL_META_KEY])
    ? (raw._meta[OFFICIAL_META_KEY] as Record<string, unknown>)
    : {};

  const title = text(server.title);
  const description = text(server.description);
  const version = text(server.version);
  const statusMessage = text(meta.statusMessage);
  const publishedAt = text(meta.publishedAt);
  const updatedAt = text(meta.updatedAt);
  const repositoryUrl = isRecord(server.repository) ? text(server.repository.url) : undefined;
  const websiteUrl = text(server.websiteUrl);

  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    status: statusOf(meta.status),
    ...(statusMessage ? { statusMessage } : {}),
    // Absent means the registry did not say, and the safe reading of "did not
    // say" is not-latest: it keeps an unlabelled row out of a list that claims
    // to hold current versions only.
    isLatest: meta.isLatest === true,
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    remotes: parseRemotes(server.remotes),
    packages: parsePackages(server.packages),
  };
}

/** A `/v0/servers` response. Total: anything unrecognised yields an empty page
 *  rather than an exception, and rows that fail to parse are simply absent. */
export function parseRegistryPage(raw: unknown): McpRegistryPage {
  if (!isRecord(raw) || !Array.isArray(raw.servers)) return { servers: [] };
  const servers: McpRegistryServer[] = [];
  for (const entry of raw.servers) {
    const parsed = parseRegistryServer(entry);
    if (parsed) servers.push(parsed);
  }
  const cursor = isRecord(raw.metadata) ? text(raw.metadata.nextCursor) : undefined;
  return { servers, ...(cursor ? { nextCursor: cursor } : {}) };
}

/** The detail endpoint returns a single `{server, _meta}` object rather than a
 *  page, so it needs its own entry point even though the row shape is identical. */
export function parseRegistryDetail(raw: unknown): McpRegistryServer | null {
  return parseRegistryServer(raw);
}

/**
 * How a server would run, in the structural terms the shared execution-surface
 * vocabulary uses (`EXECUTION_SURFACES`, `packages/shared/contracts/capabilities.ts`).
 *
 * Reported as facts rather than as `ExecutionSurface` values: the ingest layer
 * owns that mapping (`remote` → `mcp_remote_url`, `stdioCommand` →
 * `mcp_stdio_command`) and classifying a capability there keeps one place
 * deciding what is dangerous. Derived structurally from what the publisher had
 * to populate for the server to work, never from anything they assert.
 */
export function describeServerSurface(server: McpRegistryServer): {
  remote: boolean;
  stdioCommand: boolean;
  requiresSecrets: boolean;
} {
  return {
    remote: server.remotes.length > 0,
    stdioCommand: server.packages.some((p) => p.transport === "stdio"),
    requiresSecrets:
      server.remotes.some((r) => r.requiresAuth) || server.packages.some((p) => p.requiredEnv.length > 0),
  };
}

/** Servers a browse list should show by default. A deprecated entry rendered as
 *  a normal suggestion is a product defect, so filtering is a named function
 *  rather than a condition copied into each caller. */
export function browsableServers(servers: McpRegistryServer[]): McpRegistryServer[] {
  return servers.filter((s) => s.status === "active");
}

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
