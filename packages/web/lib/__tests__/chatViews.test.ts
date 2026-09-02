import { describe, expect, it } from "bun:test";
import {
  railRowTip,
  authorFor,
  buildHandleSets,
  foldReactions,
  memberHandles,
  memberName,
  mentionsViewer,
  threadRollups,
  toMessageView,
  toMessageViews,
  type ChatMember,
} from "../chatViews";
import type { ChatMessageRow, ChatReactionRow } from "../../store/chatSlice";

const ME: ChatMember = { _id: "u1", name: "Ashot", github_username: "Ashot", email: "ashot@codecast.sh" };
const MAYA: ChatMember = { _id: "u2", name: "Maya", email: "maya@codecast.sh" };
const ANCHOR: ChatMember = { _id: "u9", name: "The Anchor", is_bot: true };
const NAMELESS: ChatMember = { _id: "u4", email: "a.b+tag@codecast.sh" };

const byId = new Map<string, ChatMember>([ME, MAYA, ANCHOR, NAMELESS].map((m) => [m._id, m]));

const row = (over: Partial<ChatMessageRow>): ChatMessageRow => ({
  _id: "m1",
  channel_id: "c1",
  user_id: MAYA._id,
  content: "hi",
  created_at: 1000,
  updated_at: 1000,
  ...over,
});

describe("memberHandles", () => {
  it("resolves a person by github handle and email local part, lowercased", () => {
    expect(memberHandles(ME)).toEqual(["ashot"]); // github and email agree — one handle
    expect(memberHandles(MAYA)).toEqual(["maya"]);
    expect(memberHandles({ _id: "u6", github_username: "GH", email: "other@x.com" })).toEqual(["gh", "other"]);
  });

  it("never gives a person a handle from their display name", () => {
    // chat.ts refuses to match humans on `name` — a self-editable field would
    // let anyone rename themselves to intercept a teammate's mentions.
    expect(memberHandles(MAYA)).not.toContain("maya lindqvist");
    expect(memberHandles({ _id: "u5", name: "Ashot" })).toEqual([]);
  });

  it("matches a bot on its slugged display name", () => {
    expect(memberHandles(ANCHOR)).toEqual(["theanchor"]);
  });

  it("skips an email local part that is not handle-shaped", () => {
    expect(memberHandles(NAMELESS)).toEqual([]);
  });
});

describe("buildHandleSets", () => {
  it("knows every member's handle and marks the viewer's own", () => {
    const { known, self } = buildHandleSets([ME, MAYA, ANCHOR], ME._id);
    expect(known.has("ashot")).toBe(true);
    expect(known.has("maya")).toBe(true);
    expect(known.has("theanchor")).toBe(true);
    expect(self.has("ashot")).toBe(true);
    expect(self.has("maya")).toBe(false);
  });

  it("treats @here as addressed to everyone, including the viewer", () => {
    const { known, self } = buildHandleSets([MAYA], ME._id);
    expect(known.has("here")).toBe(true);
    expect(self.has("here")).toBe(true);
  });

  it("leaves an unknown handle out, so a stray @word stays plain text", () => {
    const { known } = buildHandleSets([MAYA], ME._id);
    expect(known.has("nobody")).toBe(false);
  });
});

describe("authorFor", () => {
  it("draws identity from the live roster", () => {
    expect(authorFor(MAYA._id, "user", byId)).toMatchObject({ id: "u2", name: "Maya" });
  });

  it("renders a bot as an agent and never with a photo", () => {
    const a = authorFor(ANCHOR._id, "agent", byId);
    expect(a.isAgent).toBe(true);
    expect(a.avatarUrl).toBeUndefined();
  });

  it("marks a roster bot as an agent even when the row does not say so", () => {
    expect(authorFor(ANCHOR._id, undefined, byId).isAgent).toBe(true);
  });

  it("degrades to a placeholder for a user the roster has not loaded", () => {
    expect(authorFor("u404", "user", byId)).toMatchObject({ id: "u404", name: "Someone" });
    expect(authorFor("u404", "agent", byId)).toMatchObject({ isAgent: true });
  });
});

describe("memberName", () => {
  it("falls back through name, github handle, email", () => {
    expect(memberName(MAYA)).toBe("Maya");
    expect(memberName({ _id: "x", github_username: "gh" })).toBe("gh");
    expect(memberName({ _id: "x", email: "e@x.com" })).toBe("e@x.com");
    expect(memberName(undefined)).toBe("Someone");
  });
});

describe("mentionsViewer", () => {
  it("is true for a direct mention and for @here", () => {
    expect(mentionsViewer(row({ mentions: [ME._id] }), ME._id)).toBe(true);
    expect(mentionsViewer(row({ mention_scope: "here" }), ME._id)).toBe(true);
  });

  it("is false when somebody else was named", () => {
    expect(mentionsViewer(row({ mentions: ["u3"] }), ME._id)).toBe(false);
    expect(mentionsViewer(row({}), ME._id)).toBe(false);
  });
});

describe("threadRollups", () => {
  it("counts replies, tracks the newest, and lists distinct repliers oldest first", () => {
    const rollups = threadRollups([
      row({ _id: "r1", thread_root_id: "m1", user_id: "u2", created_at: 10 }),
      row({ _id: "r2", thread_root_id: "m1", user_id: "u3", created_at: 20 }),
      row({ _id: "r3", thread_root_id: "m1", user_id: "u2", created_at: 30 }),
    ]);
    expect(rollups.get("m1")).toEqual({ replyCount: 3, lastReplyAt: 30, faces: ["u2", "u3"] });
  });

  it("ignores tombstoned replies and messages that are not replies", () => {
    const rollups = threadRollups([
      row({ _id: "r1", thread_root_id: "m1", deleted_at: 5 }),
      row({ _id: "m2" }),
    ]);
    expect(rollups.size).toBe(0);
  });
});

describe("foldReactions", () => {
  it("counts distinct users, so an optimistic stub and its server twin read as one", () => {
    const rows: ChatReactionRow[] = [
      { _id: "stub", message_id: "m1", user_id: "u1", emoji: "👍", created_at: 5 },
      { _id: "real", message_id: "m1", user_id: "u1", emoji: "👍", created_at: 7 },
      { _id: "other", message_id: "m1", user_id: "u2", emoji: "👍", created_at: 9 },
    ];
    const folded = foldReactions(rows, "u1");
    expect(folded).toEqual([{ emoji: "👍", count: 2, mine: true }]);
  });

  it("orders pills by first use and resolves names when asked", () => {
    const rows: ChatReactionRow[] = [
      { _id: "a", message_id: "m1", user_id: "u2", emoji: "🚀", created_at: 20 },
      { _id: "b", message_id: "m1", user_id: "u2", emoji: "🎉", created_at: 10 },
    ];
    const folded = foldReactions(rows, "u1", (id) => memberName(byId.get(id)));
    expect(folded.map((r) => r.emoji)).toEqual(["🎉", "🚀"]);
    expect(folded[0].names).toEqual(["Maya"]);
    expect(folded[0].mine).toBe(false);
  });
});

describe("sessionAuthorFor", () => {
  const base = { members: byId, viewerId: ME._id };
  const sessionRow = () =>
    row({
      _id: "s1",
      user_id: "u2",
      origin: "agent",
      origin_session_id: "sess-1",
      origin_session_title: "Fix the auth race",
      origin_agent_type: "codex",
    } as any);

  it("dresses a session-typed line as the session, crediting the human", () => {
    const view = toMessageView(sessionRow(), base);
    expect(view.author).toMatchObject({
      id: "u2",
      name: "Fix the auth race",
      isAgent: true,
      session: { id: "sess-1", agentType: "codex", via: "Maya" },
    });
    expect(view.author.avatarUrl).toBeUndefined();
  });

  it("prefers the live session title and agent when the viewer can see it", () => {
    const view = toMessageView(sessionRow(), {
      ...base,
      sessionFor: (id) => (id === "sess-1" ? { title: "Auth race (renamed)", agentType: "claude_code" } : undefined),
    });
    expect(view.author.name).toBe("Auth race (renamed)");
    expect(view.author.session?.agentType).toBe("claude_code");
  });

  it("falls back to a generic session name without a snapshot, and never fires without the origin stamp", () => {
    const bare = toMessageView(row({ _id: "s2", user_id: "u2", origin: "agent", origin_session_id: "x" } as any), base);
    expect(bare.author.name).toBe("Agent session");
    expect(bare.author.session?.agentType).toBe("claude_code");
    const human = toMessageView(row({ _id: "s3", user_id: "u2", origin_session_id: "x", origin_session_title: "T" } as any), base);
    expect(human.author.session).toBeUndefined();
    expect(human.author.name).toBe("Maya");
  });
});

describe("toMessageView", () => {
  const ctx = {
    members: byId,
    viewerId: ME._id,
    rollups: threadRollups([row({ _id: "r1", thread_root_id: "m1", user_id: "u2", created_at: 50 })]),
    sendState: (r: ChatMessageRow) => (r._failedAt ? ("failed" as const) : r._id === "stub" ? ("pending" as const) : ("sent" as const)),
    reactionsFor: (id: string) =>
      id === "m1" ? [{ emoji: "👍", count: 1, mine: false }] : undefined,
  };

  it("carries the fields the message row renders", () => {
    const view = toMessageView(row({ _id: "m1", mentions: [ME._id], edited_at: 99 }), ctx);
    expect(view).toMatchObject({
      id: "m1",
      content: "hi",
      createdAt: 1000,
      editedAt: 99,
      mentionsMe: true,
      replyCount: 1,
      lastReplyAt: 50,
      pending: false,
      failed: false,
    });
    expect(view.author.name).toBe("Maya");
    expect(view.reactions).toHaveLength(1);
    expect(view.replyFaces?.[0]).toMatchObject({ id: "u2", name: "Maya" });
  });

  it("marks an optimistic row pending and a given-up row failed", () => {
    expect(toMessageView(row({ _id: "stub" }), ctx).pending).toBe(true);
    expect(toMessageView(row({ _id: "m2", _failedAt: 1 }), ctx).failed).toBe(true);
  });

  it("leaves reactions undefined rather than empty, so the row renders no pill strip", () => {
    expect(toMessageView(row({ _id: "m2" }), ctx).reactions).toBeUndefined();
  });

  it("carries a walkie burst's lifecycle through, renamed to the view's shape", () => {
    const live = toMessageView(
      row({ _id: "m3", voice: { status: "live", room_key: "dm:a:b" } } as any),
      ctx,
    );
    expect(live.voice).toEqual({ status: "live", durationMs: undefined, roomKey: "dm:a:b" });
    const done = toMessageView(
      row({ _id: "m4", voice: { status: "done", duration_ms: 4200 } } as any),
      ctx,
    );
    expect(done.voice).toMatchObject({ status: "done", durationMs: 4200 });
    // An ordinary typed message must stay free of it, or every row in the
    // timeline would take the voice branch.
    expect(toMessageView(row({ _id: "m5" }), ctx).voice).toBeUndefined();
  });

  it("drops a brushed key from the timeline, but keeps one somebody replied to", () => {
    // The server tombstones a canceled burst rather than deleting it, so that
    // watchers holding the live row stop pulsing. That tombstone is a message to
    // the client, not a line in the DM — showing it would put "This message was
    // deleted" on screen every time a hand brushed the key.
    const brushed = row({ _id: "m6", voice: { status: "canceled" }, deleted_at: 5 } as any);
    expect(toMessageViews([brushed], ctx)).toHaveLength(0);
    // "m1" is the root the context's rollups give a reply to: with something
    // hanging off it, the tombstone does an ordinary deleted message's job.
    const answered = row({ _id: "m1", voice: { status: "canceled" }, deleted_at: 5 } as any);
    expect(toMessageViews([answered], ctx)).toHaveLength(1);
    // And an ordinary burst is never dropped.
    expect(toMessageViews([row({ _id: "m7", voice: { status: "done" } } as any)], ctx)).toHaveLength(1);
  });
});

describe("railRowTip", () => {
  const members = [
    { _id: "u_ann", name: "Ann Diaz" },
    { _id: "u_me", name: "Me" },
  ] as any;
  test("a channel: hash name, topic, and the loudest state", () => {
    expect(railRowTip({ id: "c1", name: "team", topic: "Everything", mentionCount: 2, unreadCount: 9 }, members)).toEqual({
      title: "#team",
      detail: "Everything",
      state: "2 mentions",
    });
    expect(railRowTip({ id: "c1", name: "team", unreadCount: 1 }, members)).toEqual({
      title: "#team",
      detail: undefined,
      state: "1 unread",
    });
    expect(railRowTip({ id: "c1", name: "team", mentionCount: 1 }, members).state).toBe("1 mention");
    expect(railRowTip({ id: "c1", name: "team", muted: true }, members).state).toBe("Muted");
    expect(railRowTip({ id: "c1", name: "team" }, members).state).toBeUndefined();
  });
  test("a DM: the person's name, no hash, no topic", () => {
    const tip = railRowTip({ id: "d1", name: "", kind: "dm", dmMemberIds: ["u_ann"], topic: "ignored" }, members);
    expect(tip.title).toBe("Ann Diaz");
    expect(tip.detail).toBeUndefined();
  });
  test("a live huddle outranks every other state", () => {
    expect(railRowTip({ id: "c1", name: "team", mentionCount: 3 }, members, { live: true }).state).toBe("Huddle live");
  });
});
