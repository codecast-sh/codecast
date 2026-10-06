// The page in the URL beats the restored conversation on a cold load: a boot
// at /questions (an approval notification, /welcome's way into the app) must
// not adopt the last focused conversation and move the address bar there.
import { describe, expect, test } from "bun:test";
import { bootLinkTarget } from "../inboxStore";

const sessions = { jx7bj3h: {} };

describe("bootLinkTarget", () => {
  test("a conversation URL lands on that conversation, or nowhere when it is not cached", () => {
    expect(bootLinkTarget(sessions, "/conversation/jx7bj3h")).toBe("jx7bj3h");
    expect(bootLinkTarget(sessions, "/conversation/jx7zzzz")).toBeNull();
  });

  test("the inbox and the app root restore the client's own position", () => {
    expect(bootLinkTarget(sessions, "/inbox")).toBeUndefined();
    expect(bootLinkTarget(sessions, "/")).toBeUndefined();
  });

  test("any other shell page restores nothing, so the page in the URL stays", () => {
    for (const path of ["/questions?zq=r4b", "/triggers", "/tasks", "/docs/"]) {
      expect(bootLinkTarget(sessions, path)).toBeNull();
    }
  });
});
