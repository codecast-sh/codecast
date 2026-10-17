import { describe, expect, test } from "bun:test";
import { checkoutMatches, displayPath, expandHome, newFolderPath } from "./folderSearch";

const roots = ["/Users/ada/src/aurora", "/Users/ada/src/codecast", "/Users/ada/src/borealis", "/Users/ada/dev/aurora-old"];

describe("folderSearch", () => {
  test("a checkout no session ran in is found by name, prefix first", () => {
    expect(checkoutMatches(roots, "aur", new Set())).toEqual(["/Users/ada/src/aurora", "/Users/ada/dev/aurora-old"]);
    expect(checkoutMatches(roots, "or", new Set())).toEqual(["/Users/ada/src/aurora", "/Users/ada/src/borealis", "/Users/ada/dev/aurora-old"]);
    expect(checkoutMatches(roots, "aurora", new Set(["/Users/ada/src/aurora"]))).toEqual(["/Users/ada/dev/aurora-old"]);
  });

  test("a new folder goes beside most checkouts", () => {
    expect(newFolderPath("nova", roots, [])).toBe("/Users/ada/src/nova");
    expect(newFolderPath("nova", [], ["/home/bo/work/x"])).toBe("/home/bo/work/nova");
    expect(newFolderPath("nova", [], [])).toBeNull();
    expect(newFolderPath("a/b", roots, [])).toBeNull();
    expect(newFolderPath("..", roots, [])).toBeNull();
  });

  test("~ expands to the machine's home", () => {
    expect(expandHome("~/src/x", roots)).toBe("/Users/ada/src/x");
    expect(expandHome("~/src/x", [])).toBe("~/src/x");
    expect(expandHome("/opt/x", roots)).toBe("/opt/x");
    expect(displayPath("/Users/ada/src/x")).toBe("~/src/x");
  });
});
