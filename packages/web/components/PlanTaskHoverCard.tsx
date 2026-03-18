import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import {
  Target,
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useSlideOutStore } from "../store/slideOutStore";

const api = _api as any;

const STATUS_ICON: Record<string, any> = {
  draft: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
};

const STATUS_COLOR: Record<string, string> = {
  draft: "text-sol-text-dim",
  open: "text-sol-blue",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-sol-text-dim",
};

function PlanHoverContent({ planId }: { planId: Id<"plans"> }) {
  const plan = useQuery(api.plans.webPlanContext, { plan_id: planId });

  if (!plan) return <div className="text-xs text-sol-text-dim py-2">Loading...</div>;

  const pct = plan.progress.total > 0
    ? Math.round((plan.progress.done / plan.progress.total) * 100)
    : 0;

  return (
    <div className="space-y-2.5">
      <div>
        <div className="text-xs font-medium text-sol-text">{plan.title}</div>
        {plan.goal && (
          <p className="text-[11px] text-sol-text-muted mt-1 line-clamp-2">{plan.goal}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-sol-bg-highlight overflow-hidden">
          <div
            className="h-full rounded-full bg-sol-green transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[10px] text-sol-text-dim font-mono">
          {plan.progress.done}/{plan.progress.total}
        </span>
      </div>

      {plan.tasks.length > 0 && (
        <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
          {plan.tasks.slice(0, 10).map((task: any) => {
            const Icon = STATUS_ICON[task.status] || Circle;
            const color = STATUS_COLOR[task.status] || "text-sol-text-dim";
            return (
              <div key={task._id} className="flex items-center gap-1.5 py-0.5 text-[11px]">
                <Icon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
                <span className={`truncate ${task.status === "done" ? "line-through text-sol-text-dim" : "text-sol-text-muted"}`}>
                  {task.title}
                </span>
              </div>
            );
          })}
          {plan.tasks.length > 10 && (
            <div className="text-[10px] text-sol-text-dim pt-1">
              +{plan.tasks.length - 10} more
            </div>
          )}
        </div>
      )}

      <Link
        href={`/plans/${plan._id}`}
        className="block text-[10px] text-sol-cyan hover:underline"
      >
        Open plan
      </Link>
    </div>
  );
}

export function PlanBadge({
  plan,
  className,
}: {
  plan: { _id: string; short_id: string; title: string; status?: string };
  className?: string;
}) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimeout = { current: null as ReturnType<typeof setTimeout> | null };
  const openSlideOut = useSlideOutStore((s) => s.open);

  const handleMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverOpen(true), 300);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => setHoverOpen(false), 200);
  }, []);

  const handleClick = useCallback(() => {
    setHoverOpen(false);
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    openSlideOut("plan", plan._id);
  }, [openSlideOut, plan._id]);

  return (
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 hover:bg-sol-cyan/20 transition-colors max-w-[180px] ${className || ""}`}
        >
          <Target className="w-2.5 h-2.5 flex-shrink-0" />
          <span className="truncate">{plan.title}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 bg-sol-bg border-sol-border shadow-xl p-3"
        side="bottom"
        align="start"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PlanHoverContent planId={plan._id as Id<"plans">} />
      </PopoverContent>
    </Popover>
  );
}

export function TaskBadge({
  task,
  className,
}: {
  task: { _id: string; short_id: string; title: string; status?: string };
  className?: string;
}) {
  const Icon = STATUS_ICON[task.status || "open"] || Circle;
  const color = STATUS_COLOR[task.status || "open"] || "text-sol-text-dim";
  const openSlideOut = useSlideOutStore((s) => s.open);

  return (
    <button
      onClick={() => openSlideOut("task", task._id)}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 bg-sol-yellow/10 text-sol-yellow border border-sol-yellow/20 hover:bg-sol-yellow/20 transition-colors max-w-[200px] ${className || ""}`}
    >
      <Icon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
      <span className="truncate">{task.title}</span>
    </button>
  );
}
