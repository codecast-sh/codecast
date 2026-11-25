import { describe, expect, test } from "bun:test";
import { rankPaletteFiles } from "../paletteFiles";

const files = {
  "docs/editor.md": { mtime: 3 },
  "lib/code/editorHost.ts": { mtime: 2 },
  "lib/code/editorHost.test.ts": { mtime: 1 },
  "assets/editor.png": { mtime: 1 },
  "lib/code": { dir: true, mtime: 0 },
};

describe("palette file results", () => {
  test("a local vault lists code files beside notes", () => {
    const { notes, code } = rankPaletteFiles(files, "editor", { includeCode: true, cap: 8 });
    expect(notes.map((n) => [n.path, n.base, n.kind])).toEqual([["docs/editor.md", "editor", "note"]]);
    expect(code.map((c) => c.path)).toEqual(["lib/code/editorHost.ts", "lib/code/editorHost.test.ts"]);
    expect(code[0]).toMatchObject({ base: "editorHost.ts", kind: "code" });
  });

  test("a mirror lists notes only; binaries and folders never", () => {
    const { notes, code } = rankPaletteFiles(files, "editor", { includeCode: false, cap: 8 });
    expect(notes).toHaveLength(1);
    expect(code).toHaveLength(0);
    expect(rankPaletteFiles(files, "png", { includeCode: true, cap: 8 }).code).toHaveLength(0);
    expect(rankPaletteFiles(files, "", { includeCode: true, cap: 8 })).toEqual({ notes: [], code: [] });
  });

  test("each kind is capped", () => {
    expect(rankPaletteFiles(files, "editor", { includeCode: true, cap: 1 }).code).toHaveLength(1);
  });
});
