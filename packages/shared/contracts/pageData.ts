// Live data on published pages. A bundle names its queries in cast-data.json;
// the server checks each against the reader registry and the publisher's
// access, keeps a capped result per query, and refreshes it when a viewer asks
// for one older than its interval. The page reads them through window.cast
// (the runtime in convex/lib/castData.ts). One shape for the server, the
// runtime and `cast publish data`.

export const PAGE_DATA_FILE = "cast-data.json";

export const PAGE_DATA_READERS = [
  "tasks",
  "sessions",
  "usage",
  "prs",
  "signals",
  "events",
  "event_groups",
  "metric",
  "hogql",
  "connector",
] as const;
export type PageDataReader = (typeof PAGE_DATA_READERS)[number];

export const PAGE_DATA_LIMITS = {
  queries: 24,
  min_refresh_ms: 60_000,
  default_refresh_ms: 15 * 60_000,
  max_refresh_ms: 24 * 60 * 60_000,
  /** A refresh holds its lease this long; a crashed one frees the query after it. */
  lease_ms: 90_000,
  rows: 2_000,
  result_bytes: 256 * 1024,
  args_bytes: 4_096,
  title_chars: 120,
  max_days: 365,
} as const;

/** One query's answer as the page sees it. */
export interface PageDataResult {
  columns: string[];
  rows: unknown[][];
  /** When the rows were read; 0 before the first refresh lands. */
  refreshed_at: number;
  /** What ran, in words a reader can audit. */
  query_text: string;
  /** Older than its interval (a refresh is on its way), or never read. */
  stale: boolean;
  error?: string;
  title?: string;
  reader?: string;
  refresh_ms?: number;
  truncated?: boolean;
}

export interface PageQueryDeclaration {
  reader: string;
  args?: Record<string, unknown>;
  refresh?: string | number;
  title?: string;
}

export interface PageDataDeclaration {
  queries: Record<string, PageQueryDeclaration>;
  /** team:<id> or user:<id>; absent = the publishing session's workspace. */
  workspace?: string;
}

const QUERY_ID = /^[a-z][a-z0-9_-]{0,47}$/;

/** "90s", "15m", "2h", "1d" or milliseconds → ms, bounded; a string error otherwise. */
export function parseRefresh(raw: string | number | undefined): number | { error: string } {
  if (raw === undefined) return PAGE_DATA_LIMITS.default_refresh_ms;
  let ms: number;
  if (typeof raw === "number") ms = raw;
  else {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
    if (!m) return { error: `refresh "${raw}" is not a duration like 5m, 1h or 1d` };
    ms = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
  }
  if (!Number.isFinite(ms) || ms < PAGE_DATA_LIMITS.min_refresh_ms) return { error: `refresh must be at least 1m` };
  if (ms > PAGE_DATA_LIMITS.max_refresh_ms) return { error: `refresh must be at most 1d` };
  return Math.round(ms);
}

export interface NormalizedPageQuery {
  id: string;
  reader: PageDataReader;
  args: Record<string, unknown>;
  refresh_ms: number;
  title?: string;
}

/**
 * The declaration's shape, checked before anything reads data: ids, readers,
 * refresh intervals and sizes. Each reader's own args are the registry's to
 * check (convex/lib/pageReaders.ts), because only the server knows them.
 */
export function parsePageDataDeclaration(raw: unknown): { ok: true; workspace?: string; queries: NormalizedPageQuery[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${PAGE_DATA_FILE} must be a JSON object with "queries"` };
  const decl = raw as Record<string, unknown>;
  const queries = decl.queries;
  if (!queries || typeof queries !== "object" || Array.isArray(queries)) return { ok: false, error: `${PAGE_DATA_FILE} needs a "queries" object keyed by query id` };
  const entries = Object.entries(queries as Record<string, unknown>);
  if (entries.length > PAGE_DATA_LIMITS.queries) return { ok: false, error: `a page can declare at most ${PAGE_DATA_LIMITS.queries} queries (this one has ${entries.length})` };
  let workspace: string | undefined;
  if (decl.workspace !== undefined) {
    if (typeof decl.workspace !== "string" || !/^(team|user):[a-z0-9]+$/i.test(decl.workspace)) {
      return { ok: false, error: `"workspace" must be team:<id> or user:<id>` };
    }
    workspace = decl.workspace;
  }
  const out: NormalizedPageQuery[] = [];
  for (const [id, value] of entries) {
    const where = `query "${id}"`;
    if (!QUERY_ID.test(id)) return { ok: false, error: `${where}: ids are lowercase letters, digits, _ and -, starting with a letter` };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `${where} must be an object with a "reader"` };
    const q = value as Record<string, unknown>;
    if (typeof q.reader !== "string" || !(PAGE_DATA_READERS as readonly string[]).includes(q.reader)) {
      return { ok: false, error: `${where}: unknown reader ${JSON.stringify(q.reader ?? null)} (readers: ${PAGE_DATA_READERS.join(", ")})` };
    }
    const args = q.args ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) return { ok: false, error: `${where}: "args" must be an object` };
    if (JSON.stringify(args).length > PAGE_DATA_LIMITS.args_bytes) return { ok: false, error: `${where}: args are over ${PAGE_DATA_LIMITS.args_bytes} bytes` };
    const refresh = parseRefresh(q.refresh as string | number | undefined);
    if (typeof refresh !== "number") return { ok: false, error: `${where}: ${refresh.error}` };
    if (q.title !== undefined && typeof q.title !== "string") return { ok: false, error: `${where}: "title" must be a string` };
    out.push({
      id,
      reader: q.reader as PageDataReader,
      args: args as Record<string, unknown>,
      refresh_ms: refresh,
      ...(q.title ? { title: (q.title as string).slice(0, PAGE_DATA_LIMITS.title_chars) } : {}),
    });
  }
  return { ok: true, ...(workspace ? { workspace } : {}), queries: out };
}

/** A page that reads live data gets the data runtime: the two elements, the API, or a motion page's data-cast-data bindings. */
export function pageUsesData(html: string): boolean {
  return /<cast-(chart|stat)[\s>]|\bcast\.(data|subscribe)\s*\(|\bdata-cast-data\s*=/i.test(html);
}

/**
 * Rows cut to the row cap and to `maxBytes` of JSON by dropping from the end,
 * so a result is always valid and says whether it lost rows.
 */
export function capResult(columns: string[], rows: unknown[][], maxBytes: number = PAGE_DATA_LIMITS.result_bytes): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  let kept = rows.length > PAGE_DATA_LIMITS.rows ? rows.slice(0, PAGE_DATA_LIMITS.rows) : rows;
  const size = (r: unknown[][]) => JSON.stringify({ columns, rows: r }).length;
  if (size(kept) > maxBytes) {
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(kept.slice(0, mid)) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    kept = kept.slice(0, lo);
  }
  return { columns, rows: kept, truncated: kept.length < rows.length };
}
