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
    return cloudApiVerdict(this) === "refused";
  }
}

/**
 * What a failed call's status says, the one place every HTTP rule lives:
 * "gone" (404 or 410 on a call about one agent the provider did not just
 * list: deleted there), "busy" (409: a turn still runs), "limit" (429),
 * "refused" (the credentials: 401, or 403 in the provider's own words),
 * "denied" (403 on a call about one agent: that one alone), "unexpected"
 * (any other 4xx the provider itself gave, a 404 on the list or on an agent
 * it just listed included: a call codecast makes should never get one, so
 * its API changed), else "outage" (a 5xx, a timeout, the network, or a
 * proxy's page in front of the API: none says anything about the API).
 */
export type CloudApiVerdict = "gone" | "busy" | "limit" | "refused" | "denied" | "unexpected" | "outage";

/**
 * `oneAgent`: the call was about one agent, so a 404 or 410 finds it deleted,
 * and a 403 ("denied") refuses that agent alone, not the credentials.
 * `listed`: the provider listed that agent moments ago, so a 404 on it is no
 * deletion but an endpoint that moved.
 */
export function cloudApiVerdict(err: unknown, opts: { oneAgent?: boolean; listed?: boolean } = {}): CloudApiVerdict {
  if (!(err instanceof CloudApiError)) return "outage";
  const { status, fromApi } = err;
  if (opts.oneAgent && !opts.listed && (status === 404 || status === 410)) return "gone";
  if (opts.oneAgent && status === 403 && fromApi) return "denied";
  if (status === 409) return "busy";
  if (status === 429) return "limit";
  if (status === 401 || (status === 403 && fromApi)) return "refused";
  return fromApi && status >= 400 && status < 500 && status !== 408 ? "unexpected" : "outage";
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
  return new CloudApiError(status, code, reason ? withoutKeys(reason) : fallback, { fromApi: !!(reason || code), retryAfterMs });
}

/**
 * A provider's reason with any API key it quotes taken out ("Incorrect API
 * key provided: sk-proj-****abcd"): the reason reaches cards synced to the
 * team, command results and the log, and no part of a key leaves the machine.
 */
function withoutKeys(reason: string): string {
  return reason.replace(/\b(?:sk[-_]|key_|crsr_)[\w*-]{4,}/g, "the key");
}
