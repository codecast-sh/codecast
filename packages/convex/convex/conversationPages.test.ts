import { describe, expect, test } from "bun:test";
import { list as conversationPages } from "./conversationPages";
import { makeFakeDb } from "./testDb";

describe("conversationPages", () => {
  const setup = (viewer: string) => {
    const db = makeFakeDb({
      users: [{ _id: "owner" }, { _id: "stranger" }],
      conversations: [
        { _id: "conversation", user_id: "owner", is_private: true, agent_type: "claude_code", updated_at: 1, status: "active" },
        { _id: "other", user_id: "owner", is_private: true, agent_type: "claude_code", updated_at: 1, status: "active" },
      ],
      artifacts: [
        { _id: "a2", slug: "second", user_id: "owner", session_conversation_id: "conversation", created_at: 20 },
        { _id: "a1", slug: "first", user_id: "owner", session_conversation_id: "conversation", created_at: 10 },
        { _id: "a3", slug: "elsewhere", user_id: "owner", session_conversation_id: "other", created_at: 15 },
        { _id: "a4", slug: "unbound", user_id: "owner", created_at: 5 },
      ],
    });
    const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${viewer}|session` }) } };
    return () => (conversationPages as any)._handler(ctx, { conversation_id: "conversation" });
  };

  test("lists the pages this conversation published, oldest first, keyed by the conversation", async () => {
    expect(await setup("owner")()).toEqual({
      _id: "conversation",
      pages: [{ slug: "first", created_at: 10 }, { slug: "second", created_at: 20 }],
    });
  });

  test("a viewer who cannot read the conversation gets none of its pages", async () => {
    expect(await setup("stranger")()).toEqual({ _id: "conversation", pages: [] });
  });
});
