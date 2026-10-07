import { describe, expect, test } from "bun:test";
import { stripSnippetMarkup } from "../searchHighlight";

describe("a search snippet reads as text", () => {
  test("drops a session message's wrapper and keeps its words", () => {
    expect(stripSnippetMarkup('...te titled "E2E packing list" that says: passport, charger... </session-message>'))
      .toBe('...te titled "E2E packing list" that says: passport, charger...');
    expect(stripSnippetMarkup('<session-message from="jx7">Pack the passport</session-message>')).toBe("Pack the passport");
  });

  test("drops a wrapper cut at either edge", () => {
    expect(stripSnippetMarkup('sage from="jx7"> Pack the passport')).toBe("Pack the passport");
    expect(stripSnippetMarkup("Pack the passport <system-remin")).toBe("Pack the passport");
  });

  test("leaves ordinary angle brackets and comparisons alone", () => {
    expect(stripSnippetMarkup("if a < b and b > c")).toBe("if a < b and b > c");
    expect(stripSnippetMarkup("use <div> here")).toBe("use <div> here");
  });
});
