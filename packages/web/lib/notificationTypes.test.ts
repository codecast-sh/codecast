import { describe, expect, test } from "bun:test";
import { notificationActor } from "./notificationTypes";

describe("notificationActor", () => {
  test("a snapshot name beats the live user", () => {
    expect(notificationActor({
      actor: { name: "Union (Slack)", github_username: "slack" },
      actor_name: "Aivery",
      actor_avatar: "https://a/aivery.png",
    })).toEqual({ name: "Aivery", avatar: "https://a/aivery.png", session: null });
  });

  test("falls back to the live user when there is no snapshot", () => {
    expect(notificationActor({
      actor: { name: "Alice", github_avatar_url: "https://a/alice.png" },
    })).toEqual({ name: "Alice", avatar: "https://a/alice.png", session: null });
  });

  test("a line a session typed is from the session, not its human's photo", () => {
    expect(notificationActor({
      actor: { name: "Build machine unblock", github_avatar_url: "https://a/jason.png" },
      actor_name: "Build machine unblock",
      actor_session: { id: "conv_1", agent_type: "codex" },
    })).toEqual({ name: "Build machine unblock", avatar: undefined, session: { id: "conv_1", agent_type: "codex" } });
  });
});
