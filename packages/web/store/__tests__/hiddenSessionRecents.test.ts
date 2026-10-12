import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";

// Opening a stashed or dismissed session (an old one found through search, a
// "Stashed" row) shows it through the view-only viewingDismissedId peek. That
// is a view like any other: it must land in recents and the Ctrl+Tab order.

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const ACTIVE = serverId("active");
const HIDDEN = serverId("hidden");

function session(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id,
    session_id: `s-${id}`,
    title: id === HIDDEN ? "x influence" : "active one",
    updated_at: 1_000,
    agent_type: "claude_code",
    message_count: 3,
    is_idle: true,
    has_pending: false,
    last_role_is_user: false,
    ...extra,
  } as InboxSession;
}

describe("viewing a hidden session records the visit", () => {
  const owner = {};
  const realNow = Date.now;
  let clock = 10_000;

  beforeEach(() => {
    clock = 10_000;
    (Date as unknown as { now: () => number }).now = () => clock;
    useInboxStore.setState({
      sessions: {
        [ACTIVE]: session(ACTIVE),
        [HIDDEN]: session(HIDDEN, { inbox_stashed_at: 500 } as Partial<InboxSession>),
      },
      conversations: {},
      viewingDismissedId: null,
      recentVisits: [],
      _lastViewedAt: {},
      _seenUpToAt: {},
      _seenMessageCount: {},
      pending: {},
    } as any);
    useInboxStore.getState()._setDispatch(async () => null, { owner });
    useInboxStore.getState().setCurrentSession(ACTIVE, "deep-link");
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
    (Date as unknown as { now: () => number }).now = realNow;
  });

  it("navigateToSession on a stashed session puts it at the top of recents and MRU", () => {
    clock = 20_000;
    useInboxStore.getState().navigateToSession(HIDDEN, "deep-link");

    const s = useInboxStore.getState();
    expect(s.viewingDismissedId).toBe(HIDDEN);
    expect(s.recentVisits[0]).toMatchObject({ kind: "session", key: HIDDEN, label: "x influence" });
    expect(s._lastViewedAt[HIDDEN]).toBe(20_000);
    // Leaving the current session marks it seen, as any other switch does.
    expect(s._seenUpToAt[ACTIVE]).toBe(20_000);
  });

  it("re-asserting the same peek does not re-stamp it", () => {
    clock = 20_000;
    useInboxStore.getState().setViewingDismissedId(HIDDEN);
    clock = 30_000;
    useInboxStore.getState().setViewingDismissedId(HIDDEN);
    expect(useInboxStore.getState()._lastViewedAt[HIDDEN]).toBe(20_000);
  });
});
