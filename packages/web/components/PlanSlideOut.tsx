import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  PauseCircle,
  Clock,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
} from "lucide-react";
import { SlideOutPanel } from "./SlideOutPanel";
import { useSlideOutStore } from "../store/slideOutStore";

const api = _api as any;

const STATUS_CONFIG: Record<string, { icon: typeof Circle; label: string; color: string }> = {
  draft: { icon: Circle, label: "Draft", color: "text-sol-text-dim" },
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  abandoned: { icon: XCircle, label: "Abandoned", color: "text-sol-text-dim" },
};

const TASK_STATUS_ICON: Record<string, typeof Circle> = {
  draft: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
};

const TASK_STATUS_COLOR: Record<string, string> = {
  draft: "text-sol-text-dim",
  open: "text-sol-blue",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-sol-text-dim",
};

const PRIORITY_ICON: Record<string, { icon: typeof Minus; color: string }> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red" },
  high: { icon: ArrowUp, color: "text-sol-orange" },
  medium: { icon: Minus, color: "text-sol-text-dim" },
  low: { icon: ArrowDown, color: "text-sol-text-dim" },
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PlanContent({ planId }: { planId: string }) {
  const queryArgs = planId.startsWith("pl-") ? { short_id: planId } : { id: planId };
  const data = useQuery(api.plans.webGet, queryArgs);
  const open = useSlideOutStore((s) => s.open);

  if (data === undefined) {
    return (
      <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">
        Loading...
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">
        Plan not found
      </div>
    );
  }

  const status = STATUS_CONFIG[data.status] || STATUS_CONFIG.draft;
  const StatusIcon = status.icon;
  const pct =
    data.progress && data.progress.total > 0
      ? Math.round((data.progress.done / data.progress.total) * 100)
      : 0;

  const tasks = data.tasks || [];
  const recentLog = (data.progress_log || []).slice(-5);

  return (
    <div className="p-4 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <StatusIcon className={`w-4 h-4 ${status.color}`} />
          <span
            className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${status.color} bg-current/10`}
          >
            {status.label}
          </span>
          <span className="text-[10px] font-mono text-sol-text-dim ml-auto">
            {data.short_id}
          </span>
        </div>
        {data.goal && (
          <p className="text-xs text-sol-text-muted leading-relaxed mt-2">
            {data.goal}
          </p>
        )}
      </div>

      {data.progress && data.progress.total > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-sol-text-dim uppercase tracking-wider">
              Progress
            </span>
            <span className="text-[10px] text-sol-text-dim font-mono tabular-nums">
              {data.progress.done}/{data.progress.total} ({pct}%)
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-sol-bg-highlight overflow-hidden">
            <div className="h-full flex">
              <div
                className="bg-sol-green transition-all rounded-l-full"
                style={{
                  width: `${(data.progress.done / data.progress.total) * 100}%`,
                }}
              />
              {data.progress.in_progress > 0 && (
                <div
                  className="bg-sol-yellow transition-all"
                  style={{
                    width: `${(data.progress.in_progress / data.progress.total) * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-2">
            Tasks ({tasks.length})
          </div>
          <div className="border border-sol-border/20 rounded-lg overflow-hidden divide-y divide-sol-border/10">
            {tasks.map((task: any) => {
              const Icon = TASK_STATUS_ICON[task.status] || Circle;
              const color = TASK_STATUS_COLOR[task.status] || "text-sol-text-dim";
              const pri = task.priority ? PRIORITY_ICON[task.priority] : null;
              const PriIcon = pri?.icon;
              const isDone =
                task.status === "done" || task.status === "dropped";
              return (
                <button
                  key={task._id}
                  onClick={() => open("task", task._id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sol-bg-alt/40 transition-colors group"
                >
                  <Icon className={`w-3 h-3 flex-shrink-0 ${color}`} />
                  <span className="text-[10px] font-mono text-sol-text-dim flex-shrink-0">
                    {task.short_id}
                  </span>
                  <span
                    className={`text-xs truncate flex-1 ${
                      isDone
                        ? "line-through text-sol-text-dim"
                        : "text-sol-text group-hover:text-sol-cyan"
                    } transition-colors`}
                  >
                    {task.title}
                  </span>
                  {PriIcon && pri && (
                    <PriIcon
                      className={`w-2.5 h-2.5 flex-shrink-0 ${pri.color}`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {recentLog.length > 0 && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-2">
            Recent Progress
          </div>
          <div className="space-y-2">
            {[...recentLog].reverse().map((entry: any, i: number) => (
              <div
                key={i}
                className="flex items-start gap-2 text-xs"
              >
                <Clock className="w-3 h-3 text-sol-text-dim flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <span className="text-sol-text-muted">{entry.entry}</span>
                  {entry.timestamp && (
                    <span className="block text-[10px] text-sol-text-dim/50 font-mono mt-0.5">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Link
        href={`/plans/${data._id}`}
        className="flex items-center gap-1.5 text-xs text-sol-cyan hover:text-sol-text transition-colors pt-2 border-t border-sol-border/15"
      >
        <ExternalLink className="w-3 h-3" />
        Open full plan
      </Link>
    </div>
  );
}

export function PlanSlideOut() {
  const { type, id, close } = useSlideOutStore();
  const isOpen = type === "plan" && !!id;

  return (
    <SlideOutPanel open={isOpen} onClose={close} title="Plan">
      {isOpen && id && <PlanContent planId={id} />}
    </SlideOutPanel>
  );
}
