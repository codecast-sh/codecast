import { beforeEach, describe, expect, it } from "bun:test";
import {
  useInboxStore,
  SESSIONS_PRESERVE_FIELDS,
  SESSIONS_STRIP_FIELDS,
  __resetHeldOverlayFactsForTests,
  computeInboxMembership,
  type InboxSession,
} from "../inboxStore";
import {
  INBOX_FACT_FIELDS,
  INBOX_PROJECTION_FIELDS,
  INBOX_PROJECTION_VERSION,
} from "@codecast/shared/contracts";

// The overlay applier split (sync-convergence C1): one payload carries FACTS
// (merged onto session rows, single writer) and STAMPS (the server's run of the
// shared projection — checking data, stored per scope in sessionsProjection and
// NEVER on a row). Every other sessions channel strips the stamp fields before
// the merge, so no channel can put a server verdict where a render path could
// mistake it for local truth.

const A = "a".repeat(32);
const B = "b".repeat(32);
const CHILD = "c".repeat(32);
const UNKNOWN = "d".repeat(32);

const row = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id.slice(0, 2)}`,
  agent_type: "claude_code",
  updated_at: Date.now(),
  message_count: 3,
  is_idle: true,
  has_pending: false,
  ...extra,
});

const stamp = {
  bucket: "needs_input",
  work_state: "needs_input",
  asking: false,
  below_fold: false,
  bucket_stale_at: null,
  stale_bucket: null,
};

const envelope = (over: Record<string, unknown> = {}) => ({
  v: INBOX_PROJECTION_VERSION,
  epoch: 1_756_600_000_000 - (1_756_600_000_000 % 60_000),
  user_id: "u1",
  scope: "mine",
  team_id: null,
  tally: { shown: {}, folded: {} },
  set_digest: "00000000deadbeef",
  truncated: [],
  ...over,
});

beforeEach(() => {
  useInboxStore.setState({
    sessions: { [A]: row(A), [CHILD]: row(CHILD, { parent_conversation_id: A, parent_message_uuid: "u" }) },
    sessionsProjection: {},
    pending: {},
  } as any);
});

describe("field list derivation (signature)", () => {
  it("the client preserve list derives from the shared fact constant", () => {
    for (const f of INBOX_FACT_FIELDS) expect(SESSIONS_PRESERVE_FIELDS).toContain(f);
  });

  it("the strip list IS the shared projection-stamp constant", () => {
    expect([...SESSIONS_STRIP_FIELDS]).toEqual([...INBOX_PROJECTION_FIELDS]);
  });
});

describe("applyInboxLivenessPayload — the one applier for { liveness, projection }", () => {
  it("splits a member row: facts merge onto the session row, stamps land in the scope buffer", () => {
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: {
        [A]: {
          agent_status: "working",
          is_idle: false,
          message_count: 7,
          updated_at: 123456,
          last_turn_allows_park: true,
          ...stamp,
        },
      },
      projection: envelope(),
    });
    const s = useInboxStore.getState();
    const merged = s.sessions[A] as any;
    expect(merged.agent_status).toBe("working");
    expect(merged.is_idle).toBe(false);
    expect(merged.message_count).toBe(7);
    expect(merged.last_turn_allows_park).toBe(true);
    // No stamp field ever reaches a row.
    for (const f of INBOX_PROJECTION_FIELDS) expect(merged[f]).toBeUndefined();
    // The buffer holds the stamps and the envelope.
    const slot = s.sessionsProjection["mine"];
    expect(slot).toBeDefined();
    expect(slot.v).toBe(INBOX_PROJECTION_VERSION);
    expect(slot.epoch).toBe(envelope().epoch as number);
    expect(slot.set_digest).toBe("00000000deadbeef");
    expect(slot.truncated).toEqual([]);
    expect(typeof slot.receivedAtMono).toBe("number");
    expect(slot.stamps[A]).toEqual(stamp as any);
  });

  it("an absent fact is null: a stale \"stopped\" does not outlive the payload that dropped it", () => {
    // Prod, 2026-09-01: the managed row aged out, the server's trusted status
    // became undefined, Convex dropped the key, and a merge that only wrote the
    // keys it received kept "stopped" from the day the daemon died — filing a
    // declared-done session under Needs Input on every replica while the stamp
    // beside it said done.
    useInboxStore.setState({ sessions: { [A]: row(A, { agent_status: "stopped", thread_state_status: "done", message_count: 40 }) } } as any);
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: { [A]: { is_idle: true, awaiting_input: false, is_connected: false, message_count: 40, updated_at: 5, ...stamp, bucket: "done", work_state: "done" } },
      projection: { v: INBOX_PROJECTION_VERSION, epoch: 60_000, tally: null, set_digest: null, truncated: [] },
    });
    const s = useInboxStore.getState().sessions[A] as any;
    expect(s.agent_status).toBeNull();
    expect(s.is_idle).toBe(true);
    expect(s.thread_state_status).toBe("done");
  });

  it("a fact-only child row (no bucket key) merges facts but adds no stamp", () => {
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: { [CHILD]: { agent_status: "working", is_idle: false } },
      projection: envelope(),
    });
    const s = useInboxStore.getState();
    expect((s.sessions[CHILD] as any).agent_status).toBe("working");
    expect(s.sessionsProjection["mine"].stamps[CHILD]).toBeUndefined();
  });

  it("an overlay never creates a row — an unknown id's stamp is buffered, its facts dropped", () => {
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: { [UNKNOWN]: { agent_status: "working", ...stamp } },
      projection: envelope(),
    });
    const s = useInboxStore.getState();
    expect(s.sessions[UNKNOWN]).toBeUndefined();
    // The stamp still lands: the compare needs it to name the row as `missing`
    // and heal it by id.
    expect(s.sessionsProjection["mine"].stamps[UNKNOWN]).toBeDefined();
  });

  it("personal and team scopes never share a slot", () => {
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: { [A]: { ...stamp, bucket: "working", work_state: "working" } },
      projection: envelope({ set_digest: "mine0000mine0000" }),
    });
    const mineBefore = useInboxStore.getState().sessionsProjection["mine"];
    useInboxStore.getState().applyInboxLivenessPayload("team:t1", {
      liveness: { [A]: { ...stamp, below_fold: true } },
      projection: envelope({ scope: "team", team_id: "t1", set_digest: "team0000team0000" }),
    });
    const s = useInboxStore.getState();
    expect(s.sessionsProjection["mine"].set_digest).toBe("mine0000mine0000");
    expect(s.sessionsProjection["mine"].stamps[A].bucket).toBe("working");
    expect(s.sessionsProjection["mine"].stamps[A].below_fold).toBe(false);
    expect(s.sessionsProjection["team:t1"].set_digest).toBe("team0000team0000");
    expect(s.sessionsProjection["team:t1"].stamps[A].below_fold).toBe(true);
    // The mine slot object was not rewritten by the team apply.
    expect(s.sessionsProjection["mine"]).toEqual(mineBefore);
  });

  it("the buffer is ephemeral: not registered for persistence", async () => {
    const { isPersistedStoreKey } = await import("../idbCache");
    expect(isPersistedStoreKey("sessionsProjection")).toBe(false);
  });
});

describe("single-writer enforcement on every row channel", () => {
  it("syncTable strips stamp fields from a base-list row before the merge", () => {
    useInboxStore.getState().syncTable("sessions", [
      { ...row(A), ...stamp, bucket: "pinned", work_state: "working" } as any,
    ]);
    const merged = useInboxStore.getState().sessions[A] as any;
    for (const f of INBOX_PROJECTION_FIELDS) expect(merged[f]).toBeUndefined();
  });

  it("syncOverlay strips them too — no channel may write a verdict onto a row", () => {
    useInboxStore.getState().syncOverlay("sessions", {
      [A]: { agent_status: "idle", bucket: "pinned", work_state: "working" },
    });
    const merged = useInboxStore.getState().sessions[A] as any;
    expect(merged.agent_status).toBe("idle");
    for (const f of INBOX_PROJECTION_FIELDS) expect(merged[f]).toBeUndefined();
  });

  it("base-channel nulls do not clobber overlay-set facts (preserve list from the shared constant)", () => {
    // The overlay (the one fact writer) lands a fresh fact…
    useInboxStore.getState().applyInboxLivenessPayload("mine", {
      liveness: { [A]: { agent_status: "working", tmux_session: "cc-1" } },
      projection: envelope(),
    });
    // …then the base list re-pushes the row with the facts stripped to null
    // (fast_fields_in_overlay): the overlay's values must survive.
    useInboxStore.getState().syncTable("sessions", [
      { ...row(A), agent_status: null, tmux_session: null } as any,
    ]);
    const merged = useInboxStore.getState().sessions[A] as any;
    expect(merged.agent_status).toBe("working");
    expect(merged.tmux_session).toBe("cc-1");
  });
});

describe("facts for a row the store does not hold yet are held for its arrival", () => {
  // A daemon-started session: the overlay (facts) and the base list (fast
  // fields stripped to null) are coalesced independently, so the overlay can
  // land first. Without the hold, the row landed with updated_at null, read
  // as 0 by the selection, and sat outside every window until the NEXT
  // overlay execution (one heartbeat with a live daemon; indefinite without).
  const NEW = "e".repeat(32);
  const EPOCH = 1_800_000_000_000;
  beforeEach(() => {
    __resetHeldOverlayFactsForTests();
    useInboxStore.setState({ sessions: {}, sessionsProjection: {}, pending: {} } as any);
  });

  it("overlay first, then the base row: the row lands with the overlay's facts and is a member at once", () => {
    const store = useInboxStore.getState();
    store.applyInboxLivenessPayload("mine", {
      liveness: { [NEW]: { bucket: "working", work_state: "working", agent_status: "working", is_idle: false, updated_at: EPOCH - 60_000, message_count: 2 } },
      projection: { v: INBOX_PROJECTION_VERSION, epoch: EPOCH, tally: {}, set_digest: "x", truncated: [] },
    });
    expect(useInboxStore.getState().sessions[NEW]).toBeUndefined();
    // The base list's shape with fast_fields_in_overlay: the facts are null.
    useInboxStore.getState().syncTable("sessions", [{ ...row(NEW), updated_at: null, message_count: null, agent_status: null, is_idle: null }]);
    const landed = useInboxStore.getState().sessions[NEW];
    expect(landed.updated_at).toBe(EPOCH - 60_000);
    expect(landed.message_count).toBe(2);
    expect(landed.agent_status).toBe("working");
    expect((landed as any).bucket).toBeUndefined();
    expect(computeInboxMembership(useInboxStore.getState().sessions, EPOCH).members.has(NEW)).toBe(true);
    // Consumed: a second sync of the same row does not re-merge stale facts.
    useInboxStore.getState().syncTable("sessions", [{ ...row(NEW), updated_at: EPOCH, message_count: 3 }]);
    expect(useInboxStore.getState().sessions[NEW].updated_at).toBe(EPOCH);
  });

  it("a newer payload replaces the hold, so nothing outlives one overlay execution", () => {
    const store = useInboxStore.getState();
    store.applyInboxLivenessPayload("mine", { liveness: { [NEW]: { updated_at: EPOCH - 60_000, message_count: 2 } } });
    store.applyInboxLivenessPayload("mine", { liveness: {} });
    useInboxStore.getState().syncTable("sessions", [{ ...row(NEW), updated_at: null, message_count: null }]);
    expect(useInboxStore.getState().sessions[NEW].updated_at).toBeNull();
  });
});
