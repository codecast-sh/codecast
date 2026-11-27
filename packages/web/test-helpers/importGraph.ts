// The static import graph of the web app, walked the way the bundler walks it:
// relative paths, the `@/` root and the tsconfig/vite aliases, `import type`
// erased, and `import()` left out (a dynamic import is a chunk boundary that
// loads when it runs). Guard tests use it to say what an entry may and may not
// reach (lib/__tests__/standaloneBootGraph.guard.test.ts,
// lib/__tests__/codeEditorChunk.guard.test.ts).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const WEB = resolve(import.meta.dir, "..");
export const ALIASES: Record<string, string> = {
  "next/navigation": "src/compat/next-navigation.ts",
  "next/link": "src/compat/next-link.tsx",
};

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;

function resolveFile(base: string): string | null {
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** The web file a specifier names, or null for a package. */
export function resolveSpec(from: string, spec: string): string | null {
  if (ALIASES[spec]) return join(WEB, ALIASES[spec]);
  if (spec.startsWith("@/")) return resolveFile(join(WEB, spec.slice(2)));
  if (spec.startsWith(".")) return resolveFile(resolve(dirname(from), spec));
  return null;
}

/** The value (not type-only) specifiers a file imports statically. */
export function staticImports(file: string): string[] {
  if (!/\.(ts|tsx)$/.test(file)) return [];
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) if (!m[1]) out.push(m[2]);
  return out;
}

export function rel(p: string): string {
  return relative(WEB, p);
}

/** Every web file the entry reaches, with the chain that reached it. */
export function walk(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [rel(entry)]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of staticImports(file)) {
      const target = resolveSpec(file, spec);
      if (!target || seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, rel(target)]);
      queue.push(target);
    }
  }
  return seen;
}
