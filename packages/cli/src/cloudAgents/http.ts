/**
 * The HTTP side every cloud agent API shares: one error type that knows when
 * the provider refused the credentials, a JSON request and an event stream
 * that read the provider's reason from whichever shape it answers with, the
 * key check run before a key is stored, and the base of a keyed API client.
 */
import type { ProviderKeyFacts, ProviderKeyVerdict } from "../providerKeyCrypto.js";
import { readSseJson } from "../sse.js";
import { CloudApiError, cloudApiErrorOf } from "./apiError.js";
import { errorText } from "./types.js";

export { CloudApiError, cloudApiErrorOf };

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

/** A body as JSON; undefined when it is empty or not JSON. */
function jsonOf(text: string): unknown {
  try { return text ? JSON.parse(text) : undefined; } catch { return undefined; }
}

/** The provider's error from a non-2xx answer, read from its body (JSON or none). */
async function errorOfResponse(resp: Response, req: Pick<CloudRequest, "label" | "now">, text?: string): Promise<CloudApiError> {
  const json = jsonOf(text ?? await resp.text().catch(() => ""));
  return cloudApiErrorOf(resp.status, json, `${req.label} ${resp.status}`, resp.status === 429 ? parseRetryAfter(resp.headers.get("retry-after"), req.now ?? Date.now()) : undefined);
}

/** The one fetch every cloud API request makes: JSON in, `accept` out. */
function cloudFetch(fetchImpl: typeof fetch, req: Pick<CloudRequest, "method" | "url" | "headers" | "body">, accept: string, signal?: AbortSignal): Promise<Response> {
  return fetchImpl(req.url, {
    method: req.method,
    headers: { Accept: accept, ...(req.body === undefined ? {} : { "Content-Type": "application/json" }), ...req.headers },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal,
  });
}

/**
 * A request answered with Server-Sent Events: resolves once the stream is
 * open, to its JSON frames as they come (until `endEvent`, when the provider
 * names one). A non-2xx answer throws a CloudApiError with the provider's
 * reason. No timeout: a stream lasts as long as the work it follows, so the
 * caller's signal ends it.
 */
export async function requestCloudEvents<T>(fetchImpl: typeof fetch, req: Omit<CloudRequest, "timeoutMs"> & { signal?: AbortSignal; endEvent?: string }): Promise<AsyncGenerator<{ event?: string; id?: string; data: T }>> {
  const resp = await cloudFetch(fetchImpl, req, "text/event-stream", req.signal);
  if (!resp.ok || !resp.body) throw await errorOfResponse(resp, req);
  return readSseJson<T>(resp.body, { endEvent: req.endEvent });
}

/**
 * Check a key before it is stored: `check` makes one authenticated call with
 * it (the account it names, when the provider says, and `detail`: what a key
 * the provider knows still lacks). A key the provider refuses is said in its
 * words; a network failure is said as such, never as a bad key.
 */
export async function verifyCloudKey(vendor: string, check: () => Promise<ProviderKeyFacts | void>): Promise<ProviderKeyVerdict> {
  try {
    return { ok: true, ...(await check()) };
  } catch (err) {
    if (err instanceof CloudApiError && err.keyRejected) return { ok: false, error: `${vendor} rejected this key: ${err.message}` };
    return { ok: false, error: `Couldn't reach ${vendor} to check the key: ${errorText(err)}` };
  }
}

/** A JSON request; a non-2xx answer throws a CloudApiError with the provider's reason. */
export async function requestCloudJson<T>(fetchImpl: typeof fetch, req: CloudRequest): Promise<T> {
  const resp = await cloudFetch(fetchImpl, req, "application/json", AbortSignal.timeout(req.timeoutMs ?? 60_000));
  const text = await resp.text();
  if (!resp.ok) throw await errorOfResponse(resp, req, text);
  return jsonOf(text) as T;
}

/**
 * The client of a cloud agent API reached with a key: each request goes to
 * `base` with the provider's auth headers, and an error with no reason of its
 * own is named after `name` and the path.
 */
export abstract class KeyedCloudApi {
  constructor(protected readonly key: string, protected readonly fetchImpl: typeof fetch, protected readonly base: string, private readonly name: string) {}

  protected abstract headers(): Record<string, string>;

  private label(method: string, p: string): string {
    return `${this.name} ${method} ${p.split("?")[0]}`;
  }

  request<T>(method: string, p: string, body?: unknown): Promise<T> {
    return requestCloudJson<T>(this.fetchImpl, { method, url: `${this.base}${p}`, headers: this.headers(), body, label: this.label(method, p) });
  }

  /** An event stream (requestCloudEvents): `headers` adds to the auth ones (a resume's Last-Event-ID). */
  protected events<T>(method: string, p: string, opts: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string>; endEvent?: string } = {}): Promise<AsyncGenerator<{ event?: string; id?: string; data: T }>> {
    return requestCloudEvents<T>(this.fetchImpl, { method, url: `${this.base}${p}`, headers: { ...this.headers(), ...opts.headers }, body: opts.body, label: `${this.label(method, p)} stream`, signal: opts.signal, endEvent: opts.endEvent });
  }
}
