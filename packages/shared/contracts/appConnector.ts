// The app connector contract (docs/architecture/external-data.md X8): the
// manifest a product serves at <base_url>/codecast/manifest, the subset of
// JSON Schema its readers and actions declare their input with, how a call
// becomes a request, when an action may run, and how a watched reader's rows
// become ingest items. Convex runs the calls (convex/sources/app.ts); the CLI
// coerces `--arg k=v` with the same schema and the web lists the same
// manifest, so every rule here is spelled once.
//
// Pure: no node or convex imports.
import { parseDuration } from "../time";

// ── Limits ──

export const APP_LIMITS = {
  /** A call that has not answered by then is aborted. */
  timeout_ms: 15_000,
  /** A reader's or action's response, and the manifest itself. */
  response_bytes: 256 * 1024,
  /** Serialized args of one call. */
  args_bytes: 64 * 1024,
  max_readers: 200,
  max_actions: 200,
  max_watches: 50,
  /** The watch cron's cadence: a watch cannot poll faster than this. */
  min_watch_ms: 5 * 60_000,
  max_watch_ms: 24 * 3600_000,
  /** Rows one watch poll maps; the ingest door takes no more in one batch. */
  watch_rows: 500,
  /** The manifest is refetched once it is this old. */
  manifest_max_age_ms: 24 * 3600_000,
} as const;

// ── JSON Schema subset ──

export type JsonSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

/**
 * The keywords the connector understands. Anything else in a declared schema
 * (format, pattern, oneOf) is kept on the manifest for people to read and
 * ignored by validation: a product can be stricter on its side, never looser
 * on ours for the keywords we check.
 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): JsonSchemaType | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "object") return typeof value as JsonSchemaType;
  return "undefined";
}

function typeMatches(want: JsonSchemaType, value: unknown): boolean {
  const got = typeOf(value);
  return got === want || (want === "number" && got === "integer");
}

/** Every way `value` breaks `schema`, as "path: problem" lines. Empty means valid. */
export function validateJson(schema: JsonSchema | undefined, value: unknown, path = "args"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const errors: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((t) => typeMatches(t, value))) {
    return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: must be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateJson(schema.items, item, `${path}[${i}]`)));
  }
  if (isPlainObject(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validateJson(props[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not an argument this accepts`);
    }
  }
  return errors;
}

/**
 * `--arg k=v` pairs as typed args, read by the declared property types: a
 * number property gets a number, a boolean "true"/"false", an array collects
 * repeats (or splits on commas), an object takes JSON. A key the schema does
 * not name stays a string, and validateJson decides whether it is allowed.
 * Throws on a value its property cannot read.
 */
export function coerceArgs(schema: JsonSchema | undefined, pairs: Array<[string, string]>): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  const read = (prop: JsonSchema | undefined, key: string, raw: string): unknown => {
    const types = prop?.type === undefined ? [] : Array.isArray(prop.type) ? prop.type : [prop.type];
    const t = types.find((x) => x !== "null");
    if (t === "number" || t === "integer") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new Error(`--arg ${key}: "${raw}" is not a number`);
      return n;
    }
    if (t === "boolean") {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`--arg ${key}: use true or false`);
    }
    if (t === "object") {
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`--arg ${key}: expected JSON`);
      }
    }
    return raw;
  };
  for (const [key, raw] of pairs) {
    const prop = props[key];
    const isArray = prop?.type === "array" || (Array.isArray(prop?.type) && prop!.type.includes("array"));
    if (isArray) {
      const parts = raw.split(",").map((p) => read(prop!.items, key, p.trim()));
      out[key] = [...((out[key] as unknown[]) ?? []), ...parts];
    } else {
      out[key] = read(prop, key, raw);
    }
  }
  return out;
}

// ── The manifest ──

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const READER_METHODS: readonly HttpMethod[] = ["GET", "POST"];
const ACTION_METHODS: readonly HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

export interface AppReader {
  name: string;
  title: string;
  description?: string;
  method: HttpMethod;
  path: string;
  input: JsonSchema;
  output_hint?: string;
}

export type AppRisk = "low" | "high";

export interface AppAction {
  name: string;
  title: string;
  description?: string;
  method: HttpMethod;
  path: string;
  input: JsonSchema;
  idempotent: boolean;
  risk: AppRisk;
}

export type AppWatchKind = "check" | "job";

export interface AppWatch {
  reader: string;
  every: string;
  every_ms: number;
  kind: AppWatchKind;
  /**
   * Row field names. `at` is when the row happened: required for a job
   * watch, whose reader lists recent failures, so a failure listed on every
   * poll is counted once.
   */
  map: { id: string; ok: string; title?: string; detail?: string; at?: string };
}

export interface AppManifest {
  name: string;
  version: string;
  readers: AppReader[];
  actions: AppAction[];
  watches: AppWatch[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FIELD_RE = /^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,99}$/;

/**
 * A path under the base url: absolute, no scheme, host, query, fragment or
 * dot segment, so a manifest cannot steer the secret to another host or out
 * of the base path. `{name}` segments are filled from the args.
 */
export function isSafeAppPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 300) return false;
  if (/[?#\\\s]/.test(path) || path.includes("://")) return false;
  return !path.split("/").some((seg) => seg === "." || seg === ".." || /%2e/i.test(seg) || /%2f/i.test(seg));
}

/** Raw SQL is never a reader (X8): refused by name, path and argument. */
export function looksLikeRawSql(def: { name: string; path: string; input?: JsonSchema }): boolean {
  const word = /(^|[^a-z])sql([^a-z]|$)/i;
  if (word.test(def.name) || word.test(def.path)) return true;
  return Object.keys(def.input?.properties ?? {}).some((k) => word.test(k));
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function inputSchema(raw: unknown, where: string): JsonSchema | string {
  if (raw === undefined) return { type: "object" };
  if (!isPlainObject(raw)) return `${where}: input must be a JSON Schema object`;
  if (raw.type !== undefined && raw.type !== "object") return `${where}: input must describe an object`;
  return raw as JsonSchema;
}

function method(raw: unknown, allowed: readonly HttpMethod[], fallback: HttpMethod, where: string): HttpMethod | string {
  if (raw === undefined) return fallback;
  const m = typeof raw === "string" ? (raw.toUpperCase() as HttpMethod) : undefined;
  return m && allowed.includes(m) ? m : `${where}: method must be ${allowed.join(" or ")}`;
}

/**
 * A manifest as served, checked and normalized, or every problem with it.
 * Strict on whatever decides where a call goes or whether it may run (names,
 * paths, methods, risk); lenient on prose. A missing `risk` is high and a
 * missing `idempotent` is false: the side that asks a person.
 */
export function parseAppManifest(raw: unknown): { ok: true; manifest: AppManifest } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) return { ok: false, errors: ["manifest is not a JSON object"] };
  const errors: string[] = [];
  const name = text(raw.name, 100);
  if (!name) errors.push("manifest needs a name");
  const list = (key: string, cap: number): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      errors.push(`${key} must be an array`);
      return [];
    }
    if (v.length > cap) errors.push(`${key}: at most ${cap}, got ${v.length}`);
    return v.slice(0, cap);
  };

  const seen = new Set<string>();
  const common = (r: unknown, kind: "reader" | "action", i: number, methods: readonly HttpMethod[], fallback: HttpMethod) => {
    const where = `${kind}s[${i}]`;
    if (!isPlainObject(r)) {
      errors.push(`${where} is not an object`);
      return null;
    }
    const n = typeof r.name === "string" ? r.name.trim() : "";
    if (!NAME_RE.test(n)) {
      errors.push(`${where}: name "${String(r.name ?? "")}" must be letters, digits, dots, dashes or underscores`);
      return null;
    }
    const at = `${kind} ${n}`;
    if (seen.has(`${kind}:${n}`)) errors.push(`${at}: declared twice`);
    seen.add(`${kind}:${n}`);
    if (!isSafeAppPath(r.path)) errors.push(`${at}: path must be an absolute path under the base url, got ${JSON.stringify(r.path)}`);
    const m = method(r.method, methods, fallback, at);
    if (!methods.includes(m as HttpMethod)) errors.push(m);
    const input = inputSchema(r.input, at);
    if (typeof input === "string") errors.push(input);
    return {
      name: n,
      title: text(r.title, 200) ?? n,
      description: text(r.description, 2000),
      method: m as HttpMethod,
      path: String(r.path ?? ""),
      input: typeof input === "string" ? { type: "object" as const } : input,
      raw: r,
    };
  };

  const readers: AppReader[] = [];
  list("readers", APP_LIMITS.max_readers).forEach((r, i) => {
    const c = common(r, "reader", i, READER_METHODS, "GET");
    if (!c) return;
    if (looksLikeRawSql(c)) errors.push(`reader ${c.name}: raw SQL is never a reader; declare a named reader instead`);
    readers.push({
      name: c.name,
      title: c.title,
      method: c.method,
      path: c.path,
      input: c.input,
      ...(c.description ? { description: c.description } : {}),
      ...(text(c.raw.output_hint, 2000) ? { output_hint: text(c.raw.output_hint, 2000) } : {}),
    });
  });

  const actions: AppAction[] = [];
  list("actions", APP_LIMITS.max_actions).forEach((r, i) => {
    const c = common(r, "action", i, ACTION_METHODS, "POST");
    if (!c) return;
    const risk = c.raw.risk === undefined ? "high" : c.raw.risk;
    if (risk !== "low" && risk !== "high") errors.push(`action ${c.name}: risk must be "low" or "high"`);
    if (c.raw.idempotent !== undefined && typeof c.raw.idempotent !== "boolean") errors.push(`action ${c.name}: idempotent must be true or false`);
    actions.push({
      name: c.name,
      title: c.title,
      method: c.method,
      path: c.path,
      input: c.input,
      idempotent: c.raw.idempotent === true,
      risk: risk === "low" ? "low" : "high",
      ...(c.description ? { description: c.description } : {}),
    });
  });

  const readerNames = new Set(readers.map((r) => r.name));
  const watches: AppWatch[] = [];
  list("watches", APP_LIMITS.max_watches).forEach((w, i) => {
    const where = `watches[${i}]`;
    if (!isPlainObject(w)) return void errors.push(`${where} is not an object`);
    const reader = typeof w.reader === "string" ? w.reader.trim() : "";
    if (!readerNames.has(reader)) return void errors.push(`${where}: no reader named "${reader}"`);
    if (w.kind !== "check" && w.kind !== "job") return void errors.push(`${where}: kind must be "check" or "job"`);
    let everyMs: number;
    try {
      everyMs = parseDuration(String(w.every ?? ""));
    } catch (e: any) {
      return void errors.push(`${where}: every: ${e?.message ?? e}`);
    }
    if (everyMs < APP_LIMITS.min_watch_ms || everyMs > APP_LIMITS.max_watch_ms) {
      return void errors.push(`${where}: every must be between 5m and 24h`);
    }
    const map = isPlainObject(w.map) ? w.map : {};
    const field = (k: string, required: boolean): string | undefined => {
      const v = map[k];
      if (v === undefined && !required) return undefined;
      if (typeof v !== "string" || !FIELD_RE.test(v)) {
        errors.push(`${where}: map.${k} must name a row field`);
        return undefined;
      }
      return v;
    };
    const id = field("id", true);
    const ok = field("ok", true);
    const title = field("title", false);
    const detail = field("detail", false);
    const at = field("at", w.kind === "job");
    if (!id || !ok || (w.kind === "job" && !at)) return;
    watches.push({
      reader,
      every: String(w.every).trim(),
      every_ms: everyMs,
      kind: w.kind,
      map: { id, ok, ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(at ? { at } : {}) },
    });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { name: name!, version: text(raw.version, 100) ?? "0", readers, actions, watches } };
}

/** One watch's identity in the source's watch state: a reader may feed a check watch and a job watch. */
export function watchKey(w: Pick<AppWatch, "reader" | "kind">): string {
  return `${w.kind}:${w.reader}`;
}

// ── Calls ──

/** JSON with object keys sorted at every depth, so equal args hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The request a call makes: `{name}` path segments filled from the args and
 * removed from them, the rest as query parameters on GET and DELETE and as a
 * JSON body otherwise. A placeholder with no arg is an error, never an empty
 * segment.
 */
export function buildAppRequest(
  baseUrl: string,
  def: Pick<AppReader, "method" | "path">,
  args: Record<string, unknown>,
): { ok: true; url: string; method: HttpMethod; body?: string } | { ok: false; error: string } {
  const rest: Record<string, unknown> = { ...args };
  let missing: string | null = null;
  let unsafe: string | null = null;
  const path = def.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => {
    const v = rest[key];
    delete rest[key];
    if (v === undefined || v === null || typeof v === "object" || !String(v).trim()) {
      missing ??= key;
      return "";
    }
    // encodeURIComponent leaves `.` and `..` alone, and URL parsing collapses
    // them, so a value could steer the call to an undeclared route.
    if (String(v) === "." || String(v) === "..") {
      unsafe ??= key;
      return "";
    }
    return encodeURIComponent(String(v));
  });
  if (missing) return { ok: false, error: `the path needs ${missing}` };
  if (unsafe) return { ok: false, error: `${unsafe} cannot be . or ..` };
  const base = baseUrl.replace(/\/+$/, "");
  if (!landsOnTemplate(base, path)) return { ok: false, error: "the filled path leaves the declared route" };
  if (def.method === "GET" || def.method === "DELETE") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, typeof item === "object" ? JSON.stringify(item) : String(item));
    }
    const q = qs.toString();
    return { ok: true, url: `${base}${path}${q ? `?${q}` : ""}`, method: def.method };
  }
  return { ok: true, url: `${base}${path}`, method: def.method, body: JSON.stringify(rest) };
}

/** The parsed url still sits under the base path with the template's segment count, so nothing collapsed. */
function landsOnTemplate(base: string, path: string): boolean {
  try {
    const basePath = new URL(base).pathname.replace(/\/+$/, "");
    const got = new URL(`${base}${path}`).pathname;
    return got.startsWith(`${basePath}/`) && got.split("/").length === `${basePath}${path}`.split("/").length;
  } catch {
    return false;
  }
}

/** Header-safe text: printable ASCII without the separators the header uses. */
function headerPart(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").replace(/[;=,]/g, "").trim().slice(0, 200);
}

/**
 * X-Codecast-Actor: who a call runs for, so the product's own audit names a
 * person and the session acting for them. "person=<email>; session=<id>".
 */
export function formatActorHeader(actor: { person?: string; session?: string; watch?: string }): string {
  const parts: string[] = [];
  if (actor.person) parts.push(`person=${headerPart(actor.person)}`);
  if (actor.session) parts.push(`session=${headerPart(actor.session)}`);
  if (actor.watch) parts.push(`watch=${headerPart(actor.watch)}`);
  return parts.join("; ");
}

// ── Grants and the do gate ──

export interface AppGrant {
  action: string;
  granted_by: string;
  granted_at: number;
  until?: number;
  /** How it was granted. Only a person in the browser ("session") grants; an api_token grant is from before that rule and counts for nothing. */
  via?: "session" | "api_token";
}

/** The grant that lets `action` run now, if any. An expired grant, or one an api token made, is no grant. */
export function activeGrant<G extends AppGrant>(grants: readonly G[] | undefined, action: string, now: number): G | undefined {
  return (grants ?? []).find((g) => g.action === action && g.via !== "api_token" && (g.until === undefined || g.until > now));
}

/** What a grant covers and the rules its calls follow. */
export type GrantableAction = Pick<AppAction, "name" | "title" | "risk" | "idempotent"> & { description?: string };

/**
 * The writes a vendor source makes in the vendor's own product, granted the
 * same way a manifest's actions are. Sentry's: `cast events resolve` (and
 * reopening) is issue.resolve, `cast events ignore` is issue.ignore.
 */
export const VENDOR_ACTIONS: Readonly<Record<string, readonly GrantableAction[]>> = {
  sentry: [
    { name: "issue.resolve", title: "Resolve or reopen an issue in Sentry", description: "cast events resolve on a Sentry group", risk: "low", idempotent: true },
    { name: "issue.ignore", title: "Ignore an issue in Sentry", description: "cast events ignore on a Sentry group", risk: "low", idempotent: true },
  ],
};

/** The actions a source can be granted: its manifest's for an app connector, the vendor's fixed writes otherwise. */
export function grantableActions(provider: string, manifest: Pick<AppManifest, "actions"> | null | undefined): readonly GrantableAction[] {
  return provider === "app" ? manifest?.actions ?? [] : VENDOR_ACTIONS[provider] ?? [];
}

/** Whether a source has anything to grant at all (an app connector, or a vendor with writes). */
export const sourceHasGrants = (provider: string): boolean => provider === "app" || provider in VENDOR_ACTIONS;

/** The grant a Sentry status write needs. Reopening is the resolve grant's other half. */
export function sentryStatusAction(status: "resolved" | "ignored" | "unresolved"): string {
  return status === "ignored" ? "issue.ignore" : "issue.resolve";
}

/** Where a person grants a source's actions: the Ops Apps tab (web opsHref.tab("apps", { app })). */
export function grantPagePath(sourceRef: string): string {
  return `/ops/apps?app=${encodeURIComponent(sourceRef)}`;
}

/**
 * The one check every write outside codecast passes (X8): an app connector's
 * `do` and a vendor write such as a Sentry resolve. Null when it may run, else
 * why not. `grantUrl` is where a person grants it, named in the refusal.
 */
export function writeRefusal(
  actions: readonly GrantableAction[],
  grants: readonly AppGrant[] | undefined,
  name: string,
  opts: { yes?: boolean; idempotency_key?: string; grantUrl?: string },
  now: number,
): string | null {
  const def = actions.find((a) => a.name === name);
  if (!def) return `no action ${name} to grant (there are: ${actions.map((a) => a.name).join(", ") || "none"})`;
  return doRefusal(def, grants, opts, now);
}

/** The grants with `grant` in place of any earlier grant of the same action, expired ones dropped. */
export function withGrant<G extends AppGrant>(grants: readonly G[] | undefined, grant: G, now: number): G[] {
  return [...(grants ?? []).filter((g) => g.action !== grant.action && (g.until === undefined || g.until > now)), grant];
}

/**
 * Why an action may not run, or null when it may (X8): it must be granted
 * by a person and not expired, a high-risk action needs `yes` on this very
 * call, and a non-idempotent action needs an idempotency key so a retry
 * cannot do it twice.
 */
export function doRefusal(
  action: Pick<AppAction, "name" | "risk" | "idempotent">,
  grants: readonly AppGrant[] | undefined,
  opts: { yes?: boolean; idempotency_key?: string; grantUrl?: string },
  now: number,
): string | null {
  if (!activeGrant(grants, action.name, now)) {
    return `${action.name} is not granted: a person grants it in the browser, under Ops, Apps${opts.grantUrl ? ` (${opts.grantUrl})` : ""}. An agent cannot grant it.`;
  }
  if (action.risk === "high" && !opts.yes) return `${action.name} is high risk: confirm this call with --yes`;
  if (!action.idempotent && !opts.idempotency_key?.trim()) {
    return `${action.name} is not idempotent: pass an idempotency key so a retry cannot run it twice`;
  }
  return null;
}

// ── Watches ──

function field(row: Record<string, unknown>, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const TRUE_WORDS = new Set(["true", "ok", "pass", "passed", "green", "healthy", "success", "succeeded"]);
const FALSE_WORDS = new Set(["false", "fail", "failed", "failing", "red", "error", "unhealthy", "failure"]);

function truth(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
  }
  return undefined;
}

function stampOf(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The rows of a reader's response: the array itself, or the array under rows, items or data. */
export function responseRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (isPlainObject(body)) {
    for (const k of ["rows", "items", "data", "results"]) if (Array.isArray(body[k])) return body[k] as unknown[];
  }
  return null;
}

/**
 * A watched reader's response as raw ingest items (validateIngestBatch then
 * normalizes and clips them, as for anything else entering the door).
 *
 * A check row reports its state every poll, red or green; the group rules
 * announce only the flips. A job row is one failure, so only failed rows
 * newer than `since` count, and `cursor` is the newest row time seen: a
 * reader that lists the last day's failures on every poll counts each once.
 */
export function mapWatchRows(
  watch: AppWatch,
  body: unknown,
  opts: { now: number; since?: number },
): { ok: true; items: Record<string, unknown>[]; skipped: number; cursor?: number } | { ok: false; error: string } {
  const rows = responseRows(body);
  if (!rows) return { ok: false, error: `reader ${watch.reader} did not answer with a list of rows` };
  const since = opts.since ?? opts.now - watch.every_ms;
  const items: Record<string, unknown>[] = [];
  let skipped = 0;
  let cursor: number | undefined;
  for (const row of rows.slice(0, APP_LIMITS.watch_rows)) {
    if (!isPlainObject(row)) {
      skipped++;
      continue;
    }
    const idRaw = field(row, watch.map.id);
    const id = typeof idRaw === "string" || typeof idRaw === "number" ? String(idRaw) : "";
    const ok = truth(field(row, watch.map.ok));
    if (!id || ok === undefined) {
      skipped++;
      continue;
    }
    const titleRaw = watch.map.title ? field(row, watch.map.title) : undefined;
    const detailRaw = watch.map.detail ? field(row, watch.map.detail) : undefined;
    const title = typeof titleRaw === "string" || typeof titleRaw === "number" ? String(titleRaw) : undefined;
    const detail = detailRaw === undefined || detailRaw === null ? undefined : typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw);
    const at = watch.map.at ? stampOf(field(row, watch.map.at)) : undefined;
    if (watch.kind === "check") {
      items.push({ type: "check", id, ok, ...(title ? { title } : {}), ...(detail ? { detail } : {}), at: at ?? opts.now });
      continue;
    }
    if (at === undefined) {
      skipped++;
      continue;
    }
    cursor = Math.max(cursor ?? 0, at);
    if (ok || at <= since) continue;
    items.push({ type: "job_failed", job: title ?? id, error: detail ?? "failed", job_id: id, at });
  }
  skipped += Math.max(0, rows.length - APP_LIMITS.watch_rows);
  return { ok: true, items, skipped, ...(cursor !== undefined ? { cursor } : {}) };
}
