import { exec } from "./proc.js";
import { codecastPath } from "./codecastDir.js";
import { promisify } from "util";
import * as fs from "fs";
import * as crypto from "crypto";
import { SyncService } from "./syncService.js";
import { hasTmux, isTmuxSessionMissingError, tmuxRunAsync } from "./tmux.js";
import { deviceId, isRemoteDevice } from "./remote/device.js";
import { spawnAgentTmux } from "./delivery/spawnAgentTmux.js";
import { launchTokenLedger } from "./launchToken.js";
import { launchAccountPrefix } from "./ccAccounts.js";
import { type Config, getAgentArgs } from "./config/types.js";
import { appendModelEffortFlags, resolvePrintModelAlias } from "./launchCommand.js";
import { SAFE_MODE_DENY_RULES, SAFE_MODE_MANDATE, definitionLaunchFlags } from "./agentLaunch.js";
import { resolveAgentLaunch, type AgentDefinitionSpec } from "@codecast/shared/contracts";
import { runTriggerPrecheck } from "./precheckRunner.js";
import { buildTriggerFrame } from "./triggerFrame.js";
import { describeTriggerPrecheckFailure, triggerPrecheckPassed, triggerFiringSource, triggerPrecheckApplies, triggerLifecycleInstructions, STASHED_RUN_NOTE } from "@codecast/shared/contracts";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
const _execAsync = promisify(exec);
const execAsync = (cmd: string, opts?: Record<string, any>) => _execAsync(cmd, { timeout: 10_000, env: { ...process.env, PATH: ENRICHED_PATH }, ...opts });

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONCURRENCY = 2;

// SAFE_MODE_MANDATE and SAFE_MODE_DENY_RULES live in agentLaunch.ts so a
// read only agent definition and a --safe trigger share one fence.

interface TrackedRun {
  taskId: string;
  tmuxSession: string;
  startedAt: number;
  maxRuntimeMs: number;
  // Claude session UUID assigned to this run via `--session-id`, so completion
  // can link the run's conversation back to the task. Undefined for codex runs.
  runSessionUuid?: string;
}

interface RunningTask extends TrackedRun {
  heartbeatTimer: ReturnType<typeof setInterval>;
}

// A run outlives the daemon that spawned it: its tmux pane survives a daemon
// restart, but the lease, the run table and the birth stamp all lived in this
// process. A restarted daemon that forgot them left the live run's conversation
// unstamped (a loose Needs Input card), let the lease lapse, and re-claimed the
// trigger into the same tmux name, killing the live run mid-command (tr-1162,
// 2026-09-29). So the scheduler's lease identity and its live runs are kept on
// disk, and a restarted daemon adopts them as its own.
interface SavedRuns {
  daemonId: string;
  runs: TrackedRun[];
}

function readSavedRuns(file: string): SavedRuns | null {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof saved?.daemonId !== "string" || !Array.isArray(saved.runs)) return null;
    return saved;
  } catch {
    return null;
  }
}

// Run session uuid -> trigger id for the runs this daemon has live, so the
// transcript sync creates a run's conversation already stamped as that
// trigger's run (conversations.createConversation agent_task_id), nested from
// its first instant rather than a loose card until linkRunConversation lands.
const liveRunTasks = new Map<string, string>();
export function triggerRunTaskId(sessionId: string): string | undefined {
  return liveRunTasks.get(sessionId);
}

interface TaskSchedulerConfig {
  syncService: SyncService;
  config: Config;
  log: (msg: string, level?: "debug" | "info" | "warn" | "error") => void;
  /** Where the lease identity and live runs are kept across restarts. */
  runsFile?: string;
}

/** The binary and flags a spawned run launches with. Pure — the safe-mode
 *  fences, the configured args, the per-trigger model pin and the session id
 *  are all decided here, so they are testable without tmux or a real agent. */
export function buildRunLaunch(
  task: any,
  config: Config,
  definition?: AgentDefinitionSpec,
): { agentBin: string; extraAgentArgs: string[]; runSessionUuid?: string } {
  // `cast trigger add --as`: the definition picks the client, model and effort
  // unless the trigger pinned them; its tool policy and prompt are appended
  // below through the same flags safe mode uses.
  const launch = resolveAgentLaunch(definition, {
    agent: task.agent_type === "codex" ? "codex" : task.agent_type ? "claude" : undefined,
    model: task.model || undefined,
  }, "claude");
  const agentType = launch.agent === "codex" ? "codex" : "claude";
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
    const extraArgs = getAgentArgs(config, "codex");
    if (extraArgs) {
      extraAgentArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
    }
    if (!extraAgentArgs.some(a => a.includes("--full-auto") || a.includes("--ask-for-approval") || a.includes("--dangerously-bypass"))) {
      extraAgentArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }
  } else {
    agentBin = "claude";
    extraAgentArgs.push("--dangerously-skip-permissions");
    // Safe mode is fenced in three layers, strongest first: the file-mutation
    // tools are removed outright; SAFE_MODE_DENY_RULES block the
    // state-changing shell commands (deny rules bind even under
    // --dangerously-skip-permissions); and the mandate covers what neither can
    // pattern-match. Anything not "apply" fences — fail closed on a bad value.
    if (task.mode !== "apply") {
      extraAgentArgs.push("--disallowedTools", "Edit", "Write", "NotebookEdit", ...SAFE_MODE_DENY_RULES);
      extraAgentArgs.push("--append-system-prompt", SAFE_MODE_MANDATE);
    }
    if (definition) {
      const flags = definitionLaunchFlags(launch, "claude");
      extraAgentArgs.push(...flags.args);
      if (flags.systemPrompt) extraAgentArgs.push("--system-prompt", flags.systemPrompt);
      else if (flags.appendSystemPrompt && (task.mode === "apply" || flags.appendSystemPrompt !== SAFE_MODE_MANDATE)) {
        extraAgentArgs.push("--append-system-prompt", flags.appendSystemPrompt);
      }
    }
    const extraArgs = getAgentArgs(config, "claude");
    if (extraArgs) {
      const skip = new Set(["--dangerously-skip-permissions"]);
      const extra = extraArgs.split(/\s+/).filter(Boolean);
      for (const arg of extra) {
        if (!skip.has(arg) && !extraAgentArgs.includes(arg)) extraAgentArgs.push(arg);
      }
    }
    // A run parked at a usage limit resumes its own session, so the firing
    // stays one conversation and the agent continues where it stopped.
    // Otherwise a fresh uuid — only auto-assigned if the operator didn't pin
    // one via agent_args.claude.
    if (task.parked_run_session_uuid) {
      const parked: string = task.parked_run_session_uuid;
      runSessionUuid = parked;
      extraAgentArgs.push("--resume", parked);
    } else if (!extraAgentArgs.includes("--session-id")) {
      runSessionUuid = crypto.randomUUID();
      extraAgentArgs.push("--session-id", runSessionUuid);
    }
  }

  // Per-trigger model pin (`cast trigger add --model`), resolved and appended
  // after the configured flags exactly like `cast spawn --model` — the last
  // occurrence wins in both CLIs, so the trigger's choice beats any default.
  const launchClient = agentType === "codex" ? "codex" : "claude";
  appendModelEffortFlags(extraAgentArgs, {
    agentType: launchClient,
    modelAlias: resolvePrintModelAlias(launchClient, launch.model),
    requestedEffort: launch.effort,
  });
  return { agentBin, extraAgentArgs, runSessionUuid };
}

/** The run's launch script. A shell script so the shell inside tmux does all
 *  quoting and expansion, rather than the daemon's exec shell expanding
 *  $(cat ...) after the prompt's quotes and newlines were already read.
 *
 *  A Claude run starts on the account every other codecast launch uses
 *  (`accountPrefix`, from launchAccountPrefix): the fleet store, which the
 *  daemon keeps on a live credential and moves on every account switch. A bare
 *  `claude` reads the machine's keychain login instead, which the daemon leaves
 *  alone and which can sit signed out for hours: every tr-1245 run from
 *  2026-10-03 19:39Z died on its first turn that way (ct-56748). */
export function buildRunScript(input: {
  agentType: "claude" | "codex";
  agentBin: string;
  extraAgentArgs: string[];
  promptFile: string;
  scriptFile: string;
  runSessionUuid?: string;
  accountPrefix?: string;
}): string {
  const { agentType, agentBin, extraAgentArgs, promptFile, scriptFile, runSessionUuid } = input;
  const quotedArgs = extraAgentArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const agentInvocation = agentType === "codex"
    ? `${agentBin} "$(cat ${promptFile})" ${quotedArgs}`
    : `${input.accountPrefix ?? ""}${agentBin} -p "$(cat ${promptFile})" ${quotedArgs}`;
  return [
    "#!/bin/bash",
    "unset CLAUDECODE",
    "unset ANTHROPIC_API_KEY",
    // Hand the run's session UUID to the agent so a self-report via
    // `cast trigger complete` can link the run's conversation back to the task
    // (the agent's own session_id IS this UUID, assigned via --session-id above).
    ...(runSessionUuid ? [`export CODECAST_RUN_SESSION_UUID='${runSessionUuid}'`] : []),
    agentInvocation,
    `rm -f ${promptFile} ${scriptFile}`,
    "",
  ].join("\n");
}

// A run is over when its pane's shell has no child process: the launch
// script and the agent under it are both gone, or the pane itself is. Read
// from the process tree, never from the prompt text: a prompt that ends in
// anything but $, % or # (this machine's ends in ":") left every finished run
// sitting until the 10 min cap, where it filed as "Exceeded max runtime" with
// its work done and cost a retry (tr-887, 2026-09-18). A tmux or pgrep
// failure answers "not yet"; the cap still bounds the run.
export async function runPaneFinished(
  tmuxSession: string,
  childrenOf: (pid: string) => Promise<string> = async (pid) =>
    (await execAsync(`pgrep -P ${pid}`).catch(() => ({ stdout: "" }))).stdout,
): Promise<boolean> {
  const panes = await tmuxRunAsync(["list-panes", "-t", tmuxSession, "-F", "#{pane_pid}"], { timeout: 3000 });
  if (panes.status !== 0) return isTmuxSessionMissingError(panes);
  const pids = panes.stdout.trim().split(/\s+/).filter(Boolean);
  if (pids.length === 0) return false;
  for (const pid of pids) {
    if ((await childrenOf(pid)).trim()) return false;
  }
  return true;
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
  private runsFile: string;
  private adoptable: TrackedRun[];

  constructor({ syncService, config, log, runsFile }: TaskSchedulerConfig) {
    this.runsFile = runsFile ?? codecastPath("trigger-runs.json");
    const saved = readSavedRuns(this.runsFile);
    this.daemonId = saved?.daemonId ?? crypto.randomUUID();
    this.adoptable = saved?.runs ?? [];
    this.syncService = syncService;
    this.config = config;
    this.log = (msg, level) => log(`[TaskSched] ${msg}`, level);
  }

  start(): void {
    this.log(`Started with daemon_id=${this.daemonId.slice(0, 8)}, polling every ${POLL_INTERVAL_MS / 1000}s`);
    // The first heartbeat renews the lease and settles a run whose pane ended
    // while no daemon was watching.
    for (const run of this.adoptable) {
      this.log(`Adopting run of task ${run.taskId} in ${run.tmuxSession}`);
      this.track(run);
    }
    this.adoptable = [];
    this.saveRuns();
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
   * (created_device_id, stamped by `cast trigger add`). Web-created and
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

    if (await this.precheckRefusedRun(task, claimed)) return;

    // --context current path: inject the prompt into the originating conversation
    // instead of spawning a fresh agent. The daemon's pending_messages subscription
    // + autoResumeSession handle both live (tmux-inject) and stopped (resurrect
    // then inject) sessions uniformly.
    if (task.originating_conversation_id) {
      try {
        const safeTitle = (task.title || "").replace(/"/g, "&quot;");
        // The injected prompt carries the task and NOTHING about permissions: an
        // inject run is just another turn in an already-running session, so the
        // rules that session was started with are the rules — inherited, not
        // restated. `mode` therefore governs SPAWNED runs only (the branch
        // below, where a fresh agent's toolset can actually be narrowed at
        // birth); on this path it is deliberately ignored.
        // Wake-time self-knowledge: a stashed session's agent must know nobody
        // is watching, and that its settle declaration is the only way back to
        // the human's eyes. Read fresh at injection (filing may have changed
        // since the last run); machine wakes only — an interactive turn means
        // the human is looking, and stale state is worse than none. Fails
        // open: unreadable filing → say nothing.
        // The server builds the frame every trigger path delivers (the role's
        // card, the trigger pill, the stashed note); the local wrap below
        // stands in only when it cannot answer (an older server).
        const serverFrame = await this.syncService.getInjectFrame?.(task._id.toString());
        const filing = serverFrame ? null : await this.syncService.getSessionFiling(task.originating_conversation_id.toString());
        const filingNote = filing === "stashed"
          ? STASHED_RUN_NOTE
          : "";
        const wrappedPrompt = serverFrame
          ?? `<scheduled-task title="${safeTitle}" task-id="${task._id}">${[task.prompt, triggerLifecycleInstructions(task)].filter(Boolean).join("\n\n")}${filingNote}</scheduled-task>`;
        // The injected message becomes a user-row in the messages table once
        // the agent's JSONL is parsed. The UI detects the <scheduled-task>
        // wrapper and renders it as a ScheduledTaskBlock, so we must not
        // also write a system-subtype row here -- that would double-render.
        // origin "scheduler": a machine wake must not clear the user's stash —
        // a stashed session keeps running out of the active queue.
        await this.syncService.sendMessageToSession(task.originating_conversation_id, wrappedPrompt, "scheduler");
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

    // The claimed row is current: an event that fired between the poll and
    // the claim is on it, not on the polled copy.
    const prompt = this.buildPrompt({ ...task, pending_events: claimed.pending_events ?? task.pending_events });
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

    let definition: AgentDefinitionSpec | undefined;
    if (task.agent_definition) {
      definition = (await this.syncService.resolveAgentDefinition(task.agent_definition)) ?? undefined;
      if (!definition) this.log(`agent definition "${task.agent_definition}" not found; running task "${task.title}" without it`, "warn");
    }
    const { agentBin, extraAgentArgs, runSessionUuid } = buildRunLaunch(task, this.config, definition);

    const scriptFile = `/tmp/codecast-task-${shortId}.sh`;
    const runAgent = agentType === "codex" ? "codex" : "claude";
    const scriptBody = buildRunScript({
      agentType: runAgent,
      agentBin,
      extraAgentArgs,
      promptFile,
      scriptFile,
      runSessionUuid,
      accountPrefix: runAgent === "claude" ? launchAccountPrefix(undefined, (msg) => this.log(msg, "warn")).prefix : undefined,
    });
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
        // Fences this pane's hook posts to this run: a previous run's agent left
        // alive in the same pane name reports for nothing (ct-49532).
        launchToken: launchTokenLedger().issue(tmuxSession),
      },
      { config: this.config, log: this.log },
    );
    if (!spawn.ok) {
      this.log(`Failed to spawn tmux for task "${task.title}": ${spawn.reason}`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, `Failed to spawn tmux session: ${spawn.reason}`);
      return;
    }
    this.log(`Spawned tmux session ${tmuxSession} for task "${task.title}"`);

    this.track({
      taskId: task._id,
      tmuxSession,
      startedAt: Date.now(),
      maxRuntimeMs: task.max_runtime_ms || 10 * 60 * 1000,
      runSessionUuid,
    });
  }

  private track(run: TrackedRun): void {
    const heartbeatTimer = setInterval(async () => {
      const renewed = await this.syncService.renewTaskLease(run.taskId, this.daemonId);
      if (!renewed) {
        this.log(`Lease renewal failed for task ${run.taskId}, stopping monitor`);
        this.cleanupTask(run.taskId);
      }

      await this.checkTaskCompletion(run.taskId);
    }, HEARTBEAT_INTERVAL_MS);

    this.running.set(run.taskId, { ...run, heartbeatTimer });
    this.saveRuns();

    // Link the run's conversation to the task as soon as it syncs (bounded
    // retries — the first JSONL write usually lands within seconds). This makes
    // the schedule strip/badge work DURING the run and folds the previous
    // completed run of a repeating schedule out of the inbox. completeTaskRun
    // backfills the link at run end if every attempt here loses the race.
    if (run.runSessionUuid) {
      liveRunTasks.set(run.runSessionUuid, run.taskId);
      this.scheduleRunLink(run.taskId, run.runSessionUuid);
    }
  }

  private saveRuns(): void {
    // A stopped scheduler leaves its runs on disk for the next daemon to adopt.
    if (this.stopped) return;
    const saved: SavedRuns = {
      daemonId: this.daemonId,
      runs: [...this.running.values()].map(({ heartbeatTimer: _timer, ...run }) => run),
    };
    try {
      fs.writeFileSync(this.runsFile, JSON.stringify(saved));
    } catch (err) {
      this.log(`Could not save live runs to ${this.runsFile}: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }

  /**
   * `cast trigger add --precheck "<shell command>"`: run the gate before
   * spending a session, and record a skipped run when it refuses. Returns true
   * when the caller must stop — no agent is spawned and nothing is injected.
   *
   * Event triggers ignore the precheck: a webhook already IS the evidence that
   * something changed, and re-deriving it from a shell command could only
   * disagree with the event that woke the trigger.
   *
   * The runner is fully async (precheckRunner.ts) so a 60s gate parks on a
   * timer rather than stalling the daemon's event loop.
   *
   * When the skip cannot be recorded the trigger still stops here, and its
   * lease expires into reclaimStaleTasks — the gate can never strand a trigger
   * in `running`.
   */
  private async precheckRefusedRun(task: any, claimed: any): Promise<boolean> {
    if (!task.precheck) return false;
    const source = claimed?.last_run_source ?? triggerFiringSource(task.schedule_type);
    if (!triggerPrecheckApplies(source)) return false;

    // The gate is an optimization, not a fence, so it only speaks where it can
    // speak truthfully. Run it somewhere else and "has this checkout moved?"
    // answers about the wrong directory — worse than not asking. The missing
    // checkout itself is already handled downstream (the spawn path fails
    // loudly; an inject run is delivered by the server, wherever it lives).
    const cwd = task.project_path || process.env.HOME;
    if (!cwd || !fs.existsSync(cwd)) {
      this.log(`Precheck for task "${task.title}" has no directory to run in (${task.project_path}) — running ungated`, "warn");
      return false;
    }
    const result = await runTriggerPrecheck({ command: task.precheck, cwd });
    if (triggerPrecheckPassed(result)) {
      this.log(`Precheck passed for task "${task.title}" in ${result.durationMs}ms`);
      return false;
    }

    const reason = describeTriggerPrecheckFailure(result);
    this.log(`Skipping ${source} run of task "${task.title}": ${reason}`);
    await this.syncService.skipTaskRun(task._id, this.daemonId, result, reason, source);
    return true;
  }

  // Bounded retry chain for linkRunConversation; standalone timers (not tied
  // to the RunningTask entry) so a fast run that completes before the first
  // attempt doesn't orphan the link — the mutation is idempotent either way.
  private scheduleRunLink(taskId: string, runSessionUuid: string, attempt = 0): void {
    const delaysMs = [10_000, 30_000, 90_000];
    if (attempt >= delaysMs.length) return;
    setTimeout(async () => {
      try {
        const result = await this.syncService.linkRunConversation(taskId, runSessionUuid);
        if (result.linked || !result.retry) return;
      } catch {
        // fall through to retry
      }
      this.scheduleRunLink(taskId, runSessionUuid, attempt + 1);
    }, delaysMs[attempt]);
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

    // Detect if the agent has exited: the pane's shell has nothing under it.
    if (await runPaneFinished(entry.tmuxSession)) {
      this.log(`Task ${taskId} returned to shell prompt, cleaning up`);
      try { await execAsync(`tmux kill-session -t '${entry.tmuxSession}'`); } catch {}
      await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent exited", undefined, entry.runSessionUuid);
      this.cleanupTask(taskId);
    }
  }

  private cleanupTask(taskId: string): void {
    const entry = this.running.get(taskId);
    if (entry) {
      clearInterval(entry.heartbeatTimer);
      if (entry.runSessionUuid) liveRunTasks.delete(entry.runSessionUuid);
      this.running.delete(taskId);
      this.saveRuns();
    }
  }

  private buildPrompt(task: any): string {
    return buildTriggerFrame(task, Date.now());
  }

  getRunningCount(): number {
    return this.running.size;
  }
}
