import { describe, expect, it } from "bun:test";
import { AGENT_IDLE_GRACE_MS, isLivenessStale, isQuietSettled, isStatusTrustStale, STATUS_TRUST_TTL_MS } from "./agentStatus";

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

// isQuietSettled closes the short-fuse half of the frozen-liveness class: rows
// the sessionsLiveness overlay never covers (killed, subagent, unmanaged
// imports) carry no active agent_status, so their "working" appearance is only
// the bucket fallthrough over a null/frozen is_idle. With no claim of work to
// trust, they settle after the 45s idle grace instead of the 1h TTL.
describe("isQuietSettled", () => {
  const quiet = NOW - (AGENT_IDLE_GRACE_MS + 5_000);

  it("settles a statusless quiet row with content", () => {
    expect(isQuietSettled({ message_count: 15, updated_at: quiet }, NOW)).toBe(true);
    expect(isQuietSettled({ agent_status: null, is_idle: null, message_count: 15, updated_at: quiet }, NOW)).toBe(true);
  });

  it("settles a quiet row frozen at is_idle=false with a non-active status", () => {
    expect(isQuietSettled({ agent_status: "idle", is_idle: false, message_count: 8, updated_at: quiet }, NOW)).toBe(true);
  });

  it("never settles a row with an ACTIVE agent_status (that's the 1h TTL's job)", () => {
    expect(isQuietSettled({ agent_status: "working", is_idle: false, message_count: 4, updated_at: quiet }, NOW)).toBe(false);
    expect(isQuietSettled({ agent_status: "thinking", message_count: 4, updated_at: NOW - 10 * STATUS_TRUST_TTL_MS }, NOW)).toBe(false);
  });

  it("is exactly at the grace boundary inclusive (>= grace)", () => {
    expect(isQuietSettled({ message_count: 1, updated_at: NOW - AGENT_IDLE_GRACE_MS }, NOW)).toBe(true);
    expect(isQuietSettled({ message_count: 1, updated_at: NOW - (AGENT_IDLE_GRACE_MS - 1) }, NOW)).toBe(false);
  });

  it("leaves is_idle=true rows alone (already settled the normal way)", () => {
    expect(isQuietSettled({ is_idle: true, message_count: 5, updated_at: quiet }, NOW)).toBe(false);
  });

  it("leaves server-queued work (has_pending) alone", () => {
    expect(isQuietSettled({ has_pending: true, message_count: 5, updated_at: quiet }, NOW)).toBe(false);
  });

  it("is false for a blank (0-message) row", () => {
    expect(isQuietSettled({ message_count: 0, updated_at: quiet }, NOW)).toBe(false);
  });
});

describe("isLivenessStale", () => {
  it("is the union of the two speeds: quiet-statusless OR aged active status", () => {
    // statusless, quiet past grace but well inside the TTL → stale via the short fuse
    expect(isLivenessStale({ message_count: 5, updated_at: NOW - 10 * 60 * 1000 }, NOW)).toBe(true);
    // active status, quiet past the TTL → stale via the long fuse
    expect(isLivenessStale({ agent_status: "working", is_idle: false, message_count: 5, updated_at: NOW - (STATUS_TRUST_TTL_MS + 1) }, NOW)).toBe(true);
    // active status, quiet 10 min → still trusted
    expect(isLivenessStale({ agent_status: "working", is_idle: false, message_count: 5, updated_at: NOW - 10 * 60 * 1000 }, NOW)).toBe(false);
    // statusless but fresh → trusted
    expect(isLivenessStale({ message_count: 5, updated_at: NOW - 10_000 }, NOW)).toBe(false);
  });
});
