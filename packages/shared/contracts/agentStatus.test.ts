import { describe, expect, it } from "bun:test";
import { isStatusTrustStale, STATUS_TRUST_TTL_MS } from "./agentStatus";

// isStatusTrustStale is the single staleness predicate shared by the inbox
// bucket (categorizeSessions) and every UI "working" dot (GlobalSessionPanel
// card + minimap, LivenessDot). The bug it closes: a session that aged out of
// the liveness overlay keeps its last is_idle:false forever, so a finished agent
// kept pulsing green in needs-input. Past the trust TTL — keyed on updated_at —
// any active status it carries must read as finished.

const NOW = 1_000_000_000_000;

describe("isStatusTrustStale", () => {
  it("is false for a freshly-updated row (status still trustworthy)", () => {
    expect(isStatusTrustStale({ message_count: 5, updated_at: NOW - 30_000 }, NOW)).toBe(false);
  });

  it("is true once a row with content ages past the trust TTL", () => {
    expect(isStatusTrustStale({ message_count: 5, updated_at: NOW - (STATUS_TRUST_TTL_MS + 60_000) }, NOW)).toBe(true);
  });

  it("is exactly at the boundary inclusive (>= TTL)", () => {
    expect(isStatusTrustStale({ message_count: 1, updated_at: NOW - STATUS_TRUST_TTL_MS }, NOW)).toBe(true);
    expect(isStatusTrustStale({ message_count: 1, updated_at: NOW - (STATUS_TRUST_TTL_MS - 1) }, NOW)).toBe(false);
  });

  it("is false for a blank (0-message) row — no work to distrust", () => {
    expect(isStatusTrustStale({ message_count: 0, updated_at: NOW - 10 * STATUS_TRUST_TTL_MS }, NOW)).toBe(false);
  });

  it("treats a missing updated_at as ancient (stale)", () => {
    expect(isStatusTrustStale({ message_count: 3 }, NOW)).toBe(true);
  });

  it("treats a missing message_count as no work (not stale)", () => {
    expect(isStatusTrustStale({ updated_at: NOW - 10 * STATUS_TRUST_TTL_MS }, NOW)).toBe(false);
  });
});
