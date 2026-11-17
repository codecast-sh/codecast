import { Id } from "../_generated/dataModel";
import { isViableInboxParent } from "../inboxFilters";
import { pickInheritedGitMeta, type GitMetaSource } from "../projectPaths";
import { resolveTeamForPath } from "../privacy";

// Resolve the orchestrator conversation a task's worker session should nest
// under: the session that created the task's plan
// (plans.created_from_conversation_id), which is the de-facto orchestrator and
// — unlike plans.current_session_id — is stamped once and never churned by
// per-worker auto-binding. Returns undefined when there's no plan, no recorded
// creator, or the creator isn't a renderable inbox parent, in which case the
// worker stays top-level and the client's plan-grouping fallback handles it.
export async function resolveWorkerParentConversation(
  ctx: any,
  userId: Id<"users">,
  planId: Id<"plans"> | undefined,
): Promise<Id<"conversations"> | undefined> {
  if (!planId) return undefined;
  let plan;
  try {
    plan = await ctx.db.get(planId);
  } catch {
    return undefined;
  }
  const creatorId = plan?.created_from_conversation_id as Id<"conversations"> | undefined;
  if (!creatorId) return undefined;
  let parent;
  try {
    parent = await ctx.db.get(creatorId);
  } catch {
    return undefined;
  }
  return isViableInboxParent(parent, userId.toString()) ? creatorId : undefined;
}

/**
 * Resolve the project/git context a task-bound session must launch in:
 * `project_path` (the task's own, or its team's directory mapping), `git_root`,
 * and the `git_remote_url` recovered from the task's source conversations (a task
 * itself stores no remote). Shared by `dispatch.createSession` and
 * `tasks.assignToAgent` so both task-launch paths stamp the conversation and
 * route the daemon identically — without a project_path the conversation can't
 * be started by any daemon (the "start agent run did nothing" bug). `seed` is the
 * caller's path: it refines the choice inside the task's team and never overrides it.
 */
export async function resolveTaskGitContext(
  ctx: any,
  userId: Id<"users">,
  task: any,
  mappings: any[],
  seed?: { project_path?: string; git_root?: string },
): Promise<{ project_path?: string; git_root?: string; git_remote_url?: string }> {
  let git_root = seed?.git_root;
  let git_remote_url: string | undefined;

  // What the task pins wins: its own path, then its project's. A seed is only
  // trusted past that when it already sits inside the task's team, because the
  // web sends the viewer's open repo as the seed when the task pins nothing —
  // and that repo may belong to another team entirely (a Union task launched
  // three sessions into ~/src/codecast this way). Otherwise the team's mapped
  // directory routes, and a foreign seed is the last resort that keeps a task
  // whose team has no mapping startable at all.
  const project = task.project_id ? await ctx.db.get(task.project_id).catch(() => null) : null;
  const teamKey = task.team_id?.toString();
  const seedInTaskTeam = !!teamKey
    && resolveTeamForPath(mappings, seed?.project_path, undefined).teamId?.toString() === teamKey;
  const project_path: string | undefined =
    task.project_path
    || project?.project_path
    || (seedInTaskTeam ? seed?.project_path : undefined)
    || (teamKey ? mappings.find((m: any) => m.team_id?.toString() === teamKey)?.path_prefix : undefined)
    || seed?.project_path;
  if (!git_root && project_path !== seed?.project_path) git_root = project_path;

  // A git_root that isn't an ancestor of the resolved project_path describes a
  // DIFFERENT repo — typically the viewer's currently-open conversation stamped
  // alongside a task-derived path. The daemon prefers git_root when picking a
  // cwd, so an unrelated root that happens to exist on the target machine would
  // launch the session in the wrong repo. Drop it; the project_path routes.
  if (git_root && project_path && project_path !== git_root && !project_path.startsWith(git_root.replace(/\/+$/, "") + "/")) {
    git_root = undefined;
  }

  // A task stores project_path but never git_remote_url; recover it from the
  // task's source conversations (which a daemon stamped git metadata onto) so a
  // daemon on a different machine can remap a foreign path to the local checkout.
  const sourceIds: Id<"conversations">[] = [];
  if (task.created_from_conversation) sourceIds.push(task.created_from_conversation);
  for (const cid of (task.conversation_ids ?? [])) {
    if (!sourceIds.some((s) => s.toString() === cid.toString())) sourceIds.push(cid);
  }
  const sources: GitMetaSource[] = [];
  for (const cid of sourceIds) {
    const c = await ctx.db.get(cid).catch(() => null);
    if (c && c.user_id.toString() === userId.toString()) {
      sources.push({ git_remote_url: c.git_remote_url, git_root: c.git_root, updated_at: c.updated_at, started_at: c.started_at });
    }
  }
  const inherited = pickInheritedGitMeta(sources);
  if (inherited.git_remote_url) {
    git_remote_url = inherited.git_remote_url;
    // Prefer the real repo root over a foreign full path so the daemon can keep
    // the in-repo subpath when remapping to a local checkout.
    if (inherited.git_root && project_path
        && project_path.startsWith(inherited.git_root)
        && inherited.git_root !== git_root) {
      git_root = inherited.git_root;
    }
  }

  return { project_path, git_root, git_remote_url };
}

export function worktreeNameFor(identifier: string): string {
  return identifier.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").slice(-64).replace(/^[^a-z0-9]+/, "");
}
