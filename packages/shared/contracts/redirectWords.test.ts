import { describe, expect, test } from "bun:test";
import { REDIRECT_PATTERN } from "./redirectWords";

describe("REDIRECT_PATTERN", () => {
  test("matches the cast-lessons words, case insensitively", () => {
    expect(REDIRECT_PATTERN.test("No, DON'T do that")).toBe(true);
    expect(REDIRECT_PATTERN.test("not like that, revert it")).toBe(true);
    expect(REDIRECT_PATTERN.test("looks good, ship it")).toBe(false);
  });
});
