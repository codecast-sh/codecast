// A worktree, found and described. Pure, so the repository page, the pill in
// prose and the conversation header agree on which worktree a reference means
// and on how its condition reads.
import { worktreeOfPath, type WorktreeEntry } from "@codecast/shared/contracts";
import type { RepoCheckout } from "../../hooks/useRepoBrowse";

export type WorktreeRef = { name?: string | null; path?: string | null; branch?: string | null };
export type FoundWorktree = { worktree: WorktreeEntry; checkout: RepoCheckout };

/**
 * The worktree a reference means. A path is exact, so it wins; a home relative
 * path (`~/src/app/.codecast/worktrees/x`) matches by its tail. A branch or a
 * bare name can repeat across machines, and the viewer's own checkouts are
 * listed first, so the first match is the nearest one.
 */
export function findWorktree(checkouts: RepoCheckout[] | undefined, ref: WorktreeRef): FoundWorktree | null {
  if (!checkouts?.length) return null;
  const all = checkouts.flatMap((checkout) => checkout.worktrees.map((worktree) => ({ worktree, checkout })));
  const tail = ref.path?.replace(/^~/, "").replace(/\/+$/, "");
  if (tail) {
    const hit = all.find(({ worktree }) => worktree.path === tail || worktree.path.endsWith(tail));
    if (hit) return hit;
  }
  const name = ref.name ?? worktreeOfPath(ref.path)?.name;
  return all.find(({ worktree }) => !worktree.main && ((!!name && worktree.name === name) || (!!ref.branch && worktree.branch === ref.branch))) ?? null;
}

/**
 * The worktrees a session has to do with: the one it runs in, then the ones
 * it edited files in, then any whose record names it. The later kinds are a
 * session that started in the main checkout and made a worktree halfway
 * through, which nothing on its own row says; the files it touched there do.
 */
export function worktreesOfSession(
  checkouts: RepoCheckout[] | undefined,
  session: { _id?: string | null; worktree_name?: string | null; worktree_path?: string | null; project_path?: string | null; recent_files?: string[] | null },
): WorktreeRef[] {
  const own = session.worktree_name ?? worktreeOfPath(session.worktree_path ?? session.project_path)?.name;
  const refs = new Map<string, WorktreeRef>();
  if (own) refs.set(own, { name: own, path: session.worktree_path });
  for (const file of session.recent_files ?? []) {
    const hit = worktreeOfPath(file);
    if (hit && !refs.has(hit.name)) refs.set(hit.name, { name: hit.name, path: hit.path });
  }
  for (const w of (checkouts ?? []).flatMap((c) => c.worktrees)) {
    if (!w.main && !refs.has(w.name) && !!session._id && w.sessions?.includes(session._id)) refs.set(w.name, { name: w.name, path: w.path });
  }
  return [...refs.values()];
}

/** What inline code names, if it names a worktree at all: a path inside one, or a branch a worktree has checked out. */
export function worktreeRefOfCode(text: string, checkouts: RepoCheckout[] | undefined): FoundWorktree | null {
  const code = text.trim();
  if (!code || /\s/.test(code)) return null;
  // The worktree's own folder, not a file inside it: that one stays a file link.
  const named = worktreeOfPath(code);
  if (named) return code.replace(/\/+$/, "").endsWith(`/${named.name}`) ? findWorktree(checkouts, { path: code }) : null;
  return code.includes("/") ? findWorktree(checkouts, { branch: code }) : null;
}

export type WorktreeGroup = { key: "main" | WorktreeEntry["manager"]; label: string; hint: string; worktrees: WorktreeEntry[] };

const GROUPS: Array<Omit<WorktreeGroup, "worktrees">> = [
  { key: "main", label: "Main checkout", hint: "The checkout every worktree hangs off" },
  { key: "codecast", label: "Codecast worktrees", hint: "Under .codecast/worktrees. cast ws gives the ones it made their own env files, ports and setup" },
  { key: "claude", label: "Agent worktrees", hint: "Made by Claude Code for its own subagents" },
  { key: "git", label: "Other worktrees", hint: "Made with git worktree add" },
];

/** A checkout's worktrees in reading order; occupied ones lead their group, then the most recently committed. */
export function groupWorktrees(worktrees: WorktreeEntry[]): WorktreeGroup[] {
  const rank = (w: WorktreeEntry) => (w.sessions?.length ? 1 : 0);
  return GROUPS.map((group) => ({
    ...group,
    worktrees: worktrees
      .filter((w) => (w.main ? "main" : w.manager) === group.key)
      .sort((a, b) => rank(b) - rank(a) || (b.committed_at ?? 0) - (a.committed_at ?? 0) || a.name.localeCompare(b.name)),
  })).filter((group) => group.worktrees.length);
}

export type WorktreeCondition = { tone: "ok" | "work" | "warn" | "bad" | "idle"; label: string };

/**
 * One line on whether a worktree still holds anything. "Work" means it has
 * something main does not: commits ahead or uncommitted changes. That is the
 * question asked before removing one.
 */
export function worktreeCondition(w: WorktreeEntry): WorktreeCondition {
  if (w.prunable) return { tone: "bad", label: "directory is gone" };
  if (w.state === "broken") return { tone: "bad", label: "setup is broken" };
  if (w.state === "creating" || w.state === "destroying") return { tone: "warn", label: w.state === "creating" ? "being created" : "being removed" };
  const parts = [w.dirty ? "uncommitted changes" : "", w.ahead ? `${w.ahead} ahead` : ""].filter(Boolean);
  if (parts.length) return { tone: "work", label: parts.join(" · ") };
  if (w.dirty === undefined && w.ahead === undefined) return { tone: "idle", label: "not inspected" };
  return { tone: "ok", label: w.main ? "clean" : "nothing main lacks" };
}
