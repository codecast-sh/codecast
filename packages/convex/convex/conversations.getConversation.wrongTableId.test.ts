// getConversation's conversation_id arrives raw from the inbox `?s=` deep-link
// param. The client's isConvexId guard is format-only, so a 32-char id from
// another table (a MESSAGE id was seen in prod) used to hit the
// v.id("conversations") validator and throw an ArgumentValidationError into the
// subscribing component's render, crashing the inbox into its ErrorBoundary.
// The arg is now v.string + normalizeId: a wrong-table id resolves to null,
// the same shape as not-found, and the inbox shows its "unavailable" note.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  getConversation,
  getConversationWithMeta,
  getMessagesAroundTimestamp,
  getNewMessages,
  getTranscriptWatermark,
  getUserMessages,
  listMessages,
  listMessagesTail,
} from "./conversations";

const OWNER = "u_owner";

function tables(): Record<string, any[]> {
  return {
    users: [{ _id: OWNER, name: "Owner" }],
    conversations: [
      {
        _id: "conv",
        user_id: OWNER,
        is_private: true,
        title: "My session",
        message_count: 1,
      },
    ],
    messages: [
      { _id: "msg", conversation_id: "conv", role: "user", content: "hi", timestamp: 1 },
    ],
  };
}

function ctx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
  } as any;
}

const run = (uid: string | null, t: Record<string, any[]>, conversationId: string) =>
  (getConversation as any)._handler(ctx(uid, t), { conversation_id: conversationId, limit: 1 });

describe("getConversation with a non-conversation id", () => {
  test("a message id returns null instead of throwing", async () => {
    const result = await run(OWNER, tables(), "msg");
    expect(result).toBeNull();
  });

  test("a garbage string returns null instead of throwing", async () => {
    const result = await run(OWNER, tables(), "k176a75w125a0hjktcdp31ec718dfv84");
    expect(result).toBeNull();
  });

  test("a real conversation id still resolves for its owner", async () => {
    const result = await run(OWNER, tables(), "conv");
    expect(result).not.toBeNull();
    expect(result.title).toBe("My session");
  });
});

// Every read the transcript hook subscribes to with the same raw id. The
// deep-link prewarm mounts that hook on an unverified `?s=` target, so one
// v.id validator among them was enough to crash the inbox.
describe("transcript reads with a message id", () => {
  const cases: [string, any, Record<string, unknown>, unknown][] = [
    ["getTranscriptWatermark", getTranscriptWatermark, {}, null],
    ["getConversationWithMeta", getConversationWithMeta, {}, null],
    ["listMessagesTail", listMessagesTail, { after_timestamp: 0 }, null],
    ["getNewMessages", getNewMessages, { after_timestamp: 0 }, null],
    ["getMessagesAroundTimestamp", getMessagesAroundTimestamp, { center_timestamp: 1 }, null],
    ["getUserMessages", getUserMessages, {}, []],
    ["listMessages", listMessages, { paginationOpts: { numItems: 10, cursor: null } }, { page: [], isDone: true, continueCursor: "" }],
  ];
  for (const [name, fn, extra, empty] of cases) {
    // The fake db runs no validators; a v.id("conversations") arg is what
    // threw in prod, so the exported schema is the regression check.
    test(`${name} accepts any string as conversation_id`, () => {
      const args = JSON.parse(fn.exportArgs());
      expect(args.value.conversation_id.fieldType).toEqual({ type: "string" });
    });

    test(`${name} reads a message id as not found`, async () => {
      const result = await fn._handler(ctx(OWNER, tables()), { conversation_id: "msg", ...extra });
      expect(result).toEqual(empty);
    });
  }

  test("the watermark still resolves a real conversation", async () => {
    const result = await (getTranscriptWatermark as any)._handler(ctx(OWNER, tables()), { conversation_id: "conv" });
    expect(result).toEqual({ message_count: 1, transcript_revision: 0 });
  });
});
