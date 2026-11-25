// What a language server is doing, as one state a status chip can show:
// the connection (transport.ts) folded with the server's own work-done
// progress ($/progress begin/report/end). Pure, so the chip and its tests read
// the same machine.

import type { LspStatus } from "./transport";

export type LspChipStatus =
  | "idle" // no client yet for this language
  | "starting"
  | "indexing" // ready, with server work in progress
  | "ready"
  | "unresponsive" // ready, but a request went unanswered and nothing else came back
  | "restarting"
  | "unavailable"
  | "crashed"
  | "offline"
  | "off"; // large-file mode or no server for the language

export interface ProgressTask {
  title: string;
  message?: string;
  percentage?: number;
}

export type ProgressTasks = ReadonlyMap<string, ProgressTask>;

type ProgressValue =
  | { kind: "begin"; title: string; message?: string; percentage?: number }
  | { kind: "report"; message?: string; percentage?: number }
  | { kind: "end"; message?: string };

/** Apply one $/progress notification. Returns the same map when nothing changed. */
export function applyProgress(tasks: ProgressTasks, params: { token: string | number; value: ProgressValue }): ProgressTasks {
  const key = String(params?.token);
  const v = params?.value;
  if (!v || typeof v !== "object") return tasks;
  const next = new Map(tasks);
  if (v.kind === "begin") next.set(key, { title: v.title, message: v.message, percentage: v.percentage });
  else if (v.kind === "report") {
    const cur = tasks.get(key);
    if (!cur) return tasks;
    next.set(key, { ...cur, message: v.message ?? cur.message, percentage: v.percentage ?? cur.percentage });
  } else if (v.kind === "end") {
    if (!tasks.has(key)) return tasks;
    next.delete(key);
  } else return tasks;
  return next;
}

/** The chip's status from the connection and the server's open tasks. */
export function chipStatus(connection: LspStatus | "idle", tasks: ProgressTasks, unresponsive = false): LspChipStatus {
  if (connection === "ready" && unresponsive) return "unresponsive";
  if (connection === "ready") return tasks.size > 0 ? "indexing" : "ready";
  return connection;
}

/** The task worth showing: the one with a percentage, else the newest. */
export function leadTask(tasks: ProgressTasks): ProgressTask | null {
  let lead: ProgressTask | null = null;
  for (const t of tasks.values()) if (!lead || (t.percentage !== undefined && lead.percentage === undefined)) lead = t;
  return lead;
}

/** A few characters for the chip beside the server name. */
export function chipDetail(status: LspChipStatus, tasks: ProgressTasks): string {
  switch (status) {
    case "indexing": {
      const t = leadTask(tasks);
      return t?.percentage !== undefined ? `${Math.round(t.percentage)}%` : "indexing";
    }
    case "starting":
      return "starting";
    case "restarting":
      return "restarting";
    case "unresponsive":
      return "not responding";
    case "unavailable":
      return "not installed";
    case "crashed":
      return "crashed";
    case "offline":
      return "offline";
    case "off":
      return "off";
    default:
      return "";
  }
}
