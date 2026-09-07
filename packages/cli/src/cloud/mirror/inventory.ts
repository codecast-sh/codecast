/**
 * What the home mirror ships: the human-authored parts of ~/.claude,
 * ~/.codex, ~/.grok, ~/.gemini, ~/.agents, ~/.config/opencode plus a
 * rendered, allowlisted ~/.gitconfig and the global gitignore.
 *
 * Collection is pure over a `home`: an lstat walk that follows in-home
 * symlinks (a dotfiles repo is the common skill setup), refuses anything that
 * resolves outside $HOME or into a denied root, excludes codecast-owned
 * paths, honours cloud_mirror_include/exclude — the denylist always wins —
 * and refuses a bundle over the size cap naming the roots that filled it.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isCodecastOwnedHomePath } from "../../codecastOwned.js";
import type { Config } from "../../config/types.js";
import {
  homeRelative, kindForPath, parseGitConfigList, portableText, renderGitconfig, type MirrorKind, type TransformContext,
} from "./transform.js";

import {
  AGENT_CONTEXT_ROOTS, CONTEXT_SIZE_CAP, INSTRUCTION_FILE_RE, commandCompatibilityWarnings, configPatterns,
  contextReferences, isDefaultExcluded, isDeniedPath, isNativeBinary, isReferencedDirectory, matchesContextPattern,
} from "./discovery.js";

export { CONTEXT_DENYLIST as MIRROR_DENYLIST, DEFAULT_EXCLUDES, globToRegExp, isDeniedPath, isDefaultExcluded } from "./discovery.js";
export const MIRROR_MANAGED_ROOTS: readonly string[] = AGENT_CONTEXT_ROOTS;
export const MIRROR_SOURCES = AGENT_CONTEXT_ROOTS.map((path) => ({ path, kind: "verbatim" as const, dir: true }));
export const MIRROR_SIZE_CAP = CONTEXT_SIZE_CAP;

export interface MirrorEntry {
  /** Home-relative posix path (the host writes it under its own home). */
  path: string;
  kind: MirrorKind;
  mode: "0600" | "0700";
  bytes: Buffer;
  /** The managed root it belongs to (first path segment(s)), for size reports. */
  root: string;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface CollectOptions {
  home: string;
  config?: Pick<Config, "cloud_mirror_exclude" | "cloud_mirror_include"> | null;
  /** The host home, for the gitconfig render. */
  hostHome: string;
  /** Read the git config from here so `includeIf gitdir:` blocks resolve. */
  localGitRoot?: string;
  /** Extra process env for the git call (tests pin GIT_CONFIG_GLOBAL). */
  gitEnv?: NodeJS.ProcessEnv;
  maxBytes?: number;
}

export interface Inventory {
  entries: MirrorEntry[];
  skipped: SkippedEntry[];
  excludesApplied: string[];
  warnings: string[];
  /** The laptop's git identity, reported only (shipped by the host git setup, not the mirror). */
  gitIdentity: { name?: string; email?: string };
}

function rootOf(rel: string): string {
  for (const r of MIRROR_MANAGED_ROOTS) if (rel === r || rel.startsWith(`${r}/`)) return r;
  return rel.split("/")[0] ?? rel;
}

function fileMode(stat: fs.Stats): "0600" | "0700" {
  return stat.mode & 0o100 ? "0700" : "0600";
}

/**
 * Collect every mirrorable file under `home`. Async so the daemon's tick
 * does not block its loop on a big skills tree.
 */
export async function collectMirrorFiles(opts: CollectOptions): Promise<Inventory> {
  const home = opts.home.replace(/\/+$/, "");
  const ctx: TransformContext = { fromHome: home, toHome: opts.hostHome };
  const entries = new Map<string, MirrorEntry>();
  const skipped: SkippedEntry[] = [];
  const excludes = configPatterns(opts.config?.cloud_mirror_exclude ?? undefined);
  const includes = configPatterns(opts.config?.cloud_mirror_include ?? undefined);
  const excludesApplied = new Set<string>();
  const warnings: string[] = [];
  let totalBytes = 0;
  const skippedPaths = new Set<string>();

  const skip = (rel: string, reason: string) => {
    if (skippedPaths.has(rel)) return;
    skippedPaths.add(rel);
    skipped.push({ path: rel, reason });
  };

  const realHome = await fs.promises.realpath(home).catch(() => home);

  const excluded = (rel: string, directory = false): boolean => {
    for (const pattern of excludes) {
      if (matchesContextPattern(pattern, rel, directory)) { excludesApplied.add(pattern); return true; }
    }
    return false;
  };

  const resolveEntry = async (rel: string): Promise<{ real: string; stat: fs.Stats } | null> => {
    if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) { skip(rel, "unsafe path"); return null; }
    if (isCodecastOwnedHomePath(rel)) return null;
    if (isDeniedPath(rel, true)) { skip(rel, "denied"); return null; }
    if (isDefaultExcluded(rel) || excluded(rel, true)) return null;
    const abs = path.join(home, rel);
    let real: string;
    try { real = await fs.promises.realpath(abs); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP") throw err;
      const link = await fs.promises.lstat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return null; });
      if (link) skip(rel, "dangling or cyclic symlink");
      return null;
    }
    const realRel = homeRelative(real, realHome);
    if (realRel === null) { skip(rel, "symlink resolves outside home"); return null; }
    const stat = await fs.promises.stat(real);
    if (isDeniedPath(rel, stat.isDirectory())) { skip(rel, "denied"); return null; }
    if (isDeniedPath(realRel, stat.isDirectory()) || isCodecastOwnedHomePath(realRel)) { skip(rel, `symlink resolves into a denied path (${realRel})`); return null; }
    if (isDefaultExcluded(realRel) || excluded(realRel, stat.isDirectory())) return null;
    return { real, stat };
  };

  const addFile = async (rel: string, kind: MirrorKind, real: string, stat: fs.Stats) => {
    if (entries.has(rel) || excluded(rel)) return;
    if (!stat.isFile()) { skip(rel, "not a regular file"); return; }
    const fd = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const prefix = Buffer.alloc(4);
      await fd.read(prefix, 0, 4, 0);
      if (isNativeBinary(prefix)) { skip(rel, "native binary"); return; }
      if (totalBytes + stat.size > (opts.maxBytes ?? MIRROR_SIZE_CAP)) {
        const counts = new Map<string, number>();
        for (const entry of entries.values()) counts.set(entry.root, (counts.get(entry.root) ?? 0) + entry.bytes.length);
        counts.set(rootOf(rel), (counts.get(rootOf(rel)) ?? 0) + stat.size);
        const largest = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${(n / 1048576).toFixed(1)} MiB)`).join(", ");
        throw new Error(`home mirror is over the ${(opts.maxBytes ?? MIRROR_SIZE_CAP) / 1048576} MiB cap — largest: ${largest}; exclude with cast config cloud_mirror_exclude`);
      }
      bytes = await fd.readFile();
    } finally { await fd.close(); }
    const text = portableText(bytes);
    if (text !== null) warnings.push(...commandCompatibilityWarnings(text, rel));
    totalBytes += bytes.length;
    entries.set(rel, { path: rel, kind, mode: fileMode(stat), bytes, root: rootOf(rel) });
  };

  const collect = async (rel: string, ancestors = new Set<string>()) => {
    const resolved = await resolveEntry(rel);
    if (!resolved) return;
    if (resolved.stat.isDirectory()) {
      if (ancestors.has(resolved.real)) { skip(rel, "symlink cycle"); return; }
      const chain = new Set(ancestors).add(resolved.real);
      for (const name of (await fs.promises.readdir(resolved.real)).sort()) await collect(`${rel}/${name}`, chain);
    } else await addFile(rel, kindForPath(rel), resolved.real, resolved.stat);
  };

  for (const src of MIRROR_SOURCES) await collect(src.path);
  for (const name of await fs.promises.readdir(home)) if (INSTRUCTION_FILE_RE.test(name) || name === ".mcp.json") await collect(name);
  for (const inc of includes) await collect(inc);

  const referenceQueue = [...entries.values()];
  const scanned = new Set<string>();
  for (let index = 0; index < referenceQueue.length; index++) {
    const entry = referenceQueue[index]!;
    if (scanned.has(entry.path)) continue;
    scanned.add(entry.path);
    const text = portableText(entry.bytes);
    if (text === null) continue;
    for (const ref of contextReferences(text, path.join(home, entry.path), home)) {
      const rel = homeRelative(ref, home);
      if (!rel || entries.has(rel)) continue;
      const resolved = await resolveEntry(rel);
      if (!resolved || resolved.stat.isDirectory() && !isReferencedDirectory(ref)) continue;
      const before = new Set(entries.keys());
      await collect(rel);
      for (const [key, value] of entries) if (!before.has(key)) referenceQueue.push(value);
    }
  }

  // Git: an allowlisted render of the global config and the global ignore file.
  const gitIdentity: Inventory["gitIdentity"] = {};
  const gitPairs = readGlobalGitConfig(home, undefined, opts.gitEnv);
  for (const p of gitPairs) {
    if (p.key.toLowerCase() === "user.name") gitIdentity.name = p.value;
    if (p.key.toLowerCase() === "user.email") gitIdentity.email = p.value;
  }

  const rendered = renderGitconfig(gitPairs, ctx);
  if (rendered.text) {
    entries.set(".gitconfig", { path: ".gitconfig", kind: "gitconfig", mode: "0600", bytes: Buffer.from(rendered.text), root: ".gitconfig" });
  }
  let ignoreRel: string | null = null;
  const excludesFile = [...gitPairs].reverse().find((p) => p.key.toLowerCase() === "core.excludesfile")?.value;
  if (excludesFile) {
    const abs = excludesFile.startsWith("~/") ? path.join(home, excludesFile.slice(2)) : excludesFile;
    ignoreRel = homeRelative(abs, home);
  } else if (fs.existsSync(path.join(home, ".config/git/ignore"))) {
    ignoreRel = ".config/git/ignore";
  }
  for (const rel of [...(ignoreRel ? [ignoreRel] : []), ...rendered.referencedFiles]) {
    if (entries.has(rel)) continue;
    const r = await resolveEntry(rel);
    if (r && r.stat.isFile()) await addFile(rel, rel === ignoreRel ? "gitignore" : "verbatim", r.real, r.stat);
  }

  const list = [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const total = list.reduce((n, e) => n + e.bytes.length, 0);
  if (total > (opts.maxBytes ?? MIRROR_SIZE_CAP)) {
    const byRoot = new Map<string, number>();
    for (const e of list) byRoot.set(e.root, (byRoot.get(e.root) ?? 0) + e.bytes.length);
    const biggest = [...byRoot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([r, n]) => `${r} (${(n / 1048576).toFixed(1)} MiB)`).join(", ");
    throw new Error(`home mirror is ${(total / 1048576).toFixed(1)} MiB, over the ${MIRROR_SIZE_CAP / 1048576} MiB cap — largest: ${biggest}; exclude with \`cast config cloud_mirror_exclude\``);
  }
  return { entries: list, skipped, excludesApplied: [...excludesApplied], warnings: [...new Set(warnings)], gitIdentity };
}

/**
 * The user's effective global git config, read from the repo being prepared
 * (or from $HOME): `git config --list --show-origin` — NOT `--global`, which
 * never evaluates `includeIf "gitdir:…"` blocks, so a work profile's
 * `pull.rebase` or aliases would never ship — minus the pairs whose origin is
 * the repo's own config (anything under its git common dir) or a system
 * file (`git config --system`). ~/.gitconfig, ~/.config/git/config and every
 * file they include are what remains.
 */
export function readGlobalGitConfig(home: string, cwd?: string, env?: NodeJS.ProcessEnv): Array<{ key: string; value: string }> {
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, ...env, HOME: home };
  if (!gitEnv.GIT_CONFIG_GLOBAL) gitEnv.XDG_CONFIG_HOME = path.join(home, ".config");
  const runIn = cwd && fs.existsSync(cwd) ? cwd : home;
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: runIn, env: gitEnv, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  let all: ReturnType<typeof parseGitConfigList>;
  try {
    all = parseGitConfigList(git(["config", "--list", "-z", "--show-origin"]));
  } catch {
    return [];
  }
  const system = new Set<string>();
  try { for (const p of parseGitConfigList(git(["config", "--system", "--list", "-z", "--show-origin"]))) system.add(p.origin); } catch { /* none */ }
  let commonDir: string | null = null;
  try {
    commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  } catch {
    try { commonDir = path.resolve(runIn, git(["rev-parse", "--git-common-dir"]).trim()); } catch { /* not a repo */ }
  }
  const realCommon = commonDir ? (() => { try { return fs.realpathSync(commonDir); } catch { return commonDir; } })() : null;
  const underRepo = (originPath: string): boolean => {
    if (!commonDir) return false;
    const abs = path.resolve(runIn, originPath);
    const real = (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
    return [commonDir, realCommon].some((d) => d && (abs === d || abs.startsWith(`${d}/`) || real === d || real.startsWith(`${d}/`)));
  };
  return all
    .filter((p) => p.origin.startsWith("file:") && !system.has(p.origin) && !underRepo(p.origin.slice("file:".length)))
    .map(({ key, value }) => ({ key, value }));
}
