import { describe, expect, test } from "bun:test";
import { askCiteTarget, linkAskCitations } from "../askSession";

describe("linkAskCitations", () => {
  const citations = [
    { line: 12, message_id: "m12" },
    { line: 41, message_id: "m41" },
    { line: -3, message_id: "mTail" },
  ];

  test("links single citations, ranges (first resolved line) and tail numbers", () => {
    expect(linkAskCitations("Yes (msg 12). Reverted in msg 40–42; last seen msg -3.", citations)).toBe(
      "Yes ([msg 12](#ask-cite-m12)). Reverted in [msg 40–42](#ask-cite-m41); last seen [msg -3](#ask-cite-mTail).",
    );
  });

  test("leaves citations with no resolved message as text", () => {
    expect(linkAskCitations("See msg 7 and msg 12.", citations)).toBe("See msg 7 and [msg 12](#ask-cite-m12).");
    expect(linkAskCitations("no citations", citations)).toBe("no citations");
  });

  test("round trips through askCiteTarget", () => {
    expect(askCiteTarget("#ask-cite-m12")).toBe("m12");
    expect(askCiteTarget("https://example.com")).toBeNull();
    expect(askCiteTarget(undefined)).toBeNull();
  });
});
