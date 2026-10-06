// The fence around the files the web may read and write on this machine
// through the daemon (config_read, config_write, line_profile_edit). One
// predicate for all three, each naming its kind, so a path admitted for
// writing is admitted for reading by the same rule and a new file kind is
// one line here.
//
// What it admits:
//   1. this user's ~/.claude and ~/.codex subtrees;
//   2. a small set of agent config basenames inside a project root this daemon
//      tracks (config_list advertises project CLAUDE.md/.mcp.json for editing);
//   3. a project's line profile, `.codecast/line.toml`, and its own line, the
//      plain files in `.codecast/line/` (line-map.md LX5), inside a tracked
//      root, for line_profile_edit and reading only;
//   4. for config_create and config_delete, only the per-file directories
//      (agents, commands, skills, prompts) under ~/.claude and ~/.codex;
//   5. nothing else.
// Every check runs on the canonical path (realpath of the directory), so a
// symlinked segment cannot walk a write out of the tree it was admitted to.
import fs from "node:fs";
import path from "node:path";
import { LINE_PROFILE_REL_PATH } from "./lineProfile.js";
import { REPO_LINE_FILE_RE, REPO_LINE_REL_DIR } from "@codecast/shared/contracts/lineProfile";

export const AGENT_CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "CLAUDE.md", "AGENTS.md", ".mcp.json", "settings.json", "settings.local.json", "config.toml",
]);

/**
 * The canonical path a write to `p` would land on: the realpath of its
 * directory joined with its basename. A directory that does not exist yet is
 * resolved through its nearest existing ancestor. Null when nothing resolves.
 * `followFile` also follows a symlinked file to what it names (a config file
 * linked into a dotfiles repo keeps its own name; a line profile may not).
 */
export function realTargetOf(p: string, opts: { followFile?: boolean } = {}): string | null {
  const resolved = path.resolve(p);
  if (opts.followFile) {
    try { return fs.realpathSync(resolved); } catch { /* absent: resolve through the directory */ }
  }
  const dirReal = (() => {
    try {
      return fs.realpathSync(path.dirname(resolved));
    } catch {
      let probe = path.dirname(resolved);
      const tail: string[] = [];
      while (!fs.existsSync(probe)) {
        tail.unshift(path.basename(probe));
        const up = path.dirname(probe);
        if (up === probe) return null;
        probe = up;
      }
      try {
        return path.join(fs.realpathSync(probe), ...tail);
      } catch {
        return null;
      }
    }
  })();
  return dirReal ? path.join(dirReal, path.basename(resolved)) : null;
}

const under = (target: string, root: string) => target.startsWith(root + path.sep);

/** Canonical roots: the tracked roots are realpathed so a symlinked checkout still matches its own files. */
function canonicalRoots(roots: readonly string[]): string[] {
  return roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
}

/** True when `realTarget` is a `.codecast/line.toml`, or a file of the repo's line in `.codecast/line/`, inside one of the tracked roots. */
export function isTrackedLineProfile(realTarget: string, roots: readonly string[]): boolean {
  if (!isLineProfilePath(realTarget)) return false;
  return canonicalRoots(roots).some((root) => under(realTarget, root));
}

/** A file of the repo's own line: a plain name directly in `.codecast/line/`. */
const isRepoLinePath = (resolved: string) =>
  REPO_LINE_FILE_RE.test(path.basename(resolved)) && path.dirname(resolved).endsWith(path.sep + REPO_LINE_REL_DIR.split("/").join(path.sep));

/**
 * What the caller does with the path:
 *   "config"       config_write: home subtrees and agent config basenames in a tracked root;
 *   "line_profile" line_profile_edit: a tracked line profile and nothing else, the only
 *                  writer of that file (it validates, checks `base` and republishes);
 *   "read"         config_read: what either writer admits, plus an agent config basename
 *                  anywhere (config_list advertises project files outside tracked roots).
 */
export type FenceKind = "config" | "line_profile" | "read";

/** Whether `p` names a line profile by its path, so the fence judges it by the file it resolves to. */
export const isLineProfilePath = (p: string) => {
  const resolved = path.resolve(p);
  return resolved.endsWith(path.sep + LINE_PROFILE_REL_PATH.split("/").join(path.sep)) || isRepoLinePath(resolved);
};

/**
 * The canonical path the fence judges for `p`. A line profile is judged by the
 * file it resolves to, whatever the kind: a committed symlink named line.toml
 * may not carry a read or a write out to the file it names.
 */
export const fenceTargetOf = (p: string) => realTargetOf(p, { followFile: isLineProfilePath(p) });

/** Whether the fence admits `realTarget` (from realTargetOf) for `kind` (default "config"). */
export function fenceAdmits(realTarget: string, opts: { home: string; roots: readonly string[]; kind?: FenceKind }): boolean {
  const kind = opts.kind ?? "config";
  if (isTrackedLineProfile(realTarget, opts.roots)) return kind !== "config";
  if (kind === "line_profile") return false;
  // Canonical too, so a ~/.claude linked into a dotfiles repo is still home.
  const home = opts.home ? canonicalRoots([path.join(opts.home, ".claude"), path.join(opts.home, ".codex")]) : [];
  if (home.some((a) => realTarget === a || under(realTarget, a))) return true;
  if (!AGENT_CONFIG_BASENAMES.has(path.basename(realTarget))) return false;
  return kind === "read" || canonicalRoots(opts.roots).some((root) => under(realTarget, root));
}

/** The directories config_create and config_delete may add to or remove from, relative to home. */
export const CONFIG_FILE_DIRS: readonly string[] = [
  ".claude/agents", ".claude/commands", ".claude/skills", ".claude/prompts", ".codex/prompts", ".codex/skills",
];

/**
 * The canonical path of `p` (a leading ~/ is home) when it is one of the
 * per-file config directories, or inside one; `inside` refuses the directory
 * itself (a delete names a file in it). Null when the fence refuses it.
 */
export function configDirTarget(p: string, home: string, opts: { inside?: boolean } = {}): string | null {
  const real = realTargetOf(p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
  if (!real || !home) return null;
  const dirs = canonicalRoots(CONFIG_FILE_DIRS.map((d) => path.join(home, d)));
  return dirs.some((d) => under(real, d) || (!opts.inside && real === d)) ? real : null;
}
