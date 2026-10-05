import { describe, expect, test } from "bun:test";
// The fence itself is tested in @platform/fence; this covers what codecast adds.
import { fenceUnlessBuiltin } from "./fence";

describe("fenceUnlessBuiltin", () => {
  test("builtin text passes through unfenced", () => {
    expect(fenceUnlessBuiltin("Our own memory snippet", "builtin/memory", "builtin"))
      .toBe("Our own memory snippet");
  });

  test("everything else is fenced", () => {
    expect(fenceUnlessBuiltin("desc", "mkt/acme/tool", "marketplace acme"))
      .toContain("<untrusted-");
  });
});
