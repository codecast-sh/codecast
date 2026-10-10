"use client";
// "Ask again": a cause whose fix was built while its card
// went unanswered, so nothing was approved and nothing shipped. The line
// starts on the cause again through the same start "Start now" uses
// (dispatch startLineCause); the fix is saved on its branch, so the new run
// picks it up and brings a new card. Shared by the problem's timeline and the decision page.
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useLineCauseActions } from "./map/useLineCause";
import { cn } from "../../lib/utils";
import "./line.css";

export function AskAgain({ taskId, projectId, className }: { taskId: string; projectId: string | null; className?: string }) {
  const { start, error } = useLineCauseActions(projectId);
  const [sent, setSent] = useState(false);
  const busy = sent && !error;
  return (
    <span className={cn("inline-flex items-center gap-2 min-w-0", className)} data-ask-again={taskId}>
      <button
        type="button"
        className="line-ask-again"
        disabled={busy}
        onClick={() => { setSent(true); start(taskId); }}
        title="Starts the line on this problem again. The fix is saved on its branch, so the new run picks it up and brings you a new card to answer."
      >
        <RotateCcw className="w-3 h-3 shrink-0" />{busy ? "Asking again" : "Ask again"}
      </button>
      {sent && error && <span className="text-[12px] text-sol-red" role="alert">{error}</span>}
    </span>
  );
}
