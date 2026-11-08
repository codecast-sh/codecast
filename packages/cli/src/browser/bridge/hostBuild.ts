/**
 * Which build of cast a bridge host runs, so a CLI that is newer can replace
 * a host that outlived an upgrade (host.ts ensureBridgeHost, /retire).
 *
 * A build is `<version>` for a compiled binary and `<version>+<sha12>.<commit
 * time>` when cast runs from a checkout, where the sha and the time are the
 * checkout's HEAD commit. Only a committed change or a version bump makes a
 * new build: edits in the working tree do not, so a host never restarts
 * while files are being edited, only once they are committed (or pulled).
 *
 * "Newer" is a total order, which is what keeps two checkouts from taking
 * the host from each other: a higher version wins; at the same version a
 * later commit time wins; anything else (the same commit, a tie, a compiled
 * build against a checkout of the same version) leaves the host alone. So a
 * worktree at an older commit never replaces a host started from a newer
 * one, and the swap happens at most once per new commit.
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

/** Is `mine` newer than `theirs`? False whenever the two cannot be ordered. */
export function isNewerBuild(mine: HostBuild, theirs: HostBuild): boolean {
  const v = compareVersions(mine.version, theirs.version);
  if (v !== 0) return v > 0;
  if (mine.commitTime === undefined || theirs.commitTime === undefined) return false;
  return mine.commitTime > theirs.commitTime;
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

let cachedQuick: string | null | undefined;
let cachedFull: HostBuild | undefined;

/** This process's build without its commit time: `<version>` or `<version>+<sha12>`. Cheap; read on every probe. */
export function quickBuildId(): string {
  const env = process.env.CAST_BRIDGE_BUILD;
  if (env) {
    const b = parseBuild(env);
    return b?.commit ? `${b.version}+${b.commit}` : env;
  }
  if (cachedQuick === undefined) {
    const dirs = gitDirs();
    const sha = dirs ? headSha(dirs) : null;
    cachedQuick = sha ? sha.slice(0, 12) : null;
  }
  return cachedQuick ? `${getVersion()}+${cachedQuick}` : getVersion();
}

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
 * Should this CLI replace a host that stamped `stamp`? Never for a host that
 * stamps nothing (it predates stamps, and has no idle check to ask), nor for
 * one this CLI cannot prove older. The quick id answers the common case,
 * the same build, without a git process.
 */
export function shouldReplaceHost(stamp: string | undefined): boolean {
  const theirs = parseBuild(stamp);
  if (!theirs) return false;
  const quick = theirs.commit ? `${theirs.version}+${theirs.commit}` : theirs.version;
  if (quick === quickBuildId()) return false;
  return isNewerBuild(currentBuild(), theirs);
}
