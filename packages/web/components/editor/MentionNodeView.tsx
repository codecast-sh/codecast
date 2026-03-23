import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  User,
  FileText,
  MessageSquare,
  Target,
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
  FolderOpen,
} from "lucide-react";

function abbrevModel(model?: string | null): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return null;
}

function relativeTime(ts?: number | null): string | null {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 5) return `${mins}m ago`;
  return "just now";
}

const ROUTE_MAP: Record<string, string> = {
  person: "/team",
  task: "/tasks",
  doc: "/docs",
  session: "/conversation",
  plan: "/plans",
};

const STATUS_ICONS: Record<string, typeof Circle> = {
  draft: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
};

const STATUS_COLORS: Record<string, string> = {
  draft: "text-[#586e75]",
  open: "text-[#268bd2]",
  in_progress: "text-[#b58900]",
  in_review: "text-[#6c71c4]",
  done: "text-[#859900]",
  dropped: "text-[#586e75]",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  dropped: "Dropped",
};

const PRIORITY_ICONS: Record<string, typeof Minus> = {
  urgent: AlertTriangle,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "text-[#dc322f]",
  high: "text-[#cb4b16]",
  medium: "text-[#586e75]",
  low: "text-[#586e75]",
};

const DOC_TYPE_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  plan: { label: "Plan", color: "text-[#268bd2]", bg: "bg-[#268bd2]/10" },
  design: { label: "Design", color: "text-[#6c71c4]", bg: "bg-[#6c71c4]/10" },
  spec: { label: "Spec", color: "text-[#2aa198]", bg: "bg-[#2aa198]/10" },
  investigation: { label: "Investigation", color: "text-[#b58900]", bg: "bg-[#b58900]/10" },
  handoff: { label: "Handoff", color: "text-[#cb4b16]", bg: "bg-[#cb4b16]/10" },
  note: { label: "Note", color: "text-[#93a1a1]", bg: "bg-[#93a1a1]/10" },
};

function PersonMention({ attrs }: { attrs: Record<string, any> }) {
  return (
    <a
      href={`${ROUTE_MAP.person}/${attrs.id}`}
      className="mention-inline mention-inline-person"
    >
      {attrs.image ? (
        <img src={attrs.image} alt="" className="w-[18px] h-[18px] rounded-full object-cover" />
      ) : (
        <span className="w-[18px] h-[18px] rounded-full bg-[#859900]/20 flex items-center justify-center flex-shrink-0">
          <User className="w-3 h-3 text-[#859900]" />
        </span>
      )}
      <span className="mention-inline-label">{attrs.label}</span>
    </a>
  );
}

function TaskMention({ attrs }: { attrs: Record<string, any> }) {
  const status = attrs.status || "open";
  const priority = attrs.priority;
  const StatusIcon = STATUS_ICONS[status] || Circle;
  const statusColor = STATUS_COLORS[status] || STATUS_COLORS.open;
  const statusLabel = STATUS_LABELS[status] || status;
  const showPriority = priority && priority !== "medium" && priority !== "none";
  const PriorityIcon = showPriority ? (PRIORITY_ICONS[priority] || Minus) : null;
  const priorityColor = showPriority ? (PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium) : "";

  return (
    <a href={`${ROUTE_MAP.task}/${attrs.id}`} className="mention-card mention-card-task">
      <div className="mention-card-row">
        <StatusIcon className={`w-[14px] h-[14px] flex-shrink-0 ${statusColor}`} />
        <span className="mention-card-title">{attrs.label}</span>
        {attrs.shortId && (
          <span className="mention-card-id">{attrs.shortId}</span>
        )}
      </div>
      <div className="mention-card-meta">
        <span className={`${statusColor}`}>{statusLabel}</span>
        {PriorityIcon && (
          <span className={`flex items-center gap-0.5 ${priorityColor}`}>
            <PriorityIcon className="w-3 h-3" />
          </span>
        )}
      </div>
    </a>
  );
}

function DocMention({ attrs }: { attrs: Record<string, any> }) {
  const docType = attrs.docType || attrs.sublabel || "note";
  const typeStyle = DOC_TYPE_STYLES[docType] || DOC_TYPE_STYLES.note;

  return (
    <a href={`${ROUTE_MAP.doc}/${attrs.id}`} className="mention-card mention-card-doc">
      <div className="mention-card-row">
        <FileText className="w-[14px] h-[14px] flex-shrink-0 text-[#2aa198]" />
        <span className="mention-card-title">{attrs.label}</span>
        <span className={`mention-card-badge ${typeStyle.color} ${typeStyle.bg}`}>
          {typeStyle.label}
        </span>
      </div>
    </a>
  );
}

function PlanMention({ attrs }: { attrs: Record<string, any> }) {
  const status = attrs.status || "active";
  const statusLabel = STATUS_LABELS[status] || status;
  const statusColor = STATUS_COLORS[status] || STATUS_COLORS.open;

  return (
    <a href={`${ROUTE_MAP.plan}/${attrs.id}`} className="mention-card mention-card-plan">
      <div className="mention-card-row">
        <Target className="w-[14px] h-[14px] flex-shrink-0 text-[#6c71c4]" />
        <span className="mention-card-title">{attrs.label}</span>
        {attrs.shortId && (
          <span className="mention-card-id">{attrs.shortId}</span>
        )}
      </div>
      <div className="mention-card-meta">
        <span className={statusColor}>{statusLabel}</span>
        {attrs.goal && (
          <span className="mention-card-goal">{attrs.goal}</span>
        )}
      </div>
    </a>
  );
}

function SessionMention({ attrs }: { attrs: Record<string, any> }) {
  const msgCount = attrs.messageCount;
  const projectPath = attrs.projectPath;
  const projectName = projectPath ? projectPath.split("/").slice(-2).join("/") : null;
  const isActive = attrs.status === "active";
  const model = abbrevModel(attrs.model);
  const timeAgo = relativeTime(attrs.updatedAt);
  const idleSummary = attrs.idleSummary as string | null | undefined;

  const metaParts = [
    msgCount != null ? `${msgCount} msgs` : null,
    model,
    timeAgo,
  ].filter(Boolean);

  return (
    <a href={`${ROUTE_MAP.session}/${attrs.id}`} className="mention-card mention-card-session">
      <div className="mention-card-row">
        <div className="relative flex-shrink-0">
          <MessageSquare className="w-[14px] h-[14px] text-[#268bd2]" />
          {isActive && <span className="mention-session-live-dot" />}
        </div>
        <span className="mention-card-title">{attrs.label}</span>
        {attrs.shortId && (
          <span className="mention-card-id">{attrs.shortId}</span>
        )}
      </div>
      {metaParts.length > 0 && (
        <div className="mention-card-meta">
          {metaParts.map((p, i) => (
            <span key={i}>{p}</span>
          ))}
        </div>
      )}
      {projectName && (
        <div className="mention-card-meta mention-card-project">
          <FolderOpen className="w-[10px] h-[10px] flex-shrink-0" />
          <span className="font-mono">{projectName}</span>
        </div>
      )}
      {idleSummary && (
        <div className="mention-card-summary">
          {idleSummary.length > 110 ? idleSummary.slice(0, 110) + "…" : idleSummary}
        </div>
      )}
    </a>
  );
}

export { SessionMention, PersonMention, TaskMention, PlanMention, DocMention };

export function MentionNodeView({ node }: NodeViewProps) {
  const attrs = node.attrs;
  const mtype = attrs.type || "doc";

  return (
    <NodeViewWrapper as="span" className="mention-node-wrap">
      {mtype === "person" && <PersonMention attrs={attrs} />}
      {mtype === "task" && <TaskMention attrs={attrs} />}
      {mtype === "doc" && <DocMention attrs={attrs} />}
      {mtype === "plan" && <PlanMention attrs={attrs} />}
      {mtype === "session" && <SessionMention attrs={attrs} />}
    </NodeViewWrapper>
  );
}
