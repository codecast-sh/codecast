import { describe, expect, test } from "bun:test";
import { isHomeDirectoryPath } from "./homeDirectory";

describe("isHomeDirectoryPath", () => {
  test("a user's home directory itself", () => {
    for (const p of ["/Users/ashot", "/home/cam", "/root", "/Users/ashot/"]) expect(isHomeDirectoryPath(p)).toBe(true);
  });

  test("anything deeper, shallower, relative or empty is not", () => {
    for (const p of ["/Users/ashot/src", "/home", "/Users", "/", "", "Users/ashot", "/opt/app", null, undefined]) {
      expect(isHomeDirectoryPath(p)).toBe(false);
    }
  });
});
