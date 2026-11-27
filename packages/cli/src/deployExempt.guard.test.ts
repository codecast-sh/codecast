import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileShipsTo } from "@codecast/shared/contracts/deployTargets";
import { checkoutTargets } from "./lineDeploy.js";
import { git } from "./wipSnapshot.js";

// A target's `unless` (.codecast/deploy.toml) says a change of only those files ships nothing there, so a change to
// one sends no deploy. That is a lie the moment a shipped file imports one: `cast bench` runs cli's test-helpers/
// and spawns bench/fixtures/http.cjs. This walks every file each target ships and fails on a reference, by import,
// require or `new URL(…, import.meta.url)`, relative or through a workspace package's exports
// (`@codecast/shared/contracts/__fixtures__/…`), to a file its `unless` exempts. A file read by a computed path
// (path.join) is not seen: keep such reads out of exempt directories.

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']|new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url|\b(?:from|import|require)\s*\(?\s*["']((?:@[\w.-]+\/)?[\w.-]+(?:\/[^"']*)?)["']/g;
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** A relative specifier as the file it names: `./x.js` is x.ts on disk, `./dir` its index. */
function resolve(from: string, spec: string, tracked: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.[cm]?js$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.js`]) if (tracked.has(c)) return c;
  return null;
}

type Pkg = { dir: string; exports: unknown };

/** The repository's workspace packages by name, each with its exports: `@codecast/shared/contracts/x` resolves through them. */
function workspacePackages(tracked: Set<string>): Map<string, Pkg> {
  const out = new Map<string, Pkg>();
  for (const f of tracked) {
    if (!f.endsWith("package.json")) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf-8"));
      if (typeof pkg.name === "string") out.set(pkg.name, { dir: path.posix.dirname(f), exports: pkg.exports });
    } catch { /* not a package */ }
  }
  return out;
}

/** An export's target: a string, or a condition table's import/bun/default (the first string it holds). */
function exportTarget(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  for (const k of ["bun", "import", "default", ...Object.keys(o)]) { const t = exportTarget(o[k]); if (t) return t; }
  return null;
}

/** A package specifier as the file it names: through the package's exports (a `*` pattern included), else its path. */
function resolvePackage(spec: string, pkgs: Map<string, Pkg>, tracked: Set<string>): string | null {
  const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(spec);
  const pkg = m && pkgs.get(m[1]);
  if (!pkg) return null;
  const sub = `.${m![2] ?? ""}`;
  let target: string | null = null;
  if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) && Object.keys(pkg.exports).some((k) => k.startsWith("."))) {
    const table = pkg.exports as Record<string, unknown>;
    target = exportTarget(table[sub]);
    for (const [k, v] of Object.entries(table)) {
      if (target || !k.includes("*")) continue;
      const [pre, post] = k.split("*");
      if (sub.startsWith(pre) && sub.endsWith(post)) target = exportTarget(v)?.replace("*", sub.slice(pre.length, sub.length - post.length)) ?? null;
    }
  } else if (sub === "." && typeof pkg.exports === "string") target = pkg.exports;
  return resolve(`${pkg.dir}/package.json`, target ?? sub, tracked);
}

describe("what a target's unless exempts ships nowhere", () => {
  test("no file a target ships references a file its unless exempts", async () => {
    const targets = (await checkoutTargets(ROOT)).filter((t) => t.unless?.length && t.paths.length);
    expect(targets.length).toBeGreaterThan(0);
    const tracked = new Set((await git(ROOT, ["ls-files"])).split("\n").filter(Boolean));
    const pkgs = workspacePackages(tracked);
    const offenders: string[] = [];
    for (const t of targets) {
      const under = [...tracked].filter((f) => fileShipsTo({ paths: t.paths }, f));
      for (const file of under.filter((f) => CODE.test(f) && fileShipsTo(t, f))) {
        const text = fs.readFileSync(path.join(ROOT, file), "utf-8");
        for (const m of text.matchAll(SPECIFIER)) {
          const hit = m[3] ? resolvePackage(m[3], pkgs, tracked) : resolve(file, m[1] ?? m[2], tracked);
          if (hit && fileShipsTo({ paths: t.paths }, hit) && !fileShipsTo(t, hit)) offenders.push(`${t.name}: ${file} reads ${hit}, which its unless exempts`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});
