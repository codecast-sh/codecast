import { describe, expect, test } from "bun:test";
import { holdsQueryPhrases, searchSnippet } from "./chatText";

describe("chat search text", () => {
  test("a quoted phrase must appear as typed", () => {
    expect(holdsQueryPhrases("Kept refreshing the page, call time is running", '"call page"')).toBe(false);
    expect(holdsQueryPhrases("the **call**\npage never loads", '"call page"')).toBe(true);
    expect(holdsQueryPhrases("Open the Call Page now", '"call page"')).toBe(true);
    expect(holdsQueryPhrases("anything at all", "call page")).toBe(true);
    expect(holdsQueryPhrases("i'm home and situated", "“home depot”")).toBe(false);
    expect(holdsQueryPhrases("grab it at Home Depot", "“home depot”")).toBe(true);
  });

  test("the snippet window lands on a quoted phrase deep in a message", () => {
    const content = `${"filler words here ".repeat(30)}then the call page broke ${"more tail ".repeat(20)}`;
    expect(searchSnippet(content, '"call page"', 200)).toContain("call page");
  });
});
