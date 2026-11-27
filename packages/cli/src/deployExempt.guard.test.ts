import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileShipsTo } from "@codecast/shared/contracts/deployTargets";
import { checkoutTargets } from "./lineDeploy.js";
import { git } from "./wipSnapshot.js";

// A target's `unless` (.codecast/deploy.toml) says a change of only those files ships nothing there, so a change to
// one sends no deploy. That is a lie the moment a shipped file imports one: `cast bench` runs cli's test-helpers/
// and spawns bench/fixtures/http.cjs. This walks every file each target ships and fails on a reference, by import,
// require or `new URL(…, import.meta.url)`, to a file its `unless` exempts. A file read by a computed path
// (path.join) is not seen: keep such reads out of exempt directories.

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']|new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g;
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** A relative specifier as the file it names: `./x.js` is x.ts on disk, `./dir` its index. */
function resolve(from: string, spec: string, tracked: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.[cm]?js$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.js`]) if (tracked.has(c)) return c;
  return null;
}

describe("what a target's unless exempts ships nowhere", () => {
  test("no file a target ships references a file its unless exempts", async () => {
    const targets = (await checkoutTargets(ROOT)).filter((t) => t.unless?.length && t.paths.length);
    expect(targets.length).toBeGreaterThan(0);
    const tracked = new Set((await git(ROOT, ["ls-files"])).split("\n").filter(Boolean));
    const offenders: string[] = [];
    for (const t of targets) {
      const under = [...tracked].filter((f) => fileShipsTo({ paths: t.paths }, f));
      for (const file of under.filter((f) => CODE.test(f) && fileShipsTo(t, f))) {
        const text = fs.readFileSync(path.join(ROOT, file), "utf-8");
        for (const m of text.matchAll(SPECIFIER)) {
          const hit = resolve(file, m[1] ?? m[2], tracked);
          if (hit && fileShipsTo({ paths: t.paths }, hit) && !fileShipsTo(t, hit)) offenders.push(`${t.name}: ${file} reads ${hit}, which its unless exempts`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});
