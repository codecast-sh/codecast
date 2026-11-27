import { describe, expect, test } from "bun:test";
import { cwdFromOsc7, scanTerminalPaths, terminalPathContext } from "../terminal/fileLinks";
import { editorHref } from "../filesPane";

const linked = (text: string) => scanTerminalPaths(text).map((l) => ({ text: text.slice(l.start, l.end), path: l.path, line: l.line, column: l.column }));

describe("file paths in terminal output", () => {
  test("compiler, linter and grep forms carry their line and column", () => {
    expect(linked("src/lib/x.ts(12,4): error TS2322: Type 'a' is not assignable")).toEqual([
      { text: "src/lib/x.ts(12,4)", path: "src/lib/x.ts", line: 12, column: 4 },
    ]);
    expect(linked("packages/web/lib/a.tsx:38:7  error  no-unused-vars")).toEqual([
      { text: "packages/web/lib/a.tsx:38:7", path: "packages/web/lib/a.tsx", line: 38, column: 7 },
    ]);
    expect(linked("/Users/me/src/app/main.go:120:    return nil")).toEqual([
      { text: "/Users/me/src/app/main.go:120", path: "/Users/me/src/app/main.go", line: 120, column: undefined },
    ]);
    expect(linked("  --> src/main.rs:5:9")[0]).toMatchObject({ path: "src/main.rs", line: 5, column: 9 });
  });

  test("git status and plain listings link the path alone", () => {
    expect(linked("\tmodified:   packages/web/lib/filesPane.ts")).toEqual([
      { text: "packages/web/lib/filesPane.ts", path: "packages/web/lib/filesPane.ts", line: undefined, column: undefined },
    ]);
  });

  test("URLs, prose slashes and a sentence's full stop stay out", () => {
    expect(linked("see https://github.com/owner/repo/blob/main/x.ts and/or km/h")).toEqual([]);
    expect(linked("wrote lib/x.ts.")).toEqual([{ text: "lib/x.ts", path: "lib/x.ts", line: undefined, column: undefined }]);
  });

  test("a relative path opens against the terminal's directory, on its machine", () => {
    const ctx = terminalPathContext({ cwd: "/Users/me/src/app", deviceId: "dev-1" });
    expect(ctx.home).toBe("/Users/me");
    const [hit] = scanTerminalPaths("src/x.ts(3,2): error");
    expect(editorHref({ path: hit.path, line: hit.line, column: hit.column, ctx })).toBe("/files?path=%2FUsers%2Fme%2Fsrc%2Fapp%2Fsrc%2Fx.ts&d=dev-1&l=3%3A2");
  });

  test("OSC 7 names the shell's directory", () => {
    expect(cwdFromOsc7("file://mac.local/Users/me/src/my%20app")).toBe("/Users/me/src/my app");
    expect(cwdFromOsc7("not a url")).toBeNull();
  });
});
