import { describe, expect, test } from "bun:test";
import { railFolded } from "../railFocus";

describe("railFolded", () => {
  test("More starts folded for everyone", () => {
    expect(railFolded(undefined)).toBe(true);
    expect(railFolded(false)).toBe(true);
  });
  test("opening More keeps it open", () => {
    expect(railFolded(true)).toBe(false);
  });
});
