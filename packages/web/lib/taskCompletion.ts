import type { PendingEntry } from "../store/syncProtocol";

export const COMPLETION_WINDOWS = [
  { key: "1d", label: "Completed in last 24 hours", days: 1 },
  { key: "7d", label: "Completed in last 7 days", days: 7 },
  { key: "30d", label: "Completed in last 30 days", days: 30 },
];

export function completionWindow(value: string | null | undefined): string {
  return COMPLETION_WINDOWS.find((option) => option.key === value)?.key ?? "";
}

let lastPending: Record<string, PendingEntry> | undefined;
let lastSignature = "";

export function pendingTaskCompletionsSig(pending: Record<string, PendingEntry>): string {
  if (pending === lastPending) return lastSignature;
  lastPending = pending;
  lastSignature = Object.entries(pending)
    .filter(([key, entry]) => key.startsWith("tasks:") && key.endsWith(":status") && entry.type === "field" && entry.value === "done")
    .map(([key, entry]) => `${key}:${entry.ts}`)
    .join("|");
  return lastSignature;
}

export function filterTasksByCompletion<T extends { _id: string; status: string; closed_at?: number }>(
  tasks: T[],
  window: string,
  now: number,
  pending: Record<string, PendingEntry> = {},
): T[] {
  const days = COMPLETION_WINDOWS.find((option) => option.key === window)?.days;
  if (!days) return tasks;
  const since = now - days * 86_400_000;
  return tasks.filter((task) => {
    if (task.status !== "done") return false;
    const statusWrite = pending[`tasks:${task._id}:status`];
    const completedAt = statusWrite?.type === "field" && statusWrite.value === "done" && statusWrite.ts !== undefined
      ? statusWrite.ts
      : task.closed_at;
    return completedAt !== undefined && completedAt >= since && completedAt <= now;
  });
}
