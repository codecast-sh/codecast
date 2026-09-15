import { describe, expect, test } from "bun:test";
import { cleanBudget } from "./charterBudget";

describe("cleanBudget", () => {
  test("sorted key order however the fields were set (Convex echoes sorted keys), so the store draft and the echo are the same JSON", () => {
    const handsFirst = cleanBudget({ hands_per_day: 2, tokens_per_day: 400_000 });
    const tokensFirst = cleanBudget({ tokens_per_day: 400_000, hands_per_day: 2 });
    expect(Object.keys(tokensFirst!)).toEqual(["hands_per_day", "tokens_per_day"]);
    expect(Object.keys(tokensFirst!)).toEqual([...Object.keys(tokensFirst!)].sort());
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
