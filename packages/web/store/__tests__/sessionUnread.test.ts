import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  sessionReadMap,
  sessionUnreadMap,
  sessionUnreadWakeSig,
  useInboxStore,
  type InboxSession,
} from "../inboxStore";
import { CLIENT_SYNC_REGISTRY, REPLICATION_CLASSIFICATION } from "../clientSyncRegistry";

// Session unread, end to end on the client: the optimistic ack, the manual
// flag, what the server echo is allowed to do to either, and the derivation
// the inbox card renders from.
//
// The model is deliberately two numbers — acknowledged_at against the session's
// own updated_at — so most of what these tests pin is what must NOT happen: a
// re-reported state must not re-light a card, an echo must not undo an ack,
// and a mark-unread must not be swallowed by the next render.

type DispatchCall = { action: string; args: any[] };

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const CONV = serverId("conva");
const OTHER = serverId("convb");

function session(id: string, updatedAt: number): InboxSession {
  return {
    _id: id,
    session_id: `s-${id}`,
    updated_at: updatedAt,
    agent_type: "claude_code",
    message_count: 3,
    is_idle: true,
    has_pending: false,
    last_role_is_user: false,
  } as InboxSession;
}

function markFor(convId: string) {
  return sessionReadMap(useInboxStore.getState().sessionReads)[convId];
}

function unread(convId: string): boolean {
  return !!sessionUnreadMap(useInboxStore.getState())[convId];
}

describe("session unread", () => {
  const owner = {};
  let calls: DispatchCall[];
  const realNow = Date.now;
  let clock = 10_000;

  beforeEach(() => {
    calls = [];
    clock = 10_000;
    (Date as unknown as { now: () => number }).now = () => clock;
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      sessionReads: {},
      _lastViewedAt: {},
      pending: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return null;
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
    (Date as unknown as { now: () => number }).now = realNow;
  });

  // ── The ack ───────────────────────────────────────────────────────────────

  it("acknowledging writes a stub mark at the session's own watermark and dispatches once", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    expect(unread(CONV)).toBe(true);

    useInboxStore.getState().ackSessionRead(CONV, 5_000);

    // The stamp is the session's updated_at, not the wall clock: acknowledging
    // exactly the number the card compares against is what puts the dot out
    // without waiting for a round trip.
    expect(markFor(CONV)?.acknowledged_at).toBe(5_000);
    expect(unread(CONV)).toBe(false);
    expect(calls.filter((c) => c.action === "writeSessionAck")).toHaveLength(1);
    expect(calls[0].args).toEqual([CONV, 5_000]);
  });

  it("a re-reported state costs nothing: no second dispatch while updated_at holds", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    calls.length = 0;

    // A heartbeat, a status re-emit, a refocus: the presence hook fires the ack
    // again, but the mark cannot move, so nothing goes through the outbox.
    for (let i = 0; i < 5; i++) useInboxStore.getState().ackSessionRead(CONV, 5_000);
    expect(calls).toHaveLength(0);
    expect(unread(CONV)).toBe(false);
  });

  it("a new turn re-lights the card, and the next ack clears it again", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    expect(unread(CONV)).toBe(false);

    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 6_000) } } as any);
    expect(unread(CONV)).toBe(true);

    useInboxStore.getState().ackSessionRead(CONV, 6_000);
    expect(unread(CONV)).toBe(false);
    expect(markFor(CONV)?.acknowledged_at).toBe(6_000);
  });

  it("the mark only moves forward, and never past the clock", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    // A late ack from a stale render carrying an older watermark.
    useInboxStore.getState().ackSessionRead(CONV, 4_000);
    expect(markFor(CONV)?.acknowledged_at).toBe(5_000);
    // A watermark from the future would swallow turns that have not landed.
    useInboxStore.getState().ackSessionRead(CONV, clock + 60_000);
    expect(markFor(CONV)?.acknowledged_at).toBe(clock);
  });

  // ── The manual flag ───────────────────────────────────────────────────────

  it("marking unread lights a session the ack already covered", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    expect(unread(CONV)).toBe(false);

    useInboxStore.getState().markSessionUnread(CONV);
    expect(unread(CONV)).toBe(true);
    expect(markFor(CONV)?.manual_unread).toBe(true);
    expect(calls.filter((c) => c.action === "writeSessionUnread")).toHaveLength(1);
  });

  it("the manual flag survives a session that never moves, and only an ack clears it", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    useInboxStore.getState().markSessionUnread(CONV);
    expect(unread(CONV)).toBe(true);

    // Deriving again changes nothing — the flag is not a function of time.
    expect(unread(CONV)).toBe(true);

    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    expect(unread(CONV)).toBe(false);
    // Cleared by DELETION, mirroring the server's projection, which omits a
    // false flag. A literal `false` would never reconcile by === against the
    // server's `undefined` and would freeze the row's protection forever.
    expect("manual_unread" in (markFor(CONV) as object)).toBe(false);
  });

  it("marking a session unread that has no mark at all still lights it", () => {
    useInboxStore.setState({
      sessions: { [CONV]: session(CONV, 5_000) },
      _lastViewedAt: { [CONV]: 9_000 },
    } as any);
    // The local record would otherwise cover it.
    expect(unread(CONV)).toBe(false);
    useInboxStore.getState().markSessionUnread(CONV);
    expect(unread(CONV)).toBe(true);
  });

  // ── The server echo (a second window's write, or our own) ─────────────────

  it("the real server row supersedes the optimistic stub without changing what is lit", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 5_000) } } as any);
    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    expect(Object.keys(useInboxStore.getState().sessionReads)).toEqual([`sessionread-${CONV}`]);

    clock += 1;
    useInboxStore.getState().syncTable("sessionReads", [
      { _id: serverId("readrow"), conversation_id: CONV, acknowledged_at: 5_000, updated_at: clock },
    ]);

    // altKey rekeys the stub onto the server row: one mark, not two.
    expect(Object.keys(sessionReadMap(useInboxStore.getState().sessionReads))).toEqual([CONV]);
    expect(unread(CONV)).toBe(false);
  });

  it("another window's ack arrives as a plain sync and clears the card here", () => {
    // The second window's write reaches this one either through the sync host's
    // replication slice or through the server; both land as syncTable rows.
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 7_000) } } as any);
    expect(unread(CONV)).toBe(true);

    useInboxStore.getState().syncTable("sessionReads", [
      { _id: serverId("readrow"), conversation_id: CONV, acknowledged_at: 7_000, updated_at: clock },
    ]);
    expect(unread(CONV)).toBe(false);
  });

  it("another window's mark-unread arrives the same way and lights the card here", () => {
    useInboxStore.setState({ sessions: { [CONV]: session(CONV, 7_000) } } as any);
    useInboxStore.getState().ackSessionRead(CONV, 7_000);
    expect(unread(CONV)).toBe(false);

    clock += 1;
    useInboxStore.getState().syncTable("sessionReads", [
      { _id: serverId("readrow"), conversation_id: CONV, acknowledged_at: 7_000, manual_unread: true, updated_at: clock },
    ]);
    expect(unread(CONV)).toBe(true);
  });

  // ── The local fallback ────────────────────────────────────────────────────

  it("a session with no mark falls back to this device's last-opened record", () => {
    useInboxStore.setState({
      sessions: { [CONV]: session(CONV, 5_000), [OTHER]: session(OTHER, 5_000) },
      _lastViewedAt: { [CONV]: 6_000 },
    } as any);
    // Without the fallback the model's arrival would light every session a
    // long-time user has already read.
    expect(unread(CONV)).toBe(false);
    expect(unread(OTHER)).toBe(true);
  });

  // ── The wake signature ────────────────────────────────────────────────────

  it("the wake signature names exactly the lit sessions and ignores heartbeats", () => {
    useInboxStore.setState({
      sessions: { [CONV]: session(CONV, 5_000), [OTHER]: session(OTHER, 5_000) },
    } as any);
    const before = sessionUnreadWakeSig(useInboxStore.getState());
    expect(before.split(",").sort()).toEqual([CONV, OTHER].sort());

    // A liveness tick hands back a NEW sessions ref with the same updated_at.
    // The signature must be identical, or the sidebar re-renders every second.
    useInboxStore.setState({
      sessions: { [CONV]: session(CONV, 5_000), [OTHER]: session(OTHER, 5_000) },
    } as any);
    expect(sessionUnreadWakeSig(useInboxStore.getState())).toBe(before);

    useInboxStore.getState().ackSessionRead(CONV, 5_000);
    expect(sessionUnreadWakeSig(useInboxStore.getState())).toBe(OTHER);
  });

  // ── The turn stamp and the boundary flag (ct-49533) ───────────────────────

  it("a card lights on a turn ending, not on the row's other writes", () => {
    // A triage write bumped updated_at long after the last turn. Nothing was
    // said, so nothing is unread.
    useInboxStore.setState({
      sessions: { [CONV]: { ...session(CONV, 9_000), turn_completed_at: 4_000 } },
    } as any);
    useInboxStore.getState().ackSessionRead(CONV, 4_000);
    expect(unread(CONV)).toBe(false);

    // The agent takes another turn.
    useInboxStore.setState({
      sessions: { [CONV]: { ...session(CONV, 9_000), turn_completed_at: 9_500 } },
    } as any);
    expect(unread(CONV)).toBe(true);
  });

  it("a resume never lights a card that had nothing new in it", () => {
    // A session boundary (resume / clear / manual compact) bumps updated_at
    // without a turn ending. Believing it would light every session the user
    // resumed, which is the whole failure ct-49533's flag exists to prevent.
    useInboxStore.setState({
      sessions: { [CONV]: { ...session(CONV, 9_000), agent_status_boundary: true } },
    } as any);
    expect(unread(CONV)).toBe(false);
  });

  it("the ack writes the same number the card compares against", () => {
    // If the hook acknowledged updated_at while the card compared against
    // turn_completed_at, the dot could never be cleared.
    useInboxStore.setState({
      sessions: { [CONV]: { ...session(CONV, 3_000), turn_completed_at: 8_000 } },
    } as any);
    expect(unread(CONV)).toBe(true);
    useInboxStore.getState().ackSessionRead(CONV, 8_000);
    expect(unread(CONV)).toBe(false);
    expect(markFor(CONV)?.acknowledged_at).toBe(8_000);
  });

  // ── Registration ──────────────────────────────────────────────────────────

  it("the collection is registered, replicated, and superseded by conversation_id", () => {
    const entry = CLIENT_SYNC_REGISTRY.sessionReads as any;
    expect(entry.sync).toEqual({ isDelta: true, altKey: "conversation_id" });
    expect(entry.feeds).toEqual(["sessionReads.listMine"]);
    // The viewer's read marks are the same in every window of theirs — an ack
    // in one must clear the card in all of them.
    expect(REPLICATION_CLASSIFICATION.sessionReads).toBe("shared");
  });
});
