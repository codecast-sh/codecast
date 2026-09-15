import { describe, expect, test } from "bun:test";
import { cleanBudget } from "./charterBudget";

describe("cleanBudget", () => {
  test("one key order however the fields were set, so the store draft and the echo are the same JSON", () => {
    const handsFirst = cleanBudget({ hands_per_day: 2, tokens_per_day: 400_000 });
    const tokensFirst = cleanBudget({ tokens_per_day: 400_000, hands_per_day: 2 });
    expect(Object.keys(handsFirst!)).toEqual(["tokens_per_day", "hands_per_day"]);
    expect(JSON.stringify(handsFirst)).toBe(JSON.stringify(tokensFirst));
  });

  test("drops undefined entries and is nothing when empty", () => {
    expect(cleanBudget({ hands_per_day: 2, tokens_per_day: undefined })).toEqual({ hands_per_day: 2 });
    expect(cleanBudget({})).toBeUndefined();
    expect(cleanBudget({ tokens_per_day: undefined })).toBeUndefined();
    expect(cleanBudget(null)).toBeUndefined();
    expect(cleanBudget(undefined)).toBeUndefined();
  });
});
