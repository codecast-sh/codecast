import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as crypto from "crypto";
import { SyncService } from "./syncService.js";
import { hasTmux } from "./tmux.js";
import { deviceId, isRemoteDevice } from "./remote/device.js";
import { spawnAgentTmux } from "./delivery/spawnAgentTmux.js";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
const _execAsync = promisify(exec);
const execAsync = (cmd: string, opts?: Record<string, any>) => _execAsync(cmd, { timeout: 10_000, env: { ...process.env, PATH: ENRICHED_PATH }, ...opts });

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONCURRENCY = 2;

interface RunningTask {
  taskId: string;
  tmuxSession: string;
  startedAt: number;
  maxRuntimeMs: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
  // Claude session UUID assigned to this run via `--session-id`, so completion
  // can link the run's conversation back to the task. Undefined for codex runs.
  runSessionUuid?: string;
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
  private skipLogged = new Set<string>();

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
      // Over-fetch so ineligible tasks (wrong machine) can't shadow eligible
      // ones sitting just past the concurrency-sized window.
      const dueTasks = await this.syncService.getDueTasks(10);
      if (!dueTasks || dueTasks.length === 0) return;

      for (const task of dueTasks) {
        if (this.running.size >= MAX_CONCURRENCY) break;
        if (this.running.has(task._id)) continue;
        if (!this.canServeTask(task)) continue;
        await this.executeTask(task);
      }
    } catch (err) {
      this.log(`Poll error: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }

  /**
   * Device affinity, checked BEFORE claiming: an ineligible daemon must leave
   * the task due so the right Mac claims it on wake (the queue-until-wake rule
   * from deviceRouting.pickOwnerDevice). The old behavior — claim, then spawn
   * in $HOME when the checkout is missing — ran apply-mode tasks blind on the
   * always-awake remote (same bug class as ct-32728/ct-36594).
   *
   * Primary rule: a task runs ONLY on the device that created it
   * (created_device_id, stamped by `cast schedule add`). Web-created and
   * legacy tasks carry no device id and fall back to checkout existence.
   */
  private canServeTask(task: any): boolean {
    let eligible: boolean;
    let reason: string;
    if (task.created_device_id) {
      eligible = task.created_device_id === deviceId();
      reason = `created on device ${task.created_device_id.slice(0, 8)}, this is ${deviceId().slice(0, 8)}`;
    } else if (task.originating_conversation_id) {
      // Injection tasks (--context current) only enqueue a message; the
      // server's device routing delivers it, so any daemon can enqueue.
      eligible = true;
      reason = "";
    } else if (task.project_path) {
      // Spawn tasks bind to a checkout: only a device that has it may claim.
      eligible = fs.existsSync(task.project_path);
      reason = `project_path ${task.project_path} does not exist on this device`;
    } else {
      // Path-less tasks run in $HOME — fine on the user's own Mac, wrong on a
      // remote box (mirrors the daemon's blank-project start_session gate).
      eligible = !isRemoteDevice();
      reason = "path-less task on a remote device";
    }
    if (!eligible && !this.skipLogged.has(task._id)) {
      this.skipLogged.add(task._id);
      this.log(`Skipping task "${task.title}" (${task._id}): ${reason} — leaving it due for an eligible device`);
    }
    return eligible;
  }

  private async executeTask(task: any): Promise<void> {
    const claimed = await this.syncService.claimTask(task._id, this.daemonId);
    if (!claimed) {
      this.log(`Failed to claim task ${task._id} (already claimed?)`);
      return;
    }

    this.log(`Claimed task "${task.title}" (${task._id})`);

    // --context current path: inject the prompt into the originating conversation
    // instead of spawning a fresh agent. The daemon's pending_messages subscription
    // + autoResumeSession handle both live (tmux-inject) and stopped (resurrect
    // then inject) sessions uniformly.
    if (task.originating_conversation_id) {
      try {
        const safeTitle = (task.title || "").replace(/"/g, "&quot;");
        const wrappedPrompt = `<scheduled-task title="${safeTitle}" task-id="${task._id}">${task.prompt}</scheduled-task>`;
        // The injected message becomes a user-row in the messages table once
        // the agent's JSONL is parsed. The UI detects the <scheduled-task>
        // wrapper and renders it as a ScheduledTaskBlock, so we must not
        // also write a system-subtype row here -- that would double-render.
        await this.syncService.sendMessageToSession(task.originating_conversation_id, wrappedPrompt);
        this.log(`Injected prompt into conversation ${task.originating_conversation_id.toString().slice(-8)} for task "${task.title}"`);
        await this.syncService.completeTaskRun(
          task._id,
          this.daemonId,
          undefined,
          task.originating_conversation_id,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Failed to inject into conversation for task "${task.title}": ${msg}`, "error");
        await this.syncService.failTaskRun(task._id, this.daemonId, `Injection failed: ${msg}`);
      }
      return;
    }

    const prompt = this.buildPrompt(task);
    const agentType = task.agent_type || "claude";
    // canServeTask gated the claim; this catches the checkout vanishing between
    // poll and spawn. Fail loudly — never fall back to $HOME, which runs the
    // agent (possibly apply-mode) blind in an unrelated directory.
    if (task.project_path && !fs.existsSync(task.project_path)) {
      this.log(`project_path ${task.project_path} missing at spawn time for task "${task.title}"`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, `project_path not found on this device: ${task.project_path}`);
      return;
    }
    const cwd = task.project_path || process.env.HOME || "/tmp";
    const shortId = task._id.toString().slice(-6);
    const tmuxSession = `ct-${agentType}-${shortId}`;

    // Write prompt to temp file to avoid shell quoting issues with newlines
    const promptFile = `/tmp/codecast-task-${shortId}.txt`;
    fs.writeFileSync(promptFile, prompt);

    // Build agent command args (will be passed to the script, which quotes them via "$(cat promptFile)")
    let extraAgentArgs: string[] = [];
    let agentBin: string;
    // Assigned for claude runs so completion can link the run's conversation back
    // to the task. `claude --session-id <uuid>` writes <uuid>.jsonl, which the
    // daemon syncs into a conversation keyed by session_id=<uuid>. Left undefined
    // for codex (different session scheme).
    let runSessionUuid: string | undefined;
    if (agentType === "codex") {
      agentBin = "codex";
      const extraArgs = this.config.codex_args;
      if (extraArgs) {
        extraAgentArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
      }
      if (!extraAgentArgs.some(a => a.includes("--full-auto") || a.includes("--ask-for-approval") || a.includes("--dangerously-bypass"))) {
        extraAgentArgs.push("--dangerously-bypass-approvals-and-sandbox");
      }
    } else {
      agentBin = "claude";
      extraAgentArgs.push("--dangerously-skip-permissions");
      const extraArgs = this.config.claude_args;
      if (extraArgs) {
        const skip = new Set(["--chrome", "--dangerously-skip-permissions"]);
        const extra = extraArgs.split(/\s+/).filter(Boolean);
        for (const arg of extra) {
          if (!skip.has(arg) && !extraAgentArgs.includes(arg)) extraAgentArgs.push(arg);
        }
      }
      // Only auto-assign if the operator didn't pin one via claude_args.
      if (!extraAgentArgs.includes("--session-id")) {
        runSessionUuid = crypto.randomUUID();
        extraAgentArgs.push("--session-id", runSessionUuid);
      }
    }

    // Write a shell script so the target shell (inside tmux) handles all quoting/expansion,
    // rather than relying on the outer exec shell to expand $(cat ...). This avoids issues
    // when the prompt contains characters that would be misinterpreted by the shell
    // (quotes, newlines, etc.) after being expanded by the outer shell.
    const scriptFile = `/tmp/codecast-task-${shortId}.sh`;
    const agentInvocation = agentType === "codex"
      ? `${agentBin} "$(cat ${promptFile})" ${extraAgentArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`
      : `${agentBin} -p "$(cat ${promptFile})" ${extraAgentArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
    const scriptBody = [
      "#!/bin/bash",
      "unset CLAUDECODE",
      "unset ANTHROPIC_API_KEY",
      // Hand the run's session UUID to the agent so a self-report via
      // `cast schedule complete` can link the run's conversation back to the task
      // (the agent's own session_id IS this UUID, assigned via --session-id above).
      ...(runSessionUuid ? [`export CODECAST_RUN_SESSION_UUID='${runSessionUuid}'`] : []),
      agentInvocation,
      `rm -f ${promptFile} ${scriptFile}`,
      "",
    ].join("\n");
    fs.writeFileSync(scriptFile, scriptBody, { mode: 0o755 });

    if (!hasTmux()) {
      this.log(`tmux not installed, cannot run task "${task.title}"`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, "tmux is not installed");
      return;
    }

    // Spawn through the shared delivery primitive: it re-validates the cwd (the
    // recorded-but-absent refusal above is the first line of defense), and runs
    // tmux via arg-array execFile with `send-keys -l`, so nothing the task
    // carries is ever shell-interpolated by the daemon.
    //
    // We deliberately DON'T pass `sessionId`: a task tmux name is `ct-<agent>-<id>`,
    // which the daemon's warm-restart sweep already picks up by name. Tagging it
    // with `@codecast_session_id` would route it into managed-session registration
    // with a TASKS-table id as if it were a session id. Only `@codecast_agent_type`
    // is stamped, which is harmless.
    const spawn = await spawnAgentTmux(
      {
        tmuxSession,
        cwd,
        agentType: agentType === "codex" ? "codex" : "claude",
        command: `bash ${scriptFile}`,
      },
      { config: this.config, log: this.log },
    );
    if (!spawn.ok) {
      this.log(`Failed to spawn tmux for task "${task.title}": ${spawn.reason}`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, `Failed to spawn tmux session: ${spawn.reason}`);
      return;
    }
    this.log(`Spawned tmux session ${tmuxSession} for task "${task.title}"`);

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
      runSessionUuid,
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
      await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent session ended", undefined, entry.runSessionUuid);
      this.cleanupTask(taskId);
      return;
    }

    // Check max runtime
    const elapsed = Date.now() - entry.startedAt;
    if (elapsed > entry.maxRuntimeMs) {
      this.log(`Task ${taskId} exceeded max runtime (${entry.maxRuntimeMs}ms), killing`);
      try { await execAsync(`tmux kill-session -t '${entry.tmuxSession}'`); } catch {}
      await this.syncService.failTaskRun(taskId, this.daemonId, `Exceeded max runtime (${Math.round(entry.maxRuntimeMs / 60000)}min)`, entry.runSessionUuid);
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
        await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent exited", undefined, entry.runSessionUuid);
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
    if (task.target_conversation_id) {
      parts.push(`- Your summary will be posted as a message in the originating conversation thread.`);
      parts.push(`- When done, run: cast schedule complete ${task._id} --summary "your full response to post in the thread"`);
      parts.push(`- Write the summary as if you are replying directly to the user in their conversation.`);
    } else {
      parts.push(`- When done, run: cast schedule complete ${task._id} --summary "brief description of what was done"`);
    }
    parts.push('- To schedule follow-up: cast schedule add "..." --in <time>');
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
