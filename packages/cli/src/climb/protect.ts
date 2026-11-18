// What grades a candidate, and the checks that a candidate's tree left it
// alone (flows.md FL10). Everything here is derived from git at the base and
// from the disk, never from the climb's own state, so a station that rewrites
// the state cannot widen what a candidate may touch.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

/**
 * The checkout's installed packages, which every tree the climb runs in links
 * live (envCommand withTreeAt): every file in each node_modules a tree would
 * link, by its contents. A grader package edited in place after gauge, at
 * any size and with any timestamp, changes it, and the climb stops rather
 * than score through it.
 */
export function packagesPrint(root: string): string {
  const lines: string[] = [];
  const walkAll = (abs: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walkAll(p, `${rel}/${e.name}`);
      else if (e.isFile()) { try { lines.push(`${rel}/${e.name}\0${sha(fs.readFileSync(p))}`); } catch {} }
      else if (e.isSymbolicLink()) { try { lines.push(`${rel}/${e.name}\0->${fs.readlinkSync(p)}`); } catch {} }
    }
  };
  const find = (rel: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git" || (e.name.startsWith(".") && e.name !== ".codecast")) continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === "node_modules") walkAll(path.join(root, sub), sub);
      else if (depth < 4) find(sub, depth + 1);
    }
  };
  find("", 0);
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
