// How bytes land in a vault, and how a path leaves one. Both writers — the
// loopback routes the browser uses (vaultServer.ts) and the `cast files`
// commands an agent uses — go through here, so a note saved from a browser tab
// and a note saved from a terminal are written the same way and a delete means
// the same thing on both. Two implementations of "delete a note" is how one of
// them ends up doing an unrecoverable unlink.
//
// Path rules are NOT here: every absolute path passed in must already have come
// from vaultScope.resolveVaultPath.

import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { foldCase, realVaultRoot } from "./vaultScope.js";

// Per-path FIFO locks, in this process. Each entry is the tail of the queue for
// that path; it is removed when the last holder releases, so the map holds only
// paths with work in flight.
const pathLocks = new Map<string, Promise<void>>();

async function acquirePathLock(key: string): Promise<() => void> {
  const prev = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const tail = prev.then(() => held);
  pathLocks.set(key, tail);
  await prev;
  return () => {
    release();
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  };
}

/**
 * Run `fn` holding the lock for every path in `paths`, so a read-compare-write
 * (the If-Match guard) cannot interleave with another one on the same file.
 * Keys are taken in sorted order, so a rename locking source and destination
 * cannot deadlock against one locking them the other way round.
 *
 * In-process only: `cast files` runs in its own process and an agent's editor
 * is another, and those still race the daemon. The guard narrows that window to
 * the stat-to-rename gap; it does not close it.
 */
export async function withPathLock<T>(paths: string | string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set((typeof paths === "string" ? [paths] : paths).map(foldCase))].sort();
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) releases.push(await acquirePathLock(key));
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/**
 * Write a file into the vault, creating its parent folders. The bytes land
 * exactly as given, and an existing file keeps its mode bits (an executable
 * script stays executable), owner and group.
 *
 * Write-then-rename, so a reader (or a crash) never sees a half-written file:
 * the bytes go to a sibling temp file, are fsynced, and replace the target in
 * one rename. A rename makes a NEW inode, which would quietly break two things,
 * so those cases write in place instead (vim's `backupcopy=auto` rule):
 *   - a file with hard links, whose other names would keep the old bytes;
 *   - a file whose owner or group the temp file cannot take (owned by another
 *     user, or a group this process is not in), which would change hands.
 * The in-place write truncates and rewrites the one inode, so it is not atomic:
 * a crash mid-write can leave a short file. That is the price of keeping the
 * link or the ownership intact, and both cases are rare in a source tree. It
 * also drops setuid/setgid, which the kernel clears on a write by anyone but
 * root. Extended attributes and ACLs do not survive the rename path.
 */
export async function writeVaultFile(abs: string, data: Buffer | string): Promise<fs.Stats> {
  const dir = path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true });
  // lstat: a symlink at the target is replaced, never written through.
  const prior = await fsp.lstat(abs).then((st) => (st.isFile() ? st : null), () => null);
  if (prior && prior.nlink > 1) return writeInPlace(abs, data);

  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    const fh = await fsp.open(tmp, "wx", prior ? prior.mode & 0o7777 : 0o666);
    let keepsOwner = true;
    try {
      // Owner first: a file we cannot hand back is not written twice.
      if (prior) {
        const mine = await fh.stat();
        if (mine.uid !== prior.uid || mine.gid !== prior.gid) {
          keepsOwner = await fh.chown(prior.uid, prior.gid).then(() => true, () => false);
        }
      }
      if (keepsOwner) {
        await fh.writeFile(data);
        // Mode last: open's mode is masked by the umask, and both chown and a
        // write clear setuid/setgid, so only a chmod after them keeps all bits.
        if (prior) await fh.chmod(prior.mode & 0o7777);
        await fh.sync();
      }
    } finally {
      await fh.close();
    }
    if (!keepsOwner) {
      await fsp.rm(tmp, { force: true });
      return writeInPlace(abs, data);
    }
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return fsp.stat(abs);
}

/**
 * Create a file that must not exist yet, failing with EEXIST if it does,
 * whoever made it: the daemon's path lock cannot see `cast files` or an outside
 * editor, so only the kernel's O_EXCL check makes "create" mean create. No
 * temp-and-rename: a new file has no earlier contents for a reader to lose, and
 * a failed write removes it again.
 */
export async function createVaultFile(abs: string, data: Buffer | string): Promise<fs.Stats> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const fh = await fsp.open(abs, "wx", 0o666);
  try {
    try {
      await fh.writeFile(data);
      await fh.sync();
      return await fh.stat();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await fsp.rm(abs, { force: true }).catch(() => {});
    throw err;
  }
}

async function writeInPlace(abs: string, data: Buffer | string): Promise<fs.Stats> {
  // "r+" then truncate, never "w": the file must already exist, so a target
  // removed under us is an error rather than a fresh file with default mode.
  const fh = await fsp.open(abs, "r+");
  try {
    await fh.truncate(0);
    await fh.writeFile(data);
    await fh.sync();
    return await fh.stat();
  } finally {
    await fh.close();
  }
}

/** Where this platform's trash keeps files under `home`; null where there is none. */
export function osTrashDir(home: string): string | null {
  if (process.platform === "darwin") return path.join(home, ".Trash");
  if (process.platform === "linux") return path.join(home, ".local", "share", "Trash", "files");
  return null;
}

/**
 * Move a path out of the vault instead of deleting it. A vault is the user's
 * writing; an unlink here is unrecoverable data loss from a stray click in a
 * browser tab or a mistyped path in a terminal. Preference order: the OS trash,
 * then a `.trash` folder inside the vault itself (which the scan ignores) when
 * the trash is on another volume.
 */
export function moveToTrash(vaultRoot: string, abs: string): string {
  const base = path.basename(abs);
  // $HOME, not os.homedir(): the rest of the CLI resolves the home directory the
  // same way, and bun's os.homedir() is fixed at process start regardless of it.
  const osTrash = osTrashDir(process.env.HOME || os.homedir());

  const attempt = (dir: string): string | null => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, base);
      for (let n = 2; fs.existsSync(dest); n++) {
        const ext = path.extname(base);
        dest = path.join(dir, `${base.slice(0, base.length - ext.length)} ${n}${ext}`);
      }
      fs.renameSync(abs, dest);
      return dest;
    } catch {
      return null;
    }
  };

  const viaOs = osTrash ? attempt(osTrash) : null;
  if (viaOs) return viaOs;
  // Cross-device rename (EXDEV) or no OS trash: keep it on the same volume.
  const local = attempt(path.join(realVaultRoot(vaultRoot), ".trash"));
  if (local) return local;
  throw new Error("could not move to trash");
}
