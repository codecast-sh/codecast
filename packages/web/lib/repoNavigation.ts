import { normalizeGitOrigin } from "@codecast/shared/contracts";
import { formatLineHash, parseLineHash, repoBlobHref, repoHomeHref, repoTreeHref } from "./repoView";

const repositoryPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i;

export function githubRepository(value?: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeGitOrigin(value.trim().replace(/\/+$/, ""));
  const name = normalized?.startsWith("github.com/") ? normalized.slice(11) : null;
  return name && repositoryPattern.test(name) && !name.endsWith("/.") && !name.endsWith("/..") ? name : null;
}

export function repositoryName(value?: string | null): string | null {
  if (!value) return null;
  return githubRepository(repositoryPattern.test(value) ? `https://github.com/${value}` : value);
}

export function sessionRepository(session: { git_remote_url?: string | null; pr_status?: { repository?: string } | null }): string | null {
  return githubRepository(session.git_remote_url) ?? repositoryName(session.pr_status?.repository);
}

export function taskRepository(task: { external?: { provider?: string; identifier?: string } | null }): string | null {
  return task.external?.provider === "github" ? repositoryName(task.external.identifier?.split("#")[0]) : null;
}

export function repositoryJump(input: string): { repository: string; href: string; label: string } | null {
  const text = input.trim().replace(/^https?:\/\/github\.com\//i, "");
  const match = text.match(/^([a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+)(?:@([^\s:#?]+))?(?::([^#?]+))?(#L\d+(?:-L?\d+)?)?$/i);
  if (!match) return null;
  const repository = repositoryName(match[1]);
  const ref = match[2];
  const path = match[3]?.trim();
  if (!repository || (path && (path.startsWith("/") || path.split("/").some(p => p === ".." || p === ".")))) return null;
  const range = parseLineHash(match[4]);
  if (match[4] && (!path || !range)) return null;
  const href = path ? repoBlobHref(repository, ref || "HEAD", path) : ref ? repoTreeHref(repository, ref) : repoHomeHref(repository);
  return { repository, href: href + formatLineHash(range), label: path ? `${repository} · ${path}` : ref ? `${repository} · ${ref}` : repository };
}

export type RepositoryScope = { taskId?: string; planId?: string; projectId?: string; conversationIds?: readonly string[] };

export function repositoryEventMatches(row: Record<string, any>, scope: RepositoryScope): boolean {
  return !!(
    (scope.taskId && (row.task_id === scope.taskId || row.task_ids?.includes(scope.taskId))) ||
    (scope.planId && (row.plan_id === scope.planId || row.plan_ids?.includes(scope.planId))) ||
    (scope.projectId && (row.project_id === scope.projectId || row.project_ids?.includes(scope.projectId))) ||
    scope.conversationIds?.some(id => row.conversation_id === id || row.conversation_ids?.includes(id))
  );
}
