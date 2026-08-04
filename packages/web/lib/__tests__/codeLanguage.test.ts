import { describe, expect, test } from "bun:test";
import { highlightCode, languageForPath } from "../codeLanguage";

describe("languageForPath", () => {
  test("maps the extensions a repo is actually made of", () => {
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("src/App.tsx")).toBe("tsx");
    expect(languageForPath("main.py")).toBe("python");
    expect(languageForPath("cmd/main.go")).toBe("go");
    expect(languageForPath("lib.rs")).toBe("rust");
    expect(languageForPath("config.yml")).toBe("yaml");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("build.sh")).toBe("bash");
  });

  test("is case-insensitive and reads only the last extension", () => {
    expect(languageForPath("SRC/INDEX.TS")).toBe("typescript");
    // A minified bundle is still javascript; the size cap, not the name, is
    // what keeps it out of the viewer.
    expect(languageForPath("dist/app.min.js")).toBe("javascript");
  });

  test("extensionless names we know still get a grammar", () => {
    expect(languageForPath("Dockerfile")).toBe("bash");
    expect(languageForPath("build/Makefile")).toBe("bash");
  });

  test("returns undefined rather than guessing, so text renders unstyled", () => {
    // Prism has no grammar loaded for these. Plain text is readable; a wrong
    // grammar paints half the file the wrong color.
    expect(languageForPath("notes/plan.txt")).toBeUndefined();
    expect(languageForPath(".gitignore")).toBeUndefined();
    expect(languageForPath("noextension")).toBeUndefined();
    expect(languageForPath("main.zig")).toBeUndefined();
  });
});

describe("highlightCode", () => {
  test("returns markup for a known grammar", () => {
    const html = highlightCode("const a = 1;", "typescript");
    expect(html).toContain("token");
    expect(html).toContain("const");
  });

  test("resolves the aliases people write in fences", () => {
    expect(highlightCode("const a = 1;", "ts")).toContain("token");
    expect(highlightCode("echo hi", "shell")).toContain("token");
  });

  test("returns null — never a string — when there is no grammar", () => {
    // The caller renders raw text on null. Returning "" here would inject an
    // empty <code> and the file would look blank.
    expect(highlightCode("anything", "klingon")).toBeNull();
    expect(highlightCode("anything", undefined)).toBeNull();
  });
});
