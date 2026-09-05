import { describe, expect, it } from "bun:test";
import { cleanUserMessage, isBareNudge, stickyPromptContent } from "../sessionMessage";

const interruptionNotice = "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";

const interruptionMessages = [
  interruptionNotice,
  `<turn_aborted>\n${interruptionNotice}\n</turn_aborted>`,
  "  <turn_aborted>\nuser aborted\n</turn_aborted>  ",
  `<turn_aborted>\n${interruptionNotice.slice(0, 100)}`,
];

describe("cleanUserMessage", () => {
  it.each(interruptionMessages)("hides an automatic interruption notice: %s", (content) => {
    expect(cleanUserMessage(content)).toBeNull();
  });

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

describe("isBareNudge", () => {
  it("matches the nudges a human types to keep the agent moving", () => {
    for (const s of ["continue", "Continue.", "go", "Go!", "go ahead", "keep going", "ok", "yes", "proceed", "next"]) {
      expect(isBareNudge(s)).toBe(true);
    }
  });

  it("keeps a real ask that merely starts with a nudge word", () => {
    for (const s of ["go fix the login bug", "continue with the migration", "ok but use the shared helper", "yes, and add a test"]) {
      expect(isBareNudge(s)).toBe(false);
    }
  });
});

// The sticky header surfaces what the human asked for. Trigger runs, spawned
// briefings and bare nudges are not that, whichever sticky source they reach
// through (timeline, cached user list, last-message fallback).
describe("stickyPromptContent", () => {
  it.each(interruptionMessages)("drops an automatic interruption notice: %s", (content) => {
    expect(stickyPromptContent(content)).toBeNull();
  });

  it("keeps a human prompt about an interruption", () => {
    const prompt = "I interrupted the previous turn. Please check which commands completed.";
    expect(stickyPromptContent(prompt)).toBe(prompt);
  });

  it("drops an injected trigger run", () => {
    const run = '<scheduled-task title="Market growth mandate — daily autonomous run" task-id="abc">\n# Market Growth Mandate\n\n**Goal: increase the match rate.**</scheduled-task>';
    expect(stickyPromptContent(run)).toBeNull();
  });

  it("drops a spawned run's opening briefing", () => {
    const spawned = "[Codecast Task: Growth audit]\nTask ID: abc\nMode: spawn\n\nAudit budget allocation across markets.";
    expect(stickyPromptContent(spawned)).toBeNull();
  });

  it("drops a bare nudge", () => {
    expect(stickyPromptContent("continue")).toBeNull();
    expect(stickyPromptContent("go")).toBeNull();
  });

  it("keeps a real prompt", () => {
    expect(stickyPromptContent("fix the login bug")).toBe("fix the login bug");
  });
});
