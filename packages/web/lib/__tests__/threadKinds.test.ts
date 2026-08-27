import { describe, expect, it } from "bun:test";
import {
  cardsForChip,
  chipFromSearch,
  dmCards,
  frozenReadAtOf,
  serverCards,
  questionCards,
  sessionCards,
  sessionUnread,
  sortCards,
  unreadByChip,
  visibleChips,
} from "../threadCards";
import { threadRowId, type ThreadInboxRow } from "../../store/threadTypes";

// The Threads page's card rules, tested on the React-free half of the kind
// registry (lib/threadCards): which chip a card files under, how each source
// becomes a card, the session unread rule, the chip filter and its counts,
// and how ?type= resolves.

function row(kind: ThreadInboxRow["kind"], rootKey: string, over: Partial<ThreadInboxRow> = {}): ThreadInboxRow {
  return {
    _id: threadRowId(kind, rootKey),
    kind,
    root_key: rootKey,
    team_id: "t1",
    last_activity_at: 100,
    last_read_at: 50,
    updated_at: 100,
    unread: 0,
    ...over,
  };
}

const railChannel = (over: Record<string, unknown>) =>
  ({
    id: "c1",
    name: "dm",
    kind: "dm",
    sortAt: 10,
    notifyLevel: "all",
    joined: true,
    unreadCount: 0,
    ...over,
  }) as any;

const session = (over: Record<string, unknown>) =>
  ({ _id: "s1", session_id: "s1", agent_type: "claude_code", updated_at: 5, message_count: 3, is_idle: true, has_pending: false, ...over }) as any;

describe("chipFromSearch", () => {
  it("maps known types, falls back to all on unknown, hides chat chips when chat is off", () => {
    expect(chipFromSearch(null, true)).toBe("all");
    expect(chipFromSearch("chat", true)).toBe("chat");
    expect(chipFromSearch("dm", true)).toBe("dm");
    expect(chipFromSearch("comment", true)).toBe("comment");
    expect(chipFromSearch("task", true)).toBe("task");
    expect(chipFromSearch("bogus", true)).toBe("all");
    expect(chipFromSearch("chat", false)).toBe("all");
    expect(chipFromSearch("dm", false)).toBe("all");
    expect(chipFromSearch("task", false)).toBe("task");
  });

  it("hides the Chat and DMs chips when chat is off", () => {
    expect(visibleChips(true).map((c) => c.key)).toEqual(["all", "chat", "dm", "comment", "task", "page", "question"]);
    expect(visibleChips(false).map((c) => c.key)).toEqual(["all", "comment", "task", "page", "question"]);
  });

  it("maps the page and question chips regardless of chat", () => {
    expect(chipFromSearch("page", false)).toBe("page");
    expect(chipFromSearch("question", false)).toBe("question");
  });
});

describe("serverCards", () => {
  it("files a chat thread in a DM room under DMs and keeps its chat kind", () => {
    const rows = [
      row("chat", "r1", { channel_id: "room", unread: 2 }),
      row("chat", "r2", { channel_id: "dmroom", unread: 1 }),
    ];
    const cards = serverCards(rows, (id) => (id === "dmroom" ? "dm" : "public"), () => undefined);
    expect(cards.map((c) => [c.kind, c.chip])).toEqual([["chat", "chat"], ["chat", "dm"]]);
    expect(cards[0].href).toBe("/chat/room?m=r1");
    expect(cards[0].unread).toBe(2);
  });

  it("links a task card to its short id when cached, else the task id", () => {
    const rows = [row("task", "tid1", { task_id: "tid1" }), row("task", "tid2", { task_id: "tid2" })];
    const cards = serverCards(rows, () => undefined, (id) => (id === "tid1" ? "ct-7" : undefined));
    expect(cards[0].href).toBe("/tasks/ct-7");
    expect(cards[1].href).toBe("/tasks/tid2");
    expect(cards[0].chip).toBe("task");
  });

  it("links a comment card to its conversation", () => {
    const cards = serverCards([row("comment", "conv1:msg:m1", { conversation_id: "conv1", message_id: "m1" })], () => undefined, () => undefined);
    expect(cards[0].href).toBe("/conversation/conv1");
    expect(cards[0].chip).toBe("comment");
  });
});

describe("dmCards", () => {
  it("takes only DM rooms, zeroes unread when muted, keys activity to inbound", () => {
    const rail = [
      railChannel({ id: "a", kind: "dm", unreadCount: 3, sortAt: 10, lastInboundAt: 8 }),
      railChannel({ id: "b", kind: "public", unreadCount: 9, sortAt: 99 }),
      railChannel({ id: "c", kind: "dm", unreadCount: 4, muted: true, sortAt: 20, lastReadAt: 7, lastInboundAt: 20 }),
    ];
    const cards = dmCards(rail);
    expect(cards.map((c) => c.id)).toEqual(["dm:a", "dm:c"]);
    expect(cards.map((c) => c.unread)).toEqual([3, 0]);
    expect(cards.map((c) => c.activityAt)).toEqual([8, 20]);
    expect(cards[0].href).toBe("/chat/a");
    expect(frozenReadAtOf(cards[1])).toBe(7);
  });
});

describe("session cards", () => {
  it("is unread only when opened before and grown since", () => {
    expect(sessionUnread({ message_count: 5 }, undefined)).toBe(0);
    expect(sessionUnread({ message_count: 5 }, 5)).toBe(0);
    expect(sessionUnread({ message_count: 5 }, 3)).toBe(1);
  });

  it("derives cards from the inbox rows with the cursor rule", () => {
    const cards = sessionCards(
      [session({ _id: "s1", message_count: 4, updated_at: 50 }), session({ _id: "s2", message_count: 2, updated_at: 60 })],
      { s1: 2 },
    );
    expect(cards.map((c) => [c.id, c.unread, c.activityAt])).toEqual([["session:s1", 1, 50], ["session:s2", 0, 60]]);
    expect(cards[0].href).toBe("/conversation/s1");
    expect(cards[0].kind).toBe("session");
    expect(cards[0].chip).toBe("session");
  });
});

describe("chip filtering and counts", () => {
  const cards = [
    ...serverCards(
      [
        row("chat", "r1", { channel_id: "room", unread: 1, last_activity_at: 40 }),
        row("chat", "r2", { channel_id: "dmroom", unread: 1, last_activity_at: 30 }),
        row("comment", "conv:global", { conversation_id: "conv", unread: 0, last_activity_at: 20 }),
        row("task", "t1", { task_id: "t1", unread: 3, last_activity_at: 10 }),
      ],
      (id) => (id === "dmroom" ? "dm" : "public"),
      () => undefined,
    ),
    ...dmCards([railChannel({ id: "d1", unreadCount: 2, sortAt: 35, lastInboundAt: 35 })]),
    ...sessionCards([session({ _id: "s1", message_count: 4, updated_at: 50 })], { s1: 1 }),
  ];

  it("shows sessions only under All and only when toggled on", () => {
    expect(cardsForChip(cards, "all", false).some((c) => c.kind === "session")).toBe(false);
    expect(cardsForChip(cards, "all", true).some((c) => c.kind === "session")).toBe(true);
    expect(cardsForChip(cards, "chat", true).map((c) => c.id)).toEqual(["chat:r1"]);
    expect(cardsForChip(cards, "dm", true).map((c) => c.id).sort()).toEqual(["chat:r2", "dm:d1"]);
    expect(cardsForChip(cards, "comment", true).map((c) => c.id)).toEqual(["comment:conv:global"]);
    expect(cardsForChip(cards, "task", true).map((c) => c.id)).toEqual(["task:t1"]);
  });

  it("sorts newest activity first across sources", () => {
    expect(sortCards(cardsForChip(cards, "all", true)).map((c) => c.id)).toEqual([
      "session:s1", "chat:r1", "dm:d1", "chat:r2", "comment:conv:global", "task:t1",
    ]);
  });

  it("counts unread cards per chip and never counts sessions", () => {
    expect(unreadByChip(cards)).toEqual({ all: 4, chat: 1, dm: 2, comment: 0, task: 1, page: 0, question: 0 });
  });
});


describe("page and question kinds", () => {
  it("links a page card to its published slug when cached, and skips unknown kinds", () => {
    const rows = [
      { _id: "page:a1", kind: "page", root_key: "a1", last_activity_at: 9, last_read_at: 0, updated_at: 9, unread: 1 },
      { _id: "mystery:x", kind: "mystery", root_key: "x", last_activity_at: 8, last_read_at: 0, updated_at: 8, unread: 1 },
    ] as any[];
    const cards = serverCards(rows, () => undefined, () => undefined, (id) => (id === "a1" ? "my-page" : undefined));
    expect(cards.length).toBe(1);
    expect(cards[0].kind).toBe("page");
    expect(cards[0].chip).toBe("page");
    expect(cards[0].href).toBe("/a/my-page");
  });

  it("makes cards only from pending decisions, always unread", () => {
    const cards = questionCards([
      { _id: "d1", conversation_id: "c1", session_id: "s1", question: "Q?", options: [], blocking: true, status: "pending", created_at: 7 },
      { _id: "d2", conversation_id: "c1", session_id: "s1", question: "Q2?", options: [], blocking: false, status: "answered", created_at: 8 },
      { _id: "d3", conversation_id: "c1", session_id: "s1", question: "Q3?", options: [], blocking: false, status: "dismissed", created_at: 9 },
    ] as any);
    expect(cards.map((c) => c.id)).toEqual(["question:d1"]);
    expect(cards[0].unread).toBe(1);
    expect(cards[0].chip).toBe("question");
  });

  it("questions count on their chip but never in the default view number", () => {
    const cards = questionCards([
      { _id: "d1", conversation_id: "c1", session_id: "s1", question: "Q?", options: [], blocking: true, status: "pending", created_at: 7 },
    ] as any);
    const counts = unreadByChip(cards);
    expect(counts.question).toBe(1);
    expect(counts.all).toBe(0);
  });
});
