// Pure helpers for turning a raw cwd/git_root into the canonical "project root"
// shown by the recent-projects picker. Kept dependency-free so it can be unit
// tested with `bun test` (see projectPaths.test.ts).

/**
 * Collapse a raw cwd/git_root into a canonical project root, or return null if
 * the path is not a real project we should ever surface as a chip.
 *
 * Rejects temp dirs and bare home directories or shallower (/Users/m1,
 * /home/ubuntu, /root, /) — those come from a session whose cwd fell back to
 * $HOME and are phantoms. Strips worktree suffixes (.conductor/<x>,
 * .codecast/worktrees/<x>) and, when a recognized code parent
 * (src/projects/repos/code) is present, trims to the repo directory one level
 * below it.
 */
export function normalizeProjectPath(raw: string): string | null {
  let p = raw;
  p = p.replace(/\/\.conductor\/[^/]+$/, '');
  p = p.replace(/\/\.codecast\/worktrees\/[^/]+$/, '');
  if (/^\/(tmp|var|private\/tmp|private\/var)\//.test(p)) return null;

  // A cwd that fell back to $HOME (or shallower) is not a real project — drop it
  // here rather than relying on the recent-projects local-root filter, which
  // only runs when the daemon heartbeat is fresh and so lets phantoms flicker in.
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return null; // "/" or ""
  if (segs[0] === 'root' && segs.length === 1) return null; // /root
  if ((segs[0] === 'Users' || segs[0] === 'home') && segs.length <= 2) return null; // /Users, /Users/<name>

  const parts = p.split('/');
  const srcIdx = parts.findIndex(s => s === 'src' || s === 'projects' || s === 'repos' || s === 'code');
  if (srcIdx >= 0 && srcIdx < parts.length - 1) {
    return parts.slice(0, srcIdx + 2).join('/');
  }
  return p;
}

/**
 * Directory-overlap project bound: true when one path contains the other
 * (e.g. ~/src/union-mobile vs ~/src/union-mobile/outreach), so a cwd deeper
 * inside a repo still claims the repo's sessions and vice versa. Used by the
 * CLI label views to scope "the current project" from the caller's cwd.
 */
export function projectOverlaps(boundRaw: string, raw: string | null | undefined): boolean {
  if (!raw) return false;
  const bound = boundRaw.replace(/\/+$/, "");
  const p = raw.replace(/\/+$/, "");
  return p === bound || p.startsWith(bound + "/") || bound.startsWith(p + "/");
}

export interface GitMetaSource {
  git_remote_url?: string | null;
  git_root?: string | null;
  updated_at?: number | null;
  started_at?: number | null;
}

/**
 * Recover the git remote (and real repo root) for a session created from a task.
 *
 * A task stores `project_path` but NOT `git_remote_url`, so a conversation
 * created from a task inherits the path with no remote. When that path is
 * foreign — recorded on a different machine than the one now running the session
 * (e.g. an EC2 box's `/Users/ec2-user/...`) — the owning daemon can't remap it
 * to the user's local checkout: `resolveLocalProjectPath` needs the remote URL
 * to find sibling checkouts and bails without it, surfacing a spurious "clone it
 * first" banner even though the user has the repo locally under a different path.
 *
 * The remote was recorded by a daemon on the task's *source* conversations.
 * Pick the most-recently-active source that carries a `git_remote_url`; return
 * its repo root too so the caller can preserve the in-repo subpath on remap.
 */
export function pickInheritedGitMeta(
  sources: GitMetaSource[],
): { git_remote_url: string | null; git_root: string | null } {
  let best: GitMetaSource | null = null;
  let bestT = -Infinity;
  for (const s of sources) {
    if (!s?.git_remote_url) continue;
    const t = s.updated_at ?? s.started_at ?? 0;
    if (t > bestT) { bestT = t; best = s; }
  }
  return {
    git_remote_url: best?.git_remote_url ?? null,
    git_root: best?.git_root ?? null,
  };
}
