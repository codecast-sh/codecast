import { describe, expect, test } from "bun:test";
import { unreadOnlyCards, type ThreadCardModel } from "./threadCards";

// The All view is an inbox: a card earns its place by carrying unread. The
// held set is the visit's memory — a card admitted once stays until the page
// is left, so marking itself read under the reader never removes it mid-read.

const card = (id: string, over: Partial<ThreadCardModel> = {}): ThreadCardModel => ({
  id,
  kind: "chat",
  chip: "chat",
  activityAt: 1,
  unread: 0,
  href: "/chat/x",
  source: {} as never,
  ...over,
});

describe("unreadOnlyCards", () => {
  test("read cards drop, unread cards stay", () => {
    const out = unreadOnlyCards([card("read"), card("new", { unread: 2 })], new Set());
    expect(out.map((c) => c.id)).toEqual(["new"]);
  });

  test("a card once shown holds its place after it is read", () => {
    const held = new Set<string>();
    expect(unreadOnlyCards([card("a", { unread: 1 })], held).map((c) => c.id)).toEqual(["a"]);
    // The reader saw it and it marked itself read: still on screen this visit.
    expect(unreadOnlyCards([card("a", { unread: 0 })], held).map((c) => c.id)).toEqual(["a"]);
    // A fresh visit starts a fresh hold: the read card is gone.
    expect(unreadOnlyCards([card("a", { unread: 0 })], new Set())).toEqual([]);
  });

  test("session cards ride the Sessions switch, not the unread rule", () => {
    const out = unreadOnlyCards(
      [card("session:s", { kind: "session", chip: "session" }), card("read")],
      new Set(),
    );
    expect(out.map((c) => c.id)).toEqual(["session:s"]);
  });
});
