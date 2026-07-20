import { describe, expect, it } from "bun:test";
import { cleanUserMessage } from "../GlobalSessionPanel";

describe("cleanUserMessage", () => {
  it("hides the [Codecast import] truncation banner from the inbox preview", () => {
    const banner =
      "[Codecast import] This Claude session was truncated to avoid overly-long context (which can break Claude Code /compact).\nWhat would you like to do next?";
    expect(cleanUserMessage(banner)).toBeNull();
  });

  it("keeps a real user message", () => {
    expect(cleanUserMessage("fix the login bug")).toBe("fix the login bug");
  });

  // The server truncates the preview slice, so a <task-notification> often
  // arrives with no closing tag; the inner text ("bnvc12ng6 Monitor event…")
  // was leaking into the card as if the human said it.
  it("hides a truncated task-notification with no closing tag", () => {
    const truncated =
      '<task-notification>\n<task-id>bnvc12ng6</task-id>\n<summary>Monitor event: "web dev server health (localhost:3200)"</summary>\n<event>dev server responding (200)</event>\nIf this event is something the us';
    expect(cleanUserMessage(truncated)).toBeNull();
  });
});
