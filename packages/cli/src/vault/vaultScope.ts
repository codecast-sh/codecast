// The ONE place vault path rules live: what a vault-relative path may address,
// where it resolves on disk, and which files are in scope. The HTTP routes, the
// watcher, and the reconcile scan all import from here — if any two of them ever
// disagreed about scope, the watcher would stream events for files the routes
// refuse to serve and the reconciler would "remove" files that were never gone
// (the syncScope.ts lesson, applied before it can happen).
//
// No vault module may re-implement any of this.

import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import {
  isRepoIgnoredSegment,
  isVaultAssetPath,
  isVaultIgnoredPath,
  isVaultMarkdownPath,
  VAULT_DOC_DIRS,
  type VaultFileEntry,
} from "@codecast/shared/contracts";

/** Walk bounds. A vault is a notes directory, not a source tree: these are high
 *  enough to never bite a real vault and low enough that pointing the daemon at
 *  `/` degrades to a truncated listing instead of an unbounded walk. */
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 16;
/** Directories scanned at once. Keeps the reconcile scan off the event loop for
 *  long stretches without opening thousands of file descriptors. */
const SCAN_CONCURRENCY = 8;

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * Content identity for a vault file: a 16-hex sha256 prefix. This ONE digest is
 * the loopback route's ETag, the write guard the browser sends back as If-Match,
 * and the content_hash the Convex mirror diffs on. A second hash function
 * anywhere in the vault would mean the mirror and the local channel could
 * disagree about whether two files are the same file.
 */
export function vaultContentHash(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** Files the vault serves: markdown plus the attachment set. Everything else on
 *  disk is invisible to the browser. */
export function isVaultServablePath(relPath: string): boolean {
  return isVaultMarkdownPath(relPath) || isVaultAssetPath(relPath);
}

// ---------------------------------------------------------------------------
// Repo scope
//
// A vault whose root is a git repository needs a wider ignore list than a notes
// folder: build output, tool caches and vendored dependencies are not writing,
// and walking them is expensive enough to matter on its own. The rule keys off
// the ROOT rather than off a vault "kind" flag, so scan, watch and resolve all
// reach the same conclusion from the one argument they all already have — and
// so a repo someone registered by hand with `cast vault add` is scoped the same
// way a discovered project vault is.
// ---------------------------------------------------------------------------

interface RepoScope {
  repo: boolean;
  /** .gitignore names, matched on any segment (git's own rule for a pattern
   *  with no slash in it). */
  names: Set<string>;
  /** .gitignore patterns anchored to the root, matched as a path prefix. */
  paths: Set<string>;
  at: number;
}

/** Re-read window for a root's repo scope. Long enough that a scan doesn't stat
 *  the same .gitignore hundreds of times, short enough that editing it takes
 *  effect while you watch. */
const REPO_SCOPE_TTL_MS = 30_000;
const GITIGNORE_MAX_BYTES = 64 * 1024;
const GITIGNORE_MAX_LINES = 500;

const repoScopeCache = new Map<string, RepoScope>();

/**
 * The subset of .gitignore we can honor without a matcher library: plain
 * names ("dist", ".env") and root-anchored paths ("/public/generated"). Globs,
 * character classes and nested .gitignore files are skipped — hiding too little
 * is a cluttered tree, hiding too much is a note the user cannot find.
 *
 * A negation (`!foo`) drops `foo` from the deny set rather than being modelled
 * properly: re-including something is the one case where guessing would hide a
 * file the repo explicitly asked to keep.
 */
export function parseGitignore(text: string): { names: Set<string>; paths: Set<string> } {
  const names = new Set<string>();
  const paths = new Set<string>();
  const negated = new Set<string>();

  for (const rawLine of text.split("\n").slice(0, GITIGNORE_MAX_LINES)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1).trim();
    if (/[*?[\]]/.test(line)) continue;
    line = line.replace(/\/+$/, "").replace(/^\/+/, "");
    if (!line || line === "." || line.includes("..")) continue;
    const target = line.includes("/") ? paths : names;
    if (negate) negated.add(line);
    else target.add(line);
  }
  for (const n of negated) {
    names.delete(n);
    paths.delete(n);
  }
  return { names, paths };
}

function repoScopeFor(realRoot: string): RepoScope {
  const cached = repoScopeCache.get(realRoot);
  if (cached && Date.now() - cached.at < REPO_SCOPE_TTL_MS) return cached;

  let repo = false;
  try {
    // A worktree checkout has .git as a FILE pointing at the real git dir, so
    // "exists" is the test, not "is a directory".
    repo = fs.existsSync(path.join(realRoot, ".git"));
  } catch {}

  let names = new Set<string>();
  let paths = new Set<string>();
  if (repo) {
    try {
      const file = path.join(realRoot, ".gitignore");
      if (fs.statSync(file).size <= GITIGNORE_MAX_BYTES) {
        ({ names, paths } = parseGitignore(fs.readFileSync(file, "utf-8")));
      }
    } catch {}
  }

  const scope: RepoScope = { repo, names, paths, at: Date.now() };
  // Bounded: one entry per vault root ever opened, and vault roots are few.
  if (repoScopeCache.size > 200) repoScopeCache.clear();
  repoScopeCache.set(realRoot, scope);
  return scope;
}

/** True when the vault root is a git repository, and repo scope rules apply. */
export function isRepoVaultRoot(root: string): boolean {
  return repoScopeFor(path.resolve(root)).repo;
}

/** Drop a root's cached repo scope. For tests, which rewrite .gitignore inside
 *  the TTL and must see the change. */
export function clearRepoScopeCache(): void {
  repoScopeCache.clear();
}

/**
 * THE scope predicate: is this vault-relative path out of bounds? Always-ignored
 * segments (.git, node_modules, .obsidian, .trash) plus, for a repo root, build
 * output, tool dot-directories and whatever the root .gitignore names.
 *
 * Every scope decision — resolve, scan, watch — comes through here.
 */
export function isVaultPathIgnored(root: string, relPath: string): boolean {
  if (isVaultIgnoredPath(relPath)) return true;
  // path.resolve, not realVaultRoot: this runs once per entry of every scan,
  // and a realpathSync per entry would be twenty thousand syscalls on a large
  // tree. A symlinked root just gets its own cache entry, which is harmless —
  // the security-critical resolution still happens in resolveVaultPath.
  const scope = repoScopeFor(path.resolve(root));
  if (!scope.repo) return false;

  const segments = relPath.split("/");
  let prefix = "";
  for (const seg of segments) {
    if (isRepoIgnoredSegment(seg)) return true;
    if (scope.names.has(seg)) return true;
    prefix = prefix === "" ? seg : `${prefix}/${seg}`;
    if (scope.paths.has(prefix)) return true;
  }
  return false;
}

export interface VaultProjectProbe {
  /** Markdown was found without walking the tree. False means "hide this from
   *  the picker" — see the honesty note on the function below. */
  hasNotes: boolean;
  /** Vault-relative directory to open at; "" means the root. */
  home: string;
}

/**
 * What the picker needs to know about a project directory, for the price of one
 * readdir (two when it has a doc directory). This is deliberately NOT a scan:
 * the picker asks this of every project the user has, so it must stay O(1) per
 * project — a recursive walk of three hundred repos on page load is the thing
 * this exists to avoid.
 *
 * The home rule: a repo's prose lives in docs/, doc/, wiki/ or notes/ when it
 * has one, and a repo root is mostly source directories, so landing there hides
 * what the user came for. First match wins; the root is the fallback. A doc
 * directory that holds nothing doesn't count — an empty scaffolded `docs/` is a
 * worse landing than the root.
 *
 * hasNotes is a LOWER BOUND, and a deliberate one: it sees root-level markdown
 * and the doc directory, not markdown buried in src/. A repo whose only prose
 * is a nested README is therefore hidden. The alternative — walking every repo
 * to be sure — costs more than the mistake does, and any repo with real docs
 * has a README or a docs/ at the top.
 */
export function probeProjectVault(root: string): VaultProjectProbe {
  const realRoot = path.resolve(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realRoot, { withFileTypes: true });
  } catch {
    return { hasNotes: false, home: "" };
  }

  let hasNotes = false;
  const dirs = new Set<string>();
  for (const e of entries) {
    if (e.isDirectory()) dirs.add(e.name);
    else if (e.isFile() && isVaultMarkdownPath(e.name)) hasNotes = true;
  }

  for (const dir of VAULT_DOC_DIRS) {
    if (!dirs.has(dir)) continue;
    let docEntries: fs.Dirent[];
    try {
      docEntries = fs.readdirSync(path.join(realRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    // A subdirectory counts: a docs/ split into sections is the common shape,
    // and descending into each to confirm would undo the cheapness.
    const populated = docEntries.some(
      (e) => (e.isFile() && isVaultMarkdownPath(e.name)) || e.isDirectory(),
    );
    if (populated) return { hasNotes: true, home: dir };
  }
  return { hasNotes, home: "" };
}

/** Where a project vault opens — see probeProjectVault for the rule. */
export function vaultProjectHome(root: string): string {
  return probeProjectVault(root).home;
}

/** Vault-relative form of a "/"-separated path: no leading slash, no "." or ""
 *  segments. Returns null when the path escapes (a ".." segment) or is unusable
 *  (NUL byte, absolute Windows path). */
export function normalizeVaultPath(input: string): string | null {
  if (typeof input !== "string" || input.includes("\0")) return null;
  if (/^[a-zA-Z]:[\\/]/.test(input)) return null;
  const segments: string[] = [];
  for (const seg of input.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    segments.push(seg);
  }
  return segments.join("/");
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** Real path of `target`, resolving symlinks on however much of it exists. A
 *  path whose leaf doesn't exist yet (a file about to be created) still gets its
 *  existing ancestors resolved, so a symlinked parent can't smuggle a write out
 *  of the vault. */
function realpathDeepest(target: string): string {
  const trailing: string[] = [];
  let cur = target;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return target;
      trailing.push(path.basename(cur));
      cur = parent;
    }
  }
}

function sameOrInside(root: string, candidate: string): boolean {
  const a = CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
  const b = CASE_INSENSITIVE_FS ? candidate.toLowerCase() : candidate;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** The vault root as it exists on disk, with symlinks resolved. Every resolved
 *  path is built from and compared against this, so a symlinked root (macOS
 *  /var → /private/var, a vault kept in a linked directory) is not an escape. */
export function realVaultRoot(root: string): string {
  return realpathOrSelf(path.resolve(root));
}

/**
 * Absolute on-disk path for a vault-relative path, or null when it is out of
 * scope. Rejects traversal, absolute paths, ignored segments (.git, .obsidian,
 * .trash, node_modules), and anything that resolves — through symlinks, at any
 * depth, whether or not the leaf exists yet — outside the root. Symlinks inside
 * the vault are rejected outright: they are not part of a vault, and following
 * one on a write would put bytes somewhere the user never registered.
 *
 * Existence is NOT checked; callers decide whether a missing file is a 404 or a
 * file to create.
 */
export function resolveVaultPath(root: string, relPath: string): string | null {
  const rel = normalizeVaultPath(relPath);
  if (rel === null) return null;
  if (rel !== "" && isVaultPathIgnored(root, rel)) return null;

  const realRoot = realVaultRoot(root);
  const target = rel === "" ? realRoot : path.join(realRoot, ...rel.split("/"));
  if (!sameOrInside(realRoot, target)) return null;
  if (!sameOrInside(realRoot, realpathDeepest(target))) return null;

  try {
    if (fs.lstatSync(target).isSymbolicLink()) return null;
  } catch {
    // Doesn't exist yet — nothing to link anywhere.
  }
  return target;
}

/** Vault-relative "/"-separated path for an absolute path under `root`, or null
 *  when it sits outside the vault or is out of scope. */
export function vaultRelativePath(root: string, absPath: string): string | null {
  const realRoot = realVaultRoot(root);
  // Resolve the candidate too: the watcher reports paths under the root as it
  // was registered (/var/... on macOS), which is a symlink to the real root
  // (/private/var/...) — comparing the two unresolved would drop every event.
  const abs = realpathDeepest(path.resolve(absPath));
  if (!sameOrInside(realRoot, abs)) return null;
  const rel = path.relative(realRoot, abs);
  if (rel === "") return "";
  return normalizeVaultPath(rel);
}

/** Content type for a served file, by extension. Images and PDFs must arrive
 *  with the right type or the browser downloads them instead of rendering. */
export function vaultContentType(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown": return "text/markdown; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".avif": return "image/avif";
    case ".pdf": return "application/pdf";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

/**
 * Full listing of a vault: every servable file plus every directory (so empty
 * folders render), sorted by path. Symlinks are skipped — the same rule
 * resolveVaultPath enforces, so nothing appears in a scan that a fetch would
 * then refuse.
 */
export async function scanVault(root: string): Promise<VaultFileEntry[]> {
  const realRoot = realVaultRoot(root);
  const out: VaultFileEntry[] = [];
  let queue: { abs: string; rel: string; depth: number }[] = [{ abs: realRoot, rel: "", depth: 0 }];

  while (queue.length > 0 && out.length < MAX_ENTRIES) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    const next: typeof queue = [];
    await Promise.all(batch.map(async (dir) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir.abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const rel = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
        if (isVaultPathIgnored(realRoot, rel)) continue;
        const abs = path.join(dir.abs, entry.name);
        if (entry.isDirectory()) {
          const stat = await fsp.stat(abs).catch(() => null);
          if (!stat) continue;
          out.push({ path: rel, mtime: Math.round(stat.mtimeMs), size: 0, dir: true });
          if (dir.depth + 1 < MAX_DEPTH) next.push({ abs, rel, depth: dir.depth + 1 });
        } else if (entry.isFile()) {
          if (!isVaultServablePath(rel)) continue;
          const stat = await fsp.stat(abs).catch(() => null);
          if (!stat) continue;
          out.push({ path: rel, mtime: Math.round(stat.mtimeMs), size: stat.size });
        }
      }
    }));
    queue = next.concat(queue);
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.slice(0, MAX_ENTRIES);
}


/** How to show a path in the OS file manager, or hand it to its default
 *  application. Split out from the spawning so the platform differences — the
 *  ones that are easy to get wrong and silent when wrong — are testable
 *  without launching anything.
 *
 *  `reveal` means "show me this file where it lives, selected". macOS and
 *  Windows both have a verb for that; Linux desktops do not, so the containing
 *  folder is the closest honest equivalent.
 */
export function revealCommand(
  platform: NodeJS.Platform,
  abs: string,
  mode: "reveal" | "open",
): { cmd: string; args: string[] } {
  const asOpen = mode === "open";
  if (platform === "darwin") {
    return { cmd: "open", args: asOpen ? [abs] : ["-R", abs] };
  }
  if (platform === "win32") {
    // explorer takes the selection as ONE comma-joined argument; a space after
    // the comma makes it open the user's Documents folder instead.
    return { cmd: "explorer", args: asOpen ? [abs] : [`/select,${abs}`] };
  }
  return { cmd: "xdg-open", args: [asOpen ? abs : path.dirname(abs)] };
}
