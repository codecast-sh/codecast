import { test, expect, describe } from "bun:test";
import { matchesProjectQuery } from "./utils";

describe("matchesProjectQuery", () => {
  const paths = [
    "/Users/ashot/src/codecast",
    "/Users/ashot/src/union-mobile",
    "/Users/ashot/src/footage-app",
  ];
  const matches = (q: string) => paths.filter((p) => matchesProjectQuery(p, q));

  test("empty query matches everything", () => {
    expect(matches("")).toEqual(paths);
    expect(matches("  ")).toEqual(paths);
  });

  test("matches project name prefix, not the shared path prefix", () => {
    // "s" appears in /Users/ashot/src/… on every path — must not match all
    expect(matches("s")).toEqual([]);
    // "a" hits footage-app via its "app" word, but not /Users/ashot on every path
    expect(matches("a")).toEqual(["/Users/ashot/src/footage-app"]);
    expect(matches("co")).toEqual(["/Users/ashot/src/codecast"]);
    expect(matches("u")).toEqual(["/Users/ashot/src/union-mobile"]);
  });

  test("anchored at name start, not mid-word", () => {
    expect(matches("decast")).toEqual([]);
  });

  test("matches word segments within the name", () => {
    expect(matches("mobile")).toEqual(["/Users/ashot/src/union-mobile"]);
    expect(matches("app")).toEqual(["/Users/ashot/src/footage-app"]);
  });

  test("query spanning a separator still matches from name start", () => {
    expect(matches("union-mo")).toEqual(["/Users/ashot/src/union-mobile"]);
  });

  test("case-insensitive", () => {
    expect(matches("CODE")).toEqual(["/Users/ashot/src/codecast"]);
  });

  test("query with slash falls back to full-path substring", () => {
    expect(matches("/Users/ashot/src/codecast")).toEqual(["/Users/ashot/src/codecast"]);
    expect(matches("ashot/src")).toEqual(paths);
  });
});
