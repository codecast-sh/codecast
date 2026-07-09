// Resilient HTTP for the CLI's calls to the codecast backend.
//
// History: every `cast` subcommand POSTed to the backend with a bare `fetch` —
// no timeout, no retry. When the self-hosted Convex backend is slow or contended
// (e.g. while the sync daemon is draining a large retry queue), commands would
// hang indefinitely with no feedback. The daemon already bounds its own calls
// with AbortSignal.timeout; this brings the same discipline to the CLI.

export interface CliFetchOptions {
  /**
   * Abort a single attempt after this many ms. Default 45s — deliberately
   * generous so a legitimately slow-but-working query is never aborted (the
   * slowest healthy reads observed were ~20s). Override per-call or via the
   * CAST_HTTP_TIMEOUT_MS env var.
   */
  timeoutMs?: number;
  /**
   * Extra attempts after the first, on a transient failure (timeout or 5xx).
   * Default 0: safe for non-idempotent POSTs (a create that timed out may have
   * committed server-side). Set 1+ only for idempotent reads.
   */
  retries?: number;
  /** Notified before each retry. Used for debug output and in tests. */
  onRetry?: (info: { url: string; attempt: number; reason: string }) => void;
}

export const DEFAULT_CLI_TIMEOUT_MS = 45_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt: number) => 400 * (attempt + 1);

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Drop-in replacement for `fetch` that bounds each attempt with a timeout and
 * optionally retries transient failures. Returns the final `Response`; the
 * caller keeps its existing `.json()` / `.ok` handling unchanged.
 */
export async function cliFetch(
  url: string,
  init: RequestInit,
  opts: CliFetchOptions = {},
): Promise<Response> {
  const envTimeout = Number(process.env.CAST_HTTP_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CLI_TIMEOUT_MS);
  const retries = opts.retries ?? 0;
  const notifyRetry = (attempt: number, reason: string) => {
    opts.onRetry?.({ url, attempt, reason });
    if (process.env.CAST_DEBUG) console.error(`[cast] ${url} ${reason}; retrying (${attempt + 1}/${retries})`);
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // Retry server-side faults (overloaded/contended backend), not 4xx.
      if (response.status >= 500 && attempt < retries) {
        await response.body?.cancel().catch(() => {});
        notifyRetry(attempt, `HTTP ${response.status}`);
        await delay(backoffMs(attempt));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        notifyRetry(attempt, isTimeoutError(err) ? "timed out" : "network error");
        await delay(backoffMs(attempt));
        continue;
      }
      // Surface a legible message instead of a raw AbortError stack trace.
      if (isTimeoutError(err)) {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms (backend may be overloaded)`);
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * `cliFetch` for idempotent reads (search/feed/read/etc): same timeout plus one
 * automatic retry, so a single transient timeout or 5xx from a contended backend
 * doesn't surface as a command failure. Safe because reads have no side effects.
 */
export async function cliFetchRead(
  url: string,
  init: RequestInit,
  opts: CliFetchOptions = {},
): Promise<Response> {
  return cliFetch(url, init, { retries: 1, ...opts });
}

/**
 * POST /cli/search with graceful degradation: common tokens make the messages
 * full-text index blow its read budget server-side (the whole query dies — see
 * convex/conversations.ts fetchMessageSearchPool), which surfaces here as the
 * http route's catch-all {error: "Internal error"} or a transport failure. On
 * that class of failure, retry once in titles_only mode (conversation-table
 * indexes only, reliably cheap) so callers get title/summary hits instead of a
 * hard error. The fallback result carries titles_only from the server plus
 * content_search_error for display; auth/validation errors pass through.
 */
export async function cliSearchRequest(
  siteUrl: string,
  body: Record<string, unknown>,
): Promise<any> {
  const post = async (payload: Record<string, unknown>) => {
    const resp = await cliFetchRead(`${siteUrl}/cli/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return resp.json();
  };
  let result: any;
  let transportError: unknown;
  try {
    result = await post(body);
  } catch (err) {
    transportError = err;
  }
  const contentSearchDied = transportError !== undefined || result?.error === "Internal error";
  if (contentSearchDied && !body.titles_only) {
    const detail = transportError instanceof Error
      ? transportError.message
      : result?.details || result?.error;
    try {
      const fallback = await post({ ...body, titles_only: true });
      if (!fallback?.error) {
        return { ...fallback, content_search_error: detail };
      }
    } catch { /* fall through to the original failure */ }
  }
  if (transportError !== undefined) throw transportError;
  return result;
}
