import { describe, expect, test } from "bun:test";
import { pickFields } from "./jsonFields.js";

describe("pickFields", () => {
  const row = { short_id: "ct-1", title: "T", status: "open", comments: ["long"], decisions: [] };
  test("keeps the named fields and the short id", () => {
    expect(pickFields(row, "title, status")).toEqual({ short_id: "ct-1", title: "T", status: "open" });
  });
  test("no names returns the row whole", () => {
    expect(pickFields(row, undefined)).toBe(row);
    expect(pickFields(row, " , ")).toBe(row);
  });
  test("a name the row lacks is simply absent", () => {
    expect(pickFields(row, "nope")).toEqual({ short_id: "ct-1" });
  });
});
