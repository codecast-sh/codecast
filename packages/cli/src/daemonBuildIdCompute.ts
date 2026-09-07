// Computes the daemon build id: a content hash of every first party source
// file the daemon reaches through its imports.
//
// Why a static walker and not a bundle hash. Hashing `bun build` output ties
// the id to the bun version, and the three machines that compute it do not
// agree (CI pins one version, the release runner another, the laptop a third).
// A skew there would fail the check on code nobody touched. This walker reads
// the same bytes everywhere, so the id depends only on the source.
//
// What moves the id: any .ts file under packages/cli/src, packages/shared or
// platform/packages that the daemon reaches, and the `dependencies` block of
// packages/cli/package.json. What does not: the CLI version string (it changes
// every release, which is the whole thing this exists to stop), and the
// contents of a third party package (only its version range is hashed). That
// trade is deliberate. A dependency bump is a package.json edit.
//
// Not imported by daemon.ts. Editing this file does not change the id.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { walkDirsSync } from "./fsWalk.js";
import { BUILD_ID_CHARS } from "./daemonBuildGate.js";

/** The id length in hex characters. Long enough that a collision is not a
 *  practical concern, short enough to read in a log line. */
const ID_CHARS = BUILD_ID_CHARS;

/** The daemon source file this walk starts from, relative to the repo root. */
const ENTRY = "packages/cli/src/daemon.ts";

/** Excluded from the hash so stamping is not a fixed point chase: writing the
 *  new id into this file would otherwise change the id again. */
const EXCLUDED = "packages/cli/src/daemonBuildId.ts";

/** A string literal is a module specifier only when an import or export names
 *  it. `.import(` is a method call, not the operator. */
const SPECIFIER_POSITION_RE = /(?:^|[^\w$.])(from|import)\s*\(?\s*$/;

/**
 * Reduce a source file to the part a specifier scan may read: comments gone,
 * and every string literal emptied except the ones an import or export names.
 *
 * Both halves earn their place. A `from "./x.js"` inside a prose comment would
 * otherwise join the closure. So would `'ObjC.import("Foundation")'`, a shell
 * snippet this tree really does build as a string.
 */
export function codeForSpecifiers(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const keep = SPECIFIER_POSITION_RE.test(out);
      let body = "";
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") {
          body += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          closed = true;
          break;
        }
        body += src[i];
        i++;
      }
      out += quote + (keep ? body : "") + (closed ? quote : "");
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every module specifier a file names: static imports and exports, dynamic
 *  `import("...")`, and bare `import "..."`. */
export function scanSpecifiers(src: string): string[] {
  const code = codeForSpecifiers(src);
  const found = new Set<string>();
  for (const m of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(m[1]);
  for (const m of code.matchAll(/\bimport\s+["']([^"']+)["']/g)) found.add(m[1]);
  return [...found];
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Resolve a relative specifier the way the source tree means it: the code is
 *  written with .js extensions that TypeScript maps back to .ts on disk.
 *
 *  Only TypeScript sources resolve. A `./package.json` import must stay an
 *  external string: update.ts imports packages/cli/package.json for its VERSION
 *  constant, and hashing that file whole would put the release version inside
 *  the build id, which is the one thing the id must not depend on. The
 *  dependency ranges still contribute, added by hand at the end of the walk. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates: string[] = [];
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -3);
    candidates.push(stem + ".ts", stem + ".tsx");
  }
  if (/\.tsx?$/.test(base)) candidates.push(base);
  candidates.push(base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx"));
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

const lastSegment = (rel: string): string => rel.split(path.sep).pop() ?? "";

/** Every non-test .ts file under a directory. A platform package is taken
 *  whole: resolving its export map exactly would need the bundler back.
 *
 *  Order does not matter here: the caller sorts the whole file list before it
 *  hashes anything. */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  walkDirsSync(
    dir,
    {
      dirFilter: (rel) => {
        const seg = lastSegment(rel);
        return seg !== "node_modules" && !seg.startsWith(".");
      },
      fileFilter: (rel) => {
        const seg = lastSegment(rel);
        return /\.tsx?$/.test(seg) && !/\.(test|spec)\.tsx?$/.test(seg);
      },
    },
    (files) => {
      for (const f of files) out.push(f.path);
    },
  );
  return out;
}

/** The repo root: the nearest ancestor that holds the daemon entry file. */
export function findRepoRoot(start = path.dirname(new URL(import.meta.url).pathname)): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (isFile(path.join(dir, ENTRY))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export interface BuildIdResult {
  id: string;
  /** Repo relative paths of every hashed file, sorted. */
  files: string[];
  /** Specifiers the walk did not follow (node builtins, npm packages), sorted. */
  external: string[];
}

/**
 * Walk the daemon's import closure and hash it. Deterministic: the same tree
 * gives the same id on any machine and any bun version.
 */
export function computeDaemonBuildId(repoRoot = findRepoRoot()): BuildIdResult {
  const entry = path.join(repoRoot, ENTRY);
  const excluded = path.join(repoRoot, EXCLUDED);
  const sharedRoot = path.join(repoRoot, "packages/shared");
  const platformRoot = path.join(repoRoot, "platform/packages");

  const visited = new Set<string>();
  const external = new Set<string>();
  const queue: string[] = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let src: string;
    try {
      src = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const spec of scanSpecifiers(src)) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (resolved) queue.push(resolved);
        else external.add(spec);
        continue;
      }
      if (spec === "@codecast/shared" || spec.startsWith("@codecast/shared/")) {
        const sub = spec.slice("@codecast/shared".length).replace(/^\//, "");
        const base = sub ? path.join(sharedRoot, sub) : sharedRoot;
        const resolved = [base + ".ts", path.join(base, "index.ts")].find(isFile);
        if (resolved) queue.push(resolved);
        else external.add(spec);
        continue;
      }
      if (spec.startsWith("@platform/")) {
        const pkg = spec.split("/")[1];
        const src = path.join(platformRoot, pkg, "src");
        const files = allSourceFiles(src);
        if (files.length) for (const f of files) queue.push(f);
        else external.add(spec);
        continue;
      }
      external.add(spec);
    }
  }

  visited.delete(excluded);
  const files = [...visited].map((f) => path.relative(repoRoot, f)).sort();

  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(repoRoot, rel));
    hash.update(`${rel}\n${crypto.createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  for (const spec of [...external].sort()) hash.update(`external:${spec}\n`);

  // The dependency ranges, never the version. The version changes on every
  // release and hashing it would make every release a code change.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/cli/package.json"), "utf-8"));
    for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
      hash.update(`dep:${name}@${pkg.dependencies[name]}\n`);
    }
  } catch {}

  return { id: hash.digest("hex").slice(0, ID_CHARS), files, external: [...external].sort() };
}

export function renderBuildIdFile(id: string): string {
  return `// The daemon's build id: a content hash of every first party source file the
// daemon imports. Generated. Run \`bun scripts/stamp-daemon-build-id.ts\` from
// packages/cli after changing daemon code, and commit the result.
//
// It exists so a CLI release that did not touch daemon code does not bounce a
// daemon running 200 sessions. It is a VETO, never a trigger: every restart
// decision keeps its own precondition (a newer CLI version, a disk version
// mismatch, a finished self update) and only skips the restart when the ids
// match. Nothing here can cause a restart that would not happen anyway.
//
// This file is excluded from its own hash, and it imports nothing on purpose:
// the CLI fast path reads it, so it must never pull in a module graph.
export const DAEMON_BUILD_ID = "${id}";
`;
}
