// Task-progress stats for a conversation header: the latest TodoWrite list
// plus TaskCreate/TaskUpdate bookkeeping. PURE — Convex, web, and tests all
// call this over a message window so the header never has to scan the
// messages table live (that scan times out on long sessions: each assistant
// row carries full tool_calls, and a subscribed query re-ran on every stream
// tick).

export type TaskStatItem = {
  id: string;
  content: string;
  status: string;
};

export type ConversationTaskStats = {
  total: number;
  done: number;
  in_progress: number;
  open: number;
  items: TaskStatItem[];
};

export type TaskStatToolCall = {
  name: string;
  input?: unknown;
};

export type TaskStatMessage = {
  role?: string;
  timestamp?: number;
  tool_calls?: TaskStatToolCall[] | null;
};

const TODO_TOOL_IDS = new Set(["TodoWrite", "todo_write", "todowrite"]);

function parseToolInput(input: unknown): Record<string, any> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, any>;
  }
  if (typeof input !== "string" || !input) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStatus(s: string): string {
  if (s === "completed" || s === "done") return "done";
  if (s === "in_progress") return "in_progress";
  return "open";
}

export function isTodoStatTool(name: string): boolean {
  return TODO_TOOL_IDS.has(name);
}

/** Fold a message window into the header's task-progress row. Null when empty. */
export function computeConversationTaskStats(
  messages: TaskStatMessage[] | undefined | null,
): ConversationTaskStats | null {
  if (!messages?.length) return null;

  let latestTodos: any[] | null = null;
  let latestTodoTs = -Infinity;
  const taskCreates: { subject: string; ts: number }[] = [];
  const taskStatusMap = new Map<string, { status: string; ts: number }>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    const ts = msg.timestamp ?? 0;
    for (const tc of msg.tool_calls) {
      if (TODO_TOOL_IDS.has(tc.name)) {
        const input = parseToolInput(tc.input);
        if (input?.todos && ts >= latestTodoTs) {
          latestTodos = input.todos;
          latestTodoTs = ts;
        }
        continue;
      }
      if (tc.name === "TaskCreate") {
        const inp = parseToolInput(tc.input);
        if (inp) {
          taskCreates.push({
            subject: String(inp.subject || inp.title || inp.description || ""),
            ts,
          });
        }
        continue;
      }
      if (tc.name === "TaskUpdate") {
        const inp = parseToolInput(tc.input);
        if (inp?.taskId && inp.status) {
          const prev = taskStatusMap.get(String(inp.taskId));
          if (!prev || ts >= prev.ts) {
            taskStatusMap.set(String(inp.taskId), { status: String(inp.status), ts });
          }
        }
      }
    }
  }

  taskCreates.sort((a, b) => a.ts - b.ts);
  const taskItems = taskCreates
    .map((tc, i) => {
      const id = String(i + 1);
      const rawStatus = taskStatusMap.get(id)?.status ?? "pending";
      return { id, content: tc.subject, status: normalizeStatus(rawStatus) };
    })
    .filter((t) => taskStatusMap.get(t.id)?.status !== "deleted");

  const todoItems = (latestTodos ?? []).map((t: any, i: number) => ({
    id: String(t.id || `todo-${i}`),
    content: String(t.content || t.task || t.title || ""),
    status: normalizeStatus(String(t.status ?? "pending")),
  }));
  const items = [...todoItems, ...taskItems];
  const total = items.length;
  if (total === 0) return null;
  const done = items.filter((i) => i.status === "done").length;
  const in_progress = items.filter((i) => i.status === "in_progress").length;
  return { total, done, in_progress, open: total - done - in_progress, items };
}
