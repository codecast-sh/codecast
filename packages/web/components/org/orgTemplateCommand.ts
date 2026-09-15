import { inWorkspace } from "../../lib/workspaceScope";
import type { ProjectItem } from "../../store/inboxStore";
import type { OrgTree } from "./orgTypes";

export type TemplateProject = Pick<ProjectItem, "_id" | "title" | "workspace">;
export type TemplateDraft = { projectId: string; projectPath: string; folder: string; instance: string };

export function buildOrgTemplateCommand(draft: TemplateDraft, projects: TemplateProject[], workspace: OrgTree["workspace"]): { command: string; error?: never } | { error: string; command?: never } {
  const project = projects.find((p) => p._id === draft.projectId);
  if (!workspace.id || !project?.workspace || !inWorkspace(project, `${workspace.kind}:${workspace.id}`)) return { error: "Choose an existing project in this workspace." };
  const projectPath = draft.projectPath.trim();
  const folder = draft.folder.trim();
  const absolutePath = (path: string) => path.startsWith("/") && path !== "/" && !/[\x00-\x1f\x7f]/.test(path);
  if (!absolutePath(projectPath)) return { error: "Enter an absolute project checkout path on the host, starting with /." };
  if (!absolutePath(folder)) return { error: "Enter an absolute template folder path on the same host, starting with /." };
  const instance = draft.instance.trim();
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(instance)) return { error: "Name the instance with a lowercase letter, then letters, numbers or hyphens (up to 48 characters)." };
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const workspaceFlag = workspace.kind === "team" ? `--team ${quote(workspace.id)}` : "--personal";
  return { command: `cd -- ${quote(projectPath)} &&\ncast org template inspect ${quote(folder)} &&\ncast org template install ${quote(folder)} --project ${quote(project._id)} --instance ${quote(instance)} ${workspaceFlag}` };
}
