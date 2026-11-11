import { describe, expect, test } from "bun:test";
import { finishInput, fnPrefixAt, wantsReference } from "./editStore";

describe("formula typing helpers", () => {
  test("finishInput closes what is open and leaves strings alone", () => {
    expect(finishInput('="("')).toBe('="("');
    expect(finishInput("=SUM(A1:A3")).toBe("=SUM(A1:A3)");
    expect(finishInput('=IF(A1>0,"ok')).toBe('=IF(A1>0,"ok")');
    expect(finishInput('=CONCAT("a""(",B1')).toBe('=CONCAT("a""(",B1)');
    expect(finishInput("plain (text")).toBe("plain (text");
    expect(finishInput("='Costs (draft'!A1")).toBe("='Costs (draft'!A1");
    expect(finishInput("=SUM('Q4 (plan)'!A1:A3")).toBe("=SUM('Q4 (plan)'!A1:A3)");
  });
  test("point mode and autocomplete triggers", () => {
    expect(wantsReference("=SUM(", 5)).toBe(true);
    expect(wantsReference("=A1+", 4)).toBe(true);
    expect(wantsReference("=A1", 3)).toBe(false);
    expect(fnPrefixAt("=1+su", 5)).toBe("SU");
    expect(fnPrefixAt("=A1", 3)).toBe("A1");
  });
});
