import { describe, expect, test } from "bun:test";
import { windowRows } from "../../hooks/useChatSync";

const row = (t: number) => ({ created_at: t });

describe("windowRows", () => {
  test("shows only rows the feed has paged to, so imported history behind the pages is not a hole", () => {
    const june = row(1_780_000_000_000);
    const sept15 = row(1_789_400_000_000);
    const sept16 = row(1_789_500_000_000);
    const today = row(1_789_600_000_000);
    const rows = [june, sept15, sept16, today];
    // The live page reached back to Sept 16 only.
    expect(windowRows(rows, sept16.created_at)).toEqual([sept16, today]);
    // Paging older lowered the floor.
    expect(windowRows(rows, sept15.created_at)).toEqual([sept15, sept16, today]);
    // History exhausted: everything.
    expect(windowRows(rows, 0)).toEqual(rows);
  });
  test("before the first page, the newest cached page stands in", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(i + 1));
    expect(windowRows(rows, null, 3)).toEqual([row(5), row(6), row(7)]);
    expect(windowRows(rows.slice(0, 2), null, 3)).toEqual([row(1), row(2)]);
  });
  test("no floor at all means no window (callers that never page)", () => {
    const rows = [row(1), row(2)];
    expect(windowRows(rows, undefined)).toBe(rows);
  });
});
