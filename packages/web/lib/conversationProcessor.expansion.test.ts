import { test, expect, describe } from "bun:test";
import { commandExpansionName } from "./conversationProcessor";

// Regression: a long message the user typed right after a slash command's output
// rendered as a collapsed "/skill" block. The classifier treated "previous user
// message matches isCommandMessage + this one is long" as a skill expansion, but
// isCommandMessage also matches <local-command-stdout>. A real expansion echo
// directly follows the *tagged invocation* and shares its timestamp (Claude Code
// writes both in the same batch) — those are the guards under test here.

const T0 = 1_754_000_000_000;

const INVOCATION = {
  content:
    "<command-name>/commit</command-name>\n<command-message>commit</command-message>\n<command-args></command-args>",
  timestamp: T0,
};

// Some CC versions write <command-message> first.
const INVOCATION_MSG_FIRST = {
  content:
    "<command-message>migrate</command-message>\n<command-name>/migrate</command-name>\n<command-args>if you can</command-args>",
  timestamp: T0,
};

const STDOUT = {
  content:
    "<local-command-stdout>Set model to Fable 5 and saved as your default for new sessions</local-command-stdout>",
  timestamp: T0,
};

const LONG_PROSE = "what about descript like editing (removing deadspace/uhs as well)\n\n" +
  "what about screen studio features (zoom in with mouse movement, timeline editing, etc) - " +
  "please do some web research and deeply familiarize yourself with this toolset.\n\n" +
  "wrap in a desktop app with a nice icon and deploy it - we want niceties like a control panel";

const EXPANSION = "## Task\n\nAnalyze ALL uncommitted changes and create a series of " +
  "well-organized, topical commits.\n\n## Process\n\n1. Analyze the full diff and group " +
  "changes by topic. 2. Stage and commit each group with a clear message. 3. Repeat until clean.";

describe("commandExpansionName", () => {
  test("recognizes a real expansion echo: tagged invocation + same timestamp", () => {
    expect(commandExpansionName(INVOCATION, { content: EXPANSION, timestamp: T0 })).toBe("commit");
  });

  test("handles message-before-name tag order, prefers the name tag", () => {
    expect(commandExpansionName(INVOCATION_MSG_FIRST, { content: EXPANSION, timestamp: T0 })).toBe("migrate");
  });

  test("the bug: long user prose after command stdout is NOT an expansion", () => {
    // /model ran an hour before; its stdout is the immediately preceding message.
    expect(commandExpansionName(STDOUT, { content: LONG_PROSE, timestamp: T0 + 3_600_000 })).toBeNull();
  });

  test("long user prose typed minutes after the invocation is NOT an expansion", () => {
    expect(commandExpansionName(INVOCATION, { content: LONG_PROSE, timestamp: T0 + 120_000 })).toBeNull();
  });

  test("short messages never classify", () => {
    expect(commandExpansionName(INVOCATION, { content: "go", timestamp: T0 })).toBeNull();
  });

  test("missing prev or timestamps never classify", () => {
    expect(commandExpansionName(null, { content: EXPANSION, timestamp: T0 })).toBeNull();
    expect(commandExpansionName({ content: INVOCATION.content }, { content: EXPANSION, timestamp: T0 })).toBeNull();
  });
});
