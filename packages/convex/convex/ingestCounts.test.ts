import { describe, expect, test } from "bun:test";
import { moveGroupCount } from "./ingest";

describe("moveGroupCount", () => {
  const counts = { open: 10, resolved: 4, ignored: 1 };
  test("a resolve moves one from open to resolved", () => {
    expect(moveGroupCount(counts, "open", "resolved")).toEqual({ open: 9, resolved: 5, ignored: 1 });
  });
  test("muted counts as ignored, so ignored to muted moves nothing", () => {
    expect(moveGroupCount(counts, "ignored", "muted")).toBe(counts);
    expect(moveGroupCount(counts, "muted", "open")).toEqual({ open: 11, resolved: 4, ignored: 0 });
  });
  test("never below zero", () => {
    expect(moveGroupCount({ open: 0, resolved: 0, ignored: 0 }, "resolved", "open")).toEqual({ open: 1, resolved: 0, ignored: 0 });
  });
});
