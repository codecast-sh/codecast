// How bytes land in a vault, and how a path leaves one. Both writers — the
// loopback routes the browser uses (vaultServer.ts) and the `cast vault`
// commands an agent uses — go through here, so a note saved from a browser tab
// and a note saved from a terminal are written the same way and a delete means
// the same thing on both. Two implementations of "delete a note" is how one of
// them ends up doing an unrecoverable unlink.
//
// Path rules are NOT here: every absolute path passed in must already have come
// from vaultScope.resolveVaultPath.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { realVaultRoot } from "./vaultScope.js";

/**
 * Write a file into the vault, creating its parent folders. Write-then-rename,
 * so a reader (or a crash) never sees a half-written note.
 */
export async function writeVaultFile(abs: string, data: Buffer | string): Promise<fs.Stats> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, abs);
  return fsp.stat(abs);
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
  const home = process.env.HOME || os.homedir();
  const osTrash =
    process.platform === "darwin"
      ? path.join(home, ".Trash")
      : process.platform === "linux"
        ? path.join(home, ".local", "share", "Trash", "files")
        : null;

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
