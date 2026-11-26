import { describe, expect, test } from "bun:test";
import { sessionLabel } from "./sessionLabel";

describe("sessionLabel", () => {
  test("a titled session reads by its title", () => {
    expect(sessionLabel({ title: " Prompt quality guardrails ", project_path: "/a/b" })).toBe("Prompt quality guardrails");
  });
  test("a session too young for a title reads by its project folder, never its id or its prompt", () => {
    expect(sessionLabel({ title: "", project_path: "/Users/x/code/union-mobile/" })).toBe("union-mobile");
  });
  test("with no folder, the fallback", () => {
    expect(sessionLabel({}, "a session")).toBe("a session");
  });
});
