/**
 * A cloud agent provider's error, read from whichever body shape it answers
 * with. A leaf on purpose: the transcript writer reads errors through it, and
 * the CLI's command tree loads that writer without the HTTP client behind it.
 */
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
