import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { threadRowId } from "../threadTypes";

// The switcher's "Mark all read" on another workspace's row: that workspace's
// badge and rows clear at once, and the Threads count for the workspace on
// screen stays where it was.

const ACTIVE = "teamactive".padEnd(32, "0");
const OTHER = "teamother".padEnd(32, "0");

const row = (root: string, team_id?: string) => ({
  _id: threadRowId("chat", root), kind: "chat", root_key: root, team_id,
  last_activity_at: 10, last_read_at: 5, updated_at: 10, unread: 1,
});

describe("markAllThreadsRead from the switcher", () => {
  const owner = {};
  const calls: Array<{ action: string; args: any[] }> = [];

  beforeEach(() => {
    calls.length = 0;
    useInboxStore.setState({
      clientState: { ui: { active_team_id: ACTIVE } },
      pending: {},
      threadUnread: 3,
      threadUnreadByWorkspace: [{ team_id: OTHER, count: 2 }, { team_id: null, count: 4 }],
      threadInbox: {
        [threadRowId("chat", "a")]: row("a", ACTIVE),
        [threadRowId("chat", "o")]: row("o", OTHER),
      },
    } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => { calls.push({ action, args }); return { marked: 1 }; }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  it("clears that workspace's badge and rows without touching the one on screen", () => {
    useInboxStore.getState().markAllThreadsRead(OTHER, "all");
    const s = useInboxStore.getState() as any;
    expect(s.threadUnreadByWorkspace).toEqual([{ team_id: null, count: 4 }]);
    expect(s.threadInbox[threadRowId("chat", "o")].unread).toBe(0);
    expect(s.threadInbox[threadRowId("chat", "a")].unread).toBe(1);
    expect(s.threadUnread).toBe(3);
    expect(calls.map((c) => c.action)).toContain("markAllThreadsRead");
  });

  it("clears Personal's badge by its null team", () => {
    useInboxStore.getState().markAllThreadsRead(null, "all");
    expect((useInboxStore.getState() as any).threadUnreadByWorkspace).toEqual([{ team_id: OTHER, count: 2 }]);
    expect((useInboxStore.getState() as any).threadUnread).toBe(3);
  });

  it("still zeroes the on-screen count when sweeping the workspace on screen", () => {
    useInboxStore.getState().markAllThreadsRead(ACTIVE, "all");
    expect((useInboxStore.getState() as any).threadUnread).toBe(0);
  });
});
