// A conversation's TodoWrite progress: the header's expandable progress row and
// the "Tasks: done/total" menu item, both read from the messages in the store.

import { memo, useMemo, useState } from "react";
import { Circle, CircleDot, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { computeConversationTaskStats } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { DropdownMenuItem } from "../ui/dropdown-menu";

const INLINE_TASK_STATUS: Record<string, { icon: typeof Circle; color: string }> = {
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
};

function TaskProgressRow({ taskStats }: { taskStats: { total: number; done: number; in_progress: number; open: number; items: { id: string; content: string; status: string }[] } }) {
  const [expanded, setExpanded] = useState(false);
  const { total, done, in_progress } = taskStats;
  const donePct = (done / total) * 100;
  const ipPct = (in_progress / total) * 100;
  const isComplete = done === total;

  return (
    <div className="mt-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-1 py-0.5 rounded hover:bg-sol-bg-alt/60 transition-colors group cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim flex-shrink-0" />}
        {isComplete ? (
          <CheckCircle2 className="w-3 h-3 text-sol-green flex-shrink-0" />
        ) : in_progress > 0 ? (
          <CircleDot className="w-3 h-3 text-sol-yellow animate-pulse flex-shrink-0" />
        ) : (
          <Circle className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
        )}
        <div className="flex-1 h-1.5 bg-sol-border/30 rounded-full overflow-hidden min-w-[60px] max-w-[120px]">
          <div className="h-full flex">
            <div
              className={`h-full ${isComplete ? "bg-sol-green" : "bg-sol-green/80"}`}
              style={{ width: `${donePct}%` }}
            />
            {ipPct > 0 && (
              <div className="h-full bg-sol-yellow/60" style={{ width: `${ipPct}%` }} />
            )}
          </div>
        </div>
        <span className={`text-meta tabular-nums flex-shrink-0 ${isComplete ? "text-sol-green" : "text-sol-text-dim"}`}>
          {done}/{total} tasks
        </span>
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 border-l border-sol-border/20 pl-2">
          {taskStats.items.map((item) => {
            const cfg = INLINE_TASK_STATUS[item.status] || INLINE_TASK_STATUS.open;
            const Icon = cfg.icon;
            return (
              <div key={item.id} className="flex items-center gap-1.5 py-0.5">
                <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
                <span className={`text-meta truncate ${item.status === "done" ? "text-sol-text-dim line-through" : "text-sol-text-muted"}`}>
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Task stats live in their own leaves so a streaming TodoWrite re-renders
// only these tiny consumers instead of the 11k-line ConversationView. Derived
// from the messages already in the store — a live getConversationToolStats
// scan of assistant tool_calls times out on long sessions ("too many system
// operations") and used to ErrorBoundary the Questions header.
function useConversationTaskStats(conversationId: string | undefined) {
  const messages = useInboxStore((s) =>
    conversationId ? s.messages[conversationId] : undefined,
  );
  return useMemo(() => computeConversationTaskStats(messages), [messages]);
}

export const ConversationTaskProgress = memo(function ConversationTaskProgress({ conversationId }: { conversationId: string }) {
  const taskStats = useConversationTaskStats(conversationId);
  if (!taskStats) return null;
  return <TaskProgressRow taskStats={taskStats} />;
});

export const ConversationTaskStatsMenuItem = memo(function ConversationTaskStatsMenuItem({ conversationId }: { conversationId: string }) {
  const taskStats = useConversationTaskStats(conversationId);
  if (!taskStats) return null;
  return (
    <DropdownMenuItem disabled>
      Tasks: {taskStats.done}/{taskStats.total}
    </DropdownMenuItem>
  );
});
