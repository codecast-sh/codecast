// The PostHog adapter (docs/architecture/external-data.md X7). PostHog stays
// the analytics product: codecast keeps watched metrics, not events. This
// module is the PostHog side of three things:
//
//   - a watch's value: a HogQL query (POST /query/) or a saved insight, read
//     to one number for metrics.ts, which folds it into a metric group;
//   - `cast metrics query "<hogql>"`: a passthrough that returns rows to the
//     caller, capped at PASSTHROUGH_MAX_BYTES, and stores nothing;
//   - recordings: listed from the API, and one imported the first time it is
//     read (snapshots -> rrweb events -> fromRrweb -> replays.importExternal).
//
// The token never leaves the backend. Every call goes to the host the
// connection was validated against (tokenConnectors.ts), never to a host a
// source's config names: anyone who may edit a source could otherwise point a
// team's key at their own server.
import { v } from "convex/values";
import { strFromU8, strToU8 } from "fflate";
import { action, internalQuery } from "../functions";
import type { ActionCtx } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { invalidScope } from "../lib/auth";
import { scopeArgs, scopeOf, sourceByRef } from "../ingest";
import { findReplay, gunzipCapped, readBodyCapped, REPLAY_CHUNK_MAX_INFLATED_BYTES } from "../replays";
import { connectionIdForSource, readTokenCredential, type FetchLike } from "../tokenConnectors";
import { METRIC_WATCH_LIMITS, PASSTHROUGH_MAX_BYTES } from "@codecast/shared/contracts/ingest";
import { fromRrweb, type RrwebEvent } from "@codecast/shared/replay";

const FETCH_TIMEOUT_MS = 30_000;
/** What a query answer may be before trimming to PASSTHROUGH_MAX_BYTES; past it the caller is told to add a LIMIT. */
const QUERY_READ_MAX_BYTES = 4 * 1024 * 1024;
/** A watch reads one number; its answer is small or wrong. */
const VALUE_READ_MAX_BYTES = 1024 * 1024;
const LIST_READ_MAX_BYTES = 2 * 1024 * 1024;
/** Every snapshot blob of one recording together, compressed text as received. */
const SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
const SNAPSHOT_MAX_BLOBS = 60;
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
 * when it names a numeric one (one key may read several projects), else the
 * connection's.
 */
export function posthogConn(cred: { token: string; config: Record<string, string> }, sourceConfig?: { project_id?: string } | null): PostHogConn | { error: string } {
  const host = cred.config.host;
  const project = sourceConfig?.project_id && /^\d{1,12}$/.test(sourceConfig.project_id) ? sourceConfig.project_id : cred.config.project_id;
  if (!host || !project) return { error: "The PostHog connection has no host or project id: reconnect PostHog" };
  return { token: cred.token, host, project_id: project };
}

export type PostHogAnswer = { ok: true; text: string } | { ok: false; error: string; status?: number };

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
  const url = `${conn.host}/api/projects/${conn.project_id}${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: any) {
    return { ok: false, error: `Could not reach PostHog at ${conn.host}: ${e?.message ?? "network error"}` };
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, error: `PostHog redirected ${path}; reconnect PostHog with the final host` };
  }
  const bytes = await readBodyCapped(res, opts.maxBytes);
  if (!bytes) return { ok: false, status: res.status, error: `PostHog's answer is over ${opts.maxBytes} bytes` };
  const text = new TextDecoder().decode(bytes);
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: `PostHog refused the token (${res.status})${detailOf(text) ? `: ${detailOf(text)}` : ""}` };
  if (!res.ok) return { ok: false, status: res.status, error: `PostHog answered ${res.status}${detailOf(text) ? `: ${detailOf(text)}` : ""}` };
  return { ok: true, text };
}

function parseJson(answer: PostHogAnswer): { ok: true; body: any } | { ok: false; error: string } {
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
): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
  if (watch.query_kind === "hogql") {
    const parsed = parseJson(await posthogRequest(conn, "/query/", { method: "POST", body: hogqlBody(watch.query), maxBytes: VALUE_READ_MAX_BYTES }, fetchImpl));
    if (!parsed.ok) return parsed;
    const value = hogqlScalar(parsed.body);
    return value === null ? { ok: false, error: "The query returned no number in its first cell" } : { ok: true, value };
  }
  if (watch.query_kind === "insight") {
    const parsed = parseJson(await posthogRequest(conn, insightPath(watch.query), { maxBytes: VALUE_READ_MAX_BYTES }, fetchImpl));
    if (!parsed.ok) return parsed;
    const insight = /^\d+$/.test(watch.query.trim()) ? parsed.body : parsed.body?.results?.[0];
    if (!insight) return { ok: false, error: `PostHog has no insight ${watch.query}` };
    const value = insightScalar(insight);
    return value === null ? { ok: false, error: "The insight's result has no number to watch" } : { ok: true, value };
  }
  return { ok: false, error: `A PostHog source cannot poll a ${watch.query_kind} watch` };
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
    url: str(raw.start_url),
    clicks: numeric(raw.click_count),
    errors: numeric(raw.console_error_count),
  };
}

export interface RecordingFilters {
  limit?: number;
  date_from?: string;
  date_to?: string;
  person_uuid?: string;
}

/** The list path with the filters PostHog takes, each checked before it reaches a URL. */
export function recordingsPath(filters: RecordingFilters): string {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(Math.floor(filters.limit ?? 20), 1), RECORDINGS_LIST_MAX)));
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

export function snapshotPath(recordingId: string, src: { source: string; blob_key?: string }): string {
  const params = new URLSearchParams({ source: src.source });
  if (src.blob_key !== undefined) params.set("blob_key", src.blob_key);
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
): Promise<{ ok: true; events: RrwebEvent[]; truncated: boolean } | { ok: false; error: string }> {
  const listed = parseJson(await posthogRequest(conn, `/session_recordings/${recordingId}/snapshots`, { maxBytes: LIST_READ_MAX_BYTES }, fetchImpl));
  if (!listed.ok) return listed;
  const sources = snapshotSources(listed.body);
  if (!sources.length) return { ok: false, error: `PostHog has no snapshots for recording ${recordingId}` };
  const events: RrwebEvent[] = [];
  let budget = SNAPSHOT_MAX_BYTES;
  let truncated = sources.length > SNAPSHOT_MAX_BLOBS;
  for (const src of sources.slice(0, SNAPSHOT_MAX_BLOBS)) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const answer = await posthogRequest(conn, snapshotPath(recordingId, src), { maxBytes: budget }, fetchImpl);
    if (!answer.ok) {
      // Over the budget: keep what was read. Any other failure fails the import.
      if (answer.status !== undefined && answer.status < 300) {
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
  args: { ...scopeArgs, source: v.string() },
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

/** The replay rows a list already imported, so the list can name them by short id. */
export const importedReplays = internalQuery({
  args: { source_id: v.id("event_sources"), external_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Record<string, { replay_id: Id<"replays">; short_id: string; imported: boolean }> = {};
    for (const id of args.external_ids.slice(0, RECORDINGS_LIST_MAX)) {
      const row = await findReplay(ctx, args.source_id, id);
      if (row) out[id] = { replay_id: row._id, short_id: row.short_id, imported: row.imported_at !== undefined };
    }
    return out;
  },
});

/** The connection a source calls through, decrypted inside this action. */
export async function connFor(ctx: Pick<ActionCtx, "runQuery">, input: { config: { project_id?: string } | null; connection_id: string | null }): Promise<PostHogConn | { error: string }> {
  if (!input.connection_id) return { error: "No PostHog connection in this source's workspace: connect it with `cast integrations connect posthog`" };
  const cred = await readTokenCredential(ctx, input.connection_id);
  if (!cred.ok) return { error: cred.error };
  if (cred.provider !== "posthog") return { error: `The source's connection is ${cred.provider}, not PostHog` };
  return posthogConn(cred, input.config);
}

/** `cast metrics query "<hogql>"`: rows back to the caller, nothing stored. */
export const query = action({
  args: { ...scopeArgs, source: v.string(), query: v.string() },
  handler: async (ctx, args): Promise<{ columns: unknown[]; types?: unknown[]; results: unknown[]; rows: number; truncated: boolean }> => {
    const problem = validWatchQuery("hogql", args.query);
    if (problem) invalidScope(problem);
    const { source, query: hogql, ...scope } = args;
    const input = await ctx.runQuery(internal.sources.posthog.sourceForCaller, { ...scope, source });
    const conn = await connFor(ctx, input);
    if ("error" in conn) throw new Error(conn.error);
    const parsed = parseJson(await posthogRequest(conn, "/query/", { method: "POST", body: hogqlBody(hogql), maxBytes: QUERY_READ_MAX_BYTES }));
    if (!parsed.ok) throw new Error(parsed.error.startsWith("PostHog's answer is over") ? `${parsed.error}; add a LIMIT` : parsed.error);
    return capRows(parsed.body);
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
    const known = await ctx.runQuery(internal.sources.posthog.importedReplays, { source_id: input.source_id, external_ids: rows.map((r: RecordingRow) => r.id) });
    return { recordings: rows.map((r: RecordingRow) => ({ ...r, replay: known[r.id]?.short_id ?? null, imported: known[r.id]?.imported ?? false })) };
  },
});

/**
 * `cast replay show` on a PostHog recording: imported the first time it is
 * read, then served from our own copy. Answers the replay to read.
 */
export const importRecording = action({
  args: { ...scopeArgs, source: v.string(), recording: v.string() },
  handler: async (ctx, args): Promise<{ replay_id: Id<"replays">; short_id: string; imported: boolean; truncated: boolean }> => {
    const recordingId = args.recording.trim();
    if (!RECORDING_ID.test(recordingId)) invalidScope("That is not a PostHog recording id");
    const { source, recording: _r, ...scope } = args;
    const input = await ctx.runQuery(internal.sources.posthog.sourceForCaller, { ...scope, source });
    const known = await ctx.runQuery(internal.sources.posthog.importedReplays, { source_id: input.source_id, external_ids: [recordingId] });
    const existing = known[recordingId];
    if (existing?.imported) return { replay_id: existing.replay_id, short_id: existing.short_id, imported: false, truncated: false };
    const conn = await connFor(ctx, input);
    if ("error" in conn) throw new Error(conn.error);
    const meta = parseJson(await posthogRequest(conn, `/session_recordings/${recordingId}/`, { maxBytes: LIST_READ_MAX_BYTES }));
    if (!meta.ok) throw new Error(meta.error);
    const row = recordingRow(meta.body);
    const read = await fetchRecordingEvents(conn, recordingId);
    if (!read.ok) throw new Error(read.error);
    const user = row && (row.distinct_id || row.email) ? { ...(row.distinct_id ? { id: row.distinct_id.slice(0, 200) } : {}), ...(row.email ? { email: row.email.slice(0, 200) } : {}) } : undefined;
    const imported = await ctx.runAction(internal.replays.importExternal, {
      source_id: input.source_id,
      provider: "posthog",
      external_id: recordingId,
      events: fromRrweb(read.events),
      ...(row?.started_at ? { started_at: row.started_at } : {}),
      ...(user ? { user } : {}),
    });
    return { replay_id: imported.replay_id, short_id: imported.short_id, imported: true, truncated: read.truncated };
  },
});
