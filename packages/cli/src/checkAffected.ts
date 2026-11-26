/**
 * Which of a tree's typecheck projects its changes can reach: the programs
 * `cast check` asks about when no project is named, and the ones
 * `--changed-since` keeps. Read from the program lists tsc's build info
 * records, pooled across the repository's checkouts. Split out of check.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { buildInfoPath, gitLines, readBuildInfo, readCheckConfig, resolveProjects, watchDir, type CheckProject } from "./check.js";

/**
 * Repo-relative paths in a project's program, lowercased, read from
 * watchers' build info (tsc writes every file of the program there): the
 * union of this tree's, the main checkout's and the freshest others'. The
 * program is the same give or take what a change adds, so a file one project
 * imports from another's folder still counts for it. One list alone bets that
 * its checkout carries every import the change meets: the main checkout's was
 * 17 to 89 hours old, and a project a bare check skips never refreshes its
 * own. Null when no checkout has one.
 */
export function programFiles(root: string, project: CheckProject, trees: string[] = [root, ...otherCheckouts(root)]): Set<string> | null {
  const dated = trees.flatMap((tree, i) => {
    try {
      return [{ tree, i, at: fs.statSync(buildInfoPath(watchDir(tree, project.name))).mtimeMs }];
    } catch {
      return [];
    }
  });
  // This tree and the main checkout (trees[0] and [1]), and the PROGRAM_LISTS freshest of the rest: every list is
  // megabytes of JSON, and a repository's 60 worktrees hold ~170 of them.
  const chosen = [...dated.filter((d) => d.i <= 1), ...dated.filter((d) => d.i > 1).sort((a, b) => b.at - a.at).slice(0, PROGRAM_LISTS)];
  let union: Set<string> | null = null;
  for (const { tree } of chosen) {
    const files = builtProgramFiles(tree, project);
    if (files) union = union ? new Set([...union, ...files]) : files;
  }
  return union;
}
const PROGRAM_LISTS = 6;

/**
 * Where bun installs a `file:` dependency, mapped back to the source it was
 * copied from: tsc records the vendored @platform mirror as
 * `node_modules/.bun/@platform+keys@file+platform+packages+keys[+hash]/node_modules/@platform/keys/src/x.ts`,
 * which names no file a diff touches. Repo-relative (`platform/packages/keys/src/x.ts`); null for any other path.
 */
export function bunFileDepSource(file: string): string | null {
  const m = /\/node_modules\/\.bun\/[^/]+@file\+([^/]+?)(?:\+[0-9a-f]{16})?\/node_modules\/(?:@[^/]+\/)?[^/]+\/(.+)$/.exec(file);
  return m ? `${m[1]!.split("+").join("/")}/${m[2]}` : null;
}

/** The repository's other checkouts, its main one first (git worktree list). */
function otherCheckouts(root: string): string[] {
  try {
    const self = fs.realpathSync(root);
    return gitLines(root, ["worktree", "list", "--porcelain"])
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((t) => fs.existsSync(t) && fs.realpathSync(t) !== self);
  } catch {
    return [];
  }
}

function builtProgramFiles(root: string, project: CheckProject): Set<string> | null {
  const dir = watchDir(root, project.name);
  const program = readBuildInfo(dir);
  if (!program) return null;
  const files = new Set<string>();
  for (const name of program.fileNames) {
    if (typeof name !== "string") continue;
    // Lowercased: on a case-insensitive disk (macOS) tsc writes its canonical, lowercased paths here, so
    // `checkHeap.ts` reads as `checkheap.ts`, and a path compared as written missed every camelCase file.
    const abs = path.resolve(dir, name).toLowerCase();
    const rel = bunFileDepSource(abs) ?? path.relative(root.toLowerCase(), abs);
    if (!rel.startsWith("..")) files.add(rel.split(path.sep).join("/"));
  }
  return files;
}

/** A file that decides how a program resolves rather than what it holds: a tsconfig, a package.json, a lockfile. */
const RESOLUTION_FILE = /(^|\/)(tsconfig[^/]*\.json|package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/**
 * The projects a set of changed files can affect. A file some program list
 * holds reaches the programs holding it. A code file no list holds reaches
 * every program with a file in the same folder: matching by folder survives
 * an import added since the lists were recorded (web began importing
 * shared/contracts/inboxPlacement.ts after the list it was judged by). A tsconfig, package.json or lockfile reaches
 * every program with files in or below its folder, and every project in or below its
 * folder, since tsc and module resolution walk up; a code file in a folder no
 * program has seen (new) counts for the project whose tsconfig sits above it.
 * A program no checkout of the repository has built is unknown, so any code
 * change counts for it. A changed script that no project claims by any of
 * these rules is one nothing here can place, so every project counts, and
 * `note` is told which.
 */
export function projectsTouching(root: string, projects: CheckProject[], changed: string[], note: (line: string) => void = () => {}): CheckProject[] {
  const everything = changed.filter((f) => REACH_ALL.test(f));
  if (everything.length) {
    note(`checking every project: ${everything.slice(0, 3).join(", ")} change${everything.length === 1 ? "s" : ""} what every program sees`);
    return projects;
  }
  const code = changed.filter((f) => /\.(m|c)?[jt]sx?$|\.json$/.test(f) || RESOLUTION_FILE.test(f));
  // Each build info is megabytes of JSON: read once per call, not once per file and project.
  const trees = [root, ...otherCheckouts(root)];
  const programs = new Map(projects.map((p) => [p, programFiles(root, p, trees)]));
  // Per program, the folders holding its files, and those folders with every folder above them; lowercased, as programFiles is.
  const folders = new Map([...programs].map(([p, files]) => [p, new Set([...files ?? []].map((f) => path.posix.dirname(f)))] as const));
  const reach = new Map([...folders].map(([p, dirs]) => {
    const above = new Set<string>();
    for (const dir of dirs) for (let d = dir; !above.has(d); d = path.posix.dirname(d)) {
      above.add(d);
      if (d === ".") break;
    }
    return [p, above] as const;
  }));
  const holds = (files: Set<string> | null | undefined, f: string) => !!files?.has(f.toLowerCase());
  const listed = (f: string) => projects.some((q) => holds(programs.get(q), f));
  const claimed = new Set<string>();
  const hit = projects.filter((p) => {
    const files = programs.get(p);
    if (!files) return code.length > 0;
    const dir = path.dirname(path.normalize(p.tsconfig));
    const under = (f: string) => dir === "." || f.startsWith(`${dir}/`);
    const above = (f: string) => { const d = path.dirname(f); return d === "." || dir === d || dir.startsWith(`${d}/`); };
    // A code file: a program file beside it. A resolution file: one beside it or anywhere below.
    const inFolder = (f: string) => (RESOLUTION_FILE.test(f) ? reach : folders).get(p)!.has(path.posix.dirname(f).toLowerCase());
    // A file some list holds reaches exactly the programs holding it; only one no list holds (new, or imported since
    // the lists were written) is placed by folder, else every file beside a shared component would reach them all.
    const mine = changed.filter((f) => holds(files, f) || (code.includes(f) && ((!listed(f) && inFolder(f)) || (RESOLUTION_FILE.test(f) && (under(f) || above(f))) || (!listed(f) && under(f)))));
    for (const f of mine) claimed.add(f);
    return mine.length > 0;
  });
  // A script no list, folder or tsconfig places (a vendored copy the lists name some other way, a folder nothing has
  // built) may still be compiled by any of them: checking too much costs minutes, checking too little ships errors.
  const unplaced = changed.filter((f) => /\.(m|c)?[jt]sx?$/.test(f) && !claimed.has(f));
  if (unplaced.length) {
    note(`checking every project: no project's program places ${unplaced.slice(0, 3).join(", ")}${unplaced.length > 3 ? ` and ${unplaced.length - 3} more` : ""}`);
    return projects;
  }
  return hit;
}

/** Origin's default branch (`origin/main`), else null: what a bare `cast check` measures the tree's changes against. */
export function defaultBaseRef(root: string): string | null {
  for (const args of [["rev-parse", "--abbrev-ref", "origin/HEAD"], ["rev-parse", "--abbrev-ref", "--verify", "-q", "origin/main"], ["rev-parse", "--abbrev-ref", "--verify", "-q", "origin/master"]]) {
    try {
      const ref = gitLines(root, args)[0];
      if (ref && ref !== "origin/HEAD") return ref;
    } catch {}
  }
  return null;
}

/**
 * What this tree changes against `base`: commits since the fork point, staged,
 * unstaged and untracked files, repo-relative. Null when git cannot say (no
 * base, no common history).
 */
export function changedFiles(root: string, base: string): string[] | null {
  try {
    const forkPoint = gitLines(root, ["merge-base", "HEAD", base])[0];
    if (!forkPoint) return null;
    return [...new Set([
      // Both sides of a rename: the old path is the one the programs built so far hold.
      ...gitPaths(root, ["diff", "--name-only", "--no-renames", forkPoint, "--"]),
      ...gitPaths(root, ["ls-files", "--others", "--exclude-standard"]),
    ])];
  } catch {
    return null;
  }
}

/**
 * The projects `cast check` asks about. Named ones, or with `all` every
 * configured one, as resolveProjects reads them. Bare, in a tree with a
 * config, only those the tree's changes reach: each program is a watcher of
 * gigabytes, and worktrees asking for all seven to check a one-package change
 * evicted other trees' watchers, which their next ask rebuilt (ct-100924).
 */
export function projectsForAsk(root: string, names: string[], opts: { all?: boolean; cwd?: string } = {}): { projects: CheckProject[]; why: string | null } {
  const listed = resolveProjects(root, names, opts.cwd);
  if (names.length || opts.all || !readCheckConfig(root)) return { projects: listed, why: null };
  return affectedProjects(root, listed);
}

/**
 * The projects a bare `cast check` means: of the tree's configured projects,
 * only those the tree's changes can affect. Every project when the base or
 * the changes cannot be read, or nothing changed at all (checking a clean
 * tree is an explicit ask for the whole thing). `why` is the line telling
 * the caller what was skipped; null when nothing was.
 */
function affectedProjects(root: string, projects: CheckProject[]): { projects: CheckProject[]; why: string | null } {
  const base = defaultBaseRef(root);
  const changed = base ? changedFiles(root, base) : null;
  if (!base || !changed) return { projects, why: projects.length > 1 ? `checking every project: no origin default branch to measure this tree's changes against` : null };
  if (!changed.length) return { projects, why: null };
  let unplaced: string | null = null;
  const hit = projectsTouching(root, projects, changed, (line) => { unplaced = line; });
  const skipped = projects.filter((p) => !hit.includes(p)).map((p) => p.name);
  if (!skipped.length) return { projects, why: unplaced };
  const n = `${changed.length} file${changed.length === 1 ? "" : "s"} changed since ${base}`;
  return {
    projects: hit,
    why: hit.length
      ? `checking ${hit.map((p) => p.name).join(", ")}; skipped ${skipped.join(", ")}: none of the ${n} is in their programs (cast check --all checks every project)`
      : `no project's program holds any of the ${n} (cast check --all checks every project)`,
  };
}

/**
 * The paths a git listing names, NUL separated (-z): without it a host that
 * quotes paths (core.quotepath, the default) returns a non-ASCII name as
 * "\303\251…" in quotes, which matches no program and no code pattern.
 */
export function gitPaths(root: string, args: string[]): string[] {
  const r = spawnSync("git", ["-C", root, ...args.slice(0, 1), "-z", ...args.slice(1)], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(String(r.stderr || `git ${args[0]} failed`).trim());
  return String(r.stdout).split("\0").filter(Boolean);
}

/** What a changed file outside every program can still change for all of them: the project list, the root bun config, the patches postinstall applies. A package's own bunfig.toml sets its test preloads, which tsc never reads. */
const REACH_ALL = /^\.codecast\/check\.toml$|^bunfig\.toml$|^patches\//;
