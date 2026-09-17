import { describe, expect, test } from "bun:test";
import { displayNotificationActor, rewriteNotificationMessage } from "./notificationActor";

const bridge = { name: "Union (Slack)", bot_kind: "slack" };
const aivery = { name: "Aivery", avatar_url: "https://a/aivery.png" };

describe("displayNotificationActor", () => {
  test("a snapshot name beats the live user, so a Slack person is not the workspace", () => {
    expect(displayNotificationActor(
      { actor_name: "Aivery", actor_avatar: "https://a/aivery.png" },
      bridge,
    )).toEqual({ name: "Aivery", avatar: "https://a/aivery.png" });
  });

  test("an old row with no snapshot reads the face off the mirrored message", () => {
    expect(displayNotificationActor(
      {},
      bridge,
      { external_author: aivery },
    )).toEqual({ name: "Aivery", avatar: "https://a/aivery.png" });
  });

  test("a mapped teammate is themselves; the message snapshot is ignored", () => {
    expect(displayNotificationActor(
      {},
      { name: "Alice", github_avatar_url: "https://a/alice.png" },
      { external_author: aivery },
    )).toEqual({ name: "Alice", avatar: "https://a/alice.png" });
  });

  test("an anonymous commenter has no user, only the snapshot", () => {
    expect(displayNotificationActor(
      { actor_name: "Guest", actor_avatar: "https://a/g.png" },
      null,
    )).toEqual({ name: "Guest", avatar: "https://a/g.png" });
  });
});

describe("rewriteNotificationMessage", () => {
  test("an old Slack row swaps the workspace prefix for the person", () => {
    expect(rewriteNotificationMessage(
      "Union (Slack) posted in #team: Huddle recap",
      "Aivery",
      "Union (Slack)",
    )).toBe("Aivery posted in #team: Huddle recap");
  });

  test("a message that does not start with the live name is left alone", () => {
    expect(rewriteNotificationMessage(
      "look at this",
      "Aivery",
      "Union (Slack)",
    )).toBe("look at this");
  });
});
