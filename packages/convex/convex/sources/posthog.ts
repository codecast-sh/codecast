// The PostHog adapter (docs/architecture/external-data.md X7). PostHog stays
// the analytics product: codecast keeps watched metrics, not events. This
// module is the PostHog side of three things:
//
//   - a watch's value: a HogQL query (POST /query/) or a saved insight, read
//     to one number for metrics.ts, which folds it into a metric group;
//   - `cast metrics query "<hogql>"`: a passthrough that returns rows to the
//     caller, capped at PASSTHROUGH_MAX_BYTES, and stores nothing;
//   - recordings: listed from the API, and one imported the first time it is
//     read (snapshots -> rrweb events, then vendorReplay.importVendorRecording:
//     fromRrweb -> replays.importExternal, shared with Sentry's replays).
//
// The token never leaves the backend. Every call goes to the host the
// connection was validated against (tokenConnectors.ts), never to a host a
// source's config names: anyone who may edit a source could otherwise point a
// team's key at their own server.
import { v } from "convex/values";
import { strFromU8, strToU8 } from "fflate";
import { action, internalAction, internalQuery } from "../functions";
import type { ActionCtx } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { invalidScope } from "../lib/auth";
import { scopeArgs, scopeOf, sourceByRef, type ScopeArgs } from "../ingest";
import { gunzipCapped, REPLAY_CHUNK_MAX_INFLATED_BYTES } from "../replays";
import { importVendorRecording, VendorCallError, type ImportOutcome, type VendorRecording } from "./vendorReplay";
import { connectionIdForSource, tokenFor, type FetchLike } from "../tokenConnectors";
import { isTokenRefusal } from "../lib/sourceHealth";
import { tokenHttp } from "../lib/tokenHttp";
import { historyInstants, type HistorySpan } from "../lib/ingestGroups";
import { METRIC_NO_HISTORY, METRIC_WATCH_LIMITS, PASSTHROUGH_MAX_BYTES, POSTHOG_PROJECT_ID } from "@codecast/shared/contracts/ingest";
import type { RrwebEvent } from "@codecast/shared/replay";
import { cleanUrl } from "@codecast/shared/contracts/replay";

const FETCH_TIMEOUT_MS = 30_000;
/** What a query answer may be before trimming to PASSTHROUGH_MAX_BYTES; past it the caller is told to add a LIMIT. */
const QUERY_READ_MAX_BYTES = 4 * 1024 * 1024;
/** A watch reads one number; its answer is small or wrong. */
const VALUE_READ_MAX_BYTES = 1024 * 1024;
const LIST_READ_MAX_BYTES = 2 * 1024 * 1024;
/** Every snapshot blob of one recording together, compressed text as received. */
const SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
const SNAPSHOT_MAX_BLOBS = 60;
/**
 * blob_v2 keys read in one call. PostHog refuses a wider range from a personal
 * key, and its snapshot throttle counts calls (12 a minute, 60 an hour on the
 * free tier), so a recording costs one call per this many blobs, not per blob.
 */
export const SNAPSHOT_BLOBS_PER_READ = 20;
export const RECORDINGS_LIST_MAX = 100;

// PostHog recording ids are UUIDs; insight refs are numeric ids or 8 character
// short ids. Checked so a value can never steer a request to another path.
const RECORDING_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INSIGHT_REF = /^(\d{1,12}|[A-Za-z0-9_-]{1,32})$/;
/** A relative PostHog date ("-7d", "-24h", "mStart") or an ISO date. */
const DATE_FILTER = /^(-?\d{1,4}[hdwmy]|[a-zA-Z]{1,12}|\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?)$/;

// ── Connection ──

export interface PostHogConn {
  token: string;
  host: string;
  project_id: string;
}

/**
 * Where calls go: the connection's validated host, and the source's project
 * when it names one (one key may read several projects), else the
 * connection's. A source project that is not a PostHog id is refused, never
 * swapped for the connection's: that would read another project quietly.
 */
export function posthogConn(cred: { token: string; config: Record<string, string> }, sourceConfig?: { project_id?: string } | null): PostHogConn | { error: string } {
  const host = cred.config.host;
  const own = sourceConfig?.project_id;
  if (own && !POSTHOG_PROJECT_ID.test(own)) return { error: `PostHog project id must be a number, got "${own}"` };
  const project = own || cred.config.project_id;
  if (!host || !project) return { error: "The PostHog connection has no host or project id: reconnect PostHog" };
  return { token: cred.token, host, project_id: project };
}

export type PostHogAnswer = { ok: true; text: string } | PostHogFailure;
export type PostHogFailure = { ok: false; error: string; status?: number; retry_after_ms?: number };

function detailOf(text: string): string | null {
  try {
    const j = JSON.parse(text);
    const d = j?.detail ?? j?.error ?? j?.message;
    return typeof d === "string" ? d.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * One call to the project's API. Redirects are not followed (the token stays
 * on the host it was validated for), the answer is read up to `maxBytes`, and
 * every error is safe to show: none carries the token. PostHog's own `detail`
 * comes through on a 4xx, because a HogQL syntax error is the useful part.
 */
export async function posthogRequest(
  conn: PostHogConn,
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; maxBytes: number },
  fetchImpl: FetchLike = fetch,
): Promise<PostHogAnswer> {
  const res = await tokenHttp(fetchImpl, {
    url: `${conn.host}/api/projects/${conn.project_id}${path}`,
    method: opts.method ?? "GET",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    token: conn.token,
    maxBytes: opts.maxBytes,
    timeoutMs: FETCH_TIMEOUT_MS,
    vendor: "PostHog",
  });
  if (res.failure) return { ok: false, ...(res.status ? { status: res.status } : {}), error: res.error! };
  const text = res.text ?? "";
  const detail = detailOf(text);
  if (isTokenRefusal(res.status)) return { ok: false, status: res.status, error: `PostHog refused the token (${res.status})${detail ? `: ${detail}` : ""}` };
  if (!res.ok) return { ok: false, status: res.status, error: `PostHog answered ${res.status}${detail ? `: ${detail}` : ""}`, ...(res.retry_after_ms !== undefined ? { retry_after_ms: res.retry_after_ms } : {}) };
  return { ok: true, text };
}

function parseJson(answer: PostHogAnswer): { ok: true; body: any } | PostHogFailure {
  if (!answer.ok) return answer;
  try {
    return { ok: true, body: JSON.parse(answer.text) };
  } catch {
    return { ok: false, error: "PostHog's answer is not JSON" };
  }
}

/** The body POST /query/ takes for a HogQL query. */
export function hogqlBody(query: string) {
  return { query: { kind: "HogQLQuery", query } };
}

// ── Metric values ──

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The first cell of the first row of a HogQL answer, as a number. A watch's query returns one number. */
export function hogqlScalar(body: any): number | null {
  const row = Array.isArray(body?.results) ? body.results[0] : null;
  return Array.isArray(row) ? numeric(row[0]) : numeric(row);
}

/**
 * One number from a saved insight's cached result. Trends answer a list of
 * series: the first series' aggregated value (a "number" display) or its
 * latest point. A HogQL-backed insight answers rows, read like a query.
 */
export function insightScalar(insight: any): number | null {
  const result = insight?.result ?? insight?.results;
  if (!Array.isArray(result) || !result.length) return null;
  const first = result[0];
  if (Array.isArray(first)) return numeric(first[0]);
  if (first && typeof first === "object") {
    const agg = numeric(first.aggregated_value);
    if (agg !== null) return agg;
    if (Array.isArray(first.data) && first.data.length) return numeric(first.data[first.data.length - 1]);
    return numeric(first.count);
  }
  return numeric(first);
}

/**
 * The series a watch's value is the latest point of, as dated points, oldest
 * first: a trends insight's first series (`data` beside `days`). Null when the
 * value is not a point of a series (an aggregated number, a HogQL table), so
 * history is never in other units than the polled value.
 */
export function insightSeries(insight: any): { at: number; value: number }[] | null {
  const result = insight?.result ?? insight?.results;
  const first = Array.isArray(result) ? result[0] : null;
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  if (numeric(first.aggregated_value) !== null) return null;
  const data: unknown[] = Array.isArray(first.data) ? first.data : [];
  const days: unknown[] = Array.isArray(first.days) ? first.days : [];
  if (!data.length || days.length !== data.length) return null;
  const points: { at: number; value: number }[] = [];
  data.forEach((raw, i) => {
    const value = numeric(raw);
    // "2026-09-07" or "2026-09-07 13:00:00", read as UTC.
    const day = typeof days[i] === "string" ? (days[i] as string).trim().replace(" ", "T") : "";
    const at = Date.parse(day.length === 10 ? `${day}T00:00:00Z` : /[zZ]|[+-]\d\d:?\d\d$/.test(day) ? day : `${day}Z`);
    if (value !== null && Number.isFinite(at)) points.push({ at, value });
  });
  return points.length ? points.sort((a, b) => a.at - b.at) : null;
}

/** The path of a saved insight with a fresh result: a numeric id directly, a short id through the list filter. */
export function insightPath(ref: string): string {
  const r = ref.trim();
  return /^\d+$/.test(r)
    ? `/insights/${r}/?refresh=blocking`
    : `/insights/?short_id=${encodeURIComponent(r)}&refresh=blocking`;
}

export function validWatchQuery(kind: "hogql" | "insight", query: string): string | null {
  const q = query.trim();
  if (!q) return kind === "hogql" ? "A HogQL watch needs a query" : "An insight watch needs an insight id";
  if (q.length > METRIC_WATCH_LIMITS.query_chars) return `The query is over ${METRIC_WATCH_LIMITS.query_chars} characters`;
  if (kind === "insight" && !INSIGHT_REF.test(q)) return `"${q.slice(0, 40)}" is not a PostHog insight id or short id`;
  return null;
}

/** A watch's current value, or why there is none. */
export async function fetchMetricValue(
  conn: PostHogConn,
  watch: Pick<Doc<"metric_watches">, "query_kind" | "query">,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; value: number } | PostHogFailure> {
  if (watch.query_kind === "hogql") {
    const parsed = parseJson(await posthogRequest(conn, "/query/", { method: "POST", body: hogqlBody(watch.query), maxBytes: VALUE_READ_MAX_BYTES }, fetchImpl));
    if (!parsed.ok) return parsed;
    const value = hogqlScalar(parsed.body);
    return value === null ? { ok: false, error: "The query returned no number in its first cell" } : { ok: true, value };
  }
  if (watch.query_kind === "insight") {
    const insight = await readInsight(conn, watch.query, fetchImpl);
    if (!insight.ok) return insight;
    const value = insightScalar(insight.insight);
    return value === null ? { ok: false, error: "The insight's result has no number to watch" } : { ok: true, value };
  }
  return { ok: false, error: `A PostHog source cannot poll a ${watch.query_kind} watch` };
}

/** A saved insight with a fresh result, by numeric id or short id. */
async function readInsight(conn: PostHogConn, ref: string, fetchImpl: FetchLike): Promise<{ ok: true; insight: any } | { ok: false; status?: number; error: string }> {
  const parsed = parseJson(await posthogRequest(conn, insightPath(ref), { maxBytes: VALUE_READ_MAX_BYTES }, fetchImpl));
  if (!parsed.ok) return parsed;
  const insight = /^\d+$/.test(ref.trim()) ? parsed.body : parsed.body?.results?.[0];
  return insight ? { ok: true, insight } : { ok: false, error: `PostHog has no insight ${ref}` };
}

// ── Binding now() (metric history) ──

/** Clock reads other than now(): a query using one cannot be moved to a past instant. */
const OTHER_CLOCKS = /\b(today|yesterday|now64|nowInBlock|current_timestamp|current_date|currentDate|currentTimestamp|localtimestamp|utc_timestamp|unix_timestamp)\b/i;
const UNIT_MS: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 7 * 864e5, month: 30 * 864e5, quarter: 91 * 864e5, year: 365 * 864e5 };
const UNITS = "second|minute|hour|day|week|month|quarter|year";
/** `<column> <op> ` right before a now(). */
const BEFORE_NOW = /([A-Za-z_][\w.]*)\s*(>=|<=|>|<)\s*$/;
/** What may come before a column compared against now(): the start, a paren, a comma, or a clause or boolean word. */
const COMPARISON_OPENS = /(^|[(,]|\b(?:and|or|not|where|prewhere|having|on|when|then|else))\s*$/i;
/** An optional ` - interval N unit` (or toIntervalUnit(N)) right after a now(). */
const AFTER_NOW = new RegExp(`^\\s*-\\s*(?:interval\\s+(\\d+)\\s+(${UNITS})s?\\b|toInterval(${UNITS})\\s*\\(\\s*(\\d+)\\s*\\))`, "i");

/**
 * The query with string literals, quoted names and comments blanked to
 * spaces at the same offsets, so a search sees only code. Null when a quote
 * or comment never closes.
 */
export function hogqlCodeOnly(q: string): string | null {
  let out = "";
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (; j < q.length; j++) {
        if (q[j] === "\\") j++;
        else if (q[j] === c) {
          if (q[j + 1] === c) j++;
          else break;
        }
      }
      if (j >= q.length) return null;
      out += " ".repeat(j + 1 - i);
      i = j + 1;
    } else if (c === "-" && q[i + 1] === "-") {
      const end = q.indexOf("\n", i);
      const j = end === -1 ? q.length : end;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && q[i + 1] === "*") {
      const end = q.indexOf("*/", i + 2);
      if (end === -1) return null;
      out += " ".repeat(end + 2 - i);
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A past instant as HogQL reads it: second precision, UTC. */
export function hogqlInstant(at: number): string {
  return `toDateTime('${new Date(Math.floor(at / 1000) * 1000).toISOString().replace(".000Z", "Z")}')`;
}

export type BoundQuery = { ok: true; query: string; window_ms: number | null } | { ok: false; error: string };

/**
 * A HogQL watch query as it would have read at `at`: every now() becomes a
 * fixed instant. Only a now() compared straight against a column
 * (`timestamp > now() - interval 1 day`, `timestamp < now()`) is bound; a
 * lower bound also gains `<column> <= <instant>`, because the window the
 * query names must end at the instant, not at the present. Anything else
 * that reads the clock is refused, since binding it would quietly answer a
 * different question. `window_ms` is the longest lower-bound window, so the
 * caller can space points by it.
 */
export function bindHogqlNow(query: string, at: number): BoundQuery {
  const code = hogqlCodeOnly(query);
  if (code === null) return { ok: false, error: "The query has an unclosed quote or comment" };
  const clock = OTHER_CLOCKS.exec(code);
  if (clock) return { ok: false, error: `The query reads the clock through ${clock[1]}(), which cannot be moved to a past instant; use now()` };
  const instant = hogqlInstant(at);
  const edits: { start: number; end: number; text: string }[] = [];
  let window: number | null = null;
  const calls = /\bnow\s*\(/gi;
  for (let m = calls.exec(code); m; m = calls.exec(code)) {
    // The original text, not the blanked one: now('UTC') blanks to now(     ).
    const close = /^\s*\)/.exec(query.slice(m.index + m[0].length));
    if (!close) return { ok: false, error: "now() with an argument cannot be bound to a past instant" };
    const nowEnd = m.index + m[0].length + close[0].length;
    const before = BEFORE_NOW.exec(code.slice(0, m.index));
    const after = AFTER_NOW.exec(code.slice(nowEnd));
    const end = nowEnd + (after ? after[0].length : 0);
    const start = m.index - (before?.[0].length ?? 0);
    // The comparison must stand alone: anything but a clause or a boolean
    // before the column, or arithmetic after the bound, makes it another one.
    const next = code.slice(end).trimStart()[0];
    if (!before || !COMPARISON_OPENS.test(code.slice(0, start)) || (next && "+-*/%(".includes(next))) {
      return { ok: false, error: "Only a now() compared straight against a column (timestamp > now() - interval 1 day) can be bound to a past instant" };
    }
    const [, column, op] = before;
    const shift = query.slice(nowEnd, end);
    if (op.startsWith(">")) {
      const n = after ? Number(after[1] ?? after[4]) : 0;
      const unit = (after?.[2] ?? after?.[3] ?? "").toLowerCase();
      if (after) window = Math.max(window ?? 0, n * UNIT_MS[unit]);
      edits.push({ start, end, text: `(${column} ${op} ${instant}${shift} AND ${column} <= ${instant})` });
    } else {
      edits.push({ start: m.index, end: nowEnd, text: instant });
    }
  }
  if (!edits.length) return { ok: false, error: "The query has no now() to bind, so every past instant would read the same" };
  let out = query;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { ok: true, query: out, window_ms: window };
}

/** How many times one past instant is asked again after PostHog says to slow down or that it is busy. */
const HISTORY_RETRIES = 4;
const HISTORY_RETRY_MAX_MS = 15_000;

/**
 * The past values PostHog holds for a watch, oldest first, so it starts with
 * a history instead of one point per poll. An insight answers its own dated
 * series. A HogQL watch is asked again at each past instant with now() bound
 * to it (bindHogqlNow), through the same read a poll makes. A read that
 * stops partway keeps what it has and says why in `note`.
 */
export async function fetchMetricHistory(
  conn: PostHogConn,
  watch: Pick<Doc<"metric_watches">, "query_kind" | "query">,
  span: HistorySpan,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: true; points: { at: number; value: number }[]; note?: string } | { ok: false; status?: number; error: string }> {
  if (watch.query_kind === "insight") {
    const insight = await readInsight(conn, watch.query, fetchImpl);
    if (!insight.ok) return insight;
    const points = insightSeries(insight.insight);
    return points ? { ok: true, points } : { ok: false, error: METRIC_NO_HISTORY.aggregate };
  }
  const check = bindHogqlNow(watch.query, span.now);
  if (!check.ok) return { ok: false, error: check.error };
  const instants = historyInstants(span, check.window_ms);
  if (!instants.length) return { ok: false, error: METRIC_NO_HISTORY.covered };
  const points: { at: number; value: number }[] = [];
  // Newest first, so a read cut short still joins the polled points.
  for (const at of instants.reverse()) {
    const bound = bindHogqlNow(watch.query, at);
    if (!bound.ok) return { ok: false, error: bound.error };
    let read = await fetchMetricValue(conn, { query_kind: "hogql", query: bound.query }, fetchImpl);
    // 429 is a rate limit and 503 is PostHog's "queries are a little too busy": both pass.
    for (let tries = 0; !read.ok && (read.status === 429 || read.status === 503) && tries < HISTORY_RETRIES; tries++) {
      await sleep(Math.min(read.retry_after_ms ?? 5000 * 2 ** tries, HISTORY_RETRY_MAX_MS));
      read = await fetchMetricValue(conn, { query_kind: "hogql", query: bound.query }, fetchImpl);
    }
    if (!read.ok) {
      if (!points.length || isTokenRefusal(read.status)) return read;
      return { ok: true, points: points.reverse(), note: `Stopped after ${points.length} past values: ${read.error}` };
    }
    points.push({ at, value: read.value });
  }
  return { ok: true, points: points.reverse() };
}

// ── The passthrough query ──

/**
 * A query answer cut to `max` bytes of JSON by dropping rows from the end,
 * so the caller always gets valid rows and is told how many it did not get.
 */
export function capRows(body: any, max: number = PASSTHROUGH_MAX_BYTES) {
  const results: unknown[] = Array.isArray(body?.results) ? body.results : [];
  const base = { columns: Array.isArray(body?.columns) ? body.columns : [], types: Array.isArray(body?.types) ? body.types : undefined };
  const size = (rows: unknown[]) => new TextEncoder().encode(JSON.stringify({ ...base, results: rows })).length;
  if (size(results) <= max) return { ...base, results, rows: results.length, truncated: false };
  // The largest prefix that fits, by bisection: a row can be any size.
  let lo = 0;
  let hi = results.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(results.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return { ...base, results: results.slice(0, lo), rows: results.length, truncated: true };
}

// ── Recordings ──

export interface RecordingRow {
  id: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  distinct_id: string | null;
  email: string | null;
  url: string | null;
  clicks: number | null;
  errors: number | null;
}

function stamp(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : numeric(value);
  return ms !== null && Number.isFinite(ms) ? ms : null;
}

/** One recording as the list and the import read it. Untrusted: every field is read defensively. */
export function recordingRow(raw: any): RecordingRow | null {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !RECORDING_ID.test(raw.id)) return null;
  const seconds = numeric(raw.recording_duration);
  const str = (x: unknown) => (typeof x === "string" && x ? x.slice(0, 2048) : null);
  return {
    id: raw.id,
    started_at: stamp(raw.start_time),
    ended_at: stamp(raw.end_time),
    duration_ms: seconds === null ? null : Math.round(seconds * 1000),
    distinct_id: str(raw.distinct_id),
    email: str(raw.person?.properties?.email),
    url: typeof raw.start_url === "string" && raw.start_url ? cleanUrl(raw.start_url) : null,
    clicks: numeric(raw.click_count),
    errors: numeric(raw.console_error_count),
  };
}

export interface RecordingFilters {
  limit?: number;
  /** Rows to skip: the bulk import's position in a list pinned by date_to. */
  offset?: number;
  date_from?: string;
  date_to?: string;
  person_uuid?: string;
}

/** The list path with the filters PostHog takes, each checked before it reaches a URL. */
export function recordingsPath(filters: RecordingFilters): string {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(Math.floor(filters.limit ?? 20), 1), RECORDINGS_LIST_MAX)));
  if (filters.offset && filters.offset > 0) params.set("offset", String(Math.floor(filters.offset)));
  for (const key of ["date_from", "date_to"] as const) {
    const value = filters[key]?.trim();
    if (!value) continue;
    if (!DATE_FILTER.test(value)) invalidScope(`${key} must be a PostHog date like -7d or 2026-10-01, got "${value.slice(0, 40)}"`);
    params.set(key, value);
  }
  if (filters.person_uuid?.trim()) {
    if (!RECORDING_ID.test(filters.person_uuid.trim())) invalidScope("person_uuid is not a PostHog person id");
    params.set("person_uuid", filters.person_uuid.trim());
  }
  return `/session_recordings/?${params.toString()}`;
}

/**
 * The snapshot sources of a recording, in order, of the one kind the import
 * reads: blob_v2 when PostHog offers it, else the older blob, else realtime
 * (a recording still in progress has not been flushed to a blob yet).
 */
export function snapshotSources(body: any): { source: string; blob_key?: string }[] {
  const all: any[] = Array.isArray(body?.sources) ? body.sources : [];
  for (const kind of ["blob_v2", "blob", "realtime"]) {
    const picked = all.filter((s) => s && s.source === kind);
    if (picked.length) {
      return picked.map((s) => ({ source: kind, ...(s.blob_key !== undefined && s.blob_key !== null ? { blob_key: String(s.blob_key) } : {}) }));
    }
  }
  return [];
}

/** One snapshot call: a single blob, or for blob_v2 an inclusive key range. */
export type SnapshotRead = { source: string; blob_key?: string; end_blob_key?: string };

/**
 * The calls that read these sources: blob_v2 keys in consecutive runs of up to
 * SNAPSHOT_BLOBS_PER_READ, everything else one call each.
 */
export function snapshotReads(sources: { source: string; blob_key?: string }[]): SnapshotRead[] {
  const reads: SnapshotRead[] = [];
  for (const src of sources) {
    const last = reads[reads.length - 1];
    const key = src.blob_key !== undefined && /^\d+$/.test(src.blob_key) ? Number(src.blob_key) : null;
    if (src.source === "blob_v2" && key !== null && last?.source === "blob_v2" && last.blob_key !== undefined) {
      const end = Number(last.end_blob_key ?? last.blob_key);
      if (key === end + 1 && key - Number(last.blob_key) < SNAPSHOT_BLOBS_PER_READ) {
        last.end_blob_key = String(key);
        continue;
      }
    }
    reads.push({ ...src });
  }
  return reads;
}

/** A range read as the single blobs it covers. */
function splitRead(read: SnapshotRead): SnapshotRead[] {
  if (read.end_blob_key === undefined || read.blob_key === undefined) return [read];
  const out: SnapshotRead[] = [];
  for (let k = Number(read.blob_key); k <= Number(read.end_blob_key); k++) out.push({ source: read.source, blob_key: String(k) });
  return out;
}

/**
 * The path of one read. blob_v2 is read by an inclusive key range and PostHog
 * refuses a bare blob_key ("Must provide both start blob key and end blob
 * key"), so a single blob is the range from its key to itself.
 */
export function snapshotPath(recordingId: string, read: SnapshotRead): string {
  const params = new URLSearchParams({ source: read.source });
  if (read.blob_key !== undefined && read.source === "blob_v2") {
    params.set("start_blob_key", read.blob_key);
    params.set("end_blob_key", read.end_blob_key ?? read.blob_key);
  } else if (read.blob_key !== undefined) params.set("blob_key", read.blob_key);
  return `/session_recordings/${recordingId}/snapshots?${params.toString()}`;
}

type Inflate = (bytes: Uint8Array) => Uint8Array | null;

const inflateCapped: Inflate = (bytes) => gunzipCapped(bytes, REPLAY_CHUNK_MAX_INFLATED_BYTES);

/** A field posthog-js compressed: gzip bytes carried as a latin1 string. Null when it does not inflate. */
function inflateField(value: unknown, inflate: Inflate): unknown {
  if (typeof value !== "string") return value;
  const out = inflate(strToU8(value, true));
  if (!out) return null;
  try {
    return JSON.parse(strFromU8(out));
  } catch {
    return null;
  }
}

const MUTATION_FIELDS = ["texts", "attributes", "removes", "adds"] as const;

/**
 * posthog-js compresses large events before sending (`cv: "2024-10"`): a full
 * snapshot's whole data, and an incremental mutation's four lists, each as a
 * gzip string. This undoes it; an event whose parts do not inflate is dropped.
 */
export function decompressPostHogEvent(event: any, inflate: Inflate = inflateCapped): RrwebEvent | null {
  if (!event || typeof event !== "object" || typeof event.type !== "number") return null;
  if (!event.cv) return event as RrwebEvent;
  const { cv: _cv, ...rest } = event;
  if (typeof rest.data === "string") {
    const data = inflateField(rest.data, inflate);
    return data === null ? null : { ...rest, data };
  }
  if (rest.data && typeof rest.data === "object") {
    const data: Record<string, unknown> = { ...rest.data };
    for (const field of MUTATION_FIELDS) {
      if (typeof data[field] !== "string") continue;
      const inflated = inflateField(data[field], inflate);
      if (inflated === null) return null;
      data[field] = inflated;
    }
    return { ...rest, data };
  }
  return rest as RrwebEvent;
}

/**
 * The rrweb events in a snapshots answer. blob_v2 lines are `[window_id,
 * event]`; the older blob lines are `{ window_id, data: [events] }`; a bare
 * event is taken as is. A line that does not parse is skipped, not fatal: one
 * torn line must not cost the recording.
 */
export function parseSnapshotJsonl(text: string, inflate: Inflate = inflateCapped): RrwebEvent[] {
  const out: RrwebEvent[] = [];
  const take = (raw: unknown) => {
    const event = decompressPostHogEvent(raw, inflate);
    if (event && typeof event.timestamp === "number") out.push(event);
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) take(parsed[1]);
    else if (parsed && Array.isArray(parsed.data) && parsed.window_id !== undefined) parsed.data.forEach(take);
    else take(parsed);
  }
  return out;
}

/**
 * Every rrweb event of one recording, read blob by blob up to the byte and
 * blob caps. A recording past the caps imports its beginning, and says so.
 */
export async function fetchRecordingEvents(
  conn: PostHogConn,
  recordingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; events: RrwebEvent[]; truncated: boolean } | PostHogFailure> {
  const listed = parseJson(await posthogRequest(conn, `/session_recordings/${recordingId}/snapshots`, { maxBytes: LIST_READ_MAX_BYTES }, fetchImpl));
  if (!listed.ok) return listed;
  const sources = snapshotSources(listed.body);
  if (!sources.length) return { ok: false, error: `PostHog has no snapshots for recording ${recordingId}` };
  const events: RrwebEvent[] = [];
  let budget = SNAPSHOT_MAX_BYTES;
  let truncated = sources.length > SNAPSHOT_MAX_BLOBS;
  const queue = snapshotReads(sources.slice(0, SNAPSHOT_MAX_BLOBS));
  while (queue.length) {
    const read = queue.shift()!;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const answer = await posthogRequest(conn, snapshotPath(recordingId, read), { maxBytes: budget }, fetchImpl);
    if (!answer.ok) {
      const overBudget = answer.status !== undefined && answer.status < 300;
      // A range over the budget is read again blob by blob, so the blobs that fit still land.
      if (overBudget && read.end_blob_key !== undefined && read.end_blob_key !== read.blob_key) {
        queue.unshift(...splitRead(read));
        continue;
      }
      // Over the budget: keep what was read. Any other failure fails the import.
      if (overBudget) {
        truncated = true;
        break;
      }
      return answer;
    }
    budget -= answer.text.length;
    events.push(...parseSnapshotJsonl(answer.text));
  }
  return { ok: true, events, truncated };
}

// ── Convex functions ──

/** What an action needs of a source it may use, resolved under the caller's own access. Never a secret. */
export const sourceForCaller = internalQuery({
  args: { ...scopeArgs, source: v.string(), user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    if (source.provider !== "posthog") invalidScope(`${source.short_id} is a ${source.provider} source, not PostHog`);
    return { source_id: source._id, short_id: source.short_id, config: source.config ?? null, connection_id: await connectionIdForSource(ctx, source) };
  },
});

/** The same for the poller, which runs as no one: the watch's own source. */
export const sourceForPoll = internalQuery({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return null;
    return { source_id: source._id, short_id: source.short_id, status: source.status, config: source.config ?? null, connection_id: await connectionIdForSource(ctx, source) };
  },
});

/** The connection a source calls through, decrypted inside this action. */
export async function connFor(ctx: Pick<ActionCtx, "runQuery">, input: { config: { project_id?: string } | null; connection_id: string | null }): Promise<PostHogConn | { error: string }> {
  const cred = await tokenFor(ctx, input.connection_id, "posthog");
  if (!cred.ok) return { error: cred.error };
  return posthogConn(cred, input.config);
}

type HogqlRows = { columns: unknown[]; types?: unknown[]; results: unknown[]; rows: number; truncated: boolean };

/**
 * One HogQL query against a source the scope may read, rows capped. The CLI
 * door runs it as the caller; a published page's query runs it as the page's
 * publisher (scope.user_id, internal callers only).
 */
export async function runHogql(ctx: Pick<ActionCtx, "runQuery">, scope: ScopeArgs & { user_id?: Id<"users"> }, source: string, hogql: string, fetchImpl: FetchLike = fetch): Promise<HogqlRows> {
  const problem = validWatchQuery("hogql", hogql);
  if (problem) invalidScope(problem);
  const input = await ctx.runQuery(internal.sources.posthog.sourceForCaller, { ...scope, source });
  const conn = await connFor(ctx, input);
  if ("error" in conn) throw new Error(conn.error);
  const parsed = parseJson(await posthogRequest(conn, "/query/", { method: "POST", body: hogqlBody(hogql), maxBytes: QUERY_READ_MAX_BYTES }, fetchImpl));
  if (!parsed.ok) throw new Error(parsed.error.startsWith("PostHog's answer is over") ? `${parsed.error}; add a LIMIT` : parsed.error);
  return capRows(parsed.body);
}

/** `cast metrics query "<hogql>"`: rows back to the caller, nothing stored. */
export const query = action({
  args: { ...scopeArgs, source: v.string(), query: v.string() },
  handler: async (ctx, args): Promise<HogqlRows> => {
    const { source, query: hogql, ...scope } = args;
    return await runHogql(ctx, scope, source, hogql);
  },
});

/** `cast replay ls --source <posthog>`: recordings from the API, each named by its replay short id once imported. */
export const listRecordings = action({
  args: {
    ...scopeArgs,
    source: v.string(),
    limit: v.optional(v.number()),
    date_from: v.optional(v.string()),
    date_to: v.optional(v.string()),
    person_uuid: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ recordings: (RecordingRow & { replay: string | null; imported: boolean })[] }> => {
    const { source, limit, date_from, date_to, person_uuid, ...scope } = args;
    const path = recordingsPath({ limit, date_from, date_to, person_uuid });
    const input = await ctx.runQuery(internal.sources.posthog.sourceForCaller, { ...scope, source });
    const conn = await connFor(ctx, input);
    if ("error" in conn) throw new Error(conn.error);
    const parsed = parseJson(await posthogRequest(conn, path, { maxBytes: LIST_READ_MAX_BYTES }));
    if (!parsed.ok) throw new Error(parsed.error);
    const rows = (Array.isArray(parsed.body?.results) ? parsed.body.results : []).map(recordingRow).filter((r: RecordingRow | null): r is RecordingRow => !!r);
    const known = await ctx.runQuery(internal.replays.importedReplays, { source_id: input.source_id, external_ids: rows.map((r: RecordingRow) => r.id) });
    return { recordings: rows.map((r: RecordingRow) => ({ ...r, replay: known[r.id]?.short_id ?? null, imported: known[r.id]?.imported ?? false })) };
  },
});

/** One recording read whole from PostHog: its metadata (start, person) and its rrweb events. */
export async function readPostHogRecording(conn: PostHogConn, recordingId: string, fetchImpl: FetchLike = fetch): Promise<VendorRecording> {
  const meta = parseJson(await posthogRequest(conn, `/session_recordings/${recordingId}/`, { maxBytes: LIST_READ_MAX_BYTES }, fetchImpl));
  if (!meta.ok) throw new VendorCallError(meta);
  const row = recordingRow(meta.body);
  const read = await fetchRecordingEvents(conn, recordingId, fetchImpl);
  if (!read.ok) throw new VendorCallError(read);
  return {
    events: read.events,
    truncated: read.truncated,
    ...(row?.started_at ? { started_at: row.started_at } : {}),
    ...(row && (row.distinct_id || row.email) ? { user: { id: row.distinct_id ?? undefined, email: row.email ?? undefined } } : {}),
  };
}

/** Import (or find) one recording of a source, as the source: access was checked by the caller (vendorReplay.importLinked, the bulk import). */
export async function importFor(ctx: Pick<ActionCtx, "runQuery" | "runAction">, input: { source_id: Id<"event_sources">; config: { project_id?: string } | null; connection_id: string | null }, recordingId: string): Promise<ImportOutcome> {
  return importVendorRecording(ctx, { source_id: input.source_id, provider: "posthog", external_id: recordingId }, async () => {
    const conn = await connFor(ctx, input);
    if ("error" in conn) throw new VendorCallError({ error: conn.error, lost: true });
    return readPostHogRecording(conn, recordingId);
  });
}

/**
 * `cast replay show` on a PostHog recording: imported the first time it is
 * read, then served from our own copy. Answers the replay to read.
 */
export const importRecording = action({
  args: { ...scopeArgs, source: v.string(), recording: v.string() },
  handler: async (ctx, args): Promise<ImportOutcome> => {
    const recordingId = args.recording.trim();
    if (!RECORDING_ID.test(recordingId)) invalidScope("That is not a PostHog recording id");
    const { source, recording: _r, ...scope } = args;
    const input = await ctx.runQuery(internal.sources.posthog.sourceForCaller, { ...scope, source });
    return importFor(ctx, input, recordingId);
  },
});

/** A linked recording of a source the caller may read (vendorReplay.importLinked). */
export const importForSource = internalAction({
  args: { source_id: v.id("event_sources"), external_id: v.string() },
  handler: async (ctx, args): Promise<ImportOutcome> => {
    if (!RECORDING_ID.test(args.external_id)) throw new Error("That is not a PostHog recording id");
    const input = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: args.source_id });
    if (!input) throw new Error("The recording's source was removed");
    return importFor(ctx, input, args.external_id);
  },
});
