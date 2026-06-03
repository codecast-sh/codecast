import { describe, expect, test } from "bun:test";
import { findConversationBySessionReference, findConversationByAnyRef } from "./conversationSessionLookup";

const createLookupCtx = ({
  conversationsBySessionId = {},
  managedSessionsBySessionId = {},
  conversationsById = {},
  conversationsByShortId = {},
}: {
  conversationsBySessionId?: Record<string, any>;
  managedSessionsBySessionId?: Record<string, any>;
  conversationsById?: Record<string, any>;
  conversationsByShortId?: Record<string, any>;
}) => ({
  db: {
    query(table: string) {
      return {
        withIndex(indexName: string, builder: (query: { eq(fieldName: string, value: string): unknown }) => unknown) {
          let matchedValue = "";
          builder({
            eq(_fieldName: string, value: string) {
              matchedValue = value;
              return value;
            },
          });

          const single = () => {
            if (table === "conversations" && indexName === "by_session_id") {
              return conversationsBySessionId[matchedValue] ?? null;
            }
            if (table === "managed_sessions" && indexName === "by_session_id") {
              return managedSessionsBySessionId[matchedValue] ?? null;
            }
            return null;
          };
          // by_short_id can be a single conversation or an array (collision case).
          const shortIdMatches = () => {
            const v = conversationsByShortId[matchedValue];
            if (!v) return [];
            return Array.isArray(v) ? v : [v];
          };
          return {
            async first() {
              if (table === "conversations" && indexName === "by_short_id") {
                return shortIdMatches()[0] ?? null;
              }
              return single();
            },
            async take(_n: number) {
              if (table === "conversations" && indexName === "by_short_id") {
                return shortIdMatches();
              }
              const one = single();
              return one ? [one] : [];
            },
          };
        },
      };
    },
    async get(id: string) {
      return conversationsById[id] ?? null;
    },
  },
});

describe("findConversationBySessionReference", () => {
  test("returns the direct conversation match when the session id is current", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "session-1" };
    const result = await findConversationBySessionReference(
      createLookupCtx({ conversationsBySessionId: { "session-1": conversation } }),
      "session-1",
      "user-1"
    );

    expect(result).toEqual(conversation);
  });

  test("falls back through managed_sessions when the conversation session id is stale", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "old-session" };
    const result = await findConversationBySessionReference(
      createLookupCtx({
        managedSessionsBySessionId: {
          "new-session": { _id: "managed-1", user_id: "user-1", conversation_id: "conv-1" },
        },
        conversationsById: { "conv-1": conversation },
      }),
      "new-session",
      "user-1"
    );

    expect(result).toEqual(conversation);
  });

  test("ignores managed session matches for a different user", async () => {
    const result = await findConversationBySessionReference(
      createLookupCtx({
        managedSessionsBySessionId: {
          "new-session": { _id: "managed-1", user_id: "user-2", conversation_id: "conv-1" },
        },
        conversationsById: {
          "conv-1": { _id: "conv-1", user_id: "user-2", session_id: "old-session" },
        },
      }),
      "new-session",
      "user-1"
    );

    expect(result).toBeNull();
  });
});

describe("findConversationByAnyRef", () => {
  test("resolves a short_id (what users type for `cast send`)", async () => {
    const conversation = { _id: "jx7c6zkfull", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsByShortId: { "jx7c6zk": conversation } }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("truncates a long paste to the 7-char short_id", async () => {
    const conversation = { _id: "jx7c6zkfull", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsByShortId: { "jx7c6zk": conversation } }),
      "jx7c6zkfull0000",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("falls back to a Claude session_id (what detectCurrentSessionId returns for --from)", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "uuid-session" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsBySessionId: { "uuid-session": conversation } }),
      "uuid-session",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("falls back to a direct conversation _id", async () => {
    const conversation = { _id: "conv-direct", user_id: "user-1" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsById: { "conv-direct": conversation } }),
      "conv-direct",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("refuses a short_id belonging to another user (no cross-user messaging)", async () => {
    const result = await findConversationByAnyRef(
      createLookupCtx({
        conversationsByShortId: { "jx7c6zk": { _id: "x", user_id: "user-2", short_id: "jx7c6zk" } },
      }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toBeNull();
  });

  test("picks the user's own conversation when a short_id collides across users", async () => {
    // Real-world case: two conversations share the 7-char prefix, the other
    // user's sorts first. A bare .first() would grab theirs and fail the owner
    // check — the resolver must scan for the caller's own match.
    const mine = { _id: "jx7c6zkMINE", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({
        conversationsByShortId: {
          "jx7c6zk": [
            { _id: "jx7c6zkOTHER", user_id: "user-2", short_id: "jx7c6zk" },
            mine,
          ],
        },
      }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toEqual(mine);
  });

  test("returns null for an empty ref", async () => {
    const result = await findConversationByAnyRef(createLookupCtx({}), "  ", "user-1");
    expect(result).toBeNull();
  });
});
