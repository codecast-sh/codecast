#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "bun:sqlite";
import { execSync, exec, spawn } from "child_process";
import { watch as chokidarWatch } from "chokidar";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { CursorTranscriptWatcher, type CursorTranscriptEvent } from "./cursorTranscriptWatcher.js";
import { CodexWatcher, type CodexSessionEvent } from "./codexWatcher.js";
import {
  choosePreferredCodexCandidate,
  hasCodexSessionFileOpen,
  isResumeInvocation,
  matchSingleFreshStartedConversation,
  matchStartedConversation,
} from "./sessionProcessMatcher.js";
import { GeminiWatcher, type GeminiSessionEvent } from "./geminiWatcher.js";
import { parseSessionFile, parseCodexSessionFile, parseGeminiSessionFile, parseCursorTranscriptFile, extractSlug, extractParentUuid, extractSummaryTitle, extractCwd, extractCodexCwd, extractGeminiProjectHash, detectCliFlags, type ParsedMessage } from "./parser.js";
import { extractMessagesFromCursorDb } from "./cursorProcessor.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { markSynced, getSyncRecord, findUnsyncedFiles, type SyncRecord } from "./syncLedger.js";
import { SyncService, AuthExpiredError } from "./syncService.js";
import { redactSecrets, maskToken } from "./redact.js";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";
import { InvalidateSync } from "./invalidateSync.js";
import { promisify } from "util";
import { detectPermissionPrompt } from "./permissionDetector.js";
import { handlePermissionRequest } from "./permissionHandler.js";
import { getVersion, performUpdate } from "./update.js";
import { performReconciliation, repairDiscrepancies } from "./reconciliation.js";
import { TaskScheduler } from "./taskScheduler.js";
import {
  fetchExport,
  generateClaudeCodeJsonl,
  generateCodexJsonl,
  writeClaudeCodeSession,
  writeCodexSession,
  chooseClaudeTailMessagesForTokenBudget,
} from "./jsonlGenerator.js";

const _execAsync = promisify(exec);
const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
const execAsync: typeof _execAsync = (cmd, opts?) => _execAsync(cmd, { ...opts as any, env: { ...process.env, PATH: ENRICHED_PATH, ...(opts as any)?.env } });

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const VERSION_FILE = path.join(CONFIG_DIR, "daemon.version");

interface Config {
  user_id?: string;
  team_id?: string;
  convex_url?: string;
  auth_token?: string;
  excluded_paths?: string;
  claude_args?: string;
  codex_args?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];
  agent_permission_modes?: {
    claude?: "default" | "bypass";
    codex?: "default" | "full_auto" | "bypass";
    gemini?: "default" | "bypass";
  };
}

function getPermissionFlags(agentType: "claude" | "codex" | "gemini", config?: Config | null): string | null {
  const modes = config?.agent_permission_modes;

  if (agentType === "claude") {
    if (modes?.claude === "bypass") return "--permission-mode bypassPermissions";
  } else if (agentType === "codex") {
    const existing = config?.codex_args || "";
    if (existing.includes("--full-auto") || existing.includes("--ask-for-approval") || existing.includes("--dangerously-bypass")) return null;
    if (modes?.codex === "full_auto") return "--full-auto";
    if (modes?.codex === "default") return null;
    // Default to bypass when no explicit config is set
    return "--dangerously-bypass-approvals-and-sandbox";
  } else if (agentType === "gemini") {
    // gemini flags TBD
  }

  return null;
}

interface ConversationCache {
  [sessionId: string]: string;
}

interface TitleCache {
  [sessionId: string]: string;
}

interface PendingMessages {
  [sessionId: string]: Array<{
    uuid?: string;
    role: "human" | "assistant" | "system";
    content: string;
    timestamp: number;
    filePath: string;
    fileSize: number;
    thinking?: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
    images?: Array<{ mediaType: string; data: string }>;
    subtype?: string;
  }>;
}

interface DaemonState {
  connected?: boolean;
  lastSyncTime?: number;
  pendingQueueSize?: number;
  timestamp?: number;
  authExpired?: boolean;
  authFailureCount?: number;
  lastWatchdogCheck?: number;
  watchdogRestarts?: number;
  lastHeartbeatTick?: number;
}

const AUTH_FAILURE_THRESHOLD = 5;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WATCHDOG_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_FLUSH_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_LOG_QUEUE_SIZE = 200;
const EVENT_LOOP_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
const EVENT_LOOP_LAG_THRESHOLD_MS = 60 * 1000; // 1 minute of lag = frozen
const HEARTBEAT_STALE_THRESHOLD_MS = 15 * 60 * 1000; // external watchdog: 15 min = deadlocked

type LogLevel = "debug" | "info" | "warn" | "error";

interface RemoteLog {
  level: LogLevel;
  message: string;
  metadata?: {
    session_id?: string;
    error_code?: string;
    stack?: string;
  };
  timestamp: number;
}

const remoteLogQueue: RemoteLog[] = [];
let syncServiceRef: SyncService | null = null;
let daemonVersion: string | undefined;
let activeConfig: Config | null = null;
const platform = process.platform;

const IDLE_TIMEOUT_MS = 2 * 60_000;
const IDLE_COOLDOWN_MS = 5 * 60_000;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastIdleNotification = new Map<string, number>();
const lastIdleNotifiedSize = new Map<string, number>();
const lastErrorNotification = new Map<string, number>();
const lastWorkingStatusSent = new Map<string, number>();
const WORKING_STATUS_THROTTLE_MS = 10_000;

type AgentStatus = "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected";
type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
const lastHookStatus = new Map<string, { status: AgentStatus; ts: number; permission_mode?: PermissionMode }>();
const AGENT_STATUS_DIR = path.join(process.env.HOME || "", ".codecast", "agent-status");

function sendAgentStatus(
  syncService: SyncService,
  conversationId: string,
  sessionId: string,
  status: AgentStatus,
  clientTs?: number,
  permissionMode?: PermissionMode,
): void {
  if (status === "working" && !permissionMode) {
    const last = lastWorkingStatusSent.get(sessionId) ?? 0;
    if (Date.now() - last < WORKING_STATUS_THROTTLE_MS) return;
    lastWorkingStatusSent.set(sessionId, Date.now());
  }
  syncService.updateSessionAgentStatus(conversationId, status, clientTs, permissionMode).catch((err) => { log(`[sendAgentStatus] error: ${err?.message || err}`); });
}

function truncateForNotification(text: string, maxLen = 200): string {
  let result = text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (result.length > maxLen) {
    result = result.slice(0, maxLen) + "...";
  }
  return result;
}

function detectErrorInMessage(content: string): string | null {
  const patterns = [
    /(?:Error|ERROR|FATAL|FAILED|panic):\s*(.+)/,
    /(?:compilation failed|build failed|test failed)/i,
    /exit code (?!0\b)\d+/i,
    /(?:Traceback|Exception|Unhandled rejection)/i,
  ];
  for (const pat of patterns) {
    const match = content.match(pat);
    if (match) return match[0].slice(0, 200);
  }
  return null;
}

const syncStats = {
  messagesSynced: 0,
  conversationsCreated: 0,
  sessionsActive: new Set<string>(),
  lastReportTime: Date.now(),
  errors: 0,
  warnings: 0,
};

let lastWatcherEventTime = Date.now();
let lastWatcherIdleLogTime = 0;

const HEALTH_REPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function log(message: string, level: LogLevel = "info", metadata?: RemoteLog["metadata"]): void {
  const timestamp = new Date().toISOString();
  const levelTag = level === "info" ? "" : `[${level.toUpperCase()}] `;
  const line = `[${timestamp}] ${levelTag}${message}\n`;
  fs.appendFileSync(LOG_FILE, line);

  if (level === "warn" || level === "error") {
    remoteLogQueue.push({
      level,
      message: message.slice(0, 2000),
      metadata,
      timestamp: Date.now(),
    });
    if (remoteLogQueue.length > MAX_LOG_QUEUE_SIZE) {
      remoteLogQueue.shift();
    }
  }
}

function logError(message: string, error?: Error, sessionId?: string): void {
  const errMsg = error ? `${message}: ${error.message}` : message;
  log(errMsg, "error", {
    session_id: sessionId,
    error_code: error?.name,
    stack: error?.stack?.slice(0, 1000),
  });
}

function logWarn(message: string, sessionId?: string): void {
  log(message, "warn", { session_id: sessionId });
}

function logLifecycle(event: string, details?: string): void {
  const message = details ? `[LIFECYCLE] ${event}: ${details}` : `[LIFECYCLE] ${event}`;
  log(message, "info");
  remoteLogQueue.push({
    level: "info",
    message,
    metadata: { error_code: event },
    timestamp: Date.now(),
  });
}

function logHealthSummary(): void {
  const now = Date.now();
  const periodMinutes = Math.round((now - syncStats.lastReportTime) / 60000);
  const sessionsCount = syncStats.sessionsActive.size;
  const hadActivity = syncStats.messagesSynced > 0 || syncStats.conversationsCreated > 0 || sessionsCount > 0 || syncStats.errors > 0;

  if (hadActivity) {
    const summary = `Health OK: ${syncStats.messagesSynced} msgs synced, ${syncStats.conversationsCreated} convos created, ${sessionsCount} active sessions (${periodMinutes}min period)`;

    log(summary, "info");

    remoteLogQueue.push({
      level: "info",
      message: summary,
      metadata: {
        error_code: syncStats.errors > 0 ? `${syncStats.errors} errors` : undefined,
      },
      timestamp: now,
    });
  }

  syncStats.messagesSynced = 0;
  syncStats.conversationsCreated = 0;
  syncStats.sessionsActive.clear();
  syncStats.errors = 0;
  syncStats.warnings = 0;
  syncStats.lastReportTime = now;
}

function isAutostartEnabled(): boolean {
  const home = process.env.HOME || "";
  if (platform === "darwin") {
    const plistPath = path.join(home, "Library", "LaunchAgents", "sh.codecast.daemon.plist");
    return fs.existsSync(plistPath);
  } else if (platform === "linux") {
    const servicePath = path.join(home, ".config", "systemd", "user", "codecast.service");
    return fs.existsSync(servicePath);
  }
  return false;
}

async function sendHeartbeat(): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    return;
  }

  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonVersion || "unknown",
        platform,
        pid: process.pid,
        autostart_enabled: isAutostartEnabled(),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log(`Heartbeat failed: ${response.status} ${text}`);
      return;
    }

    const data = await response.json();
    if (data.commands && data.commands.length > 0) {
      log(`Received ${data.commands.length} remote command(s)`);
      for (const cmd of data.commands) {
        await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
      }
    }

    if (data.sync_mode !== undefined) {
      const currentConfig = readConfig();
      const serverMode = data.sync_mode as "all" | "selected";
      const serverProjects: string[] = data.sync_projects ?? [];
      const localMode = currentConfig?.sync_mode ?? "all";
      const localProjects = currentConfig?.sync_projects ?? [];

      if (serverMode !== localMode || JSON.stringify(serverProjects) !== JSON.stringify(localProjects)) {
        log(`Sync settings updated from server: mode=${serverMode}, projects=${serverProjects.length}`);
        patchConfig({ sync_mode: serverMode, sync_projects: serverProjects });
        if (activeConfig) {
          activeConfig.sync_mode = serverMode;
          activeConfig.sync_projects = serverProjects;
        }
      }
    }

    if (data.team_id !== undefined) {
      const currentConfig = readConfig();
      if (currentConfig && currentConfig.team_id !== data.team_id) {
        log(`Team ID updated from server: ${data.team_id}`);
        patchConfig({ team_id: data.team_id });
        if (activeConfig) {
          activeConfig.team_id = data.team_id;
        }
      }
    }

    if (data.agent_permission_modes !== undefined) {
      const currentConfig = readConfig();
      const serverModes = data.agent_permission_modes;
      const localModes = currentConfig?.agent_permission_modes;
      if (JSON.stringify(serverModes) !== JSON.stringify(localModes)) {
        log(`Agent permission modes updated from server: ${JSON.stringify(serverModes)}`);
        patchConfig({ agent_permission_modes: serverModes });
        if (activeConfig) {
          activeConfig.agent_permission_modes = serverModes;
        }
      }
    }
  } catch (err) {
    log(`Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function executeRemoteCommand(
  commandId: string,
  command: string,
  config: Config,
  commandArgs?: string
): Promise<void> {
  const siteUrl = config.convex_url?.replace(".cloud", ".site");
  if (!siteUrl || !config.auth_token) return;

  let result: string | undefined;
  let error: string | undefined;

  try {
    switch (command) {
      case "status": {
        const state = readDaemonState();
        result = JSON.stringify({
          version: daemonVersion,
          platform,
          pid: process.pid,
          uptime: process.uptime(),
          autostart: isAutostartEnabled(),
          lastSync: state?.lastSyncTime,
          queueSize: state?.pendingQueueSize,
          stats: {
            messagesSynced: syncStats.messagesSynced,
            conversationsCreated: syncStats.conversationsCreated,
            activeSessions: syncStats.sessionsActive.size,
          },
        });
        log(`[REMOTE] Status requested, responding`);
        break;
      }
      case "version": {
        result = daemonVersion || "unknown";
        log(`[REMOTE] Version requested: ${result}`);
        break;
      }
      case "restart": {
        log(`[REMOTE] Restart requested`);
        result = "restarting";
        // Report result first, then restart
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            command_id: commandId,
            result,
          }),
        });
        setTimeout(() => {
          log("Restarting daemon per remote command...");
          const spawned = spawnReplacement();
          if (spawned) {
            skipRespawn = true;
          } else {
            log("spawnReplacement failed, letting exit handler respawn");
          }
          setTimeout(() => process.exit(0), 500);
        }, 1000);
        return;
      }
      case "force_update": {
        const currentVersion = daemonVersion || "unknown";
        logLifecycle("update_start", `Remote update requested from v${currentVersion}`);
        result = "updating";
        // Report result first, then update
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            command_id: commandId,
            result,
          }),
        });
        // Flush logs before update
        await flushRemoteLogs();
        setTimeout(async () => {
          const success = await performUpdate();
          if (success) {
            const newVersion = getVersion();
            if (compareVersions(newVersion, currentVersion) <= 0) {
              logLifecycle("update_noop", `v${currentVersion} -> v${newVersion}, requested version not available`);
              await flushRemoteLogs();
              return;
            }
            logLifecycle("update_complete", `Updated from v${currentVersion} to v${newVersion}`);
            await flushRemoteLogs();
            log("Update successful, restarting...");
            const spawned = spawnReplacement();
            if (spawned) {
              skipRespawn = true;
            } else {
              log("spawnReplacement failed, letting exit handler respawn");
            }
            setTimeout(() => process.exit(0), 500);
          } else {
            logLifecycle("update_failed", `Update failed from v${currentVersion}`);
            await flushRemoteLogs();
          }
        }, 1000);
        return;
      }
      case "start_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const rawAgentType = parsed.agent_type;
        const agentType: "claude" | "codex" | "gemini" =
          rawAgentType === "codex" || rawAgentType === "gemini" ? rawAgentType : "claude";
        const projectPath: string = parsed.project_path || process.env.HOME || "/tmp";
        const prompt: string | undefined = parsed.prompt;
        const conversationId: string | undefined = parsed.conversation_id;

        const shortId = Math.random().toString(36).slice(2, 8);
        const tmuxSession = `cc-${agentType}-${shortId}`;

        const cwd = fs.existsSync(projectPath) ? projectPath : (process.env.HOME || "/tmp");

        let binary: string;
        let binaryArgs: string[] = [];
        if (agentType === "codex") {
          binary = "codex";
          if (prompt) binaryArgs.push(prompt);
          const extraArgs = config.codex_args || "";
          if (extraArgs) binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
            // First-time notification: let user know Codex is running in full-access mode
            if (!config.codex_args && !config.agent_permission_modes?.codex) {
              const flagFile = path.join(CONFIG_DIR, ".codex-bypass-notified");
              if (!fs.existsSync(flagFile)) {
                fs.writeFileSync(flagFile, new Date().toISOString());
                if (conversationId) {
                  syncService.createSessionNotification({
                    conversation_id: conversationId,
                    type: "info",
                    title: "Codex running in full-access mode",
                    message: "Codex is running without permission prompts by default. Configure with: codecast config codex_args",
                  }).catch(() => {});
                }
              }
            }
          }
        } else if (agentType === "gemini") {
          binary = "gemini";
          if (prompt) binaryArgs.push(prompt);
        } else {
          binary = "claude";
          if (prompt) {
            binaryArgs.push("-p", prompt);
          }
          const extraArgs = config.claude_args || "";
          if (extraArgs) binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags && !extraArgs.includes("--dangerously-skip-permissions") && !extraArgs.includes("--permission-mode")) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
          }
        }

        const shellCmd = [binary, ...binaryArgs].map(a => a.includes(" ") ? `'${a.replace(/'/g, "'\\''")}'` : a).join(" ");
        const fullCmd = `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${shellCmd}`;
        const execPath = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
        const execOpts = { timeout: 5000, env: { ...process.env, PATH: execPath } };

        try {
          execSync(`tmux new-session -d -s '${tmuxSession}' -c '${cwd}'`, execOpts);
          execSync(`tmux send-keys -t '${tmuxSession}' '${fullCmd.replace(/'/g, "'\\''")}' Enter`, execOpts);
          result = JSON.stringify({ tmux_session: tmuxSession, agent_type: agentType, project_path: cwd });
          log(`[REMOTE] Started ${agentType} session in tmux: ${tmuxSession} (cwd: ${cwd})`);
          if (conversationId) {
            startedSessionTmux.set(conversationId, {
              tmuxSession,
              projectPath: cwd,
              startedAt: Date.now(),
              agentType,
            });
            log(`[REMOTE] Registered started session tmux for conversation ${conversationId.slice(0, 12)}`);
            if (agentType === "claude") {
              discoverAndLinkSession(conversationId, tmuxSession, cwd).catch(err => {
                log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
              });
            }
          }
        } catch (spawnErr) {
          error = `Failed to start session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
          log(`[REMOTE] start_session error: ${error}`);
        }
        break;
      }
      case "escape": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        if (!conversationId) {
          error = "Missing conversation_id";
          break;
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget) {
          await execAsync(`tmux send-keys -t '${tmuxTarget}' Escape`);
          result = "escape_sent";
          log(`[REMOTE] Sent Escape to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
        } else {
          try {
            process.kill(proc.pid, "SIGINT");
            result = "escape_sent_sigint";
            log(`[REMOTE] Sent SIGINT to session ${sessionId.slice(0, 8)} pid=${proc.pid}`);
          } catch (killErr) {
            error = `Failed to send SIGINT to pid ${proc.pid}: ${killErr}`;
          }
        }
        break;
      }
      case "send_keys": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        const keys = parsed.keys;
        if (!conversationId || !keys) {
          error = "Missing conversation_id or keys";
          break;
        }
        const ALLOWED_KEYS = new Set(["BTab", "Escape", "Enter", "Tab", "Up", "Down", "Left", "Right", "Space", "BSpace"]);
        const keyList = keys.split(" ");
        const invalidKey = keyList.find((k: string) => !ALLOWED_KEYS.has(k));
        if (invalidKey) {
          error = `Key '${invalidKey}' not in allowlist`;
          break;
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget) {
          await execAsync(`tmux send-keys -t '${tmuxTarget}' ${keys}`);
          result = "keys_sent";
          log(`[REMOTE] Sent ${keys} to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
        } else {
          error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
        }
        break;
      }
      case "kill_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        if (!conversationId) {
          error = "Missing conversation_id";
          break;
        }

        const started = startedSessionTmux.get(conversationId);
        if (started) {
          try {
            await execAsync(`tmux kill-session -t '${started.tmuxSession}' 2>/dev/null`);
            log(`[REMOTE] Killed started tmux session ${started.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
          } catch {}
          startedSessionTmux.delete(conversationId);
          result = "killed_tmux";
          break;
        }

        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (sessionId) {
          const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
          if (proc) {
            const tmuxTarget = await findTmuxPaneForTty(proc.tty);
            if (tmuxTarget) {
              const tmuxSessionName = tmuxTarget.split(":")[0];
              try {
                await execAsync(`tmux kill-session -t '${tmuxSessionName}' 2>/dev/null`);
                log(`[REMOTE] Killed tmux session ${tmuxSessionName} for conversation ${conversationId.slice(0, 12)}`);
                result = "killed_tmux";
              } catch {
                try {
                  process.kill(proc.pid, "SIGKILL");
                  result = "killed_sigkill";
                  log(`[REMOTE] Sent SIGKILL to pid ${proc.pid} for conversation ${conversationId.slice(0, 12)}`);
                } catch (killErr) {
                  error = `Failed to kill pid ${proc.pid}: ${killErr}`;
                }
              }
            } else {
              try {
                process.kill(proc.pid, "SIGKILL");
                result = "killed_sigkill";
                log(`[REMOTE] Sent SIGKILL to pid ${proc.pid} for conversation ${conversationId.slice(0, 12)}`);
              } catch (killErr) {
                error = `Failed to kill pid ${proc.pid}: ${killErr}`;
              }
            }
          } else {
            result = "no_process";
          }
        } else {
          result = "no_session";
        }
        break;
      }
      case "resume_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const sessionId = parsed.session_id;
        const conversationId = parsed.conversation_id;
        if (!sessionId) {
          error = "Missing session_id";
          break;
        }
        const projectPath = parsed.project_path;
        log(`[REMOTE] Force-resuming session ${sessionId.slice(0, 8)}${projectPath ? ` in ${projectPath}` : ""}`);
        let resumed = await autoResumeSession(sessionId, "", readTitleCache(), false, projectPath, conversationId);
        if (!resumed) {
          log(`[REMOTE] Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
          resumed = await repairAndResumeSession(sessionId, "", readTitleCache(), false, projectPath, conversationId);
        }
        if (resumed) {
          if (conversationId) {
            const cache = readConversationCache();
            cache[sessionId] = conversationId;
            saveConversationCache(cache);
          }
          result = JSON.stringify({ resumed: true, session_id: sessionId });
          log(`[REMOTE] Force-resume succeeded for ${sessionId.slice(0, 8)}`);
        } else if (conversationId && projectPath) {
          log(`[REMOTE] Resume failed for ${sessionId.slice(0, 8)}, starting fresh session in ${projectPath}`);
          const shortId = Math.random().toString(36).slice(2, 8);
          const tmuxSession = `cc-claude-${shortId}`;
          const cwd = fs.existsSync(projectPath) ? projectPath : (process.env.HOME || "/tmp");
          let extraFlags = config.claude_args || "";
          const fullCmd = `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; claude${extraFlags ? " " + extraFlags : ""}`;
          const execPath = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
          const execOpts = { timeout: 5000, env: { ...process.env, PATH: execPath } };
          try {
            execSync(`tmux new-session -d -s '${tmuxSession}' -c '${cwd}'`, execOpts);
            execSync(`tmux send-keys -t '${tmuxSession}' '${fullCmd.replace(/'/g, "'\\''")}' Enter`, execOpts);
            startedSessionTmux.set(conversationId, {
              tmuxSession,
              projectPath: cwd,
              startedAt: Date.now(),
              agentType: "claude",
            });
            discoverAndLinkSession(conversationId, tmuxSession, cwd).catch(err => {
              log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
            });
            result = JSON.stringify({ started_fresh: true, tmux_session: tmuxSession });
            log(`[REMOTE] Started fresh session ${tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
          } catch (spawnErr) {
            error = `Failed to start fresh session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
          }
        } else {
          error = `Failed to resume session ${sessionId.slice(0, 8)} — session file may not exist locally`;
        }
        break;
      }
      default:
        error = `Unknown command: ${command}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Report result
  try {
    await fetch(`${siteUrl}/cli/command-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        command_id: commandId,
        result,
        error,
      }),
    });
  } catch {
    // Ignore
  }
}

async function flushRemoteLogs(): Promise<void> {
  if (!syncServiceRef || remoteLogQueue.length === 0) {
    return;
  }
  const logsToSend = remoteLogQueue.splice(0, 100);
  const logsWithMeta = logsToSend.map(l => ({
    ...l,
    daemon_version: daemonVersion,
    platform,
  }));
  try {
    await syncServiceRef.syncLogs(logsWithMeta);
  } catch {
    remoteLogQueue.unshift(...logsToSend);
  }
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readConfig(): Config | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    return null;
  }
}

function patchConfig(updates: Partial<Config>): void {
  const config = readConfig();
  if (!config) return;
  Object.assign(config, updates);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function readConversationCache(): ConversationCache {
  const cacheFile = path.join(CONFIG_DIR, "conversations.json");
  if (!fs.existsSync(cacheFile)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as ConversationCache;
  } catch {
    return {};
  }
}

function saveConversationCache(cache: ConversationCache): void {
  const cacheFile = path.join(CONFIG_DIR, "conversations.json");
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

function readTitleCache(): TitleCache {
  const cacheFile = path.join(CONFIG_DIR, "titles.json");
  if (!fs.existsSync(cacheFile)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as TitleCache;
  } catch {
    return {};
  }
}

function saveTitleCache(cache: TitleCache): void {
  const cacheFile = path.join(CONFIG_DIR, "titles.json");
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

function generateTitleFromMessage(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const cmdNameMatch = trimmed.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmdNameMatch) return `/${cmdNameMatch[1].replace(/^\//, "")}`;

  const cmdMsgMatch = trimmed.match(/<command-message>([^<]*)<\/command-message>/);
  if (cmdMsgMatch) return `/${cmdMsgMatch[1].replace(/^\//, "")}`;

  const cleaned = trimmed
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  const result = cleaned || trimmed;
  if (result.length <= 50) {
    return result;
  }

  return result.slice(0, 50) + "...";
}

function readDaemonState(): DaemonState {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as DaemonState;
  } catch {
    return {};
  }
}

function saveDaemonState(updates: Partial<DaemonState>): void {
  try {
    const current = readDaemonState();
    const newState = { ...current, ...updates, timestamp: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`Failed to write daemon state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleAuthFailure(): boolean {
  const state = readDaemonState();
  const currentCount = (state.authFailureCount || 0) + 1;

  if (currentCount >= AUTH_FAILURE_THRESHOLD) {
    logError(`Auth failed ${currentCount} times consecutively - marking auth as expired`);
    saveDaemonState({ authExpired: true, authFailureCount: currentCount });
    return true;
  }

  log(`Auth failure ${currentCount}/${AUTH_FAILURE_THRESHOLD} - will retry`);
  saveDaemonState({ authFailureCount: currentCount });
  return false;
}

function resetAuthFailureCount(): void {
  const state = readDaemonState();
  if (state.authFailureCount && state.authFailureCount > 0) {
    saveDaemonState({ authFailureCount: 0 });
  }
}

interface GitInfo {
  commitHash?: string;
  branch?: string;
  remoteUrl?: string;
  status?: string;
  diff?: string;
  diffStaged?: string;
  root?: string;
}

function isPathExcluded(projectPath: string, excludedPaths?: string): boolean {
  if (!excludedPaths || !projectPath) {
    return false;
  }

  const paths = excludedPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);

  for (const excludedPath of paths) {
    const normalizedExcluded = path.resolve(excludedPath);
    const normalizedProject = path.resolve(projectPath);

    if (normalizedProject.startsWith(normalizedExcluded)) {
      return true;
    }
  }

  return false;
}

function isProjectAllowedToSync(projectPath: string, config: Config): boolean {
  if (!config.sync_mode || config.sync_mode === "all") {
    return true;
  }

  if (!config.sync_projects || config.sync_projects.length === 0) {
    return false;
  }

  const normalizedProject = path.resolve(projectPath);
  return config.sync_projects.some(allowed => {
    const normalizedAllowed = path.resolve(allowed);
    return normalizedProject === normalizedAllowed || normalizedProject.startsWith(normalizedAllowed + path.sep);
  });
}

function getGitInfo(projectPath: string): GitInfo | undefined {
  const execGit = (args: string): string | undefined => {
    try {
      return execSync(`git ${args}`, {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch {
      return undefined;
    }
  };

  const commitHash = execGit("rev-parse HEAD");
  if (!commitHash) {
    return undefined;
  }

  const branch = execGit("rev-parse --abbrev-ref HEAD");
  const remoteUrl = execGit("remote get-url origin");
  const status = execGit("status --porcelain");
  const diff = execGit("diff");
  const diffStaged = execGit("diff --cached");
  const root = execGit("rev-parse --show-toplevel");

  return {
    commitHash,
    branch,
    remoteUrl,
    status,
    diff: diff ? diff.slice(0, 100000) : undefined,
    diffStaged: diffStaged ? diffStaged.slice(0, 100000) : undefined,
    root,
  };
}

function decodeProjectDirName(dirName: string): string {
  const stripped = dirName.startsWith("-") ? dirName.slice(1) : dirName;
  const tokens = stripped.split("-");

  let resolved = "/";
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i] === "") { i++; continue; }
    let matched = false;
    for (let len = tokens.length - i; len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join("-");
      if (fs.existsSync(path.join(resolved, candidate))) {
        resolved = path.join(resolved, candidate);
        i += len;
        matched = true;
        break;
      }
      if (fs.existsSync(path.join(resolved, "." + candidate))) {
        resolved = path.join(resolved, "." + candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      resolved = path.join(resolved, tokens[i]);
      i++;
    }
  }

  return resolved;
}

async function flushPendingMessagesBatch(
  pendingMsgs: Array<{ uuid?: string; role: "human" | "assistant" | "system"; content: string; timestamp: number; thinking?: string; toolCalls?: any; toolResults?: any; images?: any; subtype?: string }>,
  conversationId: string,
  syncService: SyncService,
  retryQueue: RetryQueue,
): Promise<void> {
  try {
    await syncService.addMessages({
      conversationId,
      messages: pendingMsgs.map(msg => ({
        messageUuid: msg.uuid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype,
      })),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Batch pending flush failed, queueing individually: ${errMsg}`);
    for (const msg of pendingMsgs) {
      retryQueue.add("addMessage", {
        conversationId,
        messageUuid: msg.uuid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype,
      }, errMsg);
    }
  }
}

type RawMessage = { uuid?: string; role: string; content: string; timestamp: number; thinking?: string; toolCalls?: any; toolResults?: any; images?: any; subtype?: string };

function mapRole(role: string): "human" | "assistant" | "system" {
  return role === "user" ? "human" : role === "system" ? "system" : "assistant";
}

function prepMessageForSync(msg: RawMessage): { messageUuid?: string; role: "human" | "assistant" | "system"; content: string; timestamp: number; thinking?: string; toolCalls?: any; toolResults?: any; images?: any; subtype?: string } {
  return {
    messageUuid: msg.uuid,
    role: mapRole(msg.role),
    content: redactSecrets(msg.content),
    timestamp: msg.timestamp,
    thinking: msg.thinking,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
    images: msg.images,
    subtype: msg.subtype,
  };
}

async function syncMessagesBatch(
  messages: RawMessage[],
  conversationId: string,
  syncService: SyncService,
  retryQueue: RetryQueue,
): Promise<{ authExpired: boolean; conversationNotFound: boolean }> {
  try {
    await syncService.addMessages({
      conversationId,
      messages: messages.map(prepMessageForSync),
    });
    resetAuthFailureCount();
    return { authExpired: false, conversationNotFound: false };
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      if (handleAuthFailure()) {
        return { authExpired: true, conversationNotFound: false };
      }
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("Conversation not found")) {
      return { authExpired: false, conversationNotFound: true };
    }

    log(`Batch sync failed, queueing individually: ${errMsg}`);
    for (const msg of messages) {
      const prepped = prepMessageForSync(msg);
      retryQueue.add("addMessage", {
        conversationId,
        ...prepped,
      }, errMsg);
    }
    return { authExpired: false, conversationNotFound: false };
  }
}

async function processSessionFile(
  filePath: string,
  sessionId: string,
  projectPath: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  titleCache: TitleCache,
  updateStateCallback: () => void,
  parentConversationId?: string,
): Promise<void> {
    let lastPosition = getPosition(filePath);
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }

  
  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }

  if (stats.size <= lastPosition) {
        return;
  }

  const bytesToRead = stats.size - lastPosition;

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    const newContent = buffer.toString("utf-8");
    const messages = parseSessionFile(newContent);

    let conversationId = conversationCache[sessionId];

    // Check for summary title even if no new messages
    if (conversationId) {
      let fullContent;
      try {
        fullContent = fs.readFileSync(filePath, "utf-8");
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(fullContent);
      if (summaryTitle && titleCache[sessionId] !== summaryTitle) {
        try {
          await syncService.updateTitle(conversationId, summaryTitle);
          titleCache[sessionId] = summaryTitle;
          saveTitleCache(titleCache);
          log(`Updated title for session ${sessionId}: ${summaryTitle}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Failed to update title: ${errMsg}`);
        }
      }

      if (!planHandoffChecked.has(sessionId)) {
        planHandoffChecked.add(sessionId);
        const allMessages = parseSessionFile(fullContent);
        const userMsgs = allMessages.filter(m => m.role === "user").slice(0, 3);
        for (const msg of userMsgs) {
          if (!msg.content) continue;
          const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
          if (handoffMatch) {
            const jsonlPath = handoffMatch[1];
            const parentSessionMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (parentSessionMatch) {
              const parentSessionId = parentSessionMatch[1];
              const parentConvId = conversationCache[parentSessionId];
              if (parentConvId) {
                try {
                  await syncService.linkPlanHandoff(parentConvId, conversationId);
                  planHandoffChildren.set(parentConvId, conversationId);
                  log(`Retroactive plan handoff: linked ${sessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
                } catch (err) {
                  log(`Failed retroactive plan handoff link: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
            break;
          }
        }
      }
    }

  if (messages.length === 0) {
    setPosition(filePath, stats.size);
    return;
  }

  if (!conversationId) {
    let fullContent;
    try {
      fullContent = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
        return;
      }
      throw err;
    }

    try {
      const slug = extractSlug(fullContent);
      const parentMessageUuid = extractParentUuid(fullContent);
      const firstMessageTimestamp = messages[0]?.timestamp;
      const dirName = path.basename(path.dirname(filePath));
      const decodedPath = dirName ? decodeProjectDirName(dirName) : undefined;
      const actualProjectPath = (decodedPath && fs.existsSync(decodedPath) ? decodedPath : null) || extractCwd(fullContent) || projectPath;
      const gitInfo = actualProjectPath ? getGitInfo(actualProjectPath) : undefined;

      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      // Detect parent conversation from file path (subagents/) or content (plan handoff)
      let isPlanHandoff = false;
      if (!parentConversationId) {
        const parts = filePath.split(path.sep);
        const isSubagentFile = parts.includes("subagents");
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          const parentSessionId = parts[subagentsIdx - 1];
          if (parentSessionId && conversationCache[parentSessionId]) {
            parentConversationId = conversationCache[parentSessionId];
            log(`Detected subagent parent for ${sessionId}: ${parentConversationId}`);
          } else if (parentSessionId) {
            pendingSubagentParents.set(sessionId, parentSessionId);
            log(`Subagent ${sessionId} parent ${parentSessionId} not cached yet, queued for linking`);
          }
        }
      }
      if (!parentConversationId) {
        const userMessages = messages.filter(msg => msg.role === "user").slice(0, 3);
        for (const msg of userMessages) {
          if (!msg.content) continue;
          const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
          if (handoffMatch) {
            const jsonlPath = handoffMatch[1];
            const parentSessionMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (parentSessionMatch) {
              const parentSessionId = parentSessionMatch[1];
              if (conversationCache[parentSessionId]) {
                parentConversationId = conversationCache[parentSessionId];
                isPlanHandoff = true;
                log(`Detected plan handoff parent for ${sessionId}: ${parentConversationId} (from ${parentSessionId})`);
              }
            }
            break;
          }
        }
      }

      let matchedStartedConversation: string | null = null;
      if (startedSessionTmux.size > 0) {
        const startedClaudeEntries = Array.from(startedSessionTmux.entries())
          .filter(([, entry]) => entry.agentType === "claude");
        const proc = await findSessionProcess(sessionId, "claude").catch(() => null);
        let tmuxSessionName: string | null = null;
        if (proc) {
          tmuxSessionName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
          if (!tmuxSessionName) {
            const tmuxPane = await findTmuxPaneForTty(proc.tty);
            if (tmuxPane) {
              tmuxSessionName = tmuxPane.split(":")[0];
              cacheSessionProcess(sessionId, proc, tmuxPane);
            }
          }
        }
        matchedStartedConversation = matchStartedConversation(startedClaudeEntries, {
          tmuxSessionName,
          projectPath: actualProjectPath,
        });
        if (matchedStartedConversation && tmuxSessionName) {
          log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via tmux ${tmuxSessionName}`);
        } else if (matchedStartedConversation && actualProjectPath) {
          log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via projectPath fallback`);
        }
      }

      if (matchedStartedConversation) {
        conversationId = matchedStartedConversation;
        const tmuxEntry = startedSessionTmux.get(matchedStartedConversation);
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        syncService.updateSessionId(conversationId, sessionId).catch(() => {});
        if (tmuxEntry) {
          syncService.registerManagedSession(sessionId, process.pid, tmuxEntry.tmuxSession, conversationId).catch(() => {});
        }
        startedSessionTmux.delete(matchedStartedConversation);
        log(`Linked session ${sessionId} to existing started conversation ${conversationId}`);
      } else {
        const cliFlags = detectCliFlags(fullContent);
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "claude_code",
          projectPath: actualProjectPath,
          slug,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: isPlanHandoff ? "plan-handoff" : (parentConversationId ? undefined : parentMessageUuid),
          parentConversationId,
          gitInfo,
          cliFlags: cliFlags || undefined,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        if (isPlanHandoff && parentConversationId) {
          planHandoffChildren.set(parentConversationId, conversationId);
          log(`Registered plan handoff: parent ${parentConversationId.slice(0, 12)} -> child ${conversationId.slice(0, 12)}`);
        }
        log(`Created conversation ${conversationId} for session ${sessionId}`);
        syncStats.conversationsCreated++;

        // Detect tmux and register managed session
        findSessionProcess(sessionId, "claude").then((proc) => {
          if (!proc) return;
          findTmuxPaneForTty(proc.tty).then((tmuxPane) => {
            const tmuxSessionName = tmuxPane?.split(":")[0];
            syncService.registerManagedSession(sessionId, proc.pid, tmuxSessionName, conversationId).catch(() => {});
            if (tmuxSessionName) log(`Registered managed session for ${sessionId.slice(0, 8)} (tmux: ${tmuxSessionName})`);
          }).catch(() => {
            syncService.registerManagedSession(sessionId, process.pid, undefined, conversationId).catch(() => {});
          });
        }).catch(() => {
          syncService.registerManagedSession(sessionId, process.pid, undefined, conversationId).catch(() => {});
        });

        // Resolve any pending subagents waiting for this session as their parent
        for (const [childSessionId, parentSessionId] of pendingSubagentParents) {
          if (parentSessionId === sessionId) {
            const childConvId = conversationCache[childSessionId];
            if (childConvId) {
              syncService.linkSessions(conversationId, childConvId).then(() => {
                log(`Linked pending subagent ${childSessionId.slice(0, 8)} -> parent ${sessionId.slice(0, 8)}`);
              }).catch((err) => {
                log(`Failed to link subagent ${childSessionId.slice(0, 8)}: ${err}`);
              });
              pendingSubagentParents.delete(childSessionId);
            }
          }
        }
      }

      if ((global as any).activeSessions) {
        (global as any).activeSessions.set(conversationId, {
          sessionId,
          conversationId,
          projectPath: actualProjectPath || "",
        });
      }

      if (pendingMessages[sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
        delete pendingMessages[sessionId];
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          setPosition(filePath, stats.size);
          return;
        }
        // Let it fall through to retry queue
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to create conversation, queueing for retry: ${errMsg}`);

      if (!pendingMessages[sessionId]) {
        pendingMessages[sessionId] = [];
      }
      for (const msg of messages) {
        pendingMessages[sessionId].push({
          uuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          filePath,
          fileSize: stats.size,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype,
        });
      }

      let retryFullContent;
      try {
        retryFullContent = fs.readFileSync(filePath, "utf-8");
      } catch (readErr: any) {
        if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for retry queue. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw readErr;
      }

      const slug = extractSlug(retryFullContent);
      const firstMsgTimestamp = messages[0]?.timestamp;
      const retryDirName = path.basename(path.dirname(filePath));
      const retryDecoded = retryDirName ? decodeProjectDirName(retryDirName) : undefined;
      const retryProjectPath = (retryDecoded && fs.existsSync(retryDecoded) ? retryDecoded : null) || extractCwd(retryFullContent) || projectPath;
      const gitInfo = retryProjectPath ? getGitInfo(retryProjectPath) : undefined;

      retryQueue.add("createConversation", {
        userId,
        teamId,
        sessionId,
        agentType: "claude_code",
        projectPath: retryProjectPath,
        slug,
        startedAt: firstMsgTimestamp,
        gitInfo,
      }, errMsg);

      setPosition(filePath, stats.size);
      return;
    }
  }

  const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
  if (batchResult.authExpired) {
    log("⚠️  Authentication expired - sync paused");
    return;
  }
  if (batchResult.conversationNotFound) {
    log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
    delete conversationCache[sessionId];
    saveConversationCache(conversationCache);

    let recreateFullContent;
    try {
      recreateFullContent = fs.readFileSync(filePath, "utf-8");
    } catch (readErr: any) {
      if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath} for conversation recreation. Skipping.`);
        setPosition(filePath, stats.size);
        return;
      }
      throw readErr;
    }

    const slug = extractSlug(recreateFullContent);
    const firstMessageTimestamp = messages[0]?.timestamp;
    const recreateDirName = path.basename(path.dirname(filePath));
    const recreateDecoded = recreateDirName ? decodeProjectDirName(recreateDirName) : undefined;
    const recreateProjectPath = (recreateDecoded && fs.existsSync(recreateDecoded) ? recreateDecoded : null) || extractCwd(recreateFullContent) || projectPath;
    const gitInfo = recreateProjectPath ? getGitInfo(recreateProjectPath) : undefined;

    try {
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "claude_code",
        projectPath: recreateProjectPath,
        slug,
        title,
        startedAt: firstMessageTimestamp,
        gitInfo,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Recreated conversation ${conversationId} for session ${sessionId}`);

      await syncService.addMessages({
        conversationId,
        messages: messages.map(prepMessageForSync),
      });
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log(`Failed to recreate conversation and add messages: ${retryErrMsg}`);
    }
  }

    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "claude");

    const lastMessage = messages[messages.length - 1];
    const wasInterrupted = lastMessage?.role === "user" &&
      (lastMessage.content?.trim().startsWith("[Request interrupted") ||
       lastMessage.content?.trim().startsWith("[Request cancelled"));

    const lastAssistantMessage = messages.filter(m => m.role === "assistant").pop();
    if (lastAssistantMessage && conversationId) {
      const permissionPrompt = detectPermissionPrompt(lastAssistantMessage.content);
      if (permissionPrompt) {
        log(`Permission prompt detected for tool: ${permissionPrompt.tool_name}`);
        sendAgentStatus(syncService, conversationId, sessionId, "permission_blocked");

        const permArgPreview = truncateForNotification(
          `${permissionPrompt.tool_name}: ${permissionPrompt.arguments_preview || ""}`, 150
        );
        syncService.createSessionNotification({
          conversation_id: conversationId,
          type: "permission_request",
          title: `codecast - Permission needed`,
          message: permArgPreview,
        }).catch(() => {});

        handlePermissionRequest(
          syncService,
          conversationId,
          sessionId,
          permissionPrompt,
          log
        ).then((decision) => {
          if (decision) {
            const response = decision.approved ? "y" : "n";
            log(`Attempting to inject response '${response}' to session ${sessionId.slice(0, 8)}`);

            findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
              if (!proc) {
                log("No process found for session");
                return;
              }
              findTmuxPaneForTty(proc.tty).then((tmuxTarget) => {
                if (tmuxTarget) {
                  injectViaTmux(tmuxTarget, response).then(() => {
                    log(`Injected '${response}' via tmux for session ${sessionId.slice(0, 8)}`);
                  }).catch(() => {
                    injectViaIterm(proc.tty, response).then(() => {
                      log(`Injected '${response}' via iTerm2 for session ${sessionId.slice(0, 8)}`);
                    }).catch((err) => {
                      log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                    });
                  });
                } else {
                  injectViaIterm(proc.tty, response).then(() => {
                    log(`Injected '${response}' via iTerm2 for session ${sessionId.slice(0, 8)}`);
                  }).catch((err) => {
                    log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                  });
                }
              });
            }).catch((err) => {
              log(`Failed to find Claude session: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else {
            log("Permission request timed out or failed");
          }
        }).catch((err) => {
          log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      const errorText = detectErrorInMessage(lastAssistantMessage.content);
      if (errorText && !permissionPrompt) {
        const now = Date.now();
        const lastErr = lastErrorNotification.get(sessionId) ?? 0;
        if (now - lastErr > IDLE_COOLDOWN_MS) {
          lastErrorNotification.set(sessionId, now);
          syncService.createSessionNotification({
            conversation_id: conversationId,
            type: "session_error",
            title: "codecast - Error",
            message: truncateForNotification(errorText),
          }).catch(() => {});
        }
      }

      if (!permissionPrompt) {
        const existingTimer = idleTimers.get(sessionId);
        if (existingTimer) clearTimeout(existingTimer);

        const hookEntry = lastHookStatus.get(sessionId);
        const hookIsRecent = hookEntry && (Date.now() / 1000 - hookEntry.ts) < 30;
        if (!hookIsRecent) {
          sendAgentStatus(syncService, conversationId, sessionId, "working");
        }

        const hasPendingToolCalls = (lastAssistantMessage.toolCalls?.length ?? 0) > 0 &&
          !messages.some(m => m.role === "assistant" && (m.toolResults?.length ?? 0) > 0 &&
            m.timestamp >= lastAssistantMessage.timestamp);

        if (wasInterrupted) {
          idleTimers.delete(sessionId);
          lastIdleNotifiedSize.set(sessionId, stats.size);
        } else if (hasPendingToolCalls) {
          idleTimers.delete(sessionId);
        } else {
          const capturedFilePath = filePath;
          const capturedSize = stats.size;

          if (capturedSize === lastIdleNotifiedSize.get(sessionId)) {
            // Already notified for this state, skip
          } else {
            idleTimers.set(sessionId, setTimeout(() => {
              idleTimers.delete(sessionId);
              try {
                const currentStats = fs.statSync(capturedFilePath);
                if (currentStats.size !== capturedSize) return;
              } catch { return; }

              const hookIdle = lastHookStatus.get(sessionId);
              if (hookIdle && (Date.now() / 1000 - hookIdle.ts) < 30) return;

              lastIdleNotifiedSize.set(sessionId, capturedSize);
              sendAgentStatus(syncService, conversationId, sessionId, "idle");
              const preview = truncateForNotification(lastAssistantMessage.content);
              syncService.createSessionNotification({
                conversation_id: conversationId,
                type: "session_idle",
                title: "Claude done",
                message: preview,
              }).catch(() => {});
              log(`Sent idle notification for session ${sessionId.slice(0, 8)}`);
            }, IDLE_TIMEOUT_MS));
          }
        }
      }
    } else if (conversationId) {
      const existingTimer = idleTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        idleTimers.delete(sessionId);
      }
      lastIdleNotifiedSize.delete(sessionId);
    }

    updateStateCallback();
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }
}

async function processCursorSession(
  dbPath: string,
  sessionId: string,
  workspacePath: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  updateStateCallback: () => void
): Promise<void> {
  const syncedCount = getPosition(dbPath);

  let result: { messages: ParsedMessage[]; maxRowId: number; totalCount: number };
  try {
    result = extractMessagesFromCursorDb(dbPath, syncedCount);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${dbPath}. Will retry when permissions are restored.`);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to extract messages from Cursor DB: ${errMsg}`);
    return;
  }

  const { messages, totalCount } = result;

  if (messages.length === 0) {
    return;
  }

  let conversationId = conversationCache[sessionId];

  if (!conversationId) {
    try {
      const firstMessageTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        title,
        startedAt: firstMessageTimestamp,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for Cursor session ${sessionId}`);

      if (pendingMessages[sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
        delete pendingMessages[sessionId];
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          setPosition(dbPath, totalCount);
          return;
        }
        // Let it fall through to retry queue
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to create Cursor conversation, queueing for retry: ${errMsg}`);

      if (!pendingMessages[sessionId]) {
        pendingMessages[sessionId] = [];
      }
      for (const msg of messages) {
        pendingMessages[sessionId].push({
          uuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          filePath: dbPath,
          fileSize: totalCount,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype,
        });
      }

      const firstMsgTimestamp = messages[0]?.timestamp;

      retryQueue.add("createConversation", {
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        startedAt: firstMsgTimestamp,
      }, errMsg);

      setPosition(dbPath, totalCount);
      return;
    }
  }

  const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
  if (batchResult.authExpired) {
    log("⚠️  Authentication expired - sync paused");
    return;
  }
  if (batchResult.conversationNotFound) {
    log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
    delete conversationCache[sessionId];
    saveConversationCache(conversationCache);

    const firstMessageTimestamp = messages[0]?.timestamp;
    const firstUserMessage = messages.find(msg => msg.role === "user");
    const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

    try {
      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        title,
        startedAt: firstMessageTimestamp,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Recreated conversation ${conversationId} for Cursor session ${sessionId}`);

      await syncService.addMessages({
        conversationId,
        messages: messages.map(prepMessageForSync),
      });
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log(`Failed to recreate conversation and add messages: ${retryErrMsg}`);
    }
  }

  setPosition(dbPath, totalCount);
  log(`Synced ${messages.length} Cursor messages for session ${sessionId}`);
  syncStats.messagesSynced += messages.length;
  syncStats.sessionsActive.add(sessionId);

  updateStateCallback();
}

async function processCursorTranscriptFile(
  filePath: string,
  sessionId: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  updateStateCallback: () => void
): Promise<void> {
  let lastPosition = getPosition(filePath);
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }

  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }

  if (stats.size <= lastPosition) {
    return;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    const newContent = buffer.toString("utf-8");
    const messages = parseCursorTranscriptFile(newContent);

    let conversationId = conversationCache[sessionId];

    if (messages.length === 0) {
      setPosition(filePath, stats.size);
      return;
    }

    if (!conversationId) {
      let projectPath: string | undefined;
      try {
        projectPath = findWorkspacePathForCursorConversation(sessionId) || undefined;
      } catch {
        projectPath = undefined;
      }

      const firstMessageTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
      const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

      try {
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          slug: undefined,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: undefined,
          gitInfo,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Created conversation ${conversationId} for Cursor transcript ${sessionId}`);
        syncStats.conversationsCreated++;

        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, stats.size);
            return;
          }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Cursor conversation, queueing for retry: ${errMsg}`);

        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        }

        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          title,
          startedAt: firstMessageTimestamp,
          gitInfo,
        }, errMsg);

        setPosition(filePath, stats.size);
        return;
      }
    }

    const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);

      try {
        const projectPath = findWorkspacePathForCursorConversation(sessionId) || undefined;
        const firstMessageTimestamp = messages[0]?.timestamp;
        const firstUserMessage = messages.find(m => m.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          slug: undefined,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: undefined,
          gitInfo,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Cursor transcript ${sessionId}`);

        await syncService.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync),
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Cursor conversation and add messages: ${retryErrMsg}`);
      }
    }

    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} Cursor transcript messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Cursor transcript file ${filePath}: ${errMsg}`);
  }
}

async function processCodexSession(
  filePath: string,
  sessionId: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  titleCache: TitleCache,
  updateStateCallback: () => void
): Promise<void> {
  let lastPosition = getPosition(filePath);
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }

  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }

  if (stats.size <= lastPosition) {
    return;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    const newContent = buffer.toString("utf-8");
    const messages = parseCodexSessionFile(newContent);

    let conversationId = conversationCache[sessionId];

    if (conversationId) {
      let fullContent;
      try {
        fullContent = fs.readFileSync(filePath, "utf-8");
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(fullContent);
      if (summaryTitle && titleCache[sessionId] !== summaryTitle) {
        try {
          await syncService.updateTitle(conversationId, summaryTitle);
          titleCache[sessionId] = summaryTitle;
          saveTitleCache(titleCache);
          log(`Updated title for Codex session ${sessionId}: ${summaryTitle}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Failed to update title: ${errMsg}`);
        }
      }
    }

    if (messages.length === 0) {
      setPosition(filePath, stats.size);
      return;
    }

    if (!conversationId) {
      let fullContent;
      try {
        fullContent = fs.readFileSync(filePath, "utf-8");
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
          return;
        }
        throw err;
      }

      try {
        const projectPath = extractCodexCwd(fullContent);
        const firstMessageTimestamp = messages[0]?.timestamp;
        let matchedStartedConversation: string | null = null;

        if (startedSessionTmux.size > 0) {
          const startedCodexEntries = Array.from(startedSessionTmux.entries())
            .filter(([, entry]) => entry.agentType === "codex");
          const proc = await findSessionProcess(sessionId, "codex").catch(() => null);
          let tmuxSessionName: string | null = null;

          if (proc) {
            tmuxSessionName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
            if (!tmuxSessionName) {
              const tmuxPane = await findTmuxPaneForTty(proc.tty);
              if (tmuxPane) {
                tmuxSessionName = tmuxPane.split(":")[0];
                cacheSessionProcess(sessionId, proc, tmuxPane);
              }
            }
          }

          matchedStartedConversation = matchStartedConversation(startedCodexEntries, {
            tmuxSessionName,
            projectPath,
          });

          if (matchedStartedConversation && tmuxSessionName) {
            log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via tmux ${tmuxSessionName}`);
          } else if (matchedStartedConversation && projectPath) {
            log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via projectPath fallback`);
          } else {
            matchedStartedConversation = matchSingleFreshStartedConversation(startedCodexEntries);
            if (matchedStartedConversation) {
              log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via fresh-start fallback`);
            }
          }
        }

        if (matchedStartedConversation) {
          conversationId = matchedStartedConversation;
          const tmuxEntry = startedSessionTmux.get(matchedStartedConversation);
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          syncService.updateSessionId(conversationId, sessionId).catch(() => {});
          if (tmuxEntry) {
            syncService.registerManagedSession(sessionId, process.pid, tmuxEntry.tmuxSession, conversationId).catch(() => {});
            startCodexPermissionPoller(sessionId, tmuxEntry.tmuxSession, conversationId, syncService);
          }
          startedSessionTmux.delete(matchedStartedConversation);
          log(`Linked Codex session ${sessionId} to existing started conversation ${conversationId}`);
        } else {

          const firstUserMessage = messages.find(msg => msg.role === "user");
          const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

          conversationId = await syncService.createConversation({
            userId,
            teamId,
            sessionId,
            agentType: "codex",
            projectPath,
            slug: undefined,
            title,
            startedAt: firstMessageTimestamp,
            parentMessageUuid: undefined,
            gitInfo: undefined,
          });
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          log(`Created conversation ${conversationId} for Codex session ${sessionId}`);

          if ((global as any).activeSessions) {
            (global as any).activeSessions.set(conversationId, {
              sessionId,
              conversationId,
              projectPath: "",
            });
          }

          if (pendingMessages[sessionId]) {
            await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
            delete pendingMessages[sessionId];
          }
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, stats.size);
            return;
          }
          // Let it fall through to retry queue
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Codex conversation, queueing for retry: ${errMsg}`);

        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        }

        const firstMsgTimestamp = messages[0]?.timestamp;
        const firstUserMessage = messages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "codex",
          title,
          startedAt: firstMsgTimestamp,
        }, errMsg);

        setPosition(filePath, stats.size);
        return;
      }
    }

    const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);

      const firstMsgTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      try {
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "codex",
          title,
          startedAt: firstMsgTimestamp,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Codex session ${sessionId}`);

        await syncService.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync),
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Codex conversation and add messages: ${retryErrMsg}`);
      }
    }

    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} Codex messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "codex");

    // Agent status tracking for Codex sessions
    if (conversationId) {
      sendAgentStatus(syncService, conversationId, sessionId, "working");
    }

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Codex session file ${filePath}: ${errMsg}`);
  }
}

const geminiSyncedCounts = new Map<string, number>();

async function processGeminiSession(
  filePath: string,
  sessionId: string,
  projectHash: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  titleCache: TitleCache,
  updateStateCallback: () => void
): Promise<void> {
  try {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath}. Will retry later.`);
        return;
      }
      throw err;
    }

    const allMessages = parseGeminiSessionFile(content);
    const previousCount = geminiSyncedCounts.get(filePath) || 0;

    if (allMessages.length <= previousCount) {
      return;
    }

    const newMessages = allMessages.slice(previousCount);
    let conversationId = conversationCache[sessionId];

    if (!conversationId) {
      try {
        const firstUserMessage = allMessages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        const startTime = allMessages[0]?.timestamp;

        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          projectPath: undefined,
          slug: undefined,
          title,
          startedAt: startTime,
          parentMessageUuid: undefined,
          gitInfo: undefined,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Created conversation ${conversationId} for Gemini session ${sessionId}`);

        if ((global as any).activeSessions) {
          (global as any).activeSessions.set(conversationId, {
            sessionId,
            conversationId,
            projectPath: "",
          });
        }

        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            geminiSyncedCounts.set(filePath, allMessages.length);
            return;
          }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Gemini conversation, queueing for retry: ${errMsg}`);

        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of newMessages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: content.length,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        }

        const firstUserMessage = allMessages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          title,
          startedAt: allMessages[0]?.timestamp,
        }, errMsg);

        geminiSyncedCounts.set(filePath, allMessages.length);
        return;
      }
    }

    const batchResult = await syncMessagesBatch(newMessages, conversationId, syncService, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);

      const firstUserMessage = allMessages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      try {
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          title,
          startedAt: allMessages[0]?.timestamp,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Gemini session ${sessionId}`);

        await syncService.addMessages({
          conversationId,
          messages: newMessages.map(prepMessageForSync),
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Gemini conversation and add messages: ${retryErrMsg}`);
      }
    }

    geminiSyncedCounts.set(filePath, allMessages.length);
    log(`Synced ${newMessages.length} Gemini messages for session ${sessionId}`);
    syncStats.messagesSynced += newMessages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "gemini");

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Gemini session file ${filePath}: ${errMsg}`);
  }
}

interface ActiveSession {
  sessionId: string;
  conversationId: string;
  projectPath: string;
}

let reconnectAttempt = 0;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

function getReconnectDelay(): number {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, reconnectAttempt), MAX_DELAY_MS);
  reconnectAttempt++;
  return delay;
}

function resetReconnectDelay(): void {
  reconnectAttempt = 0;
}

interface ClaudeSessionInfo {
  pid: number;
  tty: string;
  sessionId: string;
}

function normalizeTty(tty: string): string {
  if (tty.startsWith("/dev/")) return tty;
  if (tty.startsWith("ttys")) return `/dev/${tty}`;
  if (tty.match(/^s\d+$/)) return `/dev/tty${tty}`;
  return `/dev/${tty}`;
}

function buildReverseConversationCache(cache: ConversationCache): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const [sessionId, convId] of Object.entries(cache)) {
    reverse[convId] = sessionId;
  }
  return reverse;
}

function detectSessionAgentType(sessionId: string): "claude" | "codex" | "gemini" {
  if (sessionId.startsWith("session-")) return "gemini";
  const sessionFile = findSessionFile(sessionId);
  return sessionFile?.agentType ?? "claude";
}

function tryRegisterSessionProcess(sessionId: string, agentType: "claude" | "codex" | "gemini"): void {
  try {
    const registryDir = path.join(CONFIG_DIR, "session-registry");
    const registryFile = path.join(registryDir, `${sessionId}.json`);

    if (fs.existsSync(registryFile)) {
      const stat = fs.statSync(registryFile);
      if (Date.now() - stat.mtimeMs < 300_000) return;
    }

    findSessionProcess(sessionId, agentType).then((result) => {
      if (!result) return;
      try {
        fs.mkdirSync(registryDir, { recursive: true });
        fs.writeFileSync(registryFile, JSON.stringify({ pid: result.pid, tty: result.tty, ts: Math.floor(Date.now() / 1000) }));
        log(`Opportunistically registered session ${sessionId.slice(0, 8)}: pid=${result.pid}, tty=${result.tty}`);
      } catch {}
      if (syncServiceRef) {
        const cache = readConversationCache();
        const conversationId = cache[sessionId];
        if (conversationId) {
          findTmuxPaneForTty(result.tty).then((tmuxPane) => {
            const tmuxSessionName = tmuxPane?.split(":")[0];
            syncServiceRef!.registerManagedSession(sessionId, result.pid, tmuxSessionName, conversationId).catch(() => {});
          }).catch(() => {
            syncServiceRef!.registerManagedSession(sessionId, result.pid, undefined, conversationId).catch(() => {});
          });
        }
      }
    }).catch(() => {});
  } catch {}
}

async function findSessionProcess(sessionId: string, agentType: "claude" | "codex" | "gemini" = "claude"): Promise<ClaudeSessionInfo | null> {
  // Check process cache first
  const cached = await getCachedSessionProcess(sessionId);
  if (cached) {
    log(`Process cache hit for session ${sessionId.slice(0, 8)}: pid=${cached.pid}`);
    return cached;
  }

  const binaryPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "claude";

  try {
    // Strategy 0: Check session registry (written by SessionStart hook)
    try {
      const registryFile = path.join(CONFIG_DIR, "session-registry", `${sessionId}.json`);
      if (fs.existsSync(registryFile)) {
        const reg = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        const pid = reg.pid;
        const tty = normalizeTty(reg.tty);
        // Verify process is still alive and is a claude-like process
        const { stdout: checkPs } = await execAsync(`ps -o comm= -p ${pid} 2>/dev/null`);
        if (checkPs.trim()) {
          if (agentType === "codex") {
            log(`Ignoring registry candidate for codex session ${sessionId.slice(0, 8)} (pid=${pid})`);
          } else {
          const result = { pid, tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found session ${sessionId.slice(0, 8)} via registry: pid=${pid}, tty=${tty}`);
          return result;
          }
        } else {
          // Process is dead, clean up stale registry
          try { fs.unlinkSync(registryFile); } catch {}
        }
      }
    } catch {}

    // Strategy A: find resumed sessions by command line
    try {
      const { stdout } = await execAsync(`ps aux | grep -E '${binaryPattern}' | grep -v grep | grep -v 'codecast'`);
      const lines = stdout.trim().split("\n");
      const geminiCandidates: Array<{ pid: number; tty: string }> = [];
      const codexResumeCandidates: Array<{ pid: number; tty: string }> = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const isResume = isResumeInvocation(agentType, line);
        if (!isResume && agentType !== "gemini") continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) continue;
        const pid = parseInt(parts[1], 10);
        const tty = parts[6];
        if (isNaN(pid) || tty === "?" || tty === "??") continue;
        const normalizedTty = normalizeTty(tty);
        if (line.includes(sessionId)) {
          if (agentType === "codex") {
            codexResumeCandidates.push({ pid, tty: normalizedTty });
            continue;
          }
          const result = { pid, tty: normalizedTty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found session ${sessionId.slice(0, 8)} via resume process match: pid=${pid}`);
          return result;
        }
        if (agentType === "gemini") {
          geminiCandidates.push({ pid, tty: normalizedTty });
        }
      }

      if (agentType === "gemini" && geminiCandidates.length > 0) {
        if (geminiCandidates.length === 1) {
          const only = geminiCandidates[0];
          const result = { pid: only.pid, tty: only.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found Gemini session ${sessionId.slice(0, 8)} via single process candidate: pid=${only.pid}`);
          return result;
        }

        // Gemini CLI may not expose session ids in argv; pick most recently started candidate.
        let newest: { pid: number; tty: string; startedAt: number } | null = null;
        for (const c of geminiCandidates) {
          try {
            const { stdout: startOut } = await execAsync(`ps -o lstart= -p ${c.pid}`);
            const startedAt = new Date(startOut.trim()).getTime();
            if (!isNaN(startedAt) && (!newest || startedAt > newest.startedAt)) {
              newest = { pid: c.pid, tty: c.tty, startedAt };
            }
          } catch {}
        }

        if (newest) {
          const result = { pid: newest.pid, tty: newest.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found Gemini session ${sessionId.slice(0, 8)} via newest process heuristic: pid=${newest.pid}`);
          return result;
        }

        const fallback = geminiCandidates[0];
        const result = { pid: fallback.pid, tty: fallback.tty, sessionId };
        cacheSessionProcess(sessionId, result);
        log(`Found Gemini session ${sessionId.slice(0, 8)} via fallback process candidate: pid=${fallback.pid}`);
        return result;
      }
    } catch {}

    // Strategy A2: Codex live-session matching by open JSONL file (works for non-resume iTerm sessions)
    if (agentType === "codex") {
      try {
        const { stdout } = await execAsync(`ps aux | grep -E 'codex' | grep -v grep | grep -v 'codecast'`);
        const lines = stdout.trim().split("\n");
        const candidates: Array<{ pid: number; tty: string; tmuxTarget: string | null }> = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length < 7) continue;
          const pid = parseInt(parts[1], 10);
          const tty = parts[6];
          if (isNaN(pid) || tty === "?" || tty === "??") continue;

          try {
            const { stdout: lsofOut } = await execAsync(`lsof -p ${pid} 2>/dev/null`);
            if (!hasCodexSessionFileOpen(lsofOut, sessionId)) continue;
            const normalizedTty = normalizeTty(tty);
            let tmuxTarget: string | null = null;
            try {
              tmuxTarget = await findTmuxPaneForTty(normalizedTty);
            } catch {}
            candidates.push({ pid, tty: normalizedTty, tmuxTarget });
          } catch {}
        }

        if (candidates.length > 0) {
          const preferred = choosePreferredCodexCandidate(candidates);
          if (!preferred) return null;
          const result = { pid: preferred.pid, tty: preferred.tty, sessionId };
          cacheSessionProcess(sessionId, result, preferred.tmuxTarget || undefined);
          if (preferred.tmuxTarget) {
            log(`Found codex session ${sessionId.slice(0, 8)} via lsof session file match (tmux): pid=${preferred.pid}`);
          } else {
            log(`Found codex session ${sessionId.slice(0, 8)} via lsof session file match (non-tmux preferred): pid=${preferred.pid}`);
          }
          return result;
        }

        if (codexResumeCandidates.length > 0) {
          const candidate = codexResumeCandidates[0];
          const result = { pid: candidate.pid, tty: candidate.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found codex session ${sessionId.slice(0, 8)} via resume process fallback: pid=${candidate.pid}`);
          return result;
        }
      } catch {}
    }

    // Strategy B: Scan tmux sessions named cc-resume-* or codecast-*
    try {
      const { stdout: tmuxList } = await execAsync("tmux list-sessions -F '#{session_name}' 2>/dev/null");
      const shortId = sessionId.slice(0, 8);
      for (const tmuxName of tmuxList.trim().split("\n")) {
        if (!tmuxName.includes(shortId)) continue;
        // Get the pane TTY for this tmux session
        try {
          const { stdout: paneInfo } = await execAsync(`tmux list-panes -t '${tmuxName}' -F '#{pane_tty} #{pane_pid}' 2>/dev/null`);
          const paneLine = paneInfo.trim().split("\n")[0];
          if (paneLine) {
            const [paneTty, panePidStr] = paneLine.split(" ");
            const panePid = parseInt(panePidStr, 10);
            if (!isNaN(panePid) && paneTty) {
              try {
                const { stdout: childPs } = await execAsync(`pgrep -P ${panePid} -f ${binaryPattern} 2>/dev/null`);
                const childPid = parseInt(childPs.trim().split("\n")[0]?.trim(), 10);
                if (!isNaN(childPid)) {
                  const result = { pid: childPid, tty: normalizeTty(paneTty), sessionId };
                  cacheSessionProcess(sessionId, result, `${tmuxName}:0.0`);
                  log(`Found session ${sessionId.slice(0, 8)} via tmux session ${tmuxName}: pid=${childPid}`);
                  return result;
                }
                // No agent child process found - check if pane shell itself is an agent
                if (isAgentProcess(panePid)) {
                  const result = { pid: panePid, tty: normalizeTty(paneTty), sessionId };
                  cacheSessionProcess(sessionId, result, `${tmuxName}:0.0`);
                  log(`Found session ${sessionId.slice(0, 8)} via tmux session ${tmuxName}: pid=${panePid} (direct)`);
                  return result;
                }
                log(`Tmux session ${tmuxName} has no active agent (shell pid=${panePid}), skipping`);
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}

    // Strategy C: CWD-based matching for non-resumed sessions
    const jsonlPath = findSessionJsonlPath(sessionId);
    if (jsonlPath) {
      const jsonlStat = fs.statSync(jsonlPath);
      const recentlyModified = Date.now() - jsonlStat.mtimeMs < 60_000;

      if (recentlyModified) {
        // Determine the project directory from the JSONL content
        const jsonlContent = fs.readFileSync(jsonlPath, "utf-8").slice(0, 5000);
        const projectCwd = extractCwd(jsonlContent) || (agentType === "codex" ? extractCodexCwd(jsonlContent) : null);

        if (projectCwd) {
          try {
            const psPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "/claude\\b|claude-code";
            const { stdout: psOut } = await execAsync(`ps aux | grep -E '${psPattern}' | grep -v grep | grep -v 'codecast'`);
            const candidates: Array<{ pid: number; tty: string }> = [];

            for (const line of psOut.trim().split("\n")) {
              if (!line.trim()) continue;
              const parts = line.trim().split(/\s+/);
              if (parts.length < 7) continue;
              const pid = parseInt(parts[1], 10);
              const tty = parts[6];
              if (isNaN(pid) || tty === "?" || tty === "??") continue;

              // Check CWD of this process
              try {
                const { stdout: lsofOut } = await execAsync(`lsof -d cwd -a -p ${pid} -F n 2>/dev/null`);
                const cwdLine = lsofOut.split("\n").find(l => l.startsWith("n"));
                if (cwdLine) {
                  const processCwd = cwdLine.slice(1);
                  // Match if CWD is the project dir or a subdirectory of it
                  if (processCwd === projectCwd || processCwd.startsWith(projectCwd + "/")) {
                    candidates.push({ pid, tty: normalizeTty(tty) });
                  }
                }
              } catch {}
            }

            // Filter out candidates already cached for a different session
            const unclaimed = candidates.filter(c => {
              for (const [cachedSid, cachedInfo] of sessionProcessCache) {
                if (cachedSid !== sessionId && cachedInfo.pid === c.pid) return false;
              }
              return true;
            });

            if (unclaimed.length === 1) {
              const result = { pid: unclaimed[0].pid, tty: unclaimed[0].tty, sessionId };
              cacheSessionProcess(sessionId, result);
              log(`Found session ${sessionId.slice(0, 8)} via CWD match: pid=${unclaimed[0].pid}, cwd=${projectCwd}`);
              return result;
            } else if (unclaimed.length > 1) {
              // Disambiguate using JSONL birth time vs process start time
              const jsonlBirthMs = jsonlStat.birthtimeMs;
              let bestCandidate: { pid: number; tty: string } | null = null;
              let bestDelta = Infinity;

              for (const c of unclaimed) {
                try {
                  const { stdout: etimeOut } = await execAsync(`ps -o lstart= -p ${c.pid}`);
                  const processStart = new Date(etimeOut.trim()).getTime();
                  const delta = Math.abs(processStart - jsonlBirthMs);
                  if (delta < bestDelta) {
                    bestDelta = delta;
                    bestCandidate = c;
                  }
                } catch {}
              }

              if (bestCandidate && bestDelta < 300_000) {
                const result = { pid: bestCandidate.pid, tty: bestCandidate.tty, sessionId };
                cacheSessionProcess(sessionId, result);
                log(`Found session ${sessionId.slice(0, 8)} via CWD+timing match: pid=${bestCandidate.pid}, delta=${Math.round(bestDelta / 1000)}s`);
                return result;
              }
              log(`CWD match found ${unclaimed.length} unclaimed candidates for ${sessionId.slice(0, 8)}, could not disambiguate`);
            } else {
              log(`CWD match found ${candidates.length} candidates for ${sessionId.slice(0, 8)} but all claimed by other sessions`);
            }
          } catch {}
        }
      }
    }

    return null;
  } catch (err) {
    log(`Error finding Claude session process: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function findTmuxPaneForTty(tty: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("tmux list-panes -a -F '#{pane_tty} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null");
    const normalizedTty = normalizeTty(tty);

    for (const line of stdout.trim().split("\n")) {
      const [paneTty, target] = line.split(" ");
      if (paneTty === normalizedTty && target) {
        return target;
      }
    }
    return null;
  } catch {
    return null;
  }
}

type PollMessage = { keys?: string[]; steps?: Array<{ key: string; text?: string }>; text?: string; display?: string };

function parsePollMessage(content: string): PollMessage | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__cc_poll && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps))) return parsed;
  } catch {}
  return null;
}

function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function tmuxPromptStillHasInput(paneContent: string, input: string): boolean {
  const normalizedInput = normalizePromptText(input);
  if (!normalizedInput) return false;
  const lines = paneContent.split("\n");
  const recent = lines.slice(-80).join("\n");
  const lastPromptIndex = recent.lastIndexOf("❯");
  if (lastPromptIndex === -1) return false;
  const fromPrompt = recent.slice(lastPromptIndex);
  return normalizePromptText(fromPrompt).includes(normalizedInput);
}

const tmuxTargetLocks = new Map<string, Promise<void>>();

async function withTmuxLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const baseTarget = target.split(":")[0];
  while (tmuxTargetLocks.has(baseTarget)) {
    await tmuxTargetLocks.get(baseTarget);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  tmuxTargetLocks.set(baseTarget, lock);
  try {
    return await fn();
  } finally {
    tmuxTargetLocks.delete(baseTarget);
    resolve!();
  }
}

async function injectViaTmux(target: string, content: string): Promise<void> {
  return withTmuxLock(target, () => injectViaTmuxInner(target, content));
}

async function injectViaTmuxInner(target: string, content: string): Promise<void> {
  const poll = parsePollMessage(content);
  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
    for (const step of steps) {
      await execAsync(`tmux send-keys -t '${target}' '${step.key}'`);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (step.text) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const escaped = step.text.replace(/'/g, "'\\''");
        await execAsync(`tmux send-keys -t '${target}' -l '${escaped}'`);
        await new Promise(resolve => setTimeout(resolve, 150));
        await execAsync(`tmux send-keys -t '${target}' Enter`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (poll.text) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const escaped = poll.text.replace(/'/g, "'\\''");
      await execAsync(`tmux send-keys -t '${target}' -l '${escaped}'`);
      await new Promise(resolve => setTimeout(resolve, 150));
      await execAsync(`tmux send-keys -t '${target}' Enter`);
    }
    log(`Injected poll response via tmux to ${target}`);
    return;
  }
  const sanitized = content.replace(/\r?\n/g, " ");

  // Check if there's a blocking dialog and dismiss it first
  try {
    const { stdout: preCheck } = await execAsync(`tmux capture-pane -p -J -t '${target}' -S -5`);
    if (/Press enter to continue|Update available/i.test(preCheck) && !/❯/.test(preCheck.split("\n").slice(-5).join("\n"))) {
      log(`Clearing blocking dialog before inject to ${target}`);
      await execAsync(`tmux send-keys -t '${target}' Enter`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch {}

  const id = `cc-${process.pid}-${Date.now()}`;
  const tmpFile = `/tmp/${id}`;
  try {
    fs.writeFileSync(tmpFile, sanitized);
    await execAsync(`tmux load-buffer -b '${id}' '${tmpFile}'`);
    await execAsync(`tmux paste-buffer -t '${target}' -b '${id}' -d`);
  } catch (err) {
    const escaped = sanitized.replace(/'/g, "'\\''");
    await execAsync(`tmux send-keys -t '${target}' -l '${escaped}'`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  // Scale capture range based on message length (long messages wrap many lines)
  const captureLines = Math.max(30, Math.ceil(sanitized.length / 60) + 10);
  const contentPrefix = sanitized.slice(0, 40);

  // Wait for paste to appear in the pane
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const { stdout: echoCheck } = await execAsync(`tmux capture-pane -p -J -t '${target}' -S -${captureLines}`);
      if (tmuxPromptStillHasInput(echoCheck, contentPrefix)) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  // Scale delay before Enter based on message length
  const enterDelay = Math.max(200, Math.min(1000, Math.ceil(sanitized.length / 100) * 50));
  await new Promise(resolve => setTimeout(resolve, enterDelay));
  await execAsync(`tmux send-keys -t '${target}' Enter`);

  // Verify the message was submitted - if text is still in the input, retry Enter
  // For long messages, check if the agent started processing (prompt changes from input to working)
  for (let retry = 0; retry < 5; retry++) {
    await new Promise(resolve => setTimeout(resolve, 600));
    try {
      const { stdout: postCheck } = await execAsync(`tmux capture-pane -p -J -t '${target}' -S -${captureLines}`);
      // Check if the input text is still there (message not yet submitted)
      if (tmuxPromptStillHasInput(postCheck, contentPrefix)) {
        log(`Enter may not have submitted (retry ${retry + 1}), sending Enter again to ${target}`);
        await execAsync(`tmux send-keys -t '${target}' Enter`);
      } else {
        // Also check if we can see any sign of activity (prompt gone or spinner visible)
        const lastLines = postCheck.split("\n").slice(-5).join("\n");
        const hasPrompt = /❯/.test(lastLines);
        const hasActivity = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|●|thinking|Bash|Read|Edit|Write|Glob|Grep/.test(lastLines);
        if (hasActivity || !hasPrompt) {
          break;
        }
        // Prompt visible but no text - could mean submitted or could mean text scrolled off
        // If the prompt is clean (no text after ❯), likely submitted
        const promptLine = lastLines.split("\n").find(l => l.includes("❯"));
        if (promptLine) {
          const afterPrompt = promptLine.slice(promptLine.indexOf("❯") + 1).trim();
          if (!afterPrompt) break;
        }
        break;
      }
    } catch { break; }
  }

  log(`Injected via tmux to ${target}`);
}

async function injectViaIterm(tty: string, content: string): Promise<void> {
  const normalizedTty = normalizeTty(tty);
  const poll = parsePollMessage(content);

  let scriptContent: string;
  let scriptArgs: string;

  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
    const stepActions = steps.map((step, i) => {
      const lines = [`            tell s to write text "${step.key}" without newline`];
      if (step.text) {
        const escapedText = step.text.replace(/"/g, '\\"');
        lines.push("            delay 0.5");
        lines.push(`            tell s to write text "${escapedText}" without newline`);
        lines.push("            delay 0.15");
        lines.push(`            tell s to write text ""`);
      }
      if (i < steps.length - 1) lines.push("            delay 0.5");
      return lines.join("\n");
    }).join("\n");
    const keyActions = stepActions;
    const textAction = poll.text
      ? `\n            delay 0.3\n            tell s to write text "${poll.text.replace(/"/g, '\\"')}" without newline\n            delay 0.15\n            tell s to write text ""`
      : "";
    scriptContent = `on run argv
  set targetTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
${keyActions}${textAction}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
    scriptArgs = `'${normalizedTty}'`;
  } else {
    scriptContent = `on run argv
  set msgText to item 1 of argv
  set targetTty to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
            tell s to write text msgText without newline
            delay 0.15
            tell s to write text ""
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
    const escapedContent = content.replace(/'/g, "'\\''");
    scriptArgs = `'${escapedContent}' '${normalizedTty}'`;
  }

  const tmpFile = path.join(CONFIG_DIR, "iterm-inject.scpt");
  fs.writeFileSync(tmpFile, scriptContent);
  try {
    const { stdout } = await execAsync(`osascript "${tmpFile}" ${scriptArgs}`);
    if (stdout.trim() === "not_found") {
      throw new Error(`iTerm2 session not found for TTY ${normalizedTty}`);
    }
    log(`Injected ${poll ? "poll response" : "message"} via iTerm2 for TTY ${normalizedTty}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

type SessionFileInfo = { path: string; agentType: "claude" | "codex" | "gemini" };

function findSessionJsonlPath(sessionId: string): string | null {
  return findSessionFile(sessionId)?.path ?? null;
}

function findSessionFile(sessionId: string): SessionFileInfo | null {
  // Claude sessions: ~/.claude/projects/<hash>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (fs.existsSync(claudeProjectsDir)) {
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const dir of projectDirs) {
      const jsonlPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) return { path: jsonlPath, agentType: "claude" };
    }
  }

  // Codex sessions: ~/.codex/sessions/YYYY/MM/DD/<name>-<timestamp>-<sessionId>.jsonl
  const codexSessionsDir = path.join(process.env.HOME || "", ".codex", "sessions");
  if (fs.existsSync(codexSessionsDir)) {
    try {
      const findCodex = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findCodex(fullPath);
            if (found) return found;
          } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
            return fullPath;
          }
        }
        return null;
      };
      const codexPath = findCodex(codexSessionsDir);
      if (codexPath) return { path: codexPath, agentType: "codex" };
    } catch {}
  }

  // Gemini sessions: ~/.gemini/tmp/<hash>/chats/<sessionId>.json
  const geminiTmpDir = path.join(process.env.HOME || "", ".gemini", "tmp");
  if (fs.existsSync(geminiTmpDir)) {
    try {
      const projectDirs = fs.readdirSync(geminiTmpDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
      for (const dir of projectDirs) {
        const chatsDir = path.join(geminiTmpDir, dir, "chats");
        if (!fs.existsSync(chatsDir)) continue;
        const jsonPath = path.join(chatsDir, `${sessionId}.json`);
        if (fs.existsSync(jsonPath)) return { path: jsonPath, agentType: "gemini" };
      }
    } catch {}
  }

  return null;
}

const resumeSessionCache = new Map<string, string>();
const resumeHeartbeatIntervals = new Map<string, NodeJS.Timeout>();

// Codex tmux pane monitoring for permission prompts
const codexPermissionPollers = new Map<string, NodeJS.Timeout>();
const codexPermissionPending = new Set<string>(); // sessionIds currently waiting for permission decision

const CODEX_PERMISSION_PATTERNS = [
  /Would you like to run the following command\?/,
  /Press enter to confirm or esc to cancel/,
  /Do you want to proceed\?/,
];

function detectCodexPermissionFromPane(paneContent: string): { reason: string; command: string } | null {
  if (!CODEX_PERMISSION_PATTERNS.some(p => p.test(paneContent))) return null;

  let reason = "";
  let command = "";
  const lines = paneContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("Reason:")) {
      reason = line.replace(/.*Reason:\s*/, "").trim();
    }
    if (line.startsWith("$ ")) {
      command = line.slice(2).trim();
      // Collect continuation lines (long commands wrap)
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("1.") && !next.startsWith("2.") && !next.startsWith("3.") && !next.startsWith("Press ")) {
          command += " " + next;
        } else break;
      }
    }
  }

  return { reason: reason || "Command approval requested", command: command.slice(0, 300) };
}

function startCodexPermissionPoller(sessionId: string, tmuxSession: string, conversationId: string, syncService: SyncService): void {
  if (codexPermissionPollers.has(sessionId)) return;

  const interval = setInterval(async () => {
    if (codexPermissionPending.has(sessionId)) return; // already waiting for decision

    try {
      const { stdout: paneContent } = await execAsync(`tmux capture-pane -p -J -t '${tmuxSession}' -S -30 2>/dev/null`);
      const prompt = detectCodexPermissionFromPane(paneContent);
      if (!prompt) return;

      codexPermissionPending.add(sessionId);
      log(`Codex permission prompt detected in tmux for session ${sessionId.slice(0, 8)}: ${prompt.reason.slice(0, 100)}`);

      sendAgentStatus(syncService, conversationId, sessionId, "permission_blocked");

      const preview = truncateForNotification(
        `${prompt.command || prompt.reason}`, 200
      );
      syncService.createSessionNotification({
        conversation_id: conversationId,
        type: "permission_request",
        title: "codecast - Permission needed",
        message: preview,
      }).catch(() => {});

      const permissionPrompt = {
        tool_name: "exec_command",
        arguments_preview: prompt.command || prompt.reason,
      };

      handlePermissionRequest(syncService, conversationId, sessionId, permissionPrompt, log)
        .then(async (decision) => {
          if (decision) {
            // Codex uses Enter to approve, Escape to deny
            const key = decision.approved ? "Enter" : "Escape";
            log(`Injecting Codex permission '${key}' for session ${sessionId.slice(0, 8)}`);
            try {
              await execAsync(`tmux send-keys -t '${tmuxSession}' ${key}`);
            } catch (err) {
              log(`Failed to inject Codex permission key: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          sendAgentStatus(syncService, conversationId, sessionId, "working");
          codexPermissionPending.delete(sessionId);
        })
        .catch((err) => {
          log(`Codex permission handling error: ${err instanceof Error ? err.message : String(err)}`);
          codexPermissionPending.delete(sessionId);
        });
    } catch {
      // tmux session may have ended
    }
  }, 3000);

  codexPermissionPollers.set(sessionId, interval);
  log(`Started Codex permission poller for session ${sessionId.slice(0, 8)} on tmux ${tmuxSession}`);
}

function stopCodexPermissionPoller(sessionId: string): void {
  const interval = codexPermissionPollers.get(sessionId);
  if (interval) {
    clearInterval(interval);
    codexPermissionPollers.delete(sessionId);
    codexPermissionPending.delete(sessionId);
  }
}

type StartedSessionInfo = {
  tmuxSession: string;
  projectPath: string;
  startedAt: number;
  agentType: "claude" | "codex" | "gemini";
};

const startedSessionTmux = new Map<string, StartedSessionInfo>();
const STARTED_SESSION_TTL_MS = 5 * 60 * 1000;

const UUID_JSONL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

async function discoverAndLinkSession(
  conversationId: string,
  tmuxSession: string,
  cwd: string,
): Promise<void> {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const projectDirName = cwd.replace(/\//g, "-");
  const projectDir = path.join(claudeProjectsDir, projectDirName);

  const existingFiles = new Set<string>();
  if (fs.existsSync(projectDir)) {
    for (const f of fs.readdirSync(projectDir)) {
      if (UUID_JSONL_RE.test(f)) existingFiles.add(f);
    }
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!startedSessionTmux.has(conversationId)) {
      log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked by watcher, stopping discovery`);
      return;
    }
    if (!fs.existsSync(projectDir)) continue;
    for (const f of fs.readdirSync(projectDir)) {
      const m = f.match(UUID_JSONL_RE);
      if (!m || existingFiles.has(f)) continue;
      const sessionId = m[1];
      const cache = readConversationCache();
      if (cache[sessionId]) continue;
      const reverseCache = buildReverseConversationCache(cache);
      if (reverseCache[conversationId]) {
        log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked to ${reverseCache[conversationId].slice(0, 8)} by another writer`);
        startedSessionTmux.delete(conversationId);
        return;
      }
      cache[sessionId] = conversationId;
      saveConversationCache(cache);
      if (syncServiceRef) {
        syncServiceRef.updateSessionId(conversationId, sessionId).catch(() => {});
        syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {});
      }
      startedSessionTmux.delete(conversationId);
      log(`[DISCOVER] Linked session ${sessionId.slice(0, 8)} to conversation ${conversationId.slice(0, 12)} via JSONL discovery`);
      return;
    }
  }
  log(`[DISCOVER] Timed out discovering session for conversation ${conversationId.slice(0, 12)}`);
}

const planHandoffChildren = new Map<string, string>();
const planHandoffChecked = new Set<string>();

// Track subagent sessions whose parent hasn't been cached yet: childSessionId -> parentSessionId
const pendingSubagentParents = new Map<string, string>();

interface CachedProcessInfo {
  pid: number;
  tty: string;
  tmuxTarget?: string;
  lastVerified: number;
}

const sessionProcessCache = new Map<string, CachedProcessInfo>();
const PROCESS_CACHE_TTL_MS = 30_000;

function cacheSessionProcess(sessionId: string, info: ClaudeSessionInfo, tmuxTarget?: string): void {
  sessionProcessCache.set(sessionId, {
    pid: info.pid,
    tty: info.tty,
    tmuxTarget,
    lastVerified: Date.now(),
  });
}

async function getCachedSessionProcess(sessionId: string): Promise<ClaudeSessionInfo | null> {
  const cached = sessionProcessCache.get(sessionId);
  if (!cached) return null;
  if (Date.now() - cached.lastVerified > PROCESS_CACHE_TTL_MS) {
    if (!isProcessRunning(cached.pid) || !isAgentProcess(cached.pid)) {
      sessionProcessCache.delete(sessionId);
      return null;
    }
    cached.lastVerified = Date.now();
  }
  return { pid: cached.pid, tty: cached.tty, sessionId };
}

function validateProcessCache(): void {
  for (const [sessionId, cached] of sessionProcessCache) {
    if (!isProcessRunning(cached.pid) || !isAgentProcess(cached.pid)) {
      sessionProcessCache.delete(sessionId);
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveSessionId(filePath: string): string {
  const name = path.basename(filePath, ".jsonl");
  if (UUID_RE.test(name)) return name;
  try {
    const head = fs.readFileSync(filePath, "utf-8").slice(0, 4096);
    const m = head.match(/"sessionId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    if (m) return m[1];
  } catch {}
  return name;
}

function slugify(text: string, maxLen = 30): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

async function autoResumeSession(sessionId: string, content: string, titleCache: TitleCache, nonInteractive = false, cwdOverride?: string, conversationId?: string): Promise<boolean> {
  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) {
    log(`Cannot auto-resume: session file not found for ${sessionId.slice(0, 8)}`);
    return false;
  }

  const { path: jsonlPath, agentType } = sessionFile;
  const jsonlContent = fs.readFileSync(jsonlPath, "utf-8").slice(0, 5000);
  const config = readConfig();

  let cwd: string;
  let resumeCmd: string;
  const shortId = sessionId.slice(0, 8);
  const title = titleCache[sessionId] || extractSummaryTitle(jsonlContent);
  const slug = title ? slugify(title) : "";

  const validOverride = cwdOverride && fs.existsSync(cwdOverride) ? cwdOverride : undefined;

  if (agentType === "codex") {
    cwd = validOverride || extractCodexCwd(jsonlContent) || process.env.HOME || "/tmp";
    let extraFlags = config?.codex_args || "";
    const permFlags = getPermissionFlags("codex", config);
    if (permFlags) extraFlags = extraFlags ? extraFlags + " " + permFlags : permFlags;
    resumeCmd = `codex resume ${sessionId}${extraFlags ? " " + extraFlags : ""}`;
  } else if (agentType === "gemini") {
    cwd = validOverride || process.env.HOME || "/tmp";
    resumeCmd = `gemini --resume latest`;
  } else {
    cwd = validOverride || extractCwd(jsonlContent) || process.env.HOME || "/tmp";
    let extraFlags = config?.claude_args || "";
    try {
      const firstUserLine = jsonlContent.split("\n").find(l => l.includes('"type":"user"'));
      if (firstUserLine) {
        const parsed = JSON.parse(firstUserLine);
        if (parsed.permissionMode === "bypassPermissions" && !extraFlags.includes("--dangerously-skip-permissions")) {
          extraFlags = extraFlags ? extraFlags + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
        }
      }
    } catch {}
    const permFlags = getPermissionFlags("claude", config);
    if (permFlags && !extraFlags.includes("--dangerously-skip-permissions") && !extraFlags.includes("--permission-mode")) {
      extraFlags = extraFlags ? extraFlags + " " + permFlags : permFlags;
    }
    resumeCmd = `claude --resume ${sessionId}${extraFlags ? " " + extraFlags : ""}`;
  }

  const prefix = agentType === "codex" ? "cx" : agentType === "gemini" ? "gm" : "cc";
  const tmuxSession = slug ? `${prefix}-resume-${slug}-${shortId}` : `${prefix}-resume-${shortId}`;

  try {
    try { await execAsync(`tmux kill-session -t '${tmuxSession}' 2>/dev/null`); } catch {}

    await execAsync(`tmux new-session -d -s '${tmuxSession}' -c '${cwd}'`);

    // For non-interactive mode (materialized sessions), use -p flag to process message and exit
    if (nonInteractive && agentType === "claude") {
      const tmpFile = path.join(os.tmpdir(), `codecast-msg-${shortId}.txt`);
      fs.writeFileSync(tmpFile, content);
      const nonInteractiveCmd = `env -u CLAUDECODE ${resumeCmd} -p "$(cat '${tmpFile}')" --output-format stream-json --verbose; rm -f '${tmpFile}'`;
      await execAsync(`tmux send-keys -t '${tmuxSession}' '${nonInteractiveCmd.replace(/'/g, "'\\''")}'  Enter`);
      log(`Auto-resumed ${agentType} session ${shortId} in tmux ${tmuxSession} (non-interactive), cwd=${cwd}`);
      resumeSessionCache.set(sessionId, tmuxSession);
      if (syncServiceRef) {
        syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {});
        syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {});
      }
      return true;
    }

    // Prefix with env -u CLAUDECODE to prevent "cannot launch inside another Claude Code session" error
    const safeResumeCmd = `env -u CLAUDECODE ${resumeCmd}`;
    await execAsync(`tmux send-keys -t '${tmuxSession}' '${safeResumeCmd.replace(/'/g, "'\\''")}'  Enter`);

    log(`Auto-resumed ${agentType} session ${shortId} in tmux ${tmuxSession}, cwd=${cwd}, cmd=${resumeCmd}`);

    // Register managed session early so the web UI can show "Connected" status
    resumeSessionCache.set(sessionId, tmuxSession);
    if (syncServiceRef) {
      syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {});
      syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {});
      const existing = resumeHeartbeatIntervals.get(sessionId);
      if (existing) clearInterval(existing);
      const interval = setInterval(() => {
        syncServiceRef!.heartbeatManagedSession(sessionId).catch(() => {});
      }, 30000);
      resumeHeartbeatIntervals.set(sessionId, interval);

      // Start tmux pane monitoring for Codex permission prompts
      if (agentType === "codex" && conversationId) {
        startCodexPermissionPoller(sessionId, tmuxSession, conversationId, syncServiceRef);
      }
    }

    // Poll for agent readiness - check every 250ms, bail on fatal errors
    // Must see the input prompt (❯) to know the TUI is ready for input
    const fatalErrors = [
      "cannot be launched inside another",
      "command not found",
      "No such file or directory",
      "Session not found",
      "No conversation found",
      "is not an object",
      "ENOENT",
    ];
    const promptPattern = /❯/;
    const startTime = Date.now();
    let ready = false;

    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const { stdout: paneContent } = await execAsync(`tmux capture-pane -p -J -t '${tmuxSession}' -S -20`);
        if (fatalErrors.some(e => paneContent.includes(e))) {
          log(`Auto-resume verification failed for ${shortId}: agent did not start. Pane: ${paneContent.slice(0, 300)}`);
          try { await execAsync(`tmux kill-session -t '${tmuxSession}' 2>/dev/null`); } catch {}
          return false;
        }
        if (promptPattern.test(paneContent) && await isTmuxAgentAlive(tmuxSession)) {
          log(`Agent ${shortId} ready (prompt visible) after ${Date.now() - startTime}ms`);
          ready = true;
          break;
        }
      } catch {}
    }
    if (!ready) {
      log(`Agent ${shortId} startup timed out after ${Date.now() - startTime}ms, proceeding anyway`);
    }

    // Inject the message (skip if empty — resume-only mode)
    if (content) {
      await injectViaTmux(tmuxSession + ":0.0", content);
      log(`Injected message to auto-resumed ${agentType} session ${shortId}`);
    } else {
      log(`Auto-resumed ${agentType} session ${shortId} (no message to inject)`);
    }

    return true;
  } catch (err) {
    log(`Auto-resume failed for ${agentType} ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const repairAttempts = new Map<string, number>();
const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;

async function repairAndResumeSession(
  sessionId: string,
  content: string,
  titleCache: TitleCache,
  nonInteractive: boolean,
  cwdOverride?: string,
  conversationId?: string
): Promise<boolean> {
  const lastAttempt = repairAttempts.get(sessionId);
  if (lastAttempt && Date.now() - lastAttempt < REPAIR_COOLDOWN_MS) {
    log(`Repair cooldown active for ${sessionId.slice(0, 8)}, skipping`);
    return false;
  }
  repairAttempts.set(sessionId, Date.now());

  const config = readConfig();
  if (!config?.convex_url || !config?.auth_token) {
    log(`Cannot repair session: missing config`);
    return false;
  }

  const convId = conversationId || (() => {
    const cache = readConversationCache();
    return cache[sessionId];
  })();

  if (!convId) {
    log(`Cannot repair ${sessionId.slice(0, 8)}: no conversation_id found`);
    return false;
  }

  const siteUrl = config.convex_url.replace(".cloud", ".site");

  // Strategy 1: Regenerate JSONL from Convex (cleanest)
  try {
    log(`Repairing session ${sessionId.slice(0, 8)} via Convex regeneration...`);
    const exportData = await fetchExport(siteUrl, config.auth_token!, convId);
    if (exportData.messages.length === 0) {
      log(`Repair aborted for ${sessionId.slice(0, 8)}: conversation has 0 messages, nothing to resume`);
      return false;
    }
    const sessionFile = findSessionFile(sessionId);
    const isCodexSession = sessionFile?.agentType === "codex";

    let jsonl: string;
    let tailMessages: number | undefined;
    if (isCodexSession) {
      ({ jsonl } = generateCodexJsonl(exportData, { sessionId }));
    } else {
      const TOKEN_BUDGET = 100_000;
      tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
      ({ jsonl } = generateClaudeCodeJsonl(exportData, { tailMessages }));
    }

    const projectPath = cwdOverride || exportData.conversation.project_path || undefined;

    // Backup original and write repaired
    if (sessionFile) {
      const bakPath = sessionFile.path + ".bak";
      if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(sessionFile.path, bakPath);
      }
      fs.writeFileSync(sessionFile.path, jsonl);
      if (isCodexSession) {
        log(`Repaired Codex JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} messages)`);
      } else {
        log(`Repaired JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} messages, tail=${tailMessages})`);
      }
    } else {
      if (isCodexSession) {
        writeCodexSession(jsonl, sessionId, "rollout");
        log(`Wrote new Codex session file for ${sessionId.slice(0, 8)}`);
      } else {
        writeClaudeCodeSession(jsonl, sessionId, projectPath);
        log(`Wrote new session file for ${sessionId.slice(0, 8)}`);
      }
    }

    const resumed = await autoResumeSession(sessionId, content, titleCache, nonInteractive, cwdOverride || projectPath, convId);
    if (resumed) {
      log(`Repair + resume succeeded for ${sessionId.slice(0, 8)}`);
      return true;
    }
  } catch (err) {
    log(`Convex regeneration failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Strategy 2: Surgical JSONL cleanup - remove entries that crash Claude CLI
  try {
    const sessionFile = findSessionFile(sessionId);
    if (!sessionFile) return false;

    log(`Attempting surgical JSONL cleanup for ${sessionId.slice(0, 8)}...`);
    const lines = fs.readFileSync(sessionFile.path, "utf-8").split("\n").filter(l => l.trim());
    const cleanLines: string[] = [];
    let removed = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          const hasCorruptToolResult = content.some((c: any) =>
            c.type === "tool_result" && c.content && typeof c.content === "string" &&
            (c.content.includes("is not an object") || c.content.includes("undefined"))
          );
          if (hasCorruptToolResult) {
            removed++;
            continue;
          }
        }
        cleanLines.push(line);
      } catch {
        cleanLines.push(line);
      }
    }

    if (removed > 0) {
      const bakPath = sessionFile.path + ".bak";
      if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(sessionFile.path, bakPath);
      }
      fs.writeFileSync(sessionFile.path, cleanLines.join("\n") + "\n");
      log(`Surgical cleanup: removed ${removed} corrupt entries from ${sessionId.slice(0, 8)}`);

      const resumed = await autoResumeSession(sessionId, content, titleCache, nonInteractive, cwdOverride, convId);
      if (resumed) {
        log(`Surgical repair + resume succeeded for ${sessionId.slice(0, 8)}`);
        return true;
      }
    }
  } catch (err) {
    log(`Surgical cleanup failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return false;
}

async function postDeliveryHealthCheck(
  sessionId: string,
  conversationId: string,
  content: string,
  messageId: string,
  syncService: SyncService,
  titleCache: TitleCache,
  conversationCache: ConversationCache
): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 15000));

  const tmuxSession = resumeSessionCache.get(sessionId);
  if (!tmuxSession) return;

  try {
    await execAsync(`tmux has-session -t '${tmuxSession}' 2>/dev/null`);
  } catch {
    log(`Health check: tmux session ${tmuxSession} is dead after delivery for ${sessionId.slice(0, 8)}`);

    const repaired = await repairAndResumeSession(sessionId, content, titleCache, false, undefined, conversationId);
    if (repaired) {
      log(`Health check: repaired and re-delivered message for ${sessionId.slice(0, 8)}`);
      try { await syncService.setSessionError(conversationId); } catch {}
    } else {
      log(`Health check: repair failed for ${sessionId.slice(0, 8)}, retrying message delivery`);
      try {
        await syncService.retryMessage(messageId);
        await syncService.setSessionError(conversationId, "Session crashed — retrying message delivery");
      } catch {}
    }
    return;
  }

  // Session exists - check if agent process is still alive
  const alive = await isTmuxAgentAlive(tmuxSession);
  if (!alive) {
    log(`Health check: agent process dead in ${tmuxSession} for ${sessionId.slice(0, 8)}`);
    try { await execAsync(`tmux kill-session -t '${tmuxSession}' 2>/dev/null`); } catch {}
    resumeSessionCache.delete(sessionId);
    stopCodexPermissionPoller(sessionId);
    const hbInterval = resumeHeartbeatIntervals.get(sessionId);
    if (hbInterval) { clearInterval(hbInterval); resumeHeartbeatIntervals.delete(sessionId); }

    const repaired = await repairAndResumeSession(sessionId, content, titleCache, false, undefined, conversationId);
    if (repaired) {
      log(`Health check: repaired crashed session ${sessionId.slice(0, 8)}`);
      try { await syncService.setSessionError(conversationId); } catch {}
    } else {
      log(`Health check: repair failed for crashed session ${sessionId.slice(0, 8)}, retrying message delivery`);
      try {
        await syncService.retryMessage(messageId);
        await syncService.setSessionError(conversationId, "Session crashed — retrying message delivery");
      } catch {}
    }
  } else {
    log(`Health check: session ${sessionId.slice(0, 8)} is healthy`);
    try { await syncService.setSessionError(conversationId); } catch {}
  }
}

const materializeFailures = new Map<string, number>();
const materializeInFlight = new Map<string, Promise<string | null>>();
const materializedSessions = new Set<string>();
const MATERIALIZE_COOLDOWN_MS = 5 * 60 * 1000;

async function materializeSession(
  conversationId: string,
  conversationCache: ConversationCache,
  titleCache: TitleCache,
  syncService?: SyncService
): Promise<string | null> {
  const existing = materializeInFlight.get(conversationId);
  if (existing) return existing;

  const lastFail = materializeFailures.get(conversationId);
  if (lastFail && Date.now() - lastFail < MATERIALIZE_COOLDOWN_MS) {
    return null;
  }

  const config = readConfig();
  if (!config?.convex_url || !config?.auth_token) {
    log(`Cannot materialize session: missing convex_url or auth_token`);
    return null;
  }

  const siteUrl = config.convex_url.replace(".cloud", ".site");

  const promise = (async (): Promise<string | null> => {
    try {
      log(`Materializing session for conversation ${conversationId.slice(0, 12)}...`);
      const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
      if (exportData.messages.length === 0) {
        log(`Materialization skipped for ${conversationId.slice(0, 12)}: conversation has 0 messages`);
        return null;
      }

      const TOKEN_BUDGET = 100_000;
      const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
      const { jsonl, sessionId } = generateClaudeCodeJsonl(exportData, { tailMessages });
      const projectPath = exportData.conversation.project_path || undefined;
      writeClaudeCodeSession(jsonl, sessionId, projectPath);

      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      materializedSessions.add(sessionId);
      if (exportData.conversation.title) {
        titleCache[sessionId] = exportData.conversation.title;
        saveTitleCache(titleCache);
      }

      if (syncService) {
        syncService.updateSessionId(conversationId, sessionId).catch(() => {});
      }

      log(`Materialized session ${sessionId.slice(0, 8)} for conversation ${conversationId.slice(0, 12)} (${exportData.messages.length} messages, tail=${tailMessages})`);
      return sessionId;
    } catch (err) {
      log(`Failed to materialize session for ${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      materializeFailures.set(conversationId, Date.now());
      return null;
    } finally {
      materializeInFlight.delete(conversationId);
    }
  })();

  materializeInFlight.set(conversationId, promise);
  return promise;
}

async function downloadImage(storageId: string, syncService: SyncService): Promise<string | null> {
  const destPath = `/tmp/codecast/images/${storageId}.png`;
  if (fs.existsSync(destPath)) return destPath;

  const imageUrl = await syncService.getClient().query("images:getImageUrl" as any, { storageId });
  if (!imageUrl) return null;

  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
  return destPath;
}

async function deliverMessage(
  conversationId: string,
  content: string,
  conversationCache: ConversationCache,
  syncService: SyncService,
  messageId: string,
  titleCache: TitleCache
): Promise<boolean> {
  const childConvId = planHandoffChildren.get(conversationId);
  if (childConvId) {
    log(`Redirecting message from plan parent ${conversationId.slice(0, 12)} to child ${childConvId.slice(0, 12)}`);
    return deliverMessage(childConvId, content, conversationCache, syncService, messageId, titleCache);
  }

  const reverseCache = buildReverseConversationCache(conversationCache);
  let sessionId = reverseCache[conversationId];

  if (!sessionId) {
    // Try delivering via a recently started tmux session (from start_session command)
    const tryStartedTmux = async (entry: { tmuxSession: string }): Promise<boolean> => {
      try {
        await execAsync(`tmux has-session -t '${entry.tmuxSession}' 2>/dev/null`);
        let agentAlive = false;
        for (let i = 0; i < 40; i++) {
          if (await isTmuxAgentAlive(entry.tmuxSession)) { agentAlive = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!agentAlive) {
          log(`Started session tmux ${entry.tmuxSession} exists but agent is dead, falling through`);
          startedSessionTmux.delete(conversationId);
          return false;
        }
        await injectViaTmux(entry.tmuxSession + ":0.0", content);
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        log(`Delivered message to started session tmux ${entry.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
        return true;
      } catch (err) {
        log(`Started session tmux ${entry.tmuxSession} not reachable, falling through: ${err instanceof Error ? err.message : String(err)}`);
        startedSessionTmux.delete(conversationId);
        return false;
      }
    };

    const started = startedSessionTmux.get(conversationId);
    if (started && await tryStartedTmux(started)) return true;

    const freshCache = readConversationCache();
    const freshReverse = buildReverseConversationCache(freshCache);
    sessionId = freshReverse[conversationId];
    if (sessionId) {
      conversationCache[sessionId] = conversationId;
      log(`Found session ${sessionId.slice(0, 8)} for conversation ${conversationId.slice(0, 12)} via disk cache refresh`);
    } else if (!started) {
      // No session in any cache - wait for start_session command to populate startedSessionTmux
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 500));
        const justStarted = startedSessionTmux.get(conversationId);
        if (justStarted) {
          log(`Found startedSessionTmux for ${conversationId.slice(0, 12)} after ${(i + 1) * 500}ms wait`);
          if (await tryStartedTmux(justStarted)) return true;
          break;
        }
      }
      if (!sessionId) {
        log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
        sessionId = (await materializeSession(conversationId, conversationCache, titleCache, syncService))!;
        if (!sessionId) {
          log(`Cannot deliver: no local session and materialization failed for ${conversationId}`);
          return false;
        }
      }
    } else {
      log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
      sessionId = (await materializeSession(conversationId, conversationCache, titleCache, syncService))!;
      if (!sessionId) {
        log(`Cannot deliver: no local session and materialization failed for ${conversationId}`);
        return false;
      }
    }
  }

  // Determine session type for process discovery and auto-resume
  const isCursorSession = sessionId.startsWith("cursor-");
  const isGeminiSession = sessionId.startsWith("session-");

  // Cursor is an IDE, not a terminal process - can't inject
  if (isCursorSession) {
    log(`Session ${sessionId.slice(0, 20)} is a Cursor session, skipping delivery`);
    return false;
  }

  // Detect codex sessions by checking if the JSONL exists in codex paths
  let detectedType: "claude" | "codex" | "gemini" = isGeminiSession ? "gemini" : "claude";
  if (!isGeminiSession) {
    const sessionFile = findSessionFile(sessionId);
    if (sessionFile) detectedType = sessionFile.agentType;
  }

  log(`Delivering message to session ${sessionId.slice(0, 12)} (conversation ${conversationId.slice(0, 12)}, type=${detectedType})`);

  // Check if we have a cached tmux target from a previous auto-resume
  const cachedTmux = resumeSessionCache.get(sessionId);
  if (cachedTmux) {
    try {
      await execAsync(`tmux has-session -t '${cachedTmux}' 2>/dev/null`);
      if (!(await isTmuxAgentAlive(cachedTmux))) {
        log(`Cached tmux ${cachedTmux} has no live agent process, clearing cache`);
        resumeSessionCache.delete(sessionId);
        stopCodexPermissionPoller(sessionId);
        const hbInterval = resumeHeartbeatIntervals.get(sessionId);
        if (hbInterval) { clearInterval(hbInterval); resumeHeartbeatIntervals.delete(sessionId); }
        try { await execAsync(`tmux kill-session -t '${cachedTmux}' 2>/dev/null`); } catch {}
      } else {
        await injectViaTmux(cachedTmux, content);
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        syncService.setSessionError(conversationId).catch(() => {});
        return true;
      }
    } catch {
      resumeSessionCache.delete(sessionId);
      stopCodexPermissionPoller(sessionId);
      const hbInterval = resumeHeartbeatIntervals.get(sessionId);
      if (hbInterval) { clearInterval(hbInterval); resumeHeartbeatIntervals.delete(sessionId); }
    }
  }

  // Skip process matching for materialized sessions - they have no running process
  // and CWD+timing heuristics can false-positive match other sessions
  const isMaterialized = materializedSessions.has(sessionId);
  const proc = isMaterialized ? null : await findSessionProcess(sessionId, detectedType);

  if (proc) {
    // Verify the process is still an agent (not a leftover shell)
    if (!isAgentProcess(proc.pid)) {
      log(`Process ${proc.pid} for session ${sessionId.slice(0, 8)} is no longer an agent, clearing cache`);
      sessionProcessCache.delete(sessionId);
    } else {
      // Try tmux first (most reliable)
      const tmuxTarget = await findTmuxPaneForTty(proc.tty);
      if (tmuxTarget) {
        try {
          await injectViaTmux(tmuxTarget, content);
          await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
          return true;
        } catch (err) {
          log(`tmux injection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Try iTerm2 AppleScript
      try {
        await injectViaIterm(proc.tty, content);
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        return true;
      } catch (err) {
        log(`iTerm2 injection failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // All injection methods failed on a live process - fall back to auto-resume
      log(`All injection methods failed for active session ${sessionId.slice(0, 12)}, falling back to auto-resume`);
    }
  } else {
    log(`No running process for session ${sessionId.slice(0, 12)}`);
  }

  // Last resort: auto-resume in a new tmux session
  log(`Attempting auto-resume for session ${sessionId.slice(0, 8)}`);
  const resumed = await autoResumeSession(sessionId, content, titleCache, isMaterialized, undefined, conversationId);
  if (resumed) {
    materializedSessions.delete(sessionId);
    await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
    // Schedule non-blocking health check
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService, titleCache, conversationCache).catch(err => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  // Auto-resume failed - try repair (regenerate JSONL from Convex)
  log(`Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
  const repaired = await repairAndResumeSession(sessionId, content, titleCache, isMaterialized, undefined, conversationId);
  if (repaired) {
    materializedSessions.delete(sessionId);
    await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService, titleCache, conversationCache).catch(err => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  return false;
}

function isSyncPaused(): boolean {
  return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
}

async function repairProjectPaths(syncService: SyncService): Promise<void> {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return;

  log("Checking for project paths that need repair...");

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let repaired = 0;
  let checked = 0;

  for (const dir of projectDirs) {
    const dirPath = path.join(claudeProjectsDir, dir);
    const sessionFiles = fs.readdirSync(dirPath)
      .filter(f => f.endsWith(".jsonl") && f !== "sessions-index.json");

    const decodedPath = decodeProjectDirName(dir);
    const resolvedDir = decodedPath && fs.existsSync(decodedPath) ? decodedPath : null;

    for (const file of sessionFiles) {
      const filePath = path.join(dirPath, file);
      const sessionId = resolveSessionId(filePath);

      try {
        checked++;

        let projectPath: string | null = resolvedDir;
        if (!projectPath) {
          const content = fs.readFileSync(filePath, "utf-8").slice(0, 5000);
          projectPath = extractCwd(content) || null;
        }
        if (!projectPath) continue;

        const gitInfo = getGitInfo(projectPath);
        const result = await syncService.updateProjectPath(sessionId, projectPath, gitInfo?.root);
        if (result?.updated) {
          repaired++;
          log(`Repaired path for ${sessionId.slice(0, 8)}: ${projectPath}`);
        }
      } catch {
        // Skip files we can't read or sessions that don't exist in Convex
      }
    }
  }

  if (repaired > 0) {
    log(`Repaired ${repaired} project paths (checked ${checked})`);
  }
}

async function waitForConfig(): Promise<{ config: Config; convexUrl: string }> {
  const checkInterval = 30000;

  while (true) {
    const config = readConfig();
    if (config?.user_id) {
      const convexUrl = config.convex_url || process.env.CONVEX_URL;
      if (convexUrl) {
        return { config, convexUrl };
      }
    }
    log("Waiting for configuration... (run 'codecast auth' to set up)");
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isTmuxAgentAlive(tmuxSession: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -t '${tmuxSession}' -F '#{pane_pid}' 2>/dev/null`
    );
    const panePid = stdout.trim();
    if (!panePid) return false;
    await execAsync(`pgrep -P ${panePid}`);
    return true;
  } catch {
    return false;
  }
}

function isAgentProcess(pid: number): boolean {
  try {
    const comm = execSync(`ps -o comm= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (!comm) return false;
    const agentPatterns = ["claude", "codex", "gemini", "node", "bun", "deno"];
    const lower = comm.toLowerCase();
    return agentPatterns.some(p => lower.includes(p));
  } catch {
    return false;
  }
}

let skipRespawn = false;

function spawnReplacement(): boolean {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CODECAST_RESTART: "1" },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const CRASH_FILE = path.join(CONFIG_DIR, "crash-count.json");

function recordCrash(): { count: number; backoffMinutes: number } {
  try {
    let crashes: { count: number; firstCrash: number } = { count: 0, firstCrash: Date.now() };
    if (fs.existsSync(CRASH_FILE)) {
      crashes = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
    }
    const windowMs = 30 * 60 * 1000;
    if (Date.now() - crashes.firstCrash > windowMs) {
      crashes = { count: 0, firstCrash: Date.now() };
    }
    crashes.count++;
    fs.writeFileSync(CRASH_FILE, JSON.stringify(crashes));
    const backoffMinutes = crashes.count <= 3 ? 0 : Math.min(crashes.count * 2, 30);
    return { count: crashes.count, backoffMinutes };
  } catch {
    return { count: 1, backoffMinutes: 0 };
  }
}

function clearCrashCount(): void {
  try { if (fs.existsSync(CRASH_FILE)) fs.unlinkSync(CRASH_FILE); } catch {}
}

function acquireLock(): boolean {
  if (fs.existsSync(PID_FILE)) {
    try {
      const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (existingPid === process.pid) {
        return true;
      }
      if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
        return false;
      }
    } catch {
      // PID file exists but is unreadable or invalid, continue
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  // Verify we won the race (another process may have written simultaneously)
  try {
    const writtenPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (writtenPid !== process.pid) return false;
  } catch { return false; }
  return true;
}

function findStaleSessionFiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const staleFiles: string[] = [];
  const now = Date.now();

  if (!fs.existsSync(claudeProjectsDir)) {
    return staleFiles;
  }

  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(claudeProjectsDir, projectDir);
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;

      const files = fs.readdirSync(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(projectPath, file);
        try {
          const fileStat = fs.statSync(filePath);
          const fileAge = now - fileStat.mtimeMs;

          // Skip files older than maxAge (default 7 days)
          if (fileAge > maxAgeMs) continue;

          // Check sync ledger for this file
          const syncRecord = getSyncRecord(filePath);
          if (shouldTreatClaudeFileAsStale(fileStat, syncRecord)) {
            staleFiles.push(filePath);
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch (err) {
    log(`Watchdog: Error scanning for stale files: ${err instanceof Error ? err.message : String(err)}`);
  }

  return staleFiles;
}

export function shouldTreatClaudeFileAsStale(
  fileStat: { mtimeMs: number; size: number },
  syncRecord: SyncRecord | null
): boolean {
  if (!syncRecord) {
    return true;
  }
  if (!syncRecord.isLegacyFallback && fileStat.mtimeMs > syncRecord.lastSyncedAt) {
    return true;
  }
  return fileStat.size > syncRecord.lastSyncedPosition;
}

function findStaleCodexSessionFiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const codexSessionsDir = path.join(process.env.HOME || "", ".codex", "sessions");
  const staleFiles: string[] = [];
  const now = Date.now();

  if (!fs.existsSync(codexSessionsDir)) {
    return staleFiles;
  }

  const scanDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = fs.statSync(fullPath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs) continue;

          const lastPosition = getPosition(fullPath);
          if (fileStat.size !== lastPosition) {
            staleFiles.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }
  };

  scanDir(codexSessionsDir);
  return staleFiles;
}

function detectCursorPath(): string {
  const platform = process.platform;
  const home = process.env.HOME || "";

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor");
  } else if (platform === "linux") {
    return path.join(home, ".config", "Cursor");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor");
  }

  return path.join(home, ".cursor");
}

function getCursorWorkspaceStoragePath(): string | null {
  const cursorPath = detectCursorPath();
  const workspaceStoragePath = path.join(cursorPath, "User", "workspaceStorage");
  if (!fs.existsSync(workspaceStoragePath)) {
    return null;
  }
  return workspaceStoragePath;
}

function getCursorWorkspaceFolderPath(workspaceStorageDir: string): string | null {
  const workspaceJsonPath = path.join(workspaceStorageDir, "workspace.json");
  try {
    if (!fs.existsSync(workspaceJsonPath)) {
      return null;
    }
    const content = fs.readFileSync(workspaceJsonPath, "utf-8");
    const data = JSON.parse(content);

    const folderUri = data.folder || data.workspace;
    if (!folderUri) {
      return null;
    }

    if (folderUri.startsWith("file://")) {
      const decoded = decodeURIComponent(folderUri.slice(7));
      if (process.platform === "win32" && decoded.match(/^\/[A-Z]:/i)) {
        return decoded.slice(1);
      }
      return decoded;
    }

    return folderUri;
  } catch {
    return null;
  }
}

function getCursorMaxRowId(dbPath: string): number {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const tableExists = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
      )
      .get();

    if (!tableExists) {
      return 0;
    }

    const maxRowIdResult = db
      .query<{ maxRowId: number | null }, []>(
        "SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'"
      )
      .get();

    return maxRowIdResult?.maxRowId ?? 0;
  } catch {
    return 0;
  } finally {
    if (db) {
      db.close();
    }
  }
}

interface CursorComposerData {
  allComposers?: Array<{
    composerId?: string;
  }>;
}

function getCursorComposerData(dbPath: string): CursorComposerData | null {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1"
      )
      .get();
    if (!row?.value) {
      return null;
    }
    return JSON.parse(row.value) as CursorComposerData;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

function findWorkspacePathForCursorConversation(sessionId: string): string | null {
  const workspaceStoragePath = getCursorWorkspaceStoragePath();
  if (!workspaceStoragePath) {
    return null;
  }

  let workspaceDirs: string[];
  try {
    workspaceDirs = fs.readdirSync(workspaceStoragePath);
  } catch {
    return null;
  }

  for (const workspaceHash of workspaceDirs) {
    const dbPath = path.join(workspaceStoragePath, workspaceHash, "state.vscdb");
    if (!fs.existsSync(dbPath)) {
      continue;
    }

    const composerData = getCursorComposerData(dbPath);
    const composers = composerData?.allComposers || [];
    if (!composers.some(c => c.composerId === sessionId)) {
      continue;
    }

    const workspaceStorageDir = path.dirname(dbPath);
    return getCursorWorkspaceFolderPath(workspaceStorageDir);
  }

  return null;
}

interface StaleCursorSession {
  sessionId: string;
  workspacePath: string;
  dbPath: string;
}

function findStaleCursorSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): StaleCursorSession[] {
  const workspaceStoragePath = getCursorWorkspaceStoragePath();
  const staleSessions: StaleCursorSession[] = [];
  const now = Date.now();

  if (!workspaceStoragePath) {
    return staleSessions;
  }

  let workspaceDirs: string[];
  try {
    workspaceDirs = fs.readdirSync(workspaceStoragePath);
  } catch {
    return staleSessions;
  }

  for (const workspaceHash of workspaceDirs) {
    const dbPath = path.join(workspaceStoragePath, workspaceHash, "state.vscdb");
    if (!fs.existsSync(dbPath)) {
      continue;
    }

    try {
      const stat = fs.statSync(dbPath);
      const fileAge = now - stat.mtimeMs;
      if (fileAge > maxAgeMs) continue;

      const maxRowId = getCursorMaxRowId(dbPath);
      if (maxRowId <= 0) continue;

      const lastRowId = getPosition(dbPath);
      if (maxRowId <= lastRowId) continue;

      const workspaceStorageDir = path.dirname(dbPath);
      const workspacePath = getCursorWorkspaceFolderPath(workspaceStorageDir) || workspaceHash;

      staleSessions.push({
        sessionId: workspaceHash,
        workspacePath,
        dbPath,
      });
    } catch {
      continue;
    }
  }

  return staleSessions;
}

function findStaleCursorTranscriptFiles(
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): string[] {
  const cursorProjectsDir = path.join(process.env.HOME || "", ".cursor", "projects");
  const staleFiles: string[] = [];
  const now = Date.now();

  if (!fs.existsSync(cursorProjectsDir)) {
    return staleFiles;
  }

  const scanDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".txt")) {
        if (!fullPath.includes(`${path.sep}agent-transcripts${path.sep}`)) {
          continue;
        }
        try {
          const fileStat = fs.statSync(fullPath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs) continue;

          const lastPosition = getPosition(fullPath);
          if (fileStat.size !== lastPosition) {
            staleFiles.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }
  };

  scanDir(cursorProjectsDir);
  return staleFiles;
}

interface WatchdogDependencies {
  config: Config;
  syncService: SyncService;
  conversationCache: ConversationCache;
  retryQueue: RetryQueue;
  pendingMessages: PendingMessages;
  titleCache: TitleCache;
  updateState: () => void;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

async function checkForForcedUpdate(syncService: SyncService): Promise<boolean> {
  try {
    const minVersion = await syncService.getMinCliVersion();
    if (!minVersion) return false;

    const currentVersion = getVersion();
    if (compareVersions(currentVersion, minVersion) < 0) {
      logLifecycle("forced_update_start", `current=${currentVersion} min=${minVersion}`);
      await flushRemoteLogs();
      const success = await performUpdate();
      if (success) {
        const newVersion = getVersion();
        if (compareVersions(newVersion, currentVersion) <= 0) {
          logLifecycle("forced_update_noop", `${currentVersion} -> ${newVersion}, target ${minVersion} not available yet`);
          await flushRemoteLogs();
          return false;
        }
        logLifecycle("forced_update_complete", `${currentVersion} -> ${newVersion}`);
        await flushRemoteLogs();
        spawnReplacement();
        await new Promise(resolve => setTimeout(resolve, 500));
        process.exit(0);
      } else {
        logLifecycle("forced_update_failed", `current=${currentVersion} target>=${minVersion}`);
        await flushRemoteLogs();
      }
      return true;
    }
    return false;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Forced update check failed`, err instanceof Error ? err : undefined);
    return false;
  }
}

function checkDiskVersionMismatch(): void {
  try {
    const updateTsPath = path.join(__dirname, "update.ts");
    const updateJsPath = path.join(__dirname, "update.js");
    const filePath = fs.existsSync(updateTsPath) ? updateTsPath : updateJsPath;
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const match = content.match(/const VERSION\s*=\s*["']([^"']+)["']/);
    if (!match) return;

    const diskVersion = match[1];
    if (diskVersion !== daemonVersion) {
      log(`Disk version mismatch: running=${daemonVersion} disk=${diskVersion}, restarting`);
      logLifecycle("version_mismatch_restart", `${daemonVersion} -> ${diskVersion}`);
      flushRemoteLogs().then(() => {
        const spawned = spawnReplacement();
        if (spawned) skipRespawn = true;
        setTimeout(() => process.exit(0), 500);
      }).catch(() => {
        const spawned = spawnReplacement();
        if (spawned) skipRespawn = true;
        setTimeout(() => process.exit(0), 500);
      });
    }
  } catch {}
}

function startEventLoopMonitor(): NodeJS.Timeout {
  let lastTickTime = Date.now();

  return setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickTime;
    lastTickTime = now;

    saveDaemonState({ lastHeartbeatTick: now });

    if (elapsed > EVENT_LOOP_LAG_THRESHOLD_MS) {
      logLifecycle("event_loop_freeze", `Event loop was unresponsive for ${Math.round(elapsed / 1000)}s, exiting for restart`);
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [CRITICAL] Event loop lag ${elapsed}ms exceeded threshold, self-terminating\n`); } catch {}
      process.exit(78);
    }
  }, EVENT_LOOP_CHECK_INTERVAL_MS);
}

function startVersionChecker(syncService: SyncService): NodeJS.Timeout {
  checkForForcedUpdate(syncService);

  return setInterval(() => {
    checkForForcedUpdate(syncService);
  }, VERSION_CHECK_INTERVAL_MS);
}

function logHealthReport(retryQueue: RetryQueue): void {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);
  const droppedOps = retryQueue.getDroppedOperations();
  const queueSize = retryQueue.getQueueSize();

  if (unsyncedFiles.length > 0 || droppedOps.length > 0 || queueSize > 10) {
    logWarn(
      `Health: ${unsyncedFiles.length} pending files, ${droppedOps.length} dropped ops, ${queueSize} in retry queue`
    );
  }
}

function startReconciliation(syncService: SyncService, retryQueue: RetryQueue): NodeJS.Timeout {
  log("Reconciliation scheduler started (runs every hour)");

  // Run initial reconciliation after 5 minutes (let daemon stabilize first)
  setTimeout(async () => {
    try {
      // Log health report
      logHealthReport(retryQueue);

      const result = await performReconciliation(
        syncService,
        (msg, level) => log(msg, level || "info")
      );

      if (result.discrepancies.length > 0) {
        logWarn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
        // Auto-repair by resetting positions
        const repaired = await repairDiscrepancies(result.discrepancies, log);
        log(`Reconciliation: Reset ${repaired} sessions for re-sync`);
      }
    } catch (err) {
      logError("Initial reconciliation failed", err instanceof Error ? err : new Error(String(err)));
    }
  }, 5 * 60 * 1000);

  return setInterval(async () => {
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    try {
      // Log health report
      logHealthReport(retryQueue);

      const result = await performReconciliation(
        syncService,
        (msg, level) => log(msg, level || "info")
      );

      if (result.discrepancies.length > 0) {
        logWarn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
        const repaired = await repairDiscrepancies(result.discrepancies, log);
        log(`Reconciliation: Reset ${repaired} sessions for re-sync`);
      }
    } catch (err) {
      logError("Reconciliation failed", err instanceof Error ? err : new Error(String(err)));
    }
  }, RECONCILIATION_INTERVAL_MS);
}

function startWatchdog(
  deps: WatchdogDependencies
): NodeJS.Timeout {
  log("Watchdog started");

  return setInterval(async () => {
    const state = readDaemonState();
    const now = Date.now();

    saveDaemonState({ lastWatchdogCheck: now });

    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      return;
    }

    // Validate process cache
    validateProcessCache();

    // Prune started session entries only if tmux session is dead
    for (const [convId, entry] of startedSessionTmux.entries()) {
      if (now - entry.startedAt > STARTED_SESSION_TTL_MS) {
        try {
          await execAsync(`tmux has-session -t '${entry.tmuxSession}' 2>/dev/null`, { timeout: 2000 });
        } catch {
          startedSessionTmux.delete(convId);
        }
      }
    }

    // Check for watcher staleness - only log once per hour to avoid noise
    const watcherIdleMinutes = Math.floor((now - lastWatcherEventTime) / 60000);
    const minutesSinceLastIdleLog = Math.floor((now - lastWatcherIdleLogTime) / 60000);
    if (watcherIdleMinutes >= 30 && minutesSinceLastIdleLog >= 60) {
      logWarn(`Watcher idle for ${watcherIdleMinutes}min`);
      lastWatcherIdleLogTime = now;
    }

    const staleClaudeFiles = findStaleSessionFiles();
    const staleCodexFiles = findStaleCodexSessionFiles();
    const staleCursorSessions = findStaleCursorSessions();
    const staleCursorTranscriptFiles = findStaleCursorTranscriptFiles();
    const totalStale =
      staleClaudeFiles.length +
      staleCodexFiles.length +
      staleCursorSessions.length +
      staleCursorTranscriptFiles.length;

    if (totalStale === 0) {
      return;
    }

    log(`Watchdog: Detected ${totalStale} files needing sync`);

    const currentRestarts = state?.watchdogRestarts || 0;
    saveDaemonState({ watchdogRestarts: currentRestarts + 1 });

    for (const filePath of staleClaudeFiles) {
      const parts = filePath.split(path.sep);
      const sessionId = resolveSessionId(filePath);
      const projectDirName = parts[parts.length - 2];
      const decoded = decodeProjectDirName(projectDirName);
      const projectPath = decoded && fs.existsSync(decoded) ? decoded : projectDirName.replace(/-/g, path.sep).replace(/^-/, "");

      if (deps.config.excluded_paths && isPathExcluded(projectPath, deps.config.excluded_paths)) {
        continue;
      }

      if (!isProjectAllowedToSync(projectPath, deps.config)) {
        continue;
      }

      log(`Watchdog: Syncing stale session ${sessionId}`);

      await processSessionFile(
        filePath,
        sessionId,
        projectPath,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.titleCache,
        deps.updateState
      );
    }

    for (const filePath of staleCodexFiles) {
      const filename = path.basename(filePath, ".jsonl");
      const match = filename.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      );
      const sessionId = match ? match[1] : filename;

      log(`Watchdog: Syncing stale Codex session ${sessionId}`);

      await processCodexSession(
        filePath,
        sessionId,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.titleCache,
        deps.updateState
      );
    }

    for (const cursorSession of staleCursorSessions) {
      if (deps.config.excluded_paths && isPathExcluded(cursorSession.workspacePath, deps.config.excluded_paths)) {
        continue;
      }

      if (!isProjectAllowedToSync(cursorSession.workspacePath, deps.config)) {
        continue;
      }

      log(`Watchdog: Syncing stale Cursor session ${cursorSession.sessionId}`);

      await processCursorSession(
        cursorSession.dbPath,
        cursorSession.sessionId,
        cursorSession.workspacePath,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.updateState
      );
    }

    for (const filePath of staleCursorTranscriptFiles) {
      const sessionId = path.basename(filePath, ".txt");
      const workspacePath = findWorkspacePathForCursorConversation(sessionId);

      if (workspacePath) {
        if (deps.config.excluded_paths && isPathExcluded(workspacePath, deps.config.excluded_paths)) {
          continue;
        }

        if (!isProjectAllowedToSync(workspacePath, deps.config)) {
          continue;
        }
      } else if (deps.config.sync_mode === "selected") {
        continue;
      }

      log(`Watchdog: Syncing stale Cursor transcript ${sessionId}`);

      await processCursorTranscriptFile(
        filePath,
        sessionId,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.updateState
      );
    }

    log(`Watchdog: Sync completed for ${totalStale} files`);
  }, WATCHDOG_INTERVAL_MS);
}

async function main(): Promise<void> {
  ensureConfigDir();

  if (!acquireLock()) {
    const existingPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    console.error(`Daemon already running (PID: ${existingPid}). Exiting.`);
    process.exit(0);
  }

  // Exit guard: respawn with backoff if crash looping.
  // Skip self-respawn when running under launchd (KeepAlive handles restarts).
  const underLaunchd = !!process.env.XPC_SERVICE_NAME;
  process.on("exit", (code) => {
    if (skipRespawn || underLaunchd) return;
    if (code !== 0) {
      const { count, backoffMinutes } = recordCrash();
      if (backoffMinutes > 0) {
        try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] CRASH LOOP: ${count} crashes, backing off ${backoffMinutes}min before respawn\n`); } catch {}
        try {
          spawn("sh", ["-c", `sleep ${backoffMinutes * 60} && "${process.execPath}" ${process.argv.slice(1).map(a => `"${a}"`).join(" ")}`], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, CODECAST_RESTART: "1" },
          }).unref();
        } catch {}
        return;
      }
    } else {
      clearCrashCount();
    }
    try {
      spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODECAST_RESTART: "1" },
      }).unref();
    } catch {}
  });

  process.on("uncaughtException", async (err) => {
    logError("Uncaught exception", err);
    if (syncServiceRef) {
      await flushRemoteLogs().catch(() => {});
    }
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError("Unhandled rejection", err);
    if (syncServiceRef) {
      await flushRemoteLogs().catch(() => {});
    }
  });

  try {
    daemonVersion = getVersion();
  } catch {
    daemonVersion = "unknown";
  }

  try {
    fs.writeFileSync(VERSION_FILE, daemonVersion, { mode: 0o600 });
  } catch {}

  // Report crash recovery if we had crashes before this successful startup
  let crashRecoveryInfo = "";
  if (fs.existsSync(CRASH_FILE)) {
    try {
      const crashes = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
      if (crashes.count > 0) {
        crashRecoveryInfo = ` (recovered from ${crashes.count} crashes)`;
      }
    } catch {}
  }
  clearCrashCount();

  const isRestart = process.env.CODECAST_RESTART === "1";
  logLifecycle("daemon_start", `v${daemonVersion} PID=${process.pid}${isRestart ? " (restart after update)" : ""}${crashRecoveryInfo}`);
  log(`PID: ${process.pid}`);

  if (isSyncPaused()) {
    log("⚠️  Sync is PAUSED via environment variable (CODE_CHAT_SYNC_PAUSED or CODECAST_PAUSED)");
  }

  saveDaemonState({ connected: false });

  const { config, convexUrl } = await waitForConfig();
  activeConfig = config;

  log(`User ID: ${config.user_id}`);
  log(`Convex URL: ${convexUrl}`);
  if (config.auth_token) {
    log(`Auth token: ${maskToken(config.auth_token)}`);
  }
  if (config.excluded_paths) {
    log(`Excluded paths: ${config.excluded_paths}`);
  }

  const syncService = new SyncService({
    convexUrl,
    authToken: config.auth_token,
    userId: config.user_id,
  });
  syncServiceRef = syncService;

  // Repair any project paths that were stored incorrectly (one-time on startup)
  repairProjectPaths(syncService).catch(err => {
    log(`Failed to repair project paths: ${err instanceof Error ? err.message : String(err)}`);
  });

  setInterval(() => {
    flushRemoteLogs().catch(() => {});
  }, LOG_FLUSH_INTERVAL_MS);

  setInterval(() => {
    logHealthSummary();
    sendHeartbeat().catch(() => {});
    checkDiskVersionMismatch();
  }, HEALTH_REPORT_INTERVAL_MS);

  // Send initial heartbeat
  sendHeartbeat().catch(() => {});

  // Start task scheduler
  const taskScheduler = new TaskScheduler({
    syncService,
    config,
    log,
  });
  taskScheduler.start();

  const conversationCache = readConversationCache();
  const titleCache = readTitleCache();
  const pendingMessages: PendingMessages = {};
  const activeSessions = new Map<string, ActiveSession>();

  const retryQueue = new RetryQueue({
    initialDelayMs: 3000,
    maxDelayMs: 60000,
    maxAttempts: 15,
    persistPath: `${CONFIG_DIR}/retry-queue.json`,
    droppedPath: `${CONFIG_DIR}/dropped-operations.json`,
    onLog: (message, level) => log(message, level || "info"),
  });

  const updateState = () => {
    saveDaemonState({
      lastSyncTime: Date.now(),
      pendingQueueSize: retryQueue.getQueueSize(),
    });
  };

  retryQueue.setExecutor(async (op: RetryOperation): Promise<boolean> => {
    if (op.type === "createConversation") {
      const params = op.params as {
        userId: string;
        teamId?: string;
        sessionId: string;
        agentType: "claude_code" | "codex" | "cursor";
        projectPath: string;
        slug?: string;
        startedAt?: number;
        gitInfo?: GitInfo;
      };
      const conversationId = await syncService.createConversation(params);
      conversationCache[params.sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Retry: Created conversation ${conversationId} for session ${params.sessionId}`);

      if (pendingMessages[params.sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[params.sessionId], conversationId, syncService, retryQueue);
        delete pendingMessages[params.sessionId];
      }
      updateState();
      return true;
    }

    if (op.type === "addMessage") {
      const params = op.params as {
        conversationId: string;
        messageUuid?: string;
        role: "human" | "assistant" | "system";
        content: string;
        timestamp: number;
        thinking?: string;
        toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
        images?: Array<{ mediaType: string; data: string }>;
        subtype?: string;
      };
      await syncService.addMessage(params);
      updateState();
      return true;
    }

    return false;
  });

  retryQueue.start();

  const watcher = new SessionWatcher();
  const fileSyncs = new Map<string, InvalidateSync>();

  watcher.on("ready", () => {
    log("Session watcher ready (depth=2)");
  });

  watcher.on("session", (event: SessionEvent) => {
    const filePath = event.filePath;
    lastWatcherEventTime = Date.now();

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping session: ${event.sessionId}`);
      return;
    }

    if (isPathExcluded(event.projectPath, config.excluded_paths)) {
      log(`Skipping sync for excluded path: ${event.projectPath}`);
      return;
    }

    if (!isProjectAllowedToSync(event.projectPath, config)) {
      log(`Skipping sync for non-selected project: ${event.projectPath}`);
      return;
    }


    let sync = fileSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processSessionFile(
          filePath,
          event.sessionId,
          event.projectPath,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState
        );
      });
      fileSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  watcher.on("error", (error: Error) => {
    logError("Watcher error", error);
  });

  watcher.start();

  // Agent status hook file watcher
  fs.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
  const statusWatcher = chokidarWatch(AGENT_STATUS_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });
  statusWatcher.on("add", handleStatusFile).on("change", handleStatusFile);

  function handleStatusFile(filePath: string) {
    try {
      const basename = path.basename(filePath, ".json");
      if (!basename || !filePath.endsWith(".json")) return;
      const sessionId = basename;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as { status: AgentStatus; ts: number; permission_mode?: PermissionMode };
      if (!data.status || !data.ts) return;

      const convId = conversationCache[sessionId];
      if (!convId) return;

      const prev = lastHookStatus.get(sessionId);
      if (prev && prev.ts >= data.ts) return;

      const statusChanged = !prev || prev.status !== data.status;
      const modeChanged = data.permission_mode && (!prev || prev.permission_mode !== data.permission_mode);
      lastHookStatus.set(sessionId, data);

      if (data.status === "compacting" || data.status === "idle" || data.status === "thinking") {
        const existingTimer = idleTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          idleTimers.delete(sessionId);
        }
      }

      if (statusChanged || modeChanged) {
        sendAgentStatus(syncService, convId, sessionId, data.status, data.ts * 1000, data.permission_mode);
        log(`Hook status: ${data.status}${data.permission_mode ? ` mode=${data.permission_mode}` : ''} for session ${sessionId.slice(0, 8)}`);
      }
    } catch {}
  }

  // Clean up stale agent-status files every 30 minutes
  const statusCleanupInterval = setInterval(() => {
    try {
      const files = fs.readdirSync(AGENT_STATUS_DIR);
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const file of files) {
        const fp = path.join(AGENT_STATUS_DIR, file);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          lastHookStatus.delete(path.basename(file, ".json"));
        }
      }
    } catch {}
  }, 30 * 60 * 1000);

  // Startup scan: sync any files that were missed while daemon was down
  const performStartupScan = async () => {
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");

    // Safety check: ensure directory exists
    if (!fs.existsSync(claudeProjectsDir)) {
      log("Startup scan: No projects directory found, skipping");
      return;
    }

    let unsyncedFiles: string[] = [];
    try {
      unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);
    } catch (err) {
      logError("Startup scan failed to find unsynced files", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (unsyncedFiles.length > 0) {
      log(`Startup scan: Found ${unsyncedFiles.length} files needing sync`);

      for (const filePath of unsyncedFiles) {
        const parts = filePath.split(path.sep);
        const sessionId = resolveSessionId(filePath);

        const isSubagentFile = parts.includes("subagents");
        let projectDirName: string;
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          projectDirName = parts[subagentsIdx - 2] || parts[parts.length - 2];
        } else {
          projectDirName = parts[parts.length - 2];
        }
        const decoded = decodeProjectDirName(projectDirName);
        const projectPath = decoded && fs.existsSync(decoded) ? decoded : projectDirName.replace(/-/g, path.sep).replace(/^-/, "");

        if (config.excluded_paths && isPathExcluded(projectPath, config.excluded_paths)) {
          continue;
        }

        if (!isProjectAllowedToSync(projectPath, config)) {
          continue;
        }

        let parentConversationId: string | undefined;
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          const parentSessionId = parts[subagentsIdx - 1];
          if (parentSessionId && conversationCache[parentSessionId]) {
            parentConversationId = conversationCache[parentSessionId];
          }
        }

        log(`Startup scan: Syncing ${sessionId}${parentConversationId ? ` (subagent of ${parentConversationId})` : ""}`);

        await processSessionFile(
          filePath,
          sessionId,
          projectPath,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState,
          parentConversationId,
        );
      }

      // Resolve any remaining pending subagent parents after all files processed
      for (const [childSessionId, parentSessionId] of pendingSubagentParents) {
        const parentConvId = conversationCache[parentSessionId];
        const childConvId = conversationCache[childSessionId];
        if (parentConvId && childConvId) {
          syncService.linkSessions(parentConvId, childConvId).then(() => {
            log(`Startup scan: Linked subagent ${childSessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
          }).catch((err) => {
            log(`Startup scan: Failed to link subagent ${childSessionId.slice(0, 8)}: ${err}`);
          });
          pendingSubagentParents.delete(childSessionId);
        }
      }

      log(`Startup scan: Completed syncing ${unsyncedFiles.length} files`);
    } else {
      log("Startup scan: All files up to date");
    }
  };

  // Run startup scan in background (don't block daemon startup)
  performStartupScan().then(async () => {
    // Backfill: detect unlinked plan handoff children
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    let linked = 0;
    const alreadyLinked = new Set(planHandoffChildren.values());
    for (const [childSessionId, childConvId] of Object.entries(conversationCache)) {
      if (alreadyLinked.has(childConvId)) continue;
      const possiblePaths = [
        path.join(claudeProjectsDir, `-Users-ashot-src-codecast`, `${childSessionId}.jsonl`),
      ];
      // Find the JSONL file across all project dirs
      try {
        const projDirs = fs.readdirSync(claudeProjectsDir);
        for (const dir of projDirs) {
          const fp = path.join(claudeProjectsDir, dir, `${childSessionId}.jsonl`);
          if (fs.existsSync(fp) && !possiblePaths.includes(fp)) {
            possiblePaths.push(fp);
          }
        }
      } catch {}
      for (const fp of possiblePaths) {
        if (!fs.existsSync(fp)) continue;
        try {
          const content = fs.readFileSync(fp, "utf-8");
          const msgs = parseSessionFile(content);
          const userMsgs = msgs.filter(m => m.role === "user").slice(0, 3);
          for (const msg of userMsgs) {
            if (!msg.content) continue;
            const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
            if (handoffMatch) {
              const jsonlPath = handoffMatch[1];
              const parentMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
              if (parentMatch) {
                const parentSessionId = parentMatch[1];
                const parentConvId = conversationCache[parentSessionId];
                if (parentConvId && parentConvId !== childConvId) {
                  try {
                    await syncService.linkPlanHandoff(parentConvId, childConvId);
                    planHandoffChildren.set(parentConvId, childConvId);
                    linked++;
                    log(`Backfill: linked plan handoff ${childSessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
                  } catch (err) {
                    log(`Backfill: failed to link ${childSessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
              break;
            }
          }
        } catch {}
        break;
      }
    }
    if (linked > 0) log(`Backfill: linked ${linked} plan handoff session(s)`);
  }).catch(err => {
    logError("Startup scan failed", err instanceof Error ? err : new Error(String(err)));
  });

  const watchdogInterval = startWatchdog({
    config,
    syncService,
    conversationCache,
    retryQueue,
    pendingMessages,
    titleCache,
    updateState,
  });

  const versionCheckInterval = startVersionChecker(syncService);
  const reconciliationInterval = startReconciliation(syncService, retryQueue);
  const eventLoopMonitorInterval = startEventLoopMonitor();

  const cursorWatcher = new CursorWatcher();
  const cursorSyncs = new Map<string, InvalidateSync>();

  cursorWatcher.on("ready", () => {
    log("Cursor watcher ready");
  });

  cursorWatcher.on("session", (event: CursorSessionEvent) => {
    const dbPath = event.dbPath;

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Cursor session: ${event.sessionId}`);
      return;
    }

    if (isPathExcluded(event.workspacePath, config.excluded_paths)) {
      log(`Skipping sync for excluded path: ${event.workspacePath}`);
      return;
    }

    if (!isProjectAllowedToSync(event.workspacePath, config)) {
      log(`Skipping sync for non-selected project: ${event.workspacePath}`);
      return;
    }

    let sync = cursorSyncs.get(dbPath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorSession(
          dbPath,
          event.sessionId,
          event.workspacePath,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          updateState
        );
      });
      cursorSyncs.set(dbPath, sync);
    }

    sync.invalidate();
  });

  cursorWatcher.on("error", (error: Error) => {
    logError("Cursor watcher error", error);
  });

  cursorWatcher.start();

  const cursorTranscriptWatcher = new CursorTranscriptWatcher();
  const cursorTranscriptSyncs = new Map<string, InvalidateSync>();

  cursorTranscriptWatcher.on("ready", () => {
    log("Cursor transcript watcher ready");
  });

  cursorTranscriptWatcher.on("session", (event: CursorTranscriptEvent) => {
    const filePath = event.filePath;
    lastWatcherEventTime = Date.now();

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Cursor transcript: ${event.sessionId}`);
      return;
    }

    const workspacePath = findWorkspacePathForCursorConversation(event.sessionId);
    if (workspacePath) {
      if (isPathExcluded(workspacePath, config.excluded_paths)) {
        log(`Skipping sync for excluded path: ${workspacePath}`);
        return;
      }

      if (!isProjectAllowedToSync(workspacePath, config)) {
        log(`Skipping sync for non-selected project: ${workspacePath}`);
        return;
      }
    } else if (config.sync_mode === "selected") {
      log(`Skipping Cursor transcript with unknown workspace path: ${event.sessionId}`);
      return;
    }

    let sync = cursorTranscriptSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorTranscriptFile(
          filePath,
          event.sessionId,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          updateState
        );
      });
      cursorTranscriptSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  cursorTranscriptWatcher.on("error", (error: Error) => {
    logError("Cursor transcript watcher error", error);
  });

  cursorTranscriptWatcher.start();

  const codexWatcher = new CodexWatcher();
  const codexSyncs = new Map<string, InvalidateSync>();

  codexWatcher.on("ready", () => {
    log("Codex watcher ready");
  });

  codexWatcher.on("session", (event: CodexSessionEvent) => {
    const filePath = event.filePath;

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Codex session: ${event.sessionId}`);
      return;
    }

    let sync = codexSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCodexSession(
          filePath,
          event.sessionId,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState
        );
      });
      codexSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  codexWatcher.on("error", (error: Error) => {
    logError("Codex watcher error", error);
  });

  codexWatcher.start();

  const geminiWatcher = new GeminiWatcher();
  const geminiSyncs = new Map<string, InvalidateSync>();

  geminiWatcher.on("ready", () => {
    log("Gemini watcher ready");
  });

  geminiWatcher.on("session", (event: GeminiSessionEvent) => {
    const filePath = event.filePath;

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Gemini session: ${event.sessionId}`);
      return;
    }

    let sync = geminiSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processGeminiSession(
          filePath,
          event.sessionId,
          event.projectHash,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState
        );
      });
      geminiSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  geminiWatcher.on("error", (error: Error) => {
    logError("Gemini watcher error", error);
  });

  geminiWatcher.start();

  const subscriptionClient = syncService.getSubscriptionClient();
  let unsubscribe: (() => void) | null = null;
  let permissionUnsubscribe: (() => void) | null = null;
  let commandUnsubscribe: (() => void) | null = null;
  const processedPermissionIds = new Set<string>();
  const processedCommandIds = new Set<string>();
  const messageRetryTimers = new Set<string>();

  function scheduleMessageRetry(
    messageId: string,
    retryCount: number,
    conversationId: string,
    messageContent: string,
  ) {
    if (messageRetryTimers.has(messageId)) return;
    if (retryCount >= 10) {
      log(`Message ${messageId.slice(0, 8)} exceeded max retries, marking undeliverable`);
      syncService.updateMessageStatus({ messageId, status: "undeliverable" as any }).catch(() => {});
      return;
    }
    const delays = [1000, 5000, 15000, 30000, 60000];
    const delay = delays[Math.min(retryCount, delays.length - 1)];
    log(`Scheduling retry ${retryCount + 1} for message ${messageId.slice(0, 8)} in ${delay / 1000}s`);
    messageRetryTimers.add(messageId);
    setTimeout(async () => {
      messageRetryTimers.delete(messageId);
      try {
        await syncService.retryMessage(messageId);
        log(`Retry triggered for message ${messageId.slice(0, 8)} (count: ${retryCount + 1})`);
      } catch (err) {
        log(`Failed to trigger retry for ${messageId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay);
  }

  const messagesInFlight = new Set<string>();

  const setupSubscription = () => {
    try {
      log("Setting up pending messages subscription");
      unsubscribe = subscriptionClient.onUpdate(
        "pendingMessages:getPendingMessages" as any,
        { user_id: config.user_id, api_token: config.auth_token },
        async (messages: any) => {
          log(`Subscription update received: ${JSON.stringify(messages)?.slice(0, 500)}`);

          if (!messages) {
            log("No messages in update");
            return;
          }

          if (Array.isArray(messages)) {
            log(`Received array with ${messages.length} pending message(s)`);
            for (const msg of messages) {
              if (messagesInFlight.has(msg._id)) {
                log(`Skipping message ${msg._id} - delivery already in flight`);
                continue;
              }
              messagesInFlight.add(msg._id);

              const imageIds = msg.image_storage_ids ?? (msg.image_storage_id ? [msg.image_storage_id] : []);
              log(`Pending message: conversation_id=${msg.conversation_id} content="${msg.content.slice(0, 100)}" images=${imageIds.length}`);

              let messageContent = msg.content;
              if (imageIds.length > 0) {
                const imagePaths: string[] = [];
                for (const storageId of imageIds) {
                  try {
                    const imagePath = await downloadImage(storageId, syncService);
                    if (imagePath) {
                      imagePaths.push(imagePath);
                      log(`Downloaded image to ${imagePath}`);
                    }
                  } catch (err) {
                    log(`Failed to download image: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                if (imagePaths.length > 0) {
                  const realText = msg.content.replace(/^\[image\]$/i, "").trim();
                  const imageTags = imagePaths.map(p => `[Image ${p}]`).join(" ");
                  messageContent = realText ? `${realText} ${imageTags}` : imageTags;
                }
              }

              syncService.updateSessionAgentStatus(msg.conversation_id, "connected").catch(() => {});

              try {
                const delivered = await deliverMessage(
                  msg.conversation_id,
                  messageContent,
                  conversationCache,
                  syncService,
                  msg._id,
                  titleCache
                );
                if (delivered) {
                  log(`Message delivered successfully`);
                } else {
                  log(`Message delivery failed, scheduling retry`);
                  scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, messageContent);
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log(`Error handling pending message: ${errMsg}`);
                scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, msg.content);
              } finally {
                messagesInFlight.delete(msg._id);
              }
            }
          } else {
            log(`Received non-array: ${typeof messages}`);
          }

          resetReconnectDelay();
        }
      );
      log("Subscription established successfully");
      saveDaemonState({ connected: true });
      resetReconnectDelay();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Subscription error", error);
      saveDaemonState({ connected: false });
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      const delay = getReconnectDelay();
      logWarn(`Connection lost, reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
      setTimeout(() => {
        setupSubscription();
      }, delay);
    }
  };

  setupSubscription();

  const setupPermissionSubscription = () => {
    try {
      log("Setting up permission responses subscription");
      permissionUnsubscribe = subscriptionClient.onUpdate(
        "permissions:getAllRespondedPermissions" as any,
        { user_id: config.user_id, api_token: config.auth_token },
        async (permissions: any) => {
          log(`Permission subscription update received: ${JSON.stringify(permissions)?.slice(0, 200)}`);

          if (!permissions || !Array.isArray(permissions)) {
            log("No permissions in update or invalid format");
            return;
          }

          for (const permission of permissions) {
            if (processedPermissionIds.has(permission._id)) {
              continue;
            }

            log(`New permission response: ${permission._id} status=${permission.status} tool=${permission.tool_name}`);

            try {
              const response = permission.status === "approved" ? "y" : "n";
              const sessionId = permission.session_id;
              let injected = false;

              if (sessionId) {
                const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
                if (proc) {
                  const tmuxTarget = await findTmuxPaneForTty(proc.tty);
                  if (tmuxTarget) {
                    try {
                      await injectViaTmux(tmuxTarget, response);
                      injected = true;
                    } catch {}
                  }
                  if (!injected) {
                    try {
                      await injectViaIterm(proc.tty, response);
                      injected = true;
                    } catch {}
                  }
                }
              }

              if (injected) {
                log(`Injected permission response '${response}' for session ${sessionId?.slice(0, 8)}`);
                processedPermissionIds.add(permission._id);
              } else {
                log(`Failed to inject permission response, will retry on next update`);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log(`Error handling permission response: ${errMsg}`);
            }
          }

          resetReconnectDelay();
        }
      );
      log("Permission subscription established successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Permission subscription error", error);
      if (permissionUnsubscribe) {
        permissionUnsubscribe();
        permissionUnsubscribe = null;
      }

      const delay = getReconnectDelay();
      logWarn(`Permission subscription lost, reconnecting in ${delay}ms`);
      setTimeout(() => {
        setupPermissionSubscription();
      }, delay);
    }
  };

  setupPermissionSubscription();

  const setupCommandSubscription = () => {
    try {
      log("Setting up daemon commands subscription");
      commandUnsubscribe = subscriptionClient.onUpdate(
        "users:getMyPendingCommands" as any,
        { api_token: config.auth_token },
        async (commands: any) => {
          if (!commands || !Array.isArray(commands) || commands.length === 0) {
            return;
          }

          log(`Command subscription update: ${commands.length} pending command(s)`);

          for (const cmd of commands) {
            if (processedCommandIds.has(cmd.id)) {
              continue;
            }

            processedCommandIds.add(cmd.id);
            log(`[SUBSCRIPTION] Executing command: ${cmd.command} (${cmd.id})`);
            await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
          }

          resetReconnectDelay();
        }
      );
      log("Command subscription established successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Command subscription error", error);
      if (commandUnsubscribe) {
        commandUnsubscribe();
        commandUnsubscribe = null;
      }

      const delay = getReconnectDelay();
      logWarn(`Command subscription lost, reconnecting in ${delay}ms`);
      setTimeout(() => {
        setupCommandSubscription();
      }, delay);
    }
  };

  setupCommandSubscription();

  const shutdown = async () => {
    skipRespawn = true;
    log("Shutting down gracefully");

    saveDaemonState({ connected: false });

    if (unsubscribe) {
      unsubscribe();
    }

    if (permissionUnsubscribe) {
      permissionUnsubscribe();
    }

    if (commandUnsubscribe) {
      commandUnsubscribe();
    }

    clearInterval(watchdogInterval);
    clearInterval(versionCheckInterval);
    clearInterval(reconciliationInterval);
    clearInterval(eventLoopMonitorInterval);
    clearInterval(statusCleanupInterval);
    log("Watchdog and reconciliation stopped");

    statusWatcher.close();
    watcher.stop();
    cursorWatcher.stop();
    cursorTranscriptWatcher.stop();

    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Waiting for ${pendingOps} pending operations to complete...`);

      const completed = await retryQueue.waitForCompletion(60000);
      if (!completed) {
        log(`Shutdown timeout: ${retryQueue.getQueueSize()} operations did not complete`);
      }
    }

    retryQueue.stop();

    for (const sync of fileSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorTranscriptSyncs.values()) {
      sync.stop();
    }

    if (fs.existsSync(PID_FILE)) {
      try {
        fs.unlinkSync(PID_FILE);
        log("PID file removed");
      } catch (err) {
        log(`Failed to remove PID file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try { fs.unlinkSync(VERSION_FILE); } catch {}

    logLifecycle("daemon_stop", "graceful shutdown");
    await flushRemoteLogs();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch((err) => {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    shutdown().catch((err) => {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });

  await new Promise(() => {});
}

// Flag to prevent double execution when imported and called via runDaemon
let daemonStarted = false;

export async function runDaemon(): Promise<void> {
  if (daemonStarted) return;
  daemonStarted = true;
  return main();
}

export async function runWatchdog(): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    process.exit(0);
  }

  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const version = getVersion();
  const logLine = (msg: string) => {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [watchdog] ${msg}\n`); } catch {}
  };

  // 1. Report crash loop info if crash file exists
  if (fs.existsSync(CRASH_FILE)) {
    try {
      const crashes = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
      if (crashes.count > 3) {
        await fetch(`${siteUrl}/cli/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            level: "error",
            message: `CRASH LOOP: ${crashes.count} crashes since ${new Date(crashes.firstCrash).toISOString()}, watchdog reporting`,
            metadata: { error_code: "crash_loop" },
            cli_version: version,
            platform: process.platform,
          }),
        }).catch(() => {});
      }
    } catch {}
  }

  // 2. Check if daemon is alive (process exists AND event loop is responsive)
  let daemonAlive = false;
  let daemonPid = 0;
  if (fs.existsSync(PID_FILE)) {
    try {
      daemonPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (daemonPid > 0) {
        process.kill(daemonPid, 0);
        daemonAlive = true;
      }
    } catch {
      daemonAlive = false;
    }
  }

  // 2b. If process is alive, check if event loop is actually responsive
  if (daemonAlive && daemonPid > 0) {
    try {
      const state = readDaemonState();
      const lastTick = state.lastHeartbeatTick || state.lastWatchdogCheck || 0;
      const staleness = Date.now() - lastTick;
      if (lastTick > 0 && staleness > HEARTBEAT_STALE_THRESHOLD_MS) {
        logLine(`Daemon PID ${daemonPid} is alive but event loop frozen for ${Math.round(staleness / 1000)}s, killing`);
        try { process.kill(daemonPid, 9); } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
        daemonAlive = false;
      }
    } catch {}
  }

  // 3. Send heartbeat (keeps server aware even if daemon is dead)
  let commands: Array<{ id: string; command: string }> = [];
  let minCliVersion: string | undefined;
  try {
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonAlive ? version : `${version}-watchdog`,
        platform: process.platform,
        pid: 0,
        autostart_enabled: true,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      commands = data.commands || [];
      minCliVersion = data.min_cli_version;
    }
  } catch {}

  // 3b. Check min_cli_version -- if daemon binary is outdated, update it
  // This catches cases where the daemon's own checkForForcedUpdate failed or killed the daemon
  const sendWatchdogLog = async (level: string, message: string) => {
    await fetch(`${siteUrl}/cli/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        level,
        message,
        cli_version: `${version}-watchdog`,
        platform: process.platform,
      }),
    }).catch(() => {});
  };

  if (minCliVersion && compareVersions(version, minCliVersion) < 0) {
    logLine(`Binary outdated: current=${version} min=${minCliVersion}, updating...`);
    await sendWatchdogLog("info", `[LIFECYCLE] watchdog_update_start: current=${version} min=${minCliVersion}`);
    const success = await performUpdate();
    if (success) {
      logLine("Watchdog update successful");
      await sendWatchdogLog("info", `[LIFECYCLE] watchdog_update_complete: ${version} -> ${minCliVersion}`);
      clearCrashCount();
      // Kill the running daemon so it restarts with the new binary
      if (daemonAlive && daemonPid > 0) {
        logLine(`Killing outdated daemon PID ${daemonPid}`);
        try { process.kill(daemonPid, 15); } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
        daemonAlive = false;
      }
    } else {
      logLine("Watchdog update failed");
      await sendWatchdogLog("warn", `[LIFECYCLE] watchdog_update_failed: current=${version} target>=${minCliVersion}`);
    }
  }

  // 4. If daemon is dead, restart it
  if (!daemonAlive) {
    logLine("Daemon not running, restarting...");

    // Handle force_update before restart so daemon starts with new binary
    const updateCmd = commands.find(c => c.command === "force_update");
    if (updateCmd) {
      logLine("Force update pending, updating before restart...");
      const success = await performUpdate();
      // Report result
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: updateCmd.id,
          result: success ? "Updated by watchdog" : undefined,
          error: success ? undefined : "Watchdog update failed",
        }),
      }).catch(() => {});
      if (success) {
        logLine("Update successful");
        clearCrashCount();
      }
      commands = commands.filter(c => c.id !== updateCmd.id);
    }

    // Mark remaining commands as executed (daemon will get fresh ones on reconnect)
    for (const cmd of commands) {
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: cmd.id,
          result: `Handled by watchdog (daemon was dead): restarting`,
        }),
      }).catch(() => {});
    }

    // Spawn daemon
    clearCrashCount();
    const { executablePath, args } = getDaemonExecInfo();
    try {
      const child = spawn(executablePath, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODECAST_RESTART: "1" },
      });
      child.unref();
      logLine("Daemon restarted");
    } catch (err) {
      logLine(`Failed to restart daemon: ${err}`);
    }
  } else if (commands.some(c => c.command === "force_update")) {
    // Daemon is alive but has pending force_update -- it should handle it via subscription
    // But if it hasn't within reasonable time, the watchdog can nudge by sending SIGUSR1
    logLine("Daemon alive with pending force_update, daemon should handle via subscription");
  }
}

function getDaemonExecInfo(): { executablePath: string; args: string[] } {
  const isBinary = !__filename.endsWith(".ts") && !__filename.endsWith(".js");
  if (isBinary) {
    return { executablePath: process.argv[0], args: ["--", "_daemon"] };
  }
  return { executablePath: process.execPath, args: [path.resolve(__dirname, "daemon.js")] };
}

// Only run directly if executed as the main module (not when imported)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js")) {
  daemonStarted = true;
  main().catch((err) => {
    logError("Fatal error", err instanceof Error ? err : new Error(String(err)));
    flushRemoteLogs().finally(() => process.exit(1));
  });
}
