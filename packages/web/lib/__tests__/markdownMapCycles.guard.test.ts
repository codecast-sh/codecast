import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { WEB_ROOT, walkSources } from "./sourceWalk";

// MARKDOWN COMPONENT-MAP CYCLE GUARD.
//
// The markdown pipeline modules build their react-markdown component maps at
// module top level (`export const MESSAGE_MD_COMPONENTS = { p: ImageRowParagraph, … }`).
// A top-level read happens while the module evaluates, so every binding it reads
// must already be initialized. Rollup lays a chunk out in dependency order, but
// an import CYCLE forces it to pick a break point, and a map module can then run
// before a module it imports from. A `const` binding read across that break is
// in its temporal dead zone: "ReferenceError: Cannot access 'i6' before
// initialization", the whole chunk fails to evaluate, and the page never leaves
// the boot splash (prod, 2026-09-22: messageMarkdown reached ImageRowParagraph
// through MarkdownRenderer's re-export, and MarkdownRenderer sat on a cycle
// back to messageMarkdown via EntityIdPill → TaskCommentStream → ChatMessage).
//
// A `function` declaration is hoisted, so it survives the same break; that is
// why the EntityAware* imports on the very same cycle never failed. The rule:
// a map module may import a binding from a module that has a path back to it
// ONLY if that module declares the binding itself as a hoisted function. A
// `const` (arrow component, object, array) must come from a module with no
// path back, and never through a re-export on a cyclic module.
//
// The emission order depends on which module the bundler enters first, so a
// cycle that happens to be safe today flips the day an unrelated import moves.
// This guard fails on the shape, not on the luck.

const MAP_MODULES = [
  "components/messageMarkdown.tsx",
  "lib/conversationMarkdown.tsx",
  "lib/markdownComponents.tsx",
];

const DIRS = ["app", "components", "hooks", "lib", "store", "shortcuts"];
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const e of EXTS) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

type Edge = { target: string; bindings: string[]; reexport: boolean };

// Static, value-level imports (and `export … from` re-exports) of one file.
// `import type` and dynamic `import()` never order evaluation and are skipped.
const IMPORT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s*['"]([^'"]+)['"]/g;

export function importEdges(file: string, source: string): Edge[] {
  const out: Edge[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const [, kind, typeOnly, clause, spec] = m;
    if (typeOnly) continue;
    const target = resolveImport(file, spec);
    if (!target) continue;
    const bindings = (clause.match(/\{([^}]*)\}/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("type "))
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    out.push({ target, bindings, reexport: kind === "export" });
  }
  return out;
}

const graph = new Map<string, Edge[]>();
for (const dir of DIRS) {
  for (const f of walkSources(join(WEB_ROOT, dir))) graph.set(f, importEdges(f, readFileSync(f, "utf8")));
}

// Shortest static-import path from `from` to `to`, as repo-relative files.
export function importPath(from: string, to: string): string[] | null {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { target } of graph.get(cur) ?? []) {
      if (prev.has(target)) continue;
      prev.set(target, cur);
      if (target === to) {
        const path: string[] = [];
        for (let c: string | null = to; c; c = prev.get(c)!) path.unshift(relative(WEB_ROOT, c));
        return path;
      }
      queue.push(target);
    }
  }
  return null;
}

// The names a file declares as hoisted functions (`export function X`).
function hoistedExports(file: string): Set<string> {
  const src = readFileSync(file, "utf8");
  return new Set([...src.matchAll(/^export\s+(?:async\s+)?function\s+([\w$]+)/gm)].map((m) => m[1]));
}

describe("markdown component maps never read a const across an import cycle", () => {
  for (const rel of MAP_MODULES) {
    test(rel, () => {
      const file = join(WEB_ROOT, rel);
      const problems: string[] = [];
      for (const { target, bindings } of graph.get(file) ?? []) {
        const back = importPath(target, file);
        if (!back) continue;
        const hoisted = hoistedExports(target);
        const unsafe = bindings.filter((b) => !hoisted.has(b));
        if (unsafe.length === 0) continue;
        problems.push(
          `${unsafe.join(", ")} from ${relative(WEB_ROOT, target)} — that module reaches back into ${rel}:\n      ${back.join("\n   -> ")}`,
        );
      }
      expect(
        problems,
        `Import these bindings from the module that declares them (one with no path back), or declare them as hoisted functions:\n  ${problems.join("\n  ")}`,
      ).toEqual([]);
    });
  }
});
