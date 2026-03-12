import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as crypto from "crypto";
import { SyncService } from "./syncService.js";
import { hasTmux } from "./tmux.js";

const _execAsync = promisify(exec);
const execAsync: typeof _execAsync = (cmd, opts?) => _execAsync(cmd, { timeout: 10_000, ...opts as any });

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONCURRENCY = 2;

interface RunningTask {
  taskId: string;
  tmuxSession: string;
  startedAt: number;
  maxRuntimeMs: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

interface TaskSchedulerConfig {
  syncService: SyncService;
  config: { auth_token?: string; claude_args?: string; codex_args?: string };
  log: (msg: string, level?: "debug" | "info" | "warn" | "error") => void;
}

export class TaskScheduler {
  private daemonId: string;
  private syncService: SyncService;
  private config: TaskSchedulerConfig["config"];
  private log: TaskSchedulerConfig["log"];
  private running = new Map<string, RunningTask>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor({ syncService, config, log }: TaskSchedulerConfig) {
    this.daemonId = crypto.randomUUID();
    this.syncService = syncService;
    this.config = config;
    this.log = (msg, level) => log(`[TaskSched] ${msg}`, level);
  }

  start(): void {
    this.log(`Started with daemon_id=${this.daemonId.slice(0, 8)}, polling every ${POLL_INTERVAL_MS / 1000}s`);
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const task of this.running.values()) {
      clearInterval(task.heartbeatTimer);
    }
    this.running.clear();
    this.log("Stopped");
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.running.size >= MAX_CONCURRENCY) return;

    try {
      const dueTasks = await this.syncService.getDueTasks(MAX_CONCURRENCY - this.running.size);
      if (!dueTasks || dueTasks.length === 0) return;

      for (const task of dueTasks) {
        if (this.running.size >= MAX_CONCURRENCY) break;
        if (this.running.has(task._id)) continue;
        await this.executeTask(task);
      }
    } catch (err) {
      this.log(`Poll error: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }

  private async executeTask(task: any): Promise<void> {
    const claimed = await this.syncService.claimTask(task._id, this.daemonId);
    if (!claimed) {
      this.log(`Failed to claim task ${task._id} (already claimed?)`);
      return;
    }

    this.log(`Claimed task "${task.title}" (${task._id})`);

    const prompt = this.buildPrompt(task);
    const agentType = task.agent_type || "claude";
    const projectPath = task.project_path || process.env.HOME || "/tmp";
    const cwd = fs.existsSync(projectPath) ? projectPath : (process.env.HOME || "/tmp");
    const shortId = task._id.toString().slice(-6);
    const tmuxSession = `ct-${agentType}-${shortId}`;

    // Write prompt to temp file to avoid shell quoting issues with newlines
    const promptFile = `/tmp/codecast-task-${shortId}.txt`;
    fs.writeFileSync(promptFile, prompt);

    let args: string[] = [];
    if (agentType === "codex") {
      args.push("codex", `"$(cat ${promptFile})"`);
      const extraArgs = this.config.codex_args;
      if (extraArgs) {
        args.push(...extraArgs.split(/\s+/).filter(Boolean));
      }
      if (!args.some(a => a.includes("--full-auto") || a.includes("--ask-for-approval") || a.includes("--dangerously-bypass"))) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
    } else {
      args.push("claude", "-p", `"$(cat ${promptFile})"`, "--dangerously-skip-permissions");
      const extraArgs = this.config.claude_args;
      if (extraArgs) {
        const skip = new Set(["--chrome", "--dangerously-skip-permissions"]);
        const extra = extraArgs.split(/\s+/).filter(Boolean);
        for (const arg of extra) {
          if (!skip.has(arg) && !args.includes(arg)) args.push(arg);
        }
      }
    }

    const shellCmd = `unset CLAUDECODE; ${args.join(" ")}; rm -f ${promptFile}`;

    if (!hasTmux()) {
      this.log(`tmux not installed, cannot run task "${task.title}"`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, "tmux is not installed");
      return;
    }

    try {
      try { await execAsync(`tmux kill-session -t '${tmuxSession}' 2>/dev/null`); } catch {}
      await execAsync(`tmux new-session -d -s '${tmuxSession}' -c '${cwd}'`);
      await execAsync(`tmux send-keys -t '${tmuxSession}' ${JSON.stringify(shellCmd)} Enter`);
      this.log(`Spawned tmux session ${tmuxSession} for task "${task.title}"`);
    } catch (err) {
      this.log(`Failed to spawn tmux for task "${task.title}": ${err instanceof Error ? err.message : String(err)}`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, "Failed to spawn tmux session");
      return;
    }

    const heartbeatTimer = setInterval(async () => {
      const renewed = await this.syncService.renewTaskLease(task._id, this.daemonId);
      if (!renewed) {
        this.log(`Lease renewal failed for task ${task._id}, stopping monitor`);
        this.cleanupTask(task._id);
      }

      await this.checkTaskCompletion(task._id);
    }, HEARTBEAT_INTERVAL_MS);

    const maxRuntimeMs = task.max_runtime_ms || 10 * 60 * 1000;

    this.running.set(task._id, {
      taskId: task._id,
      tmuxSession,
      startedAt: Date.now(),
      maxRuntimeMs,
      heartbeatTimer,
    });
  }

  private async checkTaskCompletion(taskId: string): Promise<void> {
    const entry = this.running.get(taskId);
    if (!entry) return;

    // Check if tmux session still exists
    try {
      await execAsync(`tmux has-session -t '${entry.tmuxSession}' 2>/dev/null`);
    } catch {
      this.log(`tmux session ${entry.tmuxSession} ended for task ${taskId}`);
      await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent session ended");
      this.cleanupTask(taskId);
      return;
    }

    // Check max runtime
    const elapsed = Date.now() - entry.startedAt;
    if (elapsed > entry.maxRuntimeMs) {
      this.log(`Task ${taskId} exceeded max runtime (${entry.maxRuntimeMs}ms), killing`);
      try { await execAsync(`tmux kill-session -t '${entry.tmuxSession}'`); } catch {}
      await this.syncService.failTaskRun(taskId, this.daemonId, `Exceeded max runtime (${Math.round(entry.maxRuntimeMs / 60000)}min)`);
      this.cleanupTask(taskId);
      return;
    }

    // Detect if agent has exited (shell prompt visible)
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -p -J -t '${entry.tmuxSession}' -S -20 2>/dev/null`
      );
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1]?.trim() || "";
      if (lastLine.endsWith("$") || lastLine.endsWith("%") || lastLine.endsWith("#")) {
        this.log(`Task ${taskId} returned to shell prompt, cleaning up`);
        try { await execAsync(`tmux kill-session -t '${entry.tmuxSession}'`); } catch {}
        await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent exited");
        this.cleanupTask(taskId);
      }
    } catch {
      // Capture failed, will check again next heartbeat
    }
  }

  private cleanupTask(taskId: string): void {
    const entry = this.running.get(taskId);
    if (entry) {
      clearInterval(entry.heartbeatTimer);
      this.running.delete(taskId);
    }
  }

  private buildPrompt(task: any): string {
    const parts: string[] = [];

    parts.push(`[Codecast Task: ${task.title}]`);
    parts.push(`Task ID: ${task._id}`);
    parts.push(`Mode: ${task.mode || "propose"}`);
    parts.push("");
    parts.push(task.prompt);

    if (task.context_summary || task.last_run_summary) {
      parts.push("");
      parts.push("---");
    }

    if (task.context_summary) {
      const convId = task.originating_conversation_id;
      parts.push(`Context from originating session${convId ? ` (${convId.toString().slice(-8)})` : ""}:`);
      parts.push(task.context_summary);
    }

    if (task.last_run_summary) {
      const ago = task.last_run_at
        ? formatTimeAgo(Date.now() - task.last_run_at)
        : "unknown time ago";
      parts.push("");
      parts.push(`Previous run (${ago}):`);
      parts.push(task.last_run_summary);
    }

    parts.push("");
    parts.push("---");
    parts.push("Instructions:");
    parts.push(`- When done, run: cast task complete ${task._id} --summary "brief description of what was done"`);
    parts.push('- To schedule follow-up: cast task add "..." --in <time>');
    if (task.originating_conversation_id) {
      parts.push(`- Run \`cast read ${task.originating_conversation_id}\` for full original context`);
    }

    return parts.join("\n");
  }

  getRunningCount(): number {
    return this.running.size;
  }
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
