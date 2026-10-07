// The ingest contract (docs/architecture/external-data.md X1 to X4): what a
// running product may send to `POST /cli/ingest/<key>`, how a batch is checked
// before anything is written, the group kinds and transitions the upsert
// speaks, and which trigger and signal kind each transition maps to. The door,
// the group upsert, the adapters, the SDK, the CLI and the web all import this
// file, so a name or a cap is spelled once.
//
// Pure: no node or convex imports. The CLI, the browser SDK and the Convex
// runtime all load it, which is why the key helpers use globalThis.crypto.
import type { SignalKind } from "./signalFingerprint";

// ── Sources ──

/** Providers a person adds (`cast sources add`, the Ops form). */
export const ADDABLE_SOURCE_PROVIDERS = ["sentry", "posthog", "sdk", "http", "app"] as const;
/** Providers codecast creates and feeds itself: github is CI on a repository's default branch (X7). */
export const SYSTEM_SOURCE_PROVIDERS = ["github"] as const;
export const SOURCE_PROVIDERS = [...ADDABLE_SOURCE_PROVIDERS, ...SYSTEM_SOURCE_PROVIDERS] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];
export type AddableSourceProvider = (typeof ADDABLE_SOURCE_PROVIDERS)[number];

/** The system source CI runs on a default branch file under, one per workspace; `--source github-ci` names it. */
export const GITHUB_CI_SOURCE_NAME = "github-ci";

/** Providers that push through the ingest door with a write-only key; the rest hold a connection credential. */
export const KEYED_SOURCE_PROVIDERS: readonly SourceProvider[] = ["sdk", "http"];

/** A Sentry org or project slug (or numeric id): checked so a value cannot steer a URL to another path. */
export const SENTRY_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** A PostHog project id. */
export const POSTHOG_PROJECT_ID = /^\d{1,12}$/;

/**
 * A source's own settings: what it reads inside its connection. Where the
 * connection points (host, base url) belongs to the connection alone, which
 * proved it with a live call, so no source names it. The CLI's flags and the
 * server's check both come from this list.
 */
export interface SourceConfigField {
  key: "org" | "projects" | "project_id" | "environments" | "allowed_origins";
  flag: string;
  list: boolean;
  providers: readonly SourceProvider[];
  help: string;
  /** The value is refused unless every entry matches. */
  pattern?: RegExp;
  /** What a bad value is, for the refusal. */
  what?: string;
}

export const SOURCE_CONFIG_FIELDS: readonly SourceConfigField[] = [
  { key: "org", flag: "org", list: false, providers: ["sentry"], help: "Sentry organization slug (must be the connection's)", pattern: SENTRY_SLUG, what: "a Sentry organization slug" },
  { key: "projects", flag: "projects", list: true, providers: ["sentry"], help: "Sentry project slugs or ids to mirror", pattern: SENTRY_SLUG, what: "a Sentry project slug or id" },
  { key: "project_id", flag: "project-id", list: false, providers: ["posthog"], help: "PostHog project id, when not the connection's", pattern: POSTHOG_PROJECT_ID, what: "a PostHog project id (a number)" },
  { key: "environments", flag: "environments", list: true, providers: SOURCE_PROVIDERS, help: "Only these environments" },
  { key: "allowed_origins", flag: "allowed-origins", list: true, providers: KEYED_SOURCE_PROVIDERS, help: "Origins a browser SDK may post from" },
];

/**
 * Why a source's config is refused, or null: a setting for another provider,
 * or a value that is not what its provider takes. Refused rather than
 * ignored, so a mistyped project never quietly reads a different one.
 */
export function sourceConfigProblem(provider: SourceProvider, config: Record<string, unknown> | undefined | null): string | null {
  for (const field of SOURCE_CONFIG_FIELDS) {
    const value = config?.[field.key];
    if (value === undefined) continue;
    if (!field.providers.includes(provider)) return `${field.key} does not apply to a ${provider} source`;
    if (!field.pattern) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one !== "string" || !field.pattern.test(one)) return `"${String(one)}" is not ${field.what}`;
    }
  }
  return null;
}

export const SOURCE_STATUSES = ["active", "paused", "error"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * The one spelling of a source name, for storing and for comparing a trigger's
 * `source` filter against a firing: `--source Union ` and `union` are the same
 * source, the way two spellings of a repository are one repository.
 */
export function normalizeSourceName(name: string | undefined | null): string {
  return (name ?? "").trim().toLowerCase();
}

/**
 * Whether a trigger's `source` filter admits a firing from `source` (X4). A
 * trigger that names no source fires for every source its owner can see.
 */
export function sourceFilterAdmits(filter: string | undefined | null, source: string | undefined | null): boolean {
  return !filter || normalizeSourceName(filter) === normalizeSourceName(source);
}

/**
 * Short id prefixes for the ingestion tables, minted by counters.nextShortId
 * like ct- and sg-. Here so the CLI and web recognize a handle by its prefix.
 */
export const INGEST_SHORT_ID_PREFIX = {
  source: "src",
  group: "eg",
  replay: "rp",
  metric_watch: "mw",
} as const;

// ── Groups and transitions ──

export const GROUP_KINDS = ["error", "log", "job", "check", "metric", "replay_issue"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const GROUP_STATUSES = ["open", "resolved", "ignored", "muted"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/**
 * The only things that write an external_events row, fire a trigger and may
 * promote to a signal (X3). An occurrence that is none of these only patches
 * counts.
 */
export const TRANSITIONS = [
  "new",
  "regressed",
  "spike",
  "resolved",
  "check_failed",
  "check_recovered",
  "job_failed",
  "metric_alert",
  "metric_recovered",
  "deploy",
] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** What a new source promotes when it does not say (X1): new and regressed errors. */
export const DEFAULT_PROMOTE: readonly Transition[] = ["new", "regressed"];

/**
 * The derived trigger name a transition fires (X4), or undefined when nothing
 * waits on it. Errors and warning logs share the error names: a person arms
 * "a new error", not "a new group of kind log".
 */
export function transitionTriggerEvent(kind: GroupKind | undefined, transition: Transition): string | undefined {
  if (transition === "deploy") return "deploy";
  switch (transition) {
    case "check_failed":
    case "check_recovered":
    case "job_failed":
    case "metric_alert":
    case "metric_recovered":
      return transition;
  }
  if (kind !== "error" && kind !== "log") return undefined;
  if (transition === "new") return "error_new";
  if (transition === "regressed") return "error_regressed";
  if (transition === "spike") return "error_spike";
  return undefined;
}

/**
 * The transitions a group of each kind can make (X3, the rules in
 * lib/ingestGroups.ts): errors and warning logs open, regress and spike; a job
 * group announces its failures; a check and a metric flip between failing and
 * recovered. Any group can be resolved. Surfaces read it to name what a group
 * may fire.
 */
export const KIND_TRANSITIONS: Record<GroupKind, readonly Transition[]> = {
  error: ["new", "regressed", "spike", "resolved"],
  log: ["new", "regressed", "spike", "resolved"],
  replay_issue: ["new", "regressed", "resolved"],
  job: ["job_failed", "resolved"],
  check: ["check_failed", "check_recovered", "resolved"],
  metric: ["metric_alert", "metric_recovered", "resolved"],
};

/** The trigger events a group of this kind can fire, in transition order. */
export function kindTriggerEvents(kind: GroupKind): string[] {
  const out: string[] = [];
  for (const t of KIND_TRANSITIONS[kind]) {
    const name = transitionTriggerEvent(kind, t);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The signal kind a promoted transition files as (X6). Absent means the transition never promotes. */
export const TRANSITION_SIGNAL_KIND: Partial<Record<Transition, SignalKind>> = {
  new: "bug",
  regressed: "regression",
  spike: "regression",
  check_failed: "bug",
  job_failed: "bug",
  metric_alert: "ux",
};

export function transitionSignalKind(transition: Transition): SignalKind | undefined {
  return TRANSITION_SIGNAL_KIND[transition];
}

/** Upsert thresholds (X3), so the rule set and any surface explaining it agree. */
export const GROUP_RULES = {
  spike_factor: 5,
  spike_min_count: 20,
  spike_cooldown_ms: 6 * 3600_000,
  job_burst_count: 3,
  job_burst_window_ms: 3600_000,
  job_cooldown_ms: 6 * 3600_000,
  bucket_hours: 72,
  samples_per_group: 20,
  metric_points: 60,
} as const;

const HOUR_MS = 3600_000;

/**
 * Hourly counts for the last `hours`, oldest first, ending with the hour `now`
 * is in. Buckets are sparse (one per hour that had hits, keyed by the hour's
 * start in ms), so an hour with no bucket is a zero and a gap stays a gap.
 * Every sparkline over a group's or an event name's buckets reads this.
 */
export function bucketSeries(buckets: readonly { hour: number; count: number }[] | undefined, now: number, hours: number = GROUP_RULES.bucket_hours): number[] {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS;
  const start = end - (hours - 1) * HOUR_MS;
  const out = new Array<number>(hours).fill(0);
  for (const b of buckets ?? []) {
    const hour = Math.floor(b.hour / HOUR_MS) * HOUR_MS;
    if (hour < start || hour > end) continue;
    out[(hour - start) / HOUR_MS] += b.count;
  }
  return out;
}

/** One analytics event name's hourly counts as a source row carries them (convex lib/ingestGroups countEventNames). */
export type EventNameCounts = { name: string; buckets: { hour: number; count: number }[] };

/**
 * A source's counted analytics events for a reader, busiest first over the
 * last 24 hours: the day's count and every hour of the window, oldest first
 * (a sparkline's input). `cast sources show` and the web source card read this.
 */
export function eventNameRows(names: readonly EventNameCounts[] | undefined, now: number, limit = 10): { name: string; day: number; hourly: number[] }[] {
  return (names ?? [])
    .map((e) => {
      const hourly = bucketSeries(e.buckets, now);
      return { name: e.name, day: hourly.slice(-24).reduce((n, c) => n + c, 0), hourly };
    })
    .filter((r) => r.hourly.some((c) => c > 0))
    .sort((a, b) => b.day - a.day || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** How many fired events an armed trigger holds until a run claims them (X4). */
export const PENDING_EVENTS_CAP = 20;

/**
 * Watched metrics (X7): how often a watch may poll, and what a passthrough
 * read (`cast metrics query`, `cast connector read`) hands back at most. A
 * passthrough answer goes to the caller and is never stored.
 */
/** What a metric watch polls: a HogQL query or a PostHog insight id. */
export const WATCH_KINDS = ["hogql", "insight"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

/** Which side of the threshold alerts. */
export const WATCH_DIRECTIONS = ["above", "below"] as const;
export type WatchDirection = (typeof WATCH_DIRECTIONS)[number];

export const METRIC_WATCH_LIMITS = {
  interval_min_ms: 60_000,
  interval_default_ms: 5 * 60_000,
  interval_max_ms: 7 * 24 * 3600_000,
  query_chars: 20_000,
  /** How far back `cast metrics backfill` reads by default, and at most. */
  backfill_days_default: 30,
  backfill_days_max: 365,
} as const;

/** Why a watch has no history to read from its source (metrics.loadHistory): not failures, so they never stop a source. */
export const METRIC_NO_HISTORY = {
  covered: "The watch's points already reach back as far as asked",
  aggregate: "The insight's value is a total, not a dated series; its history is its polls",
} as const;

/** A watch's last history read, as stored on it: when, how many past points it added, why none, or still reading. */
export type MetricWatchHistory = { at: number; added: number; note?: string; reading?: boolean };

export const PASSTHROUGH_MAX_BYTES = 256 * 1024;

// ── Ingest keys ──

export const INGEST_KEY_PREFIX = "cc_ing_";
const INGEST_KEY_RANDOM_LENGTH = 32;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const INGEST_KEY_RE = /^cc_ing_[0-9A-Za-z]{32}$/;

/** A fresh write-only key: cc_ing_ and 32 base62 characters (about 190 bits). */
export function generateIngestKey(): string {
  let out = "";
  // Rejection sampling keeps every character equally likely: 248 is the
  // largest multiple of 62 below 256.
  while (out.length < INGEST_KEY_RANDOM_LENGTH) {
    const bytes = new Uint8Array(48);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= 248) continue;
      out += BASE62[b % 62];
      if (out.length === INGEST_KEY_RANDOM_LENGTH) break;
    }
  }
  return INGEST_KEY_PREFIX + out;
}

export function isIngestKey(key: string | undefined | null): boolean {
  return !!key && INGEST_KEY_RE.test(key);
}

/**
 * What the UI shows for a key after it is gone: the fixed prefix and the
 * first 8 random characters. The fixed prefix alone would tell keys apart not
 * at all, so the 8 characters are taken after it.
 */
export function ingestKeyPrefix(key: string): string {
  return key.slice(0, INGEST_KEY_PREFIX.length + 8);
}

/** The stored form: lowercase hex sha256. Only this is kept; the key is shown once. */
export async function hashIngestKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── The batch ──

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Logs below warn are accepted and dropped: only warn and above are grouped (X2). */
export function isGroupedLogLevel(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf("warn");
}

export interface IngestUser {
  id?: string;
  email?: string;
  name?: string;
}

export type IngestItem =
  | {
      type: "error";
      message: string;
      stack?: string;
      level?: LogLevel;
      fingerprint?: string;
      tags?: Record<string, string>;
      context?: Record<string, unknown>;
      url?: string;
      user?: IngestUser;
      /** Links the sample to a recording (X5). */
      replay_id?: string;
      at: number;
    }
  | { type: "log"; level: LogLevel; message: string; fingerprint?: string; context?: Record<string, unknown>; at: number }
  | { type: "job_failed"; job: string; error: string; attempt?: number; job_id?: string; at: number }
  | { type: "check"; id: string; ok: boolean; title?: string; detail?: string; at: number }
  | { type: "event"; name: string; props?: Record<string, unknown>; at: number }
  | { type: "deploy"; version: string; sha?: string; environment?: string; at: number }
  | {
      type: "replay";
      replay_id: string;
      url?: string;
      user?: IngestUser;
      started_at?: number;
      duration_ms?: number;
      /** Chunks uploaded so far; chunk keys derive from the replay and the index. */
      chunks?: number;
      counts?: { clicks?: number; errors?: number; failed_requests?: number };
      at: number;
    };

export type IngestItemType = IngestItem["type"];
export const INGEST_ITEM_TYPES: readonly IngestItemType[] = ["error", "log", "job_failed", "check", "event", "deploy", "replay"];

export interface IngestEnvelope {
  sdk: { name: string; version: string };
  release?: string;
  environment?: string;
}

export const INGEST_LIMITS = {
  max_items: 500,
  max_bytes: 1024 * 1024,
  message_chars: 2_000,
  stack_chars: 16 * 1024,
  title_chars: 300,
  detail_chars: 4_000,
  name_chars: 200,
  url_chars: 2_048,
  fingerprint_chars: 200,
  /** Serialized size of a context, props or tags object; larger ones are replaced by a note. */
  object_chars: 8 * 1024,
  object_keys: 50,
  tag_value_chars: 200,
  /** An item stamped further ahead than this is clamped to the receive time. */
  future_skew_ms: 5 * 60_000,
} as const;

export interface IngestRejection {
  index: number;
  reason: string;
}

export type IngestBatchResult =
  | { ok: true; envelope: IngestEnvelope; items: IngestItem[]; rejected: IngestRejection[] }
  /** The whole batch is refused. `status` is the HTTP answer: 400 means do not retry, 413 means split. */
  | { ok: false; status: 400 | 413; error: string };

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function str(value: unknown, max: number): string | undefined {
  const s = clip(value, max)?.trim();
  return s ? s : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A bounded JSON object, or a note saying it was too large. Never throws on cycles. */
function boundedObject(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value).slice(0, INGEST_LIMITS.object_keys);
  const picked: Record<string, unknown> = {};
  for (const k of keys) picked[k.slice(0, INGEST_LIMITS.name_chars)] = value[k];
  let json: string;
  try {
    json = JSON.stringify(picked);
  } catch {
    return { _truncated: "not serializable" };
  }
  if (json.length > INGEST_LIMITS.object_chars) return { _truncated: `${json.length} chars` };
  return JSON.parse(json);
}

function boundedTags(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const k of Object.keys(value).slice(0, INGEST_LIMITS.object_keys)) {
    const v = value[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k.slice(0, INGEST_LIMITS.name_chars)] = String(v).slice(0, INGEST_LIMITS.tag_value_chars);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function user(value: unknown): IngestUser | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: IngestUser = {
    id: str(value.id, INGEST_LIMITS.name_chars),
    email: str(value.email, INGEST_LIMITS.name_chars),
    name: str(value.name, INGEST_LIMITS.name_chars),
  };
  return out.id || out.email || out.name ? out : undefined;
}

function level(value: unknown): LogLevel | undefined {
  return (LOG_LEVELS as readonly unknown[]).includes(value) ? (value as LogLevel) : undefined;
}

/** Epoch ms from a number or an ISO string; missing or far-future stamps become the receive time. */
function stamp(value: unknown, now: number): number {
  const ms = typeof value === "string" ? Date.parse(value) : num(value);
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return now;
  return ms > now + INGEST_LIMITS.future_skew_ms ? now : ms;
}

/** One item, normalized and clipped, or the reason it was refused. */
function validateItem(raw: unknown, now: number): IngestItem | string {
  if (!isPlainObject(raw)) return "item is not an object";
  const at = stamp(raw.at, now);
  const L = INGEST_LIMITS;
  switch (raw.type) {
    case "error": {
      const message = str(raw.message, L.message_chars);
      if (!message) return "error needs a message";
      return {
        type: "error",
        message,
        stack: clip(raw.stack, L.stack_chars),
        level: level(raw.level),
        fingerprint: str(raw.fingerprint, L.fingerprint_chars),
        tags: boundedTags(raw.tags),
        context: boundedObject(raw.context),
        url: str(raw.url, L.url_chars),
        user: user(raw.user),
        replay_id: str(raw.replay_id, L.name_chars),
        at,
      };
    }
    case "log": {
      const message = str(raw.message, L.message_chars);
      const lv = level(raw.level);
      if (!message) return "log needs a message";
      if (!lv) return "log needs a level (debug, info, warn, error, fatal)";
      return {
        type: "log",
        level: lv,
        message,
        fingerprint: str(raw.fingerprint, L.fingerprint_chars),
        context: boundedObject(raw.context),
        at,
      };
    }
    case "job_failed": {
      const job = str(raw.job, L.name_chars);
      if (!job) return "job_failed needs a job";
      return {
        type: "job_failed",
        job,
        error: str(raw.error, L.message_chars) ?? "failed",
        attempt: num(raw.attempt),
        job_id: str(raw.job_id, L.name_chars),
        at,
      };
    }
    case "check": {
      const id = str(raw.id, L.name_chars);
      if (!id) return "check needs an id";
      if (typeof raw.ok !== "boolean") return "check needs ok: true or false";
      return {
        type: "check",
        id,
        ok: raw.ok,
        title: str(raw.title, L.title_chars),
        detail: str(raw.detail, L.detail_chars),
        at,
      };
    }
    case "event": {
      const name = str(raw.name, L.name_chars);
      if (!name) return "event needs a name";
      return { type: "event", name, props: boundedObject(raw.props), at };
    }
    case "deploy": {
      const version = str(raw.version, L.name_chars);
      if (!version) return "deploy needs a version";
      return {
        type: "deploy",
        version,
        sha: str(raw.sha, L.name_chars),
        environment: str(raw.environment, L.name_chars),
        at,
      };
    }
    case "replay": {
      const replayId = str(raw.replay_id, L.name_chars);
      if (!replayId) return "replay needs a replay_id";
      const counts = isPlainObject(raw.counts)
        ? { clicks: num(raw.counts.clicks), errors: num(raw.counts.errors), failed_requests: num(raw.counts.failed_requests) }
        : undefined;
      return {
        type: "replay",
        replay_id: replayId,
        url: str(raw.url, L.url_chars),
        user: user(raw.user),
        started_at: raw.started_at === undefined ? undefined : stamp(raw.started_at, now),
        duration_ms: num(raw.duration_ms),
        chunks: num(raw.chunks),
        counts,
        at,
      };
    }
    default:
      return `unknown item type ${JSON.stringify(raw.type)?.slice(0, 40) ?? "undefined"}`;
  }
}

/** Absent optional fields leave no `undefined` keys behind, so an item reads the same after a JSON round trip. */
function dropUndefined<T extends object>(item: T): T {
  for (const key of Object.keys(item) as (keyof T)[]) {
    const v = item[key];
    if (v === undefined) delete item[key];
    else if (isPlainObject(v)) dropUndefined(v);
  }
  return item;
}

/** Utf-8 byte length without Buffer, which the browser and Convex lack. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Check a batch before anything is written (X2). Takes the raw request text
 * (preferred: the size cap is on bytes received) or an already parsed body.
 * A structural problem refuses the whole batch; a bad item is listed in
 * `rejected` and the rest go through, so one malformed error never costs the
 * batch around it.
 */
export function validateIngestBatch(body: unknown, now: number = Date.now()): IngestBatchResult {
  let parsed: unknown = body;
  if (typeof body === "string") {
    if (byteLength(body) > INGEST_LIMITS.max_bytes) return { ok: false, status: 413, error: `batch is over ${INGEST_LIMITS.max_bytes} bytes` };
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, error: "body is not JSON" };
    }
  } else {
    let size: number;
    try {
      size = byteLength(JSON.stringify(body) ?? "");
    } catch {
      return { ok: false, status: 400, error: "body is not serializable" };
    }
    if (size > INGEST_LIMITS.max_bytes) return { ok: false, status: 413, error: `batch is over ${INGEST_LIMITS.max_bytes} bytes` };
  }
  if (!isPlainObject(parsed)) return { ok: false, status: 400, error: "body is not an object" };
  if (!Array.isArray(parsed.items)) return { ok: false, status: 400, error: "items must be an array" };
  if (parsed.items.length > INGEST_LIMITS.max_items) {
    return { ok: false, status: 413, error: `batch has ${parsed.items.length} items, at most ${INGEST_LIMITS.max_items}` };
  }

  const sdk = isPlainObject(parsed.sdk) ? parsed.sdk : {};
  const envelope: IngestEnvelope = {
    sdk: {
      name: str(sdk.name, INGEST_LIMITS.name_chars) ?? "unknown",
      version: str(sdk.version, INGEST_LIMITS.name_chars) ?? "0",
    },
    release: str(parsed.release, INGEST_LIMITS.name_chars),
    environment: str(parsed.environment, INGEST_LIMITS.name_chars),
  };

  const items: IngestItem[] = [];
  const rejected: IngestRejection[] = [];
  parsed.items.forEach((raw, index) => {
    const result = validateItem(raw, now);
    if (typeof result === "string") rejected.push({ index, reason: result });
    else items.push(dropUndefined(result));
  });
  return { ok: true, envelope, items, rejected };
}
