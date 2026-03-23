#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "bun:sqlite";
import { execSync, execFileSync, exec, execFile, spawn, spawnSync } from "child_process";
import { watch as chokidarWatch } from "chokidar";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { CursorTranscriptWatcher, type CursorTranscriptEvent } from "./cursorTranscriptWatcher.js";
import { CodexWatcher, type CodexSessionEvent } from "./codexWatcher.js";
import { CodexAppServer, type ApprovalRequest } from "./codexAppServer.js";
import {
  choosePreferredCodexCandidate,
  hasCodexSessionFileOpen,
  isResumeInvocation,
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
import { getVersion, performUpdate, ensureCastAlias } from "./update.js";
import { performReconciliation, repairDiscrepancies } from "./reconciliation.js";
import { TaskScheduler } from "./taskScheduler.js";
import { hasTmux } from "./tmux.js";
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
const EXEC_TIMEOUT_MS = 10_000;
const execAsync = async (cmd: string, opts?: any): Promise<{ stdout: string; stderr: string }> => {
  const result = await _execAsync(cmd, {
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
    ...opts,
    env: { ...process.env, PATH: ENRICHED_PATH, ...(opts?.env || {}) },
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};

const _execFileAsync = promisify(execFile);

const SAFE_ENV = { ...process.env, PATH: ENRICHED_PATH };

function tmuxExecSync(args: string[], opts?: { timeout?: number; env?: Record<string, string | undefined> }): string {
  return execFileSync("tmux", args, {
    timeout: opts?.timeout ?? EXEC_TIMEOUT_MS,
    encoding: "utf-8",
    env: { ...SAFE_ENV, ...opts?.env },
  }).toString();
}

async function tmuxExec(args: string[], opts?: { timeout?: number; killSignal?: string; env?: Record<string, string | undefined> }): Promise<{ stdout: string; stderr: string }> {
  return _execFileAsync("tmux", args, {
    timeout: opts?.timeout ?? EXEC_TIMEOUT_MS,
    killSignal: (opts?.killSignal ?? "SIGTERM") as any,
    env: { ...SAFE_ENV, ...opts?.env },
  });
}

function validatePath(p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (!path.isAbsolute(p)) return null;
  if (/[;|&`$(){}<>"\r\n\0]/.test(p)) return null;
  const resolved = path.resolve(p);
  if (resolved !== p && resolved !== p.replace(/\/+$/, "")) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

const SAFE_ARG_RE = /^[a-zA-Z0-9_.\/=:@%+, -]+$/;
function sanitizeBinaryArgs(args: string[]): string[] {
  return args.filter(a => {
    if (!SAFE_ARG_RE.test(a)) {
      log(`[SECURITY] Rejected unsafe binary arg: ${a}`);
      return false;
    }
    return true;
  });
}

function validateTmuxTarget(target: string): boolean {
  return /^[a-zA-Z0-9_.:-]+$/.test(target);
}

// Sleep/wake detection: if the last tick was more than 30s ago, we probably just woke from sleep.
// During the wake grace period, skip polling to let tmux recover and avoid zombie accumulation.
let lastTickTime = Date.now();
const SLEEP_DETECTION_THRESHOLD_MS = 30_000;
const WAKE_GRACE_PERIOD_MS = 5_000;
let wakeGraceUntil = 0;
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTickTime;
  if (elapsed > SLEEP_DETECTION_THRESHOLD_MS) {
    wakeGraceUntil = now + WAKE_GRACE_PERIOD_MS;
    dismissedIdleSince.clear();
    log(`Sleep detected (${Math.round(elapsed / 1000)}s gap), grace period until ${new Date(wakeGraceUntil).toISOString()}, dismissed-idle timers reset`);
  }
  lastTickTime = now;
}, 5_000);
function isInWakeGrace(): boolean { return Date.now() < wakeGraceUntil; }


const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const VERSION_FILE = path.join(CONFIG_DIR, "daemon.version");
const STARTED_SESSIONS_FILE = path.join(CONFIG_DIR, "started-sessions.json");

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
  agent_default_params?: {
    claude?: Record<string, string>;
    codex?: Record<string, string>;
    gemini?: Record<string, string>;
    cursor?: Record<string, string>;
  };
}

function getPermissionFlags(agentType: "claude" | "codex" | "cursor" | "gemini", config?: Config | null): string | null {
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

function getDefaultParamFlags(agentType: "claude" | "codex" | "cursor" | "gemini", config?: Config | null): string | null {
  const params = config?.agent_default_params?.[agentType];
  if (!params || Object.keys(params).length === 0) return null;
  return Object.entries(params).map(([k, v]) => `--${k} ${v}`).join(" ");
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
  runtimeVersion?: string;
}

const AUTH_FAILURE_THRESHOLD = 5;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WATCHDOG_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_FLUSH_INTERVAL_MS = 15 * 1000; // 15 seconds - flush more frequently
const MAX_LOG_QUEUE_SIZE = 500;
const LOG_QUEUE_FILE = path.join(process.env.HOME || "", ".codecast", "log-queue.json");
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

let remoteLogQueue: RemoteLog[] = [];
let syncServiceRef: SyncService | null = null;
let daemonVersion: string | undefined;
let activeConfig: Config | null = null;
const platform = process.platform;

function loadPersistedLogQueue(): void {
  try {
    if (fs.existsSync(LOG_QUEUE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOG_QUEUE_FILE, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        remoteLogQueue = [...data, ...remoteLogQueue].slice(-MAX_LOG_QUEUE_SIZE);
        fs.unlinkSync(LOG_QUEUE_FILE);
      }
    }
  } catch {}
}

function persistLogQueue(): void {
  if (remoteLogQueue.length === 0) return;
  try {
    fs.writeFileSync(LOG_QUEUE_FILE, JSON.stringify(remoteLogQueue), { mode: 0o600 });
  } catch {}
}

function getSiteUrl(): string | null {
  const config = activeConfig || readConfig();
  if (!config?.convex_url) return null;
  return config.convex_url.replace(".cloud", ".site");
}

function getAuthToken(): string | null {
  const config = activeConfig || readConfig();
  return config?.auth_token || null;
}

async function flushRemoteLogsViaHttp(): Promise<void> {
  if (remoteLogQueue.length === 0) return;
  const siteUrl = getSiteUrl();
  const token = getAuthToken();
  if (!siteUrl || !token) return;

  const logsToSend = remoteLogQueue.splice(0, 100);
  const logsWithMeta = logsToSend.map(l => ({
    ...l,
    daemon_version: daemonVersion,
    platform,
  }));

  try {
    const response = await fetch(`${siteUrl}/cli/log-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: token, logs: logsWithMeta }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      remoteLogQueue.unshift(...logsToSend);
      persistLogQueue();
    }
  } catch {
    remoteLogQueue.unshift(...logsToSend);
    persistLogQueue();
  }
}

function sendLogImmediate(level: LogLevel, message: string, metadata?: RemoteLog["metadata"]): void {
  const siteUrl = getSiteUrl();
  const token = getAuthToken();
  if (!siteUrl || !token) return;

  fetch(`${siteUrl}/cli/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: token,
      level,
      message: message.slice(0, 2000),
      metadata,
      cli_version: daemonVersion,
      platform,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

const IDLE_COOLDOWN_MS = 5 * 60_000;
const IDLE_DEBOUNCE_MS = 5_000;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastIdleNotifiedSize = new Map<string, number>();
const lastErrorNotification = new Map<string, number>();
const lastWorkingStatusSent = new Map<string, number>();
const WORKING_STATUS_THROTTLE_MS = 10_000;
const lastSentAgentStatus = new Map<string, AgentStatus>();
const workingPhaseStart = new Map<string, number>();
const MIN_WORKING_DURATION_FOR_NOTIF_MS = 10_000;
const dismissedIdleSince = new Map<string, number>();
const DISMISSED_IDLE_KILL_MS = 60 * 60 * 1000;
const zombieStrikes = new Map<string, number>();
const ZOMBIE_STRIKE_THRESHOLD = 3;

type AgentStatus = "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped";
type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
type HookStatusData = { status: AgentStatus; ts: number; permission_mode?: PermissionMode; message?: string; transcript_path?: string };
const lastHookStatus = new Map<string, HookStatusData>();
const pendingInteractivePrompts = new Map<string, { timestamp: number; options: Array<{ label: string; description?: string }>; isConfirmation?: boolean }>();
const AGENT_STATUS_DIR = path.join(process.env.HOME || "", ".codecast", "agent-status");
const skillsSyncedConversations = new Set<string>();

function readAvailableSkills(projectPath?: string): Array<{ name: string; description: string }> {
  const skills: Array<{ name: string; description: string }> = [];
  const seen = new Set<string>();
  const home = process.env.HOME || "";
  const commandDirs = [
    path.join(home, ".claude", "commands"),
    ...(projectPath ? [path.join(projectPath, ".claude", "commands")] : []),
  ];
  for (const dir of commandDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const name = file.replace(/\.md$/, "");
        if (seen.has(name)) continue;
        seen.add(name);
        try {
          const content = fs.readFileSync(path.join(dir, file), "utf-8");
          const m = content.match(/^---[\s\S]*?description:\s*(.+?)[\r\n]/m);
          skills.push({ name, description: m?.[1]?.trim() || "" });
        } catch {}
      }
    } catch {}
  }
  const skillDirs = [
    path.join(home, ".claude", "skills"),
    ...(projectPath ? [path.join(projectPath, ".claude", "skills")] : []),
  ];
  for (const dir of skillDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const skillMd = path.join(dir, entry, "SKILL.md");
        const standalone = path.join(dir, entry);
        let content = "";
        if (fs.existsSync(skillMd)) {
          content = fs.readFileSync(skillMd, "utf-8");
        } else if (entry.endsWith(".md")) {
          content = fs.readFileSync(standalone, "utf-8");
        } else continue;
        const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)[\r\n]/m);
        const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)[\r\n]/m);
        const invocable = /user_invocable:\s*true/i.test(content);
        const name = nameMatch?.[1]?.trim() || entry.replace(/\.md$/, "");
        if (!invocable || seen.has(name)) continue;
        seen.add(name);
        skills.push({ name, description: descMatch?.[1]?.trim() || "" });
      }
    } catch {}
  }
  return skills;
}

function syncSkillsForConversation(conversationId: string, projectPath: string | undefined, syncService: SyncService): void {
  if (skillsSyncedConversations.has(conversationId)) return;
  skillsSyncedConversations.add(conversationId);
  const allSkills = readAvailableSkills(projectPath);
  if (allSkills.length === 0) return;
  syncService.setAvailableSkills(conversationId, JSON.stringify(allSkills)).catch(() => {});
  if (projectPath) {
    const globalSkills = readAvailableSkills();
    const globalNames = new Set(globalSkills.map(s => s.name));
    const projectOnly = allSkills.filter(s => !globalNames.has(s.name));
    if (projectOnly.length > 0) {
      syncService.setAvailableSkills(undefined, JSON.stringify(projectOnly), projectPath).catch(() => {});
    }
  }
}

function sendAgentStatus(
  syncService: SyncService,
  conversationId: string,
  sessionId: string,
  status: AgentStatus,
  clientTs?: number,
  permissionMode?: PermissionMode,
  idleMessage?: string,
): void {
  const prevStatus = lastSentAgentStatus.get(sessionId);
  const isTransition = prevStatus !== status;
  if (status === "working" && !permissionMode && !isTransition) {
    const last = lastWorkingStatusSent.get(sessionId) ?? 0;
    if (Date.now() - last < WORKING_STATUS_THROTTLE_MS) return;
  }
  if (status === "working") {
    lastWorkingStatusSent.set(sessionId, Date.now());
    if (!workingPhaseStart.has(sessionId)) {
      workingPhaseStart.set(sessionId, Date.now());
    }
  }
  lastSentAgentStatus.set(sessionId, status);
  syncService.updateSessionAgentStatus(conversationId, status, clientTs, permissionMode).catch((err) => { log(`[sendAgentStatus] error: ${err?.message || err}`); });
  if (status === "idle" && idleMessage) {
    const workStart = workingPhaseStart.get(sessionId);
    workingPhaseStart.delete(sessionId);
    if (workStart) {
      const workingDuration = Date.now() - workStart;
      if (workingDuration >= MIN_WORKING_DURATION_FOR_NOTIF_MS) {
        syncService.createSessionNotification({
          conversation_id: conversationId,
          type: "session_idle",
          title: "Claude done",
          message: idleMessage,
        }).catch(() => {});
        log(`Sent idle notification for session ${sessionId.slice(0, 8)} (worked ${Math.round(workingDuration / 1000)}s)`);
      } else {
        log(`Skipped idle notification for session ${sessionId.slice(0, 8)} (worked only ${Math.round(workingDuration / 1000)}s < ${MIN_WORKING_DURATION_FOR_NOTIF_MS / 1000}s)`);
      }
    }
  }
  if (status === "stopped") {
    workingPhaseStart.delete(sessionId);
  }
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

function extractPendingToolUseFromTranscript(transcriptPath: string): { tool_name: string; arguments_preview: string } | null {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const tailContent = readFileTail(transcriptPath, 32768);
    const lines = tailContent.trim().split("\n");
    const tail = lines.slice(-20);

    let lastToolUse: { name: string; input: any } | null = null;
    const completedToolIds = new Set<string>();

    for (const line of tail) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === "tool_result") completedToolIds.add(block.tool_use_id);
          if (block.type === "tool_use") lastToolUse = { name: block.name, input: block.input };
        }
      } catch {}
    }

    if (!lastToolUse) return null;

    let preview = "";
    if (lastToolUse.input) {
      if (typeof lastToolUse.input.command === "string") {
        preview = lastToolUse.input.command;
      } else if (typeof lastToolUse.input.file_path === "string") {
        preview = lastToolUse.input.file_path;
      } else if (typeof lastToolUse.input.pattern === "string") {
        preview = lastToolUse.input.pattern;
      } else {
        preview = JSON.stringify(lastToolUse.input).slice(0, 300);
      }
    }
    if (lastToolUse.input?.description) {
      preview = `${lastToolUse.input.description}\n${preview}`;
    }

    return { tool_name: lastToolUse.name, arguments_preview: preview.slice(0, 500) };
  } catch {
    return null;
  }
}

const permissionRecordPending = new Set<string>();
const permissionJustResolved = new Set<string>();

const syncStats = {
  messagesSynced: 0,
  conversationsCreated: 0,
  sessionsActive: new Set<string>(),
  lastReportTime: Date.now(),
  errors: 0,
  warnings: 0,
};

let lastWatcherEventTime = Date.now();

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

function logDelivery(message: string, metadata?: RemoteLog["metadata"]): void {
  log(message, "info", metadata);
  remoteLogQueue.push({
    level: "info",
    message: `[DELIVERY] ${message.slice(0, 2000)}`,
    metadata,
    timestamp: Date.now(),
  });
  if (remoteLogQueue.length > MAX_LOG_QUEUE_SIZE) {
    remoteLogQueue.shift();
  }
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

function getSystemMetrics(): { rss_mb: number; heap_mb: number; heap_total_mb: number; uptime_min: number; fds: number; cpu_user_ms: number; cpu_system_ms: number } {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  let fds = 0;
  try {
    fds = fs.readdirSync(`/dev/fd`).length;
  } catch {
    try {
      fds = parseInt(execSync("lsof -p " + process.pid + " 2>/dev/null | wc -l", { timeout: 5000 }).toString().trim(), 10) || 0;
    } catch {}
  }
  return {
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    uptime_min: Math.round(process.uptime() / 60),
    fds,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000),
  };
}

const FD_WARN_THRESHOLD = 5000;
const RSS_WARN_THRESHOLD_MB = 1500;

function logHealthSummary(): void {
  const now = Date.now();
  const periodMinutes = Math.round((now - syncStats.lastReportTime) / 60000);
  const sessionsCount = syncStats.sessionsActive.size;
  const metrics = getSystemMetrics();

  const metricStr = `rss=${metrics.rss_mb}MB heap=${metrics.heap_mb}/${metrics.heap_total_mb}MB fds=${metrics.fds} cpu=${metrics.cpu_user_ms}+${metrics.cpu_system_ms}ms uptime=${metrics.uptime_min}min`;
  const syncStr = `${syncStats.messagesSynced}msgs ${syncStats.conversationsCreated}convos ${sessionsCount}sessions ${syncStats.errors}errs`;
  const summary = `Health: ${syncStr} | ${metricStr} (${periodMinutes}min)`;

  log(summary, "info");

  remoteLogQueue.push({
    level: "info",
    message: summary,
    metadata: {
      error_code: syncStats.errors > 0 ? `${syncStats.errors} errors` : undefined,
    },
    timestamp: now,
  });

  if (metrics.fds > FD_WARN_THRESHOLD) {
    const msg = `HIGH FD COUNT: ${metrics.fds} open file descriptors (threshold: ${FD_WARN_THRESHOLD})`;
    logWarn(msg);
    sendLogImmediate("warn", msg, { error_code: "high_fd_count" });
  }

  if (metrics.rss_mb > RSS_WARN_THRESHOLD_MB) {
    const msg = `HIGH MEMORY: ${metrics.rss_mb}MB RSS (threshold: ${RSS_WARN_THRESHOLD_MB}MB)`;
    logWarn(msg);
    sendLogImmediate("warn", msg, { error_code: "high_memory" });
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

const processedPollCommandIds = new Set<string>();

async function pollDaemonCommands(): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) return;
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
        has_tmux: hasTmux(),
      }),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data.commands && data.commands.length > 0) {
      log(`[POLL] Received ${data.commands.length} command(s): ${data.commands.map((c: any) => c.command).join(", ")}`);
      for (const cmd of data.commands) {
        if (processedPollCommandIds.has(cmd.id)) continue;
        processedPollCommandIds.add(cmd.id);
        await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
      }
    }
  } catch {}
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
        has_tmux: hasTmux(),
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
        if (processedPollCommandIds.has(cmd.id)) continue;
        processedPollCommandIds.add(cmd.id);
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

    if (data.agent_default_params !== undefined) {
      const currentConfig = readConfig();
      const serverParams = data.agent_default_params;
      const localParams = currentConfig?.agent_default_params;
      if (JSON.stringify(serverParams) !== JSON.stringify(localParams)) {
        log(`Agent default params updated from server: ${JSON.stringify(serverParams)}`);
        patchConfig({ agent_default_params: serverParams });
        if (activeConfig) {
          activeConfig.agent_default_params = serverParams;
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
          if (isManagedByLaunchd()) {
            log("Launchd will restart daemon after exit");
          } else {
            const spawned = spawnReplacement();
            if (spawned) {
              skipRespawn = true;
            } else {
              log("spawnReplacement failed, letting exit handler respawn");
            }
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
            logLifecycle("update_complete", `Binary replaced from v${currentVersion}, restarting`);
            await flushRemoteLogs();
            log("Update successful, restarting...");
            if (isManagedByLaunchd()) {
              log("Launchd will restart daemon after update");
            } else {
              const spawned = spawnReplacement();
              if (spawned) {
                skipRespawn = true;
              } else {
                log("spawnReplacement failed, letting exit handler respawn");
              }
            }
            setTimeout(() => process.exit(0), 500);
          } else {
            logLifecycle("update_failed", `Update failed from v${currentVersion}`);
            await flushRemoteLogs();
          }
        }, 1000);
        return;
      }
      case "run_workflow": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const workflowRunId = parsed.workflow_run_id;
        if (!workflowRunId) {
          error = "Missing workflow_run_id";
          break;
        }

        let projectPath = process.env.HOME || "/tmp";
        try {
          const resp = await fetch(`${siteUrl}/cli/workflow-runs/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_token: config.auth_token, run_id: workflowRunId }),
          });
          const data = await resp.json() as any;
          if (data.run?.project_path) {
            const vp = validatePath(data.run.project_path);
            if (vp) projectPath = vp;
          }
        } catch {}

        const shortId = workflowRunId.slice(-6);
        const tmuxSession = `wf-${shortId}`;

        if (!hasTmux()) {
          error = "tmux is not installed";
          break;
        }

        const argv1 = process.argv[1] || "";
        let castBin: string;
        if (argv1.endsWith("daemon.ts") || argv1.endsWith("daemon.js")) {
          const ext = argv1.endsWith(".ts") ? ".ts" : ".js";
          const indexPath = path.join(path.dirname(argv1), `index${ext}`);
          castBin = `${process.argv[0]} ${indexPath}`;
        } else if (argv1 === "_daemon" || !argv1.includes("/")) {
          castBin = process.execPath;
        } else {
          castBin = "cast";
        }
        const cmdText = `${castBin} workflow run-daemon ${workflowRunId}`;

        try {
          tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", projectPath], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", cmdText], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          spawnSync("sleep", ["0.2"]);
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          result = JSON.stringify({ tmux_session: tmuxSession, workflow_run_id: workflowRunId });
          log(`[REMOTE] Started workflow run ${workflowRunId} in tmux: ${tmuxSession}`);
        } catch (spawnErr) {
          error = `Failed to start workflow: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
        }
        break;
      }
      case "start_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const rawAgentType = parsed.agent_type;
        const agentType: "claude" | "codex" | "cursor" | "gemini" =
          rawAgentType === "codex" || rawAgentType === "cursor" || rawAgentType === "gemini" ? rawAgentType : "claude";
        const rawPath: string = parsed.project_path || process.env.HOME || "/tmp";
        const conversationId: string | undefined = parsed.conversation_id;
        const isolated: boolean = parsed.isolated === true;
        const worktreeName: string | undefined = parsed.worktree_name;

        const shortId = Math.random().toString(36).slice(2, 8);
        const tmuxSession = `cc-${agentType}-${shortId}`;

        let cwd = validatePath(rawPath) || validatePath(process.env.HOME || "/tmp") || "/tmp";
        let worktreeResult: WorktreeResult | null = null;

        if (isolated && cwd) {
          const gitRoot = (() => {
            try {
              return execSync("git rev-parse --show-toplevel", {
                cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
              }).trim();
            } catch { return null; }
          })();
          if (gitRoot) {
            const wtName = worktreeName || `session-${shortId}`;
            worktreeResult = createWorktree(gitRoot, wtName);
            if (worktreeResult) {
              cwd = worktreeResult.worktreePath;
              log(`[WORKTREE] Created isolated worktree: ${worktreeResult.worktreeName} at ${cwd}`);
            } else {
              log(`[WORKTREE] Failed to create worktree, falling back to repo root`);
            }
          }
        }

        let binary: string;
        let binaryArgs: string[] = [];
        if (agentType === "codex") {
          binary = "codex";
          const extraArgs = config.codex_args || "";
          if (extraArgs) binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
            if (!config.codex_args && !config.agent_permission_modes?.codex) {
              const flagFile = path.join(CONFIG_DIR, ".codex-bypass-notified");
              if (!fs.existsSync(flagFile)) {
                fs.writeFileSync(flagFile, new Date().toISOString());
                if (conversationId) {
                  syncServiceRef?.createSessionNotification({
                    conversation_id: conversationId,
                    type: "info" as any,
                    title: "Codex running in full-access mode",
                    message: "Codex is running without permission prompts by default. Configure with: cast config codex_args",
                  }).catch(() => {});
                }
              }
            }
          }
        } else if (agentType === "cursor") {
          binary = "cursor-agent";
        } else if (agentType === "gemini") {
          binary = "gemini";
        } else {
          binary = "claude";
          const extraArgs = config.claude_args || "";
          if (extraArgs) binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags && !extraArgs.includes("--dangerously-skip-permissions") && !extraArgs.includes("--permission-mode")) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
          }
        }

        const defaultFlags = getDefaultParamFlags(agentType as "claude" | "codex" | "cursor" | "gemini", config);
        if (defaultFlags) {
          binaryArgs.push(...defaultFlags.split(/\s+/).filter(Boolean));
        }

        binaryArgs = sanitizeBinaryArgs(binaryArgs);
        const envPrefix = worktreeResult
          ? `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT AGENT_RESOURCE_INDEX=${worktreeResult.portIndex}`
          : `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`;
        let cmdText = `${envPrefix} ${[binary, ...binaryArgs].join(" ")}`;

        let codexThreadId: string | null = null;
        if (agentType === "codex" && codexAppServerInstance?.running) {
          try {
            const sandbox = binaryArgs.includes("--full-auto") ? "danger-full-access" as const : "workspace-write" as const;
            const approval = binaryArgs.includes("--full-auto") ? "never" as const : "on-request" as const;
            const resp = await codexAppServerInstance.threadStart({ cwd, sandbox, approvalPolicy: approval });
            codexThreadId = resp.thread.id;
            cmdText = `${envPrefix} codex resume ${codexThreadId}`;
            log(`[codex-app-server] pre-created thread ${codexThreadId.slice(0, 8)} for new session`);
          } catch (err) {
            log(`[codex-app-server] thread pre-create failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (!hasTmux()) {
          error = "tmux is not installed";
          break;
        }

        try {
          tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", cwd], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", cmdText], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          spawnSync("sleep", ["0.2"]);
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          const resultObj: Record<string, any> = { tmux_session: tmuxSession, agent_type: agentType, project_path: cwd };
          if (worktreeResult) {
            resultObj.worktree_name = worktreeResult.worktreeName;
            resultObj.worktree_branch = worktreeResult.worktreeBranch;
            resultObj.worktree_path = worktreeResult.worktreePath;
            resultObj.port_index = worktreeResult.portIndex;
          }
          result = JSON.stringify(resultObj);
          log(`[REMOTE] Started ${agentType} session in tmux: ${tmuxSession} (cwd: ${cwd})`);
          if (conversationId) {
            startedSessionTmux.set(conversationId, {
              tmuxSession,
              projectPath: cwd,
              startedAt: Date.now(),
              agentType,
              worktreeName: worktreeResult?.worktreeName,
              worktreeBranch: worktreeResult?.worktreeBranch,
              worktreePath: worktreeResult?.worktreePath,
            });
            log(`[REMOTE] Registered started session tmux for conversation ${conversationId.slice(0, 12)}`);
            if (codexThreadId) {
              appServerThreads.set(codexThreadId, { threadId: codexThreadId, conversationId });
              appServerConversations.set(conversationId, codexThreadId);
              log(`[codex-app-server] registered conv=${conversationId.slice(0, 12)} -> thread=${codexThreadId.slice(0, 8)}`);
            }
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
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape"]);
          await new Promise(resolve => setTimeout(resolve, 500));
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
          result = "escape_sent";
          log(`[REMOTE] Sent Escape+Enter to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
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
      case "rewind": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        const stepsBack = parsed.steps_back;
        if (!conversationId || stepsBack === undefined || stepsBack < 1) {
          error = "Missing conversation_id or invalid steps_back";
          break;
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const agentType = detectSessionAgentType(sessionId);
        if (agentType !== "claude") {
          error = `Rewind not yet supported for ${agentType} sessions`;
          break;
        }
        const proc = await findSessionProcess(sessionId, agentType);
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (!tmuxTarget || !validateTmuxTarget(tmuxTarget)) {
          error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
          break;
        }

        const safeSteps = Math.min(Math.max(1, Math.floor(Number(stepsBack))), 50);

        const PROMPT_RE = /[❯›]/;
        const PROMPT_EMPTY_RE = /[❯›]\s*(\n|$)/;
        const BUSY_RE = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Wandering|Vibing|Coasting|Working|thinking/;

        const captureLast = async (): Promise<string> => {
          const { stdout } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxTarget, "-S", "-8"]);
          return stdout.split("\n").slice(-10).join("\n");
        };

        const isAtPrompt = async (): Promise<boolean> => {
          const last = await captureLast();
          return PROMPT_RE.test(last) && !BUSY_RE.test(last);
        };

        const hasEmptyPrompt = async (): Promise<boolean> => {
          const last = await captureLast();
          return PROMPT_EMPTY_RE.test(last);
        };

        // Step 1: Get to idle prompt
        if (!(await isAtPrompt())) {
          log(`[REWIND] Session not at prompt, sending Escape`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape"]);
          let gotPrompt = false;
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (await isAtPrompt()) { gotPrompt = true; break; }
          }
          if (!gotPrompt) {
            error = "Timed out waiting for prompt after interrupt";
            break;
          }
          log(`[REWIND] Got prompt after interrupt`);
        }

        // Step 2: Clear any existing text in the prompt
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await hasEmptyPrompt()) break;
          log(`[REWIND] Clearing existing prompt text (attempt ${attempt + 1})`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape"]);
          await new Promise(r => setTimeout(r, 500));
        }

        // Step 3: Navigate history with Up arrows
        log(`[REWIND] Sending ${safeSteps} Up arrows`);
        const upKeys = Array.from({ length: safeSteps }, () => "Up");
        await tmuxExec(["send-keys", "-t", tmuxTarget, ...upKeys]);
        await new Promise(r => setTimeout(r, 300));

        // Step 4: Verify prompt has text (history was navigated)
        if (await hasEmptyPrompt()) {
          log(`[REWIND] Prompt still empty after Up arrows, no history at position ${safeSteps}`);
          error = `No message found at history position ${safeSteps}`;
          break;
        }

        // Step 5: Submit with single Enter (no confirmation needed)
        log(`[REWIND] Submitting rewind`);
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
        result = "rewind_sent";
        log(`[REWIND] Rewind ${stepsBack} steps sent to session ${sessionId.slice(0, 8)}`);
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
        let sessionId: string | undefined;
        {
          const cache = readConversationCache();
          const reverse = buildReverseConversationCache(cache);
          sessionId = reverse[conversationId];
        }
        if (!sessionId) {
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500));
            const freshCache = readConversationCache();
            const freshReverse = buildReverseConversationCache(freshCache);
            sessionId = freshReverse[conversationId];
            if (sessionId) break;
          }
        }
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
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          const groups: string[][] = [];
          for (const k of keyList) {
            if (k === "Escape" || k === "Enter" || (groups.length > 0 && k !== groups[groups.length - 1][0])) {
              groups.push([k]);
            } else if (groups.length === 0) {
              groups.push([k]);
            } else {
              groups[groups.length - 1].push(k);
            }
          }
          for (let i = 0; i < groups.length; i++) {
            if (i > 0) {
              const prevKey = groups[i - 1][0];
              const needsDelay = prevKey === "Escape" || prevKey === "Enter";
              await new Promise((r) => setTimeout(r, needsDelay ? 600 : 150));
            }
            await tmuxExec(["send-keys", "-t", tmuxTarget, ...groups[i]]);
          }
          result = "keys_sent";
          log(`[REMOTE] Sent ${keys} (${groups.length} groups) to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
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
        if (started && validateTmuxTarget(started.tmuxSession)) {
          try {
            await tmuxExec(["kill-session", "-t", started.tmuxSession]);
            log(`[REMOTE] Killed started tmux session ${started.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
          } catch {}
          startedSessionTmux.delete(conversationId);
          result = "killed_tmux";
        }

        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (sessionId && !result) {
          const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
          if (proc) {
            const tmuxTarget = await findTmuxPaneForTty(proc.tty);
            if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
              const tmuxSessionName = tmuxTarget.split(":")[0];
              try {
                await tmuxExec(["kill-session", "-t", tmuxSessionName]);
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
          }
        }

        if (sessionId) {
          const cachedTmux = resumeSessionCache.get(sessionId);
          if (cachedTmux && validateTmuxTarget(cachedTmux)) {
            try {
              await tmuxExec(["kill-session", "-t", cachedTmux]);
              log(`[REMOTE] Killed cached resume tmux ${cachedTmux} for session ${sessionId.slice(0, 8)}`);
            } catch {}
            resumeSessionCache.delete(sessionId);
            if (!result) result = "killed_tmux";
          }
          const hbInterval = resumeHeartbeatIntervals.get(sessionId);
          if (hbInterval) { clearInterval(hbInterval); resumeHeartbeatIntervals.delete(sessionId); }
          stopCodexPermissionPoller(sessionId);
          sessionProcessCache.delete(sessionId);
          resumeInFlight.delete(sessionId);
          resumeInFlightStarted.delete(sessionId);

          const shortId = sessionId.slice(0, 8);
          try {
            const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
            for (const tmuxName of tmuxList.trim().split("\n")) {
              if (!tmuxName || !tmuxName.includes(shortId)) continue;
              if (!validateTmuxTarget(tmuxName)) continue;
              const alive = await isTmuxAgentAlive(tmuxName);
              if (!alive) {
                try {
                  await tmuxExec(["kill-session", "-t", tmuxName]);
                  log(`[REMOTE] Killed zombie tmux session ${tmuxName} for session ${shortId}`);
                  if (!result) result = "killed_zombie";
                } catch {}
              }
            }
          } catch {}
        }

        if (!result) result = sessionId ? "no_process" : "no_session";
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
        const forceReconstitute = parsed.force_reconstitute === true;
        // Skip if a resume is already in flight for this session
        if (resumeInFlight.has(sessionId)) {
          log(`[REMOTE] Resume already in flight for ${sessionId.slice(0, 8)}, skipping`);
          result = JSON.stringify({ skipped: true, reason: "resume_in_flight" });
          break;
        }
        restartingSessionIds.set(sessionId, Date.now());
        let resumed = false;
        if (forceReconstitute) {
          log(`[REMOTE] Force-reconstituting session ${sessionId.slice(0, 8)} from DB${projectPath ? ` in ${projectPath}` : ""}`);
        } else {
          log(`[REMOTE] Force-resuming session ${sessionId.slice(0, 8)}${projectPath ? ` in ${projectPath}` : ""}`);
          resumed = await autoResumeSession(sessionId, "", readTitleCache(), false, projectPath, conversationId);
          if (!resumed) {
            log(`[REMOTE] Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
            resumed = await repairAndResumeSession(sessionId, "", readTitleCache(), false, projectPath, conversationId);
          }
        }
        if (resumed) {
          if (conversationId) {
            const cache = readConversationCache();
            cache[sessionId] = conversationId;
            saveConversationCache(cache);
            if (syncServiceRef) {
              syncServiceRef.markSessionActive(conversationId).catch(() => {});
              syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {});
            }
          }
          restartingSessionIds.delete(sessionId);
          result = JSON.stringify({ resumed: true, session_id: sessionId });
          log(`[REMOTE] Force-resume succeeded for ${sessionId.slice(0, 8)}`);
        } else if (conversationId && projectPath) {
          log(`[REMOTE] Resume failed for ${sessionId.slice(0, 8)}, reconstituting session from DB...`);
          const cwd = fs.existsSync(projectPath) ? projectPath : (process.env.HOME || "/tmp");
          let reconstituted = false;

          if (config?.convex_url && config?.auth_token) {
            try {
              const siteUrl = config.convex_url.replace(".cloud", ".site");
              const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
              if (exportData.messages.length > 0) {
                const TOKEN_BUDGET = 100_000;
                const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
                const { jsonl } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId });
                const { sessionId: newSessionId, filePath: reconFilePath } = writeClaudeCodeSession(jsonl, sessionId, projectPath);
                setPosition(reconFilePath, fs.statSync(reconFilePath).size);
                log(`[REMOTE] Reconstituted JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} msgs, tail=${tailMessages})`);

                const reconResumed = await autoResumeSession(newSessionId, "", readTitleCache(), false, cwd, conversationId);
                if (reconResumed) {
                  const cache = readConversationCache();
                  cache[newSessionId] = conversationId;
                  saveConversationCache(cache);
                  if (syncServiceRef) {
                    syncServiceRef.markSessionActive(conversationId).catch(() => {});
                    syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {});
                  }
                  restartingSessionIds.delete(sessionId);
                  result = JSON.stringify({ reconstituted: true, session_id: newSessionId });
                  log(`[REMOTE] Reconstituted + resumed session ${sessionId.slice(0, 8)}`);
                  reconstituted = true;
                }
              }
            } catch (reconErr) {
              log(`[REMOTE] Reconstitution failed for ${sessionId.slice(0, 8)}: ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`);
            }
          }

          if (!reconstituted) {
            const existingStarted = startedSessionTmux.get(conversationId);
            if (existingStarted && (Date.now() - existingStarted.startedAt) < 60_000) {
              log(`[REMOTE] Fresh session ${existingStarted.tmuxSession} already started for ${conversationId.slice(0, 12)}, skipping duplicate`);
              result = JSON.stringify({ started_fresh: true, tmux_session: existingStarted.tmuxSession, deduplicated: true });
              break;
            }
            log(`[REMOTE] Starting blank session in ${projectPath}`);
            const shortId = Math.random().toString(36).slice(2, 8);
            const tmuxSession = `cc-claude-${shortId}`;
            let extraFlags = config.claude_args || "";
            const blankArgs = extraFlags ? extraFlags.split(/\s+/).filter(Boolean) : [];
            const safeBlankArgs = sanitizeBinaryArgs(blankArgs);
            const blankCmdText = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${["claude", ...safeBlankArgs].join(" ")}`;
            try {
              tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", cwd], { timeout: 5000 });
              tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", blankCmdText], { timeout: 5000 });
              tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
              spawnSync("sleep", ["0.2"]);
              tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
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
          }
        } else {
          error = `Failed to resume session ${sessionId.slice(0, 8)} — session file may not exist locally`;
        }
        break;
      }
      case "config_list": {
        const home = process.env.HOME || "";
        const claudeDir = path.join(home, ".claude");
        const codexDir = path.join(home, ".codex");

        type ConfigFile = { path: string; type: string; label: string; tool: string };
        const files: ConfigFile[] = [];

        const addFile = (filePath: string, type: string, label: string, tool: string) => {
          if (fs.existsSync(filePath)) files.push({ path: filePath, type, label, tool });
        };

        const addDir = (dir: string, type: string, tool: string) => {
          if (!fs.existsSync(dir)) return;
          try {
            for (const f of fs.readdirSync(dir)) {
              const fullPath = path.join(dir, f);
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                // Skills are directories containing SKILL.md
                const skillFile = path.join(fullPath, "SKILL.md");
                if (fs.existsSync(skillFile)) {
                  files.push({ path: skillFile, type, label: f, tool });
                }
              } else if (f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".toml")) {
                files.push({ path: fullPath, type, label: f.replace(/\.(md|json|toml)$/, ""), tool });
              }
            }
          } catch {}
        };

        // Claude global files
        addFile(path.join(claudeDir, "CLAUDE.md"), "instructions", "Global CLAUDE.md", "claude");
        addFile(path.join(claudeDir, "settings.json"), "settings", "settings.json", "claude");
        addFile(path.join(claudeDir, "settings.local.json"), "settings", "settings.local.json", "claude");
        addFile(path.join(claudeDir, "keybindings.json"), "keybindings", "keybindings.json", "claude");
        addDir(path.join(claudeDir, "agents"), "agent", "claude");
        addDir(path.join(claudeDir, "commands"), "command", "claude");
        addDir(path.join(claudeDir, "skills"), "skill", "claude");
        addDir(path.join(claudeDir, "prompts"), "prompt", "claude");

        // Codex global files
        addFile(path.join(codexDir, "AGENTS.md"), "instructions", "Global AGENTS.md", "codex");
        addFile(path.join(codexDir, "AGENTS.override.md"), "instructions", "AGENTS.override.md", "codex");
        addFile(path.join(codexDir, "config.toml"), "settings", "config.toml", "codex");
        addDir(path.join(codexDir, "prompts"), "command", "codex");
        addDir(path.join(codexDir, "skills"), "skill", "codex");
        if (fs.existsSync(path.join(codexDir, "rules"))) {
          for (const f of fs.readdirSync(path.join(codexDir, "rules"))) {
            files.push({ path: path.join(codexDir, "rules", f), type: "rules", label: f, tool: "codex" });
          }
        }

        // Per-project files from known project paths
        const args_parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const projectPaths: string[] = args_parsed.project_paths || [];
        for (const pp of projectPaths) {
          const p = validatePath(pp);
          if (!p) continue;
          const name = path.basename(p);
          addFile(path.join(p, "CLAUDE.md"), "project_instructions", `${name}/CLAUDE.md`, "claude");
          addFile(path.join(p, "AGENTS.md"), "project_instructions", `${name}/AGENTS.md`, "codex");
          addFile(path.join(p, ".claude", "settings.json"), "project_settings", `${name}/.claude/settings.json`, "claude");
          addFile(path.join(p, ".claude", "settings.local.json"), "project_settings", `${name}/.claude/settings.local.json`, "claude");
          addFile(path.join(p, ".mcp.json"), "mcp", `${name}/.mcp.json`, "claude");
          addFile(path.join(p, ".codex", "config.toml"), "project_settings", `${name}/.codex/config.toml`, "codex");
          addDir(path.join(p, ".claude", "agents"), "project_agent", "claude");
          addDir(path.join(p, ".claude", "skills"), "project_skill", "claude");
          addDir(path.join(p, ".claude", "commands"), "project_command", "claude");
        }

        result = JSON.stringify(files);
        break;
      }
      case "config_read": {
        const { file_path: readPath } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!readPath || typeof readPath !== "string") {
          error = "Missing file_path";
          break;
        }
        const home = process.env.HOME || "";
        const allowed = [path.join(home, ".claude"), path.join(home, ".codex")];
        const resolved = path.resolve(readPath);
        const isAllowed = allowed.some((a) => resolved.startsWith(a + path.sep) || resolved === a) ||
          readPath.endsWith("/CLAUDE.md") || readPath.endsWith("/AGENTS.md") ||
          readPath.endsWith("/.mcp.json") || readPath.endsWith("/settings.json") ||
          readPath.endsWith("/settings.local.json") || readPath.endsWith("/config.toml") ||
          readPath.includes("/.claude/") || readPath.includes("/.codex/");
        if (!isAllowed) {
          error = "Path not allowed";
          break;
        }
        if (!fs.existsSync(resolved)) {
          result = JSON.stringify({ content: null, exists: false });
        } else {
          const content = fs.readFileSync(resolved, "utf-8");
          result = JSON.stringify({ content, exists: true });
        }
        break;
      }
      case "config_write": {
        const { file_path: writePath, content: writeContent } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!writePath || typeof writePath !== "string" || typeof writeContent !== "string") {
          error = "Missing file_path or content";
          break;
        }
        const home = process.env.HOME || "";
        const allowed = [path.join(home, ".claude"), path.join(home, ".codex")];
        const resolved = path.resolve(writePath);
        const isAllowed = allowed.some((a) => resolved.startsWith(a + path.sep)) ||
          writePath.endsWith("/CLAUDE.md") || writePath.endsWith("/AGENTS.md") ||
          writePath.endsWith("/.mcp.json") || writePath.endsWith("/settings.json") ||
          writePath.endsWith("/settings.local.json") || writePath.endsWith("/config.toml") ||
          writePath.includes("/.claude/") || writePath.includes("/.codex/");
        if (!isAllowed) {
          error = "Path not allowed";
          break;
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, writeContent, "utf-8");
        result = JSON.stringify({ success: true });
        log(`[CONFIG] Wrote ${resolved}`);
        break;
      }
      case "config_create": {
        const { dir_path, filename, content: createContent = "" } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!dir_path || !filename) {
          error = "Missing dir_path or filename";
          break;
        }
        const home = process.env.HOME || "";
        const allowedDirs = [
          path.join(home, ".claude", "agents"),
          path.join(home, ".claude", "commands"),
          path.join(home, ".claude", "skills"),
          path.join(home, ".claude", "prompts"),
          path.join(home, ".codex", "prompts"),
          path.join(home, ".codex", "skills"),
        ];
        const expandedDir = dir_path.startsWith("~/") ? path.join(home, dir_path.slice(2)) : dir_path;
        const resolvedDir = path.resolve(expandedDir);
        if (!allowedDirs.some((a) => resolvedDir === a || resolvedDir.startsWith(a + path.sep))) {
          error = "Dir not allowed";
          break;
        }
        if (!/^[a-zA-Z0-9_-]+\.(md|json|toml)$/.test(filename)) {
          error = "Invalid filename";
          break;
        }
        const newPath = path.join(resolvedDir, filename);
        if (fs.existsSync(newPath)) {
          error = "File already exists";
          break;
        }
        fs.mkdirSync(resolvedDir, { recursive: true });
        fs.writeFileSync(newPath, createContent, "utf-8");
        result = JSON.stringify({ success: true, path: newPath });
        log(`[CONFIG] Created ${newPath}`);
        break;
      }
      case "config_delete": {
        const { file_path: deletePath } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!deletePath || typeof deletePath !== "string") {
          error = "Missing file_path";
          break;
        }
        const home = process.env.HOME || "";
        const allowedDirs = [
          path.join(home, ".claude", "agents"),
          path.join(home, ".claude", "commands"),
          path.join(home, ".claude", "skills"),
          path.join(home, ".claude", "prompts"),
          path.join(home, ".codex", "prompts"),
          path.join(home, ".codex", "skills"),
        ];
        const expandedDelete = deletePath.startsWith("~/") ? path.join(home, deletePath.slice(2)) : deletePath;
        const resolved = path.resolve(expandedDelete);
        if (!allowedDirs.some((a) => resolved.startsWith(a + path.sep))) {
          error = "Only files in agents/commands/skills/prompts dirs can be deleted";
          break;
        }
        if (!fs.existsSync(resolved)) {
          error = "File not found";
          break;
        }
        fs.unlinkSync(resolved);
        result = JSON.stringify({ success: true });
        log(`[CONFIG] Deleted ${resolved}`);
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
  await flushRemoteLogsViaHttp();
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
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
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

  const worktreeMatch = projectPath.match(/(?:\.codecast\/worktrees|\.conductor)\/([^/]+)/);
  const worktreeName = worktreeMatch ? worktreeMatch[1] : undefined;

  return {
    commitHash,
    branch,
    remoteUrl,
    status,
    diff: diff ? diff.slice(0, 100000) : undefined,
    diffStaged: diffStaged ? diffStaged.slice(0, 100000) : undefined,
    root,
    worktreeName,
    worktreeBranch: worktreeName ? branch : undefined,
    worktreePath: worktreeName ? projectPath : undefined,
  };
}

const CODECAST_WORKTREE_DIR = ".codecast/worktrees";

interface WorktreeResult {
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  portIndex: number;
}

function createWorktree(repoRoot: string, name: string): WorktreeResult | null {
  const worktreeDir = path.join(repoRoot, CODECAST_WORKTREE_DIR);
  const worktreePath = path.join(worktreeDir, name);
  const branchName = `codecast/${name}`;

  if (fs.existsSync(worktreePath)) {
    const existingBranch = (() => {
      try {
        return execSync(`git rev-parse --abbrev-ref HEAD`, {
          cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch { return branchName; }
    })();
    return {
      worktreePath,
      worktreeName: name,
      worktreeBranch: existingBranch,
      portIndex: assignPortIndex(repoRoot),
    };
  }

  fs.mkdirSync(worktreeDir, { recursive: true });

  // Retry loop to handle concurrent git lock contention
  let created = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      try { execSync(`sleep ${(200 + attempt * 300) / 1000}`, { stdio: "ignore" }); } catch {}
    }
    try {
      execSync(`git worktree add -b ${branchName} ${worktreePath}`, {
        cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
      created = true;
      break;
    } catch (err) {
      // Branch already exists — try without -b
      try {
        execSync(`git worktree add ${worktreePath} ${branchName}`, {
          cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        created = true;
        break;
      } catch (err2) {
        lastErr = err2;
      }
    }
  }

  if (!created) {
    log(`[WORKTREE] Failed to create worktree: ${lastErr}`);
    return null;
  }

  // Remove large build artifact directories that bloat the worktree
  const LARGE_ARTIFACT_DIRS = ["packages/desktop/src-tauri/target"];
  for (const dir of LARGE_ARTIFACT_DIRS) {
    const fullPath = path.join(worktreePath, dir);
    if (fs.existsSync(fullPath)) {
      try { execSync(`/bin/rm -rf ${JSON.stringify(fullPath)}`, { stdio: "ignore" }); } catch {}
    }
  }

  copySetupFiles(repoRoot, worktreePath);

  return {
    worktreePath,
    worktreeName: name,
    worktreeBranch: branchName,
    portIndex: assignPortIndex(repoRoot),
  };
}

function assignPortIndex(repoRoot: string): number {
  const worktreeDir = path.join(repoRoot, CODECAST_WORKTREE_DIR);
  if (!fs.existsSync(worktreeDir)) return 0;
  const existing = fs.readdirSync(worktreeDir).filter(f => {
    try { return fs.statSync(path.join(worktreeDir, f)).isDirectory(); } catch { return false; }
  });
  return Math.min(existing.length - 1, 9);
}

function copySetupFiles(mainRoot: string, worktreePath: string): void {
  const configFile = path.join(mainRoot, ".wt-setup-files");
  const patterns = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    : [".env", ".env.local"];

  for (const pattern of patterns) {
    const src = path.join(mainRoot, pattern);
    const dest = path.join(worktreePath, pattern);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      const destDir = path.dirname(dest);
      fs.mkdirSync(destDir, { recursive: true });
      if (fs.statSync(src).isDirectory()) {
        execSync(`cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" });
      } else {
        fs.copyFileSync(src, dest);
      }
    } catch {}
  }
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

function readFileHead(filePath: string, maxBytes: number = 8192): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readFileTail(filePath: string, maxBytes: number = 8192): string {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const offset = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readFileHeadAndTail(filePath: string, headBytes: number = 8192, tailBytes: number = 8192): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= headBytes + tailBytes) {
    return fs.readFileSync(filePath, "utf-8");
  }
  const head = readFileHead(filePath, headBytes);
  const tail = readFileTail(filePath, tailBytes);
  return head + "\n" + tail;
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
  const isSubagent = filePath.split(path.sep).includes("subagents");
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
    let messages = parseSessionFile(newContent);

    if (permissionJustResolved.has(sessionId)) {
      const before = messages.length;
      messages = messages.filter(m => !(m.role === "user" && /^[yn]$/i.test(m.content?.trim())));
      if (messages.length < before) {
        log(`Filtered ${before - messages.length} permission response message(s) for session ${sessionId.slice(0, 8)}`);
      }
      permissionJustResolved.delete(sessionId);
    }

    let conversationId = conversationCache[sessionId];

    // Check for summary title using the already-read new chunk + small tail read
    if (conversationId) {
      let titleContent: string;
      try {
        titleContent = newContent + "\n" + readFileTail(filePath, 4096);
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(titleContent);
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
        let headContent: string;
        try {
          headContent = readFileHead(filePath, 16384);
        } catch { headContent = ""; }
        const headMessages = parseSessionFile(headContent);
        const userMsgs = headMessages.filter(m => m.role === "user").slice(0, 3);
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
    let headContent: string;
    try {
      headContent = readFileHead(filePath, 16384);
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
        return;
      }
      throw err;
    }

    try {
      const slug = extractSlug(headContent);
      const parentMessageUuid = extractParentUuid(headContent);
      const firstMessageTimestamp = messages[0]?.timestamp;
      const dirName = path.basename(path.dirname(filePath));
      const decodedPath = dirName ? decodeProjectDirName(dirName) : undefined;
      const actualProjectPath = (decodedPath && fs.existsSync(decodedPath) ? decodedPath : null) || extractCwd(headContent) || projectPath;
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
      if (startedSessionTmux.size > 0 && !isSubagent && !parentConversationId) {
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
        if (parentConversationId) {
          syncService.linkSessions(parentConversationId, conversationId, subagentDescriptions.get(sessionId)).then(() => {
            log(`Linked started conversation ${conversationId.slice(0, 12)} to parent ${parentConversationId!.slice(0, 12)}`);
          }).catch((err) => {
            log(`Failed to link started conversation to parent: ${err}`);
          });
        }
      } else {
        const cliFlags = detectCliFlags(headContent + "\n" + newContent);
        let subagentDescription: string | undefined;
        if (isSubagent) {
          try {
            const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
              if (meta.description) {
                subagentDescription = meta.description;
                subagentDescriptions.set(sessionId, meta.description);
              }
            }
          } catch {}
        }
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
          subagentDescription,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        if (isPlanHandoff && parentConversationId) {
          planHandoffChildren.set(parentConversationId, conversationId);
          log(`Registered plan handoff: parent ${parentConversationId.slice(0, 12)} -> child ${conversationId.slice(0, 12)}`);
        }
        log(`Created conversation ${conversationId} for session ${sessionId}`);
        syncStats.conversationsCreated++;
        syncSkillsForConversation(conversationId, actualProjectPath, syncService);

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
              syncService.linkSessions(conversationId, childConvId, subagentDescriptions.get(childSessionId)).then(() => {
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

      let retryHeadContent: string;
      try {
        retryHeadContent = readFileHead(filePath, 16384);
      } catch (readErr: any) {
        if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for retry queue. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw readErr;
      }

      const slug = extractSlug(retryHeadContent);
      const firstMsgTimestamp = messages[0]?.timestamp;
      const retryDirName = path.basename(path.dirname(filePath));
      const retryDecoded = retryDirName ? decodeProjectDirName(retryDirName) : undefined;
      const retryProjectPath = (retryDecoded && fs.existsSync(retryDecoded) ? retryDecoded : null) || extractCwd(retryHeadContent) || projectPath;
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

  // Intercept plan mode tool calls (ExitPlanMode, TaskCreate, TaskUpdate) and sync to Convex
  if (conversationId && (newContent.includes("ExitPlanMode") || newContent.includes("TaskCreate") || newContent.includes("TaskUpdate"))) {
    const lines = newContent.split("\n");
    for (const line of lines) {
      if (!line.includes("ExitPlanMode") && !line.includes("TaskCreate") && !line.includes("TaskUpdate")) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type !== "tool_use") continue;

          if (block.name === "ExitPlanMode" && block.input?.plan && !planModeSynced.has(sessionId)) {
            planModeSynced.add(sessionId);
            const dirName = path.basename(path.dirname(filePath));
            const projPath = dirName ? decodeProjectDirName(dirName) : undefined;
            try {
              const planShortId = await syncService.syncPlanFromPlanMode({
                sessionId,
                planContent: block.input.plan,
                projectPath: projPath,
              });
              if (planShortId) {
                planModePlanMap.set(sessionId, planShortId);
                savePlanModeCache();
                if (projPath) {
                  try {
                    const snippet = await syncService.getPlanSnippet(planShortId);
                    if (snippet) {
                      const contextDir = path.join(projPath, ".claude");
                      if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
                      const contextFile = path.join(contextDir, "plan-context.md");
                      fs.writeFileSync(contextFile, `# Active Plan Context\n\n${snippet}\n`, { mode: 0o644 });
                      log(`Wrote plan context to ${contextFile}`);
                    }
                  } catch (ctxErr) {
                    log(`Failed to write plan context: ${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)}`);
                  }
                }
              }
              log(`Synced plan_mode plan ${planShortId} for session ${sessionId.slice(0, 8)} (${block.input.plan.length} chars)`);
            } catch (err) {
              log(`Failed to sync plan_mode: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (block.name === "TaskCreate" && block.input?.subject) {
            const taskMap = planModeTaskMap.get(sessionId) || new Map();
            const localId = String(taskMap.size + 1);
            try {
              const shortId = await syncService.syncTaskFromPlanMode({
                sessionId,
                title: block.input.subject,
                description: block.input.description,
                planShortId: planModePlanMap.get(sessionId),
              });
              if (shortId) {
                taskMap.set(localId, shortId);
                planModeTaskMap.set(sessionId, taskMap);
                savePlanModeCache();
                log(`Synced task ${shortId} from TaskCreate in session ${sessionId.slice(0, 8)}: ${block.input.subject}`);
              }
            } catch (err) {
              log(`Failed to sync TaskCreate: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (block.name === "TaskUpdate" && block.input?.taskId && block.input?.status) {
            const taskMap = planModeTaskMap.get(sessionId);
            const shortId = taskMap?.get(String(block.input.taskId));
            if (shortId) {
              const status = block.input.status === "completed" ? "done" : block.input.status === "in_progress" ? "in_progress" : block.input.status;
              try {
                await syncService.updateTaskStatus(shortId, status, sessionId);
                log(`Updated task ${shortId} -> ${status} in session ${sessionId.slice(0, 8)}`);
              } catch (err) {
                log(`Failed to sync TaskUpdate: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      } catch {}
    }
  }

  syncSkillsForConversation(conversationId, projectPath, syncService);

  const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
  if (batchResult.authExpired) {
    log("⚠️  Authentication expired - sync paused");
    return;
  }
  if (batchResult.conversationNotFound) {
    log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
    delete conversationCache[sessionId];
    saveConversationCache(conversationCache);

    let recreateHeadContent: string;
    try {
      recreateHeadContent = readFileHead(filePath, 16384);
    } catch (readErr: any) {
      if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath} for conversation recreation. Skipping.`);
        setPosition(filePath, stats.size);
        return;
      }
      throw readErr;
    }

    const slug = extractSlug(recreateHeadContent);
    const firstMessageTimestamp = messages[0]?.timestamp;
    const recreateDirName = path.basename(path.dirname(filePath));
    const recreateDecoded = recreateDirName ? decodeProjectDirName(recreateDirName) : undefined;
    const recreateProjectPath = (recreateDecoded && fs.existsSync(recreateDecoded) ? recreateDecoded : null) || extractCwd(recreateHeadContent) || projectPath;
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
        permissionJustResolved.add(sessionId);
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
            const key = decision.approved ? "Enter" : "Escape";
            log(`Attempting to inject '${key}' to session ${sessionId.slice(0, 8)}`);

            findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
              if (!proc) {
                log("No process found for session");
                return;
              }
              findTmuxPaneForTty(proc.tty).then(async (tmuxTarget) => {
                try {
                  if (tmuxTarget) {
                    await tmuxExec(["send-keys", "-t", tmuxTarget, key]);
                    log(`Injected '${key}' via tmux for session ${sessionId.slice(0, 8)}`);
                  } else {
                    await injectViaTerminal(proc.tty, decision.approved ? "\r" : "\x1b", proc.termProgram);
                    log(`Injected '${key}' via terminal for session ${sessionId.slice(0, 8)}`);
                  }
                } catch (err) {
                  log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
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
      if (errorText && !permissionPrompt && !isSubagent) {
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

        if (wasInterrupted) {
          idleTimers.delete(sessionId);
          lastIdleNotifiedSize.set(sessionId, stats.size);
          sendAgentStatus(syncService, conversationId, sessionId, "idle");
        } else {
          const hookEntry = lastHookStatus.get(sessionId);
          const hookIsRecent = hookEntry && (Date.now() / 1000 - hookEntry.ts) < 30;

          const hasPendingToolCalls = (lastAssistantMessage.toolCalls?.length ?? 0) > 0 &&
            !messages.some(m => m.role === "assistant" && (m.toolResults?.length ?? 0) > 0 &&
              m.timestamp >= lastAssistantMessage.timestamp);

          const hookSaysActive = hookIsRecent && hookEntry &&
            (hookEntry.status === "working" || hookEntry.status === "thinking" || hookEntry.status === "compacting");

          if (hasPendingToolCalls || hookSaysActive) {
            if (!hookIsRecent) {
              sendAgentStatus(syncService, conversationId, sessionId, "working");
            }
            idleTimers.delete(sessionId);
          } else if (lastAssistantMessage.stopReason === "end_turn") {
            idleTimers.delete(sessionId);
            const capturedSize = stats.size;
            if (capturedSize !== lastIdleNotifiedSize.get(sessionId)) {
              lastIdleNotifiedSize.set(sessionId, capturedSize);
              const preview = isSubagent ? undefined : truncateForNotification(lastAssistantMessage.content);
              sendAgentStatus(syncService, conversationId, sessionId, "idle", undefined, undefined, preview);
            }
          } else {
            if (!hookIsRecent) {
              sendAgentStatus(syncService, conversationId, sessionId, "working");
            }
            const capturedSize = stats.size;
            const capturedConvId = conversationId;

            if (capturedSize !== lastIdleNotifiedSize.get(sessionId)) {
              lastIdleNotifiedSize.set(sessionId, capturedSize);
              idleTimers.set(sessionId, setTimeout(() => {
                idleTimers.delete(sessionId);
                const preview = isSubagent ? undefined : truncateForNotification(lastAssistantMessage.content);
                sendAgentStatus(syncService, capturedConvId, sessionId, "idle", undefined, undefined, preview);
              }, IDLE_DEBOUNCE_MS));
            }
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
      let titleContent: string;
      try {
        titleContent = newContent + "\n" + readFileTail(filePath, 4096);
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(titleContent);
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
      let headContent: string;
      try {
        headContent = readFileHead(filePath, 16384);
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
          return;
        }
        throw err;
      }

      try {
        const projectPath = extractCodexCwd(headContent);
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

    // Agent status tracking for Codex sessions (skip if managed by app-server)
    if (conversationId && !appServerConversations.has(conversationId)) {
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
  termProgram?: string;
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

function detectSessionAgentType(sessionId: string): "claude" | "codex" | "cursor" | "gemini" {
  if (sessionId.startsWith("session-")) return "gemini";
  const sessionFile = findSessionFile(sessionId);
  return sessionFile?.agentType ?? "claude";
}

function tryRegisterSessionProcess(sessionId: string, agentType: "claude" | "codex" | "cursor" | "gemini"): void {
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
          if (!resumeHeartbeatIntervals.has(sessionId)) {
            const interval = setInterval(async () => {
              try {
                const result = await syncServiceRef!.heartbeatManagedSession(sessionId);
                await processHeartbeatResponse(sessionId, result);
              } catch {}
            }, 30000);
            resumeHeartbeatIntervals.set(sessionId, interval);
          }
        }
      }
    }).catch(() => {});
  } catch {}
}

async function findSessionProcess(sessionId: string, agentType: "claude" | "codex" | "cursor" | "gemini" = "claude"): Promise<ClaudeSessionInfo | null> {
  // Check process cache first
  const cached = await getCachedSessionProcess(sessionId);
  if (cached) {
    log(`Process cache hit for session ${sessionId.slice(0, 8)}: pid=${cached.pid}`);
    return cached;
  }

  const binaryPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "claude";

  try {
    const codexResumeCandidates: Array<{ pid: number; tty: string }> = [];
    // Strategy 0: Check session registry (written by SessionStart hook)
    try {
      const registryFile = path.join(CONFIG_DIR, "session-registry", `${sessionId}.json`);
      if (fs.existsSync(registryFile)) {
        const reg = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        const pid = reg.pid;
        const tty = normalizeTty(reg.tty);
        const termProgram = reg.term || undefined;
        // Verify process is still alive and is a claude-like process
        const { stdout: checkPs } = await execAsync(`ps -o comm= -p ${pid} 2>/dev/null`);
        if (checkPs.trim()) {
          if (agentType === "codex") {
            log(`Ignoring registry candidate for codex session ${sessionId.slice(0, 8)} (pid=${pid})`);
          } else {
          const result = { pid, tty, sessionId, termProgram };
          cacheSessionProcess(sessionId, result);
          log(`Found session ${sessionId.slice(0, 8)} via registry: pid=${pid}, tty=${tty}, term=${termProgram ?? "unknown"}`);
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
      const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
      const shortId = sessionId.slice(0, 8);
      for (const tmuxName of tmuxList.trim().split("\n")) {
        if (!tmuxName.includes(shortId)) continue;
        // Get the pane TTY for this tmux session
        try {
          const { stdout: paneInfo } = await tmuxExec(["list-panes", "-t", tmuxName, "-F", "#{pane_tty} #{pane_pid}"]);
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
        const jsonlContent = readFileHead(jsonlPath, 5000);
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
  if (!hasTmux()) return null;
  try {
    const { stdout } = await tmuxExec(["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]);
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

type InteractivePrompt = { question: string; options: Array<{ label: string; description?: string }>; isConfirmation?: boolean };

function parseInteractivePrompt(text: string): InteractivePrompt | null {
  const lines = text.split("\n");
  const optionPattern = /^\s*[❯>)]*\s*(\d+)[.)]\s+(.+?)(?:\s{2,}(.+?))?$/;
  const options: Array<{ label: string; description?: string }> = [];
  let firstOptionIdx = -1;
  let lastOptionIdx = -1;
  let gapCount = 0;
  let hasCursorIndicator = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(optionPattern);
    if (m) {
      if (lastOptionIdx < 0) lastOptionIdx = i;
      firstOptionIdx = i;
      if (/^\s*[❯>]\s*\d/.test(lines[i])) hasCursorIndicator = true;
      const label = m[2].replace(/\s*[✓✗✔☑]\s*/g, "").trim();
      if (label.length > 80) continue;
      const description = m[3]?.trim() || undefined;
      if (label) options.unshift({ label, description });
      gapCount = 0;
    } else if (options.length > 0) {
      const trimmed = lines[i].trim();
      if (!trimmed || /^\s{10,}/.test(lines[i])) {
        gapCount++;
        if (gapCount > 3) break;
      } else {
        break;
      }
    }
  }

  if (options.length >= 2 && firstOptionIdx >= 0) {
    const tail = lines.slice(firstOptionIdx).join("\n");
    const hasFooter = /enter to confirm|esc(ape)? to (exit|cancel)|↑.*↓|←.*→|arrow keys/i.test(tail);
    if (hasCursorIndicator || hasFooter) {
      const headerLines = lines.slice(Math.max(0, firstOptionIdx - 5), firstOptionIdx)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !/^[❯>]/.test(l) && !/^[─━═─\-_]{5,}$/.test(l));
      const question = headerLines[headerLines.length - 1] || "Select an option";
      return { question, options };
    }
  }

  // Detect confirmation prompts: "Press Enter to continue..." / "Esc to cancel"
  const joined = lines.slice(-15).join("\n");
  const enterMatch = joined.match(/(?:press\s+)?enter\s+to\s+(continue|confirm|proceed|accept)[\s.…]*/i);
  const escMatch = joined.match(/esc(?:ape)?\s+to\s+(cancel|exit|quit|go back)[\s.…]*/i);
  if (enterMatch) {
    const contextLines = lines.filter(l => l.trim().length > 0).slice(-8);
    const headerLine = contextLines.find(l => !/(press|enter|esc|─|━)/i.test(l) && l.trim().length > 5);
    const question = headerLine?.trim() || "Continue?";
    const confirmOptions: Array<{ label: string; description?: string }> = [
      { label: `Continue (${enterMatch[1]})` },
    ];
    if (escMatch) {
      confirmOptions.push({ label: `Cancel (${escMatch[1]})` });
    }
    return { question, options: confirmOptions, isConfirmation: true };
  }

  return null;
}

type PollMessage = { keys?: string[]; steps?: Array<{ key: string; text?: string }>; text?: string; display?: string };

function parsePollMessage(content: string): PollMessage | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__cc_poll && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps))) return parsed;
  } catch {}
  return null;
}

async function checkForInteractivePrompt(
  tmuxTarget: string,
  sessionId: string,
  conversationId: string,
  syncService: SyncService,
  delayMs = 2000,
): Promise<void> {
  if (pendingInteractivePrompts.has(sessionId)) { log(`Skipping prompt check: pending prompt exists for ${sessionId.slice(0, 8)}`); return; }

  await new Promise(resolve => setTimeout(resolve, delayMs));

  try {
    const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxTarget, "-S", "-50"]);
    const prompt = parseInteractivePrompt(paneContent);
    if (!prompt) {
      log(`No interactive prompt found in ${tmuxTarget} for session ${sessionId.slice(0, 8)}`);
      return;
    }

    log(`Interactive prompt detected in session ${sessionId.slice(0, 8)}: "${prompt.question}" with ${prompt.options.length} options (confirmation=${!!prompt.isConfirmation})`);

    const now = Date.now();
    pendingInteractivePrompts.set(sessionId, { timestamp: now, options: prompt.options, isConfirmation: prompt.isConfirmation });

    await syncService.addMessages({
      conversationId,
      messages: [{
        messageUuid: `interactive-prompt-${sessionId}-${now}`,
        role: "assistant" as const,
        content: "",
        timestamp: now,
        toolCalls: [{
          id: `prompt-${now}`,
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: prompt.question,
              options: prompt.options,
              ...(prompt.isConfirmation ? { isConfirmation: true } : {}),
            }],
          },
        }],
      }],
    });

    log(`Synced interactive prompt as AskUserQuestion for session ${sessionId.slice(0, 8)}`);
  } catch (err) {
    log(`Interactive prompt check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function tmuxPromptStillHasInput(paneContent: string, input: string): boolean {
  const normalizedInput = normalizePromptText(input);
  if (!normalizedInput) return false;
  const lines = paneContent.split("\n");
  const recent = lines.slice(-80).join("\n");
  const lastPromptIndex = Math.max(recent.lastIndexOf("❯"), recent.lastIndexOf("›"));
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
      if (step.text) {
        await tmuxExec(["send-keys", "-t", target, "Escape"]);
        await new Promise(resolve => setTimeout(resolve, 500));
        await tmuxExec(["send-keys", "-t", target, "-l", step.text]);
        await new Promise(resolve => setTimeout(resolve, 150));
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        await new Promise(resolve => setTimeout(resolve, 200));
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        await new Promise(resolve => setTimeout(resolve, 300));
      } else {
        await tmuxExec(["send-keys", "-t", target, step.key]);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (poll.text) {
      await new Promise(resolve => setTimeout(resolve, 300));
      await tmuxExec(["send-keys", "-t", target, "-l", poll.text]);
      await new Promise(resolve => setTimeout(resolve, 150));
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
      await new Promise(resolve => setTimeout(resolve, 200));
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
    }
    log(`Injected poll response via tmux to ${target}`);
    return;
  }
  const sanitized = content.replace(/\r?\n/g, " ");

  // Check if there's a blocking dialog and dismiss it first
  try {
    const { stdout: preCheck } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", "-5"]);
    const hasBlockingWarning = /Press enter to continue|Update available|⚠|recorded with model|weekly limit/i.test(preCheck);
    const promptVisible = /[❯›]/.test(preCheck.split("\n").slice(-5).join("\n"));
    if (hasBlockingWarning && !promptVisible) {
      log(`Clearing blocking dialog before inject to ${target}`);
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else if (hasBlockingWarning && promptVisible) {
      await tmuxExec(["send-keys", "-t", target, "Escape"]);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch {}

  const contentLines = content.split(/\r?\n/).length;
  const captureLines = Math.max(30, contentLines + Math.ceil(sanitized.length / 60) + 10);
  const contentPrefix = sanitized.slice(0, 40);

  const doPaste = async () => {
    const id = `cc-${process.pid}-${Date.now()}`;
    const tmpFile = `/tmp/${id}`;
    try {
      fs.writeFileSync(tmpFile, content);
      await tmuxExec(["load-buffer", "-b", id, tmpFile]);
      await tmuxExec(["paste-buffer", "-t", target, "-b", id, "-d", "-p"]);
    } catch (err) {
      await tmuxExec(["send-keys", "-t", target, "-l", sanitized]);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  };

  // Capture pane before paste for before/after comparison
  let prePaste = "";
  try {
    const { stdout } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
    prePaste = stdout;
  } catch {}

  // Paste once
  await doPaste();

  // Brief confirmation: did the pane change? (5 checks, 200ms apart = 1s max)
  let pasteConfirmed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      const { stdout: postPaste } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
      if (postPaste !== prePaste) {
        pasteConfirmed = true;
        break;
      }
    } catch {}
  }

  if (!pasteConfirmed) {
    log(`Paste may not have landed in ${target} (pane unchanged after 1s), proceeding anyway`);
  }

  // Send Enter (double-tap with 200ms gap to handle occasional hangs)
  const enterDelay = Math.max(200, Math.min(1000, Math.ceil(sanitized.length / 100) * 50));
  await new Promise(resolve => setTimeout(resolve, enterDelay));
  await tmuxExec(["send-keys", "-t", target, "Enter"]);
  await new Promise(resolve => setTimeout(resolve, 200));
  await tmuxExec(["send-keys", "-t", target, "Enter"]);

  // Post-submit: verify the agent started processing
  let rePasted = false;
  for (let retry = 0; retry < 5; retry++) {
    await new Promise(resolve => setTimeout(resolve, 600));
    try {
      const { stdout: postCheck } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
      const lastLines = postCheck.split("\n").slice(-15).join("\n");
      const hasPrompt = /[❯›]/.test(lastLines);
      const hasActivity = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|●|thinking|Bash|Read|Edit|Write|Glob|Grep/.test(lastLines);

      if (hasActivity) {
        break;
      }

      // Check if text is still sitting in the input (look at full capture, not just last lines)
      const inputStuck = tmuxPromptStillHasInput(postCheck, contentPrefix);

      if (!hasPrompt && !inputStuck) {
        // No prompt visible AND text not in input = agent is processing
        break;
      }

      if (inputStuck) {
        log(`Enter may not have submitted (retry ${retry + 1}), sending Enter again to ${target}`);
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        await new Promise(resolve => setTimeout(resolve, 200));
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        continue;
      }

      // Empty prompt, no activity -- paste may have been silently dropped
      if (hasPrompt && !pasteConfirmed && !rePasted) {
        const promptLine = lastLines.split("\n").find(l => /[❯›]/.test(l));
        const afterPrompt = promptLine ? (promptLine.match(/[❯›]/) ? promptLine.slice(promptLine.match(/[❯›]/)!.index! + 1).trim() : "") : "";
        if (!afterPrompt) {
          log(`Paste likely dropped (empty prompt, no activity), re-pasting once to ${target}`);
          await doPaste();
          await new Promise(resolve => setTimeout(resolve, enterDelay));
          await tmuxExec(["send-keys", "-t", target, "Enter"]);
          rePasted = true;
          continue;
        }
      }

      break;
    } catch { break; }
  }

  log(`Injected via tmux to ${target}${pasteConfirmed ? "" : " (unconfirmed)"}${rePasted ? " (re-pasted)" : ""}`)
}

function buildAppleScript(
  app: "iTerm2" | "Terminal",
  normalizedTty: string,
  content: string,
  poll: ReturnType<typeof parsePollMessage>,
): { script: string; args: string } {
  const isIterm = app === "iTerm2";

  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));

    let stepActions: string;
    if (isIterm) {
      stepActions = steps.map((step, i) => {
        const lines: string[] = [];
        if (step.text) {
          lines.push(`            tell s to write text (ASCII character 27)`);
          lines.push("            delay 0.5");
          const escapedText = step.text.replace(/"/g, '\\"');
          lines.push(`            tell s to write text "${escapedText}" without newline`);
          lines.push("            delay 0.15");
          lines.push(`            tell s to write text ""`);
          lines.push("            delay 0.2");
          lines.push(`            tell s to write text ""`);
        } else {
          lines.push(`            tell s to write text "${step.key}" without newline`);
        }
        if (i < steps.length - 1) lines.push("            delay 0.5");
        return lines.join("\n");
      }).join("\n");
    } else {
      stepActions = steps.map((step, i) => {
        const lines: string[] = [];
        if (step.text) {
          lines.push(`          do script (ASCII character 27) in t`);
          lines.push("          delay 0.5");
          const escapedText = step.text.replace(/"/g, '\\"');
          lines.push(`          do script "${escapedText}" in t`);
        } else {
          lines.push(`          do script "${step.key}" in t`);
        }
        if (i < steps.length - 1) lines.push("          delay 0.5");
        return lines.join("\n");
      }).join("\n");
    }

    const textAction = poll.text
      ? isIterm
        ? `\n            delay 0.3\n            tell s to write text "${poll.text.replace(/"/g, '\\"')}" without newline\n            delay 0.15\n            tell s to write text ""\n            delay 0.2\n            tell s to write text ""`
        : `\n          delay 0.3\n          do script "${poll.text.replace(/"/g, '\\"')}" in t`
      : "";

    const script = isIterm
      ? `on run argv
  set targetTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
${stepActions}${textAction}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run`
      : `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
${stepActions}${textAction}
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
    return { script, args: `'${normalizedTty}'` };
  }

  const escapedContent = content.replace(/'/g, "'\\''");
  const script = isIterm
    ? `on run argv
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
            delay 0.2
            tell s to write text ""
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run`
    : `on run argv
  set msgText to item 1 of argv
  set targetTty to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          do script msgText in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
  return { script, args: `'${escapedContent}' '${normalizedTty}'` };
}

async function injectViaTerminal(tty: string, content: string, termProgram?: string): Promise<void> {
  const normalizedTty = normalizeTty(tty);
  const poll = parsePollMessage(content);

  const app: "iTerm2" | "Terminal" = termProgram === "Apple_Terminal" ? "Terminal" : "iTerm2";
  const { script, args } = buildAppleScript(app, normalizedTty, content, poll);

  const tmpFile = path.join(CONFIG_DIR, "terminal-inject.scpt");
  fs.writeFileSync(tmpFile, script);
  try {
    const { stdout } = await execAsync(`osascript "${tmpFile}" ${args}`);
    if (stdout.trim() === "not_found") {
      throw new Error(`${app} session not found for TTY ${normalizedTty}`);
    }
    log(`Injected ${poll ? "poll response" : "message"} via ${app} for TTY ${normalizedTty}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}


type SessionFileInfo = { path: string; agentType: "claude" | "codex" | "cursor" | "gemini" };

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
      // Check subagent directories: <parent-session-id>/subagents/<sessionId>.jsonl
      const dirPath = path.join(claudeProjectsDir, dir);
      try {
        const subEntries = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const subDir of subEntries) {
          const subPath = path.join(dirPath, subDir.name, `${sessionId}.jsonl`);
          if (fs.existsSync(subPath)) return { path: subPath, agentType: "claude" };
        }
      } catch {}
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

async function killSessionBySessionId(sessionId: string, reason: string): Promise<void> {
  const cache = readConversationCache();
  const conversationId = cache[sessionId];
  let killed = false;

  const cachedTmux = resumeSessionCache.get(sessionId);
  if (cachedTmux && validateTmuxTarget(cachedTmux)) {
    try { await tmuxExec(["kill-session", "-t", cachedTmux]); killed = true; } catch {}
    resumeSessionCache.delete(sessionId);
  }

  if (!killed) {
    try {
      const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
      if (proc) {
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          try { await tmuxExec(["kill-session", "-t", tmuxTarget.split(":")[0]]); killed = true; } catch {}
        }
        if (!killed) {
          try { process.kill(proc.pid, "SIGKILL"); killed = true; } catch {}
        }
      }
    } catch {}
  }

  if (conversationId) {
    const started = startedSessionTmux.get(conversationId);
    if (started && validateTmuxTarget(started.tmuxSession) && !killed) {
      try { await tmuxExec(["kill-session", "-t", started.tmuxSession]); } catch {}
    }
    startedSessionTmux.delete(conversationId);
  }

  const hbInterval = resumeHeartbeatIntervals.get(sessionId);
  if (hbInterval) { clearInterval(hbInterval); resumeHeartbeatIntervals.delete(sessionId); }
  stopCodexPermissionPoller(sessionId);
  sessionProcessCache.delete(sessionId);
  resumeInFlight.delete(sessionId);
  resumeInFlightStarted.delete(sessionId);
  dismissedIdleSince.delete(sessionId);

  if (conversationId && syncServiceRef) {
    syncServiceRef.markSessionCompleted(conversationId).catch(() => {});
    sendAgentStatus(syncServiceRef, conversationId, sessionId, "stopped");
  }

  log(`[AUTO-KILL] Session ${sessionId.slice(0, 8)} killed: ${reason}`);
}

async function processHeartbeatResponse(sessionId: string, result?: { found: boolean; dismissed?: boolean }): Promise<void> {
  if (!result?.found) return;

  const status = lastSentAgentStatus.get(sessionId);
  const isIdle = status === "idle" || status === "permission_blocked";

  if (result.dismissed && isIdle) {
    if (!dismissedIdleSince.has(sessionId)) {
      dismissedIdleSince.set(sessionId, Date.now());
      log(`[DISMISSED-IDLE] Session ${sessionId.slice(0, 8)} is dismissed+idle, starting 1h timer`);
    }
    const idleSince = dismissedIdleSince.get(sessionId)!;
    if (Date.now() - idleSince >= DISMISSED_IDLE_KILL_MS) {
      const tmux = resumeSessionCache.get(sessionId);
      const alive = tmux ? await isTmuxAgentAlive(tmux) : false;
      if (alive) {
        log(`[DISMISSED-IDLE] Session ${sessionId.slice(0, 8)} timer expired but agent still alive, resetting`);
        dismissedIdleSince.delete(sessionId);
      } else {
        killSessionBySessionId(sessionId, "dismissed and idle for 1+ hour").catch(() => {});
      }
    }
  } else {
    if (dismissedIdleSince.has(sessionId)) {
      log(`[DISMISSED-IDLE] Session ${sessionId.slice(0, 8)} no longer dismissed+idle, timer cleared`);
    }
    dismissedIdleSince.delete(sessionId);
  }
}

// Codex tmux pane monitoring for permission prompts
const codexPermissionPollers = new Map<string, NodeJS.Timeout>();
const codexPermissionPending = new Set<string>(); // sessionIds currently waiting for permission decision
const codexPermissionRunning = new Set<string>(); // sessionIds with an in-flight tmux capture

let codexAppServerInstance: CodexAppServer | null = null;
const appServerThreads = new Map<string, { threadId: string; conversationId: string }>();
const appServerConversations = new Map<string, string>();

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
    if (codexPermissionPending.has(sessionId)) return;
    if (codexPermissionRunning.has(sessionId)) return;
    if (isInWakeGrace()) return;

    codexPermissionRunning.add(sessionId);
    try {
      const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-30"], { timeout: 3000, killSignal: "SIGKILL" });
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
            const key = decision.approved ? "Enter" : "Escape";
            log(`Injecting Codex permission '${key}' for session ${sessionId.slice(0, 8)}`);
            try {
              await tmuxExec(["send-keys", "-t", tmuxSession, key]);
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
    } finally {
      codexPermissionRunning.delete(sessionId);
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
  agentType: "claude" | "codex" | "cursor" | "gemini";
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
};

const STARTED_SESSION_TTL_MS = 5 * 60 * 1000;

class PersistedStartedSessions extends Map<string, StartedSessionInfo> {
  constructor() {
    super();
    this.load();
  }

  set(key: string, value: StartedSessionInfo): this {
    super.set(key, value);
    this.save();
    return this;
  }

  delete(key: string): boolean {
    const result = super.delete(key);
    if (result) this.save();
    return result;
  }

  private save(): void {
    try {
      const data: Record<string, StartedSessionInfo> = {};
      const now = Date.now();
      for (const [k, v] of this) {
        if (now - v.startedAt < STARTED_SESSION_TTL_MS) data[k] = v;
      }
      fs.writeFileSync(STARTED_SESSIONS_FILE, JSON.stringify(data), "utf-8");
    } catch {}
  }

  private load(): void {
    try {
      if (!fs.existsSync(STARTED_SESSIONS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(STARTED_SESSIONS_FILE, "utf-8"));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw) as [string, StartedSessionInfo][]) {
        if (now - v.startedAt < STARTED_SESSION_TTL_MS) {
          super.set(k, v);
        }
      }
      if (this.size > 0) {
        log(`Loaded ${this.size} started session(s) from disk`);
      }
    } catch {}
  }
}

const startedSessionTmux = new PersistedStartedSessions();
const restartingSessionIds = new Map<string, number>();
const RESTART_GUARD_TTL_MS = 60_000;

// Prevent concurrent resume attempts on the same session
const resumeInFlight = new Map<string, Promise<boolean>>();
const resumeInFlightStarted = new Map<string, number>();
const RESUME_IN_FLIGHT_TIMEOUT_MS = 120_000;

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
    const candidates: string[] = [];
    for (const f of fs.readdirSync(projectDir)) {
      const m = f.match(UUID_JSONL_RE);
      if (!m || existingFiles.has(f)) continue;
      const sessionId = m[1];
      const cache = readConversationCache();
      if (cache[sessionId]) continue;
      candidates.push(sessionId);
    }
    if (candidates.length === 0) continue;
    // Verify which candidate belongs to this tmux session's process
    let linkedSessionId: string | null = null;
    for (const sessionId of candidates) {
      try {
        const proc = await findSessionProcess(sessionId, "claude").catch(() => null);
        if (proc) {
          const tmuxPane = await findTmuxPaneForTty(proc.tty);
          if (tmuxPane && tmuxPane.split(":")[0] === tmuxSession) {
            linkedSessionId = sessionId;
            break;
          }
        }
      } catch {}
    }
    // If process verification fails but there's exactly one candidate, use it
    if (!linkedSessionId && candidates.length === 1) {
      linkedSessionId = candidates[0];
    }
    if (linkedSessionId) {
      const cache = readConversationCache();
      const reverseCache = buildReverseConversationCache(cache);
      if (reverseCache[conversationId]) {
        log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked to ${reverseCache[conversationId].slice(0, 8)} by another writer`);
        startedSessionTmux.delete(conversationId);
        return;
      }
      cache[linkedSessionId] = conversationId;
      saveConversationCache(cache);
      if (syncServiceRef) {
        syncServiceRef.updateSessionId(conversationId, linkedSessionId).catch(() => {});
        syncServiceRef.registerManagedSession(linkedSessionId, process.pid, tmuxSession, conversationId).catch(() => {});
      }
      startedSessionTmux.delete(conversationId);
      log(`[DISCOVER] Linked session ${linkedSessionId.slice(0, 8)} to conversation ${conversationId.slice(0, 12)} via JSONL discovery`);
      return;
    }
  }
  log(`[DISCOVER] Timed out discovering session for conversation ${conversationId.slice(0, 12)}`);
}

const planHandoffChildren = new Map<string, string>();
const planHandoffChecked = new Set<string>();
const planModeSynced = new Set<string>();
const planModePlanMap = new Map<string, string>(); // sessionId -> plan short_id
const planModeTaskMap = new Map<string, Map<string, string>>(); // sessionId -> (localTaskId -> shortId)

const PLAN_MODE_CACHE_FILE = path.join(CONFIG_DIR, "plan-mode-cache.json");

function loadPlanModeCache(): void {
  try {
    if (!fs.existsSync(PLAN_MODE_CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PLAN_MODE_CACHE_FILE, "utf-8"));
    if (data.synced) for (const s of data.synced) planModeSynced.add(s);
    if (data.plans) for (const [k, v] of Object.entries(data.plans)) planModePlanMap.set(k, v as string);
    if (data.tasks) {
      for (const [sessionId, taskObj] of Object.entries(data.tasks)) {
        const map = new Map<string, string>();
        for (const [localId, shortId] of Object.entries(taskObj as Record<string, string>)) {
          map.set(localId, shortId);
        }
        planModeTaskMap.set(sessionId, map);
      }
    }
  } catch {}
}

function savePlanModeCache(): void {
  try {
    const tasks: Record<string, Record<string, string>> = {};
    for (const [sessionId, map] of planModeTaskMap) {
      tasks[sessionId] = Object.fromEntries(map);
    }
    fs.writeFileSync(PLAN_MODE_CACHE_FILE, JSON.stringify({
      synced: [...planModeSynced],
      plans: Object.fromEntries(planModePlanMap),
      tasks,
    }), { mode: 0o600 });
  } catch {}
}

loadPlanModeCache();

// Track subagent sessions whose parent hasn't been cached yet: childSessionId -> parentSessionId
const pendingSubagentParents = new Map<string, string>();
// Track subagent descriptions read from .meta.json: sessionId -> description
const subagentDescriptions = new Map<string, string>();

interface CachedProcessInfo {
  pid: number;
  tty: string;
  tmuxTarget?: string;
  termProgram?: string;
  lastVerified: number;
}

const sessionProcessCache = new Map<string, CachedProcessInfo>();
const PROCESS_CACHE_TTL_MS = 30_000;

function cacheSessionProcess(sessionId: string, info: ClaudeSessionInfo, tmuxTarget?: string): void {
  sessionProcessCache.set(sessionId, {
    pid: info.pid,
    tty: info.tty,
    tmuxTarget,
    termProgram: info.termProgram,
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
  return { pid: cached.pid, tty: cached.tty, sessionId, termProgram: cached.termProgram };
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
  const parts = filePath.split(path.sep);
  if (parts.includes("subagents")) return name;
  try {
    const head = readFileHead(filePath, 4096);
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
  // Deduplicate concurrent resume attempts on the same session
  const existing = resumeInFlight.get(sessionId);
  if (existing) {
    const startedAt = resumeInFlightStarted.get(sessionId) ?? 0;
    const age = Date.now() - startedAt;
    if (age > RESUME_IN_FLIGHT_TIMEOUT_MS) {
      logDelivery(`Resume in-flight for ${sessionId.slice(0, 8)} is stale (${Math.round(age / 1000)}s), clearing and retrying`);
      resumeInFlight.delete(sessionId);
      resumeInFlightStarted.delete(sessionId);
    } else {
      logDelivery(`Resume already in flight for ${sessionId.slice(0, 8)}, waiting (age=${Math.round(age / 1000)}s)...`);
      try {
        const result = await Promise.race([
          existing,
          new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("resume_timeout")), RESUME_IN_FLIGHT_TIMEOUT_MS - age)),
        ]);
        if (result && content) {
          const tmuxSession = resumeSessionCache.get(sessionId);
          if (tmuxSession) {
            await injectViaTmux(tmuxSession + ":0.0", content);
            log(`Injected message to already-resumed session ${sessionId.slice(0, 8)}`);
          }
        }
        return result;
      } catch (err) {
        if (err instanceof Error && err.message === "resume_timeout") {
          logDelivery(`Resume in-flight timed out for ${sessionId.slice(0, 8)}, clearing and retrying`);
          resumeInFlight.delete(sessionId);
          resumeInFlightStarted.delete(sessionId);
        } else {
          throw err;
        }
      }
    }
  }
  const promise = autoResumeSessionInner(sessionId, content, titleCache, nonInteractive, cwdOverride, conversationId);
  resumeInFlight.set(sessionId, promise);
  resumeInFlightStarted.set(sessionId, Date.now());
  try {
    return await promise;
  } finally {
    resumeInFlight.delete(sessionId);
    resumeInFlightStarted.delete(sessionId);
  }
}

async function autoResumeSessionInner(sessionId: string, content: string, titleCache: TitleCache, nonInteractive = false, cwdOverride?: string, conversationId?: string): Promise<boolean> {
  if (!hasTmux()) {
    logDelivery(`Cannot auto-resume ${sessionId.slice(0, 8)}: tmux not installed`);
    return false;
  }
  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) {
    logDelivery(`Cannot auto-resume ${sessionId.slice(0, 8)}: session JSONL file not found`);
    return false;
  }

  const { path: jsonlPath, agentType } = sessionFile;
  const jsonlContent = readFileHead(jsonlPath, 5000);
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
    let resumeId = sessionId;
    if (!UUID_RE.test(sessionId)) {
      const newUuid = crypto.randomUUID();
      const newPath = path.join(path.dirname(jsonlPath), `${newUuid}.jsonl`);
      try {
        const rawContent = fs.readFileSync(jsonlPath, "utf-8");
        const rewritten = rawContent.replace(
          new RegExp(`"sessionId"\\s*:\\s*"${sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, "g"),
          `"sessionId":"${newUuid}"`
        );
        fs.writeFileSync(newPath, rewritten);
        log(`Copied non-UUID session ${sessionId} to resumable UUID ${newUuid}`);
        resumeId = newUuid;
        if (conversationId) {
          const cache = readConversationCache();
          cache[newUuid] = conversationId;
          saveConversationCache(cache);
        }
        if (syncServiceRef && conversationId) {
          syncServiceRef.updateSessionId(conversationId, newUuid).catch(() => {});
        }
      } catch (err) {
        log(`Failed to copy session for UUID resume: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resumeCmd = `claude --resume ${resumeId}${extraFlags ? " " + extraFlags : ""}`;
  }

  const prefix = agentType === "codex" ? "cx" : agentType === "gemini" ? "gm" : "cc";
  const tmuxSession = slug ? `${prefix}-resume-${slug}-${shortId}` : `${prefix}-resume-${shortId}`;

  try {
    try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}

    await tmuxExec(["new-session", "-d", "-s", tmuxSession, "-c", cwd]);

    // For non-interactive mode (materialized sessions), use -p flag to process message and exit
    if (nonInteractive && agentType === "claude") {
      const tmpFile = path.join(os.tmpdir(), `codecast-msg-${shortId}.txt`);
      fs.writeFileSync(tmpFile, content);
      const nonInteractiveCmd = `env -u CLAUDECODE ${resumeCmd} -p "$(cat '${tmpFile}')" --output-format stream-json --verbose && rm -f '${tmpFile}'`;
      await tmuxExec(["send-keys", "-t", tmuxSession, "-l", nonInteractiveCmd]);
      await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);
      await new Promise(resolve => setTimeout(resolve, 200));
      await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);
      logDelivery(`Auto-resumed ${agentType} ${shortId} in tmux=${tmuxSession} (non-interactive) cwd=${cwd}`);

      // Poll briefly for fatal errors before declaring success
      const fatalErrors = [
        "No conversation found",
        "Session not found",
        "command not found",
        "cannot be launched inside another",
        "is not an object",
        "ENOENT",
      ];
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-20"]);
          if (fatalErrors.some(e => paneContent.includes(e))) {
            logDelivery(`Auto-resume FATAL (non-interactive) for ${shortId}: ${paneContent.slice(0, 300)}`);
            try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
            try { fs.unlinkSync(tmpFile); } catch {}
            return false;
          }
          // If we see JSON output streaming, agent is working
          if (paneContent.includes('"type":"result"') || paneContent.includes('"type":"assistant"')) {
            logDelivery(`Agent ${shortId} (non-interactive) producing output after ${(i + 1) * 500}ms`);
            break;
          }
        } catch {}
      }

      resumeSessionCache.set(sessionId, tmuxSession);
      if (syncServiceRef && conversationId) {
        syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {});
        syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {});
      }
      return true;
    }

    // Prefix with env -u CLAUDECODE to prevent "cannot launch inside another Claude Code session" error
    await tmuxExec(["send-keys", "-t", tmuxSession, "-l", `env -u CLAUDECODE ${resumeCmd}`]);
    await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);
    await new Promise(resolve => setTimeout(resolve, 200));
    await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);

    logDelivery(`Auto-resumed ${agentType} ${shortId} in tmux=${tmuxSession} cwd=${cwd} cmd=${resumeCmd}`);

    // Register managed session early so the web UI can show "Connected" status
    resumeSessionCache.set(sessionId, tmuxSession);
    if (syncServiceRef && conversationId) {
      syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {});
      syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {});
      const existing = resumeHeartbeatIntervals.get(sessionId);
      if (existing) clearInterval(existing);
      const interval = setInterval(async () => {
        try {
          const result = await syncServiceRef!.heartbeatManagedSession(sessionId);
          await processHeartbeatResponse(sessionId, result);
        } catch {}
      }, 30000);
      resumeHeartbeatIntervals.set(sessionId, interval);

      // Start tmux pane monitoring for Codex permission prompts
      if (agentType === "codex" && conversationId) {
        startCodexPermissionPoller(sessionId, tmuxSession, conversationId, syncServiceRef);
      }
    }

    // Poll for agent readiness - check every 250ms, bail on fatal errors
    // Must see the input prompt (❯ for Claude, › for Codex) to know the TUI is ready
    const fatalErrors = [
      "cannot be launched inside another",
      "command not found",
      "No such file or directory",
      "Session not found",
      "No conversation found",
      "is not an object",
      "ENOENT",
    ];
    const promptPattern = /[❯›]/;
    const startTime = Date.now();
    let ready = false;

    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-20"]);
        if (fatalErrors.some(e => paneContent.includes(e))) {
          logDelivery(`Auto-resume FATAL for ${shortId}: agent crashed. Pane: ${paneContent.slice(0, 300)}`);
          try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
          return false;
        }
        if (promptPattern.test(paneContent) && await isTmuxAgentAlive(tmuxSession)) {
          logDelivery(`Agent ${shortId} ready (prompt visible) after ${Date.now() - startTime}ms`);
          ready = true;
          break;
        }
      } catch {}
    }
    if (!ready) {
      logDelivery(`Agent ${shortId} startup timed out after ${Date.now() - startTime}ms, proceeding anyway`);
    }

    // Dismiss startup warnings (model mismatch, rate limit) before injection
    // These warnings block the prompt -- send Escape then Enter to clear them
    if (ready || !content) {
      try {
        const { stdout: preInjectPane } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-15"]);
        const warningPatterns = /⚠|recorded with model|weekly limit|Update available|Press enter to continue/;
        if (warningPatterns.test(preInjectPane)) {
          logDelivery(`Clearing startup warnings for ${shortId} before injection`);
          await tmuxExec(["send-keys", "-t", tmuxSession, "Escape"]);
          await new Promise(resolve => setTimeout(resolve, 300));
          // Wait for the prompt to appear after clearing warnings
          for (let w = 0; w < 20; w++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            try {
              const { stdout: cleared } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-5"]);
              if (promptPattern.test(cleared.split("\n").slice(-3).join("\n"))) break;
            } catch {}
          }
        }
      } catch {}
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
    logDelivery(`Auto-resume EXCEPTION ${agentType} ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
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
      ({ jsonl } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId }));
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
        const { filePath: repairFilePath } = writeClaudeCodeSession(jsonl, sessionId, projectPath);
        setPosition(repairFilePath, fs.statSync(repairFilePath).size);
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

  // Skip health check if a resume is already in flight (remote or auto)
  if (resumeInFlight.has(sessionId)) {
    log(`Health check: skipping for ${sessionId.slice(0, 8)}, resume in flight`);
    return;
  }
  const restartTs = restartingSessionIds.get(sessionId);
  if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) {
    log(`Health check: skipping for ${sessionId.slice(0, 8)}, restart in progress`);
    return;
  }

  const tmuxSession = resumeSessionCache.get(sessionId);
  if (!tmuxSession) return;

  try {
    await tmuxExec(["has-session", "-t", tmuxSession]);
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
    try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
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

async function startFreshSessionForDelivery(
  conversationId: string,
): Promise<StartedSessionInfo | null> {
  const existing = startedSessionTmux.get(conversationId);
  if (existing) return existing;

  if (!hasTmux()) {
    logDelivery(`Cannot start fresh session: tmux not available`);
    return null;
  }

  const config = readConfig();
  let projectPath = process.env.HOME || "/tmp";

  if (config?.convex_url && config?.auth_token) {
    try {
      const siteUrl = config.convex_url.replace(".cloud", ".site");
      const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
      if (exportData.conversation?.project_path && fs.existsSync(exportData.conversation.project_path)) {
        projectPath = exportData.conversation.project_path;
      }
    } catch {}
  }

  const shortId = Math.random().toString(36).slice(2, 8);
  const tmuxSession = `cc-claude-${shortId}`;
  let extraFlags = config?.claude_args || "";
  const blankArgs = extraFlags ? extraFlags.split(/\s+/).filter(Boolean) : [];
  const safeBlankArgs = sanitizeBinaryArgs(blankArgs);
  const blankCmdText = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${["claude", ...safeBlankArgs].join(" ")}`;

  try {
    tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", projectPath], { timeout: 5000 });
    tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", blankCmdText], { timeout: 5000 });
    tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
    spawnSync("sleep", ["0.2"]);
    tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
    const entry: StartedSessionInfo = {
      tmuxSession,
      projectPath,
      startedAt: Date.now(),
      agentType: "claude",
    };
    startedSessionTmux.set(conversationId, entry);
    discoverAndLinkSession(conversationId, tmuxSession, projectPath).catch(err => {
      log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
    });
    logDelivery(`Started fresh session ${tmuxSession} for conv=${conversationId.slice(0, 12)} in ${projectPath}`);
    return entry;
  } catch (err) {
    logDelivery(`Failed to start fresh session for conv=${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

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
    logDelivery(`Cannot materialize: missing convex_url or auth_token`);
    return null;
  }

  const siteUrl = config.convex_url.replace(".cloud", ".site");

  const promise = (async (): Promise<string | null> => {
    try {
      logDelivery(`Materializing session for conv=${conversationId.slice(0, 12)}...`);
      const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
      if (exportData.messages.length === 0) {
        logDelivery(`Materialization skipped for ${conversationId.slice(0, 12)}: 0 messages (session_id=${exportData.conversation?.session_id?.slice(0, 8) || "none"})`);
        return null;
      }

      const TOKEN_BUDGET = 100_000;
      const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
      const { jsonl, sessionId } = generateClaudeCodeJsonl(exportData, { tailMessages });
      const projectPath = exportData.conversation.project_path || undefined;
      const { filePath: matFilePath } = writeClaudeCodeSession(jsonl, sessionId, projectPath);
      setPosition(matFilePath, fs.statSync(matFilePath).size);

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

      logDelivery(`Materialized session=${sessionId.slice(0, 8)} conv=${conversationId.slice(0, 12)} (${exportData.messages.length} msgs, tail=${tailMessages})`);
      return sessionId;
    } catch (err) {
      logDelivery(`Materialization FAILED for ${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
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
  logDelivery(`deliverMessage called: conv=${conversationId.slice(0, 12)} msgId=${messageId.slice(0, 12)} content="${content.slice(0, 80)}"`);

  const childConvId = planHandoffChildren.get(conversationId);
  if (childConvId) {
    logDelivery(`Redirecting message from plan parent ${conversationId.slice(0, 12)} to child ${childConvId.slice(0, 12)}`);
    return deliverMessage(childConvId, content, conversationCache, syncService, messageId, titleCache);
  }

  if (codexAppServerInstance?.running) {
    const appServerThreadId = appServerConversations.get(conversationId);
    if (appServerThreadId) {
      try {
        const input: Array<{ type: "text"; text: string }> = [{ type: "text", text: content }];
        await codexAppServerInstance.turnStart({ threadId: appServerThreadId, input });
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        logDelivery(`[codex-app-server] delivered via app-server to thread ${appServerThreadId.slice(0, 8)}`);
        return true;
      } catch (err) {
        logDelivery(`[codex-app-server] delivery failed, falling back to tmux: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const reverseCache = buildReverseConversationCache(conversationCache);
  let sessionId = reverseCache[conversationId];

  const pendingPrompt = pendingInteractivePrompts.get(sessionId || conversationId);
  pendingInteractivePrompts.delete(sessionId || conversationId);

  // If there's an active poll and the message is plain text (not already a poll response),
  // check if it matches one of the poll options and convert to a poll response
  if (pendingPrompt && !parsePollMessage(content)) {
    const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized && pendingPrompt.options.length > 0) {
      if (pendingPrompt.isConfirmation) {
        const isConfirm = /^(continue|enter|yes|ok|confirm|proceed|accept|y)$/i.test(normalized) ||
          (pendingPrompt.options[0] && normalized.includes(pendingPrompt.options[0].label.toLowerCase().split(" (")[0]));
        const isCancel = /^(cancel|escape|esc|no|quit|n)$/i.test(normalized) ||
          (pendingPrompt.options[1] && normalized.includes(pendingPrompt.options[1].label.toLowerCase().split(" (")[0]));
        if (isConfirm) {
          content = JSON.stringify({ __cc_poll: true, keys: ["Enter"], display: "Continue" });
          logDelivery(`Converted plain text to confirmation Enter for session=${(sessionId || conversationId).slice(0, 8)}`);
        } else if (isCancel) {
          content = JSON.stringify({ __cc_poll: true, keys: ["Escape"], display: "Cancel" });
          logDelivery(`Converted plain text to confirmation Escape for session=${(sessionId || conversationId).slice(0, 8)}`);
        }
      } else {
        const matchIdx = pendingPrompt.options.findIndex(opt => {
          const optNorm = opt.label.replace(/\s+/g, " ").trim().toLowerCase();
          return optNorm === normalized || normalized.includes(optNorm) || optNorm.includes(normalized);
        });
        if (matchIdx >= 0) {
          const key = String(matchIdx + 1);
          const display = pendingPrompt.options[matchIdx].label;
          content = JSON.stringify({ __cc_poll: true, keys: [key], display });
          logDelivery(`Converted plain text "${display}" to poll key=${key} for session=${(sessionId || conversationId).slice(0, 8)}`);
        }
      }
    }
  }

  if (!sessionId) {
    const cacheKeys = Object.keys(conversationCache);
    const reverseKeys = Object.keys(reverseCache);
    logDelivery(`No session in cache for conv=${conversationId.slice(0, 12)}, cache has ${cacheKeys.length} sessions/${reverseKeys.length} convs, startedTmux has ${startedSessionTmux.size} entries`);
    syncService.updateSessionAgentStatus(conversationId, "starting").catch(() => {});
    // Try delivering via a recently started tmux session (from start_session command)
    const tryStartedTmux = async (entry: StartedSessionInfo): Promise<boolean> => {
      try {
        await tmuxExec(["has-session", "-t", entry.tmuxSession]);
        // Agent-specific prompt patterns:
        // Claude: ❯ or ⏵   Codex: >   Gemini: various
        const promptPattern = entry.agentType === "codex" ? />\s*$/ : entry.agentType === "gemini" ? />\s*$|gemini/i : /❯|⏵/;
        const fatalErrors = [
          "cannot be launched inside another",
          "command not found",
          "No such file or directory",
          "ENOENT",
        ];
        let ready = false;
        const startTime = Date.now();
        const trustPromptPatterns = /trust this folder|safety check|Is this a project/i;
        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          try {
            const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", entry.tmuxSession, "-S", "-20"]);
            if (fatalErrors.some(e => paneContent.includes(e))) {
              log(`Started session ${entry.tmuxSession} hit fatal error, falling through. Pane: ${paneContent.slice(0, 200)}`);
              startedSessionTmux.delete(conversationId);
              return false;
            }
            // Dismiss workspace trust prompt if detected (shows ❯ but isn't the input prompt)
            if (trustPromptPatterns.test(paneContent)) {
              log(`Started session ${entry.tmuxSession} showing trust prompt, sending Enter to accept`);
              await tmuxExec(["send-keys", "-t", entry.tmuxSession, "Enter"]);
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
            if (promptPattern.test(paneContent)) {
              // Verify it's the actual input prompt, not the trust prompt's ❯
              const lastLines = paneContent.split("\n").slice(-10).join("\n");
              if (trustPromptPatterns.test(lastLines)) continue;
              log(`Started session ${entry.tmuxSession} ready (prompt visible) after ${Date.now() - startTime}ms`);
              ready = true;
              break;
            }
          } catch {}
        }
        if (!ready) {
          log(`Started session ${entry.tmuxSession} startup timed out after ${Date.now() - startTime}ms, proceeding anyway`);
        }
        // Extra settle time: Claude Code's input handler may not be ready immediately
        // after the prompt is visible. Wait to avoid silent paste drops.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const startedTmuxTarget = entry.tmuxSession + ":0.0";
        await injectViaTmux(startedTmuxTarget, content);
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        log(`Delivered message to started session tmux ${entry.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
        const isPollResponse = !!parsePollMessage(content);
        if (content.trimStart().startsWith("/") || isPollResponse) {
          checkForInteractivePrompt(startedTmuxTarget, conversationId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
        }
        return true;
      } catch (err) {
        log(`Started session tmux ${entry.tmuxSession} not reachable, falling through: ${err instanceof Error ? err.message : String(err)}`);
        // Only clear if session is old (>60s). Fresh sessions may just need more startup time.
        if (Date.now() - entry.startedAt > 60_000) {
          startedSessionTmux.delete(conversationId);
        }
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
      logDelivery(`Waiting up to 12s for start_session to populate startedSessionTmux for conv=${conversationId.slice(0, 12)}`);
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500));
        const justStarted = startedSessionTmux.get(conversationId);
        if (justStarted) {
          log(`Found startedSessionTmux for ${conversationId.slice(0, 12)} after ${(i + 1) * 500}ms wait`);
          if (await tryStartedTmux(justStarted)) return true;
          break;
        }
        // Also check disk cache - session may have linked via watcher
        const recheckCache = readConversationCache();
        const recheckReverse = buildReverseConversationCache(recheckCache);
        if (recheckReverse[conversationId]) {
          sessionId = recheckReverse[conversationId];
          conversationCache[sessionId!] = conversationId;
          log(`Found session ${sessionId!.slice(0, 8)} for ${conversationId.slice(0, 12)} via disk cache on wait iteration ${i + 1}`);
          break;
        }
      }
      if (!sessionId) {
        log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
        sessionId = (await materializeSession(conversationId, conversationCache, titleCache, syncService))!;
        if (!sessionId) {
          logDelivery(`Materialization failed for conv=${conversationId.slice(0, 12)}, starting fresh session`);
          const freshEntry = await startFreshSessionForDelivery(conversationId);
          if (freshEntry && await tryStartedTmux(freshEntry)) return true;
          log(`Cannot deliver: no local session, materialization failed, and fresh start failed for ${conversationId}`);
          return false;
        }
      }
    } else {
      log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
      sessionId = (await materializeSession(conversationId, conversationCache, titleCache, syncService))!;
      if (!sessionId) {
        logDelivery(`Materialization failed for conv=${conversationId.slice(0, 12)}, starting fresh session`);
        const freshEntry = await startFreshSessionForDelivery(conversationId);
        if (freshEntry && await tryStartedTmux(freshEntry)) return true;
        logDelivery(`Cannot deliver: no local session, materialization failed, and fresh start failed for conv=${conversationId.slice(0, 12)}`);
        return false;
      }
    }
  }

  // Determine session type for process discovery and auto-resume
  const isCursorSession = sessionId.startsWith("cursor-");
  const isGeminiSession = sessionId.startsWith("session-");

  // Cursor is an IDE, not a terminal process - can't inject
  if (isCursorSession) {
    logDelivery(`Session ${sessionId.slice(0, 20)} is Cursor IDE, cannot inject - skipping`);
    return false;
  }

  // Detect codex sessions by checking if the JSONL exists in codex paths
  let detectedType: "claude" | "codex" | "cursor" | "gemini" = isGeminiSession ? "gemini" : "claude";
  if (!isGeminiSession) {
    const sessionFile = findSessionFile(sessionId);
    if (sessionFile) detectedType = sessionFile.agentType;
  }

  logDelivery(`Delivering to session=${sessionId.slice(0, 12)} conv=${conversationId.slice(0, 12)} type=${detectedType}`);


  // Check if we have a cached tmux target from a previous auto-resume
  const cachedTmux = resumeSessionCache.get(sessionId);
  if (cachedTmux) {
    logDelivery(`Found cached tmux=${cachedTmux} for session=${sessionId.slice(0, 12)}`);
    try {
      await tmuxExec(["has-session", "-t", cachedTmux]);
      if (!(await isTmuxAgentAlive(cachedTmux))) {
        logDelivery(`Cached tmux ${cachedTmux} has no live agent, clearing cache`);
        resumeSessionCache.delete(sessionId);
        stopCodexPermissionPoller(sessionId);
        const hbInterval = resumeHeartbeatIntervals.get(sessionId);
        if (hbInterval) { clearInterval(hbInterval); resumeHeartbeatIntervals.delete(sessionId); }
        try { await tmuxExec(["kill-session", "-t", cachedTmux]); } catch {}
      } else {
        await injectViaTmux(cachedTmux, content);
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        syncService.setSessionError(conversationId).catch(() => {});
        const isPollResponse = !!parsePollMessage(content);
        if (content.trimStart().startsWith("/") || isPollResponse) {
          checkForInteractivePrompt(cachedTmux, sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
        }
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
  logDelivery(`Finding process: materialized=${isMaterialized} session=${sessionId.slice(0, 12)}`);
  const proc = isMaterialized ? null : await findSessionProcess(sessionId, detectedType);

  if (proc) {
    logDelivery(`Found process pid=${proc.pid} tty=${proc.tty} for session=${sessionId.slice(0, 12)}`);
    // Verify the process is still an agent (not a leftover shell)
    if (!isAgentProcess(proc.pid)) {
      logDelivery(`Process ${proc.pid} is no longer an agent process, clearing cache`);
      sessionProcessCache.delete(sessionId);
    } else {
      // Try tmux first (most reliable)
      const tmuxTarget = await findTmuxPaneForTty(proc.tty);
      logDelivery(`tmux pane for tty=${proc.tty}: ${tmuxTarget ?? "not found"}`);
      let agentDetectedDead = false;
      if (tmuxTarget) {
        try {
          await injectViaTmux(tmuxTarget, content);
          const tmuxSessionName = tmuxTarget.split(":")[0];
          const agentAlive = await isTmuxAgentAlive(tmuxSessionName);
          if (!agentAlive) {
            logDelivery(`Agent in ${tmuxTarget} is dead after injection, falling through to auto-resume`);
            sessionProcessCache.delete(sessionId);
            agentDetectedDead = true;
          } else {
            await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
            logDelivery(`Delivered via tmux ${tmuxTarget}`);
            const isPollResponse = !!parsePollMessage(content);
            if (content.trimStart().startsWith("/") || isPollResponse) {
              checkForInteractivePrompt(tmuxTarget, sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
            }
            return true;
          }
        } catch (err) {
          logDelivery(`tmux injection failed for ${tmuxTarget}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!agentDetectedDead) {
        // Try AppleScript injection (iTerm2 or Terminal.app)
        const termLabel = proc.termProgram === "Apple_Terminal" ? "Terminal.app" : "iTerm2";
        logDelivery(`Trying ${termLabel} injection for tty=${proc.tty}`);
        try {
          await injectViaTerminal(proc.tty, content, proc.termProgram);
          await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
          logDelivery(`Delivered via ${termLabel} tty=${proc.tty}`);
          return true;
        } catch (err) {
          logDelivery(`${termLabel} injection failed for ${proc.tty}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      logDelivery(`All injection methods failed for live process pid=${proc.pid}, falling back to auto-resume`);
    }
  } else {
    logDelivery(`No running process found for session=${sessionId.slice(0, 12)} type=${detectedType}`);
  }

  // Last resort: auto-resume in a new tmux session
  const tmuxAvailable = hasTmux();
  logDelivery(`Attempting auto-resume: session=${sessionId.slice(0, 8)} tmux=${tmuxAvailable}`);
  if (!tmuxAvailable) {
    logDelivery(`CANNOT auto-resume: tmux is not installed. Install with: brew install tmux`);
  }
  const resumed = await autoResumeSession(sessionId, content, titleCache, isMaterialized, undefined, conversationId);
  if (resumed) {
    materializedSessions.delete(sessionId);
    await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
    logDelivery(`Delivered via auto-resume for session=${sessionId.slice(0, 8)}`);
    const isPollResponse = !!parsePollMessage(content);
    if (content.trimStart().startsWith("/") || isPollResponse) {
      const resumeTmux = resumeSessionCache.get(sessionId);
      if (resumeTmux) {
        checkForInteractivePrompt(resumeTmux + ":0.0", sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
      }
    }
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService, titleCache, conversationCache).catch(err => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  // Auto-resume failed - try repair (regenerate JSONL from Convex)
  logDelivery(`Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
  const repaired = await repairAndResumeSession(sessionId, content, titleCache, isMaterialized, undefined, conversationId);
  if (repaired) {
    materializedSessions.delete(sessionId);
    await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
    logDelivery(`Delivered via repair+resume for session=${sessionId.slice(0, 8)}`);
    const isPollResponse = !!parsePollMessage(content);
    if (content.trimStart().startsWith("/") || isPollResponse) {
      const resumeTmux = resumeSessionCache.get(sessionId);
      if (resumeTmux) {
        checkForInteractivePrompt(resumeTmux + ":0.0", sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
      }
    }
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService, titleCache, conversationCache).catch(err => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  logDelivery(`DELIVERY FAILED: all methods exhausted for session=${sessionId.slice(0, 8)} conv=${conversationId.slice(0, 12)}`);
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
          const content = readFileHead(filePath, 5000);
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

async function backfillPlanModeFromJSONL(syncService: SyncService): Promise<void> {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return;

  let synced = 0;
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of projectDirs) {
    const dirPath = path.join(claudeProjectsDir, dir);
    let sessionFiles: string[];
    try {
      sessionFiles = fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl") && !f.includes("sessions-index"));
    } catch { continue; }

    const decodedPath = decodeProjectDirName(dir);

    for (const file of sessionFiles) {
      const filePath = path.join(dirPath, file);
      const sessionId = file.replace(".jsonl", "");
      if (planModeSynced.has(sessionId)) continue;

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (!content.includes("ExitPlanMode")) continue;

        let planContent: string | undefined;
        for (const line of content.split("\n")) {
          if (!line.includes("ExitPlanMode")) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry.message || entry;
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            for (const block of blocks) {
              if (block.type === "tool_use" && block.name === "ExitPlanMode" && block.input?.plan) {
                planContent = block.input.plan;
                break;
              }
            }
          } catch { continue; }
          if (planContent) break;
        }

        if (!planContent) continue;

        const projPath = decodedPath && fs.existsSync(decodedPath) ? decodedPath : undefined;
        const planShortId = await syncService.syncPlanFromPlanMode({
          sessionId,
          planContent,
          projectPath: projPath,
        });

        planModeSynced.add(sessionId);
        if (planShortId) planModePlanMap.set(sessionId, planShortId);
        savePlanModeCache();
        synced++;
        log(`Backfilled plan_mode plan ${planShortId || "doc-only"} for session ${sessionId.slice(0, 8)}`);
      } catch (err) {
        // Skip individual failures silently
      }
    }
  }

  if (synced > 0) log(`Backfilled ${synced} plan_mode plan(s) from JSONL history`);
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
    log("Waiting for configuration... (run 'cast auth' to set up)");
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
  if (!hasTmux()) return false;
  try {
    const { stdout } = await tmuxExec(
      ["list-panes", "-t", tmuxSession, "-F", "#{pane_pid}"], { timeout: 3000, killSignal: "SIGKILL" }
    );
    const panePid = stdout.trim();
    if (!panePid) return false;
    try {
      await execAsync(`pgrep -P ${panePid}`, { timeout: 3000, killSignal: "SIGKILL" });
      return true;
    } catch {
      try {
        const { stdout: paneContent } = await tmuxExec(
          ["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-5"], { timeout: 3000, killSignal: "SIGKILL" }
        );
        const trimmed = paneContent.trim();
        if (!trimmed) return false;
        // Only declare dead on POSITIVE evidence of death
        if (/[$%#]\s*$/.test(trimmed)) return false;
        if (/Segmentation fault|panic:|SIGABRT|core dumped|exited with/.test(trimmed)) return false;
        // Pane has content but no death indicators — assume alive (conservative)
        return true;
      } catch {}
      // tmux capture failed — don't assume dead
      return true;
    }
  } catch {
    // tmux session doesn't exist at all
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

function isManagedByLaunchd(): boolean {
  return !!process.env.XPC_SERVICE_NAME;
}

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
  const underLaunchd = isManagedByLaunchd();
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

  // Even without a PID file, check for zombie daemon processes (e.g. from a
  // shutdown that deleted the PID file but failed to exit).
  if (!underLaunchd) {
    try {
      const pgrepOut = execSync(`pgrep -f 'daemon\\.ts$' 2>/dev/null || true`, { encoding: "utf-8", timeout: 3000 });
      const pids = pgrepOut.trim().split("\n").map(Number).filter(p => p && p !== process.pid && isProcessRunning(p));
      for (const zombiePid of pids) {
        log(`Killing zombie daemon process ${zombiePid}`);
        try { process.kill(zombiePid, "SIGKILL"); } catch {}
      }
    } catch {}
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
  watcher: SessionWatcher;
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
        logLifecycle("forced_update_complete", `Binary replaced from v${currentVersion}, target>=${minVersion}`);
        await flushRemoteLogs();
        if (!isManagedByLaunchd()) {
          spawnReplacement();
        }
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
        if (!isManagedByLaunchd()) {
          const spawned = spawnReplacement();
          if (spawned) skipRespawn = true;
        }
        setTimeout(() => process.exit(0), 500);
      }).catch(() => {
        if (!isManagedByLaunchd()) {
          const spawned = spawnReplacement();
          if (spawned) skipRespawn = true;
        }
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
      logLifecycle("wake_detected", `System was suspended for ${Math.round(elapsed / 1000)}s, recovering`);
      lastWatcherEventTime = 0;
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
  let watchdogRunning = false;

  return setInterval(async () => {
    if (watchdogRunning || isInWakeGrace()) return;
    watchdogRunning = true;
    try {
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

    // Prune started session entries if tmux session is dead or agent has crashed
    for (const [convId, entry] of startedSessionTmux.entries()) {
      if (now - entry.startedAt > STARTED_SESSION_TTL_MS) {
        try {
          await tmuxExec(["has-session", "-t", entry.tmuxSession], { timeout: 3000, killSignal: "SIGKILL" });
          if (!(await isTmuxAgentAlive(entry.tmuxSession))) {
            log(`Pruning started session ${entry.tmuxSession}: agent dead (zombie shell)`);
            try { await tmuxExec(["kill-session", "-t", entry.tmuxSession]); } catch {}
            startedSessionTmux.delete(convId);
          }
        } catch {
          startedSessionTmux.delete(convId);
        }
      }
    }

    // Reap zombie cc-resume-* and cc-claude-* tmux sessions where agent has crashed
    // Require 3 consecutive "dead" checks before killing (strike system)
    const activeStartedTmux = new Set([...startedSessionTmux.values()].map(e => e.tmuxSession));
    const activeResumeTmux = new Set(resumeSessionCache.values());
    try {
      const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"], { timeout: 3000, killSignal: "SIGKILL" });
      const seenThisCycle = new Set<string>();
      for (const tmuxName of tmuxList.trim().split("\n")) {
        if (!tmuxName || (!/^cc-resume-/.test(tmuxName) && !/^cc-claude-/.test(tmuxName))) continue;
        seenThisCycle.add(tmuxName);
        if (activeStartedTmux.has(tmuxName)) continue;
        if (activeResumeTmux.has(tmuxName)) continue;
        if (!(await isTmuxAgentAlive(tmuxName))) {
          const strikes = (zombieStrikes.get(tmuxName) || 0) + 1;
          zombieStrikes.set(tmuxName, strikes);
          if (strikes >= ZOMBIE_STRIKE_THRESHOLD) {
            log(`Reaping zombie tmux session ${tmuxName} (${strikes} consecutive dead checks)`);
            try { await tmuxExec(["kill-session", "-t", tmuxName]); } catch {}
            zombieStrikes.delete(tmuxName);
          } else {
            log(`Zombie candidate ${tmuxName}: strike ${strikes}/${ZOMBIE_STRIKE_THRESHOLD}`);
          }
        } else {
          zombieStrikes.delete(tmuxName);
        }
      }
      for (const name of zombieStrikes.keys()) {
        if (!seenThisCycle.has(name)) zombieStrikes.delete(name);
      }
    } catch {}

    // Mark stale agent-status files as completed (session ended without SessionEnd hook)
    try {
      const statusDir = AGENT_STATUS_DIR;
      if (fs.existsSync(statusDir)) {
        const IDLE_STALE_MS = 10 * 60 * 1000;
        const ACTIVE_STALE_MS = 30 * 60 * 1000;
        for (const file of fs.readdirSync(statusDir)) {
          if (!file.endsWith(".json")) continue;
          const sessionId = file.replace(".json", "");
          const filePath = path.join(statusDir, file);
          try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(raw) as HookStatusData;
            if (!data.ts) continue;
            const ageMs = now - data.ts * 1000;
            const threshold = (data.status === "idle" || data.status === "stopped") ? IDLE_STALE_MS : ACTIVE_STALE_MS;
            if (ageMs < threshold) continue;
            const convId = deps.conversationCache[sessionId];
            if (!convId) { try { fs.unlinkSync(filePath); } catch {} continue; }
            log(`Watchdog: stale ${data.status} session ${sessionId.slice(0, 8)} (${Math.round(ageMs / 60000)}min), marking completed`);
            deps.syncService.markSessionCompleted(convId).catch(() => {});
            sendAgentStatus(deps.syncService, convId, sessionId, "stopped");
            try { fs.unlinkSync(filePath); } catch {}
          } catch {}
        }
      }
    } catch {}

    // Check for watcher staleness -- only restart if idle for 60+ min.
    // Short idle periods are normal (no active sessions, nighttime, etc.)
    const watcherIdleMinutes = Math.floor((now - lastWatcherEventTime) / 60000);
    if (watcherIdleMinutes >= 60) {
      log(`Watcher idle for ${watcherIdleMinutes}min, restarting`);
      try {
        deps.watcher.restart();
        lastWatcherEventTime = now;
        log(`Watcher restarted successfully`);
      } catch (err) {
        logError("Failed to restart watcher", err instanceof Error ? err : new Error(String(err)));
      }
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
    } finally { watchdogRunning = false; }
  }, WATCHDOG_INTERVAL_MS);
}

async function main(): Promise<void> {
  ensureConfigDir();
  ensureCastAlias();

  if (!acquireLock()) {
    const existingPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    console.error(`Daemon already running (PID: ${existingPid}). Exiting.`);
    process.exit(0);
  }

  // Exit guard: respawn with backoff if crash looping.
  // Skip self-respawn when running under launchd (KeepAlive handles restarts).
  const underLaunchd = isManagedByLaunchd();
  process.on("exit", (code) => {
    persistLogQueue();
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
    persistLogQueue();
    sendLogImmediate("error", `UNCAUGHT EXCEPTION: ${err.message}`, {
      error_code: err.name,
      stack: err.stack?.slice(0, 1000),
    });
    await flushRemoteLogs().catch(() => {});
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError("Unhandled rejection", err);
    await flushRemoteLogs().catch(() => {});
  });

  try {
    daemonVersion = getVersion();
  } catch {
    daemonVersion = "unknown";
  }

  try {
    fs.writeFileSync(VERSION_FILE, daemonVersion, { mode: 0o600 });
  } catch {}

  activeConfig = readConfig();
  loadPersistedLogQueue();

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
  const startMsg = `v${daemonVersion} PID=${process.pid}${isRestart ? " (restart after update)" : ""}${crashRecoveryInfo}`;
  logLifecycle("daemon_start", startMsg);
  sendLogImmediate("info", `[LIFECYCLE] daemon_start: ${startMsg}`, { error_code: "daemon_start" });
  log(`PID: ${process.pid}`);

  if (isSyncPaused()) {
    log("⚠️  Sync is PAUSED via environment variable (CODE_CHAT_SYNC_PAUSED or CODECAST_PAUSED)");
  }

  saveDaemonState({ connected: false, runtimeVersion: getVersion() });

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

  // Check for forced updates immediately on startup before anything else
  // This allows recovery from broken versions by downloading a fix early
  try {
    const didUpdate = await checkForForcedUpdate(syncService);
    if (didUpdate) return; // process.exit already called inside
  } catch (err) {
    log(`Startup update check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Repair any project paths that were stored incorrectly (one-time on startup)
  repairProjectPaths(syncService).catch(err => {
    log(`Failed to repair project paths: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Backfill plan_mode plans from JSONL files that the daemon missed (e.g., sessions completed before daemon started)
  backfillPlanModeFromJSONL(syncService).catch(err => {
    log(`Failed to backfill plan_mode from JSONL: ${err instanceof Error ? err.message : String(err)}`);
  });

  setInterval(() => {
    flushRemoteLogs().catch(() => {});
  }, LOG_FLUSH_INTERVAL_MS);

  setInterval(() => {
    logHealthSummary();
    sendHeartbeat().catch(() => {});
    checkDiskVersionMismatch();
  }, HEALTH_REPORT_INTERVAL_MS);

  setInterval(() => {
    pollDaemonCommands().catch(() => {});
  }, 10_000);

  // Auto-dispatch: detect active plans with bound workflows that haven't started
  const notifiedPlanWorkflows = new Set<string>();
  async function checkPlanAutoDispatch() {
    if (!config.auth_token) return;
    const siteUrl = (config.convex_url || "").replace(".cloud", ".site");
    try {
      const resp = await fetch(`${siteUrl}/cli/plans/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: config.auth_token, status: "active" }),
      });
      const data = await resp.json() as any;
      const plans = Array.isArray(data) ? data : (data?.plans || []);
      for (const plan of plans) {
        if (plan.workflow_id && !plan.workflow_run_id && !notifiedPlanWorkflows.has(plan.short_id)) {
          notifiedPlanWorkflows.add(plan.short_id);
          log(`[AUTO-DISPATCH] Plan ${plan.short_id} has workflow ready — start from web UI or: cast workflow run --plan ${plan.short_id}`);
        }
      }
    } catch {}
  }

  setInterval(() => {
    checkPlanAutoDispatch().catch(() => {});
  }, 60_000);

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

  // Sync skills to user profile on startup (global + per-project)
  {
    const globalSkills = readAvailableSkills();
    if (globalSkills.length > 0) {
      const skillsJson = JSON.stringify(globalSkills);
      log(`Startup: syncing ${globalSkills.length} global skills to user profile`);
      syncService.setAvailableSkills(undefined as any, skillsJson).then(() => {
        log(`Startup: user-level skills synced`);
      }).catch(err => log(`Startup skills sync error: ${err}`));
    }
    const globalNames = new Set(globalSkills.map(s => s.name));
    const projectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    const decodeProjectPath = (dirName: string): string | null => {
      const segments = dirName.replace(/^-/, "").split("-");
      let resolved = "";
      let i = 0;
      while (i < segments.length) {
        let candidate = segments[i];
        i++;
        while (true) {
          const testPath = resolved + "/" + candidate;
          if (i >= segments.length) { resolved = testPath; break; }
          try {
            if (fs.statSync(testPath).isDirectory()) { resolved = testPath; break; }
          } catch {}
          candidate += "-" + segments[i];
          i++;
        }
      }
      return fs.existsSync(resolved) ? resolved : null;
    };
    try {
      const entries = fs.readdirSync(projectsDir);
      for (const entry of entries) {
        const projectPath = decodeProjectPath(entry);
        if (!projectPath) continue;
        const hasCommands = fs.existsSync(path.join(projectPath, ".claude", "commands"));
        const hasSkills = fs.existsSync(path.join(projectPath, ".claude", "skills"));
        if (!hasCommands && !hasSkills) continue;
        const allSkills = readAvailableSkills(projectPath);
        const projectOnly = allSkills.filter(s => !globalNames.has(s.name));
        if (projectOnly.length > 0) {
          log(`Startup: syncing ${projectOnly.length} project skills for ${path.basename(projectPath)}`);
          syncService.setAvailableSkills(undefined as any, JSON.stringify(projectOnly), projectPath).catch(() => {});
        }
      }
    } catch {}
  }

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
    depth: 0,
  });
  statusWatcher.on("add", handleStatusFile).on("change", handleStatusFile);

  // Process existing status files on startup (chokidar ignoreInitial skips them)
  try {
    for (const file of fs.readdirSync(AGENT_STATUS_DIR)) {
      if (file.endsWith(".json")) {
        handleStatusFile(path.join(AGENT_STATUS_DIR, file));
      }
    }
  } catch {}

  function handleStatusFile(filePath: string) {
    try {
      const basename = path.basename(filePath, ".json");
      if (!basename || !filePath.endsWith(".json")) return;
      const sessionId = basename;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as HookStatusData;
      if (!data.status || !data.ts) return;

      const convId = conversationCache[sessionId];
      if (!convId) return;

      const prev = lastHookStatus.get(sessionId);
      if (prev && prev.ts >= data.ts) return;

      const statusChanged = !prev || prev.status !== data.status;
      const modeChanged = data.permission_mode && (!prev || prev.permission_mode !== data.permission_mode);
      lastHookStatus.set(sessionId, data);

      if (data.status === "compacting" || data.status === "thinking" || data.status === "stopped") {
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

      if (data.status === "stopped" && statusChanged) {
        const restartTs = restartingSessionIds.get(sessionId);
        if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) {
          log(`Session ended for ${sessionId.slice(0, 8)}, but restart in progress — skipping completion`);
          try { fs.unlinkSync(filePath); } catch {}
        } else {
          log(`Session ended for ${sessionId.slice(0, 8)}, marking completed`);
          syncService.markSessionCompleted(convId).catch(() => {});
          try { fs.unlinkSync(filePath); } catch {}
        }
      }

      if (data.status === "permission_blocked" && !permissionRecordPending.has(sessionId)) {
        permissionRecordPending.add(sessionId);
        permissionJustResolved.add(sessionId);
        const transcriptPath = data.transcript_path || findTranscriptForSession(sessionId);

        // Prefer tool name from hook message (direct from PermissionRequest event) over transcript extraction
        // Transcript can return stale tool_use entries (e.g. ExitPlanMode) that don't match the actual permission
        const hookToolName = data.message?.split(/[:\s]/)[0] || null;
        const toolInfo = !hookToolName ? extractPendingToolUseFromTranscript(transcriptPath || "") : null;
        const toolName = hookToolName || toolInfo?.tool_name || extractToolFromMessage(data.message || "");
        const preview = toolInfo?.arguments_preview || data.message || "";

        const SKIP_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
        if (toolName && !SKIP_TOOLS.has(toolName)) {
          log(`Creating permission record: ${toolName} for session ${sessionId.slice(0, 8)}`);
          const permPrompt = { tool_name: toolName, arguments_preview: preview };

          syncService.createSessionNotification({
            conversation_id: convId,
            type: "permission_request",
            title: "codecast - Permission needed",
            message: truncateForNotification(`${toolName}: ${preview}`, 150),
          }).catch(() => {});

          handlePermissionRequest(syncService, convId, sessionId, permPrompt, log)
            .then((decision) => {
              permissionRecordPending.delete(sessionId);
              if (decision) {
                const key = decision.approved ? "Enter" : "Escape";
                log(`Permission ${decision.approved ? "approved" : "denied"} for session ${sessionId.slice(0, 8)}, sending '${key}'`);
                findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
                  if (!proc) { log("No process found for permission injection"); return; }
                  findTmuxPaneForTty(proc.tty).then(async (tmuxTarget) => {
                    try {
                      if (tmuxTarget) {
                        await tmuxExec(["send-keys", "-t", tmuxTarget, key]);
                      } else {
                        await injectViaTerminal(proc.tty, decision.approved ? "\r" : "\x1b", proc.termProgram);
                      }
                      log(`Injected '${key}' for session ${sessionId.slice(0, 8)}`);
                      sendAgentStatus(syncService, convId, sessionId, "working");
                    } catch (err) {
                      log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  });
                }).catch((err) => {
                  log(`Failed to find session process: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            })
            .catch((err) => {
              permissionRecordPending.delete(sessionId);
              log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
            });
        } else {
          log(`Skipped permission record for ${toolName || "unknown"} (SKIP_TOOLS) session ${sessionId.slice(0, 8)}`);
          permissionRecordPending.delete(sessionId);
        }
      }

      if (data.status !== "permission_blocked" && prev?.status === "permission_blocked") {
        permissionRecordPending.delete(sessionId);
      }
    } catch {}
  }

  function extractToolFromMessage(message: string): string {
    const colonMatch = message.match(/^(\w+):\s/);
    if (colonMatch) return colonMatch[1];
    const m = message.match(/permission to use (\w+)/i) || message.match(/allow (\w+)/i);
    return m?.[1] || "Bash";
  }

  function findTranscriptForSession(sessionId: string): string | null {
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    try {
      const dirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of dirs) {
        const jsonlPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(jsonlPath)) return jsonlPath;
      }
    } catch {}
    return null;
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
          try {
            const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
              if (meta.description) subagentDescriptions.set(sessionId, meta.description);
            }
          } catch {}
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
          syncService.linkSessions(parentConvId, childConvId, subagentDescriptions.get(childSessionId)).then(() => {
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
          const headContent = readFileHead(fp, 16384);
          const msgs = parseSessionFile(headContent);
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
    watcher,
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

  codexAppServerInstance = new CodexAppServer({
    log,
    onApproval: async (threadId: string, approval: ApprovalRequest) => {
      const entry = appServerThreads.get(threadId);
      if (!entry) return true;
      const permissionPrompt = {
        tool_name: approval.method,
        arguments_preview: JSON.stringify(approval.params).slice(0, 200),
      };
      try {
        const decision = await handlePermissionRequest(syncService, entry.conversationId, threadId, permissionPrompt, log);
        return decision?.approved ?? true;
      } catch (err) {
        log(`[codex-app-server] approval error: ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
    },
  });

  codexAppServerInstance.on("turnCompleted", async (threadId: string, turnId: string, messages: any[], status: string) => {
    const entry = appServerThreads.get(threadId);
    if (!entry) return;
    if (messages.length > 0) {
      const batchResult = await syncMessagesBatch(messages, entry.conversationId, syncService, retryQueue);
      if (!batchResult.authExpired && !batchResult.conversationNotFound) {
        syncStats.messagesSynced += messages.length;
        syncStats.sessionsActive.add(threadId);
        log(`[codex-app-server] synced ${messages.length} messages for thread ${threadId.slice(0, 8)}`);
      }
    }
    sendAgentStatus(syncService, entry.conversationId, threadId, status === "completed" ? "idle" : "working");
  });

  codexAppServerInstance.on("turnStarted", (threadId: string) => {
    const entry = appServerThreads.get(threadId);
    if (entry) {
      sendAgentStatus(syncService, entry.conversationId, threadId, "working");
    }
  });

  codexAppServerInstance.on("threadNameUpdated", async (threadId: string, name: string | null) => {
    if (!name) return;
    const entry = appServerThreads.get(threadId);
    if (!entry) return;
    try {
      await syncService.updateTitle(entry.conversationId, name);
      log(`[codex-app-server] updated title for thread ${threadId.slice(0, 8)}: ${name}`);
    } catch {}
  });

  codexAppServerInstance.on("approvalRequested", (threadId: string, approval: ApprovalRequest) => {
    const entry = appServerThreads.get(threadId);
    if (entry) {
      sendAgentStatus(syncService, entry.conversationId, threadId, "permission_blocked");
      syncService.createSessionNotification({
        conversation_id: entry.conversationId,
        type: "permission_request" as any,
        title: "codecast - Permission needed",
        message: `${approval.method}: ${JSON.stringify(approval.params).slice(0, 200)}`,
      }).catch(() => {});
    }
  });

  codexAppServerInstance.on("error", (err: Error) => {
    log(`[codex-app-server] error: ${err.message}`);
  });

  codexAppServerInstance.start();
  log("[codex-app-server] started");

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
      logDelivery(`msg=${messageId.slice(0, 8)} exceeded max retries (10), marking undeliverable`);
      syncService.updateMessageStatus({ messageId, status: "undeliverable" as any }).catch(() => {});
      return;
    }
    const delays = [1000, 5000, 15000, 30000, 60000];
    const delay = delays[Math.min(retryCount, delays.length - 1)];
    logDelivery(`Scheduling retry ${retryCount + 1}/10 for msg=${messageId.slice(0, 8)} in ${delay / 1000}s`);
    messageRetryTimers.add(messageId);
    setTimeout(async () => {
      messageRetryTimers.delete(messageId);
      try {
        await syncService.retryMessage(messageId);
        logDelivery(`Retry ${retryCount + 1} triggered for msg=${messageId.slice(0, 8)}`);
      } catch (err) {
        logDelivery(`Retry trigger failed for msg=${messageId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay);
  }

  const messagesInFlight = new Set<string>();

  const setupSubscription = () => {
    try {
      logDelivery("Setting up pending messages subscription");
      unsubscribe = subscriptionClient.onUpdate(
        "pendingMessages:getPendingMessages" as any,
        { user_id: config.user_id, api_token: config.auth_token },
        async (messages: any) => {
          if (!messages) {
            return;
          }

          if (Array.isArray(messages)) {
            if (messages.length > 0) {
              logDelivery(`Subscription: ${messages.length} pending message(s) received`);
            }
            for (const msg of messages) {
              if (messagesInFlight.has(msg._id)) {
                logDelivery(`Skipping msg=${msg._id.slice(0, 8)} - already in flight`);
                continue;
              }
              messagesInFlight.add(msg._id);

              const imageIds = msg.image_storage_ids ?? (msg.image_storage_id ? [msg.image_storage_id] : []);
              logDelivery(`Processing: msg=${msg._id.slice(0, 8)} conv=${msg.conversation_id.slice(0, 12)} content="${msg.content.slice(0, 80)}" images=${imageIds.length} retry=${msg.retry_count ?? 0}`);

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
                  logDelivery(`SUCCESS: msg=${msg._id.slice(0, 8)} delivered`);
                } else {
                  logDelivery(`FAILED: msg=${msg._id.slice(0, 8)} delivery returned false, scheduling retry ${(msg.retry_count ?? 0) + 1}`);
                  scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, messageContent);
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logDelivery(`ERROR: msg=${msg._id.slice(0, 8)} exception: ${errMsg}`);
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
      logDelivery("Pending messages subscription established");
      saveDaemonState({ connected: true });
      if (reconnectAttempt > 0) {
        sendLogImmediate("info", `[LIFECYCLE] connection_restored: after ${reconnectAttempt} attempts`, { error_code: "connection_restored" });
      }
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
      if (reconnectAttempt <= 3 || reconnectAttempt % 10 === 0) {
        sendLogImmediate("warn", `Connection lost, attempt ${reconnectAttempt}: ${error.message}`, {
          error_code: "connection_lost",
          stack: error.stack?.slice(0, 500),
        });
      }
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
              const approved = permission.status === "approved";
              const key = approved ? "Enter" : "Escape";
              const sessionId = permission.session_id;
              let injected = false;

              if (sessionId) {
                const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
                if (proc) {
                  const tmuxTarget = await findTmuxPaneForTty(proc.tty);
                  if (tmuxTarget) {
                    try {
                      await tmuxExec(["send-keys", "-t", tmuxTarget, key]);
                      injected = true;
                    } catch {}
                  }
                  if (!injected) {
                    try {
                      await injectViaTerminal(proc.tty, approved ? "\r" : "\x1b", proc.termProgram);
                      injected = true;
                    } catch {}
                  }
                }
              }

              if (injected) {
                log(`Injected permission '${key}' for session ${sessionId?.slice(0, 8)}`);
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
            if (processedCommandIds.has(cmd.id) || processedPollCommandIds.has(cmd.id)) {
              continue;
            }

            processedCommandIds.add(cmd.id);
            processedPollCommandIds.add(cmd.id);
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

    // Hard exit guarantee: if graceful shutdown takes too long, force exit.
    // This prevents zombie daemons that hold the event loop open via in-flight retries.
    const hardExitTimer = setTimeout(() => {
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [CRITICAL] Hard exit after shutdown timeout\n`); } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
      try { fs.unlinkSync(VERSION_FILE); } catch {}
      process.exit(1);
    }, 15_000);
    hardExitTimer.unref();

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
    codexAppServerInstance?.stop();

    retryQueue.stop();

    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Dropping ${pendingOps} pending retry operations`);
    }

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
    sendLogImmediate("info", "[LIFECYCLE] daemon_stop: graceful shutdown", { error_code: "daemon_stop" });
    await flushRemoteLogs();
    persistLogQueue();
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

  // 3c. If daemon is alive but running an older version than the binary, kill it
  if (daemonAlive && daemonPid > 0) {
    try {
      const state = readDaemonState();
      const daemonVersion = state.runtimeVersion;
      // If runtimeVersion is missing, daemon predates this field -- assume outdated if min_cli_version is set
      const needsKill = daemonVersion
        ? compareVersions(daemonVersion, version) < 0
        : !!(minCliVersion && compareVersions(version, minCliVersion) >= 0);
      if (needsKill) {
        logLine(`Daemon running v${daemonVersion || "unknown"} but binary is v${version}, killing to upgrade`);
        await sendWatchdogLog("info", `[LIFECYCLE] watchdog_version_mismatch: daemon=${daemonVersion || "unknown"} binary=${version}, killing`);
        try { process.kill(daemonPid, 15); } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
        daemonAlive = false;
      }
    } catch {}
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
  const execPath = process.execPath;
  const isBinary = !execPath.endsWith("/bun") && !execPath.endsWith("/node") && !execPath.includes("node_modules");
  if (isBinary) {
    return { executablePath: execPath, args: ["--", "_daemon"] };
  }
  return { executablePath: execPath, args: [path.resolve(__dirname, "daemon.js")] };
}

// Only run directly if executed as the main module (not when imported)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js")) {
  daemonStarted = true;
  main().catch((err) => {
    logError("Fatal error", err instanceof Error ? err : new Error(String(err)));
    flushRemoteLogs().finally(() => process.exit(1));
  });
}
