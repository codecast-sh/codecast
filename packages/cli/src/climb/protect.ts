// What grades a candidate, and the checks that a candidate's tree left it
// alone (flows.md FL10). Everything here is derived from git at the base and
// from the disk, never from the climb's own state, so a station that rewrites
// the state cannot widen what a candidate may touch.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "../proc.js";
import type { EnvDeclaration } from "@codecast/shared/contracts/envs";
import { CLIMB_ALWAYS_PROTECTED, commandPaths, globMatch, protectedTouches } from "@codecast/shared/contracts/climb";

const sha = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");
export const tryGit = (root: string, args: string[]) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };

/** `$name` and `${name}` filled from `env`, so `$project_path/x.sh` reads as the file it is. */
export const fillVars = (command: string, env: Record<string, string | undefined>) => command.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, k) => env[k] ?? whole);

/**
 * The files a command starts, as the base holds them, and the directory each
 * sits in (what a runner imports usually lives beside it). A runner should
 * live in a directory of its own: one in the repo's root holds only itself.
 */
export function commandFiles(root: string, base: string, command: string, env: Record<string, string | undefined> = {}, depth = 0): string[] {
  const filled = fillVars(command, env);
  const atBase = (p: string) => tryGit(root, ["cat-file", "-t", `${base}:${p}`]) === "blob";
  const files = commandPaths(filled, root).filter(atBase);
  // A package script runs its own command: follow it (a few levels), so `bun run eval` pins what `eval` runs, not only package.json.
  if (depth < 3) {
    for (const m of filled.matchAll(/(?:^|[\s;&|(])(?:npm|bun|pnpm|yarn)\s+(?:run(?:-script)?\s+([\w:.-]+)|(test)\b)/g)) {
      const name = m[1] ?? m[2];
      if (/[/.]/.test(name) && !/^[\w-]+:[\w:-]+$/.test(name)) continue;
      for (const pkg of files.filter((f) => f === "package.json" || f.endsWith("/package.json"))) {
        let script: unknown;
        try { script = JSON.parse(tryGit(root, ["show", `${base}:${pkg}`]) ?? "{}")?.scripts?.[name]; } catch { continue; }
        const dir = path.posix.dirname(pkg);
        if (typeof script === "string") files.push(...commandFiles(root, base, dir === "." ? script : `cd ${dir} && ${script}`, env, depth + 1).filter((f) => !f.endsWith("/**")));
      }
    }
  }
  // The script files a command reaches are what grade; package.json and Makefile alone pin only the recipe, so they never count as a pinned file by themselves.
  return [...new Set(files.flatMap((f) => (f.includes("/") && !/(^|\/)(package\.json|Makefile)$/.test(f) ? [f, `${path.posix.dirname(f)}/**`] : [f])))];
}

/** Whether a command's pinned files hold anything beyond package.json and Makefile, the recipes that name the real gate. */
export const pinsAScript = (files: readonly string[]) => files.some((f) => !/(^|\/)(package\.json|Makefile)$/.test(f));

/** Every glob that grades: the always protected set, each env's `protects`, and each env command's files with their directories. */
export function gradingGlobs(root: string, base: string, decls: readonly EnvDeclaration[]): string[] {
  return [...new Set([...CLIMB_ALWAYS_PROTECTED, ...decls.flatMap((d) => [...(d.protects ?? []), ...commandFiles(root, base, d.command)])])];
}

/** One digest of every file under `globs` as checked out in `dir` (node_modules and .git skipped: they have their own checks). */
export function protectedDigest(dir: string, globs: readonly string[]): string {
  const prefixes = [...new Set(globs.map((g) => g.split(/[*?[]/)[0].replace(/[^/]*$/, "")).filter(Boolean))];
  const files: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(sub);
      else if (globs.some((g) => globMatch(g, sub))) files.push(sub);
    }
  };
  for (const p of prefixes) {
    const at = p.replace(/\/$/, "");
    if (fs.existsSync(path.join(dir, at)) && fs.statSync(path.join(dir, at)).isDirectory()) walk(at);
  }
  for (const g of globs) if (!/[*?[]/.test(g) && fs.existsSync(path.join(dir, g)) && fs.statSync(path.join(dir, g)).isFile()) files.push(g);
  return sha([...new Set(files)].sort().map((f) => `${f}\0${sha(fs.readFileSync(path.join(dir, f)))}`).join("\n"));
}

/** The packages a set of files names in its imports and requires: `zod`, `@scope/pkg`, never a relative path or a node builtin. */
export function importedPackages(sources: readonly string[]): string[] {
  const names = new Set<string>();
  const spec = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
  for (const text of sources) for (const m of text.matchAll(spec)) {
    const raw = m[1];
    if (raw.startsWith("node:") || raw.startsWith("bun:")) continue;
    const parts = raw.split("/");
    names.add(raw.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
  return [...names].sort();
}

/**
 * The installed packages the files that grade import, as the checkout holds
 * them: every tree the climb runs in links the checkout's node_modules live
 * (envCommand withTreeAt), so a grader package edited there after gauge would
 * grade both sides with someone's edit. Each is found the way Node resolves
 * it, from the importing file's directory up to the repo root.
 */
export function graderPackageDirs(root: string, base: string, globs: readonly string[]): string[] {
  const files = (tryGit(root, ["ls-tree", "-r", "--name-only", base]) ?? "").split("\n").filter((f) => /\.(m?[jt]sx?|cjs)$/.test(f) && !f.includes("node_modules/") && globs.some((g) => globMatch(g, f)));
  const dirs = new Set<string>();
  for (const f of files) {
    const text = tryGit(root, ["show", `${base}:${f}`]) ?? "";
    for (const name of importedPackages([text])) {
      for (let d = path.posix.dirname(f); ; d = path.posix.dirname(d)) {
        const rel = d === "." ? `node_modules/${name}` : `${d}/node_modules/${name}`;
        if (fs.existsSync(path.join(root, rel))) { dirs.add(rel); break; }
        if (d === ".") break;
      }
    }
  }
  return [...dirs].sort();
}

/**
 * The lockfile's integrity entry for an installed package at `rel`
 * (`node_modules/x` or `pkg/node_modules/x`), from the nearest lockfile up:
 * package-lock.json (its `packages` map), bun.lock (`"x": ["x@1.2.3", ..., "sha512-..."]`)
 * or yarn.lock (an `integrity` line under `x@...:`). Empty when no lockfile
 * names it.
 */
function lockIntegrity(root: string, rel: string, name: string, version: string): string {
  const parts = rel.split("/node_modules/")[0];
  const dirs = rel.startsWith("node_modules/") ? [""] : [parts, ...parts.split("/").map((_, i, a) => a.slice(0, a.length - 1 - i).join("/"))];
  for (const d of [...new Set(dirs)]) {
    const at = (f: string) => path.join(root, d, f);
    try {
      const lock = JSON.parse(fs.readFileSync(at("package-lock.json"), "utf8"));
      const hit = lock?.packages?.[rel.slice(d ? d.length + 1 : 0)] ?? lock?.packages?.[`node_modules/${name}`];
      if (hit?.integrity) return hit.integrity;
    } catch {}
    try {
      const text = fs.readFileSync(at("bun.lock"), "utf8");
      // A package's entry is one line: "x": ["x@1.2.3", "", { ...deps }, "sha512-..."].
      const line = text.split("\n").find((l) => l.includes(`["${name}@${version}"`));
      const m = line?.match(/"(sha\d+-[^"]+)"/);
      if (m) return m[1];
    } catch {}
    try {
      const text = fs.readFileSync(at("yarn.lock"), "utf8");
      const block = text.split(/\n(?=\S)/).find((b) => b.split("\n")[0].split(/,\s*/).some((k) => k.replace(/^"|"?:?$/g, "").startsWith(`${name}@`)) && b.includes(`version "${version}"`));
      const m = block?.match(/integrity\s+"?([^"\s]+)/);
      if (m) return m[1];
    } catch {}
  }
  return "";
}

/**
 * Those packages as what can change a grade: each one's name and version
 * from its package.json, and its lockfile integrity entry. A shared checkout's
 * installed files are touched all day by other sessions (caches, rebuilds,
 * timestamps), and none of that moves a grade; a different version or a
 * different tarball does. A package with no lockfile entry is read by its
 * package.json alone.
 */
export function packagesPrint(root: string, dirs: readonly string[]): string {
  const lines = dirs.map((d) => {
    let pkg: any = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, d, "package.json"), "utf8")); } catch {}
    if (!pkg) return `${d}\0missing`;
    const name = String(pkg.name ?? d.split("node_modules/").pop());
    const version = String(pkg.version ?? "");
    return `${d}\0${name}@${version}\0${lockIntegrity(root, d, name, version)}`;
  });
  return sha(lines.sort().join("\n"));
}

/** Why a candidate commit may not run, or null: it starts at the base, changes something, and touches nothing that grades. */
export function inadmissible(root: string, base: string, sha: string, globs: readonly string[]): string | null {
  if (tryGit(root, ["merge-base", base, sha]) !== base) return `does not start from the base ${base.slice(0, 8)}`;
  // Renames off: a moved file shows as a deletion of its old path, which is what a protect glob names.
  const files = (tryGit(root, ["diff", "--no-renames", "--name-only", base, sha]) ?? "").split("\n").filter(Boolean);
  if (!files.length) return "changes nothing";
  const touched = protectedTouches(files, globs);
  return touched.length ? `changes what grades it: ${touched.slice(0, 5).join(", ")}` : null;
}
