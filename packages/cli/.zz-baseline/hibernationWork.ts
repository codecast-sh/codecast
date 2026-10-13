import { openTaskStart } from "./backgroundTaskStart.js";

type Block = { type?: string; id?: string; name?: string; input?: { run_in_background?: unknown }; tool_use_id?: string; content?: unknown; text?: string };
type Row = { type?: string; sessionId?: string; operation?: string; content?: unknown; attachment?: { prompt?: unknown }; message?: { content?: unknown } };

export class HibernationWorkScan {
  private pending = new Set<string>();
  private open = new Set<string>();
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
        if (block.name === "Agent" || block.name === "Task") this.unknown = true;
        if (block.name === "Monitor" || block.name === "Workflow" || block.input?.run_in_background) {
          if (!block.id || !["Bash", "Monitor", "Workflow"].includes(block.name ?? "")) this.unknown = true;
          else this.pending.add(block.id);
        }
      }
      if (row.type === "user" && block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
          ? block.content.map((part: { text?: string }) => part?.text ?? "").join("\n") : "";
        const started = openTaskStart(text);
        if (started) {
          this.open.add(started.id);
          if (block.tool_use_id) this.pending.delete(block.tool_use_id);
        }
      }
      if (row.type === "user" && block.type === "text") this.completed(block.text);
    }
  }

  reason(): string | null {
    if (this.unknown || this.pending.size > 0) return "background-work-unproven";
    return this.open.size > 0 ? "open-background-work" : null;
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
