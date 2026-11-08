/**
 * Which build of cast a bridge host runs, so a CLI that is newer can replace
 * a host that outlived an upgrade (host.ts ensureBridgeHost, /retire).
 *
 * A build is `<version>` for a compiled binary and `<version>+<sha12>.<commit
 * time>` when cast runs from a checkout, where the sha and the time are the
 * checkout's HEAD commit. The commit is for status only: "newer" is the CLI
 * version alone. A swap drops every connected client (engine sockets, watch
 * streams, cloud hosts) and an older extension detaches every agent tab when
 * its host goes, so it happens once per release, never once per commit
 * (origin/main takes dozens a day), and two checkouts of the same version
 * never take the host from each other.
 *
 * CAST_BRIDGE_BUILD overrides the whole stamp for this process (tests and
 * the rig start a host that reads as old).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../../proc.js";
import { getVersion } from "../../cliVersion.js";
import { compareVersions } from "../engine.js";

export interface HostBuild {
  version: string;
  commit?: string;
  commitTime?: number;
}

export function parseBuild(stamp: string | undefined | null): HostBuild | null {
  if (!stamp) return null;
  const m = /^(\d+(?:\.\d+)*)(?:\+([0-9a-f]{7,40})\.(\d+))?$/.exec(stamp);
  if (!m) return null;
  return { version: m[1], ...(m[2] ? { commit: m[2], commitTime: parseInt(m[3], 10) } : {}) };
}

export function formatBuild(b: HostBuild): string {
  return b.commit && b.commitTime !== undefined ? `${b.version}+${b.commit}.${b.commitTime}` : b.version;
}

/** Is `mine` a newer CLI version than `theirs`? Commits never order builds. */
export function isNewerBuild(mine: HostBuild, theirs: HostBuild): boolean {
  return compareVersions(mine.version, theirs.version) > 0;
}

/** The checkout this source file sits in: its git dir and the shared one, or null for a compiled binary. */
function gitDirs(): { gitDir: string; commonDir: string; root: string } | null {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  if (dir.startsWith("/$bunfs") || dir.startsWith("B:")) return null;
  for (let i = 0; i < 12; i++) {
    const dotGit = path.join(dir, ".git");
    try {
      const st = fs.statSync(dotGit);
      const gitDir = st.isDirectory() ? dotGit : path.resolve(dir, fs.readFileSync(dotGit, "utf-8").replace(/^gitdir:\s*/, "").trim());
      let commonDir = gitDir;
      try {
        commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim());
      } catch {}
      return { gitDir, commonDir, root: dir };
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** HEAD's sha read straight from the git dir: no git process on every command. */
function headSha(dirs: { gitDir: string; commonDir: string }): string | null {
  try {
    const head = fs.readFileSync(path.join(dirs.gitDir, "HEAD"), "utf-8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return null;
    for (const base of [dirs.gitDir, dirs.commonDir]) {
      try {
        const sha = fs.readFileSync(path.join(base, ref), "utf-8").trim();
        if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      } catch {}
    }
    const packed = fs.readFileSync(path.join(dirs.commonDir, "packed-refs"), "utf-8");
    return new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed)?.[1] ?? null;
  } catch {
    return null;
  }
}

let cachedFull: HostBuild | undefined;

/** This process's whole build, commit time included (one `git log` for a checkout). */
export function currentBuild(): HostBuild {
  const env = parseBuild(process.env.CAST_BRIDGE_BUILD);
  if (env) return env;
  if (cachedFull) return cachedFull;
  const version = getVersion();
  const dirs = gitDirs();
  const sha = dirs ? headSha(dirs) : null;
  if (!dirs || !sha) return (cachedFull = { version });
  const out = spawnSync("git", ["-C", dirs.root, "log", "-1", "--format=%ct", sha], { encoding: "utf-8", timeout: 5_000 });
  const commitTime = parseInt(String(out.stdout ?? "").trim(), 10);
  return (cachedFull = Number.isFinite(commitTime) ? { version, commit: sha.slice(0, 12), commitTime } : { version });
}

/**
 * Should this CLI replace a host that stamped `stamp`? Only for an older CLI
 * version; never for a host that stamps nothing (it predates stamps, and has
 * no idle check to ask). No git process: the version is all it reads.
 */
export function shouldReplaceHost(stamp: string | undefined): boolean {
  const theirs = parseBuild(stamp);
  if (!theirs) return false;
  return isNewerBuild(parseBuild(process.env.CAST_BRIDGE_BUILD) ?? { version: getVersion() }, theirs);
}
