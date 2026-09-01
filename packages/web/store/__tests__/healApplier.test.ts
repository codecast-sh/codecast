import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { HIDDEN_OVERRIDE_SETTLE_MS, useInboxStore, type InboxSession } from "../inboxStore";

// THE HEAL APPLIER (sync-convergence C7): rows the digest compare hydrates by
// id land through ONE store path — settled field locks are released first so
// the authoritative row can win, planted excludes are lifted, then the
// ordinary delta merge. The lock release is the fix the two-replica
// simulation forced (2026-09-01): a pin this device dispatched, cleared
// server-side by another device's kill before any row echoed the pinned
// value, left an immortal lock that re-asserted the pin over every later
// row — a killed-but-pinned card forever. Past the compare's carve-out bound
// the lock no longer counts as an intentional deviation, so the heal lets go.

const NOW = 1_800_000_000_000;
const ME = "u".repeat(32);
const A = "a".repeat(32);
const B = "b".repeat(32);

function row(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "active",
    updated_at: NOW - 60_000, message_count: 3, is_idle: true, has_pending: false, ...extra,
  } as InboxSession;
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  useInboxStore.setState({
    sessions: {
      [A]: row(A, { is_pinned: true, inbox_pinned_at: NOW - 10 * 60_000 }),
      [B]: row(B, { is_pinned: true, inbox_pinned_at: NOW - 1_000 }),
    },
    conversations: { [A]: { _id: A, inbox_pinned_at: NOW - 10 * 60_000 }, [B]: { _id: B, inbox_pinned_at: NOW - 1_000 } },
    pending: {
      // A's pin lock is ten minutes old and never echoed; B's is one second old.
      [`sessions:${A}:inbox_pinned_at`]: { type: "field", value: NOW - 10 * 60_000, ts: NOW - 10 * 60_000 },
      [`sessions:${A}:is_pinned`]: { type: "field", value: true, ts: NOW - 10 * 60_000 },
      [`conversations:${A}:inbox_pinned_at`]: { type: "field", value: NOW - 10 * 60_000, ts: NOW - 10 * 60_000 },
      [`sessions:${B}:inbox_pinned_at`]: { type: "field", value: NOW - 1_000, ts: NOW - 1_000 },
      [`sessions:${B}:is_pinned`]: { type: "field", value: true, ts: NOW - 1_000 },
      // An exclude is not a field lock and is never aged here.
      [`sessions:${"c".repeat(32)}`]: { type: "exclude", ts: NOW - 20 * 60_000 },
    },
    currentUser: { _id: ME },
    currentSessionId: null,
  } as any);
});
afterEach(() => nowSpy.mockRestore());

describe("releaseSettledFieldLocks", () => {
  it("drops only field locks past the settle window on the named rows", () => {
    useInboxStore.getState().releaseSettledFieldLocks([A, B]);
    const pending = useInboxStore.getState().pending;
    expect(Object.keys(pending).sort()).toEqual([
      `sessions:${B}:inbox_pinned_at`,
      `sessions:${B}:is_pinned`,
      `sessions:${"c".repeat(32)}`,
    ].sort());
    expect(HIDDEN_OVERRIDE_SETTLE_MS).toBe(5 * 60 * 1000);
  });

  it("leaves rows it was not asked about alone", () => {
    useInboxStore.getState().releaseSettledFieldLocks([B]);
    expect(useInboxStore.getState().pending[`sessions:${A}:inbox_pinned_at`]).toBeDefined();
  });
});

describe("applyHealedSessions", () => {
  it("the authoritative row wins on a settled lock; a fresh lock still protects its row", () => {
    // The server says: A was killed and un-pinned elsewhere; B is un-pinned too
    // (its dispatch is still in flight — the local pin must survive).
    useInboxStore.getState().applyHealedSessions([A, B], [
      row(A, { is_pinned: false, inbox_pinned_at: null, inbox_dismissed_at: NOW - 5 * 60_000, inbox_killed_at: NOW - 5 * 60_000 }),
      row(B, { is_pinned: false, inbox_pinned_at: null }),
    ]);
    const s = useInboxStore.getState();
    expect(s.sessions[A].inbox_pinned_at).toBeNull();
    expect(s.sessions[A].is_pinned).toBe(false);
    expect(s.sessions[A].inbox_killed_at).toBe(NOW - 5 * 60_000);
    expect(s.sessions[B].inbox_pinned_at).toBe(NOW - 1_000);
    expect(s.sessions[B].is_pinned).toBe(true);
  });

  it("lifts a planted exclude for a returned row so the delta merge cannot drop it", () => {
    const C = "c".repeat(32);
    useInboxStore.getState().applyHealedSessions([C], [row(C)]);
    const s = useInboxStore.getState();
    expect(s.pending[`sessions:${C}`]).toBeUndefined();
    expect(s.sessions[C]).toBeDefined();
  });

  it("an empty answer changes no rows (deletion truth is authorized absence) but still releases settled locks", () => {
    useInboxStore.getState().applyHealedSessions([A], []);
    const s = useInboxStore.getState();
    expect(s.sessions[A].inbox_pinned_at).toBe(NOW - 10 * 60_000);
    expect(s.pending[`sessions:${A}:inbox_pinned_at`]).toBeUndefined();
  });
});
