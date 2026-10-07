import { describe, expect, test } from "bun:test";
import { ENTRY_PATH, contentTypeFor, fileSetProblems, manifestHash, needsTranspile, normalizeFilePath } from "./files";
import { MAX_FILE_BYTES, MAX_FILES_PER_VERSION, VERSION_SUMMARY_MAX } from "./limits";
import { IMPORT_MAP, SDK_SPECIFIER } from "./runtime";
import { seedFiles } from "./seed";
import { transpile } from "./transpile";
import { cleanSummary, nextVersionNumber, parseVersionNumber, versionSaid } from "./versions";

describe("version numbering", () => {
  test("numbers run 1..n with no gaps", () => {
    expect(nextVersionNumber(0)).toBe(1);
    expect(nextVersionNumber(14)).toBe(15);
  });

  test("a corrupt count throws instead of minting a duplicate", () => {
    for (const bad of [-1, 1.5, NaN]) expect(() => nextVersionNumber(bad)).toThrow();
  });

  test("route spellings parse; anything else is null", () => {
    expect(parseVersionNumber("v12")).toBe(12);
    expect(parseVersionNumber("V3")).toBe(3);
    expect(parseVersionNumber(" 7 ")).toBe(7);
    for (const bad of ["v0", "0", "v", "12a", "-3", "v1.5", ""]) expect(parseVersionNumber(bad)).toBeNull();
  });

  test("summaries are one line and capped with an ellipsis", () => {
    expect(cleanSummary("  Made the\nbackground   blue ")).toBe("Made the background blue");
    const long = cleanSummary("word ".repeat(100));
    expect(long).toHaveLength(VERSION_SUMMARY_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("file paths", () => {
  test("normalizes the ways people write a relative path", () => {
    expect(normalizeFilePath("./src/App.jsx")).toBe("src/App.jsx");
    expect(normalizeFilePath("/index.html")).toBe("index.html");
  });

  test("refuses escapes, hidden files, odd characters and unknown types", () => {
    for (const bad of ["../x.js", "src/../x.js", "src/./x.js", ".env", "src/.hidden.js", "a b.js", "x.exe", "noext", "", "a/b/c/d/e/f/g.js"]) {
      expect(normalizeFilePath(bad)).toBeNull();
    }
  });

  test("serves JSX/TS as JavaScript and knows which to transpile", () => {
    expect(contentTypeFor("src/App.tsx")).toStartWith("text/javascript");
    expect(contentTypeFor("index.html")).toStartWith("text/html");
    expect(needsTranspile("src/App.jsx")).toBe(true);
    expect(needsTranspile("src/util.js")).toBe(false);
  });
});

describe("file set rules", () => {
  const entry = { path: ENTRY_PATH, text: "<!doctype html>" };

  test("a set with an entry and sane files passes", () => {
    expect(fileSetProblems([entry, { path: "src/a.js", text: "export {}" }])).toEqual([]);
  });

  test("names every problem at once", () => {
    const problems = fileSetProblems([
      { path: "src/a.js", text: "x".repeat(MAX_FILE_BYTES + 1) },
      { path: "src/a.js", text: "" },
      { path: "../evil.js", text: "" },
    ]);
    expect(problems.join("\n")).toContain("index.html is missing");
    expect(problems.join("\n")).toContain("appears twice");
    expect(problems.join("\n")).toContain("not an allowed path");
    expect(problems.join("\n")).toContain("at most 200 KB");
  });

  test("caps the file count", () => {
    const many = Array.from({ length: MAX_FILES_PER_VERSION }, (_, i) => ({ path: `f${i}.js`, text: "" }));
    expect(fileSetProblems([entry, ...many])[0]).toContain("at most");
  });

  test("the manifest hash ignores order and sees any change", async () => {
    const a = { path: "a.js", hash: "1" };
    const b = { path: "b.js", hash: "2" };
    expect(await manifestHash([a, b])).toBe(await manifestHash([b, a]));
    expect(await manifestHash([a, b])).not.toBe(await manifestHash([a, { ...b, hash: "3" }]));
  });
});

describe("transpile", () => {
  test("JSX becomes an ES module on the automatic runtime, imports untouched", () => {
    const out = transpile("src/App.jsx", `import x from "./x.js";\nexport default () => <b>{x}</b>;`);
    if (!out.ok) throw new Error(out.error);
    expect(out.code).toContain(`from "react/jsx-runtime"`);
    expect(out.code).toContain(`import x from "./x.js"`);
    expect(out.code).not.toContain("<b>");
  });

  test("TypeScript types are stripped", () => {
    const out = transpile("src/a.ts", "export const n: number = 1; export type T = { a: string };");
    expect(out.ok && out.code).not.toContain(": number");
  });

  test("a syntax error comes back with the path, never thrown", () => {
    const out = transpile("src/App.jsx", "export default () => <div>;");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/^src\/App\.jsx: Unexpected token.* \(1:\d+\)$/);
  });

  test("plain JS passes through", () => {
    expect(transpile("a.js", "const x = 1")).toEqual({ ok: true, code: "const x = 1" });
  });
});

describe("seed version", () => {
  const files = seedFiles(`Frog "choir" <3`);

  test("passes the file rules and every module transpiles", () => {
    expect(fileSetProblems(files)).toEqual([]);
    for (const f of files) expect(transpile(f.path, f.text).ok).toBe(true);
  });

  test("pins React and the SDK through the import map", () => {
    const html = files.find((f) => f.path === ENTRY_PATH)!.text;
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(map).toEqual(IMPORT_MAP);
    expect(files.find((f) => f.path === "src/App.jsx")!.text).toContain(`from "${SDK_SPECIFIER}"`);
  });

  test("the app name is escaped in HTML and quoted in JS", () => {
    const html = files.find((f) => f.path === ENTRY_PATH)!.text;
    expect(html).toContain("<title>Frog &quot;choir&quot; &lt;3</title>");
    expect(files.find((f) => f.path === "src/App.jsx")!.text).toContain(`const NAME = "Frog \\"choir\\" <3";`);
  });
});

describe("versionSaid", () => {
  test("says what a version did, never a bare number for a build", () => {
    expect(versionSaid({ kind: "build", summary: "Turns the background blue", parent_number: 3 }, null)).toBe("turns the background blue");
    expect(versionSaid({ kind: "build", summary: "SVG frogs sing", parent_number: 3 }, null)).toBe("SVG frogs sing");
    expect(versionSaid({ kind: "build", summary: "Makes a frog choir", parent_number: null }, null)).toBe("made it");
    expect(versionSaid({ kind: "build", summary: "Makes a frog choir" }, null)).toBe("made it");
    expect(versionSaid({ kind: "restore", summary: "Undid v7: Turns it blue", undid: 7, source: { version: 6 } }, null)).toBe("undid v7: Turns it blue");
    expect(versionSaid({ kind: "restore", summary: "Turns it blue", undid: null, source: { version: 3 } }, null)).toBe("brought back v3");
    expect(versionSaid({ kind: "fork", summary: "x" }, "Night Sky")).toBe("forked it from Night Sky");
  });
});
