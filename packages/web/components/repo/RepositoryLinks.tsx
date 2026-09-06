import { useMemo, type SyntheticEvent } from "react";
import Link from "next/link";
import { FolderGit2, GitBranch, ExternalLink } from "lucide-react";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useSyncTaskExternalEvents, useSyncPlanExternalEvents, useSyncProjectExternalEvents } from "../../hooks/useSyncExternalEvents";
import { githubRepository, repositoryName, repositoryEventMatches, sessionRepository, taskRepository, type RepositoryScope } from "../../lib/repoNavigation";
import { commitPageHref, repoCompareHref, repoHomeHref, repoTreeHref, repoCommitsHref, repoPullsHref, toStandaloneHref } from "../../lib/repoView";

const repoSig = (row: any) => `${row.repository ?? ""}|${row.git_remote_url ?? ""}|${row.pr_status?.repository ?? ""}`;
const taskRepoSig = (row: any) => `${row.project_id}|${row.plan_id}|${row.conversation_ids?.join(",")}|${row.created_from_conversation}|${row.external?.provider}|${row.external?.identifier}`;
const linkClass = "inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-cyan focus-visible:outline focus-visible:outline-sol-cyan";

type GitStateSession = {
  git_remote_url?: string | null;
  git_branch?: string | null;
  worktree_branch?: string | null;
  git_commit_hash?: string | null;
  git_ahead?: number | null;
  git_behind?: number | null;
  git_dirty?: boolean | null;
  pr_status?: { repository?: string } | null;
};

const promptPart = "inline-flex items-center gap-1 px-1.5 py-0.5 hover:bg-sol-cyan/15 focus-visible:outline focus-visible:outline-sol-cyan";

/**
 * The session's checkout as a shell prompt would show it: the branch, then —
 * when the daemon has reported them — the commit it sits on, how far it is
 * from its upstream, and a dirty marker. Each part opens the matching
 * repository page: the branch its tree, the sha its commit, the distance the
 * compare against the branch's upstream. `detail` off keeps only the branch,
 * for the places a card has no room for more.
 */
export function BranchCodeLink({ session, className = "", detail = true }: { session: GitStateSession; className?: string; detail?: boolean }) {
  const repository = sessionRepository(session);
  const branch = session.git_branch || session.worktree_branch;
  if (!repository) return null;
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const sha = detail && session.git_commit_hash ? session.git_commit_hash : null;
  const ahead = detail ? session.git_ahead ?? 0 : 0;
  const behind = detail ? session.git_behind ?? 0 : 0;
  const dirty = detail && !!session.git_dirty;
  return (
    <span
      className={`inline-flex items-stretch min-w-0 max-w-[320px] rounded border border-sol-cyan/25 bg-sol-cyan/5 font-mono text-[10px] text-sol-cyan divide-x divide-sol-cyan/20 ${className}`}
      title={`${repository}${branch ? ` at ${branch}` : ""}${sha ? ` on ${sha.slice(0, 7)}` : ""}${dirty ? ", uncommitted changes" : ""}`}
    >
      <Link href={branch ? repoTreeHref(repository, branch) : repoHomeHref(repository)} onClick={stop} onKeyDown={stop}
        aria-label={`Browse code for ${repository}${branch ? ` at ${branch}` : ""}`}
        className={`${promptPart} min-w-0`}>
        <GitBranch className="w-3 h-3 shrink-0" /><span className="truncate">{branch || repository}</span>
        {dirty && <span className="text-sol-orange" aria-label="uncommitted changes">*</span>}
      </Link>
      {sha && (
        <Link href={commitPageHref(repository, sha)} onClick={stop} onKeyDown={stop} aria-label={`Open commit ${sha.slice(0, 7)}`} className={`${promptPart} text-sol-text-muted`}>
          {sha.slice(0, 7)}
        </Link>
      )}
      {(ahead > 0 || behind > 0) && branch && (
        <Link href={repoCompareHref(repository, `origin/${branch}`, branch)} onClick={stop} onKeyDown={stop}
          aria-label={`${ahead} ahead, ${behind} behind upstream`} title={`${ahead} ahead, ${behind} behind upstream`}
          className={`${promptPart} ${behind > 0 ? "text-sol-orange" : "text-sol-text-muted"}`}>
          {ahead > 0 && <span>↑{ahead}</span>}
          {behind > 0 && <span>↓{behind}</span>}
        </Link>
      )}
    </span>
  );
}

export function RepositoryLinks({ taskId, planId, projectId, conversationIds = [], sessions = [], repository, remote }: RepositoryScope & { sessions?: readonly any[]; repository?: string; remote?: string }) {
  useSyncTaskExternalEvents(taskId);
  useSyncPlanExternalEvents(planId);
  useSyncProjectExternalEvents(projectId);
  const tasks = useWorkspaceCollection("tasks", taskRepoSig);
  const relatedTasks = tasks.filter(row => (projectId && row.project_id === projectId) || (planId && row.plan_id === planId));
  const taskSessions = relatedTasks.flatMap(row => [...(row.conversation_ids || []), row.created_from_conversation].filter(Boolean));
  const ids = [...new Set([...conversationIds, ...sessions.map(s => s._id || s.id), ...taskSessions].filter(Boolean))].sort().join(",");
  const scope = useMemo(() => ({ taskId, planId, projectId, conversationIds: ids ? ids.split(",") : [] }), [taskId, planId, projectId, ids]);
  const whereEvent = useMemo(() => (row: any) => repositoryEventMatches(row, scope), [scope]);
  const whereSession = useMemo(() => (row: any) => scope.conversationIds.includes(row._id), [scope]);
  const events = useCollectionRows("externalEvents", { where: whereEvent, sig: repoSig });
  const cachedSessions = useCollectionRows("sessions", { where: whereSession, sig: repoSig });
  const details = useCollectionRows("conversations", { where: whereSession, sig: repoSig });
  const names = [...new Set([
    repositoryName(repository), githubRepository(remote),
    ...sessions.map(sessionRepository), ...cachedSessions.map(sessionRepository), ...details.map(sessionRepository),
    ...relatedTasks.map(taskRepository),
    ...events.map(e => repositoryName(e.repository)),
  ].filter((name): name is string => !!name))].sort();
  if (!names.length) return null;
  return <nav aria-label="Related code" className="my-3 space-y-1">
    {names.map(name => <div key={name} className="flex items-center gap-1 flex-wrap text-xs">
      <Link href={repoHomeHref(name)} className={linkClass} title={`Browse source for ${name}`}><FolderGit2 className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{name}</span></Link>
      <Link href={repoCommitsHref(name, "HEAD")} className={linkClass}>History</Link>
      <Link href={repoPullsHref(name)} className={linkClass}>Pull requests</Link>
      <a href={toStandaloneHref(repoHomeHref(name))} target="_blank" rel="noopener noreferrer" className={linkClass} title={`Open ${name} without the app sidebar`} aria-label={`Open ${name} in a separate browser tab`}><ExternalLink className="h-3 w-3" /></a>
    </div>)}
  </nav>;
}
