import { beforeEach, describe, expect, it } from "bun:test";
import { applyLiveInboxIds } from "../useLiveInboxSessions";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";

const ME = "kd77bg600000000000000000000000me";
const BOT = "kd7e0g100000000000000000000000bt";
const DISOWNED = "jx78xak0000000000000000000000aaa";
const KILLED = "jx7kill0000000000000000000000ccc";
const LIVE = "jx7live0000000000000000000000bbb";
const OLD = "jx7old00000000000000000000000ddd";

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
const owned = (id: string) => row(id, { user_id: BOT, owned_by_me: true, owner_user_id: ME });

// A fake client whose getInboxSessionsByIds returns the rows `serves` holds,
// recording every id it was asked about.
function byIdsClient(serves: Record<string, InboxSession>) {
  const asked: string[] = [];
  return {
    asked,
    query: async (_fn: unknown, args: { ids: string[] }) => {
      asked.push(...args.ids);
      return { sessions: args.ids.filter((id) => serves[id]).map((id) => serves[id]) };
    },
  };
}
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("applyLiveInboxIds: a foreign row I own that leaves the live list is settled through byIds", () => {
  beforeEach(() => {
    useInboxStore.setState({
      currentUser: { _id: ME } as any,
      sessions: { [DISOWNED]: owned(DISOWNED), [KILLED]: owned(KILLED), [OLD]: owned(OLD), [LIVE]: row(LIVE, { user_id: ME }) },
      liveInboxIds: new Set([LIVE, DISOWNED, KILLED]),
      liveInboxIdList: [LIVE, DISOWNED, KILLED],
    });
  });

  it("an id byIds omits loses only its claim; one byIds returns keeps the server's stamps", async () => {
    // KILLED left the list's scan but I still own it, so byIds returns it.
    const client = byIdsClient({ [KILLED]: { ...owned(KILLED), inbox_killed_at: 5 } as InboxSession });
    applyLiveInboxIds([{ _id: LIVE }], client);
    await settled();
    const s = useInboxStore.getState();
    expect(client.asked.sort()).toEqual([DISOWNED, KILLED].sort());
    expect(s.sessions[DISOWNED]).toBeDefined();
    expect(s.sessions[DISOWNED].owned_by_me).toBe(false);
    expect(s.sessions[DISOWNED].owner_user_id).toBeNull();
    expect(s.sessions[KILLED].owned_by_me).toBe(true);
    expect(s.sessions[KILLED].owner_user_id).toBe(ME);
    expect([...s.liveInboxIds]).toEqual([LIVE]);
  });

  it("asks nothing when no claiming row left: rows the list never held, and an unchanged set", async () => {
    const client = byIdsClient({});
    applyLiveInboxIds([{ _id: LIVE }, { _id: DISOWNED }, { _id: KILLED }], client);
    await settled();
    expect(client.asked).toEqual([]);
    expect(useInboxStore.getState().sessions[OLD].owned_by_me).toBe(true);
  });

  it("never asks about my own runs", async () => {
    useInboxStore.setState({ liveInboxIds: new Set([LIVE]), liveInboxIdList: [LIVE] });
    const client = byIdsClient({});
    applyLiveInboxIds([], client);
    await settled();
    expect(client.asked).toEqual([]);
  });
});
