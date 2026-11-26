import { describe, expect, test } from "bun:test";
import { triageFactsOf } from "./liveTriage";

describe("live triage adapter", () => {
  test("pinned reads the inbox pin stamp, the one placement reads", () => {
    const now = 1_800_000_000_000;
    const row = { _id: "a", updated_at: now, message_count: 3, is_pinned: true } as any;
    expect(triageFactsOf(row, now, false).pinned).toBe(false);
    expect(triageFactsOf({ ...row, inbox_pinned_at: now - 1 }, now, false).pinned).toBe(true);
  });
});
