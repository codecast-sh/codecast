import { useMemo } from "react";
import Link from "next/link";
import { FolderGit2, GitBranch, ExternalLink } from "lucide-react";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useSyncTaskExternalEvents, useSyncPlanExternalEvents, useSyncProjectExternalEvents } from "../../hooks/useSyncExternalEvents";
import { githubRepository, repositoryName, repositoryEventMatches, sessionRepository, taskRepository, type RepositoryScope } from "../../lib/repoNavigation";
import { repoHomeHref, repoTreeHref, repoCommitsHref, repoPullsHref, toStandaloneHref } from "../../lib/repoView";

const repoSig = (row: any) => `${row.repository ?? ""}|${row.git_remote_url ?? ""}|${row.pr_status?.repository ?? ""}`;
const taskRepoSig = (row: any) => `${row.project_id}|${row.plan_id}|${row.conversation_ids?.join(",")}|${row.created_from_conversation}|${row.external?.provider}|${row.external?.identifier}`;
const linkClass = "inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-cyan focus-visible:outline focus-visible:outline-sol-cyan";

export function BranchCodeLink({ session, className = "" }: { session: { git_remote_url?: string | null; git_branch?: string | null; worktree_branch?: string | null; pr_status?: { repository?: string } | null }; className?: string }) {
  const repository = sessionRepository(session);
  const branch = session.git_branch || session.worktree_branch;
  if (!repository) return null;
  return (
    <Link href={branch ? repoTreeHref(repository, branch) : repoHomeHref(repository)} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
      title={`Browse ${repository}${branch ? ` at ${branch}` : ""} in Codecast`}
      aria-label={`Browse code for ${repository}${branch ? ` at ${branch}` : ""}`}
      className={`inline-flex items-center gap-1 min-w-0 max-w-[180px] rounded border border-sol-cyan/25 bg-sol-cyan/5 px-1.5 py-0.5 text-[10px] text-sol-cyan hover:bg-sol-cyan/15 focus-visible:outline focus-visible:outline-sol-cyan ${className}`}>
      <GitBranch className="w-3 h-3 shrink-0" /><span className="truncate">{branch || repository}</span>
    </Link>
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
