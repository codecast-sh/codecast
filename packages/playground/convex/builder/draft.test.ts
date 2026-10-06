import { describe, expect, test } from "bun:test";
import { seedFiles } from "../lib/seed";
import { Draft, DraftError, draftProblems, importSpecifiers, resolveRelative } from "./draft";

const seed = () => new Draft(seedFiles("Frog Choir"));

describe("Draft operations", () => {
  test("edit replaces exactly one occurrence and refuses ambiguity", () => {
    const d = new Draft([{ path: "index.html", text: "a b a" }]);
    expect(() => d.edit("index.html", "a", "x")).toThrow(/appears 2 times/);
    expect(() => d.edit("index.html", "zzz", "x")).toThrow(/was not found/);
    expect(d.edit("index.html", "a b", "c")).toBe("Edited index.html.");
    expect(d.read("index.html")).toBe("c a");
    expect(d.edit("./index.html", "c", "$&$1", true)).toBe("Edited index.html.");
    expect(d.read("index.html")).toBe("$&$1 a");
  });

  test("paths are normalized and bad ones are refused in words the agent can use", () => {
    const d = seed();
    expect(d.write("./src/Board.jsx", "export default 1;")).toBe("Created src/Board.jsx (17 bytes).");
    expect(d.has("src/Board.jsx")).toBe(true);
    expect(() => d.write("../escape.js", "")).toThrow(DraftError);
    expect(() => d.write("src/photo.png", "")).toThrow(/not a path a version can hold/);
    expect(() => d.remove("index.html")).toThrow(/cannot be deleted/);
    expect(() => d.read("src/Nope.jsx")).toThrow(/does not exist/);
  });

  test("touched lists changed files first, then files only read", () => {
    const d = seed();
    d.read("src/main.jsx");
    d.read("src/App.jsx");
    d.edit("src/App.jsx", "Wave hello", "Croak");
    d.write("src/Pond.jsx", "export const Pond = () => null;");
    d.remove("src/styles.css");
    expect(d.touched()).toEqual([
      { path: "src/App.jsx", how: "wrote" },
      { path: "src/styles.css", how: "deleted" },
      { path: "src/Pond.jsx", how: "wrote" },
      { path: "src/main.jsx", how: "read" },
    ]);
    expect(d.changed()).toBe(true);
  });

  test("writing a file back to its base text is not a change", () => {
    const d = seed();
    const text = d.read("src/App.jsx");
    d.write("src/App.jsx", text);
    expect(d.changed()).toBe(false);
  });
});

describe("draftProblems", () => {
  test("the seed passes, so every first build starts from a valid draft", () => {
    expect(draftProblems(seedFiles("Frog Choir"))).toEqual([]);
  });

  test("a syntax error names the file", () => {
    const d = seed();
    d.edit("src/App.jsx", "<main className=\"stage\">", "<main className=\"stage\"");
    const problems = draftProblems(d.snapshot());
    expect(problems.length).toBe(1);
    expect(problems[0]).toStartWith("src/App.jsx:");
  });

  test("an import of a missing file is caught before it can white-screen the app", () => {
    const d = seed();
    d.edit("src/App.jsx", 'import { useState } from "react";', 'import { useState } from "react";\nimport Pond from "./Pond.jsx";');
    expect(draftProblems(d.snapshot())).toEqual(['src/App.jsx imports "./Pond.jsx", but src/Pond.jsx does not exist']);
  });

  test("CSS imported from JavaScript, root paths and unmapped packages are refused with a fix", () => {
    const d = seed();
    d.edit(
      "src/main.jsx",
      'import App from "./App.jsx";',
      'import App from "./App.jsx";\nimport "./styles.css";\nimport confetti from "canvas-confetti";\nimport x from "/src/App.jsx";',
    );
    const problems = draftProblems(d.snapshot());
    expect(problems).toContain('src/main.jsx imports the stylesheet "./styles.css"; browsers cannot import CSS from JavaScript, so link it from index.html instead');
    expect(problems.some((p) => p.includes('"canvas-confetti", which the import map does not name') && p.includes("https://esm.sh/"))).toBe(true);
    expect(problems.some((p) => p.includes('"/src/App.jsx"; use a relative path'))).toBe(true);
  });

  test("URL imports and import map entries pass", () => {
    const d = seed();
    d.edit("src/main.jsx", 'import App from "./App.jsx";', 'import App from "./App.jsx";\nimport confetti from "https://esm.sh/canvas-confetti@1";\nimport { flushSync } from "react-dom";');
    expect(draftProblems(d.snapshot())).toEqual([]);
  });

  test("index.html must load files that exist, and keep a readable import map", () => {
    const d = seed();
    d.edit("index.html", 'href="src/styles.css"', 'href="src/style.css"');
    d.edit("index.html", '"imports": {', '"imports": {,');
    const problems = draftProblems(d.snapshot());
    expect(problems).toContain('index.html loads "src/style.css", which does not exist');
    expect(problems.some((p) => p.startsWith("the import map in index.html is not valid JSON"))).toBe(true);
  });

  test("losing index.html is a problem", () => {
    expect(draftProblems([{ path: "src/main.js", text: "" }])).toContain("index.html is missing");
  });
});

describe("module references", () => {
  test("importSpecifiers finds static, side effect, re-export and dynamic imports, skipping comments", () => {
    const code = [
      'import React, { useState } from "react";',
      "import {",
      "  a,",
      '} from "./a.js";',
      'import "./side.js";',
      'export { b } from "./b.js";',
      'const c = await import("./c.js");',
      '// import d from "./d.js";',
    ].join("\n");
    expect(importSpecifiers(code).sort()).toEqual(["./a.js", "./b.js", "./c.js", "./side.js", "react"]);
  });

  test("resolveRelative stays inside the app", () => {
    expect(resolveRelative("src/App.jsx", "./Pond.jsx")).toBe("src/Pond.jsx");
    expect(resolveRelative("src/parts/A.jsx", "../B.jsx?v=1")).toBe("src/B.jsx");
    expect(resolveRelative("index.html", "src/main.jsx")).toBe("src/main.jsx");
    expect(resolveRelative("src/App.jsx", "../../x.js")).toBeNull();
  });
});
