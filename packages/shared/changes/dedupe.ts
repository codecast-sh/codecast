// Rebase twins (spec 7.1 step 2): a rebased commit keeps its author, author
// time and subject but gets a new sha, and both copies can reach the commits
// table. Collapse them to one, keeping the copy on the default branch. A
// change committed again a little later (an amend, a reset and recommit) has
// a new time as well, so it is told by its content instead.
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

/** Recommitted copies of one change land within this long of each other. */
export const CONTENT_TWIN_MS = 30 * 60 * 1000;

/** Below this many changed lines a size match is no evidence ("fix typo", +1 -1, twice), so where it touched must match too. */
export const CONTENT_TWIN_MIN_LINES = 40;

/**
 * The same change by content: author, subject and size. Identical line counts
 * from one author under one subject, within `CONTENT_TWIN_MS`, are the same
 * change; where it touched is left out, since two ingestions of one commit
 * can file its files differently (a truncated file list, a path read twice).
 * A change under `CONTENT_TWIN_MIN_LINES` keys on its area map as well. Null
 * for a commit that changed no lines, which has nothing to compare.
 */
export function contentKey(c: Pick<ChangeCommit, "author_email" | "subject" | "insertions" | "deletions" | "areas">): string | null {
  const lines = c.insertions + c.deletions;
  if (lines === 0) return null;
  const subject = c.subject.replace(/\s+/g, " ").trim().toLowerCase();
  const key = `${c.author_email.toLowerCase()}\u0000${subject}\u0000${c.insertions}\u0000${c.deletions}`;
  if (lines >= CONTENT_TWIN_MIN_LINES) return key;
  return `${key}\u0000${Object.entries(c.areas).map(([a, t]) => `${a}:${t.touches}`).sort().join(",")}`;
}

export type DedupeResult<C> = {
  commits: C[];
  /** Kept sha to the shas collapsed into it. */
  twins: Record<string, string[]>;
};

/**
 * Keep one commit per (author email, timestamp, subject), then one per
 * content key among copies within `CONTENT_TWIN_MS` of the kept one. The copy
 * that landed on the default branch with an explicit branch wins, then any
 * copy read as default, then the newest row. Order of the input is kept.
 */
export function dedupeCommits<C extends ChangeCommit>(commits: readonly C[], defaultBranch: string): DedupeResult<C> {
  const rank = (c: C) => (c.branch === defaultBranch ? 2 : onDefaultBranch(c, defaultBranch) ? 1 : 0);
  const better = (c: C, prev: C) => {
    const d = rank(c) - rank(prev);
    return d > 0 || (d === 0 && (c.created_at ?? c.timestamp) > (prev.created_at ?? prev.timestamp));
  };
  const twins: Record<string, string[]> = {};
  /** One pass: commits sharing a key within `within` ms of the group's keeper collapse onto the better copy. */
  const collapse = (input: readonly C[], key: (c: C) => string | null, within: number): C[] => {
    const groups = new Map<string, { keeper: C; members: C[] }[]>();
    const dropped = new Set<C>();
    for (const c of input) {
      const k = key(c);
      if (k === null) continue;
      const list = groups.get(k) ?? [];
      groups.set(k, list);
      const g = list.find((x) => Math.abs(c.timestamp - x.keeper.timestamp) <= within);
      if (!g) {
        list.push({ keeper: c, members: [c] });
        continue;
      }
      g.members.push(c);
      if (better(c, g.keeper)) g.keeper = c;
    }
    for (const list of groups.values()) {
      for (const g of list) {
        for (const m of g.members) {
          if (m === g.keeper) continue;
          dropped.add(m);
          // A dropped copy hands the twins it had already collected to its keeper.
          (twins[g.keeper.sha] ??= []).push(m.sha, ...(twins[m.sha] ?? []));
          delete twins[m.sha];
        }
      }
    }
    return input.filter((c) => !dropped.has(c));
  };
  const exact = collapse(commits, twinKey, 0);
  return { commits: collapse(exact, contentKey, CONTENT_TWIN_MS), twins };
}
