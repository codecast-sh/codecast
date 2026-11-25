// Shared by the @convex-dev/auth patch scripts in this directory.

import { existsSync, readFileSync, writeFileSync, globSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function copies(rel) {
  // Every copy in the tree, not just the root one. bun gives each workspace
  // package its own node_modules entry, and a test resolves the package from
  // ITS package (packages/web), so a patch applied only at the root can be
  // invisible to the file that reads it. Resolving each path to its real
  // location collapses the symlinks, so a shared copy is patched once.
  const roots = [
    "node_modules/@convex-dev/auth",
    ...globSync("node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth"),
    ...globSync("packages/*/node_modules/@convex-dev/auth"),
    ...globSync("packages/*/node_modules/.bun/@convex-dev+auth@*/node_modules/@convex-dev/auth"),
  ];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const key = realpathSync(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export const rewriter = (tag) => (file, fn) => {
  if (!existsSync(file)) return;
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) return;
  writeFileSync(file, after);
  console.log(`[${tag}] Patched ${file}`);
};
