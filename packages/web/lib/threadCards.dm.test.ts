import { describe, expect, test } from "bun:test";
import {
  cardsForChip,
  dmCards,
  defaultOpenEntry,
  openEntryExpired,
  resolveOpenEntry,
  sortCards,
  toggledOpenEntry,
  unreadByChip,
} from "./threadCards";
import type { ChatRailChannel } from "../store/chatSlice";

// DM cards on /threads: presence and rank in the All view key to the
// counterpart's last message (lastInboundAt). The viewer's own send never
// creates or re-ranks a card there — a reply RETIRES the card from All (the
// viewer spoke last, nothing awaits them) until the next inbound — and never
// re-opens a card the user collapsed. The DMs chip follows the same rule.

const T0 = 1_700_000_000_000;

function room(id: string, over: Partial<ChatRailChannel> = {}): ChatRailChannel {
  return {
    id,
    name: id,
    kind: "dm",
    isPrivate: false,
    unreadCount: 0,
    mentionCount: 0,
    muted: false,
    sortAt: T0,
    notifyLevel: "all",
    joined: true,
    ...over,
  } as ChatRailChannel;
}

describe("presence", () => {
  test("a room with no inbound ever is browse-only: in no view", () => {
    const cards = dmCards([
      room("quiet", { sortAt: T0 + 5000 }), // viewer-only sends
      room("live", { sortAt: T0, lastInboundAt: T0 }),
    ]);
    expect(cardsForChip(cards, "all", false).map((c) => c.id)).toEqual(["dm:live"]);
    expect(cardsForChip(cards, "dm", false).map((c) => c.id)).toEqual(["dm:live"]);
  });

  test("a fresh outbound to a quiet room creates no card in All", () => {
    const before = dmCards([room("quiet", { sortAt: T0 })]);
    expect(cardsForChip(before, "all", false)).toEqual([]);
    // The viewer sends: sortAt moves, lastInboundAt stays absent.
    const after = dmCards([room("quiet", { sortAt: T0 + 60_000 })]);
    expect(cardsForChip(after, "all", false)).toEqual([]);
  });
});

describe("rank and timestamp", () => {
  const rail = (bSortAt: number, bInboundAt: number) => [
    room("a", { sortAt: T0 + 1000, lastInboundAt: T0 + 1000 }),
    room("b", { sortAt: bSortAt, lastInboundAt: bInboundAt }),
  ];

  test("own send answers the thread: the card leaves All until the next inbound", () => {
    const before = dmCards(rail(T0, T0));
    expect(cardsForChip(before, "all", false).map((c) => c.id).sort()).toEqual(["dm:a", "dm:b"]);
    // The viewer replies in b: sortAt jumps past the inbound — answered, gone from All.
    const afterOwnSend = dmCards(rail(T0 + 9000, T0));
    const cardB = (cards: ReturnType<typeof dmCards>) => cards.find((c) => c.id === "dm:b")!;
    expect(cardB(afterOwnSend).activityAt).toBe(cardB(before).activityAt);
    expect(cardsForChip(afterOwnSend, "all", false).map((c) => c.id)).toEqual(["dm:a"]);
    // The counterpart replies: the card returns, ranked by their message.
    const afterInbound = dmCards(rail(T0 + 9000, T0 + 9000));
    expect(cardB(afterInbound).activityAt).toBe(T0 + 9000);
    expect(sortCards(cardsForChip(afterInbound, "all", false)).map((c) => c.id)).toEqual(["dm:b", "dm:a"]);
  });

  test("the shown time is the inbound time, not the own-send time", () => {
    const [card] = dmCards([room("b", { sortAt: T0 + 9000, lastInboundAt: T0 })]);
    expect(card.activityAt).toBe(T0);
    expect(card.browseOnly).toBe(true);
  });

  test("the DMs chip retires an answered room too", () => {
    const cards = dmCards(rail(T0 + 9000, T0));
    expect(cardsForChip(cards, "dm", false).map((c) => c.id)).toEqual(["dm:a"]);
  });
});

describe("open map", () => {
  test("a user collapse holds across the viewer's own send, expires on inbound", () => {
    const at = (inboundAt: number) => dmCards([room("b", { sortAt: inboundAt, lastInboundAt: inboundAt, unreadCount: 1 })])[0];
    const card = at(T0);
    const collapsed = toggledOpenEntry(card, defaultOpenEntry(card));
    expect(collapsed.expanded).toBe(false);
    // The viewer replies: sortAt moves, activityAt does not — the collapse stands.
    const afterOwnSend = dmCards([room("b", { sortAt: T0 + 5000, lastInboundAt: T0, unreadCount: 1 })])[0];
    expect(openEntryExpired(afterOwnSend, collapsed)).toBe(false);
    expect(resolveOpenEntry(afterOwnSend, collapsed, false)).toBe(collapsed);
    // The counterpart speaks again: newer unread re-earns the default-open.
    const afterInbound = at(T0 + 8000);
    expect(openEntryExpired(afterInbound, collapsed)).toBe(true);
    expect(resolveOpenEntry(afterInbound, collapsed, false).expanded).toBe(true);
  });
});

describe("counts", () => {
  test("a browse-only room never ticks the All badge; muting still zeroes unread", () => {
    const counts = unreadByChip(
      dmCards([
        room("quiet", { unreadCount: 1 }), // no inbound: whatever the count says, not in All
        room("live", { unreadCount: 2, lastInboundAt: T0 }),
        room("hushed", { unreadCount: 3, muted: true, lastInboundAt: T0 }),
        // Answered elsewhere but the count is stale: presence keys to the
        // reply, so neither the DMs chip nor the All badge counts it.
        room("answered", { unreadCount: 1, sortAt: T0 + 5000, lastInboundAt: T0 }),
      ]),
    );
    expect(counts.all).toBe(1);
    expect(counts.dm).toBe(1);
  });
});
