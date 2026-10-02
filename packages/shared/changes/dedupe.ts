// Rebase twins (spec 7.1 step 2): a rebased commit keeps its author, author
// time and subject but gets a new sha, and both copies can reach the commits
// table. Collapse them to one, keeping the copy on the default branch.
import type { ChangeCommit } from "./types";

/** The repo's default branch: the one recorded on the repo, else `main` or `master` when seen, else `main`. */
export function resolveDefaultBranch(recorded: string | null | undefined, branchesSeen: Iterable<string | null | undefined>): string {
  if (recorded) return recorded;
  const seen = new Set(branchesSeen);
  if (seen.has("main")) return "main";
  if (seen.has("master")) return "master";
  return "main";
}

/** A commit with no recorded branch came from a transcript and is read as landing on the default branch. */
export function onDefaultBranch(commit: Pick<ChangeCommit, "branch">, defaultBranch: string): boolean {
  return !commit.branch || commit.branch === defaultBranch;
}

export function twinKey(c: Pick<ChangeCommit, "author_email" | "timestamp" | "subject">): string {
  return `${c.author_email.toLowerCase()}\u0000${c.timestamp}\u0000${c.subject.trim()}`;
}

export type DedupeResult<C> = {
  commits: C[];
  /** Kept sha to the shas collapsed into it. */
  twins: Record<string, string[]>;
};

/**
 * Keep one commit per (author email, timestamp, subject). The copy that
 * landed on the default branch with an explicit branch wins, then any copy
 * read as default, then the newest row. Order of the input is kept.
 */
export function dedupeCommits<C extends ChangeCommit>(commits: readonly C[], defaultBranch: string): DedupeResult<C> {
  const rank = (c: C) => (c.branch === defaultBranch ? 2 : onDefaultBranch(c, defaultBranch) ? 1 : 0);
  const best = new Map<string, C>();
  for (const c of commits) {
    const k = twinKey(c);
    const prev = best.get(k);
    if (!prev) {
      best.set(k, c);
      continue;
    }
    const d = rank(c) - rank(prev);
    if (d > 0 || (d === 0 && (c.created_at ?? c.timestamp) > (prev.created_at ?? prev.timestamp))) best.set(k, c);
  }
  const kept = new Set([...best.values()].map((c) => c.sha));
  const twins: Record<string, string[]> = {};
  const out: C[] = [];
  for (const c of commits) {
    if (kept.has(c.sha)) {
      out.push(c);
      kept.delete(c.sha);
      continue;
    }
    if (best.get(twinKey(c))?.sha === c.sha) continue;
    const keeper = best.get(twinKey(c))!;
    (twins[keeper.sha] ??= []).push(c.sha);
  }
  return { commits: out, twins };
}
