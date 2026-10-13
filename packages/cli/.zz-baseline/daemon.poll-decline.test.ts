import { describe, expect, test } from "bun:test";
import { parsePollMessage, pollDeclineText, pollMenuSteps } from "./daemon.js";

// Regression for the "211" bug (2026-06-27): answering a multi-question AskUserQuestion
// with a mix of menu picks and a custom ("Other") free-text answer declined the whole
// poll and dribbled the leftover option digits ("2","1","1") into the prompt box.
//
// Root cause: Claude Code's question menu has no inline free-text slot, so free text can
// only be entered by declining the menu (Escape) and typing at the prompt — which throws
// away every menu selection. The daemon used to do that Escape PER STEP, mid-loop, so the
// option-digit steps after it landed as literal characters in the reopened prompt box.
//
// The fix: the web now sends every answer as prose in a single `text` field, and the
// daemon declines ONCE then types it. pollDeclineText decides whether a poll is such a
// decline (and returns the text to type); pollMenuSteps returns the option keystrokes to
// drive when it is NOT a decline. These tests pin both decisions.

describe("pollDeclineText", () => {
  test("text-only poll (the new web shape for any custom answer) is a decline", () => {
    const poll = parsePollMessage(JSON.stringify({ __cc_poll: true, text: "use the intro response", display: "x" }))!;
    expect(poll).not.toBeNull();
    expect(pollDeclineText(poll)).toBe("use the intro response");
    // No menu keystrokes are driven — the menu is declined, not navigated.
    expect(pollMenuSteps(poll)).toEqual([]);
  });

  test("multi-answer prose flattens newlines so a literal LF can't submit early", () => {
    const poll = parsePollMessage(JSON.stringify({
      __cc_poll: true,
      text: "P0.1: introduction + post-meeting feedback\n\nMarkets: cut over now",
    }))!;
    expect(pollDeclineText(poll)).toBe("P0.1: introduction + post-meeting feedback  ·  Markets: cut over now");
  });

  test("old embedded-text shape (steps with a `text`) is still a decline — and drops no digits", () => {
    // This is the exact payload shape that produced "211": one Other step plus three
    // option-digit steps. The fix declines once and types the Other text; the digit
    // steps are NOT replayed into the prompt.
    const poll = parsePollMessage(JSON.stringify({
      __cc_poll: true,
      steps: [{ key: "5", text: "use the intro response" }, { key: "2" }, { key: "1" }, { key: "1" }],
    }))!;
    expect(pollDeclineText(poll)).toBe("use the intro response");
  });

  test("plan-feedback shape (menu key PLUS top-level text) is NOT a decline", () => {
    // Selecting option 4 opens a feedback field that `text` fills — driving the key is
    // required, and Escaping would cancel the whole plan menu.
    const poll = parsePollMessage(JSON.stringify({ __cc_poll: true, keys: ["4"], text: "tighten the error path" }))!;
    expect(pollDeclineText(poll)).toBeNull();
    expect(pollMenuSteps(poll)).toEqual([{ key: "4" }]);
  });

  test("pure menu selection (keys only) is NOT a decline", () => {
    const poll = parsePollMessage(JSON.stringify({ __cc_poll: true, keys: ["1", "2"], display: "A, B" }))!;
    expect(pollDeclineText(poll)).toBeNull();
    expect(pollMenuSteps(poll)).toEqual([{ key: "1" }, { key: "2" }]);
  });
});

describe("parsePollMessage", () => {
  test("recognizes a text-only poll (no keys/steps)", () => {
    expect(parsePollMessage(JSON.stringify({ __cc_poll: true, text: "hi" }))).not.toBeNull();
  });

  test("rejects a __cc_poll with neither keys, steps, nor text", () => {
    expect(parsePollMessage(JSON.stringify({ __cc_poll: true, display: "x" }))).toBeNull();
  });

  test("rejects non-poll JSON", () => {
    expect(parsePollMessage(JSON.stringify({ hello: "world" }))).toBeNull();
    expect(parsePollMessage("not json")).toBeNull();
  });
});
