// Claude Code's native installer keeps every release at
// ~/.local/share/claude/versions/<version> and re-points the ~/.local/bin/claude
// symlink at the newest one. macOS keys a bare executable's "Files and Folders"
// grants (Downloads, Documents, Desktop, iCloud Drive, ...) by the executable's
// RESOLVED path plus its code-signing designated requirement, and Claude Code
// takes responsibility for its own process (the dialog names the binary, never
// the terminal or the daemon that launched it). So to TCC every update is a
// brand-new app, titled with the version ("2.1.241" would like to access ...),
// and the user answers every folder prompt again.
//
// The signature is already stable across releases (Developer ID Application:
// Anthropic PBC, identifier com.anthropic.claude-code), so a copy of the current
// release at ONE fixed path keeps its grants forever: new bytes at the old path
// still satisfy the stored requirement. APFS clones the 300 MB copy for free,
// and every launch re-checks the installer's symlink, so a session started
// through codecast always runs the version the user installed.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { whichBin } from "./proc.js";

/** A native-installer release: `.../claude/versions/<version>` (basename is a version). */
export const CLAUDE_VERSIONED_BINARY_RE = /\/claude\/versions\/[^/]+$/;

export const STABLE_CLAUDE_DIR = path.join(os.homedir(), ".codecast", "bin");

export interface StableClaudeBinaryOptions {
  platform?: NodeJS.Platform;
  /** Where `claude` resolves on PATH, symlinks followed. */
  resolveClaude?: () => string | null;
  /** Directory holding the fixed-path copy. */
  dir?: string;
  warn?: (message: string) => void;
}

/** Where installers put `claude` when it is not on the caller's PATH: the daemon
 *  runs under launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `which` alone
 *  misses every user-level install. */
export const CLAUDE_INSTALL_CANDIDATES = [
  path.join(os.homedir(), ".local/bin/claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  path.join(os.homedir(), ".npm/bin/claude"),
];

/** The installed claude executable, symlinks followed: PATH first, then the
 *  known install locations. Null when claude is not installed. */
export function resolveClaudeInstall(
  candidates: string[] = CLAUDE_INSTALL_CANDIDATES,
  which: (name: string) => string | null = whichBin,
): string | null {
  for (const found of [which("claude"), ...candidates]) {
    if (!found) continue;
    try {
      const real = fs.realpathSync(found);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The fixed-path copy of the installed Claude Code release, refreshed when the
 * installer has moved on. Null when there is nothing to stabilise: not macOS,
 * no claude on PATH, an install whose path is already stable (npm, homebrew),
 * or a copy that failed (the caller launches the installer's path instead).
 */
export function stableClaudeBinary(opts: StableClaudeBinaryOptions = {}): string | null {
  if ((opts.platform ?? process.platform) !== "darwin") return null;
  const source = (opts.resolveClaude ?? resolveClaudeInstall)();
  if (!source || !CLAUDE_VERSIONED_BINARY_RE.test(source)) return null;
  const dir = opts.dir ?? STABLE_CLAUDE_DIR;
  const copy = path.join(dir, "claude");
  const stamp = `${copy}.source`;
  try {
    if (isCurrent(copy, stamp, source)) return copy;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.claude.${process.pid}.tmp`);
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tmp, 0o755);
    // Atomic swap: a session already running keeps its old inode.
    fs.renameSync(tmp, copy);
    fs.writeFileSync(stamp, source);
    return copy;
  } catch (err) {
    opts.warn?.(`stable claude binary: ${(err as Error).message}; launching ${source} instead`);
    return null;
  }
}

/** The copy came from this exact release file and is not truncated. */
function isCurrent(copy: string, stamp: string, source: string): boolean {
  try {
    if (fs.readFileSync(stamp, "utf-8").trim() !== source) return false;
    return fs.statSync(copy).size === fs.statSync(source).size;
  } catch {
    return false;
  }
}
