import { Bot, CheckSquare, FileText, FolderOpen, Hash, MessageSquare, Tag, Target, User, Calendar } from "lucide-react";
import type { MentionItem } from "./MentionList";
import { useInboxStore, placeInboxRows, rankVerdictOf } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { AvatarImg } from "../../lib/avatarCache";
import { visitTimeAgo } from "../../lib/recentVisits";
import { statusesForTeam, taskStatusOf } from "../../lib/taskStatuses";
import { agentDisplayName, deriveLiveAt, modelDisplayLabel } from "@codecast/shared/contracts";
import { liveFactsOf } from "../../lib/liveness";

const TYPES = {
  session: { icon: MessageSquare, label: "Session", color: "text-sol-blue" },
  task: { icon: CheckSquare, label: "Task", color: "text-sol-violet" },
  doc: { icon: FileText, label: "Doc", color: "text-sol-cyan" },
  plan: { icon: Target, label: "Plan", color: "text-sol-violet" },
  label: { icon: Tag, label: "Label", color: "text-sol-magenta" },
  person: { icon: User, label: "Person", color: "text-sol-green" },
  file: { icon: FolderOpen, label: "File", color: "text-sol-text-dim" },
  skill: { icon: Hash, label: "Command", color: "text-sol-orange" },
  date: { icon: Calendar, label: "Date", color: "text-sol-orange" },
};

const STATE_COLORS: Record<string, string> = {
  working: "text-sol-green", needs_input: "text-sol-orange", done: "text-sol-green",
  dormant: "text-sol-text-dim", idle: "text-sol-text-dim", in_progress: "text-sol-yellow",
  in_review: "text-sol-violet", blocked: "text-sol-orange", permission_blocked: "text-sol-orange",
};

export function MentionSuggestion({ item }: { item: Omit<MentionItem, "id"> & { id?: string; description?: string } }) {
  const now = useCoarseNow(15_000);
  const liveJson = useInboxStore((s) => {
    const id = item.id ?? "";
    if (item.type === "session" && s.sessions[id]) {
      const row = s.sessions[id];
      const live = deriveLiveAt(liveFactsOf(row), now);
      const verdict = rankVerdictOf({ ...row, ...live, agent_status: (live.agent_status ?? undefined) as typeof row.agent_status, is_connected: live.daemon_alive }, placeInboxRows(s, { now }).placements.get(id));
      const status = !verdict.idle ? "working" : verdict.waiting ? verdict.rest : "idle";
      return JSON.stringify({
        label: row.title || "Untitled Session", status, messageCount: row.message_count,
        projectPath: row.git_root || row.project_path, agentType: row.agent_type,
        model: row.model ?? undefined, idleSummary: row.idle_summary, updatedAt: row.updated_at,
      });
    }
    if (item.type === "task" && s.tasks[id]) {
      const row = s.tasks[id];
      return JSON.stringify({ label: row.title, status: taskStatusOf(row, statusesForTeam(s.teams, row.team_id)).name, priority: row.priority, updatedAt: row.updated_at });
    }
    if (item.type === "plan" && s.plans[id]) {
      const row = s.plans[id];
      return JSON.stringify({ label: row.title, status: row.status, goal: row.goal, updatedAt: row.updated_at });
    }
    if (item.type === "doc" && s.docs[id]) {
      const row = s.docs[id];
      return JSON.stringify({ label: row.title, docType: row.doc_type, updatedAt: row.updated_at });
    }
    return "{}";
  });
  const current = { ...item, ...JSON.parse(liveJson) } as typeof item;
  const config = TYPES[current.type as keyof typeof TYPES] ?? TYPES.doc;
  const Icon = current.isBot ? Bot : config.icon;
  const status = current.type === "person" || (current.type === "session" && liveJson === "{}") ? undefined : current.status;
  const parts = [config.label];
  if (current.type === "session") {
    if (current.agentType) parts.push(agentDisplayName(current.agentType));
    const model = modelDisplayLabel(current.agentType, current.model);
    if (model) parts.push(model);
    const project = current.projectPath?.split("/").filter(Boolean).pop();
    if (project) parts.push(project);
    if (current.messageCount != null) parts.push(`${current.messageCount} msg${current.messageCount === 1 ? "" : "s"}`);
  } else if (current.type === "task") {
    if (current.shortId) parts.push(current.shortId);
    if (current.priority && current.priority !== "none") parts.push(`${current.priority} priority`);
  } else if (current.type === "file") {
    const parent = current.label.replace(/\/[^/]+$/, "");
    if (parent !== current.label) parts.push(parent);
  } else if (current.type === "doc") parts.push(current.docType || "note");
  else if (current.type === "plan" && current.shortId) parts.push(current.shortId);
  else if (current.sublabel || current.description) parts.push(current.sublabel || current.description!);
  const summary = current.type === "session" ? current.idleSummary : current.type === "plan" ? current.goal : undefined;
  const time = current.viewedAt || current.updatedAt;
  const timeLabel = current.viewedAt ? "Viewed" : "Updated";

  return (
    <>
      {current.image
        ? <AvatarImg src={current.image} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
        : <Icon aria-hidden className={`w-4 h-4 shrink-0 ${config.color}`} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13px] truncate" title={current.label}>
            {current.type === "file" ? current.label.split("/").pop() : current.type === "skill" ? `/${current.label}` : current.label}
          </span>
          {time ? <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim tabular-nums" title={`${timeLabel} ${new Date(time).toLocaleString()}`}>{timeLabel.toLowerCase()} {visitTimeAgo(time)}</span> : null}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-sol-text-dim min-w-0" title={[status, ...parts, summary].filter(Boolean).join(" · ")}>
          {status && <span className={`shrink-0 ${STATE_COLORS[status.toLowerCase().replace(/ /g, "_")] ?? "text-sol-text-muted"}`}>
            {status === "working" && <span className="inline-block w-1.5 h-1.5 mr-1 rounded-full bg-sol-green" />}
            {status.replace(/_/g, " ")}
          </span>}
          {status && <span aria-hidden className="opacity-40">·</span>}
          <span className="truncate">{parts.join(" · ")}</span>
        </span>
      </span>
    </>
  );
}
