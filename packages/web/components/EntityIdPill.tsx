import React, { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import {
  Target,
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  ArrowUpRight,
  AlertTriangle,
  ArrowUp,
  Minus,
  ArrowDown,
  ChevronDown,
  ExternalLink,
  MessageSquare,
  FolderOpen,
} from "lucide-react";
import { Popover, PopoverContent, PopoverAnchor } from "./ui/popover";

const api = _api as any;

const ENTITY_ID_RE = /^(?:(?:ct|pl)-[a-z0-9]+|jx[a-z0-9]{5,})$/i;

const STATUS_ICON: Record<string, any> = {
  draft: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
  backlog: Circle,
};

const STATUS_COLOR: Record<string, string> = {
  draft: "text-gray-400",
  open: "text-sol-blue",
  backlog: "text-gray-400",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-gray-500",
  active: "text-sol-green",
  paused: "text-sol-yellow",
  abandoned: "text-gray-500",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  dropped: "Dropped",
  active: "Active",
  paused: "Paused",
  abandoned: "Abandoned",
};

const PRIORITY_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  urgent: { icon: AlertTriangle, color: "text-red-400", label: "Urgent" },
  high: { icon: ArrowUp, color: "text-orange-400", label: "High" },
  medium: { icon: Minus, color: "text-sol-yellow", label: "Medium" },
  low: { icon: ArrowDown, color: "text-sol-blue", label: "Low" },
};

export function isEntityId(text: string): boolean {
  return ENTITY_ID_RE.test(text.trim());
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

function TaskHoverContent({ task }: { task: any }) {
  const StatusIcon = STATUS_ICON[task.status || "open"] || Circle;
  const statusColor = STATUS_COLOR[task.status || "open"] || "text-gray-400";
  const statusLabel = STATUS_LABEL[task.status] || task.status;
  const priority = PRIORITY_CONFIG[task.priority];

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {task.title || task.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
            {priority && (
              <>
                <span className="text-gray-600">·</span>
                <span className={`inline-flex items-center gap-0.5 text-[10px] ${priority.color}`}>
                  <priority.icon className="w-2.5 h-2.5" />
                  {priority.label}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {task.description && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(task.description).slice(0, 200)}
        </p>
      )}

      {task.plan && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <Target className="w-2.5 h-2.5 text-sol-cyan flex-shrink-0" />
          <span className="text-[10px] text-sol-cyan truncate">{task.plan.title}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{task.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

function PlanHoverContent({ plan }: { plan: any }) {
  const statusColor = STATUS_COLOR[plan.status || "active"] || "text-gray-400";
  const statusLabel = STATUS_LABEL[plan.status] || plan.status;

  const tasks = plan.tasks || [];
  const doneCount = tasks.filter((t: any) => t.status === "done").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Target className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {plan.title || plan.short_id}
          </div>
          <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      {plan.goal && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(plan.goal).slice(0, 200)}
        </p>
      )}

      {total > 0 && (
        <div className="flex items-center gap-2 pl-[22px]">
          <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-sol-green transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500 font-mono">
            {doneCount}/{total}
          </span>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="space-y-0.5 pl-[22px] max-h-[120px] overflow-y-auto">
          {tasks.slice(0, 6).map((t: any) => {
            const Icon = STATUS_ICON[t.status] || Circle;
            const color = STATUS_COLOR[t.status] || "text-gray-400";
            return (
              <div key={t._id} className="flex items-center gap-1.5 py-0.5 text-[10px]">
                <Icon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
                <span className={`truncate ${t.status === "done" ? "line-through text-gray-500" : "text-gray-400"}`}>
                  {t.title}
                </span>
              </div>
            );
          })}
          {tasks.length > 6 && (
            <div className="text-[10px] text-gray-500 pt-0.5">+{tasks.length - 6} more</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{plan.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

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

function SessionHoverContent({ session }: { session: any }) {
  const isActive = session.status === "active";
  const model = abbrevModel(session.model);
  const projectName = session.project_path?.split("/").pop() ?? null;
  const timeAgo = relativeTime(session.updated_at);

  const metaParts = [
    session.message_count != null ? `${session.message_count} msgs` : null,
    model,
    timeAgo,
  ].filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="relative flex-shrink-0 mt-0.5">
          <MessageSquare className="w-3.5 h-3.5 text-sol-blue" />
          {isActive && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sol-green border border-sol-bg" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {session.title || session.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${isActive ? "text-sol-green" : "text-gray-400"}`}>
              {isActive ? "Active" : session.status || "Stopped"}
            </span>
            {session.agent_type && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-[10px] text-gray-400">{session.agent_type}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {metaParts.length > 0 && (
        <div className="flex items-center gap-2 pl-[22px] text-[10px] text-gray-500 font-mono">
          {metaParts.map((p, i) => (
            <span key={i}>{p}</span>
          ))}
        </div>
      )}

      {projectName && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <FolderOpen className="w-2.5 h-2.5 text-gray-500 flex-shrink-0" />
          <span className="text-[10px] text-gray-400 font-mono truncate">{projectName}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{session.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+|doc:\w+))?\](?:\s*\([^)]*\))?/g;

function MentionPill({ name, entityId }: { name: string; entityId?: string }) {
  if (entityId && isEntityId(entityId)) {
    return <EntityIdPill shortId={entityId} />;
  }
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-blue/10 text-sol-blue border border-sol-blue/20 align-baseline">
      @{name}
    </span>
  );
}

export function renderWithMentions(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const name = match[1].trim();
    const entityId = match[2];
    parts.push(<MentionPill key={match.index} name={name} entityId={entityId} />);
    lastIndex = MENTION_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

export function EntityAwareCode({ children, className, ...props }: any) {
  const text = String(children);
  if (!className && isEntityId(text)) {
    return <EntityIdPill shortId={text} />;
  }
  return <code className={className} {...props}>{children}</code>;
}

export function EntityAwareLink({ href, children, ...props }: any) {
  if (href?.startsWith("entity://")) {
    return <EntityIdPill shortId={href.slice(9)} />;
  }
  if (href?.startsWith("mention://")) {
    const name = decodeURIComponent(href.slice(10));
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-blue/10 text-sol-blue border border-sol-blue/20 align-baseline">
        @{name}
      </span>
    );
  }
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
  if (isEntityId(text)) {
    return <EntityIdPill shortId={text} />;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
}

const CROSSHATCH_BG = [
  "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.04) 4px, rgba(255,255,255,0.04) 5px)",
  "repeating-linear-gradient(-45deg, transparent, transparent 4px, rgba(255,255,255,0.04) 4px, rgba(255,255,255,0.04) 5px)",
].join(", ");

function InlineTaskExpand({ task }: { task: any }) {
  const sc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.open;
  const StatusIcon = sc.icon;
  const pc = PRIORITY_CONFIG[task.priority || "medium"];
  const PriorityIcon = pc?.icon || Minus;

  return (
    <div
      className="mt-1 rounded-lg border border-sol-border/20 overflow-hidden"
      style={{ background: CROSSHATCH_BG }}
    >
      <div className="px-3 py-2.5 space-y-2">
        <div className="text-xs font-medium text-sol-text leading-snug">
          {task.title}
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${sc.color}`}>
            <StatusIcon className="w-2.5 h-2.5" />
            {sc.label}
          </span>
          {pc && (
            <span className={`inline-flex items-center gap-1 text-[10px] ${pc.color}`}>
              <PriorityIcon className="w-2.5 h-2.5" />
              {pc.label}
            </span>
          )}
        </div>
        {task.description && (
          <p className="text-[11px] text-sol-text-muted line-clamp-3 leading-relaxed">
            {stripMarkdown(task.description).slice(0, 200)}
          </p>
        )}
        {task.plan && (
          <div className="flex items-center gap-1.5">
            <Target className="w-2.5 h-2.5 text-sol-cyan flex-shrink-0" />
            <span className="text-[10px] text-sol-cyan truncate">{task.plan.title}</span>
          </div>
        )}
        <Link
          href={`/tasks/${task._id}`}
          className="flex items-center gap-1 text-[10px] text-sol-cyan hover:text-sol-text transition-colors pt-1 border-t border-sol-border/10"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-2.5 h-2.5" />
          Open full task
        </Link>
      </div>
    </div>
  );
}

function InlinePlanExpand({ plan }: { plan: any }) {
  const statusColor = STATUS_COLOR[plan.status || "active"] || "text-gray-400";
  const statusLabel = STATUS_LABEL[plan.status] || plan.status;
  const tasks = plan.tasks || [];
  const doneCount = tasks.filter((t: any) => t.status === "done").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div
      className="mt-1 rounded-lg border border-sol-border/20 overflow-hidden"
      style={{ background: CROSSHATCH_BG }}
    >
      <div className="px-3 py-2.5 space-y-2">
        <div className="text-xs font-medium text-sol-text leading-snug">
          {plan.title}
        </div>
        <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
        {plan.goal && (
          <p className="text-[11px] text-sol-text-muted line-clamp-2 leading-relaxed">
            {stripMarkdown(plan.goal).slice(0, 200)}
          </p>
        )}
        {total > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-sol-green transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] text-sol-text-dim font-mono">
              {doneCount}/{total}
            </span>
          </div>
        )}
        {tasks.length > 0 && (
          <div className="space-y-0.5 max-h-[100px] overflow-y-auto">
            {tasks.slice(0, 5).map((t: any) => {
              const Icon = STATUS_ICON[t.status] || Circle;
              const color = STATUS_COLOR[t.status] || "text-gray-400";
              return (
                <div key={t._id} className="flex items-center gap-1.5 py-0.5 text-[10px]">
                  <Icon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
                  <span className={`truncate ${t.status === "done" ? "line-through text-sol-text-dim" : "text-sol-text-muted"}`}>
                    {t.title}
                  </span>
                </div>
              );
            })}
            {tasks.length > 5 && (
              <div className="text-[10px] text-sol-text-dim">+{tasks.length - 5} more</div>
            )}
          </div>
        )}
        <Link
          href={`/plans/${plan._id}`}
          className="flex items-center gap-1 text-[10px] text-sol-cyan hover:text-sol-text transition-colors pt-1 border-t border-sol-border/10"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-2.5 h-2.5" />
          Open full plan
        </Link>
      </div>
    </div>
  );
}

function InlineSessionExpand({ session }: { session: any }) {
  const isActive = session.status === "active";
  const model = abbrevModel(session.model);
  const projectName = session.project_path?.split("/").pop() ?? null;
  const timeAgo = relativeTime(session.updated_at);

  const metaParts = [
    session.message_count != null ? `${session.message_count} msgs` : null,
    model,
    timeAgo,
  ].filter(Boolean);

  return (
    <div
      className="mt-1 rounded-lg border border-sol-border/20 overflow-hidden"
      style={{ background: CROSSHATCH_BG }}
    >
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-shrink-0">
            <MessageSquare className="w-3.5 h-3.5 text-sol-blue" />
            {isActive && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sol-green border border-sol-bg" />
            )}
          </div>
          <div className="text-xs font-medium text-sol-text leading-snug">
            {session.title || session.short_id}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${isActive ? "text-sol-green" : "text-sol-text-dim"}`}>
            {isActive ? "Active" : session.status || "Stopped"}
          </span>
          {metaParts.map((p, i) => (
            <span key={i} className="text-[10px] text-sol-text-dim font-mono">{p}</span>
          ))}
        </div>
        {projectName && (
          <div className="flex items-center gap-1.5">
            <FolderOpen className="w-2.5 h-2.5 text-sol-text-dim flex-shrink-0" />
            <span className="text-[10px] text-sol-text-muted font-mono truncate">{projectName}</span>
          </div>
        )}
        <Link
          href={`/conversation/${session._id}`}
          className="flex items-center gap-1 text-[10px] text-sol-cyan hover:text-sol-text transition-colors pt-1 border-t border-sol-border/10"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-2.5 h-2.5" />
          Open session
        </Link>
      </div>
    </div>
  );
}

const TASK_STATUS_CONFIG: Record<string, { icon: any; label: string; color: string }> = {
  draft: { icon: CircleDotDashed, label: "Draft", color: "text-gray-400" },
  open: { icon: Circle, label: "Open", color: "text-sol-blue" },
  in_progress: { icon: CircleDot, label: "In Progress", color: "text-sol-yellow" },
  in_review: { icon: CircleDot, label: "In Review", color: "text-sol-violet" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  dropped: { icon: XCircle, label: "Dropped", color: "text-gray-500" },
};

export function EntityIdPill({ shortId }: { shortId: string }) {
  const id = shortId.toLowerCase().trim();
  const isTask = id.startsWith("ct-");
  const isPlan = id.startsWith("pl-");
  const isSession = id.startsWith("jx");

  const [hoverOpen, setHoverOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hoverTimeout = { current: null as ReturnType<typeof setTimeout> | null };

  const task = useQuery(api.tasks.webGet, isTask ? { short_id: id } : "skip");
  const plan = useQuery(api.plans.webGet, isPlan ? { short_id: id } : "skip");
  const session = useQuery(
    api.conversations.webGet,
    isSession ? (id.length <= 7 ? { short_id: id } : { id }) : "skip"
  );

  const entity = isTask ? task : isPlan ? plan : session;
  const status = entity?.status;

  const Icon = isSession
    ? MessageSquare
    : isPlan
      ? Target
      : STATUS_ICON[status || "open"] || Circle;

  const colors = isSession
    ? "bg-sol-blue/10 text-sol-blue border-sol-blue/20 hover:bg-sol-blue/20"
    : isPlan
      ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20 hover:bg-sol-cyan/20"
      : "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/20 hover:bg-sol-yellow/20";

  const pillLabel = isSession && entity?.title
    ? entity.title.length > 30 ? entity.title.slice(0, 30) + "…" : entity.title
    : id;

  const handleMouseEnter = useCallback(() => {
    if (expanded) return;
    hoverTimeout.current = setTimeout(() => setHoverOpen(true), 250);
  }, [expanded]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => setHoverOpen(false), 150);
  }, []);

  const handleClick = useCallback(() => {
    setHoverOpen(false);
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setExpanded((v) => !v);
  }, []);

  return (
    <span style={{ display: expanded ? "block" : "inline" }}>
      <Popover open={hoverOpen && !expanded} onOpenChange={setHoverOpen}>
        <PopoverAnchor asChild>
          <button
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-mono leading-[1.4] ${colors} border transition-colors cursor-pointer align-baseline`}
          >
            <span className="relative flex-shrink-0">
              <Icon className="w-2.5 h-2.5" />
              {isSession && status === "active" && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-sol-green" />
              )}
            </span>
            <span>{pillLabel}</span>
            <ChevronDown className={`w-2 h-2 flex-shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </PopoverAnchor>
        <PopoverContent
          className="w-64 bg-sol-bg border border-sol-border shadow-xl p-3 cursor-pointer"
          side="top"
          align="start"
          sideOffset={6}
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {entity ? (
            isTask ? <TaskHoverContent task={entity} />
            : isPlan ? <PlanHoverContent plan={entity} />
            : <SessionHoverContent session={entity} />
          ) : (
            <div className="text-[11px] text-gray-500">{id}</div>
          )}
        </PopoverContent>
      </Popover>
      {expanded && entity && (
        isTask ? <InlineTaskExpand task={entity} />
        : isPlan ? <InlinePlanExpand plan={entity} />
        : <InlineSessionExpand session={entity} />
      )}
    </span>
  );
}
