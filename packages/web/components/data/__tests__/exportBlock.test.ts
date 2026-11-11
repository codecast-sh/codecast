import { describe, expect, test } from "bun:test";
import { blockRows, fileName, toCsv } from "../exportBlock";

const result = (columns: string[], rows: unknown[][]) => ({ _id: "r", doc_id: "d", qkey: "q", columns, rows, refreshed_at: 1, refresh_ms: 1, query_text: "", source: "usage", args: {}, workspace: "team:t" });

describe("block export", () => {
  test("CSV quotes commas, quotes and newlines, and leaves blanks empty", () => {
    expect(toCsv(["name", "note", "n"], [["ada", 'said "hi", left', 3], ["bo", "two\nlines", null]])).toBe('name,note,n\r\nada,"said ""hi"", left",3\r\nbo,"two\nlines",');
  });
  test("a KPI exports the rows its number used, under the dashboard's filter; a table its shaped rows", () => {
    const r = result(["day", "person", "spend"], [["d1", "ada", 1], ["d1", "bo", 2], ["d2", "ada", 4]]);
    const kpi = { key: "b_k", kind: "kpi", rev: 1, query: { source: "usage" }, field: "spend" } as any;
    expect(blockRows(kpi, r as any, { person: "ada" })?.rows).toEqual([["d1", "ada", 1], ["d2", "ada", 4]]);
    const table = { key: "b_t", kind: "table", rev: 1, query: { source: "usage" }, columns: "person,spend", sort: "-spend", limit: 2 } as any;
    expect(blockRows(table, r as any)).toEqual({ columns: ["person", "spend"], rows: [["ada", 4], ["bo", 2]] });
  });
  test("file names come from the title", () => {
    expect(fileName("Spend per day!", "png")).toBe("spend-per-day.png");
    expect(fileName(undefined, "csv")).toBe("block.csv");
  });
});
