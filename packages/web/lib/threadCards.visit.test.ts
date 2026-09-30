import { describe, expect, test } from "bun:test";
import { arrangeVisit, newVisit, readerFold, READER_TAIL, type ThreadCardModel } from "./threadCards";

// The Threads page is one stable list per visit: new threads on top, then the
// seen ones under a marker, and nothing the reader does moves a thread.

const T0 = 1_700_000_000_000;

function card(id: string, over: Partial<ThreadCardModel> = {}, readAt = T0): ThreadCardModel {
  return {
    id,
    kind: "task",
    chip: "task",
    activityAt: T0,
    unread: 0,
    href: `/tasks/${id}`,
    source: { _id: id, kind: "task", root_key: id, last_activity_at: T0, last_read_at: readAt, updated_at: T0, unread: over.unread ?? 0 } as any,
    ...over,
  };
}

const ids = (cs: ThreadCardModel[]) => cs.map((c) => c.id);

describe("arrangeVisit", () => {
  test("first pass: unread threads above the marker, read ones below, each newest first", () => {
    const v = newVisit();
    const out = arrangeVisit(v, [card("a", { unread: 1 }), card("b"), card("c", { unread: 2 }), card("d")]);
    expect(ids(out.fresh)).toEqual(["a", "c"]);
    expect(ids(out.seen)).toEqual(["b", "d"]);
  });

  test("reading or answering a thread moves nothing, even as its activity jumps", () => {
    const v = newVisit();
    arrangeVisit(v, [card("a", { unread: 1 }), card("b", { unread: 1 }), card("c")]);
    // b is read and answered: unread 0, newest activity, sorted first by the source.
    const out = arrangeVisit(v, [card("b", { activityAt: T0 + 5000 }), card("a"), card("c")]);
    expect(ids(out.fresh)).toEqual(["a", "b"]);
    expect(ids(out.seen)).toEqual(["c"]);
  });

  test("a thread that leaves the source mid visit keeps its place", () => {
    const v = newVisit();
    arrangeVisit(v, [card("a", { unread: 1 }), card("b", { unread: 1 })]);
    const out = arrangeVisit(v, [card("b")]);
    expect(ids(out.fresh)).toEqual(["a", "b"]);
  });

  test("an unread arrival lands on top of the new section", () => {
    const v = newVisit();
    arrangeVisit(v, [card("a", { unread: 1 }), card("b")]);
    const out = arrangeVisit(v, [card("x", { unread: 1 }), card("y", { unread: 1 }), card("a", { unread: 1 }), card("b")]);
    expect(ids(out.fresh)).toEqual(["x", "y", "a"]);
  });

  test("an older page loading in joins the bottom of the seen section", () => {
    const v = newVisit();
    arrangeVisit(v, [card("a", { unread: 1 }), card("b")]);
    const out = arrangeVisit(v, [card("a"), card("b"), card("old1"), card("old2")]);
    expect(ids(out.seen)).toEqual(["b", "old1", "old2"]);
  });

  test("news on a seen thread moves it up into the new section", () => {
    const v = newVisit();
    arrangeVisit(v, [card("a", { unread: 1 }), card("b"), card("c")]);
    const out = arrangeVisit(v, [card("c", { unread: 1 }), card("a"), card("b")]);
    expect(ids(out.fresh)).toEqual(["c", "a"]);
    expect(ids(out.seen)).toEqual(["b"]);
  });

  test("the unread boundary is the one the visit first saw", () => {
    const v = newVisit();
    arrangeVisit(v, [card("a", { unread: 1 }, T0 - 100)]);
    arrangeVisit(v, [card("a", {}, T0)]);
    expect(v.readAt.get("a")).toBe(T0 - 100);
  });
});

describe("readerFold", () => {
  test("with news: the new items and one earlier for context", () => {
    expect(readerFold([1, 2, 3, 4, 5, 6], 4)).toEqual({ hidden: 3, firstNew: 4 });
  });

  test("with nothing new: the newest few", () => {
    expect(readerFold([1, 2, 3, 4, 5, 6], 10)).toEqual({ hidden: 6 - READER_TAIL, firstNew: -1 });
    expect(readerFold([1, 2], 10).hidden).toBe(0);
  });

  test("no boundary (a session) folds to the newest few with no divider", () => {
    expect(readerFold([1, 2, 3, 4, 5], 0)).toEqual({ hidden: 5 - READER_TAIL, firstNew: -1 });
  });

  test("undefined is not a reader: everything shows", () => {
    expect(readerFold([1, 2, 3, 4, 5], undefined)).toEqual({ hidden: 0, firstNew: -1 });
  });
});

describe("answered threads", () => {
  test("a thread whose newest reply is the viewer's own shows no stale unread", async () => {
    const { serverCards, cardsForChip } = await import("./threadCards");
    const row = (id: string, user_id: string, author_kind?: "agent") =>
      ({ _id: id, kind: "task", root_key: id, last_activity_at: T0, last_read_at: 0, updated_at: T0, unread: 2, last_reply: { _id: "m", created_at: T0, preview: "", user_id, author_kind } }) as any;
    const cards = serverCards([row("mine", "u_me"), row("theirs", "u_other"), row("agent", "u_me", "agent")], () => undefined, () => undefined, () => undefined, "u_me");
    expect(cards.map((c) => [c.id, c.unread])).toEqual([["mine", 0], ["theirs", 2], ["agent", 2]]);
    expect(cardsForChip(cards, "all", false)).toHaveLength(3);
  });
});
