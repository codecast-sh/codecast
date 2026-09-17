import { describe, expect, test } from "bun:test";
import { cutSearchPage, searchMessageMatches } from "./messages";
import type { Id } from "./_generated/dataModel";

const row = (id: string, timestamp: number, content?: string) => ({ _id: id as Id<"messages">, timestamp, content });

describe("cutSearchPage", () => {
  test("a short page is the last page", () => {
    const rows = [row("a", 1), row("b", 2)];
    expect(cutSearchPage(rows, 5)).toEqual({ rows, next_after_ts: null });
  });

  test("a full page ends before the boundary timestamp so a tie is never split", () => {
    // limit 3, four rows read: the boundary is the third row's timestamp (20),
    // which the fourth row shares. Both rows at 20 move to the next page.
    const rows = [row("a", 10), row("b", 15), row("c", 20), row("d", 20)];
    const page = cutSearchPage(rows, 3);
    expect(page.rows.map((r) => r._id)).toEqual(["a", "b"]);
    // gt(19) reads everything at 20 again.
    expect(page.next_after_ts).toBe(19);
  });

  test("a page of one timestamp still advances", () => {
    const rows = [row("a", 5), row("b", 5), row("c", 5), row("d", 5)];
    const page = cutSearchPage(rows, 3);
    expect(page.rows.map((r) => r._id)).toEqual(["a", "b", "c"]);
    expect(page.next_after_ts).toBe(5);
  });
});

describe("searchMessageMatches", () => {
  test("counts every term, case-insensitively, and skips rows without content", () => {
    const rows = [row("a", 1, "Facebook ads; facebook again"), row("b", 2), row("c", 3, "nothing here")];
    expect(searchMessageMatches(rows, ["facebook"])).toEqual([{ message_id: "a", timestamp: 1, match_count: 2 }]);
  });

  test("hits inside context tags the transcript hides do not count", () => {
    const rows = [row("a", 1, "<system-reminder>facebook facebook</system-reminder>\nreal facebook mention")];
    expect(searchMessageMatches(rows, ["facebook"])).toEqual([{ message_id: "a", timestamp: 1, match_count: 1 }]);
  });
});
