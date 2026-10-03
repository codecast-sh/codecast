// The codecast sink: errors, warning logs, job failures, checks, counted
// events, deploys and replay manifests, batched to codecast's ingest door
// (POST <endpoint>/<ingestKey>, codecast docs/architecture/external-data.md X2).
//
// Transport agnostic: plain fetch everywhere, gzip where CompressionStream
// exists, and a beacon flush on pagehide when there is a window. No React, no
// SDK peers, so a server, a worker and a browser bundle all load it.
//
// The ingest key is write-only and safe to ship in a browser bundle. Like the
// rest of the package this file reads no env: the app passes its committed
// codecast.json in (`config`), which `cast sources add` writes, or the key
// itself. An explicit ingestKey or endpoint wins over the file's.

import { runScrub, type UrlScrubber } from "./scrub";

/** Codecast's prod ingest door. The Caddy proxy in front of the Convex site forwards /cli. */
export const DEFAULT_CODECAST_INGEST_ENDPOINT = "https://convex.codecast.sh/cli/ingest";

export const CODECAST_SDK = { name: "@platform/analytics", version: "0.1.0" } as const;

/** The door's per request caps (codecast INGEST_LIMITS.max_items and max_bytes). */
export const CODECAST_BATCH_LIMITS = { max_items: 500, max_bytes: 1024 * 1024 } as const;

// Beacons are capped near 64 KB by every browser; stay under it with room for the envelope.
const BEACON_MAX_BYTES = 60 * 1024;
// A sink whose door is down must not grow without limit; the oldest items go first.
const QUEUE_LIMIT = 2_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

// The item shapes match codecast packages/shared/contracts/ingest.ts IngestItem.
// The platform package must not import codecast, so they are spelled here.
export type CodecastLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface CodecastUser {
  id?: string;
  email?: string;
  name?: string;
}

export type CodecastIngestItem =
  | {
      type: "error";
      message: string;
      stack?: string;
      level?: CodecastLogLevel;
      fingerprint?: string;
      tags?: Record<string, string>;
      context?: Record<string, unknown>;
      url?: string;
      user?: CodecastUser;
      replay_id?: string;
      at: number;
    }
  | { type: "log"; level: CodecastLogLevel; message: string; fingerprint?: string; context?: Record<string, unknown>; at: number }
  | { type: "job_failed"; job: string; error: string; attempt?: number; job_id?: string; at: number }
  | { type: "check"; id: string; ok: boolean; title?: string; detail?: string; at: number }
  | { type: "event"; name: string; props?: Record<string, unknown>; at: number }
  | { type: "deploy"; version: string; sha?: string; environment?: string; at: number }
  | {
      type: "replay";
      replay_id: string;
      url?: string;
      user?: CodecastUser;
      started_at?: number;
      duration_ms?: number;
      chunks?: number;
      counts?: { clicks?: number; errors?: number; failed_requests?: number };
      at: number;
    };

/**
 * codecast.json, the committed codecast config (codecast
 * packages/shared/contracts/codecastConfig.ts; spelled here because the
 * platform package must not import codecast). Nothing in it is secret.
 */
export interface CodecastJson {
  endpoint?: string;
  ingestKey?: string;
  sources: Record<string, { id: string; workspace: string }>;
}

const SOURCE_ID = /^src-\d+$/;
const WORKSPACE = /^(team|user):[A-Za-z0-9_-]+$/;

/** A codecast.json as read (JSON already parsed), or why it is not one. Unknown keys are refused. */
export function parseCodecastJson(raw: unknown): { ok: true; config: CodecastJson } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["codecast.json is not a JSON object"] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(r)) if (!["$schema", "endpoint", "ingestKey", "sources"].includes(key)) errors.push(`unknown key "${key}"`);
  const config: CodecastJson = { sources: {} };
  if (r.endpoint !== undefined) {
    if (typeof r.endpoint !== "string" || !/^https?:\/\/[^\s]+$/.test(r.endpoint)) errors.push("endpoint must be an http(s) URL");
    else config.endpoint = r.endpoint.replace(/\/+$/, "");
  }
  if (r.ingestKey !== undefined) {
    if (typeof r.ingestKey !== "string" || !/^cc_ing_[A-Za-z0-9_-]+$/.test(r.ingestKey)) errors.push("ingestKey must be a cc_ing_ key");
    else config.ingestKey = r.ingestKey;
  }
  const sources = r.sources;
  if (sources !== undefined && (!sources || typeof sources !== "object" || Array.isArray(sources))) errors.push("sources must be an object of name to { id, workspace }");
  for (const [name, s] of Object.entries(sources && typeof sources === "object" && !Array.isArray(sources) ? (sources as Record<string, unknown>) : {})) {
    const src = s as { id?: unknown; workspace?: unknown } | null;
    if (!src || typeof src.id !== "string" || !SOURCE_ID.test(src.id) || typeof src.workspace !== "string" || !WORKSPACE.test(src.workspace)) {
      errors.push(`sources.${name} must be { "id": "src-N", "workspace": "team:<id>" or "user:<id>" }`);
      continue;
    }
    config.sources[name] = { id: src.id, workspace: src.workspace };
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}

/** Where a codecast.json's codecast publishes its signing keys: the ingest endpoint's origin. */
export function codecastKeysUrl(config: Pick<CodecastJson, "endpoint"> | null | undefined): string {
  return `${new URL(config?.endpoint || DEFAULT_CODECAST_INGEST_ENDPOINT).origin}/.well-known/codecast-keys.json`;
}

export type CodecastErrorItem = Extract<CodecastIngestItem, { type: "error" }>;
export type CodecastReplayManifest = Omit<Extract<CodecastIngestItem, { type: "replay" }>, "type" | "at">;

export interface CodecastSinkConfig {
  /** The app's committed codecast.json (parsed JSON): its ingestKey and endpoint, unless given below. */
  config?: unknown;
  /** Write-only ingest key (cc_ing_...). Required unless `config` carries one. */
  ingestKey?: string;
  /** Ingest door base, without the key. Defaults to `config`'s, then codecast prod. */
  endpoint?: string;
  release?: string;
  environment?: string;
  /** How long an item waits for company before a batch goes. Default 5 s. */
  flushMs?: number;
  /** Items per request, capped at the door's 500. Default 100. */
  maxBatch?: number;
  /** fetch implementation. Defaults to the global fetch as it is at creation. */
  fetch?: typeof fetch;
  /** Overrides the sdk name and version in the envelope. */
  sdk?: { name: string; version: string };
  /** Rewrites secret URL parts before an error url or a replay URL is queued (./scrub). */
  scrubUrl?: UrlScrubber;
  /** Clock and timers, for tests. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface CaptureErrorOptions {
  context?: Record<string, unknown>;
  tags?: Record<string, string>;
  fingerprint?: string;
  level?: CodecastLogLevel;
  url?: string;
}

export type ReplaySignResult = { upload_url: string } | { exists: true };

/** One chunk to sign: its index in the recording and the hash and size of the exact bytes PUT. */
export interface ReplayChunkSign {
  replay_id: string;
  seq: number;
  sha256: string;
  size: number;
}

/** Lowercase hex sha256, the form the door's chunk keys use. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CodecastSink {
  readonly endpoint: string;
  readonly ingestKey: string;
  /** The door answered 401: the key is gone, so the sink dropped its queue and sends nothing more. */
  readonly stopped: boolean;
  /** Items waiting to go. */
  readonly pending: number;
  captureError(error: unknown, options?: CaptureErrorOptions): void;
  /** Only warn and above reach the door; lower levels are dropped here rather than there. */
  log(level: CodecastLogLevel, message: string, context?: Record<string, unknown>): void;
  jobFailed(job: string, error: unknown, options?: { attempt?: number; jobId?: string }): void;
  check(id: string, ok: boolean, options?: { title?: string; detail?: string }): void;
  event(name: string, props?: Record<string, unknown>): void;
  deploy(version: string, options?: { sha?: string; environment?: string }): void;
  replay(manifest: CodecastReplayManifest): void;
  setUser(user: CodecastUser | null): void;
  /** Error items carry this id, so a sample links to the recording that saw it. */
  setReplayId(replayId: string | undefined): void;
  /** Called with every error item as it is captured. The replay recorder listens here. */
  onError(listener: (item: CodecastErrorItem) => void): () => void;
  /**
   * Ask the door for a presigned PUT for one replay chunk (codecast
   * replaysHttp.ts). The key is content addressed by the sha256 of the bytes
   * that will be PUT, so a chunk already stored answers exists. null when the
   * request failed.
   */
  signReplayChunk(chunk: ReplayChunkSign): Promise<ReplaySignResult | null>;
  /** The configured URL rewrite (identity without one), for a recorder riding this sink. */
  scrubUrl(text: string): string;
  /** Send everything queued now. With beacon, use navigator.sendBeacon (page is going away). */
  flush(options?: { beacon?: boolean }): Promise<void>;
  /** Stop timers and listeners. Queued items are dropped. */
  close(): void;
}

/** Whether a log level is grouped at the door (codecast isGroupedLogLevel). */
export function isReportedLogLevel(level: CodecastLogLevel): boolean {
  return level === "warn" || level === "error" || level === "fatal";
}

/** The error a thrown value names, without assuming it is an Error. */
export function errorParts(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name || "Error", stack: error.stack };
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

/** Gzip a string when the runtime has CompressionStream; null otherwise. */
export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What a response status asks the sink to do with the batch it answered. */
export type SendOutcome = "ok" | "retry" | "drop" | "split" | "stop";

export function classifyStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "stop";
  if (status === 413) return "split";
  if (status === 429 || status >= 500 || status === 0) return "retry";
  // 400 and the rest: the batch itself is refused, and resending it never helps.
  return "drop";
}

/** Exponential backoff with full jitter, honoring a Retry-After the door sends. */
export function backoffMs(attempt: number, retryAfterHeader?: string | null, random: () => number = Math.random): number {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, BACKOFF_MAX_MS);
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(cap / 2 + (random() * cap) / 2);
}

/** The key and door a sink uses: explicit values first, then codecast.json's. Throws on a codecast.json that does not parse. */
export function resolveSinkTarget(config: Pick<CodecastSinkConfig, "config" | "ingestKey" | "endpoint">): { ingestKey?: string; endpoint: string } {
  let file: CodecastJson | undefined;
  if (config.config !== undefined) {
    const parsed = parseCodecastJson(config.config);
    if (!parsed.ok) throw new Error(`codecast.json: ${parsed.errors.join("; ")}`);
    file = parsed.config;
  }
  return {
    ingestKey: config.ingestKey || file?.ingestKey,
    endpoint: (config.endpoint || file?.endpoint || DEFAULT_CODECAST_INGEST_ENDPOINT).replace(/\/+$/, ""),
  };
}

export function createCodecastSink(config: CodecastSinkConfig): CodecastSink {
  const target = config ? resolveSinkTarget(config) : null;
  const ingestKey = target?.ingestKey;
  if (!target || typeof ingestKey !== "string" || !ingestKey) {
    throw new Error("ingestKey is required (pass it, or a codecast.json that carries one)");
  }
  const endpoint = target.endpoint;
  if (!/^https?:\/\//.test(endpoint)) throw new Error(`endpoint must be an http(s) URL, got ${JSON.stringify(endpoint)}`);
  const url = `${endpoint}/${encodeURIComponent(ingestKey)}`;
  // Captured now, so a recorder that wraps fetch later never sees the sink's own traffic.
  const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
  const doFetch = config.fetch ?? globalFetch;
  const now = config.now ?? (() => Date.now());
  const setTimer = config.setTimeout ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    // A server process must not stay alive for a telemetry flush.
    handle?.unref?.();
    return handle;
  });
  const clearTimer = config.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const flushMs = config.flushMs ?? 5_000;
  const maxBatch = Math.max(1, Math.min(config.maxBatch ?? 100, CODECAST_BATCH_LIMITS.max_items));
  const envelope = {
    sdk: config.sdk ?? CODECAST_SDK,
    ...(config.release ? { release: config.release } : {}),
    ...(config.environment ? { environment: config.environment } : {}),
  };

  let queue: CodecastIngestItem[] = [];
  let timer: unknown = null;
  let sending: Promise<void> | null = null;
  let attempt = 0;
  // While a retry waits out its backoff, a full queue does not jump the wait.
  let backingOff = false;
  let stopped = false;
  let closed = false;
  let user: CodecastUser | undefined;
  let replayId: string | undefined;
  const errorListeners = new Set<(item: CodecastErrorItem) => void>();

  const schedule = (ms: number) => {
    if (timer !== null || closed || stopped) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, ms);
  };

  const enqueue = (item: CodecastIngestItem) => {
    if (stopped || closed) return;
    queue.push(item);
    if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
    if (queue.length >= maxBatch && !backingOff) void flush();
    else schedule(flushMs);
  };

  const body = (items: CodecastIngestItem[]) => JSON.stringify({ ...envelope, items });

  /** POST one batch; resolves to what to do with it. */
  const post = async (items: CodecastIngestItem[]): Promise<{ outcome: SendOutcome; retryAfter?: string | null }> => {
    if (!doFetch) return { outcome: "drop" };
    const text = body(items);
    const gz = await gzipText(text);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: gz ? { "Content-Type": "application/json", "Content-Encoding": "gzip" } : { "Content-Type": "application/json" },
        body: gz ?? text,
        // keepalive lets a send started as the page leaves finish; browsers cap it near 64 KB.
        keepalive: (gz ? gz.byteLength : byteLength(text)) < BEACON_MAX_BYTES,
      } as RequestInit);
      return { outcome: classifyStatus(res.status), retryAfter: res.headers?.get?.("Retry-After") };
    } catch {
      return { outcome: "retry" };
    }
  };

  const stop = () => {
    stopped = true;
    queue = [];
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  /** Send one batch and follow its outcome. Returns false when the loop should pause. */
  const sendBatch = async (items: CodecastIngestItem[]): Promise<boolean> => {
    const { outcome, retryAfter } = await post(items);
    if (outcome === "ok" || outcome === "drop") {
      attempt = 0;
      backingOff = false;
      return true;
    }
    if (outcome === "stop") {
      stop();
      return false;
    }
    if (outcome === "split" && items.length > 1) {
      const half = Math.ceil(items.length / 2);
      return (await sendBatch(items.slice(0, half))) && (await sendBatch(items.slice(half)));
    }
    if (outcome === "split") return true; // one item over the cap never fits; let it go
    // Retry: back to the front of the queue, in order, after a backoff.
    queue = [...items, ...queue].slice(-QUEUE_LIMIT);
    const wait = backoffMs(attempt++, retryAfter);
    if (timer !== null) clearTimer(timer);
    timer = null;
    backingOff = true;
    schedule(wait);
    return false;
  };

  const drain = async () => {
    while (queue.length && !stopped && !closed) {
      const items = queue.splice(0, maxBatch);
      if (!(await sendBatch(items))) return;
    }
  };

  const beaconFlush = () => {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator) : undefined;
    if (!nav?.sendBeacon) return false;
    // text/plain keeps a beacon a simple request: a JSON content type would
    // need a preflight, which a beacon never makes. The door parses the body
    // text whatever its type.
    while (queue.length) {
      let n = Math.min(queue.length, maxBatch);
      while (n > 1 && byteLength(body(queue.slice(0, n))) > BEACON_MAX_BYTES) n = Math.ceil(n / 2);
      const items = queue.splice(0, n);
      try {
        nav.sendBeacon(url, new Blob([body(items)], { type: "text/plain;charset=UTF-8" }));
      } catch {
        // the page is leaving; nothing else to try
      }
    }
    return true;
  };

  const flush = async (options?: { beacon?: boolean }) => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (stopped || closed || !queue.length) return sending ?? undefined;
    if (options?.beacon && beaconFlush()) return;
    if (sending) {
      await sending;
      if (queue.length && !timer) return flush();
      return;
    }
    sending = drain().finally(() => {
      sending = null;
    });
    return sending;
  };

  // A page going away (tab closed, navigated, backgrounded on mobile) gets one
  // beacon with whatever is queued. pagehide fires where unload does not
  // (bfcache, iOS), and visibilitychange covers a tab that is simply killed later.
  const onPageHide = () => void flush({ beacon: true });
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") onPageHide();
  };
  const win = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : undefined;
  win?.addEventListener("pagehide", onPageHide);
  win?.addEventListener("visibilitychange", onVisibility);

  const pageUrl = () => {
    try {
      return typeof location !== "undefined" ? location.href : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    endpoint,
    ingestKey,
    get stopped() {
      return stopped;
    },
    get pending() {
      return queue.length;
    },
    captureError(error, options) {
      if (stopped || closed) return;
      const { message, stack } = errorParts(error);
      const at = options?.url ?? pageUrl();
      const where = at && runScrub(config.scrubUrl, at);
      const item: CodecastErrorItem = {
        type: "error",
        message,
        ...(stack ? { stack } : {}),
        ...(options?.level ? { level: options.level } : {}),
        ...(options?.fingerprint ? { fingerprint: options.fingerprint } : {}),
        ...(options?.tags ? { tags: options.tags } : {}),
        ...(options?.context ? { context: options.context } : {}),
        ...(where ? { url: where } : {}),
        ...(user ? { user } : {}),
        ...(replayId ? { replay_id: replayId } : {}),
        at: now(),
      };
      for (const listener of errorListeners) {
        try {
          listener(item);
        } catch {
          // a listener failing must not cost the report
        }
      }
      enqueue(item);
    },
    log(level, message, context) {
      if (!isReportedLogLevel(level)) return;
      enqueue({ type: "log", level, message, ...(context ? { context } : {}), at: now() });
    },
    jobFailed(job, error, options) {
      enqueue({
        type: "job_failed",
        job,
        error: errorParts(error).message,
        ...(options?.attempt !== undefined ? { attempt: options.attempt } : {}),
        ...(options?.jobId ? { job_id: options.jobId } : {}),
        at: now(),
      });
    },
    check(id, ok, options) {
      enqueue({ type: "check", id, ok, ...(options?.title ? { title: options.title } : {}), ...(options?.detail ? { detail: options.detail } : {}), at: now() });
    },
    event(name, props) {
      enqueue({ type: "event", name, ...(props ? { props } : {}), at: now() });
    },
    deploy(version, options) {
      const environment = options?.environment ?? config.environment;
      enqueue({ type: "deploy", version, ...(options?.sha ? { sha: options.sha } : {}), ...(environment ? { environment } : {}), at: now() });
    },
    replay(manifest) {
      enqueue({ type: "replay", ...manifest, ...(user && !manifest.user ? { user } : {}), at: now() });
    },
    setUser(next) {
      user = next ?? undefined;
    },
    scrubUrl(text) {
      return runScrub(config.scrubUrl, text);
    },
    setReplayId(next) {
      replayId = next;
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    async signReplayChunk(chunk) {
      if (!doFetch || stopped || closed) return null;
      try {
        const res = await doFetch(`${url}/replay-sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
        });
        if (classifyStatus(res.status) === "stop") stop();
        if (!res.ok) return null;
        const answer = (await res.json()) as Partial<{ upload_url: string | null; exists: boolean }>;
        if (answer?.exists === true) return { exists: true };
        if (typeof answer?.upload_url === "string") return { upload_url: answer.upload_url };
        return null;
      } catch {
        return null;
      }
    },
    flush,
    close() {
      closed = true;
      queue = [];
      if (timer !== null) clearTimer(timer);
      timer = null;
      errorListeners.clear();
      win?.removeEventListener("pagehide", onPageHide);
      win?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
