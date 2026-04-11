import { useState } from "react";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useInboxStore } from "../store/inboxStore";

const RETRYABLE_STATUSES = new Set(["needs_context", "blocked", "failed"]);

interface RetryTaskButtonProps {
  task: { short_id: string; execution_status?: string };
  className?: string;
  onRetry?: () => void;
}

export function RetryTaskButton({ task, className, onRetry }: RetryTaskButtonProps) {
  const [loading, setLoading] = useState(false);
  const updateTask = useInboxStore((s) => s.updateTask);

  if (!task.execution_status || !RETRYABLE_STATUSES.has(task.execution_status)) {
    return null;
  }

  const handleRetry = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    updateTask(task.short_id, { status: "open", execution_status: "" });
    onRetry?.();
    setLoading(false);
  };

  return (
    <button
      onClick={handleRetry}
      disabled={loading}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
        "bg-sol-blue/10 text-sol-blue border border-sol-blue/30",
        "hover:bg-sol-blue/20 transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      title="Retry task"
    >
      <RotateCw className={cn("w-2.5 h-2.5", loading && "animate-spin")} />
      Retry
    </button>
  );
}
