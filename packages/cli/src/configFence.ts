// The fence around the files the web may read and write on this machine
// through the daemon (config_read, config_write, line_profile_edit). One
// predicate for all three, so a path admitted for writing is admitted for
// reading by the same rule and a new file kind is one line here.
//
// What it admits:
//   1. this user's ~/.claude and ~/.codex subtrees;
//   2. a small set of agent config basenames inside a project root this daemon
//      tracks (config_list advertises project CLAUDE.md/.mcp.json for editing);
//   3. a project's line profile, `.codecast/line.toml`, inside a tracked root;
//   4. nothing else.
// Every check runs on the canonical path (realpath of the directory), so a
// symlinked segment cannot walk a write out of the tree it was admitted to.
import fs from "node:fs";
import path from "node:path";
import { LINE_PROFILE_REL_PATH } from "./lineProfile.js";

export const AGENT_CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "CLAUDE.md", "AGENTS.md", ".mcp.json", "settings.json", "settings.local.json", "config.toml",
]);

/**
 * The canonical path a write to `p` would land on: the realpath of its
 * directory joined with its basename. A directory that does not exist yet is
 * resolved through its nearest existing ancestor. Null when nothing resolves.
 */
export function realTargetOf(p: string): string | null {
  const resolved = path.resolve(p);
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

/** True when `realTarget` is a `.codecast/line.toml` inside one of the tracked roots. */
export function isTrackedLineProfile(realTarget: string, roots: readonly string[]): boolean {
  if (!realTarget.endsWith(path.sep + LINE_PROFILE_REL_PATH.split("/").join(path.sep))) return false;
  return canonicalRoots(roots).some((root) => under(realTarget, root));
}

export type FenceKind = "config" | "line_profile";

/**
 * Whether the fence admits `realTarget` (from realTargetOf). "line_profile"
 * admits only a tracked line profile; "config" admits everything listed at the
 * top of this file.
 */
export function fenceAdmits(realTarget: string, opts: { home: string; roots: readonly string[]; kind?: FenceKind }): boolean {
  if (isTrackedLineProfile(realTarget, opts.roots)) return true;
  if (opts.kind === "line_profile") return false;
  const home = opts.home;
  if (home && [path.join(home, ".claude"), path.join(home, ".codex")].some((a) => realTarget === a || under(realTarget, a))) return true;
  return AGENT_CONFIG_BASENAMES.has(path.basename(realTarget)) && canonicalRoots(opts.roots).some((root) => under(realTarget, root));
}
