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
  homeRelative, parseGitConfigList, renderGitconfig, type MirrorKind, type TransformContext,
} from "./transform.js";

export interface MirrorSource {
  /** Home-relative path of a file or directory. */
  path: string;
  kind: MirrorKind;
  /** Directory: collect every regular file under it. */
  dir?: boolean;
  /** Directory: only files whose basename matches (non-recursive when set). */
  only?: RegExp;
  /** Directory: home-relative children to leave out (besides codecast-owned ones). */
  skip?: string[];
}

/** Home-relative roots the mirror manages — stale mirrored files under them may be pruned. */
export const MIRROR_MANAGED_ROOTS: readonly string[] = [".claude", ".codex", ".grok", ".gemini", ".agents", ".config/opencode"];

export const MIRROR_SOURCES: readonly MirrorSource[] = [
  { path: ".claude/CLAUDE.md", kind: "claude-md" },
  { path: ".claude/settings.json", kind: "claude-settings" },
  { path: ".claude/settings.local.json", kind: "claude-settings" },
  { path: ".claude/keybindings.json", kind: "verbatim" },
  { path: ".claude/agents", kind: "verbatim", dir: true },
  { path: ".claude/skills", kind: "verbatim", dir: true },
  { path: ".claude/commands", kind: "verbatim", dir: true },
  { path: ".claude/prompts", kind: "verbatim", dir: true },
  { path: ".claude/output-styles", kind: "verbatim", dir: true },
  { path: ".claude/hooks", kind: "verbatim", dir: true },
  { path: ".claude", kind: "verbatim", dir: true, only: /\.(sh|py|js|mjs)$/ },
  { path: ".claude/plugins/known_marketplaces.json", kind: "json-remap" },
  { path: ".codex/AGENTS.md", kind: "agents-md" },
  { path: ".codex/AGENTS.override.md", kind: "agents-md" },
  { path: ".codex/config.toml", kind: "codex-toml" },
  { path: ".codex/hooks.json", kind: "codex-hooks" },
  { path: ".codex/prompts", kind: "verbatim", dir: true },
  { path: ".codex/rules", kind: "verbatim", dir: true },
  { path: ".codex/skills", kind: "verbatim", dir: true, skip: [".codex/skills/.system"] },
  { path: ".grok/AGENTS.md", kind: "agents-md" },
  { path: ".grok/config.toml", kind: "toml-remap" },
  { path: ".grok/skills", kind: "verbatim", dir: true },
  { path: ".grok/hooks", kind: "json-remap", dir: true, only: /\.json$/ },
  { path: ".grok/user-settings.json", kind: "json-remap" },
  { path: ".grok/settings.json", kind: "json-remap" },
  { path: ".gemini/GEMINI.md", kind: "claude-md" },
  { path: ".gemini/settings.json", kind: "gemini-settings" },
  { path: ".gemini/commands", kind: "verbatim", dir: true },
  { path: ".agents/skills", kind: "verbatim", dir: true },
  { path: ".config/opencode/opencode.json", kind: "opencode-json" },
  { path: ".config/opencode/opencode.jsonc", kind: "opencode-json" },
  { path: ".config/opencode/AGENTS.md", kind: "agents-md" },
  { path: ".config/opencode/agent", kind: "verbatim", dir: true },
  { path: ".config/opencode/command", kind: "verbatim", dir: true },
  { path: ".config/opencode/plugins", kind: "verbatim", dir: true, skip: [".config/opencode/plugins/codecast-stable.js"] },
];

/**
 * Never shipped, whatever cloud_mirror_include says. A plain entry (`.ssh`,
 * `.codex/auth.json`) is matched against the home-relative path — exact, or
 * as a directory prefix; a path glob (`.codex/*.sqlite*`) against the whole
 * path; a bare NAME glob (`id_*`, `*.pem`) names FILES and is matched against
 * the basename only, so a skill directory called `id_generator` is not a
 * key. Both the logical path and the symlink-resolved path are checked.
 */
export const MIRROR_DENYLIST: readonly string[] = [
  ".claude/.credentials.json", ".claude.json",
  ".claude/history.jsonl", ".claude/projects", ".claude/sessions", ".claude/session-env", ".claude/shell-snapshots",
  ".claude/file-history", ".claude/backups", ".claude/cache", ".claude/downloads", ".claude/todos", ".claude/statsig",
  ".claude/plugins/marketplaces", ".claude/plugins/repos", ".claude/plugins/cache", ".claude/plugins/installed_plugins.json",
  ".codex/auth.json", ".codex/*.sqlite*", ".codex/sessions", ".codex/cache", ".codex/tmp", ".codex/shell_snapshots",
  ".codex/thread-writer-locks", ".codex/models_cache.json", ".codex/installation_id", ".codex/skills/.system", ".codex/plugins",
  ".grok/sessions",
  ".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".gemini/tmp", ".gemini/history",
  ".config/gh", ".config/gcloud", ".ssh", ".aws", ".gnupg", ".kube", ".docker/config.json",
  ".netrc", ".npmrc", ".pgpass", ".codecast", ".mcp.json",
  "*.pem", "id_*", "*.key", "credentials*.json", "hosts.yml",
];

/** Noise that never belongs in a mirror, applied under every root. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  "**/node_modules/**", "**/.git/**", "**/__pycache__/**", "**/.DS_Store", "**/*.log",
];

/** Refuse a bundle whose bodies exceed this. */
export const MIRROR_SIZE_CAP = 64 * 1024 * 1024;

/** `*`, `**`, `?` globs over posix paths. Anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matchesPattern(pattern: string, rel: string, isDir: boolean): boolean {
  const isGlob = /[*?]/.test(pattern);
  if (isGlob && !pattern.includes("/")) {
    if (isDir) return false;
    return globToRegExp(pattern).test(path.posix.basename(rel));
  }
  const base = pattern.replace(/\/\*\*$/, "");
  if (rel === base || rel.startsWith(`${base}/`)) return true;
  return isGlob && globToRegExp(pattern).test(rel);
}

/** Denied as a file (default) or as a directory (bare name patterns do not apply). */
export function isDeniedPath(rel: string, isDir = false): boolean {
  return MIRROR_DENYLIST.some((p) => matchesPattern(p, rel, isDir));
}

export function isDefaultExcluded(rel: string): boolean {
  return DEFAULT_EXCLUDES.some((p) => globToRegExp(p).test(rel));
}

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
}

export interface Inventory {
  entries: MirrorEntry[];
  skipped: SkippedEntry[];
  excludesApplied: string[];
  /** The laptop's git identity, reported only (shipped by the host git setup, not the mirror). */
  gitIdentity: { name?: string; email?: string };
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim().replace(/^~\//, "").replace(/^\.\//, "")).filter(Boolean);
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
  const excludes = parseList(opts.config?.cloud_mirror_exclude ?? undefined);
  const includes = parseList(opts.config?.cloud_mirror_include ?? undefined);
  const excludeRes = excludes.map((g) => globToRegExp(g));
  const excludesApplied = new Set<string>();
  const visitedDirs = new Set<string>();
  const skippedPaths = new Set<string>();

  const skip = (rel: string, reason: string) => {
    if (skippedPaths.has(rel)) return;
    skippedPaths.add(rel);
    skipped.push({ path: rel, reason });
  };

  const realHome = await fs.promises.realpath(home).catch(() => home);

  /** Resolve one logical path; null when it must not be shipped. */
  const resolveEntry = async (rel: string): Promise<{ real: string; stat: fs.Stats } | null> => {
    if (isCodecastOwnedHomePath(rel)) return null;
    // Path-shaped denials apply before anything is touched (and are reported
    // even for an absent path a user included); name-shaped ones need to
    // know whether this is a file.
    if (isDeniedPath(rel, true)) { skip(rel, "denied"); return null; }
    if (isDefaultExcluded(rel)) return null;
    const abs = path.join(home, rel);
    const lstat = await fs.promises.lstat(abs).catch(() => null);
    if (!lstat) return null;
    if (!lstat.isSymbolicLink()) {
      if (!lstat.isDirectory() && isDeniedPath(rel)) { skip(rel, "denied"); return null; }
      return { real: abs, stat: lstat };
    }
    let real: string;
    try { real = await fs.promises.realpath(abs); } catch { skip(rel, "dangling symlink"); return null; }
    const realRel = homeRelative(real, realHome) ?? homeRelative(real, home);
    if (realRel === null) { skip(rel, "symlink resolves outside home"); return null; }
    const stat = await fs.promises.stat(real).catch(() => null);
    if (!stat) { skip(rel, "dangling symlink"); return null; }
    const isDir = stat.isDirectory();
    if (!isDir && isDeniedPath(rel)) { skip(rel, "denied"); return null; }
    if (isDeniedPath(realRel, isDir) || isCodecastOwnedHomePath(realRel)) { skip(rel, `symlink resolves into a denied path (${realRel})`); return null; }
    return { real, stat };
  };

  const excluded = (rel: string): boolean => {
    for (let i = 0; i < excludeRes.length; i++) {
      if (excludeRes[i]!.test(rel)) { excludesApplied.add(excludes[i]!); return true; }
    }
    return false;
  };

  const addFile = async (rel: string, kind: MirrorKind, real: string, stat: fs.Stats) => {
    if (entries.has(rel)) return;
    if (excluded(rel)) return;
    if (!stat.isFile()) { skip(rel, "not a regular file"); return; }
    const bytes = await fs.promises.readFile(real);
    entries.set(rel, { path: rel, kind, mode: fileMode(stat), bytes, root: rootOf(rel) });
  };

  const walkDir = async (rel: string, kind: MirrorKind, real: string, only?: RegExp, skipList: string[] = []) => {
    const realDir = await fs.promises.realpath(real).catch(() => real);
    if (visitedDirs.has(`${kind}:${realDir}:${only ? "only" : "all"}`)) return;
    visitedDirs.add(`${kind}:${realDir}:${only ? "only" : "all"}`);
    const names = await fs.promises.readdir(real).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const childRel = `${rel}/${name}`;
      if (skipList.some((s) => childRel === s || childRel.startsWith(`${s}/`))) continue;
      // A filtered scan is non-recursive: names that do not match are never resolved,
      // so a denied neighbour (`.credentials.json` beside a script) is not reported.
      if (only && !only.test(name)) continue;
      const resolved = await resolveEntry(childRel);
      if (!resolved) continue;
      if (resolved.stat.isDirectory()) {
        if (only) continue;
        await walkDir(childRel, kind, resolved.real, undefined, skipList);
      } else if (!only || only.test(name)) {
        await addFile(childRel, kind, resolved.real, resolved.stat);
      }
    }
  };

  const collect = async (rel: string, kind: MirrorKind, dir: boolean | undefined, only?: RegExp, skipList?: string[]) => {
    const resolved = await resolveEntry(rel);
    if (!resolved) return;
    if (resolved.stat.isDirectory()) {
      if (dir) await walkDir(rel, kind, resolved.real, only, skipList);
    } else if (!dir) {
      await addFile(rel, kind, resolved.real, resolved.stat);
    }
  };

  for (const src of MIRROR_SOURCES) await collect(src.path, src.kind, src.dir, src.only, src.skip);

  // Files the settings point at (statusLine script) ride along verbatim.
  const settings = entries.get(".claude/settings.json");
  if (settings) {
    try {
      const parsed = JSON.parse(settings.bytes.toString("utf-8"));
      const cmd = parsed?.statusLine?.command;
      if (typeof cmd === "string") {
        const first = cmd.trim().split(/\s+/)[0] ?? "";
        const abs = first.startsWith("~/") ? path.join(home, first.slice(2)) : first;
        const rel = homeRelative(abs, home);
        if (rel) {
          const r = await resolveEntry(rel);
          if (r && r.stat.isFile()) await addFile(rel, "verbatim", r.real, r.stat);
        }
      }
    } catch { /* unparseable settings: the transform stage reports it */ }
  }

  // Extra user-named files/dirs. The denylist has already had its say.
  for (const inc of includes) {
    const resolved = await resolveEntry(inc);
    if (!resolved) { if (!skippedPaths.has(inc)) skip(inc, "not found"); continue; }
    if (resolved.stat.isDirectory()) await walkDir(inc, "verbatim", resolved.real);
    else await addFile(inc, "verbatim", resolved.real, resolved.stat);
  }

  // Git: an allowlisted render of the global config and the global ignore file.
  const gitIdentity: Inventory["gitIdentity"] = {};
  const gitPairs = readGlobalGitConfig(home, opts.localGitRoot, opts.gitEnv);
  for (const p of gitPairs) {
    if (p.key.toLowerCase() === "user.name") gitIdentity.name = p.value;
    if (p.key.toLowerCase() === "user.email") gitIdentity.email = p.value;
  }

  const rendered = renderGitconfig(gitPairs, ctx);
  if (rendered.text) {
    entries.set(".gitconfig", { path: ".gitconfig", kind: "gitconfig", mode: "0600", bytes: Buffer.from(rendered.text), root: ".gitconfig" });
  }
  let ignoreRel: string | null = null;
  const excludesFile = gitPairs.find((p) => p.key.toLowerCase() === "core.excludesfile")?.value;
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
  if (total > MIRROR_SIZE_CAP) {
    const byRoot = new Map<string, number>();
    for (const e of list) byRoot.set(e.root, (byRoot.get(e.root) ?? 0) + e.bytes.length);
    const biggest = [...byRoot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([r, n]) => `${r} (${(n / 1048576).toFixed(1)} MiB)`).join(", ");
    throw new Error(`home mirror is ${(total / 1048576).toFixed(1)} MiB, over the ${MIRROR_SIZE_CAP / 1048576} MiB cap — largest: ${biggest}; exclude with \`cast config cloud_mirror_exclude\``);
  }
  return { entries: list, skipped, excludesApplied: [...excludesApplied], gitIdentity };
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
