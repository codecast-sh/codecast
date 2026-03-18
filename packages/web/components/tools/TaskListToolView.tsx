import { Check, Circle, Loader2, Lock } from "lucide-react";
import type { ToolViewProps } from "@/lib/toolRegistry";

interface TaskItem {
  id: string;
  status: string;
  subject: string;
  owner?: string;
  blockedBy?: string[];
}

function parseTaskListResult(output: any): TaskItem[] {
  const text = typeof output === "string" ? output : JSON.stringify(output || "");
  const items: TaskItem[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(([^)]+)\))?(?:\s+\[blocked by ([^\]]+)])?$/);
    if (match) {
      items.push({
        id: match[1],
        status: match[2],
        subject: match[3].trim(),
        owner: match[4]?.trim(),
        blockedBy: match[5]?.split(",").map((s) => s.trim().replace("#", "")),
      });
    }
  }
  return items;
}

const statusIcon: Record<string, React.ReactNode> = {
  completed: <Check className="w-4 h-4 text-emerald-500" />,
  in_progress: <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />,
  pending: <Circle className="w-4 h-4 text-sol-text-dim" />,
};

const ownerColors = [
  "bg-blue-500/20 text-blue-400 border-blue-500/30",
  "bg-violet-500/20 text-violet-400 border-violet-500/30",
  "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "bg-pink-500/20 text-pink-400 border-pink-500/30",
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
];

function ownerColor(name: string, allOwners: string[]): string {
  const idx = allOwners.indexOf(name);
  return ownerColors[idx >= 0 ? idx % ownerColors.length : 0];
}

export function TaskListToolView({ output }: ToolViewProps) {
  const items = parseTaskListResult(output);
  if (items.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground italic">No tasks</div>;
  }

  const allOwners = [...new Set(items.map((t) => t.owner).filter(Boolean) as string[])];
  const completed = items.filter((t) => t.status === "completed").length;
  const inProgress = items.filter((t) => t.status === "in_progress").length;
  const pending = items.filter((t) => t.status === "pending").length;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>
          <span className="text-emerald-500 font-semibold">{completed}</span> done
        </span>
        {inProgress > 0 && (
          <span>
            <span className="text-amber-500 font-semibold">{inProgress}</span> active
          </span>
        )}
        {pending > 0 && (
          <span>
            <span className="text-foreground/70 font-semibold">{pending}</span> pending
          </span>
        )}
      </div>

      <div className="space-y-1">
        {items.map((task) => {
          const isBlocked = task.blockedBy && task.blockedBy.length > 0;
          return (
            <div
              key={task.id}
              className={`flex items-start gap-2.5 py-1.5 px-2 rounded text-sm ${
                isBlocked ? "opacity-60" : ""
              }`}
            >
              <div className="mt-0.5 flex-shrink-0">
                {isBlocked ? (
                  <Lock className="w-4 h-4 text-sol-text-dim" />
                ) : (
                  statusIcon[task.status] || statusIcon.pending
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sol-text-dim text-xs font-mono">#{task.id}</span>
                  <span
                    className={`${
                      task.status === "completed"
                        ? "text-sol-text-dim line-through"
                        : task.status === "in_progress"
                          ? "text-sol-text-secondary"
                          : "text-sol-text-muted"
                    }`}
                  >
                    {task.subject}
                  </span>
                  {task.owner && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${ownerColor(task.owner, allOwners)}`}
                    >
                      @{task.owner}
                    </span>
                  )}
                  {isBlocked && (
                    <span className="text-[10px] text-sol-text-dim">
                      blocked by {task.blockedBy!.map((id) => `#${id}`).join(", ")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
