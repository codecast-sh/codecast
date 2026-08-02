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
  isVaultAssetPath,
  isVaultIgnoredPath,
  isVaultMarkdownPath,
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
  if (rel !== "" && isVaultIgnoredPath(rel)) return null;

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
        if (isVaultIgnoredPath(rel)) continue;
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
