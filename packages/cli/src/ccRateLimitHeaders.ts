// The rate-limit windows a model response's headers carry. Every response
// names the account's unified 5h and 7d windows; a request for a model with
// its own weekly window also names that one.
import type { CcUsageWindow } from "./ccAccounts.js";

type Headers = { get(name: string): string | null };

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface RateLimitFingerprint {
  five_hour_reset: number | null;
  seven_day_reset: number | null;
  five_hour_utilization: number | null;
  seven_day_utilization: number | null;
}

export function parseRateLimitFingerprint(headers: Headers): RateLimitFingerprint {
  return {
    five_hour_reset: headerNumber(headers, "anthropic-ratelimit-unified-5h-reset"),
    seven_day_reset: headerNumber(headers, "anthropic-ratelimit-unified-7d-reset"),
    five_hour_utilization: headerNumber(headers, "anthropic-ratelimit-unified-5h-utilization"),
    seven_day_utilization: headerNumber(headers, "anthropic-ratelimit-unified-7d-utilization"),
  };
}

/**
 * The model-scoped weekly window a response's headers carry, or null when they
 * carry none. A request for a model with its own weekly window answers with
 * that window beside the unified ones (measured 2026-11-17 on Fable 5.2:
 * `…-7d_oi-utilization: 0.31`, `…-7d_oi-status: allowed`, `…-7d_oi-reset`).
 */
export function parseScopedRateLimitWindow(headers: Headers): CcUsageWindow | null {
  const util = headerNumber(headers, "anthropic-ratelimit-unified-7d_oi-utilization");
  const status = headers.get("anthropic-ratelimit-unified-7d_oi-status");
  if (util == null && !status) return null;
  const reset = headerNumber(headers, "anthropic-ratelimit-unified-7d_oi-reset");
  const percent = status === "rejected" ? 100 : Math.min(100, Math.round((util ?? 0) * 100));
  return { percent, ...(reset != null && { resets_at: reset * 1000 }) };
}
