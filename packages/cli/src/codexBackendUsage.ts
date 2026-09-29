// The ChatGPT backend's own usage endpoint — the second reading behind a Codex
// account's meters (ct-49528).
//
// `codex app-server`'s account/rateLimits/read stays the primary source: it is
// the only one that reports model-scoped limits and the credits balance, and it
// speaks for whichever CODEX_HOME it was pointed at. What it does NOT always
// report is the five-hour session window — a plan whose app-server answers with
// the weekly bucket alone leaves the session meter blank, and blank reads as
// headroom. GET /backend-api/wham/usage answers with both windows plus the
// plan type and the grantable reset credits, so it supplements the RPC: every
// field the RPC filled wins, and the backend only fills the holes.
//
// The request is the one Codex itself makes (Orca codex-backend-auth.ts:88-96),
// down to the originator header, because the endpoint is not a public API and
// an unrecognized client is the kind of thing that gets refused.

import * as fs from "fs";
import * as path from "path";
import { CloudApiError, requestCloudJson } from "./cloudAgents/http.js";
export { parseRetryAfter } from "./cloudAgents/http.js";
import {
  foldCodexLimits,
  isCodexWindowFilled,
  type CanonicalLimit,
  type CanonicalWindow,
  type CodexUsageSnapshot,
} from "./codexUsage.js";

/** The ChatGPT backend's Codex API (usage here, Codex Cloud's tasks in cloudAgents/codex.ts). */
export const CODEX_BACKEND_BASE = "https://chatgpt.com/backend-api/wham";
export const CODEX_BACKEND_USAGE_URL = `${CODEX_BACKEND_BASE}/usage`;

/** A refusal from the ChatGPT backend without a reason of its own (the reset
 *  credit endpoints): the one error every backend request throws, CloudApiError,
 *  with the wait a 429 named. */
export class CodexUsageHttpError extends CloudApiError {
  constructor(status: number, retryAfterMs?: number) {
    super(status, undefined, `codex usage endpoint ${status}`, { fromApi: false, retryAfterMs });
  }
}

// The poll used to treat every refusal alike: throw, and try again on the next
// tick. That reads a 429's Retry-After as noise and hammers a rate-limited
// endpoint. So a failure records when this account may be asked again: what the
// server named on a 429, else 30s doubling per consecutive failure, capped at
// 15 minutes. The RPC snapshot is unaffected — the backend is a supplement, and
// a supplement that is backing off simply adds nothing.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

export interface UsageRetryState {
  retry_at: number; // no automated backend probe of this account before then
  failures: number; // consecutive failures; drives the delay
  reason: string;
  failed_at: number;
  status?: number; // HTTP status, when the endpoint answered at all
  retry_after?: boolean; // the server named the wait; not our own guess
}

/** The backoff state after one failed probe. */
export function nextUsageRetry(
  prev: UsageRetryState | undefined,
  err: unknown,
  now: number,
): UsageRetryState {
  const failures = (prev?.failures ?? 0) + 1;
  const http = err instanceof CloudApiError ? err : undefined;
  const named = http?.retryAfterMs;
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  return {
    retry_at: now + (named ?? backoff),
    failures,
    reason: err instanceof Error ? err.message : String(err),
    failed_at: now,
    ...(http && { status: http.status }),
    ...(named !== undefined && { retry_after: true }),
  };
}

/** One request to the ChatGPT backend's Codex API (usage, Codex Cloud's tasks); a refusal throws a CloudApiError with its reason. */
export function codexBackendRequest<T>(
  headers: Record<string, string>,
  method: string,
  apiPath: string,
  opts: { body?: unknown; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<T> {
  return requestCloudJson<T>(opts.fetchImpl ?? fetch, {
    method,
    url: `${CODEX_BACKEND_BASE}${apiPath}`,
    headers,
    body: opts.body,
    label: `codex ${method} ${apiPath.split("?")[0]}`,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * The request headers Codex itself sends, read from one CODEX_HOME's auth.json.
 *
 * `codexHomeDir` is a real home or a profile's snapshot dir — the same seam the
 * app-server probe uses, so the active login is read from ~/.codex and a dormant
 * account from its snapshot, never the other way round. Null when that home has
 * no access token (logged out, or an API-key-only login).
 */
export function codexBackendAuthHeaders(codexHomeDir: string): Record<string, string> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(codexHomeDir, "auth.json"), "utf-8");
  } catch {
    return null;
  }
  return codexBackendHeadersFromAuth(raw);
}

/** The same headers from an auth.json blob already read (null without an access token). */
export function codexBackendHeadersFromAuth(raw: string): Record<string, string> | null {
  let tokens: any;
  try {
    tokens = JSON.parse(raw)?.tokens;
  } catch {
    return null;
  }
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (typeof tokens.account_id === "string" && tokens.account_id) {
    headers["ChatGPT-Account-Id"] = tokens.account_id;
  }
  return headers;
}

interface BackendWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

/** A backend window in the canonical shape. Duration arrives in seconds here
 * and in minutes everywhere else, so it is converted before classification. */
function toCanonicalBackendWindow(raw: BackendWindow | null | undefined): CanonicalWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const seconds = raw.limit_window_seconds;
  const minutes =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds / 60)
      : undefined;
  return { used_percent: raw.used_percent, window_minutes: minutes, resets_at: raw.reset_at };
}

/** Parse a /backend-api/wham/usage body into the limit-window half of a
 * snapshot. Null when the body carries no plan type — that is what a signed-out
 * or redirected response looks like, and half a reading is worse than none. */
export function parseBackendUsageResponse(
  body: any,
  now: number,
): Omit<CodexUsageSnapshot, "models"> | null {
  if (!body || typeof body !== "object" || typeof body.plan_type !== "string") return null;
  const limit: CanonicalLimit = {
    limit_id: "codex",
    plan_type: body.plan_type,
    primary: toCanonicalBackendWindow(body.rate_limit?.primary_window),
    secondary: toCanonicalBackendWindow(body.rate_limit?.secondary_window),
  };
  const snap = foldCodexLimits([limit], now);
  const available = body.rate_limit_reset_credits?.available_count;
  if (typeof available === "number" && available > 0) snap.reset_credits = { available };
  return snap;
}

/** GET /usage for a login's headers (the same request Codex Cloud's sign-in check makes). */
export function requestCodexBackendUsage(headers: Record<string, string>, fetchImpl?: typeof fetch): Promise<any> {
  return codexBackendRequest(headers, "GET", "/usage", { fetchImpl, timeoutMs: 15_000 });
}

/**
 * One GET against the ChatGPT backend for the account whose auth.json lives in
 * `codexHomeDir`. Null when that home has no usable token or the body is not a
 * usage reading; throws a CloudApiError when the endpoint refused, so the
 * caller can back off on what the response said.
 */
export async function fetchCodexBackendUsage(
  codexHomeDir: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<Omit<CodexUsageSnapshot, "models"> | null> {
  const headers = codexBackendAuthHeaders(codexHomeDir);
  if (!headers) return null;
  return parseBackendUsageResponse(await requestCodexBackendUsage(headers, opts.fetchImpl), opts.now ?? Date.now());
}

/**
 * Merge a backend reading under an app-server reading.
 *
 * The RPC is authoritative wherever it spoke: every field it filled survives
 * untouched, and the backend only fills holes. `fetched_at` stays the primary
 * reading's, because that is the reading the meters are mostly made of.
 */
export function mergeCodexUsage(
  primary: Omit<CodexUsageSnapshot, "models"> | null,
  backend: Omit<CodexUsageSnapshot, "models"> | null,
): Omit<CodexUsageSnapshot, "models"> | null {
  if (!primary) return backend;
  if (!backend) return primary;
  return {
    ...primary,
    ...(primary.plan_type ? {} : backend.plan_type ? { plan_type: backend.plan_type } : {}),
    // A 0% window with no reset time is the placeholder Codex writes when it
    // has no reading — treat it as a hole so a real weekly can fill it.
    ...(isCodexWindowFilled(primary.session)
      ? {}
      : isCodexWindowFilled(backend.session)
        ? { session: backend.session }
        : {}),
    ...(isCodexWindowFilled(primary.weekly)
      ? {}
      : isCodexWindowFilled(backend.weekly)
        ? { weekly: backend.weekly }
        : {}),
    ...(primary.reset_credits ? {} : backend.reset_credits ? { reset_credits: backend.reset_credits } : {}),
  };
}
