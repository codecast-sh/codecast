import { useMemo, type ReactNode } from "react";
import { MessageSquare, Tag, Folder, FileText, ListTodo, Map as MapIcon, Search, Inbox, LayoutGrid, Hash, Lock, Rss, Globe, Workflow, Zap, FolderKanban, Flag } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { visitTimeAgo, type ResolvedVisit } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { sessionLivenessState, type LivenessState } from "../lib/liveness";
import { SessionGlyph } from "./identity";
import { identityRowOf } from "../lib/sessionIdentity";
import { statusesForTeam, statusVisual, taskStatusOf } from "../lib/taskStatuses";
import { PLAN_STATUS_OPTIONS } from "./menus/entityOptions";
import { LivenessDot } from "./LivenessDot";
import { isBrowserRoutePath } from "../lib/browserPane";
import { visitDetailParts } from "../lib/recentVisitDetails";

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
  if (isBrowserRoutePath(path)) return <Globe className={className} />;
  if (path.startsWith("/initiatives")) return <Flag className={className} />;
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

// The glyph that says what kind of thing a visit is, in the object's own
// state colour where it has one (task status, plan status, label colour).
export function RecentVisitGlyph({ item, className }: { item: ResolvedVisit; className: string }) {
  const dim = `${className} text-sol-text-dim`;
  switch (item.objectType) {
    case "session":
      // Who the session is (session-characters.md S3), else the old glyph.
      return (
        <SessionGlyph
          row={item.entity ? identityRowOf(item.entity as any) : null}
          size={16}
          fallback={<MessageSquare className={dim} />}
        />
      );
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

// A two-line recents row: glyph, title with the time it was visited, and the
// detail line. The caller supplies the interactive wrapper (button, cmdk item,
// the switcher's selected frame) so this stays purely presentational.
export function RecentVisitRow({ item, selected = false, trailing }: { item: ResolvedVisit; selected?: boolean; trailing?: ReactNode }) {
  const teams = useInboxStore((s) => s.teams);
  const parts = visitDetailParts(item, teams);
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
