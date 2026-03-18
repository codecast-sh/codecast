import { useState } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

const api = _api as any;

const RETRYABLE_STATUSES = new Set(["needs_context", "blocked", "failed"]);

interface RetryTaskButtonProps {
  task: { short_id: string; execution_status?: string };
  className?: string;
  onRetry?: () => void;
}

export function RetryTaskButton({ task, className, onRetry }: RetryTaskButtonProps) {
  const [loading, setLoading] = useState(false);
  const webUpdate = useMutation(api.tasks.webUpdate);

  if (!task.execution_status || !RETRYABLE_STATUSES.has(task.execution_status)) {
    return null;
  }

  const handleRetry = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    try {
      await webUpdate({
        short_id: task.short_id,
        status: "open",
        execution_status: "",
      });
      onRetry?.();
    } finally {
      setLoading(false);
    }
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
