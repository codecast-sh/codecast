import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

/**
 * One atomic file write for the whole CLI.
 *
 * The daemon has no atomic write at all today: its remote `config_write` handler
 * calls `fs.writeFileSync` straight onto the target, so a crash, a power loss or
 * a kill between truncate and the last byte leaves the user with a truncated —
 * often unparseable — `~/.claude/settings.json`. That is the reason this module
 * exists: every config write should go through here.
 *
 * The body is lifted from the journal's version (`FileExecutionOperationJournal`
 * in `execution/localJournal.ts`), which was the strictest of the four
 * hand-rolled copies (the others: `writeAccountFile` in `ccAccounts.ts`, the
 * private `atomicWriteFile` in `codexAccounts.ts`, `writeProviderKeyStore` in
 * `providerKeyStore.ts`):
 *
 *  - the temp name carries pid + uuid and opens with "wx", so two writers can
 *    never share a temp file and a stale temp can never be adopted;
 *  - the payload is fsynced before the rename, so the rename can only publish
 *    bytes the disk has actually acknowledged;
 *  - `rename` is the publish step, and it is atomic within a filesystem, so a
 *    concurrent reader sees the whole old file or the whole new one — never a
 *    partial one;
 *  - the temp file is removed on every failure path, and temps stranded by a
 *    kill are swept by the next successful write.
 *
 * The mode rule comes from `writeProviderKeyStore`, the only copy that got it
 * right: `open`/`writeFile` modes are masked by the process umask, so a caller
 * asking for 0600 under a loose umask could still get 0600 but a caller asking
 * for 0666 would silently get 0644. An explicit `fchmod` after creation makes
 * the requested mode the mode on disk.
 *
 * Two limits are inherent to publishing by rename, not oversights:
 *
 *  - A hardlinked file does not survive. Rename swaps the directory entry, so
 *    the other name keeps pointing at the old inode with the old bytes. No
 *    scheme publishes atomically AND preserves a hardlink; a caller that needs
 *    the link must write in place and accept the torn window.
 *  - The temp file lands beside the target, so the rename never crosses a
 *    filesystem. Passing a target on a different filesystem is fine; passing one
 *    whose directory is not writable is not, and fails before anything is
 *    published.
 */
export interface AtomicWriteOptions {
  /**
   * Exact permissions for the published file. Omit to keep the mode the file
   * already has — overwriting a user's 0644 settings.json must not quietly
   * narrow it, and overwriting a 0600 credential file must not widen it.
   * Defaults to 0600 when the file does not exist yet.
   */
  mode?: number;
}

/** Temps stranded by a kill are swept once they are older than this. The floor
 *  exists so the sweep can never race a concurrent writer's live temp file. */
const STALE_TEMP_MS = 60_000;

/** Mode of an existing file, or undefined when it is not there / not readable. */
function currentMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * A directory has to be executable to reach the file inside it, so the file's
 * own mode decides the directory's: 0600 -> 0700, 0644 -> 0755. One rule instead
 * of a second knob, and it keeps a credential's directory private while a
 * project file's directory stays reachable by the group that can read the file.
 */
function directoryModeFor(fileMode: number): number {
  return fileMode | ((fileMode & 0o444) >> 2);
}

/**
 * Resolve a symlink chain to the file it names.
 *
 * A config file is very often a symlink into a dotfiles repo — that is the usual
 * shape of `~/.claude/settings.json` and `~/.codex/config.toml`. Renaming over
 * the link would delete it and leave a regular file in its place, so the repo
 * copy would freeze at its last value and every later write would land somewhere
 * the user is not looking.
 *
 * `fs.realpathSync` is not usable here: it throws on a dangling symlink, and a
 * link pointing at a file that does not exist yet is a file this helper is
 * supposed to create.
 */
function resolveLinkTarget(filePath: string): string {
  let current = filePath;
  for (let hops = 0; hops < 40; hops++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current; // Nothing there yet: this is the path to create.
    }
    if (!stat.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  throw new Error(
    `atomicWriteFile: ${filePath} is a symlink loop (still linking after 40 hops). ` +
      `Run \`ls -l\` along the chain and repoint or delete the link that closes it.`,
  );
}

const escapeForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Delete temp files left by writers that died before their `finally` could run.
 *
 * A SIGKILL, an OOM kill or a power loss — the failures this module exists for —
 * skip the cleanup entirely, and because every temp name carries a fresh uuid
 * each death strands a NEW file. Unswept, they accumulate without bound in
 * directories the user opens: `~/.claude`, `~/.codex`, a project root holding
 * `.mcp.json`.
 *
 * The pattern demands this module's own pid.uuid shape, so the sweep can only
 * ever remove a file this module wrote.
 */
function sweepStrandedTemps(dir: string, baseName: string): void {
  const mine = new RegExp(`^\\.${escapeForRegExp(baseName)}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const name of names) {
    if (!mine.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // Another writer swept it first, or it is still being written. Either way
      // there is nothing to do and nothing to report.
    }
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
  const target = resolveLinkTarget(filePath);
  const dir = path.dirname(target);
  const baseName = path.basename(target);
  const mode = options.mode ?? currentMode(target) ?? 0o600;

  fs.mkdirSync(dir, { recursive: true, mode: directoryModeFor(mode) });

  // pid + uuid: two processes (or two writes in one process) must never collide
  // on the temp path, because a shared temp file is exactly the torn write this
  // helper exists to prevent.
  const tempPath = path.join(dir, `.${baseName}.${process.pid}.${randomUUID()}.tmp`);

  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    // The umask masks the mode passed to open, so ask for it again explicitly.
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.renameSync(tempPath, target);
    } catch (err) {
      // The common cause is a target that is a directory, where node reports
      // ENOTEMPTY/EISDIR against the temp path and never names the real problem.
      throw new Error(
        `atomicWriteFile: cannot publish ${target}: ${(err as Error).message}. ` +
          `Check that it is a file and not a directory, and that ${dir} is writable.`,
        { cause: err },
      );
    }

    // Persist the directory entry where supported. Some filesystems reject
    // fsync on a directory; the file itself has still been fsynced + renamed.
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

    // After publishing, so a failure here can never cost a write that succeeded.
    sweepStrandedTemps(dir, baseName);
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
