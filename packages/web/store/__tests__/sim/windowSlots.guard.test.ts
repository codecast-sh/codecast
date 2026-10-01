// Every module binding the sim can reach is classified
// (docs/architecture/multiplayer-sim-harness.md, section 3.3).
//
// The sim runs several windows in one process, so a module-level `let`, Map or
// Set that production keeps per window would silently leak between simulated
// windows. This walks the import graph from every sim file, collects the
// top-level `let`/`var` and `const X = new Map|Set` bindings of
// packages/web/{store,hooks,lib}, and fails on any binding sim/windowSlots.ts
// does not classify, printing the line to add. It also fails on a classified
// binding that no longer exists, so the table never lies.
//
// Static: it reads source text and imports no store (windowSlots.ts reaches
// the store only lazily, inside the functions this test never calls).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildBootGraph } from "../../../../cli/src/bench/bootGraph";
import { WINDOW_SLOTS } from "./windowSlots";

const SIM = import.meta.dir;
const WEB = join(SIM, "../../..");
const GUARDED = /^(store|hooks|lib)\//;
const SKIP = /(^|\/)__tests__\/|\.test\.tsx?$/;

/** Top-level mutable bindings of one source file, in source order. Prettier keeps top-level declarations at column 0. */
export function topLevelBindings(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^(?:export\s+)?(?:let|var)\s+([\w$]+)/gm)) out.push(m[1]);
  for (const m of source.matchAll(/^(?:export\s+)?const\s+([\w$]+)\b[^\n]*?=\s*new\s+(?:Map|Set)\b/gm)) out.push(m[1]);
  return out;
}

function simRoots(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return simRoots(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".guard.test.ts") ? [p] : [];
  });
}

// The graph walk reads several hundred files: slow on a loaded machine.
const WALK_TIMEOUT = 120_000;

describe("sim window slots", () => {
  test(
    "every top-level binding the sim can reach is classified in WINDOW_SLOTS",
    () => {
      const graph = buildBootGraph(simRoots(SIM), undefined, {
        calls: true,
        alias: (spec) => (spec.startsWith("@/") ? join(WEB, spec.slice(2)) : null),
      });
      const files = [...graph.nodes.keys()]
        .map((f) => relative(WEB, f))
        .filter((f) => GUARDED.test(f) && !SKIP.test(f))
        .sort();
      // A walk that stops at the sim's own files would pass vacuously.
      expect(files).toContain("store/inboxStore.ts");

      const missing: string[] = [];
      for (const file of files) {
        for (const binding of topLevelBindings(readFileSync(join(WEB, file), "utf8"))) {
          if (!(`${file}:${binding}` in WINDOW_SLOTS)) {
            missing.push(`  "${file}:${binding}": "window" | "memo" | "transient" | { shared: "<why one copy is right>" },`);
          }
        }
      }
      expect(
        missing.join("\n"),
        `unclassified module bindings reachable from the sim; add each to WINDOW_SLOTS in sim/windowSlots.ts (a window binding also needs a seam):\n${missing.join("\n")}\n`,
      ).toBe("");
    },
    WALK_TIMEOUT,
  );

  test("every classified binding still exists", () => {
    const stale = Object.keys(WINDOW_SLOTS).filter((key) => {
      const file = key.slice(0, key.lastIndexOf(":"));
      const path = join(WEB, file);
      return !existsSync(path) || !topLevelBindings(readFileSync(path, "utf8")).includes(key.slice(file.length + 1));
    });
    expect(stale, "WINDOW_SLOTS entries naming a binding that is gone; remove them").toEqual([]);
  });

  test("the extractor sees the shapes it is meant to", () => {
    const src = [
      "let a = 0;",
      "export let b: string | null = null;",
      "var c;",
      "const d = new Map<string, (x: number) => void>();",
      "export const e: ReadonlySet<string> = new Set(['x']);",
      "const f = new WeakMap();",
      "const g = { h: new Map() };",
      "function k() {",
      "  let inner = 1;",
      "}",
    ].join("\n");
    expect(topLevelBindings(src).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
});
