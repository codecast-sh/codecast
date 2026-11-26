import { ShortId } from "./ShortId";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { computePlanProgress } from "../lib/liveEntities";
import { RailProgress, railChipClass } from "./ContextRail";
import { Target } from "lucide-react";

const api = _api as any;

/** The plan a session belongs to, as one rail chip that opens the plan page.
 *  A person pressing the plan chip wants the plan: it used to open a summary
 *  (the goal cut to two lines and the task titles) with the plan one more
 *  link away, and people pressed the chip again and again without getting
 *  there (ct-101660). The plan page carries the goal and the task list whole. */
export function PlanContextPanel({ planId }: { planId: Id<"plans"> }) {
  const queryPlan = useQueryNoThrow(api.plans.webPlanContext, { plan_id: planId }).data;

  // Local-first first paint: the strip used to pop in a round-trip after the
  // conversation rendered, on every open. The store's plan row + task rows
  // compose the same shape; the query replaces it when it answers. Read
  // non-reactively — this panel sits in the always-mounted header, and the
  // query is what keeps it fresh.
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

  if (!plan) return null;

  const { progress } = plan;

  return (
    <div data-cc-context-panel className="contents">
      <Link
        href={`/plans/${plan.short_id ?? plan._id}`}
        data-cc-rail-item="plan"
        title={`${plan.title} · ${plan.short_id ?? ""}`}
        className={railChipClass(false)}
      >
        <Target className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />
        <span className="min-w-0 truncate font-medium text-sol-cyan">{plan.title}</span>
        <span data-rail-full className="flex-shrink-0"><ShortId id={plan.short_id} className="text-sol-text-dim" /></span>
        <span className="ml-auto" />
        <RailProgress done={progress.done} total={progress.total} bar="bg-sol-green" />
      </Link>
    </div>
  );
}
