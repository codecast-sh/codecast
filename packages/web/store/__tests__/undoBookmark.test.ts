import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { _resetUndoStacks, performUndo, setUndoNotifier } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

// A fresh bookmark stays undoable after the server's listBookmarks echo, whose
// row carries the server's own _id and created_at: created_at is a field the
// server assigns, not one the user chose (UNDO_CONFIG.serverAssignedFields).
const CONV = "c".repeat(32);
const MSG = "m".repeat(32);
const s = () => useInboxStore.getState() as any;
const owner = {};
let notices: string[] = [];
let sent: string[] = [];
beforeAll(() => s()._setDispatch(async (a: string) => { sent.push(a); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  notices = [];
  sent = [];
  setUndoNotifier({ notify: (m) => notices.push(m), onHistoryStep: (k, _n, e) => notices.push(`${k}:${e.label}`) });
  useInboxStore.setState({ bookmarks: [], pending: {} } as any);
});

test("undo of a fresh bookmark after the echo carries the server's created_at", async () => {
  s().toggleBookmark(CONV, MSG);
  const local = s().bookmarks[0];
  s().syncTable("bookmarks", [{ _id: "b".repeat(32), conversation_id: CONV, message_id: MSG, created_at: local.created_at + 37, name: null, note: null, conversation_title: "x" }]);
  expect(s().bookmarks.map((b: any) => b.message_id)).toEqual([MSG]);
  sent = [];
  performUndo();
  await new Promise((r) => setTimeout(r, 5));
  expect({ notices, bookmarks: s().bookmarks.length, sent }).toEqual({
    notices: ["undo:Bookmarked a message"],
    bookmarks: 0,
    sent: ["toggleBookmark"],
  });
});
