import { useMemo } from "react";
import { useQuery } from "convex/react";
import { AppLoader } from "./AppLoader";
import { useInboxStore } from "../store/inboxStore";
import { computePlanProgress } from "../lib/liveEntities";
import { useRouter } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { Target } from "lucide-react";
import { HoverCard } from "./ui/HoverCard";
import { taskVisual } from "./TaskStatusBadge";

const api = _api as any;

function PlanHoverContent({ planId }: { planId: Id<"plans"> }) {
  const queryPlan = useQuery(api.plans.webPlanContext, { plan_id: planId });

  // Local-first: the hover card is transient, so a spinner on EVERY hover is
  // pure delay when the store already holds the plan and its tasks. Same
  // composite as PlanContextPanel; the query replaces it when it answers.
  const plan = useMemo(() => {
    if (queryPlan !== undefined) return queryPlan;
    const s = useInboxStore.getState();
    const row = (s.plans as any)[String(planId)];
    if (!row) return undefined;
    const tasks = (row.task_ids ?? [])
      .map((tid: any) => (s.tasks as any)[String(tid)])
      .filter((t: any) => t && !t.parent_id);
    return { ...row, tasks, progress: computePlanProgress(tasks) };
  }, [queryPlan, planId]);

  if (!plan) return <AppLoader className="min-h-0 bg-transparent py-4 gap-3" size={20} />;

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
            const { icon: Icon, color } = taskVisual(task.status);
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
  const router = useRouter();
  return (
    <HoverCard side="bottom" className="w-72" card={<div className="p-3"><PlanHoverContent planId={plan._id as Id<"plans">} /></div>}>
      <button
        onClick={() => router.push(`/plans/${plan._id}`)}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 hover:bg-sol-cyan/20 transition-colors max-w-[180px] ${className || ""}`}
      >
        <Target className="w-2.5 h-2.5 flex-shrink-0" />
        <span className="truncate">{plan.title}</span>
      </button>
    </HoverCard>
  );
}
