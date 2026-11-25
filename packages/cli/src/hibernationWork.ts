import { openTaskStart } from "./backgroundTaskStart.js";

type Block = { type?: string; id?: string; name?: string; input?: { run_in_background?: unknown; task_id?: unknown }; tool_use_id?: string; content?: unknown; text?: string; is_error?: unknown };
type Row = { type?: string; sessionId?: string; timestamp?: unknown; operation?: string; content?: unknown; attachment?: { prompt?: unknown }; message?: { content?: unknown }; toolUseResult?: unknown };

export class HibernationWorkScan {
  private pending = new Set<string>();
  private open = new Set<string>();
  /** Agent and Task call ids. */
  private agentCalls = new Set<string>();
  /** SendMessage call ids: a reply that resumes an agent opens it. */
  private sends = new Set<string>();
  /** Teammates spawned and not yet shut down: agent id (or `name:<name>`) to name. */
  private teammates = new Map<string, string>();
  /** TaskStop call id to the task it asked to stop. */
  private stops = new Map<string, string>();
  private unknown = false;

  /**
   * `processStartMs` is when the agent's current process started. Work a row
   * dated before it started belongs to an earlier process and never refuses:
   * agents, teammates and workflow runs lived inside that process and died
   * with it, and its Bash and Monitor jobs either died too or were orphaned.
   * An orphan the park would reach makes parkPlanRefusal refuse
   * (park-reaches-beyond-agent); one it would not reach keeps running.
   */
  constructor(private sessionId: string, private processStartMs = -Infinity) {}

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
    // A row without a readable date counts as this process's.
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const earlierProcess = at < this.processStartMs;
    const content = row.message?.content;
    if (row.type === "user" && typeof content === "string") this.completed(content);
    if (!Array.isArray(content)) return;
    const results = (content as Block[]).filter(block => block?.type === "tool_result").length;
    for (const block of content as Block[]) {
      if (!block || typeof block !== "object") continue;
      if (row.type === "assistant" && block.type === "tool_use") {
        // An Agent call is pending until an answer says what became of it. An
        // async launch notice opens the agent until a notification under its id
        // says it ended. A teammate's "Spawned successfully" starts a teammate,
        // which keeps the session awake until it shuts down: it runs inside
        // this process, waits on its mailbox, and a resume does not bring it
        // back. A completion (a <usage> block, or the result marked completed)
        // or a failed call settles it. Any other answer, such as a foreground
        // agent sent to the background, stays unproven.
        const agent = block.name === "Agent" || block.name === "Task";
        if (!earlierProcess && (agent || block.name === "Monitor" || block.name === "Workflow" || block.input?.run_in_background)) {
          if (!block.id || !(agent || ["Bash", "Monitor", "Workflow"].includes(block.name ?? ""))) this.unknown = true;
          else {
            this.pending.add(block.id);
            if (agent) this.agentCalls.add(block.id);
          }
        }
        if (block.name === "SendMessage" && block.id) this.sends.add(block.id);
        if (block.name === "TaskStop" && block.id && typeof block.input?.task_id === "string") this.stops.set(block.id, block.input.task_id);
      }
      if (row.type === "user" && block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
          ? block.content.map((part: { text?: string }) => part?.text ?? "").join("\n") : "";
        const started = openTaskStart(text);
        if (started && !earlierProcess) this.open.add(started.id);
        // The row's toolUseResult describes its one tool result.
        const toolUseResult = results === 1 && row.toolUseResult && typeof row.toolUseResult === "object" ? row.toolUseResult as Record<string, unknown> : undefined;
        let settled = false;
        if (block.tool_use_id && this.agentCalls.has(block.tool_use_id) && !started) {
          const spawned = text.match(/^\s*Spawned successfully\b/) && text.match(/^name: (\S+)$/m)?.[1];
          if (spawned && !earlierProcess) this.teammates.set(text.match(/^agent_id: (\S+)$/m)?.[1] ?? `name:${spawned}`, spawned);
          settled = !!spawned || block.is_error === true || toolUseResult?.status === "completed" || /<usage>[\s\S]*<\/usage>\s*$/.test(text);
          // Any other answer that names the agent (a foreground agent sent to
          // the background) leaves it running: open until its notification.
          const agentId = typeof toolUseResult?.agentId === "string" && toolUseResult.agentId ? toolUseResult.agentId : text.match(/^agentId: (\S+)/m)?.[1];
          if (!settled && agentId) {
            if (!earlierProcess) this.open.add(agentId);
            settled = true;
          }
        }
        // A Bash, Monitor or Workflow call answered with anything but a launch
        // notice (an error, a refusal) started nothing to wait on. Had it started
        // something under a notice this scan cannot read, a command is caught by
        // the process checks and a workflow run by the quiet window on its
        // transcripts under subagents/.
        if (block.tool_use_id && !this.agentCalls.has(block.tool_use_id)) settled = true;
        if (block.tool_use_id && (started || settled)) this.pending.delete(block.tool_use_id);
        // SendMessage to a finished agent resumes it, in this process, until a
        // notification under its id says it ended.
        if (block.tool_use_id && this.sends.has(block.tool_use_id) && !earlierProcess) {
          const resumed = this.resumedAgent(text, toolUseResult);
          if (resumed) this.open.add(resumed);
        }
        // A stopped task gets no notification: Claude Code's confirmation is
        // the TaskStop result itself (128 stops in this Mac's transcripts on
        // 2026-11-01, 6 followed by a notification).
        const stopped = block.tool_use_id ? this.stops.get(block.tool_use_id) : undefined;
        if (stopped && text.includes(`Successfully stopped task: ${stopped}`)) this.ended(stopped);
      }
      if (row.type === "user" && block.type === "text") this.completed(block.text);
    }
  }

  reason(): string | null {
    if (this.unknown || this.pending.size > 0) return "background-work-unproven";
    if (this.teammates.size > 0) return "team-active";
    return this.open.size > 0 ? "open-background-work" : null;
  }

  /**
   * The agent a SendMessage reply resumed, by the id its completion notice
   * carries: a field that holds it, else the reply's own token when that is a
   * (short) agent id, which the notice's id starts with. A reply that names
   * the agent only by its name opens nothing here, since no notice carries a
   * name and it would stay open for the life of the process. The agent writes
   * its transcript under subagents/, so the daemon's quiet window on that
   * folder covers it while it runs.
   */
  private resumedAgent(text: string, toolUseResult: Record<string, unknown> | undefined): string | null {
    let reply: { message?: unknown; resumedAgentId?: unknown; revivedAgentId?: unknown; pin?: { id?: unknown } } | null = null;
    try { reply = JSON.parse(text); } catch { return null; }
    const token = typeof reply?.message === "string" ? reply.message.match(/^Resuming agent (\S+)/)?.[1] : undefined;
    if (!token) return null;
    for (const id of [reply!.resumedAgentId, reply!.revivedAgentId, toolUseResult?.revivedAgentId, toolUseResult?.resumedAgentId, reply!.pin?.id]) {
      if (typeof id === "string" && id) return id;
    }
    return /^a[0-9a-f]{6,}$/.test(token) ? token : null;
  }

  /** Close the task under `taskId`, and any work opened under a prefix of it (a resume reply can name an agent by a short id). */
  private ended(taskId: string): void {
    for (const id of this.open) if (taskId === id || taskId.startsWith(id)) this.open.delete(id);
    this.teammates.delete(taskId);
  }

  private completed(value: unknown): void {
    if (typeof value !== "string") return;
    // A teammate ends when it approves a shutdown: its shutdown_response with
    // approve true arrives as a message from it.
    for (const [, from, body] of value.matchAll(/<teammate-message teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g)) {
      let message: { type?: unknown; approve?: unknown } | null = null;
      try { message = JSON.parse(body.trim()); } catch {}
      if (message?.type !== "shutdown_response" || message.approve !== true) continue;
      for (const [id, name] of this.teammates) if (name === from) this.teammates.delete(id);
    }
    const text = value.trim();
    const notifications = [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)];
    if (notifications.map(match => match[0]).join("").replace(/\s/g, "") !== text.replace(/\s/g, "")) return;
    for (const [, notification] of notifications) {
      const statuses = [...notification.matchAll(/<status>([^<]+)<\/status>/g)];
      const terminal = statuses.length === 1
        ? ["completed", "failed", "stopped", "killed"].includes(statuses[0][1].trim())
        // A Monitor that runs out of time ends with an event and no status:
        // "[Monitor expired after 30m with no events delivered. Re-arm it…]"
        // or "[Monitor timed out — re-arm if needed.]".
        // Any other status-less event is a line of the monitor's own output.
        : statuses.length === 0 && /<event>\s*\[Monitor (?:expired|timed out)\b/.test(notification);
      if (!terminal) continue;
      for (const match of notification.matchAll(/<task-id>([^<]+)<\/task-id>/g)) this.ended(match[1].trim());
    }
  }
}
