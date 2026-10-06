import { describe, expect, test } from "bun:test";
import { anchorFromDiffHunk, captureAnchor, placeAnchor, placementLabel, relocateAnchor } from "./codeAnchor";

const FILE = [
  "import { run } from './run';",
  "",
  "export function main(args: string[]) {",
  "  const config = loadConfig(args);",
  "  const result = run(config);",
  "  return result.exitCode;",
  "}",
  "",
  "function loadConfig(args: string[]) {",
  "  return { verbose: args.includes('-v') };",
  "}",
];

// The comment on line 5, `const result = run(config);`.
const anchor = { line: 5, text: captureAnchor(FILE, 5)! };

describe("captureAnchor", () => {
  test("keeps the commented lines trimmed with two lines either side", () => {
    expect(anchor.text).toEqual({
      before: ["export function main(args: string[]) {", "const config = loadConfig(args);"],
      lines: ["const result = run(config);"],
      after: ["return result.exitCode;", "}"],
    });
  });

  test("clips context at the file edges and refuses lines outside it", () => {
    expect(captureAnchor(FILE, 1)!.before).toEqual([]);
    expect(captureAnchor(FILE, 11)!.after).toEqual([]);
    expect(captureAnchor(FILE, 0)).toBeUndefined();
    expect(captureAnchor(FILE, 12)).toBeUndefined();
  });

  test("caps a long range at 12 lines and 2 KB", () => {
    const big = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(300)}`);
    const text = captureAnchor(big, 5, 30)!;
    expect(text.before.length + text.lines.length + text.after.length).toBeLessThanOrEqual(12);
    expect(new TextEncoder().encode(JSON.stringify(text)).length).toBeLessThanOrEqual(2048);
    expect(text.lines[0]).toStartWith("line 4 ");
  });
});

describe("relocateAnchor", () => {
  test("finds the passage where it was", () => {
    expect(relocateAnchor(anchor, FILE)).toBe(5);
  });

  test("moved down by lines added above", () => {
    const file = [FILE[0], "import { log } from './log';", "import { env } from './env';", ...FILE.slice(1)];
    expect(relocateAnchor(anchor, file)).toBe(7);
  });

  test("moved up by lines removed above", () => {
    expect(relocateAnchor(anchor, FILE.slice(2))).toBe(3);
  });

  test("edited nearby: the context changed, the commented line did not", () => {
    const file = [...FILE];
    file[3] = "  const config = loadConfig(args, process.env);";
    file[5] = "  return result.exitCode ?? 1;";
    file.splice(1, 0, "// header");
    expect(relocateAnchor(anchor, file)).toBe(6);
  });

  test("reindented: matches ignoring whitespace", () => {
    const file = FILE.map((line) => line.replace("run(config)", "run( config )"));
    expect(relocateAnchor(anchor, file)).toBe(5);
  });

  test("deleted: null", () => {
    const file = FILE.filter((_, i) => i !== 4);
    expect(relocateAnchor(anchor, file)).toBeNull();
  });

  test("duplicated passage: the copy nearest the old line wins", () => {
    const pad = (n: number) => Array(n).fill("// pad");
    // The whole function twice: once at the top, once 30 lines down.
    const file = [...FILE.slice(2, 7), ...pad(30), ...FILE.slice(2, 7)];
    expect(relocateAnchor({ line: 5, text: anchor.text }, file)).toBe(3);
    expect(relocateAnchor({ line: 30, text: anchor.text }, file)).toBe(38);
  });

  test("a bare `}` is not matched without its context", () => {
    const brace = { line: 7, text: captureAnchor(FILE, 7)! };
    const file = ["function other() {", "  return 1;", "}"];
    expect(relocateAnchor(brace, file)).toBeNull();
  });

  test("lines the caller cannot see never match", () => {
    const sparse: (string | undefined)[] = [...FILE];
    sparse[4] = undefined;
    expect(relocateAnchor(anchor, sparse)).toBeNull();
  });
});

describe("placeAnchor", () => {
  const comment = { line_number: 5, line_end: 6, anchor_lines: captureAnchor(FILE, 5, 6) };

  test("current, moved and outdated", () => {
    expect(placeAnchor(comment, FILE)).toEqual({ state: "current", line: 5, lineEnd: 6 });
    expect(placeAnchor(comment, ["// new", ...FILE])).toEqual({ state: "moved", line: 6, lineEnd: 7, from: 5 });
    expect(placeAnchor(comment, FILE.slice(0, 4))).toEqual({ state: "outdated", line: 5, lineEnd: 6, from: 5 });
  });

  test("a comment written before anchors existed stays at its line", () => {
    expect(placeAnchor({ line_number: 5 }, [])).toEqual({ state: "current", line: 5, lineEnd: undefined });
    expect(placeAnchor({}, FILE)).toBeNull();
  });

  test("labels", () => {
    expect(placementLabel(placeAnchor(comment, ["// new", ...FILE]))).toBe("moved from line 5");
    expect(placementLabel(placeAnchor(comment, []))).toBe("outdated");
    expect(placementLabel(placeAnchor(comment, FILE))).toBe("");
  });
});

describe("anchorFromDiffHunk", () => {
  const hunk = [
    "@@ -1,6 +1,7 @@",
    " export function main(args: string[]) {",
    "   const config = loadConfig(args);",
    "-  const out = run(config);",
    "+  const result = run(config);",
  ].join("\n");

  test("the right side ends at the commented line", () => {
    expect(anchorFromDiffHunk(hunk, "RIGHT")).toEqual({
      before: ["export function main(args: string[]) {", "const config = loadConfig(args);"],
      lines: ["const result = run(config);"],
      after: [],
    });
  });

  test("the left side reads the removed lines", () => {
    const left = hunk.split("\n").slice(0, 4).join("\n");
    expect(anchorFromDiffHunk(left, "LEFT")!.lines).toEqual(["const out = run(config);"]);
  });

  test("relocates against the file as it is now", () => {
    expect(relocateAnchor({ line: 3, text: anchorFromDiffHunk(hunk, "RIGHT")! }, FILE)).toBe(5);
  });
});
