// Fixed-window counting: a window opens at the first hit and allows `max`
// hits until `windowMs` has passed, then the next hit opens a fresh one.
import type { RateRule } from "./limits";

export type RateWindow = { window_start: number; count: number };

export type RateDecision = { allowed: boolean; next: RateWindow; retryAfterMs: number };

export function takeFromWindow(current: RateWindow | null, rule: RateRule, now: number): RateDecision {
  if (!current || now - current.window_start >= rule.windowMs) {
    return { allowed: true, next: { window_start: now, count: 1 }, retryAfterMs: 0 };
  }
  if (current.count >= rule.max) {
    return { allowed: false, next: current, retryAfterMs: current.window_start + rule.windowMs - now };
  }
  return { allowed: true, next: { ...current, count: current.count + 1 }, retryAfterMs: 0 };
}
