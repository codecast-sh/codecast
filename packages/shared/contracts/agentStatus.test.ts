import { describe, expect, it } from "bun:test";
import { deriveLiveAt } from "./inboxProjection";
import { AGENT_IDLE_GRACE_MS, HEARTBEAT_ALIVE_MS, HEARTBEAT_FLUSH_INTERVAL_MS, HEARTBEAT_REFRESH_MS, HEARTBEAT_WRITE_CADENCE_MS, isLivenessStale, isQuietSettled, isStatusTrustStale, STATUS_TRUST_TTL_MS } from "./agentStatus";

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

  // A retired row's live-looking fields are never believable, and neither
  // time-based arm catches the common case: killing a session mid-turn leaves an
  // ACTIVE agent_status (isQuietSettled bails at once) and kill never touches
  // updated_at (isStatusTrustStale needs the full hour). ct-41083.
  it("is stale immediately for a KILLED session that was working when it died", () => {
    const justKilled = {
      agent_status: "working", is_idle: false, message_count: 5,
      updated_at: NOW - 10_000, inbox_killed_at: NOW - 10_000,
    };
    expect(isLivenessStale(justKilled, NOW)).toBe(true);
    // The same row alive is trusted — the kill marker is doing the work here,
    // not the clock.
    expect(isLivenessStale({ ...justKilled, inbox_killed_at: undefined }, NOW)).toBe(false);
  });

  it("needs no clock: a killed row is stale even with a brand-new updated_at", () => {
    expect(isLivenessStale(
      { agent_status: "thinking", is_idle: false, message_count: 5, updated_at: NOW, inbox_killed_at: NOW },
      NOW,
    )).toBe(true);
  });

  it("leaves the two time-based arms alone for unkilled rows", () => {
    // Regression guard: the killed branch must not swallow the existing logic.
    expect(isLivenessStale({ message_count: 5, updated_at: NOW - 10 * 60 * 1000, inbox_killed_at: null }, NOW)).toBe(true);
    expect(isLivenessStale({ agent_status: "working", is_idle: false, message_count: 5, updated_at: NOW - 10 * 60 * 1000, inbox_killed_at: null }, NOW)).toBe(false);
  });
});

// The heartbeat window measures the heartbeat WRITES, and those land on the
// first flush past the server's throttle — never on the flush cadence alone.
// When the window did not clear that interval, a session running a long silent
// tool call read as a dead daemon and filed under Needs Input while its daemon
// was beating (2026-09-17: writes measured 60s apart in steady state and 85s
// behind a late flush, against a 90s window).
describe("heartbeat liveness window", () => {
  it("is derived from the cadence it measures", () => {
    expect(HEARTBEAT_WRITE_CADENCE_MS).toBe(HEARTBEAT_REFRESH_MS + HEARTBEAT_FLUSH_INTERVAL_MS);
  });

  it("clears the write cadence by a whole extra flush", () => {
    expect(HEARTBEAT_ALIVE_MS - HEARTBEAT_WRITE_CADENCE_MS).toBeGreaterThan(HEARTBEAT_FLUSH_INTERVAL_MS);
  });

  // The window is applied to last_heartbeat by deriveLiveAt, which is the path
  // both the server stamp and every replica render take.
  const quietWorkingSession = (heartbeatAge: number) =>
    deriveLiveAt(
      {
        status: "active",
        updated_at: NOW - 5 * 60_000, // a long silent tool call: no output for minutes
        message_count: 2668,
        has_pending_messages: false,
        agent_status: "working",
        agent_status_updated_at: NOW - 5 * 60_000,
        last_heartbeat: NOW - heartbeatAge,
        daemon_alive_until: NOW - heartbeatAge + HEARTBEAT_ALIVE_MS,
        last_role_is_user: false,
      } as any,
      NOW,
    );

  it("keeps a quiet working session alive across a late flush", () => {
    // The measured worst case on a busy account: the heartbeat write ran 85s
    // late while the daemon was beating the whole time. The replica reads that
    // write some seconds later still — it re-derives at its own clock over a
    // fact it received — so the age it sees clears 90s and the old window
    // called this live session dead.
    expect(quietWorkingSession(85_000).agent_status).toBe("working");
    expect(quietWorkingSession(95_000).agent_status).toBe("working");
  });

  it("still calls a genuinely gone daemon stopped", () => {
    expect(quietWorkingSession(10 * 60_000).agent_status).toBe("stopped");
  });
});
