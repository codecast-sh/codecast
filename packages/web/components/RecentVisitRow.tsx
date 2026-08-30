import { useMemo } from "react";
import { MessageSquare, Tag, Folder, FileText, ListTodo, Map as MapIcon, Search, Inbox, LayoutGrid, Hash, Lock, Rss, Globe, Workflow, Zap, FolderKanban } from "lucide-react";
import { useInboxStore, getProjectName } from "../store/inboxStore";
import { VISIT_OBJECT_LABEL, visitTimeAgo, type ResolvedVisit } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { sessionLivenessState, type LivenessState } from "../lib/liveness";
import { agentDisplayName } from "../lib/commentThread";
import { statusesForTeam, statusVisual, taskStatusOf } from "../lib/taskStatuses";
import { computePlanProgress } from "../lib/liveEntities";
import { PRIORITY_OPTIONS, PLAN_STATUS_OPTIONS, DOC_TYPE_OPTIONS } from "./menus/entityOptions";
import { LivenessDot } from "./LivenessDot";

// One surface → icon map for every place that shows a page reference (the
// recents rows, the tab bar). Route prefix decides; LayoutGrid is the generic.
export function PageIcon({ path, className }: { path: string; className: string }) {
  if (path.startsWith("/tasks")) return <ListTodo className={className} />;
  if (path.startsWith("/docs")) return <FileText className={className} />;
  if (path.startsWith("/plans")) return <MapIcon className={className} />;
  if (path.startsWith("/search")) return <Search className={className} />;
  if (path.startsWith("/inbox") || path.startsWith("/conversation/")) return <Inbox className={className} />;
  if (path.startsWith("/chat/")) return <Hash className={className} />;
  if (path.startsWith("/chat")) return <MessageSquare className={className} />;
  if (path.startsWith("/feed")) return <Rss className={className} />;
  if (path.startsWith("/files") || path.startsWith("/vault")) return <Folder className={className} />;
  if (path.startsWith("/pages") || path.startsWith("/artifacts")) return <Globe className={className} />;
  if (path.startsWith("/projects")) return <FolderKanban className={className} />;
  if (path.startsWith("/workflows") || path.startsWith("/routines")) return <Workflow className={className} />;
  if (path.startsWith("/triggers") || path.startsWith("/schedules")) return <Zap className={className} />;
  return <LayoutGrid className={className} />;
}

const LIVENESS_WORD: Record<LivenessState, string> = {
  active: "working",
  idle: "idle",
  blocked: "blocked",
  error: "error",
  new: "new",
  pinned: "pinned",
  unresponsive: "unresponsive",
  done: "done",
  dormant: "dormant",
};

// A task's status glyph in its team's colour. Its own component so only rows
// that are tasks subscribe to the teams roster.
function TaskGlyph({ task, className }: { task: any; className: string }) {
  const teams = useInboxStore((s) => s.teams);
  const visual = useMemo(() => {
    const statuses = statusesForTeam(teams, task.team_id);
    return statusVisual(taskStatusOf(task, statuses), statuses);
  }, [teams, task]);
  const Icon = visual.icon;
  return <Icon className={`${className} ${visual.color}`} />;
}

function taskStatusLabel(task: any, teams: any[]): string {
  const statuses = statusesForTeam(teams, task.team_id);
  return taskStatusOf(task, statuses).name;
}

// The glyph that says what kind of thing a visit is, in the object's own
// state colour where it has one (task status, plan status, label colour).
export function RecentVisitGlyph({ item, className }: { item: ResolvedVisit; className: string }) {
  const dim = `${className} text-sol-text-dim`;
  switch (item.objectType) {
    case "session":
      return <MessageSquare className={dim} />;
    case "task":
      return item.entity ? <TaskGlyph task={item.entity} className={className} /> : <ListTodo className={dim} />;
    case "plan": {
      const opt = PLAN_STATUS_OPTIONS.find((o) => o.key === item.entity?.status);
      const Icon = opt?.icon ?? MapIcon;
      return <Icon className={`${className} ${opt?.color ?? "text-sol-text-dim"}`} />;
    }
    case "doc":
      return <FileText className={dim} />;
    case "channel": {
      const kind = item.entity?.kind;
      const Icon = kind === "dm" ? MessageSquare : kind === "private" ? Lock : Hash;
      return <Icon className={dim} />;
    }
    case "label":
      return <Tag className={`${className} ${getLabelColor(item.title).text}`} />;
    case "project":
      return <Folder className={dim} />;
    default:
      return <PageIcon path={item.path ?? ""} className={dim} />;
  }
}

// The detail line under a title: what kind of object this is, then the facts
// that tell it apart from its neighbours — a task's id / status / priority, a
// plan's progress, a session's project and agent, a label's session count.
function detailParts(item: ResolvedVisit, teams: any[]): string[] {
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

// A two-line recents row: glyph, title with the time it was visited, and the
// detail line. The caller supplies the interactive wrapper (button, cmdk item,
// the switcher's selected frame) so this stays purely presentational.
export function RecentVisitRow({ item, selected = false, trailing }: { item: ResolvedVisit; selected?: boolean; trailing?: React.ReactNode }) {
  const teams = useInboxStore((s) => s.teams);
  const parts = detailParts(item, teams);
  const liveness = item.objectType === "session" && item.entity ? sessionLivenessState(item.entity) : null;
  return (
    <>
      <span className="w-5 flex-shrink-0 flex items-center justify-center">
        <RecentVisitGlyph item={item} className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className={`truncate text-[13px] ${selected ? "text-sol-text font-medium" : "text-sol-text/85"}`}>{item.title}</span>
          {trailing}
          <span className="ml-auto text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{visitTimeAgo(item.ts)}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-sol-text-dim truncate">
          {liveness && (
            <>
              <LivenessDot state={liveness} size="xs" />
              <span>{LIVENESS_WORD[liveness]}</span>
              <span className="opacity-50">·</span>
            </>
          )}
          <span className="truncate">{parts.join(" · ")}</span>
        </span>
      </span>
    </>
  );
}
