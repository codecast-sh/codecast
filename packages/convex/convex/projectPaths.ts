// Pure helpers for turning a raw cwd/git_root into the canonical "project root"
// shown by the recent-projects picker. Pure (shared contracts only) so it can be unit
// tested with `bun test` (see projectPaths.test.ts).

import { isHomeDirectoryPath, worktreeOfPath } from "@codecast/shared/contracts";

/** Temp dirs and bare home directories or shallower: never a real project. */
function isPhantomProjectPath(p: string): boolean {
  if (/^\/(tmp|var|private\/tmp|private\/var)\//.test(p)) return true;
  // A cwd that fell back to $HOME (or shallower) is not a real project — drop it
  // here rather than relying on the recent-projects local-root filter, which
  // only runs when the daemon heartbeat is fresh and so lets phantoms flicker in.
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return true; // "/" or ""
  if (isHomeDirectoryPath(p)) return true; // /root, /Users/<name>, /home/<name>
  return (segs[0] === 'Users' || segs[0] === 'home') && segs.length === 1; // /Users, /home
}

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
  if (isPhantomProjectPath(p)) return null;

  const parts = p.split('/');
  const srcIdx = parts.findIndex(s => s === 'src' || s === 'projects' || s === 'repos' || s === 'code');
  if (srcIdx >= 0 && srcIdx < parts.length - 1) {
    return parts.slice(0, srcIdx + 2).join('/');
  }
  return p;
}

/**
 * The project folder a session belongs to, for the recent-projects picker.
 *
 * A git_root already names the checkout, so it is taken as it stands: trimming
 * it to one level below a code parent files every repo in
 * ~/code/work/GitHub/<repo> under ~/code/work, a folder that is not a checkout
 * at all. Only a bare cwd, which may be anywhere inside a repo, gets the trim.
 */
export function conversationProjectRoot(conv: {
  git_root?: string | null;
  project_path?: string | null;
}): string | null {
  if (!conv.git_root) return conv.project_path ? normalizeProjectPath(conv.project_path) : null;
  const root = (worktreeOfPath(conv.git_root)?.root || conv.git_root).replace(/\/+$/, '');
  return isPhantomProjectPath(root) ? null : root;
}

export type ProjectTally = {
  path: string;
  count: number;
  lastActive: number;
  /** repositoryKeyOfRemote of the checkout; absent for a plain folder. */
  repository?: string;
};

/**
 * One entry per repository per home directory, carrying the sessions of all its
 * checkouts: a repo worked on through a thousand worktrees is one project, and
 * as separate rows it would push every other project off a capped list.
 *
 * The home directory stays in the key so the same repo on differently laid out
 * machines keeps a path for each; the unscoped list is narrowed per machine and
 * deduped by the client afterwards. The entry opens the checkout named after the
 * repo, the main one by convention, and failing that the most used. Worktrees
 * kept under a dot folder (~/.codex/worktrees/<id>/<repo>) borrow the repo's name
 * without being its main checkout, so they don't count as named after it.
 */
export function foldCheckoutsByRepository(tallies: ProjectTally[]): ProjectTally[] {
  const groups = new Map<string, ProjectTally[]>();
  for (const tally of tallies) {
    const key = tally.repository
      ? `repo:${tally.repository}:${tally.path.match(/^\/(?:Users|home)\/[^/]+/)?.[0] ?? ""}`
      : `path:${tally.path}`;
    const group = groups.get(key);
    if (group) group.push(tally);
    else groups.set(key, [tally]);
  }
  return Array.from(groups.values(), (group) => {
    const repoName = group[0].repository?.split("/").pop()?.toLowerCase();
    const named = (p: ProjectTally) =>
      p.path.split("/").pop()?.toLowerCase() === repoName && !/\/\.[^/]+\//.test(p.path) ? 1 : 0;
    const [chosen] = [...group].sort(
      (a, b) => named(b) - named(a) || b.count - a.count || b.lastActive - a.lastActive,
    );
    return {
      ...chosen,
      count: group.reduce((sum, p) => sum + p.count, 0),
      lastActive: Math.max(...group.map((p) => p.lastActive)),
    };
  });
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

/** Whether a project is equal to, or nested beneath, a root reported by a device. */
export function pathWithinLocalRoots(pathRaw: string, roots: string[]): boolean {
  const projectPath = pathRaw.replace(/\/+$/, "");
  return roots.some((rootRaw) => {
    const root = rootRaw.replace(/\/+$/, "");
    return projectPath === root || projectPath.startsWith(root + "/");
  });
}

/**
 * The project a directory belongs to: the one whose project_path contains it
 * (pathWithinLocalRoots), the deepest such path when several do. Projects that
 * share that path are told apart by the repo's line profile default
 * (projects.line_profile.default); still more than one is no answer, because
 * guessing files a signal into a line nobody there is watching.
 */
export function projectContainingPath<P extends { project_path?: string; line_profile?: { default?: boolean } }>(
  projects: P[],
  dirRaw: string | null | undefined,
): P | null {
  if (!dirRaw) return null;
  const depth = (p: P) => p.project_path!.replace(/\/+$/, "").length;
  const holding = projects.filter((p) => p.project_path && pathWithinLocalRoots(dirRaw, [p.project_path]));
  if (holding.length === 0) return null;
  const deepest = Math.max(...holding.map(depth));
  let best = holding.filter((p) => depth(p) === deepest);
  if (best.length > 1) best = best.filter((p) => p.line_profile?.default);
  return best.length === 1 ? best[0] : null;
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
