import { describe, expect, test } from "bun:test";
import { CHECK_WATCHERS_BACKSTOP, MACHINE_SLOTS, machineCap, worktreesFor } from "./machineCaps.js";

describe("typecheck watcher cap", () => {
  test("memory admits watchers; the count is a backstop of 16", () => {
    expect(CHECK_WATCHERS_BACKSTOP).toBe(16);
  });

  test("the environment still wins over the default", () => {
    expect(machineCap("check", { CAST_CHECK_MAX_WATCHERS: "3" })).toBe(3);
  });
});

describe("worktree slot", () => {
  test("one place per 16 GB of memory, never none", () => {
    const gb = 1024 ** 3;
    expect(worktreesFor(8 * gb)).toBe(1);
    expect(worktreesFor(16 * gb)).toBe(1);
    expect(worktreesFor(64 * gb)).toBe(4);
    expect(worktreesFor(128 * gb)).toBe(8);
  });

  test("is a named slot, and its environment variable wins", () => {
    expect(MACHINE_SLOTS).toContain("worktree");
    expect(machineCap("worktree", { CAST_WORKTREE_MAX: "3" })).toBe(3);
  });
});
