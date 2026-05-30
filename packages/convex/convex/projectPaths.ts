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
