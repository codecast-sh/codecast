import { expect, test } from "bun:test";
import { classifyFeedMessage, getConversationPreview, isContextOnlyUserMessage, initialSubagentPromptId } from "./conversationProcessor";
import { filterUserMessages } from "../../convex/convex/userMessagesFilter";

test("stored Codex setup is hidden from thread, preview, feed and message navigation", () => {
  const content = "<recommended_plugins>\nAvailable plugins\n</recommended_plugins>\n# AGENTS.md instructions for /repo";
  expect(isContextOnlyUserMessage(content)).toBe(true);
  expect(classifyFeedMessage(content)).toEqual({ kind: "hidden" });
  expect(getConversationPreview([{ role: "user", content }], "Review")).toEqual([]);
  expect(filterUserMessages([{ _id: "setup", role: "user", content, timestamp: 1 }])).toEqual([]);
});

test("a linked child's initial brief belongs to its parent; later or attributed messages stay human", () => {
  const prompt = { _id: "brief", role: "user", content: "Review cloud spawn" };
  const setup = { _id: "setup", role: "user", content: "<recommended_plugins>plugins</recommended_plugins>" };
  expect(initialSubagentPromptId([setup, prompt], "parent", false)).toBe("brief");
  expect(initialSubagentPromptId([prompt], null, false)).toBeUndefined();
  expect(initialSubagentPromptId([prompt], "parent", true)).toBeUndefined();
  expect(initialSubagentPromptId([{ ...prompt, from_user_id: "human" }], "parent", false)).toBeUndefined();
  expect(initialSubagentPromptId([{ _id: "reply", role: "assistant" }, prompt], "parent", false)).toBeUndefined();
});
