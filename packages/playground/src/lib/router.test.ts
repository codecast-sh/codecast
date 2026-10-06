import { describe, expect, test } from "bun:test";
import { parseRoute } from "./router";

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
