// The docs shots mode (lib/docsShots) and the Acme fixture world it seeds
// (lib/acmeWorld) must never reach a production bundle. Production folds
// `DOCS_SHOTS` to false, which drops the one dynamic import of the mode in
// src/main.tsx; a static import anywhere else would ship the fixture world
// (and its fake sign-in) to every visitor. Only lib/docsShots/flag.ts, which
// holds no fixtures, may be imported by app code.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = join(import.meta.dir, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-ssr", "dist-perf", "public", "docs-shots", "scripts", "e2e", "test-helpers", "__tests__"]);
const SKIP_PREFIXES = ["lib/acmeWorld/", "lib/docsShots/"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".") || name.startsWith("__harness")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("docs shots stay out of production code", () => {
  test("only the flag is imported outside the mode, and the mode only behind it in main.tsx", () => {
    const offenders: string[] = [];
    for (const file of sources(WEB)) {
      const rel = relative(WEB, file);
      if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']*(?:acmeWorld|docsShots)[^"']*)["']/g)) {
        const spec = m[1];
        if (/docsShots\/flag$/.test(spec)) continue;
        if (rel === "src/main.tsx" && /docsShots\/install$/.test(spec) && m[0].startsWith("import")) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("main.tsx loads the mode only when the flag is on", () => {
    const main = readFileSync(join(WEB, "src/main.tsx"), "utf-8");
    expect(main).toMatch(/if \(DOCS_SHOTS\) void import\("\.\.\/lib\/docsShots\/install"\)/);
  });

  test("the flag is off in production builds", () => {
    const flag = readFileSync(join(WEB, "lib/docsShots/flag.ts"), "utf-8");
    expect(flag).toMatch(/DOCS_SHOTS = import\.meta\.env\.DEV && /);
  });
});
