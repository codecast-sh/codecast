import { beforeEach, describe, expect, it } from "bun:test";
import { applyLiveInboxIds } from "../useLiveInboxSessions";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";

const ME = "kd77bg600000000000000000000000me";
const BOT = "kd7e0g100000000000000000000000bt";
const DISOWNED = "jx78xak0000000000000000000000aaa";
const LIVE = "jx7live0000000000000000000000bbb";

const row = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id.slice(0, 7)}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 5,
  is_idle: false,
  has_pending: false,
  ...extra,
});

describe("applyLiveInboxIds — disown reconcile runs ahead of the change-guard", () => {
  beforeEach(() => {
    useInboxStore.setState({
      currentUser: { _id: ME } as any,
      sessions: {
        [DISOWNED]: row(DISOWNED, { user_id: BOT, owned_by_me: true, owner_user_id: ME }),
        [LIVE]: row(LIVE, { user_id: ME }),
      },
      liveInboxIds: new Set([LIVE]),
      liveInboxIdList: [LIVE],
    });
  });

  it("clears a stale ownership claim even when the id set is unchanged (early return path)", () => {
    // A reload after another tab already recorded the post-disown set: the
    // change-guard short-circuits setLiveInboxIds, but the stale cached row
    // must still lose its owned_by_me claim or it renders under show-old.
    applyLiveInboxIds([{ _id: LIVE }]);
    const s = useInboxStore.getState();
    expect([...s.liveInboxIds]).toEqual([LIVE]);
    expect(s.sessions[DISOWNED].owned_by_me).toBe(false);
    expect(s.sessions[DISOWNED].owner_user_id).toBeNull();
  });

  it("a payload that still routes the session to me leaves its claim intact", () => {
    applyLiveInboxIds([{ _id: LIVE }, { _id: DISOWNED }]);
    const s = useInboxStore.getState();
    expect(s.sessions[DISOWNED].owned_by_me).toBe(true);
    expect([...s.liveInboxIds].sort()).toEqual([DISOWNED, LIVE].sort());
  });
});
