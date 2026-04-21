import { describe, expect, test } from "bun:test";
import { findConversationBySessionReference } from "./conversationSessionLookup";

const createLookupCtx = ({
  conversationsBySessionId = {},
  managedSessionsBySessionId = {},
  conversationsById = {},
}: {
  conversationsBySessionId?: Record<string, any>;
  managedSessionsBySessionId?: Record<string, any>;
  conversationsById?: Record<string, any>;
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

          return {
            async first() {
              if (table === "conversations" && indexName === "by_session_id") {
                return conversationsBySessionId[matchedValue] ?? null;
              }
              if (table === "managed_sessions" && indexName === "by_session_id") {
                return managedSessionsBySessionId[matchedValue] ?? null;
              }
              return null;
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
