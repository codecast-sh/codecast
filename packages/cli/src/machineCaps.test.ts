import { describe, expect, test } from "bun:test";
import { CHECK_WATCHERS_BACKSTOP, machineCap } from "./machineCaps.js";

describe("typecheck watcher cap", () => {
  test("memory admits watchers; the count is a backstop of 16", () => {
    expect(CHECK_WATCHERS_BACKSTOP).toBe(16);
  });

  test("the environment still wins over the default", () => {
    expect(machineCap("check", { CAST_CHECK_MAX_WATCHERS: "3" })).toBe(3);
  });
});
