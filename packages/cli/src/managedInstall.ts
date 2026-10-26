// A managed install: the binary an organization's MDM put on the machine with
// Codecast.pkg, at /usr/local/bin/codecast, owned by root. The person cannot
// replace it and must not try (a self-update would fail, or prompt), so it is
// updated by the MDM shipping a newer pkg. Any root-owned binary counts, so a
// distro package on Linux is treated the same way.
//
// A person who installed per user before their Mac was managed still has
// ~/.local/bin/codecast. Left alone, that copy keeps updating itself and every
// run of it rewrites the daemon's launcher to point at itself, so the daemon
// would flip between two binaries depending on which one ran last. The managed
// binary wins: `adoptManagedBinary` turns the per-user copies into symlinks to
// it, so `cast` from a shell, the desktop app and the daemon all run the same
// file. `codecast mdm enroll` calls it as the logged-in user.

import * as fs from "node:fs";
import * as path from "node:path";

export const MANAGED_BINARY_PATH = "/usr/local/bin/codecast";

/** Where earlier per-user installs put the binary, relative to $HOME (install.sh, older releases). */
const PER_USER_BINARIES = [".local/bin/codecast", ".codecast/bin/codecast"];

type Stat = (p: string) => { uid: number };

/** True when the running binary belongs to root: updates come from whoever installed it, never from a self-update. */
export function isManagedInstall(execPath = process.execPath, stat: Stat = fs.statSync, platform = process.platform): boolean {
  if (platform !== "darwin" && platform !== "linux") return false;
  try {
    return stat(execPath).uid === 0;
  } catch {
    return false;
  }
}

/**
 * Point every per-user copy of the binary at the managed one. Idempotent: a
 * path that is already a symlink is left as it is, and nothing happens unless
 * the managed binary is present and root-owned. Returns the paths it replaced.
 */
export function adoptManagedBinary(home: string, managed = MANAGED_BINARY_PATH): string[] {
  if (!isManagedInstall(managed)) return [];
  const replaced: string[] = [];
  for (const rel of PER_USER_BINARIES) {
    const p = path.join(home, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    const tmp = `${p}.managed-${process.pid}`;
    fs.symlinkSync(managed, tmp);
    fs.renameSync(tmp, p);
    replaced.push(p);
  }
  return replaced;
}
