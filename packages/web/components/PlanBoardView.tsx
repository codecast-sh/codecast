import { useState, useCallback, DragEvent } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { TaskStatusBadge, getExecStatusConfig } from "./TaskStatusBadge";
import { toast } from "sonner";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
} from "lucide-react";

const api = _api as any;

const BOARD_COLUMNS = [
  { status: "open", label: "Open", icon: Circle, color: "text-sol-blue", border: "border-sol-blue/30" },
  { status: "in_progress", label: "In Progress", icon: CircleDot, color: "text-sol-yellow", border: "border-sol-yellow/30" },
  { status: "in_review", label: "Verify", icon: CircleDot, color: "text-sol-violet", border: "border-sol-violet/30" },
  { status: "done", label: "Done", icon: CheckCircle2, color: "text-sol-green", border: "border-sol-green/30" },
  { status: "dropped", label: "Dropped", icon: XCircle, color: "text-sol-text-dim", border: "border-sol-text-dim/30" },
] as const;

const PRIORITY_CONFIG: Record<string, { icon: typeof Minus; color: string }> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red" },
  high: { icon: ArrowUp, color: "text-sol-orange" },
  medium: { icon: Minus, color: "text-sol-text-dim" },
  low: { icon: ArrowDown, color: "text-sol-text-dim" },
};

export function PlanBoardView({ tasks, planShortId }: { tasks: any[]; planShortId: string }) {
  const webUpdate = useMutation(api.tasks.webUpdate);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const onDragStart = useCallback((e: DragEvent, shortId: string) => {
    e.dataTransfer.setData("text/plain", shortId);
    e.dataTransfer.effectAllowed = "move";
    setDragging(shortId);
  }, []);

  const onDragEnd = useCallback(() => {
    setDragging(null);
    setDragOver(null);
  }, []);

  const onDrop = useCallback(async (e: DragEvent, targetStatus: string) => {
    e.preventDefault();
    setDragOver(null);
    const shortId = e.dataTransfer.getData("text/plain");
    if (!shortId) return;

    const task = tasks.find(t => t.short_id === shortId);
    if (!task || task.status === targetStatus) {
      setDragging(null);
      return;
    }

    try {
      await webUpdate({ short_id: shortId, status: targetStatus });
      toast.success(`${shortId} → ${targetStatus.replace("_", " ")}`);
    } catch {
      toast.error("Failed to update task");
    }
    setDragging(null);
  }, [tasks, webUpdate]);

  const onDragOver = useCallback((e: DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(status);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(null);
  }, []);

  return (
    <div className="grid grid-cols-5 gap-3 min-h-[300px]">
      {BOARD_COLUMNS.map(col => {
        const ColIcon = col.icon;
        const columnTasks = tasks.filter(t => t.status === col.status);
        const isOver = dragOver === col.status;

        return (
          <div
            key={col.status}
            onDrop={e => onDrop(e, col.status)}
            onDragOver={e => onDragOver(e, col.status)}
            onDragLeave={onDragLeave}
            className={`flex flex-col rounded-lg border transition-colors ${
              isOver
                ? `${col.border} bg-sol-bg-alt/50`
                : "border-sol-border/15 bg-sol-bg-alt/20"
            }`}
          >
            <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-sol-border/10">
              <ColIcon className={`w-3.5 h-3.5 ${col.color}`} />
              <span className={`text-xs font-medium ${col.color}`}>{col.label}</span>
              <span className="text-[10px] text-sol-text-dim/50 ml-auto tabular-nums">
                {columnTasks.length}
              </span>
            </div>

            <div className="flex-1 p-2 space-y-1.5 overflow-y-auto">
              {columnTasks.map(task => {
                const pc = task.priority ? PRIORITY_CONFIG[task.priority] : null;
                const PriorityIcon = pc?.icon;
                const hasExec = task.execution_status && !!getExecStatusConfig(task.execution_status);
                const isDragging = dragging === task.short_id;

                return (
                  <div
                    key={task._id}
                    draggable
                    onDragStart={e => onDragStart(e, task.short_id)}
                    onDragEnd={onDragEnd}
                    className={`rounded-md border border-sol-border/20 bg-sol-bg px-2.5 py-2 cursor-grab active:cursor-grabbing transition-opacity ${
                      isDragging ? "opacity-30" : "opacity-100 hover:border-sol-border/40"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-mono text-sol-text-dim">{task.short_id}</span>
                      {PriorityIcon && pc && (
                        <PriorityIcon className={`w-3 h-3 ${pc.color}`} />
                      )}
                    </div>
                    <div className="text-xs text-sol-text leading-snug line-clamp-2">
                      {task.title}
                    </div>
                    {hasExec && (
                      <div className="mt-1.5">
                        <TaskStatusBadge status={task.execution_status} type="execution" />
                      </div>
                    )}
                    {task.execution_status === "needs_context" && (
                      <div className="mt-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-sol-orange/15 text-sol-orange border border-sol-orange/25">
                        Needs input
                      </div>
                    )}
                    {task.execution_status === "blocked" && (
                      <div className="mt-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-sol-red/15 text-sol-red border border-sol-red/25">
                        Blocked
                      </div>
                    )}
                  </div>
                );
              })}
              {columnTasks.length === 0 && (
                <div className="flex items-center justify-center h-16 text-[10px] text-sol-text-dim/30">
                  Drop here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
