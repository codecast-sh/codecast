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
  "sheet",
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
  /** The exact call: re-runnable with `cast publish data <page> <id>`. */
  call?: { reader: string; args: Record<string, unknown>; workspace: string };
  /** Older than its interval (a refresh is on its way), or never read. */
  stale: boolean;
  error?: string;
  title?: string;
  reader?: string;
  refresh_ms?: number;
  truncated?: boolean;
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
export function parsePageDataDeclaration(raw: unknown): { ok: true; workspace?: string; queries: NormalizedPageQuery[]; state?: PageStateCollection[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${PAGE_DATA_FILE} must be a JSON object with "queries"` };
  const decl = raw as Record<string, unknown>;
  const queries = decl.queries ?? (decl.state !== undefined ? {} : undefined);
  if (!queries || typeof queries !== "object" || Array.isArray(queries)) return { ok: false, error: `${PAGE_DATA_FILE} needs a "queries" object keyed by query id, or a "state" object` };
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
  const state = parsePageStateDeclaration(decl.state);
  if (!state.ok) return state;
  return { ok: true, ...(workspace ? { workspace } : {}), queries: out, ...(state.collections.length ? { state: state.collections } : {}) };
}

/** A page that reads live data or state gets the data runtime: the two elements, the API, or a motion page's data-cast-data bindings. */
export function pageUsesData(html: string): boolean {
  return /<cast-(chart|stat|agent)[\s>]|\bcast\.(data|subscribe|state|me|agents)\s*\(|\bdata-cast-data\s*=/i.test(html);
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

// ── Page state: collections a page reads and writes, live ──
//
// Declared under "state" in the same file. Each collection says who may read
// it and who may write it; the server stamps every row's author and enforces
// both on every call (convex/pageState.ts). Rows outlive republish and
// rollback: they are the page's data, not its content.

/** Who may read: anyone the page's gates admit, its editors, or its owner alone. */
export const PAGE_STATE_READ = ["viewers", "editors", "owner"] as const;
/** Who may write: anyone the gates admit, a signed-in account, editors, or the owner alone. */
export const PAGE_STATE_WRITE = ["anyone", "signed-in", "editors", "owner"] as const;
export type PageStateRead = (typeof PAGE_STATE_READ)[number];
export type PageStateWrite = (typeof PAGE_STATE_WRITE)[number];

export const PAGE_STATE_LIMITS = {
  collections: 16,
  /** One row's value as JSON. */
  row_bytes: 4_096,
  /** A collection's values together: also the most one list answer carries. */
  collection_bytes: 1_048_576,
  rows: 2_000,
  key_chars: 128,
  /** Writes a minute across the whole page; the page is the unit, because client addresses rotate behind the proxy. */
  writes_per_minute: 120,
} as const;

export interface PageStateCollection {
  id: string;
  read: PageStateRead;
  write: PageStateWrite;
  /** Writers below editor may change and delete only rows they wrote (signed-in authors; anonymous rows are nobody's). */
  own: boolean;
}

export function parsePageStateDeclaration(raw: unknown): { ok: true; collections: PageStateCollection[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, collections: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `"state" must be an object keyed by collection id` };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > PAGE_STATE_LIMITS.collections) return { ok: false, error: `a page can declare at most ${PAGE_STATE_LIMITS.collections} state collections` };
  const out: PageStateCollection[] = [];
  for (const [id, value] of entries) {
    const where = `state "${id}"`;
    if (!QUERY_ID.test(id)) return { ok: false, error: `${where}: ids are lowercase letters, digits, _ and -, starting with a letter` };
    const c = (value ?? {}) as Record<string, unknown>;
    if (typeof c !== "object" || Array.isArray(c)) return { ok: false, error: `${where} must be an object` };
    const read = c.read ?? "viewers";
    const write = c.write ?? "editors";
    if (!(PAGE_STATE_READ as readonly unknown[]).includes(read)) return { ok: false, error: `${where}: "read" is one of ${PAGE_STATE_READ.join(", ")}` };
    if (!(PAGE_STATE_WRITE as readonly unknown[]).includes(write)) return { ok: false, error: `${where}: "write" is one of ${PAGE_STATE_WRITE.join(", ")}` };
    if (c.own !== undefined && typeof c.own !== "boolean") return { ok: false, error: `${where}: "own" is true or false` };
    out.push({ id, read: read as PageStateRead, write: write as PageStateWrite, own: c.own === true });
  }
  return { ok: true, collections: out };
}

/** A value as stored: JSON within the row cap, or the reason it is refused. */
export function encodeStateValue(value: unknown): { json: string } | { error: string } {
  if (value === undefined) return { error: "a row needs a value" };
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { error: "the value is not JSON" };
  }
  if (json === undefined) return { error: "the value is not JSON" };
  if (json.length > PAGE_STATE_LIMITS.row_bytes) return { error: `a row is at most ${PAGE_STATE_LIMITS.row_bytes} bytes of JSON (this one is ${json.length})` };
  return { json };
}
