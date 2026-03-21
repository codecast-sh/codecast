import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSlideOutStore } from "../store/slideOutStore";
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
} from "lucide-react";
import { Popover, PopoverContent, PopoverAnchor } from "./ui/popover";

const api = _api as any;

const ENTITY_ID_RE = /^(ct|pl)-[a-z0-9]+$/i;

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

export function EntityIdPill({ shortId }: { shortId: string }) {
  const id = shortId.toLowerCase().trim();
  const prefix = id.split("-")[0];
  const isTask = prefix === "ct";
  const isPlan = prefix === "pl";
  const openSlideOut = useSlideOutStore((s) => s.open);

  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimeout = { current: null as ReturnType<typeof setTimeout> | null };

  const task = useQuery(api.tasks.webGet, isTask ? { short_id: id } : "skip");
  const plan = useQuery(api.plans.webGet, isPlan ? { short_id: id } : "skip");

  const entity = isTask ? task : plan;
  const status = entity?.status;

  const Icon = isPlan
    ? Target
    : STATUS_ICON[status || "open"] || Circle;

  const colors = isPlan
    ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20 hover:bg-sol-cyan/20"
    : "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/20 hover:bg-sol-yellow/20";

  const handleMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverOpen(true), 250);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => setHoverOpen(false), 150);
  }, []);

  const handleClick = useCallback(() => {
    setHoverOpen(false);
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    if (!entity?._id) return;
    openSlideOut(isTask ? "task" : "plan", entity._id);
  }, [openSlideOut, entity, isTask]);

  return (
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverAnchor asChild>
        <button
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-mono leading-[1.4] ${colors} border transition-colors cursor-pointer align-baseline`}
        >
          <Icon className="w-2.5 h-2.5 flex-shrink-0" />
          <span>{id}</span>
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
          isTask ? <TaskHoverContent task={entity} /> : <PlanHoverContent plan={entity} />
        ) : (
          <div className="text-[11px] text-gray-500">{id}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
