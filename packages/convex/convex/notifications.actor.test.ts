import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { list } from "./notifications";

const ADA = "user-ada";
const BRIDGE = "user-bridge";
const MSG = "chat_messages_1";

function ctx() {
  const db = makeFakeDb({
    users: [
      { _id: ADA, name: "Ada", email: "ada@example.test" },
      { _id: BRIDGE, name: "Union (Slack)", is_bot: true, bot_kind: "slack" },
    ],
    notifications: [{
      _id: "notifications_1",
      recipient_user_id: ADA,
      type: "chat_post",
      actor_user_id: BRIDGE,
      entity_type: "chat_channel",
      entity_id: "chan",
      chat_message_id: MSG,
      message: "Union (Slack) posted in #team: Huddle recap",
      read: false,
      created_at: 2,
    }],
    chat_messages: [{
      _id: MSG,
      user_id: BRIDGE,
      content: "Huddle recap",
      external_author: { name: "Aivery", avatar_url: "https://a/aivery.png" },
      created_at: 1,
    }],
  });
  return {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${ADA}|session` }) },
  };
}

describe("notifications.list Slack overlay", () => {
  test("an old bridge-authored row names the Slack person and rewrites the body", async () => {
    const rows = await (list as any)._handler(ctx(), {});
    expect(rows).toHaveLength(1);
    expect(rows[0].actor.name).toBe("Aivery");
    expect(rows[0].actor.github_avatar_url).toBe("https://a/aivery.png");
    expect(rows[0].message).toBe("Aivery posted in #team: Huddle recap");
  });
});
