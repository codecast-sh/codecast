import { describe, expect, test } from "bun:test";
import {
  conversationForAccess,
  getConversationPublic,
  getConversationWithMeta,
} from "./conversations";
import { makeFakeDb } from "./testDb";

const CONVERSATION_ID = "conversations_shared";
const USER_ID = "users_owner";
const STABLE_CONTEXT = JSON.stringify({
  mode: "team",
  injected_at: 1,
  items: [{
    id: "conversations_unrelated",
    title: "Private roadmap",
    project_path: "/Users/owner/company/private-roadmap",
    user_name: "Teammate",
  }],
});

function sharedFixture() {
  return makeFakeDb({
    conversations: [{
      _id: CONVERSATION_ID,
      user_id: USER_ID,
      is_private: true,
      share_token: "public-token",
      title: "Shared session",
      status: "active",
      message_count: 0,
      started_at: 1,
      updated_at: 1,
      stable_context: STABLE_CONTEXT,
    }],
    users: [{
      _id: USER_ID,
      name: "Owner",
      email: "owner@example.com",
    }],
    messages: [],
    session_owners: [],
  });
}

const anonymousCtx = (db: ReturnType<typeof makeFakeDb>) => ({
  db,
  auth: { getUserIdentity: async () => null },
});

describe("stable-context share privacy", () => {
  test("getConversationWithMeta strips the owner's feed snapshot for shared access", async () => {
    const result = await (getConversationWithMeta as any)._handler(
      anonymousCtx(sharedFixture()),
      { conversation_id: CONVERSATION_ID, share_token: "public-token" },
    );

    expect(result?.title).toBe("Shared session");
    expect(result?.stable_context).toBeUndefined();
  });

  test("getConversationPublic strips the owner's feed snapshot for an anonymous viewer", async () => {
    const result = await (getConversationPublic as any)._handler(
      anonymousCtx(sharedFixture()),
      { conversation_id: CONVERSATION_ID, limit: 20, share_token: "public-token" },
    );

    expect(result?.access_level).toBe("shared");
    expect(result?.conversation?.title).toBe("Shared session");
    expect(result?.conversation?.stable_context).toBeUndefined();
  });

  test("owner and team responses retain stable context", () => {
    const conversation = {
      _id: CONVERSATION_ID,
      stable_context: STABLE_CONTEXT,
    };
    expect(conversationForAccess(conversation, "owner").stable_context).toBe(STABLE_CONTEXT);
    expect(conversationForAccess(conversation, "team").stable_context).toBe(STABLE_CONTEXT);
  });
});
