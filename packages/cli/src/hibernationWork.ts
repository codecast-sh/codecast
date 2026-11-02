import { openTaskStart } from "./backgroundTaskStart.js";

type Block = { type?: string; id?: string; name?: string; input?: { run_in_background?: unknown; task_id?: unknown }; tool_use_id?: string; content?: unknown; text?: string };
type Row = { type?: string; sessionId?: string; operation?: string; content?: unknown; attachment?: { prompt?: unknown }; message?: { content?: unknown } };

export class HibernationWorkScan {
  private pending = new Set<string>();
  private open = new Set<string>();
  /** Every agent id a launch notice named, finished or not. */
  private agents = new Set<string>();
  /** TaskStop call id to the task it asked to stop. */
  private stops = new Map<string, string>();
  private unknown = false;

  constructor(private sessionId: string) {}

  consume(row: Row): void {
    if (row.sessionId && row.sessionId !== this.sessionId) return;
    if (row.type === "queue-operation") {
      if (row.operation === "remove") this.completed(row.content);
      return;
    }
    if (row.type === "attachment") {
      this.completed(row.attachment?.prompt);
      return;
    }
    if (row.type !== "user" && row.type !== "assistant") return;
    const content = row.message?.content;
    if (row.type === "user" && typeof content === "string") this.completed(content);
    if (!Array.isArray(content)) return;
    for (const block of content as Block[]) {
      if (!block || typeof block !== "object") continue;
      if (row.type === "assistant" && block.type === "tool_use") {
        // An Agent call is open until its launch notice names the agent and a
        // notification under that id says it ended. Any other answer (a
        // teammate's "Spawned successfully", which no notification ever ends)
        // leaves the call pending, so the session stays unproven.
        const agent = block.name === "Agent" || block.name === "Task";
        if (agent || block.name === "Monitor" || block.name === "Workflow" || block.input?.run_in_background) {
          if (!block.id || !(agent || ["Bash", "Monitor", "Workflow"].includes(block.name ?? ""))) this.unknown = true;
          else this.pending.add(block.id);
        }
        if (block.name === "TaskStop" && block.id && typeof block.input?.task_id === "string") this.stops.set(block.id, block.input.task_id);
      }
      if (row.type === "user" && block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
          ? block.content.map((part: { text?: string }) => part?.text ?? "").join("\n") : "";
        const started = openTaskStart(text);
        if (started) {
          this.open.add(started.id);
          if (started.kind === "agent") this.agents.add(started.id);
          if (block.tool_use_id) this.pending.delete(block.tool_use_id);
        }
        // A stopped task gets no notification: Claude Code's confirmation is
        // the TaskStop result itself (128 stops in this Mac's transcripts on
        // 2026-11-01, 6 followed by a notification).
        const stopped = block.tool_use_id ? this.stops.get(block.tool_use_id) : undefined;
        if (stopped && text.includes(`Successfully stopped task: ${stopped}`)) this.open.delete(stopped);
      }
      if (row.type === "user" && block.type === "text") this.completed(block.text);
    }
  }

  reason(): string | null {
    if (this.unknown || this.pending.size > 0) return "background-work-unproven";
    return this.open.size > 0 ? "open-background-work" : null;
  }

  /** True when this agent's launch and its end are both in the transcript. */
  finishedAgent(id: string): boolean {
    return this.agents.has(id) && !this.open.has(id);
  }

  private completed(value: unknown): void {
    if (typeof value !== "string") return;
    const text = value.trim();
    const notifications = [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)];
    if (notifications.map(match => match[0]).join("").replace(/\s/g, "") !== text.replace(/\s/g, "")) return;
    for (const [, notification] of notifications) {
      const statuses = [...notification.matchAll(/<status>([^<]+)<\/status>/g)];
      if (statuses.length !== 1 || !["completed", "failed", "stopped", "killed"].includes(statuses[0][1].trim())) continue;
      for (const match of notification.matchAll(/<task-id>([^<]+)<\/task-id>/g)) this.open.delete(match[1].trim());
    }
  }
}
