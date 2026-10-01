/**
 * The HTTP side every cloud agent API shares: one error type that knows when
 * the provider refused the credentials, a JSON request and an SSE request
 * that read the provider's reason from whichever shape it answers with, and
 * the key check run before a key is stored.
 */
import type { ProviderKeyVerdict } from "../providerKeyCrypto.js";
import { errorText } from "./types.js";

export class CloudApiError extends Error {
  /**
   * `fromApi`: the body was the provider's own error (it named a reason or a
   * code). A proxy in front of the API (a bot challenge page) answers without
   * one, and that says nothing about the account.
   */
  readonly fromApi: boolean;
  /** Set only when the provider named a wait (a 429's Retry-After); otherwise the caller picks its own delay. */
  readonly retryAfterMs?: number;
  constructor(readonly status: number, readonly code: string | undefined, message: string, opts: { fromApi?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.fromApi = opts.fromApi ?? true;
    this.retryAfterMs = opts.retryAfterMs;
  }
  /** The provider refused the credentials (wrong, revoked, expired, or lacking access); a 403 only in the provider's own words. */
  get keyRejected(): boolean {
    return this.status === 401 || (this.status === 403 && this.fromApi);
  }
}

/**
 * A provider's reason and code from an error body. Providers answer with
 * `{error: {code|type, message}}`, `{code, message}`, `{detail}` or
 * `{detail: {type, message}}`.
 */
export function cloudApiErrorOf(status: number, body: unknown, fallback: string, retryAfterMs?: number): CloudApiError {
  const b = body && typeof body === "object" ? body as Record<string, any> : {};
  const nested = [b.error, b.detail].find((o) => o && typeof o === "object") as Record<string, any> | undefined;
  const inner = nested ?? b;
  const code = [inner.code, inner.type].find((c): c is string => typeof c === "string" && !!c);
  const reason = [inner.message, b.detail].find((m): m is string => typeof m === "string" && !!m);
  return new CloudApiError(status, code, reason ?? fallback, { fromApi: !!(reason || code), retryAfterMs });
}

// A corrupt or hostile Retry-After would otherwise hold a poll off for years.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Retry-After (RFC 9110) in ms: either delta-seconds or an HTTP date. Capped
 * at 24h. Undefined when the header is absent, unparseable, or already past:
 * the caller then falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : undefined;
}

export interface CloudRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Names the request in an error that carries no reason. */
  label: string;
  timeoutMs?: number;
  /** The clock a Retry-After date is read against (tests). */
  now?: number;
}

/** The provider's error from a non-2xx answer, read from its body (JSON or none). */
async function errorOfResponse(resp: Response, req: Pick<CloudRequest, "label" | "now">, text?: string): Promise<CloudApiError> {
  let json: unknown = undefined;
  try { const body = text ?? await resp.text(); json = body ? JSON.parse(body) : undefined; } catch {}
  return cloudApiErrorOf(resp.status, json, `${req.label} ${resp.status}`, resp.status === 429 ? parseRetryAfter(resp.headers.get("retry-after"), req.now ?? Date.now()) : undefined);
}

/**
 * A request answered with Server-Sent Events: its body, to read with readSse
 * (sse.ts). A non-2xx answer throws a CloudApiError with the provider's
 * reason. No timeout: a stream lasts as long as the work it follows, so the
 * caller's signal ends it.
 */
export async function requestCloudStream(fetchImpl: typeof fetch, req: Omit<CloudRequest, "timeoutMs"> & { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
  const resp = await fetchImpl(req.url, {
    method: req.method,
    headers: { Accept: "text/event-stream", ...(req.body === undefined ? {} : { "Content-Type": "application/json" }), ...req.headers },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: req.signal,
  });
  if (!resp.ok || !resp.body) throw await errorOfResponse(resp, req);
  return resp.body;
}

/**
 * Check a key before it is stored: `check` makes one authenticated call with
 * it (the account it names, when the provider says, and `detail`: what a key
 * the provider knows still lacks). A key the provider refuses is said in its
 * words; a network failure is said as such, never as a bad key.
 */
export async function verifyCloudKey(vendor: string, check: () => Promise<{ account?: string; detail?: string } | void>): Promise<ProviderKeyVerdict> {
  try {
    const found = await check();
    return { ok: true, ...(found?.account ? { account: found.account } : {}), ...(found?.detail ? { detail: found.detail } : {}) };
  } catch (err) {
    if (err instanceof CloudApiError && err.keyRejected) return { ok: false, error: `${vendor} rejected this key: ${err.message}` };
    return { ok: false, error: `Couldn't reach ${vendor} to check the key: ${errorText(err)}` };
  }
}

/** A JSON request; a non-2xx answer throws a CloudApiError with the provider's reason. */
export async function requestCloudJson<T>(fetchImpl: typeof fetch, req: CloudRequest): Promise<T> {
  const resp = await fetchImpl(req.url, {
    method: req.method,
    headers: { Accept: "application/json", ...(req.body === undefined ? {} : { "Content-Type": "application/json" }), ...req.headers },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  });
  const text = await resp.text();
  if (!resp.ok) throw await errorOfResponse(resp, req, text);
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch {}
  return json as T;
}
