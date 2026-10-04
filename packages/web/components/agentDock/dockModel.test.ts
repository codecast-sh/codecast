import { test, expect } from "bun:test";
import { nextEntryId } from "./dockModel";

const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("settling an entry moves to the one after it", () => {
  expect(nextEntryId(list, "a")).toBe("b");
  expect(nextEntryId(list, "b")).toBe("c");
});

test("the last entry falls back to the one before", () => {
  expect(nextEntryId(list, "c")).toBe("b");
});

test("the only entry leaves nothing to show", () => {
  expect(nextEntryId([{ id: "a" }], "a")).toBeNull();
});

test("an entry opened from a dot (not in the list) moves to the head of the list", () => {
  expect(nextEntryId(list, "z")).toBe("a");
});
