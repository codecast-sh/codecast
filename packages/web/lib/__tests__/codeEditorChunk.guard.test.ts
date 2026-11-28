import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WEB, rel, staticImports, walk } from "../../test-helpers/importGraph";

// Contract 3 of docs/architecture/code-editor.md: the code editor never joins
// the main bundle. The app's entry and boot (src/main.tsx, src/boot.tsx, which
// every page loads) must not reach CodeMirror, its language packages, Lezer or
// vim through a static import. lib/code files may sit in boot's graph only
// while they import none of those (the command registry and session matching
// do today); the editor itself loads behind `import()` from Files, a path link
// or a diff. Measured 2026-11-26 (perf/README.md, "Editor"): boot is 2,383 KB
// gzipped and the editor adds 85 KB on top of the Files route.

const EDITOR_PACKAGES = /^(@codemirror\/|@replit\/codemirror|@lezer\/|codemirror$|@uiw\/)/;

/** Each path from the entry to a file that imports an editor package. */
function editorLeaks(entry: string): string[] {
  const out: string[] = [];
  for (const [file, chain] of walk(join(WEB, entry))) {
    const pkgs = staticImports(file).filter((s) => EDITOR_PACKAGES.test(s));
    if (pkgs.length) out.push(`${chain.join(" -> ")} imports ${pkgs.join(", ")}`);
  }
  return out;
}

describe("the code editor stays out of the main bundle", () => {
  test("the entry and boot reach no CodeMirror, Lezer or vim module", () => {
    expect(editorLeaks("src/main.tsx")).toEqual([]);
    expect(editorLeaks("src/boot.tsx")).toEqual([]);
  });

  test("the lib/code files boot reaches are the ones known to be CodeMirror-free", () => {
    const reached = [...walk(join(WEB, "src/boot.tsx")).keys()].map(rel).filter((p) => p.startsWith("lib/code/") || p.startsWith("components/code/"));
    // A new entry here is fine only if it imports no editor package (the test
    // above says so); list it to keep the boundary a decision, not a drift.
    expect(reached.sort()).toEqual(["lib/code/agent/sessions.ts", "lib/code/commands.ts"]);
  });

  test("the walker sees the editor (a self check: the editor host is a leak)", () => {
    expect(editorLeaks("lib/code/editorHost.ts").length).toBeGreaterThan(0);
  });
});
