import { describe, expect, test } from "bun:test";
import { suggestionOutcome } from "../useComposerSuggestion";

const shown = { anchor: "a1", text: "add the test first" };

describe("suggestionOutcome", () => {
  test("a taken suggestion sent as written, or changed first", () => {
    expect(suggestionOutcome(shown, shown, "a1", " add the test first ")).toEqual({ anchor_message_uuid: "a1", suggestion: "add the test first", outcome: "sent", shown: ["add the test first"], typed_length: 18 });
    expect(suggestionOutcome(shown, shown, "a1", "add the test first, then ship")).toMatchObject({ outcome: "edited" });
  });

  test("own words after a ghost on show for this turn are ignored", () => {
    expect(suggestionOutcome(null, shown, "a1", "revert the flag")).toEqual({
      anchor_message_uuid: "a1", suggestion: "add the test first", outcome: "ignored", shown: ["add the test first"], typed_length: 15,
    });
  });

  test("a suggestion taken on an earlier turn is not this turn's outcome", () => {
    // Tab on turn a1, the turn answered elsewhere, own words on turn a2.
    expect(suggestionOutcome(shown, null, "a2", "revert the flag")).toBeNull();
  });

  test("nothing to report: no ghost shown, a ghost for an older turn, an empty send, a slash command", () => {
    expect(suggestionOutcome(null, null, "a1", "revert the flag")).toBeNull();
    expect(suggestionOutcome(null, shown, "a2", "revert the flag")).toBeNull();
    expect(suggestionOutcome(null, shown, "a1", "   ")).toBeNull();
    expect(suggestionOutcome(null, shown, "a1", "/compact")).toBeNull();
  });
});
