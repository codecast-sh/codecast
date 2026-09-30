import { describe, expect, test } from "bun:test";
import {
  cardsForChip,
  dmCards,
  sortCards,
  unreadByChip,
} from "./threadCards";
import type { ChatRailChannel } from "../store/chatSlice";

// DM cards on /threads: rank keys to the counterpart's last message
// (lastInboundAt), so the viewer's own send never re-ranks a room, and a room
// where the viewer spoke last carries no unread.

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

describe("rank and timestamp", () => {
  const rail = (bSortAt: number, bInboundAt: number) => [
    room("a", { sortAt: T0 + 1000, lastInboundAt: T0 + 1000 }),
    room("b", { sortAt: bSortAt, lastInboundAt: bInboundAt }),
  ];

  test("every room is listed, including one the counterpart never spoke in", () => {
    const cards = dmCards([room("quiet", { sortAt: T0 + 5000 }), room("live", { sortAt: T0, lastInboundAt: T0 })]);
    expect(cardsForChip(cards, "dm", false).map((c) => c.id).sort()).toEqual(["dm:live", "dm:quiet"]);
  });

  test("an own send leaves the room's rank alone; the next inbound moves it", () => {
    const cardB = (cards: ReturnType<typeof dmCards>) => cards.find((c) => c.id === "dm:b")!;
    const before = dmCards(rail(T0, T0));
    const afterOwnSend = dmCards(rail(T0 + 9000, T0));
    expect(cardB(afterOwnSend).activityAt).toBe(cardB(before).activityAt);
    const afterInbound = dmCards(rail(T0 + 9000, T0 + 9000));
    expect(cardB(afterInbound).activityAt).toBe(T0 + 9000);
    expect(sortCards(cardsForChip(afterInbound, "all", false)).map((c) => c.id)).toEqual(["dm:b", "dm:a"]);
  });
});

describe("activity", () => {
  test("the viewer's own send does not move a room's activity; the counterpart's does", () => {
    const at = (inboundAt: number) => dmCards([room("b", { sortAt: inboundAt, lastInboundAt: inboundAt, unreadCount: 1 })])[0];
    const card = at(T0);
    // The viewer replies: sortAt moves, activityAt does not — the row keeps its rank.
    const afterOwnSend = dmCards([room("b", { sortAt: T0 + 5000, lastInboundAt: T0, unreadCount: 1 })])[0];
    expect(afterOwnSend.activityAt).toBe(card.activityAt);
    // The counterpart speaks again: the row moves up.
    expect(at(T0 + 8000).activityAt).toBe(T0 + 8000);
  });
});

describe("counts", () => {
  test("a room nothing awaits in never ticks the All badge; muting still zeroes unread", () => {
    const counts = unreadByChip(
      dmCards([
        room("quiet", { unreadCount: 1 }), // no inbound: whatever the count says, nothing awaits
        room("live", { unreadCount: 2, lastInboundAt: T0 }),
        room("hushed", { unreadCount: 3, muted: true, lastInboundAt: T0 }),
        // Answered elsewhere but the count is stale: neither the DMs chip
        // nor the All badge counts it.
        room("answered", { unreadCount: 1, sortAt: T0 + 5000, lastInboundAt: T0 }),
      ]),
    );
    expect(counts.all).toBe(1);
    expect(counts.dm).toBe(1);
  });
});
