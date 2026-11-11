import { describe, expect, test } from "bun:test";
import { middleTruncate, splitPath } from "../middleTruncate";

// A row cuts a path in the middle: the file name stays, the directories give way.

describe("splitPath", () => {
  test("splits the directories from the file name, keeping the last separator on the directory", () => {
    expect(splitPath("packages/web/lib/server.ts")).toEqual({ dir: "packages/web/lib/", base: "server.ts" });
    expect(splitPath("/Users/me/repo/a.ts")).toEqual({ dir: "/Users/me/repo/", base: "a.ts" });
    expect(splitPath("C:\\repo\\src\\a.ts")).toEqual({ dir: "C:\\repo\\src\\", base: "a.ts" });
  });

  test("a bare name has no directory, and a trailing slash stays on its last name", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
    expect(splitPath("dist/")).toEqual({ dir: "", base: "dist/" });
    expect(splitPath("packages/web/")).toEqual({ dir: "packages/", base: "web/" });
    expect(splitPath("")).toEqual({ dir: "", base: "" });
  });
});

describe("middleTruncate", () => {
  const path = "packages/web/components/conversation/blocks/ModernRow.tsx";

  test("a path that fits is untouched", () => {
    expect(middleTruncate(path, path.length)).toBe(path);
    expect(middleTruncate("src/a.ts", 40)).toBe("src/a.ts");
  });

  test("keeps the first directory, the file name, and as many directories next to the file as fit", () => {
    expect(middleTruncate(path, 40)).toBe("packages/…/blocks/ModernRow.tsx");
    expect(middleTruncate(path, 45)).toBe("packages/…/conversation/blocks/ModernRow.tsx");
    for (const max of [20, 31, 40, 52]) expect(middleTruncate(path, max).length).toBeLessThanOrEqual(max);
  });

  test("an absolute path keeps its root", () => {
    expect(middleTruncate("/Users/me/src/codecast/packages/web/lib/server.ts", 30)).toBe("/Users/…/web/lib/server.ts");
  });

  test("with no room for a directory it drops them all, never the name", () => {
    expect(middleTruncate(path, 16)).toBe("…/ModernRow.tsx");
    expect(middleTruncate(path, 14)).toBe("…ModernRow.tsx");
  });

  test("a name longer than the room keeps its end, where the extension is", () => {
    const long = "src/a-very-long-generated-file-name.test.ts";
    expect(middleTruncate(long, 12)).toBe("…ame.test.ts");
    expect(middleTruncate("averyveryverylongname.ts", 10)).toBe("…ngname.ts");
  });
});
