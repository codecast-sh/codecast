import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// THE source walker the guard tests share. Every guard is an allowlist plus
// a pattern over the same file set; the walk and the comment stripping live
// here once so no guard carries its own copy of the skip list.

export const WEB_ROOT = join(import.meta.dir, "..", "..");
export const MOBILE_ROOT = join(WEB_ROOT, "..", "mobile");

const SKIP_DIRS = new Set(["node_modules", "__tests__", ".next", ".expo", "dist", "ios", "android"]);

// Every non-test .ts/.tsx source under `dir` (recursive). `keepTests` walks
// __tests__ directories too, for guards that police test files.
export function walkSources(dir: string, opts: { keepTests?: boolean } = {}, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) && !(opts.keepTests && name === "__tests__")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSources(full, opts, out);
    else if (/\.tsx?$/.test(name) && (opts.keepTests || !/\.test\.tsx?$/.test(name))) out.push(full);
  }
  return out;
}

// The file's lines with comment lines dropped (line comments and block
// comment bodies), numbered 1-based, so a mention in prose never counts.
export function codeLines(src: string): Array<{ line: string; n: number }> {
  const out: Array<{ line: string; n: number }> = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    out.push({ line, n: i + 1 });
  });
  return out;
}

// `${rel}:${n}: ${line}` for every code line under `dirs` (relative to
// `root`) that matches `token`, skipping allowlisted files.
export function offendersUnder(
  root: string,
  dirs: readonly string[],
  token: RegExp,
  allowed: ReadonlyMap<string, string> = new Map(),
): string[] {
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const file of walkSources(join(root, dir))) {
      const rel = file.slice(root.length + 1);
      if (allowed.has(rel)) continue;
      for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
        if (token.test(line)) offenders.push(`${rel}:${n}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}
