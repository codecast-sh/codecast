import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The on/off of a bookmark must be local-first: the toggle updates the store
// synchronously, and an unrelated server re-push of listBookmarks (which re-runs
// on any heartbeat that bumps a bookmarked conversation) must not revert an
// in-flight toggle before its own mutation has committed. `bookmarks` is a
// localFirst list keyed by message_id, so the engine's membership locks
// (bookmarks:<message id>) do the holding, and a refusal undoes the toggle.
const CONV = "conv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MSG = "msg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function serverRow(messageId: string) {
  return { _id: `bk_${messageId}`, conversation_id: CONV, message_id: messageId, created_at: 100 };
}

const lock = () => (useInboxStore.getState().pending as any)[`bookmarks:${MSG}`];

describe("bookmark local-first toggle", () => {
  const owner = {};
  let refuse = false;
  beforeEach(() => {
    refuse = false;
    useInboxStore.setState({ bookmarks: [], pending: {} });
    useInboxStore.getState()._setDispatch(async () => {
      if (refuse) throw new Error("Uncaught Error: no");
      return null;
    }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  it("adds optimistically at the top and records the pending intent", () => {
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    const s = useInboxStore.getState();
    expect(s.bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
    expect(lock()).toMatchObject({ type: "include" });
  });

  it("removes optimistically and records the pending intent", () => {
    useInboxStore.setState({ bookmarks: [serverRow(MSG)] });
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    const s = useInboxStore.getState();
    expect(s.bookmarks).toHaveLength(0);
    expect(lock()).toMatchObject({ type: "exclude" });
  });

  it("keeps an in-flight add when a stale list sync arrives before the mutation commits", () => {
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    // Heartbeat re-push of listBookmarks: server hasn't seen the add yet.
    useInboxStore.getState().syncTable("bookmarks", []);
    const s = useInboxStore.getState();
    expect(s.bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
    expect(lock()).toBeDefined();
  });

  it("clears the pending add once the server list reflects it", () => {
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    useInboxStore.getState().syncTable("bookmarks", [serverRow(MSG)]);
    const s = useInboxStore.getState();
    expect(s.bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
    expect(lock()).toBeUndefined();
  });

  it("keeps an in-flight removal when a stale list sync still contains the row", () => {
    useInboxStore.setState({ bookmarks: [serverRow(MSG)] });
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    // Server still has the row (delete not committed yet).
    useInboxStore.getState().syncTable("bookmarks", [serverRow(MSG)]);
    const s = useInboxStore.getState();
    expect(s.bookmarks).toHaveLength(0);
    expect(lock()).toBeDefined();
  });

  it("clears the pending removal once the server list drops the row", () => {
    useInboxStore.setState({ bookmarks: [serverRow(MSG)] });
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    useInboxStore.getState().syncTable("bookmarks", []);
    const s = useInboxStore.getState();
    expect(s.bookmarks).toHaveLength(0);
    expect(lock()).toBeUndefined();
  });

  it("puts a refused add back the way it was", async () => {
    refuse = true;
    useInboxStore.getState().toggleBookmark(CONV, MSG);
    expect(useInboxStore.getState().bookmarks).toHaveLength(1);
    for (let i = 0; i < 100 && lock(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(lock()).toBeUndefined();
    expect(useInboxStore.getState().bookmarks).toHaveLength(0);
  });

  it("leaves an untouched server list alone when there are no pending toggles", () => {
    const list = [serverRow(MSG)];
    useInboxStore.getState().syncTable("bookmarks", list);
    expect(useInboxStore.getState().bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
  });
});
