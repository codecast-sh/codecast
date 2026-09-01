import { beforeEach, describe, expect, it } from "bun:test";
import {
  isSessionDismissed,
  isSessionHardBlocked,
  isSessionHidden,
  isSessionKilled,
  isSessionEffectivelyIdle,
  classifySession,
  useInboxStore,
  type InboxSession,
} from "../inboxStore";

// inbox_killed_at is the authoritative "this session is retired" marker, and the
// server's classifyWorkState (convex/inboxFilters.ts) gives it precedence over
// every other signal. These cover the web's copies of that derivation, which
// used to read inbox_dismissed_at (a DIFFERENT field — the command kill surfaces
// never write it) or nothing at all, so the same session read "killed" to
// `cast sessions` and "working" to the web. See ct-41083.

const REAL_A = "a".repeat(32);

function session(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id,
    session_id: `sess-${id}`,
    updated_at: 1,
    agent_type: "claude_code",
    message_count: 3,
    is_idle: true,
    has_pending: false,
    ...extra,
  } as InboxSession;
}

// How a kill arrives from the killSession MUTATION — the web's
// convCommand("killSession"): the /sessions kill button and the panel's
// kill-and-complete. It stamps inbox_killed_at alone; nothing stamps
// inbox_dismissed_at, which is why reading that field to answer "is this
// killed?" silently missed every one of them. (`cast kill` and the web's own
// kill action write BOTH stamps, so those rows were never the gap.)
function killed(extra: Partial<InboxSession> = {}): InboxSession {
  return session(REAL_A, { inbox_killed_at: 1_000, ...extra });
}

describe("isSessionKilled", () => {
  it("reports a command-killed row killed — inbox_dismissed_at says nothing about it", () => {
    const s = killed();
    expect(isSessionKilled(s)).toBe(true);
    // The predicate /sessions used to call for its `killed` column:
    expect(isSessionDismissed(s)).toBe(false);
    expect(isSessionHidden(s)).toBe(false);
  });

  it("does not call an ordinary stashed or dismissed row killed", () => {
    expect(isSessionKilled(session(REAL_A, { inbox_stashed_at: 5 }))).toBe(false);
    expect(isSessionKilled(session(REAL_A, { inbox_dismissed_at: 5 }))).toBe(false);
  });
});

// The web reads the SHARED classifier through classifySession; `waiting` is
// its settled verdict (needs_input / done / dormant), so a killed row — filed
// `idle` by the killed precedence — never waits.
const waits = (s: InboxSession) => classifySession(s).waiting;

describe("killed precedence in the shared classifiers", () => {
  it("a killed row is effectively idle even while its agent_status still says working", () => {
    expect(isSessionEffectivelyIdle(killed({ agent_status: "working", is_idle: false }))).toBe(true);
    // Control: the same row alive is not idle.
    expect(isSessionEffectivelyIdle(session(REAL_A, { agent_status: "working", is_idle: false }))).toBe(false);
  });

  it("a killed row is effectively idle even while a server-queued message is pending", () => {
    expect(isSessionEffectivelyIdle(killed({ has_pending: true, is_idle: false }))).toBe(true);
  });

  it("a killed row never waits for input — not on an open poll", () => {
    expect(waits(killed({ awaiting_input: true }))).toBe(false);
    expect(waits(session(REAL_A, { awaiting_input: true }))).toBe(true);
  });

  it("a killed row never waits for input — not on a permission block", () => {
    expect(waits(killed({ agent_status: "permission_blocked" }))).toBe(false);
    expect(waits(session(REAL_A, { agent_status: "permission_blocked" }))).toBe(true);
  });

  it("a killed row never waits for input — not on an unresolved auth banner", () => {
    expect(waits(killed({ pending_api_error: true }))).toBe(false);
    expect(waits(session(REAL_A, { pending_api_error: true }))).toBe(true);
  });

  it("a killed row never waits for input — not as a dead agent with output", () => {
    expect(waits(killed({ agent_status: "stopped" }))).toBe(false);
    expect(waits(session(REAL_A, { agent_status: "stopped" }))).toBe(true);
  });

  it("a killed row never waits for input — not as a plain finished turn", () => {
    expect(waits(killed({ is_idle: true }))).toBe(false);
    expect(waits(session(REAL_A, { is_idle: true }))).toBe(true);
  });
});

// Pin is an ORDERING gesture, not a revival. The sanctioned revivals are an
// explicit send, Restart, and undismiss; the server's dispatch rail now drops a
// kill-clear that isn't itself an un-kill, so an optimistic clear here only
// rendered a retired row alive until the round-trip put the marker back.
describe("pin does not un-kill", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: { [REAL_A]: session(REAL_A, { inbox_killed_at: 1_000 }) },
      conversations: { [REAL_A]: { _id: REAL_A, inbox_killed_at: 1_000 } },
      pending: {},
      currentUser: null,
    } as any);
  });

  it("pinSession leaves inbox_killed_at intact on the conversation twin", () => {
    useInboxStore.getState().pinSession(REAL_A);
    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].is_pinned).toBe(true);
    expect((s.conversations[REAL_A] as any).inbox_killed_at).toBe(1_000);
  });

  it("the cross-window pin bridge likewise leaves inbox_killed_at intact", () => {
    useInboxStore.getState().applyGestureBridge({
      kind: "pin", id: REAL_A, pinned: true, pinnedAt: 500, ts: 500,
    } as any);
    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].is_pinned).toBe(true);
    expect((s.conversations[REAL_A] as any).inbox_killed_at).toBe(1_000);
  });
});

// Restore IS a sanctioned revival, and the only one that reaches a row killed
// through a command (marker set, inbox_dismissed_at unset). The server's un-kill
// mirror can't help there — it gates on `wasDismissed` — so the client has to
// clear all three stamps itself or shouldShowInInbox goes on hiding the row.
describe("restore un-kills", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {
        [REAL_A]: session(REAL_A, { inbox_killed_at: 1_000, inbox_dismissed_at: null }),
      },
      conversations: {
        [REAL_A]: { _id: REAL_A, inbox_killed_at: 1_000, inbox_dismissed_at: null },
      },
      messages: {},
      pendingMessages: {},
      pagination: {},
      pendingSessionCreates: {},
      pending: {},
      currentSessionId: null,
      viewingDismissedId: null,
      currentUser: null,
      clientState: {},
    } as any);
  });

  it("restoreSession clears inbox_killed_at on both twins", () => {
    useInboxStore.getState().restoreSession(REAL_A);
    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_killed_at).toBeNull();
    expect((s.conversations[REAL_A] as any).inbox_killed_at).toBeNull();
    expect(isSessionKilled(s.sessions[REAL_A])).toBe(false);
  });

  it("the cross-window restore receiver clears it too", () => {
    useInboxStore.getState().applyGestureBridge({
      kind: "restore", ids: [REAL_A], ts: 9_000,
    } as any);
    const s = useInboxStore.getState();
    expect(s.sessions[REAL_A].inbox_killed_at).toBeNull();
    expect((s.conversations[REAL_A] as any).inbox_killed_at).toBeNull();
  });
});

// isSessionHardBlocked is what pulls an ANCHOR out of its own space and into the
// inbox (categorizeSessions' hiddenAnchor gate). A killed anchor keeps its
// frozen awaiting_input / permission_blocked, so without a killed branch it
// re-escalated forever after teardown.
describe("isSessionHardBlocked killed precedence", () => {
  it("a killed session is not hard-blocked by a frozen open poll", () => {
    expect(isSessionHardBlocked(killed({ awaiting_input: true }))).toBe(false);
    expect(isSessionHardBlocked(session(REAL_A, { awaiting_input: true }))).toBe(true);
  });

  it("a killed session is not hard-blocked by a frozen permission prompt", () => {
    expect(isSessionHardBlocked(killed({ agent_status: "permission_blocked" }))).toBe(false);
    expect(isSessionHardBlocked(session(REAL_A, { agent_status: "permission_blocked" }))).toBe(true);
  });

  it("a killed session is not hard-blocked by an auth banner or a dead agent", () => {
    expect(isSessionHardBlocked(killed({ pending_api_error: true }))).toBe(false);
    expect(isSessionHardBlocked(killed({ agent_status: "stopped" }))).toBe(false);
    expect(isSessionHardBlocked(session(REAL_A, { pending_api_error: true }))).toBe(true);
    expect(isSessionHardBlocked(session(REAL_A, { agent_status: "stopped" }))).toBe(true);
  });

  it("a killed ANCHOR stops escalating into the active inbox", () => {
    // categorizeSessions: hiddenAnchor = is_anchor && !isSessionHardBlocked(s).
    // True here means the anchor stays in its own space, which is the fix.
    const anchor = killed({ is_anchor: true, awaiting_input: true } as Partial<InboxSession>);
    expect(!!(anchor as any).is_anchor && !isSessionHardBlocked(anchor)).toBe(true);
  });
});
