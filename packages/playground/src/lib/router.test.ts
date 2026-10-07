import { describe, expect, test } from "bun:test";
import { isPlainClick, parseRoute } from "./router";

describe("parseRoute", () => {
  test("home", () => {
    expect(parseRoute("/", "")).toEqual({ kind: "home" });
  });

  test("an app on live, with and without the room", () => {
    expect(parseRoute("/frog-choir-m6ub", "")).toEqual({ kind: "app", slug: "frog-choir-m6ub", version: null, room: false });
    expect(parseRoute("/frog-choir-m6ub", "?room")).toEqual({ kind: "app", slug: "frog-choir-m6ub", version: null, room: true });
  });

  test("a version, keeping the room flag", () => {
    expect(parseRoute("/frog-choir-m6ub/v/12", "?room")).toEqual({ kind: "app", slug: "frog-choir-m6ub", version: 12, room: true });
  });

  test("anything else is missing", () => {
    expect(parseRoute("/Not_A_Slug", "")).toEqual({ kind: "missing" });
    expect(parseRoute("/frog-choir-m6ub/v/0", "")).toEqual({ kind: "missing" });
    expect(parseRoute("/frog-choir-m6ub/v/abc", "")).toEqual({ kind: "missing" });
    expect(parseRoute("/frog-choir-m6ub/edit", "")).toEqual({ kind: "missing" });
  });
});

describe("isPlainClick", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  test("a plain primary click moves in place", () => {
    expect(isPlainClick(click)).toBe(true);
  });
  test("modified, other-button and handled clicks are the browser's", () => {
    for (const e of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      expect(isPlainClick({ ...click, ...e })).toBe(false);
    }
  });
});
