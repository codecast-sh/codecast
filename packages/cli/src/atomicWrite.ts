import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

/**
 * One atomic file write for the whole CLI.
 *
 * The daemon has no atomic write at all today: the remote config handler at
 * `daemon.ts:4322` calls `fs.writeFileSync` straight onto the target, so a
 * crash, a power loss or a kill between truncate and the last byte leaves the
 * user with a truncated — often unparseable — `~/.claude/settings.json`. That
 * is the reason this module exists: every config write should go through here.
 *
 * The body is lifted from the journal's version (`execution/localJournal.ts:297`),
 * which was the strictest of the four hand-rolled copies (the others:
 * `ccAccounts.ts:81`, `codexAccounts.ts:154`, `providerKeyStore.ts:53`):
 *
 *  - the parent directory is created 0700, so a secret never lands in a
 *    world-readable directory that the write itself created;
 *  - the temp name carries pid + uuid and opens with "wx", so two writers can
 *    never share a temp file and a stale temp can never be adopted;
 *  - the payload is fsynced before the rename, so the rename can only publish
 *    bytes the disk has actually acknowledged;
 *  - `rename` is the publish step, and it is atomic within a filesystem, so a
 *    concurrent reader sees the whole old file or the whole new one — never a
 *    partial one;
 *  - the temp file is removed on every failure path.
 *
 * The mode rule comes from `providerKeyStore.ts:55`, the only copy that got it
 * right: `open`/`writeFile` modes are masked by the process umask, so a caller
 * asking for 0600 under a loose umask could still get 0600 but a caller asking
 * for 0666 would silently get 0644. An explicit `fchmod` after creation makes
 * the requested mode the mode on disk.
 */
export interface AtomicWriteOptions {
  /**
   * Exact permissions for the published file. Omit to keep the mode the file
   * already has — overwriting a user's 0644 settings.json must not quietly
   * narrow it, and overwriting a 0600 credential file must not widen it.
   * Defaults to 0600 when the file does not exist yet.
   */
  mode?: number;
  /** Permissions for directories this call has to create. */
  dirMode?: number;
  /**
   * fsync the payload before publishing it. On by default; the only reason to
   * turn it off is a cache file where a crash losing the write is harmless and
   * the flush cost is not.
   */
  fsync?: boolean;
}

/** Mode of an existing file, or undefined when it is not there / not readable. */
function currentMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write `content` to `filePath` so that a concurrent reader observes either the
 * previous file or this one, never a mix of the two.
 */
export function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(filePath);
  const mode = options.mode ?? currentMode(filePath) ?? 0o600;
  const shouldFsync = options.fsync !== false;

  fs.mkdirSync(dir, { recursive: true, mode: options.dirMode ?? 0o700 });

  // pid + uuid: two processes (or two writes in one process) must never collide
  // on the temp path, because a shared temp file is exactly the torn write this
  // helper exists to prevent.
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    // The umask masks the mode passed to open, so ask for it again explicitly.
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    if (shouldFsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);

    // Persist the directory entry where supported. Some filesystems reject
    // fsync on a directory; the file itself has still been fsynced + renamed.
    if (shouldFsync) {
      try {
        const dirFd = fs.openSync(dir, "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Best effort only for the directory metadata.
      }
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful is left to do with a descriptor we cannot close.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // A successful rename consumes the temporary path.
    }
  }
}
