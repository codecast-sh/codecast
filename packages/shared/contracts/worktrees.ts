/**
 * A repository's worktrees as one checkout publishes them: the CLI builds the
 * payload (cli worktreeMirror.ts), convex stores one per publisher and root in
 * the repository cache (repos.ingestLocal) and the web reads every checkout's
 * together (repos.getWorktrees).
 *
 * GitHub knows a repository's branches; only a machine knows its checkouts, so
 * this is the one repository cache row with no GitHub twin.
 */

export const WORKTREES_KIND = "worktrees";

export type WorktreeManager = "codecast" | "claude" | "git";
export type WorktreeState = "creating" | "ready" | "broken" | "destroying";

export interface WorktreeEntry {
  name: string;
  path: string;
  /** Absent when HEAD is detached. */
  branch?: string;
  head_sha: string;
  /** The repository's main checkout, which every other worktree hangs off. */
  main?: boolean;
  /** `cast ws`, Claude Code's own agent worktrees, or a plain `git worktree add`. */
  manager: WorktreeManager;
  /** What `cast ws` recorded, for the worktrees it manages. */
  state?: WorktreeState;
  ports?: Record<string, number>;
  locked?: boolean;
  /** git would prune it: its directory is gone. */
  prunable?: boolean;
  dirty?: boolean;
  /** Distance from the default branch, not from an upstream: a worktree branch rarely has one. */
  ahead?: number;
  behind?: number;
  subject?: string;
  committed_at?: number;
  /** Conversation ids: the sessions running in it now, and the ones that ran in or acquired it. */
  sessions?: string[];
}

export interface WorktreesPayload {
  root: string;
  /** The machine the checkout is on: what a session started in one of its worktrees targets. */
  device_id?: string;
  device_label?: string;
  default_branch: string;
  truncated: boolean;
  /**
   * Whether the publisher looked for running sessions. The daemon does; `cast
   * ws` cannot, so a publish without them keeps what the row already held.
   */
  sessions_live: boolean;
  worktrees: WorktreeEntry[];
  at: number;
}

/**
 * What the server stores for a publish, given what it held before. A publish
 * that did not look for sessions names only the ones `cast ws` recorded, so a
 * worktree it names none for keeps the sessions of the last publish that looked.
 */
export function mergeWorktreesPayload(incoming: WorktreesPayload, previous: WorktreesPayload | null): WorktreesPayload {
  if (incoming.sessions_live || !previous) return incoming;
  const held = new Map(previous.worktrees.map((w) => [w.path, w.sessions]));
  return {
    ...incoming,
    worktrees: incoming.worktrees.map((w) => {
      const sessions = [...new Set([...(held.get(w.path) ?? []), ...(w.sessions ?? [])])].sort();
      return sessions.length ? { ...w, sessions } : w;
    }),
  };
}

/**
 * `…/.codecast/worktrees/<name>` and the other places a managed worktree
 * lives. Greedy on the left so a worktree made inside another names the inner
 * one, and the root may be empty: agents write `.codecast/worktrees/x` as
 * often as the absolute path.
 */
const WORKTREE_PATH_RE = /^((.*?)\/?\.(?:codecast\/worktrees|claude\/worktrees|conductor)\/([^/]+))(?:\/.*)?$/;
const WORKTREE_PATH_DEEPEST_RE = /^((.*)\/\.(?:codecast\/worktrees|claude\/worktrees|conductor)\/([^/]+))(?:\/.*)?$/;

/**
 * The worktree a path is in: its folder, its name, and the repository root it
 * hangs off ("" for a relative path). Null outside a managed worktree.
 */
export function worktreeOfPath(path: string | null | undefined): { path: string; root: string; name: string } | null {
  const m = path?.match(WORKTREE_PATH_DEEPEST_RE) ?? path?.match(WORKTREE_PATH_RE);
  return m ? { path: m[1], root: m[2], name: m[3] } : null;
}
