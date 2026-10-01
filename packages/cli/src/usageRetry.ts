// The backoff every provider usage poll keeps per account (Claude's OAuth
// usage endpoint, the ChatGPT backend's /wham/usage).
//
// The polls used to treat every refusal alike: throw, and try again on the
// next tick. That reads a 429's Retry-After as noise and hammers a
// rate-limited endpoint, and it makes a hard outage cost one request per
// account per tick for as long as it lasts. So a failure records when this
// account may be asked again: what the server named on a 429 (a CloudApiError
// carries it), else 30s doubling per consecutive failure, capped at 15
// minutes. The stale snapshot always survives: a meter that flapped to empty
// on a transient 500 would read as headroom.

import { CloudApiError } from "./cloudAgents/http.js";
import { doublingDelay } from "./cloudAgents/poll.js";

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

export interface UsageRetryState {
  retry_at: number; // no automated probe of this account before then
  failures: number; // consecutive failures; drives the delay
  reason: string; // the last failure, as `cast usage` prints it
  failed_at: number;
  status?: number; // HTTP status, when the endpoint answered at all
  retry_after?: boolean; // the server named the wait; not our own guess
}

/** The backoff state after one failed probe. */
export function nextUsageRetry(prev: UsageRetryState | undefined, err: unknown, now: number): UsageRetryState {
  const failures = (prev?.failures ?? 0) + 1;
  const http = err instanceof CloudApiError ? err : undefined;
  const named = http?.retryAfterMs;
  const backoff = doublingDelay(BACKOFF_BASE_MS, BACKOFF_MAX_MS, failures - 1);
  return {
    retry_at: now + (named ?? backoff),
    failures,
    reason: err instanceof Error ? err.message : String(err),
    failed_at: now,
    ...(http && { status: http.status }),
    ...(named !== undefined && { retry_after: true }),
  };
}
