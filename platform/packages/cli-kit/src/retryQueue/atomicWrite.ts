// Atomic file publish: write a temp file beside the target, fsync, rename.
// Lifted from codecast's packages/cli/src/atomicWrite.ts; a reader sees the
// whole old file or the whole new one, never a torn one. Symlinks are
// followed so a dotfiles repo copy keeps receiving writes, and temps stranded
// by a kill are swept once they are a minute old.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  /** Exact permissions for the published file. Omit to keep the current mode,
   *  or 0600 when the file does not exist yet. */
  mode?: number;
}

const STALE_TEMP_MS = 60_000;

function currentMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** 0600 -> 0700, 0644 -> 0755: a directory must be executable to reach the file. */
function directoryModeFor(fileMode: number): number {
  return fileMode | ((fileMode & 0o444) >> 2);
}

function resolveLinkTarget(filePath: string): string {
  let current = filePath;
  for (let hops = 0; hops < 40; hops++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current;
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
    } catch {}
  }
}

export function atomicWriteFile(filePath: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const target = resolveLinkTarget(filePath);
  const dir = path.dirname(target);
  const baseName = path.basename(target);
  const mode = options.mode ?? currentMode(target) ?? 0o600;
  fs.mkdirSync(dir, { recursive: true, mode: directoryModeFor(mode) });
  const tempPath = path.join(dir, `.${baseName}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.renameSync(tempPath, target);
    } catch (err) {
      throw new Error(
        // The common cause is a target that is a directory, where node reports
        // ENOTEMPTY/EISDIR against the temp path and never names the real problem.
        `atomicWriteFile: cannot publish ${target}: ${(err as Error).message}. ` +
          `Check that it is a file and not a directory, and that ${dir} is writable.`,
        { cause: err },
      );
    }
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {}
    sweepStrandedTemps(dir, baseName);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}
