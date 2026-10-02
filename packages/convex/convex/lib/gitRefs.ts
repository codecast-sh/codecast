// Git references, folded.
//
// Two jobs live here, both pure enough to unit test:
//   1. Reading codecast object ids out of free git text — a commit message, a
//      PR title or body, a branch name — and resolving them to rows.
//   2. Folding many small GitHub facts (check runs, a review decision, a
//      merge state) into the one word a card can show.
//
// Everything a webhook processor or the PR shepherd needs to answer "what does
// this git activity mean" is here, so the processors stay thin.

import { Doc, Id } from "../_generated/dataModel";
import { bareEntityIdRegex, inferEntityTypeFromShortId } from "@codecast/shared/entities";
import { extractSessionTrailer } from "@codecast/shared/blame";
import { isConversationOwner, isConversationTeamVisible } from "../privacy";

type Db = { db: any };

/**
 * Every task short id in a piece of git text, lowercased and deduped, in the
 * order it appears.
 *
 * The scan comes from the shared mention vocabulary, so a branch
 * (`ct-123-fix-auth`, `feature/ct-123`), a commit message and a PR body are all
 * read the same way, and a newly registered short id prefix needs no change
 * here. Only task ids survive the filter: a PR body that mentions pl-88 links
 * its plan through the task, not directly.
 */
export function extractTaskShortIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.match(bareEntityIdRegex()) ?? []) {
    const id = match.toLowerCase();
    if (inferEntityTypeFromShortId(id) !== "task") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type TaskLinks = {
  task_ids: Id<"tasks">[];
  plan_ids: Id<"plans">[];
  project_ids: Id<"projects">[];
};

/**
 * Short ids to real rows, plus the plans and projects those tasks belong to.
 *
 * A miss is silent: git text names ids from other workspaces and from before
 * the task was deleted, and a push must never fail because a commit message
 * quoted a stale id.
 */
export async function resolveTaskLinks(ctx: Db, shortIds: string[]): Promise<TaskLinks> {
  const task_ids: Id<"tasks">[] = [];
  const planIds = new Set<string>();
  const projectIds = new Set<string>();

  for (const shortId of shortIds) {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", shortId))
      .first();
    if (!task) continue;
    task_ids.push(task._id);
    if (task.plan_id) planIds.add(String(task.plan_id));
    if (task.project_id) projectIds.add(String(task.project_id));
  }

  return {
    task_ids,
    plan_ids: [...planIds] as Id<"plans">[],
    project_ids: [...projectIds] as Id<"projects">[],
  };
}

/** Read the task links straight out of git text. */
export async function resolveTaskLinksFromText(ctx: Db, ...texts: (string | null | undefined)[]): Promise<TaskLinks> {
  return resolveTaskLinks(ctx, extractTaskShortIds(texts.filter(Boolean).join("\n")));
}

// ── Which sessions git activity may link ──

/** Who is linking: the codecast user behind the git activity, and the team it routes to. */
export type LinkScope = { userId?: Id<"users"> | null; teamId?: Id<"teams"> | null };

/**
 * Whether git activity may link a session. A linked session reaches the pull
 * request, the repo page, search, and the comment codecast posts on GitHub,
 * so the link is decided by access, never by routing or a branch name: the
 * user behind the activity owns the session, or it is routed to the team AND
 * team-visible under the conversation visibility rule.
 */
export async function isConversationLinkable(ctx: Db, conv: Doc<"conversations">, scope: LinkScope): Promise<boolean> {
  if (scope.userId && (await isConversationOwner(ctx, scope.userId, conv))) return true;
  return !!scope.teamId && String(conv.team_id) === String(scope.teamId) && (await isConversationTeamVisible(ctx, conv));
}

/**
 * The sessions on a branch that `scope` may link. The branch index spans every
 * user, and branch names repeat everywhere (`main`), so the name alone never
 * links a session.
 */
export async function linkableSessionsOnBranch(ctx: Db, branch: string, scope: LinkScope, limit: number): Promise<Doc<"conversations">[]> {
  const onBranch: Doc<"conversations">[] = await ctx.db
    .query("conversations")
    .withIndex("by_git_branch", (q: any) => q.eq("git_branch", branch))
    .take(limit);
  const linkable: Doc<"conversations">[] = [];
  for (const conv of onBranch) {
    if (await isConversationLinkable(ctx, conv, scope)) linkable.push(conv);
  }
  return linkable;
}

// ── The session a commit names ──

export { extractSessionTrailer };

/**
 * A checkout an agent harness made for an isolated worktree: Claude Code's
 * Agent and Workflow isolation, at `.claude/worktrees/agent-<id>` or
 * `.claude/worktrees/wf_<run>-<n>` on branch `worktree-<that name>`. An agent
 * may switch to a branch it names itself, so the checkout's path decides when
 * known and the branch otherwise. A commit there is the harness's scratch
 * snapshot, not the session's work, so it links to no session until it
 * reaches a real branch.
 */
export function isHarnessScratch(where: { branch?: string | null; root?: string | null }): boolean {
  if (where.root && /\/\.claude\/worktrees\/(agent-|wf_)[^/]*\/?$/.test(where.root)) return true;
  return !!where.branch && /^worktree-(agent-|wf_)/.test(where.branch);
}

/**
 * The session a commit's `Codecast-Session` trailer names, when the claim
 * holds up.
 *
 * The trailer is text anyone who can push may write, so it links only a
 * session isConversationLinkable allows: one the reporting user owns (the
 * checkout path, which knows who reported), or one its team may actually
 * read. A private session routed to the team is neither, so a push naming it
 * links nothing.
 *
 * `current` is the session already on the commit row. The trailer replaces it
 * only when that link is empty, gone, or belongs to the same person, so a
 * trailer can correct a guess about someone's own work but can never take a
 * commit away from another person's session.
 */
export async function conversationFromSessionTrailer(
  ctx: Db,
  message: string | null | undefined,
  scope: LinkScope & { current?: Id<"conversations"> | null },
): Promise<Id<"conversations"> | undefined> {
  const named = extractSessionTrailer(message);
  if (!named) return undefined;
  const id = ctx.db.normalizeId("conversations", named);
  const conv = id ? await ctx.db.get(id) : null;
  if (!conv || !(await isConversationLinkable(ctx, conv, scope))) return undefined;
  if (scope.current && String(scope.current) !== String(conv._id)) {
    const current = await ctx.db.get(scope.current);
    if (current && String(current.user_id) !== String(conv.user_id)) return undefined;
  }
  return conv._id;
}

// ── Folding GitHub state ──

export type CheckEntry = {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
  updated_at: number;
  external_id?: string;
  // The check suite the run belongs to (check_run.check_suite.id). Re-runs of a
  // workflow keep their suite; a fresh trigger on the same commit gets a new one.
  suite_id?: string;
  // What triggered the suite ("push", "pull_request", ...), learned from the
  // workflow_run delivery for the same suite. Absent for checks that are not
  // GitHub Actions or whose workflow_run has not arrived.
  event?: string;
  // The GitHub App that owns the run (check_run.app.slug: "github-actions",
  // "gitguardian", ...). Present on the check_run payload itself, so it tells
  // an Actions check from another app's before any workflow_run arrives.
  app?: string;
};

/** The app slug GitHub Actions stamps on every check_run it owns. */
export const GITHUB_ACTIONS_APP = "github-actions";

/** Conclusions GitHub reports that do not mean the check failed. */
export const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * One word for a head commit's whole check suite:
 * "none" (nothing ran) | "pending" | "failure" | "success".
 *
 * A single failure decides the answer no matter what else is still running,
 * because that is the fact the shepherd must act on first.
 */
export function foldChecksState(checks: CheckEntry[] | undefined | null): string {
  if (!checks || checks.length === 0) return "none";
  let pending = false;
  for (const check of checks) {
    if (check.status !== "completed") { pending = true; continue; }
    if (!check.conclusion) { pending = true; continue; }
    if (!PASSING_CONCLUSIONS.has(check.conclusion)) return "failure";
  }
  return pending ? "pending" : "success";
}

// One spelling for a repository. The rule lives beside the reference parser in
// the shared contracts so the CLI, the web and this backend cannot drift; it is
// re-exported here because every git module already imports from this file.
export { normalizeRepository, repositoryOwner } from "@codecast/shared/contracts";

// The shepherd fold is pure and the web reads it too (the Changes page's In
// review chips), so it lives beside the reference parser.
export { foldShepherdState, type ShepherdPrState } from "@codecast/shared/contracts";

export function prUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

export function commitUrl(repository: string, sha: string): string {
  return `https://github.com/${repository}/commit/${sha}`;
}

export function shortSha(sha: string | undefined | null): string {
  return (sha ?? "").slice(0, 7);
}
