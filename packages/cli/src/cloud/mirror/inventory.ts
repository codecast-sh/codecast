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

import { execFileSync } from "../../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { isCodecastOwnedHomePath } from "../../codecastOwned.js";
import type { Config } from "../../config/types.js";
import {
  credentialContentReason, homeRelative, kindForPath, parseGitConfigList, portableText, renderGitconfig, type MirrorKind, type TransformContext,
} from "./transform.js";

import {
  AGENT_CONTEXT_ROOTS, CONTEXT_SIZE_CAP, INSTRUCTION_FILE_RE, commandCompatibilityWarnings, configPatterns,
  activeContextReferences, contextReferences, isAccessError, isAccountDataPath, isActiveConfig, isDefaultExcluded, isDeniedPath, isNativeBinary, isReferencedDirectory, matchesContextPattern,
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
  const referenceQueue: MirrorEntry[] = [];
  const collectedDirs = new Set<string>();
  const skippedPaths = new Map<string, SkippedEntry>();

  const skip = (rel: string, reason: string) => {
    const previous = skippedPaths.get(rel);
    if (previous) {
      if (previous.reason.startsWith("optional reference") && !reason.startsWith("optional reference")) previous.reason = reason;
      return;
    }
    const entry = { path: rel, reason };
    skippedPaths.set(rel, entry);
    skipped.push(entry);
  };

  const realHome = await fs.promises.realpath(home);

  const excluded = (rel: string, directory = false): boolean => {
    for (const pattern of excludes) {
      if (matchesContextPattern(pattern, rel, directory)) { excludesApplied.add(pattern); return true; }
    }
    return false;
  };

  const resolveEntry = async (rel: string, optionalReference = false): Promise<{ real: string; stat: fs.Stats } | null> => {
    if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) { skip(rel, "unsafe path"); return null; }
    if (isCodecastOwnedHomePath(rel)) { skip(rel, "codecast-owned path"); return null; }
    if (isDeniedPath(rel, true)) { skip(rel, "denied"); return null; }
    if (isAccountDataPath(rel) && !includes.some((p) => matchesContextPattern(p, rel, true))) { skip(rel, "account data excluded"); return null; }
    if (isDefaultExcluded(rel) || excluded(rel, true)) { skip(rel, "excluded"); return null; }
    const abs = path.join(home, rel);
    let real: string;
    try { real = await fs.promises.realpath(abs); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP") throw err;
      const link = await fs.promises.lstat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return null; });
      if (link) skip(rel, optionalReference ? "optional reference has an unresolved symlink" : "dangling or cyclic symlink");
      return null;
    }
    const realRel = homeRelative(real, realHome);
    if (realRel === null) { skip(rel, "symlink resolves outside home"); return null; }
    if (isAccountDataPath(realRel) && !includes.some((p) => matchesContextPattern(p, realRel, true))) { skip(rel, "symlink resolves into excluded account data"); return null; }
    const stat = await fs.promises.stat(real);
    if (isDeniedPath(rel, stat.isDirectory())) { skip(rel, "denied"); return null; }
    if (isDeniedPath(realRel, stat.isDirectory()) || isCodecastOwnedHomePath(realRel)) { skip(rel, `symlink resolves into a denied path (${realRel})`); return null; }
    if (isDefaultExcluded(realRel) || excluded(realRel, stat.isDirectory())) { skip(rel, "symlink target excluded"); return null; }
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
      totalBytes += stat.size;
      bytes = await fd.readFile();
    } finally { await fd.close(); }
    const credential = !isActiveConfig(kind) && credentialContentReason(bytes);
    if (credential) { totalBytes -= stat.size; skip(rel, credential); return; }
    const text = portableText(bytes);
    if (text !== null) warnings.push(...commandCompatibilityWarnings(text, rel));
    totalBytes += bytes.length - stat.size;
    const entry = { path: rel, kind, mode: fileMode(stat), bytes, root: rootOf(rel) };
    entries.set(rel, entry);
    referenceQueue.push(entry);
  };

  const collect = async (initial: string, optionalReference = false) => {
    const queue = [{ rel: initial, ancestors: new Set<string>() }];
    for (let start = 0; start < queue.length;) {
      const batch = queue.slice(start, start + 8);
      start += batch.length;
      const children = await Promise.all(batch.map(async ({ rel, ancestors }) => {
        if (entries.has(rel) || collectedDirs.has(rel)) return [];
        const resolved = await resolveEntry(rel, optionalReference);
        if (!resolved) return [];
        if (resolved.stat.isDirectory()) {
          if (ancestors.has(resolved.real)) { skip(rel, "symlink cycle"); return []; }
          collectedDirs.add(rel);
          const chain = new Set(ancestors).add(resolved.real);
          return (await fs.promises.readdir(resolved.real)).sort().map((name) => ({ rel: `${rel}/${name}`, ancestors: chain }));
        }
        await addFile(rel, kindForPath(rel), resolved.real, resolved.stat);
        return [];
      }));
      queue.push(...children.flat());
    }
  };

  for (const src of MIRROR_SOURCES) await collect(src.path);
  for (const name of await fs.promises.readdir(home)) if (INSTRUCTION_FILE_RE.test(name) || name === ".mcp.json") await collect(name);
  for (const inc of includes) await collect(inc);

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

  const scanned = new Set<string>();
  for (let index = 0; index < referenceQueue.length; index++) {
    const entry = referenceQueue[index]!;
    if (scanned.has(entry.path)) continue;
    scanned.add(entry.path);
    const text = portableText(entry.bytes);
    if (text === null) continue;
    const required = activeContextReferences(text, path.join(home, entry.path), home, entry.kind);
    for (const ref of new Set([...contextReferences(text, path.join(home, entry.path), home), ...required])) {
      const rel = homeRelative(ref, home);
      if (!rel || entries.has(rel) || collectedDirs.has(rel) || skippedPaths.has(rel) && !required.has(ref)) continue;
      try {
        const resolved = await resolveEntry(rel, !required.has(ref));
        if (!resolved) {
          const reason = skippedPaths.get(rel)?.reason;
          if (required.has(ref) && (!reason || /dangling|unresolved symlink/.test(reason))) throw new Error(`missing active context reference: ${entry.path} -> ${rel}`);
          if (required.has(ref)) warnings.push(`${entry.path}: unsupported host dependency ${rel} (${reason})`);
          skip(rel, "referenced path absent or excluded"); continue;
        }
        if (resolved.stat.isDirectory() && !required.has(ref) && !isReferencedDirectory(ref)) continue;
        await collect(rel, !required.has(ref));
      } catch (err) {
        if (required.has(ref) || !isAccessError(err)) throw err;
        skip(rel, `optional reference inaccessible (${(err as NodeJS.ErrnoException).code})`);
      }
    }
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

export function readGlobalGitConfig(home: string, cwd?: string, env?: NodeJS.ProcessEnv): Array<{ key: string; value: string }> {
  const gitEnv: NodeJS.ProcessEnv = { ...process.env, ...env, HOME: home };
  if (!gitEnv.XDG_CONFIG_HOME) gitEnv.XDG_CONFIG_HOME = path.join(home, ".config");
  const sources = gitEnv.GIT_CONFIG_GLOBAL ? [gitEnv.GIT_CONFIG_GLOBAL] : [path.join(gitEnv.XDG_CONFIG_HOME, "git/config"), path.join(home, ".gitconfig")];
  return sources.flatMap((file) => {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return [];
    const output = execFileSync("git", ["config", "--file", file, "--includes", "--list", "-z", "--show-origin"], {
      cwd: cwd ?? home, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    return parseGitConfigList(output).map(({ key, value }) => ({ key, value }));
  });
}
