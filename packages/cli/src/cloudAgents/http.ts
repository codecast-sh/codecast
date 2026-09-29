/**
 * The HTTP side every cloud agent API shares: one error type that knows when
 * the provider refused the credentials, and a JSON request that reads the
 * provider's reason from whichever shape it answers with.
 */

export class CloudApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
  /** The provider refused the credentials (wrong, revoked, expired, or lacking access). */
  get keyRejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * A provider's reason and code from an error body. Providers answer with
 * `{error: {code, message}}`, `{code, message}` or `{detail}`.
 */
export function cloudApiErrorOf(status: number, body: unknown, fallback: string): CloudApiError {
  const b = body && typeof body === "object" ? body as Record<string, any> : {};
  const inner = b.error && typeof b.error === "object" ? b.error as Record<string, any> : b;
  const code = typeof inner.code === "string" ? inner.code : undefined;
  const message = [inner.message, b.detail].find((m): m is string => typeof m === "string" && !!m) ?? fallback;
  return new CloudApiError(status, code, message);
}

export interface CloudRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Names the request in an error that carries no reason. */
  label: string;
  timeoutMs?: number;
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
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch {}
  if (!resp.ok) throw cloudApiErrorOf(resp.status, json, `${req.label} ${resp.status}`);
  return json as T;
}
