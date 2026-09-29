import { describe, expect, it } from "bun:test";
import { CloudApiError, parseRetryAfter } from "./cloudAgents/http.js";
import { nextUsageRetry } from "./usageRetry.js";

const NOW = 1_781_000_000_000;

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("  90 ", NOW)).toBe(90_000);
  });

  it("reads an HTTP date as the wait from now", () => {
    expect(parseRetryAfter(new Date(NOW + 300_000).toUTCString(), NOW)).toBe(300_000);
  });

  it("ignores a header that names no future wait", () => {
    for (const h of [null, undefined, "", "   ", "soon", "0", "-5", new Date(NOW - 60_000).toUTCString()]) {
      expect(parseRetryAfter(h, NOW)).toBeUndefined();
    }
  });

  it("caps at 24h so a corrupt header can't freeze the meters", () => {
    expect(parseRetryAfter("999999999", NOW)).toBe(24 * 60 * 60 * 1000);
    expect(parseRetryAfter(new Date(NOW + 400 * 86_400_000).toUTCString(), NOW)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("nextUsageRetry", () => {
  it("doubles the wait per consecutive failure, capped at 15 minutes", () => {
    let state = nextUsageRetry(undefined, new Error("boom"), NOW);
    expect(state.retry_at - NOW).toBe(30_000);
    expect(state.failures).toBe(1);
    state = nextUsageRetry(state, new Error("boom"), NOW);
    expect(state.retry_at - NOW).toBe(60_000);
    for (let i = 0; i < 10; i++) state = nextUsageRetry(state, new Error("boom"), NOW);
    expect(state.retry_at - NOW).toBe(15 * 60 * 1000);
  });

  it("prefers the wait the server named over its own backoff", () => {
    const state = nextUsageRetry(
      { retry_at: 0, failures: 4, reason: "x", failed_at: 0 },
      new CloudApiError(429, undefined, "usage endpoint 429", { fromApi: false, retryAfterMs: 5_000 }),
      NOW,
    );
    expect(state.retry_at).toBe(NOW + 5_000);
    expect(state.retry_after).toBe(true);
    expect(state.status).toBe(429);
    expect(state.reason).toBe("usage endpoint 429");
  });

  it("records the status of a refusal that named no wait", () => {
    const state = nextUsageRetry(undefined, new CloudApiError(503, undefined, "usage endpoint 503"), NOW);
    expect(state.retry_at).toBe(NOW + 30_000);
    expect(state.status).toBe(503);
    expect(state.retry_after).toBeUndefined();
  });
});
