import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The on/off of a bookmark must be local-first: the toggle updates the store
// synchronously, and an unrelated server re-push of listBookmarks (which re-runs
// on any heartbeat that bumps a bookmarked conversation) must not revert an
// in-flight toggle before its own mutation has committed.
const CONV = "conv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MSG = "msg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function serverRow(messageId: string) {
  return { _id: `bk_${messageId}`, conversation_id: CONV, message_id: messageId, created_at: 100 };
}

describe("bookmark local-first toggle", () => {
  beforeEach(() => {
    useInboxStore.setState({ bookmarks: [], bookmarkPending: {}, pending: {} });
  });

  it("adds optimistically at the top and records the pending intent", () => {
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    const s = useInboxStore.getState();
    expect(s.bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
    expect(s.bookmarkPending[MSG]).toEqual({ bookmarked: true, conversationId: CONV });
  });

  it("removes optimistically and records the pending intent", () => {
    useInboxStore.setState({ bookmarks: [serverRow(MSG)] });
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    const s = useInboxStore.getState();
    expect(s.bookmarks).toHaveLength(0);
    expect(s.bookmarkPending[MSG]).toEqual({ bookmarked: false, conversationId: CONV });
  });

  it("keeps an in-flight add when a stale list sync arrives before the mutation commits", () => {
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    // Heartbeat re-push of listBookmarks: server hasn't seen the add yet.
    useInboxStore.getState().syncTable("bookmarks", []);
    const s = useInboxStore.getState();
    expect(s.bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
    expect(s.bookmarkPending[MSG]).toBeDefined();
  });

  it("clears the pending add once the server list reflects it", () => {
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    useInboxStore.getState().syncTable("bookmarks", [serverRow(MSG)]);
    const s = useInboxStore.getState();
    expect(s.bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
    expect(s.bookmarkPending[MSG]).toBeUndefined();
  });

  it("keeps an in-flight removal when a stale list sync still contains the row", () => {
    useInboxStore.setState({ bookmarks: [serverRow(MSG)] });
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    // Server still has the row (delete not committed yet).
    useInboxStore.getState().syncTable("bookmarks", [serverRow(MSG)]);
    const s = useInboxStore.getState();
    expect(s.bookmarks).toHaveLength(0);
    expect(s.bookmarkPending[MSG]).toBeDefined();
  });

  it("clears the pending removal once the server list drops the row", () => {
    useInboxStore.setState({ bookmarks: [serverRow(MSG)] });
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    useInboxStore.getState().syncTable("bookmarks", []);
    const s = useInboxStore.getState();
    expect(s.bookmarks).toHaveLength(0);
    expect(s.bookmarkPending[MSG]).toBeUndefined();
  });

  it("leaves an untouched server list alone when there are no pending toggles", () => {
    const list = [serverRow(MSG)];
    useInboxStore.getState().syncTable("bookmarks", list);
    expect(useInboxStore.getState().bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
  });
});
