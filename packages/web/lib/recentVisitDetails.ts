import { getProjectName } from "../store/inboxStore";
import { VISIT_OBJECT_LABEL, type ResolvedVisit } from "./recentVisits";
import { agentDisplayName } from "./commentThread";
import { statusesForTeam, taskStatusOf } from "./taskStatuses";
import { computePlanProgress } from "./liveEntities";
import { PRIORITY_OPTIONS, PLAN_STATUS_OPTIONS, DOC_TYPE_OPTIONS } from "../components/menus/entityOptions";

function taskStatusLabel(task: any, teams: any[]): string {
  const statuses = statusesForTeam(teams, task.team_id);
  return taskStatusOf(task, statuses).name;
}

// The detail line under a title: what kind of object this is, then the facts
// that tell it apart from its neighbours — a task's id / status / priority, a
// plan's progress, a session's project and agent, a label's session count.
// Exported so the searchable recents menu matches a query against the same
// words the row shows (a project name, an agent, a task id).
export function visitDetailParts(item: ResolvedVisit, teams: any[]): string[] {
  const kind = VISIT_OBJECT_LABEL[item.objectType];
  const e = item.entity;
  switch (item.objectType) {
    case "session": {
      const parts = [kind];
      const project = e ? getProjectName(e.git_root, e.project_path) : "unknown";
      if (project !== "unknown") parts.push(project);
      if (e?.agent_type) parts.push(agentDisplayName(e.agent_type));
      if (e?.author_name) parts.push(e.author_name);
      return parts;
    }
    case "task": {
      if (!e) return [kind];
      const parts = [e.short_id ?? kind, taskStatusLabel(e, teams)];
      const priority = PRIORITY_OPTIONS.find((o) => o.key === e.priority);
      if (priority && priority.key !== "none") parts.push(priority.label);
      if (e.assignee_info?.name) parts.push(e.assignee_info.name);
      return parts;
    }
    case "plan": {
      if (!e) return [kind];
      const parts = [e.short_id ?? kind];
      const status = PLAN_STATUS_OPTIONS.find((o) => o.key === e.status);
      if (status) parts.push(status.label);
      const progress = e.progress ?? (e.tasks ? computePlanProgress(e.tasks) : null);
      if (progress?.total) parts.push(`${progress.done}/${progress.total} done`);
      return parts;
    }
    case "doc": {
      const type = DOC_TYPE_OPTIONS.find((o) => o.key === e?.doc_type)?.label ?? e?.doc_type;
      return type ? [kind, type] : [kind];
    }
    case "channel": {
      const k = e?.kind;
      const parts = [k === "dm" ? "Direct message" : k === "private" ? "Private channel" : kind];
      if (e?.topic) parts.push(e.topic);
      return parts;
    }
    case "label":
      return [kind, sessionsWord(item.sessionCount ?? 0)];
    case "project": {
      const parts = [kind, sessionsWord(item.sessionCount ?? 0)];
      if (item.projectPath) parts.push(item.projectPath);
      return parts;
    }
    default:
      return item.path ? [kind, item.path] : [kind];
  }
}

function sessionsWord(n: number): string {
  return n === 1 ? "1 session" : `${n} sessions`;
}

