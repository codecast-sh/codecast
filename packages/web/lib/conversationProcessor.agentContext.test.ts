import { expect, test } from "bun:test";
import { classifyFeedMessage, getConversationPreview, isContextOnlyUserMessage } from "./conversationProcessor";
import { filterUserMessages } from "../../convex/convex/userMessagesFilter";

test("stored Codex setup is hidden from thread, preview, feed and message navigation", () => {
  const content = "<recommended_plugins>\nAvailable plugins\n</recommended_plugins>\n# AGENTS.md instructions for /repo";
  expect(isContextOnlyUserMessage(content)).toBe(true);
  expect(classifyFeedMessage(content)).toEqual({ kind: "hidden" });
  expect(getConversationPreview([{ role: "user", content }], "Review")).toEqual([]);
  expect(filterUserMessages([{ _id: "setup", role: "user", content, timestamp: 1 }])).toEqual([]);
});
