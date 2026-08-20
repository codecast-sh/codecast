import { describe, expect, test } from "bun:test";
import { getMoreMessages } from "./conversations";
import { makeFakeDb } from "./testDb";

// Regression for the owner-definition drift (audit F20): message paging,
// export, fork and tree endpoints gated on `conversation.user_id === viewer`
// with a team fallback, so a SECONDARY session owner (a session_owners row —
// assigned to steer, not the primary owner, not a teammate) could open the
// conversation via checkConversationAccess but got null from getMoreMessages
// and friends. The gate is now the shared canOwnerOrTeamAccess, which uses the
// canonical owner definition. getMoreMessages stands in for all swapped sites.

const CONV = "conversations_1";

function fixture() {
  return makeFakeDb({
    conversations: [{
      _id: CONV,
      user_id: "users_primary",
      is_private: true,
      title: "Private session",
      status: "active",
    }],
    session_owners: [{
      _id: "session_owners_1",
      conversation_id: CONV,
      user_id: "users_second",
      added_by: "users_primary",
      added_at: 1,
    }],
    team_memberships: [],
    messages: [
      { _id: "messages_1", conversation_id: CONV, timestamp: 10, role: "user", content: "hi" },
      { _id: "messages_2", conversation_id: CONV, timestamp: 20, role: "assistant", content: "hello" },
    ],
  });
}

const ctxAs = (db: any, userId: string) => ({
  db,
  auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) },
});

describe("getMoreMessages — secondary session owner reads like an owner", () => {
  test("THE BUG: a session_owners-only viewer gets the page, not null", async () => {
    const result = await (getMoreMessages as any)._handler(
      ctxAs(fixture(), "users_second"),
      { conversation_id: CONV, cursor: 0 },
    );
    expect(result).not.toBeNull();
    expect(result.messages.map((m: any) => m._id)).toEqual(["messages_1", "messages_2"]);
  });

  test("the primary owner still gets the page", async () => {
    const result = await (getMoreMessages as any)._handler(
      ctxAs(fixture(), "users_primary"),
      { conversation_id: CONV, cursor: 0 },
    );
    expect(result?.messages.length).toBe(2);
  });

  test("a stranger is still denied", async () => {
    const result = await (getMoreMessages as any)._handler(
      ctxAs(fixture(), "users_stranger"),
      { conversation_id: CONV, cursor: 0 },
    );
    expect(result).toBeNull();
  });
});
