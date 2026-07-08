import { describe, expect, test } from "bun:test";
import {
  mergeUserMessageFeed,
  type FeedCandidate,
  type FeedRawMessage,
} from "./messageFeed";

// In-memory message store keyed by conversation. Each entry is a user message
// with a timestamp; `content` defaults to real prose so it survives the filter.
type StoreMsg = { _id: string; timestamp: number; content?: string };
type Store = Record<string, { updated_at: number; isOwn?: boolean; author?: string; msgs: StoreMsg[] }>;

function buildCandidates(store: Store): FeedCandidate[] {
  return Object.entries(store).map(([convId, c]) => ({
    conversation_id: convId,
    updated_at: c.updated_at,
    title: `${convId}-title`,
    session_id: `${convId}-sess`,
    isOwn: c.isOwn ?? true,
    authorName: c.author ?? "me",
  }));
}

// Returns the real fetcher plus a call counter so tests can assert the
// early-exit actually skips conversations.
function makeFetcher(store: Store) {
  let calls = 0;
  const fetchUserMessages = async (
    convId: string,
    cursor: number | undefined,
    take: number
  ): Promise<FeedRawMessage[]> => {
    calls++;
    const rows = (store[convId]?.msgs ?? [])
      .filter((m) => cursor === undefined || m.timestamp < cursor)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, take);
    return rows.map((m) => ({
      _id: m._id,
      conversation_id: convId,
      role: "user",
      content: m.content ?? `real prompt ${m._id}`,
      timestamp: m.timestamp,
    }));
  };
  return { fetchUserMessages, calls: () => calls };
}

// Ground truth: every meaningful user message, newest first.
function oracle(store: Store): { _id: string; timestamp: number }[] {
  const all: { _id: string; timestamp: number }[] = [];
  for (const c of Object.values(store)) {
    for (const m of c.msgs) {
      const content = m.content ?? `real prompt ${m._id}`;
      if (content.trim().length > 10) all.push({ _id: m._id, timestamp: m.timestamp });
    }
  }
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

// Page through the whole feed; assert no dupes and a monotonically advancing
// cursor, then return the flattened id sequence.
async function drain(store: Store, limit: number): Promise<string[]> {
  const candidates = buildCandidates(store);
  const seen = new Set<string>();
  const order: string[] = [];
  let cursor: number | undefined = undefined;
  for (let page = 0; page < 100; page++) {
    const { fetchUserMessages } = makeFetcher(store);
    const res = await mergeUserMessageFeed({ candidates, cursor, limit, fetchUserMessages });
    for (const m of res.messages) {
      expect(seen.has(m._id)).toBe(false); // no duplicates across pages
      seen.add(m._id);
      order.push(m._id);
    }
    if (res.nextCursor == null) break;
    expect(res.nextCursor).toBeLessThan(cursor ?? Infinity); // strictly advances
    cursor = res.nextCursor;
  }
  return order;
}

describe("mergeUserMessageFeed", () => {
  test("merges newest-first across conversations", async () => {
    const store: Store = {
      a: { updated_at: 300, msgs: [{ _id: "a1", timestamp: 300 }, { _id: "a2", timestamp: 100 }] },
      b: { updated_at: 250, msgs: [{ _id: "b1", timestamp: 250 }, { _id: "b2", timestamp: 50 }] },
    };
    const { fetchUserMessages } = makeFetcher(store);
    const res = await mergeUserMessageFeed({
      candidates: buildCandidates(store),
      cursor: undefined,
      limit: 10,
      fetchUserMessages,
    });
    expect(res.messages.map((m) => m._id)).toEqual(["a1", "b1", "a2", "b2"]);
    expect(res.nextCursor).toBeNull();
  });

  test("paginates to exactly the oracle order with no gaps or dupes", async () => {
    const store: Store = {
      a: { updated_at: 1000, msgs: [10, 90, 80, 5].map((t) => ({ _id: `a${t}`, timestamp: t })) },
      b: { updated_at: 95, msgs: [95, 85, 70, 1].map((t) => ({ _id: `b${t}`, timestamp: t })) },
      c: { updated_at: 999, msgs: [999, 60].map((t) => ({ _id: `c${t}`, timestamp: t })) },
    };
    const expected = oracle(store).map((m) => m._id);
    for (const limit of [1, 2, 3, 5]) {
      expect(await drain(store, limit)).toEqual(expected);
    }
  });

  test("an always-active conversation still yields its OLD messages on deep pages", async () => {
    // `a` has a high updated_at (recently bumped) but its messages are old; it
    // must keep contributing as the cursor walks past `b`'s newer messages.
    const store: Store = {
      a: { updated_at: 10_000, msgs: [100, 90, 80].map((t) => ({ _id: `a${t}`, timestamp: t })) },
      b: { updated_at: 95, msgs: [95, 85].map((t) => ({ _id: `b${t}`, timestamp: t })) },
    };
    expect(await drain(store, 2)).toEqual(["a100", "b95", "a90", "b85", "a80"]);
  });

  test("drops messages with thin (<=10 char) content", async () => {
    const store: Store = {
      a: {
        updated_at: 300,
        msgs: [
          { _id: "real", timestamp: 300, content: "a genuine question here" },
          { _id: "thin", timestamp: 200, content: "ok" },
          { _id: "blank", timestamp: 100, content: "   " },
        ],
      },
    };
    const { fetchUserMessages } = makeFetcher(store);
    const res = await mergeUserMessageFeed({
      candidates: buildCandidates(store),
      cursor: undefined,
      limit: 10,
      fetchUserMessages,
    });
    expect(res.messages.map((m) => m._id)).toEqual(["real"]);
  });

  test("early-exit: once the page is full, older conversations are never fetched", async () => {
    // One busy recent conversation fills the page; 50 stale ones must be skipped.
    const store: Store = {
      hot: { updated_at: 5000, msgs: [5000, 4999, 4998, 4997].map((t) => ({ _id: `h${t}`, timestamp: t })) },
    };
    for (let i = 0; i < 50; i++) {
      store[`cold${i}`] = { updated_at: 100 + i, msgs: [{ _id: `c${i}`, timestamp: 100 + i }] };
    }
    const { fetchUserMessages, calls } = makeFetcher(store);
    const res = await mergeUserMessageFeed({
      candidates: buildCandidates(store),
      cursor: undefined,
      limit: 2,
      fetchUserMessages,
    });
    expect(res.messages.map((m) => m._id)).toEqual(["h5000", "h4999"]);
    expect(res.nextCursor).toBe(4999);
    expect(calls()).toBe(1); // only the hot conversation was read
  });

  test("carries per-conversation projection (title, session, author, is_own)", async () => {
    const store: Store = {
      mine: { updated_at: 300, isOwn: true, author: "me", msgs: [{ _id: "m1", timestamp: 300 }] },
      theirs: { updated_at: 250, isOwn: false, author: "sam", msgs: [{ _id: "t1", timestamp: 250 }] },
    };
    const { fetchUserMessages } = makeFetcher(store);
    const res = await mergeUserMessageFeed({
      candidates: buildCandidates(store),
      cursor: undefined,
      limit: 10,
      fetchUserMessages,
    });
    const m1 = res.messages.find((m) => m._id === "m1")!;
    const t1 = res.messages.find((m) => m._id === "t1")!;
    expect(m1.is_own).toBe(true);
    expect(m1.author_name).toBe("me");
    expect(m1.conversation_title).toBe("mine-title");
    expect(m1.conversation_session_id).toBe("mine-sess");
    expect(t1.is_own).toBe(false);
    expect(t1.author_name).toBe("sam");
  });

  test("empty candidate set returns an empty page", async () => {
    const { fetchUserMessages } = makeFetcher({});
    const res = await mergeUserMessageFeed({
      candidates: [],
      cursor: undefined,
      limit: 10,
      fetchUserMessages,
    });
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });
});
