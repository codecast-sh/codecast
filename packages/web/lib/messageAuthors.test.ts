import { describe, expect, test } from "bun:test";
import { messageAgentTypes } from "./messageAuthors";

describe("messageAgentTypes", () => {
  test("an Antigravity session's gemini-4-* replies are Antigravity's, not Gemini CLI's", () => {
    const authors = messageAgentTypes(
      [
        { _id: "u", role: "user", content: "hi", timestamp: 1 },
        { _id: "a", role: "assistant", content: "hello", model: "gemini-4-argon-high", timestamp: 2 },
        { _id: "c", role: "assistant", content: "hello", model: "claude-opus-5-5-high", timestamp: 3 },
      ],
      "antigravity",
    );
    expect(authors.get("a")).toBe("antigravity");
    expect(authors.get("c")).toBe("antigravity");
  });

  test("a Gemini CLI session still reads its model as Gemini", () => {
    const authors = messageAgentTypes([{ _id: "a", role: "assistant", content: "x", model: "gemini-2.5-pro", timestamp: 1 }], "gemini");
    expect(authors.get("a")).toBe("gemini");
  });
});
