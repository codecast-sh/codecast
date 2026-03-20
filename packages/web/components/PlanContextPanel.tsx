import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  Target,
  ArrowUp,
  Minus,
  ArrowDown,
  AlertTriangle,
} from "lucide-react";

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

const PRIORITY_ICON: Record<string, any> = {
  urgent: AlertTriangle,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "text-sol-red",
  high: "text-sol-orange",
  medium: "text-sol-text-dim",
  low: "text-sol-text-dim",
};

export function PlanContextPanel({ planId }: { planId: Id<"plans"> }) {
  const plan = useQuery(api.plans.webPlanContext, { plan_id: planId });
  const [expanded, setExpanded] = useState(false);

  if (!plan) return null;

  const { progress } = plan;
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
      >
        <Target className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />
        <span className="font-medium text-sol-cyan truncate">{plan.title}</span>
        <span className="text-sol-text-dim font-mono">{plan.short_id}</span>
        <div className="flex items-center gap-1.5 ml-auto">
          <div className="w-16 h-1.5 rounded-full bg-sol-bg-highlight overflow-hidden">
            <div
              className="h-full rounded-full bg-sol-green transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-sol-text-dim">{progress.done}/{progress.total}</span>
          {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {plan.goal && (
            <p className="text-[11px] text-sol-text-muted line-clamp-2">{plan.goal}</p>
          )}

          <div className="space-y-0.5">
            {plan.tasks.map((task: any) => {
              const Icon = STATUS_ICON[task.status] || Circle;
              const color = STATUS_COLOR[task.status] || "text-sol-text-dim";
              const PIcon = PRIORITY_ICON[task.priority];
              const pColor = PRIORITY_COLOR[task.priority];

              return (
                <Link
                  key={task._id}
                  href={`/tasks/${task._id}`}
                  className="flex items-center gap-2 py-1 px-1.5 rounded text-xs hover:bg-sol-bg-alt/50 transition-colors group"
                >
                  <Icon className={`w-3 h-3 flex-shrink-0 ${color}`} />
                  <span className={`truncate ${task.status === "done" ? "line-through text-sol-text-dim" : "text-sol-text-muted group-hover:text-sol-text"}`}>
                    {task.title}
                  </span>
                  {PIcon && pColor && (
                    <PIcon className={`w-3 h-3 ml-auto flex-shrink-0 ${pColor}`} />
                  )}
                </Link>
              );
            })}
          </div>

          <Link
            href={`/plans/${plan.short_id}`}
            className="block text-[10px] text-sol-cyan hover:underline pt-1"
          >
            View full plan
          </Link>
        </div>
      )}
    </div>
  );
}
