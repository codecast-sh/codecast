/**
 * Making a folder unpacked from another machine safe to open
 * (cli/src/folderSync.ts, docs/architecture/peer-transport.md).
 */

import { execFile } from "./proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SAFE_GIT_KEY = new RegExp("^(" + [
  "core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|checkstat|trustctime|untrackedcache|splitindex|commitgraph|multipackindex|abbrev|compression|loosecompression|sparsecheckout|sparsecheckoutcone|warnambiguousrefs|worktree)",
  "remote\\..+\\.(url|pushurl|fetch|push|tagopt|prune|mirror|promisor|partialclonefilter)",
  "branch\\..+\\.(remote|pushremote|merge|rebase|description)",
  "user\\.(name|email|signingkey)",
  "submodule\\..+\\.(url|path|active|branch)",
  "submodule\\.active",
  "extensions\\.(objectformat|refstorage|partialclone|preciousobjects)",
  "lfs\\.(repositoryformatversion|url|pushurl)",
  "init\\.defaultbranch",
  "pull\\.(rebase|ff)",
  "push\\.(default|autosetupremote)",
  "fetch\\.prune",
].join("|") + ")$", "is");

async function gitConfig(cfg: string, args: string[]): Promise<string> {
  const out: unknown = await execFileAsync("git", ["config", "--file", cfg, ...args], { cwd: os.tmpdir(), encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  return typeof out === "string" ? out : String((out as { stdout: string }).stdout);
}

/** Keep only git config keys known to run nothing and point nowhere outside the
 *  tree; every other key goes. A config git cannot read goes entirely. */
async function sanitizeGitConfig(cfg: string, gitDir: string, root: string): Promise<void> {
  try {
    const entries = (await gitConfig(cfg, ["--list", "-z"])).split("\0").filter(Boolean).map((e) => {
      const nl = e.indexOf("\n");
      return nl < 0 ? [e, ""] : [e.slice(0, nl), e.slice(nl + 1)];
    });
    const drop = new Set<string>();
    for (const [key, value] of entries) {
      if (!SAFE_GIT_KEY.test(key)) drop.add(key);
      else if (key.toLowerCase() === "core.worktree" && !inside(root, path.resolve(gitDir, value))) drop.add(key);
    }
    for (const key of drop) await gitConfig(cfg, ["--unset-all", key]);
  } catch {
    await fs.promises.rm(cfg, { force: true });
  }
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

async function symlinkEscapes(link: string, root: string, realRoot: string): Promise<boolean> {
  const target = await fs.promises.readlink(link);
  if (!inside(root, path.resolve(path.dirname(link), target))) return true;
  const real = await fs.promises.realpath(link).catch(() => null);
  if (real) return !inside(realRoot, real);
  return target.split(/[\\/]/).includes("..");
}

/** Where a gitdir pointer (a `.git` file or a `commondir`) leads, if it stays inside the tree. */
async function pointerTarget(file: string, base: string, root: string): Promise<string | null> {
  const text = (await fs.promises.readFile(file, "utf-8").catch(() => "")).trim();
  const target = path.basename(file) === ".git" ? /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim() : text;
  if (!target) return null;
  const real = await fs.promises.realpath(path.resolve(base, target)).catch(() => null);
  return real && inside(root, real) ? real : null;
}

/**
 * Make an extracted tree safe to open: no devices, fifos or sockets, no
 * symlink that resolves outside it, and in every git dir (found by its shape,
 * `.git` files and `commondir` pointers, not by name) no hooks, no pointer out
 * of the tree, and no config that runs a program.
 */
export async function sanitizeExtractedTree(staging: string): Promise<void> {
  const root = await fs.promises.realpath(staging);
  const links: string[] = [];
  const gitFiles: string[] = [];
  const gitDirs = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    const names = new Set(items.map((d) => d.name));
    if (path.basename(dir) === ".git" || (names.has("HEAD") && (names.has("objects") || names.has("refs") || names.has("commondir")))) gitDirs.add(dir);
    for (const d of items) {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) {
        if (d.name === ".git") await fs.promises.rm(p, { force: true });
        else links.push(p);
      } else if (d.isDirectory()) {
        await visit(p);
      } else if (!d.isFile()) {
        await fs.promises.rm(p, { force: true });
      } else if (d.name === ".git") {
        gitFiles.push(p);
      }
    }
  };
  await visit(root);
  const remaining = new Set(links);
  for (let removed = true; removed; ) {
    removed = false;
    for (const link of remaining) {
      if (!(await symlinkEscapes(link, root, root))) continue;
      await fs.promises.rm(link, { force: true });
      remaining.delete(link);
      removed = true;
    }
  }
  for (const file of gitFiles) {
    const target = await pointerTarget(file, path.dirname(file), root);
    if (target) gitDirs.add(target);
    else await fs.promises.rm(file, { force: true });
  }
  const done = new Set<string>();
  for (let pending = [...gitDirs]; pending.length; pending = [...gitDirs].filter((g) => !done.has(g))) {
    for (const g of pending) {
      done.add(g);
      const common = path.join(g, "commondir");
      if (fs.existsSync(common)) {
        const target = await pointerTarget(common, g, root);
        if (target) gitDirs.add(target);
        else await fs.promises.rm(common, { force: true });
      }
      const hooks = path.join(g, "hooks");
      await fs.promises.rm(hooks, { recursive: true, force: true });
      await fs.promises.mkdir(hooks);
      for (const name of ["config", "config.worktree"]) {
        const cfg = path.join(g, name);
        const st = await fs.promises.lstat(cfg).catch(() => null);
        if (st?.isSymbolicLink()) await fs.promises.rm(cfg, { force: true });
        else if (st?.isFile()) await sanitizeGitConfig(cfg, g, root);
      }
    }
  }
}
