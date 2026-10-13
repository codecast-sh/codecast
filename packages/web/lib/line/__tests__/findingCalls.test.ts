import { describe, expect, test } from "bun:test";
import { callWordsShort, callsIn, textWithCalls } from "../findingCalls";

// ct-58683's finding, as a person filed it.
const ID = "94373d15-a72c-4fd2-84c1-3bf5d900e5ac";
const TEXT = `Call ${ID} (Oct 9 14:02Z, Eric S). Feedback (slack msg 1791554755.009459) said 'you never named Jeff Londis'. The call ${ID} summary lists four names.`;

describe("findingCalls", () => {
  test("a call named by id is the app's call view, once", () => {
    expect(callsIn(TEXT)).toEqual([{ app: "union", view: "call", id: ID, at: null }]);
  });
  test("the words keep their text, with each call id as its reference and no Slack ts", () => {
    const parts = textWithCalls(TEXT);
    expect(parts[0]).toBe("Call ");
    expect(parts[1]).toEqual({ app: "union", view: "call", id: ID, at: null });
    const words = parts.filter((p) => typeof p === "string").join("");
    expect(words).not.toContain("1791554755");
    expect(words).toContain("Feedback said 'you never named Jeff Londis'");
    expect(parts.filter((p) => typeof p !== "string")).toHaveLength(2);
  });
  test("a row line names a call by its first eight characters", () => {
    expect(callWordsShort(TEXT).startsWith("Call 94373d15 (Oct 9")).toBe(true);
    expect(callWordsShort(TEXT)).not.toContain("slack msg");
  });
  test("a text with no call is itself", () => {
    expect(textWithCalls("Nothing here.")).toEqual(["Nothing here."]);
  });
});
