// One bearer-token HTTP client for every outside service a token connection
// reaches (Sentry, PostHog, a product's app connector, and the validate call
// that proves a pasted token). Every call:
//   - refuses a host inside our own network (loopback, private, link-local,
//     CGNAT, unique-local, the deployment's own hosts), since Convex runs
//     these fetches from inside codecast's network;
//   - refuses redirects, so a token is never carried to a host nobody named,
//     and cancels the redirect's body;
//   - is aborted after a timeout;
//   - reads the answer capped as it streams;
//   - never puts the token or a redirect target in an error message.
// Vendors map statuses to their own wording in thin wrappers. A leaf module
// with no Convex imports, so the adapters, replays and tokenConnectors can all
// load it without a cycle.

import { internalHostRefusal, type FetchLike } from "./guardedFetch";

export type { FetchLike };
/** The literal-host check every server fetch shares (lib/guardedFetch); token calls go to a host a person pasted. */
export { internalHostRefusal };

export const TOKEN_HTTP_TIMEOUT_MS = 15_000;
/** The cap when a caller names none: no vendor answer this feature reads is near it. */
export const TOKEN_HTTP_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A response body of at most `max` bytes, or null. Refuses on the declared
 * length first, then counts while streaming so a lying or absent header still
 * stops at the cap.
 */
export async function readBodyCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > max ? null : whole;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── The call ──

export interface TokenHttpRequest {
  url: string;
  method?: string;
  /** Sent as is; a JSON body is the caller's to stringify. */
  body?: string;
  /** The bearer secret. Absent for a codecast-signed app connection, which carries its signature in `headers`. */
  token?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  /** The service's name in messages ("Sentry", "PostHog"). */
  vendor: string;
}

export interface TokenHttpResult {
  /** A 2xx answer read whole within the cap. */
  ok: boolean;
  /** 0 when no answer arrived. */
  status: number;
  text?: string;
  content_type?: string;
  /** Sentry's pagination header. */
  link: string | null;
  /** A non-2xx answer's Retry-After, in ms (a 429 from a rate limit). */
  retry_after_ms?: number;
  bytes: number;
  ms: number;
  /** Set on every failure; a non-2xx answer gets `<vendor> answered <status>` for a wrapper to refine. */
  error?: string;
  /** Why the call failed before a status could mean anything. */
  failure?: "refused_host" | "unreachable" | "timeout" | "redirect" | "over" | "broken";
}

/** One authenticated call under the rules at the top of this file. */
export async function tokenHttp(fetchImpl: FetchLike, req: TokenHttpRequest): Promise<TokenHttpResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const timeoutMs = req.timeoutMs ?? TOKEN_HTTP_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? TOKEN_HTTP_MAX_BYTES;
  const fail = (failure: TokenHttpResult["failure"], error: string, status = 0, bytes = 0): TokenHttpResult => ({ ok: false, status, link: null, bytes, ms: ms(), error, failure });

  const refused = internalHostRefusal(req.url);
  if (refused) return fail("refused_host", `${req.vendor} is not called inside codecast's network (${refused})`);
  const origin = new URL(req.url).origin;
  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method ?? "GET",
      headers: {
        ...(req.token ? { Authorization: `Bearer ${req.token}` } : {}),
        Accept: "application/json",
        ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...req.headers,
      },
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return timedOut
      ? fail("timeout", `${req.vendor} gave no answer in ${timeoutMs / 1000}s`)
      : fail("unreachable", `Could not reach ${req.vendor} at ${origin}: ${e?.message ?? "network error"}`);
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => {});
    return fail("redirect", `${req.vendor} redirected (${res.status}); redirects are not followed, so connect with the final URL`, res.status);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(res, maxBytes);
  } catch (e: any) {
    return fail("broken", `${req.vendor}'s answer broke off: ${e?.message ?? "read error"}`, res.status);
  }
  if (!bytes) return fail("over", `${req.vendor}'s answer is over ${maxBytes} bytes`, res.status, maxBytes);
  return {
    ok: res.ok,
    status: res.status,
    text: new TextDecoder().decode(bytes),
    content_type: res.headers.get("content-type") ?? undefined,
    link: res.headers.get("link"),
    bytes: bytes.length,
    ms: ms(),
    ...(res.ok ? {} : { error: `${req.vendor} answered ${res.status}` }),
    ...(!res.ok && retryAfterMs(res.headers.get("retry-after")) !== null ? { retry_after_ms: retryAfterMs(res.headers.get("retry-after"))! } : {}),
  };
}

/** A Retry-After header (seconds, or an HTTP date) in ms from now, or null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  const raw = header?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** A result's text as JSON, or undefined when it is not. */
export function jsonOf(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
