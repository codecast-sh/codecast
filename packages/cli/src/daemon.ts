#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Database } from "bun:sqlite";
import { execSync, exec, spawn } from "child_process";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { CursorTranscriptWatcher, type CursorTranscriptEvent } from "./cursorTranscriptWatcher.js";
import { CodexWatcher, type CodexSessionEvent } from "./codexWatcher.js";
import { parseSessionFile, parseCodexSessionFile, parseCursorTranscriptFile, extractSlug, extractParentUuid, extractSummaryTitle, extractCwd, extractCodexCwd, type ParsedMessage } from "./parser.js";
import { extractMessagesFromCursorDb } from "./cursorProcessor.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { markSynced, getSyncRecord, findUnsyncedFiles } from "./syncLedger.js";
import { SyncService, AuthExpiredError } from "./syncService.js";
import { redactSecrets, maskToken } from "./redact.js";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";
import { InvalidateSync } from "./invalidateSync.js";
import { promisify } from "util";
import { detectPermissionPrompt } from "./permissionDetector.js";
import { handlePermissionRequest } from "./permissionHandler.js";
import { getVersion, performUpdate } from "./update.js";
import { performReconciliation, repairDiscrepancies } from "./reconciliation.js";

const execAsync = promisify(exec);

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");

interface Config {
  user_id?: string;
  team_id?: string;
  convex_url?: string;
  auth_token?: string;
  excluded_paths?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];
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
}

const AUTH_FAILURE_THRESHOLD = 5;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WATCHDOG_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_FLUSH_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_LOG_QUEUE_SIZE = 200;

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
const platform = process.platform;

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
        await executeRemoteCommand(cmd.id, cmd.command, config);
      }
    }
  } catch (err) {
    log(`Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function executeRemoteCommand(
  commandId: string,
  command: string,
  config: Config
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
        // Schedule restart
        setTimeout(() => {
          log("Restarting daemon per remote command...");
          process.exit(0); // Exit, launchd/systemd will restart
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
        // Trigger update check
        setTimeout(async () => {
          const success = await performUpdate();
          if (success) {
            const newVersion = getVersion();
            logLifecycle("update_complete", `Updated from v${currentVersion} to v${newVersion}`);
            await flushRemoteLogs();
            log("Update successful, restarting...");
            process.exit(0);
          } else {
            logLifecycle("update_failed", `Update failed from v${currentVersion}`);
            await flushRemoteLogs();
          }
        }, 1000);
        return;
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

  if (trimmed.length <= 50) {
    return trimmed;
  }

  return trimmed.slice(0, 50) + "...";
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
      const actualProjectPath = extractCwd(fullContent) || projectPath;
      const gitInfo = actualProjectPath ? getGitInfo(actualProjectPath) : undefined;

      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "claude_code",
        projectPath: actualProjectPath,
        slug,
        title,
        startedAt: firstMessageTimestamp,
        parentMessageUuid,
        gitInfo,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for session ${sessionId}`);
      syncStats.conversationsCreated++;

      if ((global as any).activeSessions) {
        (global as any).activeSessions.set(conversationId, {
          sessionId,
          conversationId,
          projectPath: actualProjectPath || "",
        });
      }

      if (pendingMessages[sessionId]) {
        for (const msg of pendingMessages[sessionId]) {
          try {
            await syncService.addMessage({
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
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to add pending message, queueing for retry: ${errMsg}`);
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
      const retryProjectPath = extractCwd(retryFullContent) || projectPath;
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

  for (const msg of messages) {
    try {
      await syncService.addMessage({
        conversationId,
        messageUuid: msg.uuid,
        role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
        content: redactSecrets(msg.content),
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype,
      });
      resetAuthFailureCount();
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          return;
        }
        // Continue to error handling - will retry
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Conversation not found")) {
        log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
        delete conversationCache[sessionId];
        saveConversationCache(conversationCache);

        let recreateFullContent;
        try {
          recreateFullContent = fs.readFileSync(filePath, "utf-8");
        } catch (readErr: any) {
          if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
            log(`Warning: Permission denied reading ${filePath} for conversation recreation. Skipping.`);
            continue;
          }
          throw readErr;
        }

        const slug = extractSlug(recreateFullContent);
        const firstMessageTimestamp = messages[0]?.timestamp;
        const recreateProjectPath = extractCwd(recreateFullContent) || projectPath;
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

          await syncService.addMessage({
            conversationId,
            messageUuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        } catch (retryErr) {
          const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Failed to recreate conversation and add message: ${retryErrMsg}`);
        }
      } else {
        log(`Failed to add message, queueing for retry: ${errMsg}`);
        retryQueue.add("addMessage", {
          conversationId,
          messageUuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
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

    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);

    const lastAssistantMessage = messages.filter(m => m.role === "assistant").pop();
    if (lastAssistantMessage && conversationId) {
      const permissionPrompt = detectPermissionPrompt(lastAssistantMessage.content);
      if (permissionPrompt) {
        log(`Permission prompt detected for tool: ${permissionPrompt.tool_name}`);

        handlePermissionRequest(
          syncService,
          conversationId,
          sessionId,
          permissionPrompt,
          log
        ).then((decision) => {
          if (decision) {
            const response = decision.approved ? "y" : "n";
            log(`Attempting to inject response '${response}' to Claude Code`);

            findClaudeCodeProcesses().then((processes) => {
              if (processes.length === 0) {
                log("No Claude Code processes found");
                return;
              }

              for (const proc of processes) {
                getTtyPath(proc.tty).then((ttyPath) => {
                  if (ttyPath) {
                    injectMessageToStdin(ttyPath, response).then(() => {
                      log(`Injected '${response}' to Claude Code process ${proc.pid} at ${ttyPath}`);
                    }).catch((err) => {
                      log(`Failed to inject to ${ttyPath}: ${err instanceof Error ? err.message : String(err)}`);
                    });
                  }
                }).catch((err) => {
                  log(`Failed to get TTY path for ${proc.tty}: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            }).catch((err) => {
              log(`Failed to find Claude Code processes: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else {
            log("Permission request timed out or failed");
          }
        }).catch((err) => {
          log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
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
        for (const msg of pendingMessages[sessionId]) {
          try {
            await syncService.addMessage({
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
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to add pending message, queueing for retry: ${errMsg}`);
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

  for (const msg of messages) {
    try {
      await syncService.addMessage({
        conversationId,
        messageUuid: msg.uuid,
        role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
        content: redactSecrets(msg.content),
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype,
      });
      resetAuthFailureCount();
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          return;
        }
        // Continue to error handling - will retry
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Conversation not found")) {
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

          await syncService.addMessage({
            conversationId,
            messageUuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        } catch (retryErr) {
          const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Failed to recreate conversation and add message: ${retryErrMsg}`);
        }
      } else {
        log(`Failed to add message, queueing for retry: ${errMsg}`);
        retryQueue.add("addMessage", {
          conversationId,
          messageUuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
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
          for (const msg of pendingMessages[sessionId]) {
            try {
              await syncService.addMessage({
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
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log(`Failed to add pending message, queueing for retry: ${errMsg}`);
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

    for (const msg of messages) {
      try {
        await syncService.addMessage({
          conversationId,
          messageUuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype,
        });
        resetAuthFailureCount();
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            return;
          }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("Conversation not found")) {
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

            await syncService.addMessage({
              conversationId,
              messageUuid: msg.uuid,
              role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
              content: redactSecrets(msg.content),
              timestamp: msg.timestamp,
              thinking: msg.thinking,
              toolCalls: msg.toolCalls,
              toolResults: msg.toolResults,
              images: msg.images,
              subtype: msg.subtype,
            });
          } catch (retryErr) {
            const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            log(`Failed to recreate Cursor conversation and add message: ${retryErrMsg}`);
          }
        } else {
          log(`Failed to add message, queueing for retry: ${errMsg}`);
          retryQueue.add("addMessage", {
            conversationId,
            messageUuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
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
          for (const msg of pendingMessages[sessionId]) {
            try {
              await syncService.addMessage({
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
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log(`Failed to add pending message, queueing for retry: ${errMsg}`);
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

    for (const msg of messages) {
      try {
        await syncService.addMessage({
          conversationId,
          messageUuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype,
        });
        resetAuthFailureCount();
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            return;
          }
          // Continue to error handling - will retry
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("Conversation not found")) {
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

            await syncService.addMessage({
              conversationId,
              messageUuid: msg.uuid,
              role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
              content: redactSecrets(msg.content),
              timestamp: msg.timestamp,
              thinking: msg.thinking,
              toolCalls: msg.toolCalls,
              toolResults: msg.toolResults,
              images: msg.images,
              subtype: msg.subtype,
            });
          } catch (retryErr) {
            const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            log(`Failed to recreate Codex conversation and add message: ${retryErrMsg}`);
          }
        } else {
          log(`Failed to add message, queueing for retry: ${errMsg}`);
          retryQueue.add("addMessage", {
            conversationId,
            messageUuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
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

    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} Codex messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Codex session file ${filePath}: ${errMsg}`);
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

interface ClaudeCodeProcess {
  pid: number;
  tty: string;
}

async function findClaudeCodeProcesses(): Promise<ClaudeCodeProcess[]> {
  try {
    const { stdout } = await execAsync("ps aux | grep -i 'claude' | grep -v grep");
    const lines = stdout.trim().split("\n");
    const processes: ClaudeCodeProcess[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;

      const pid = parseInt(parts[1], 10);
      const tty = parts[6];

      if (isNaN(pid) || tty === "?" || tty === "??") continue;

      processes.push({ pid, tty });
    }

    return processes;
  } catch (err) {
    log(`Error finding Claude Code processes: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function getTtyPath(tty: string): Promise<string | null> {
  if (tty.startsWith("/dev/")) {
    return tty;
  }

  if (tty.startsWith("ttys")) {
    return `/dev/${tty}`;
  }

  if (tty.match(/^s\d+$/)) {
    return `/dev/tty${tty}`;
  }

  return null;
}

async function injectMessageToStdin(ttyPath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const messageWithNewline = content + "\n";

    fs.writeFile(ttyPath, messageWithNewline, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
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

    for (const file of sessionFiles) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = path.join(dirPath, file);

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const actualCwd = extractCwd(content);
        if (!actualCwd) continue;

        checked++;

        const result = await syncService.updateProjectPath(sessionId, actualCwd);
        if (result?.updated) {
          repaired++;
          log(`Repaired path for ${sessionId.slice(0, 8)}: ${actualCwd}`);
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
          if (!syncRecord) {
            // Never synced - add to stale list
            staleFiles.push(filePath);
          } else if (fileStat.mtimeMs > syncRecord.lastSyncedAt) {
            // Modified after last sync - add to stale list
            staleFiles.push(filePath);
          } else if (fileStat.size > syncRecord.lastSyncedPosition) {
            // New content since last sync
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
      log(`Force update required: current=${currentVersion} min=${minVersion}`);
      log("Performing automatic update...");
      const success = await performUpdate();
      if (success) {
        log("Update successful, restarting daemon...");
        // Spawn new daemon before exiting (don't rely on launchd/systemd)
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, CODECAST_RESTART: "1" },
        });
        child.unref();
        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 500));
        process.exit(0);
      } else {
        log("Update failed, will retry later");
      }
      return true;
    }
    return false;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Version check failed: ${errMsg}`);
    return false;
  }
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

  // Only log if there are issues
  if (unsyncedFiles.length > 0 || droppedOps.length > 0 || queueSize > 10) {
    logWarn(
      `Health: ${unsyncedFiles.length} pending files, ${droppedOps.length} dropped ops, ${queueSize} in retry queue`
    );
  } else {
    log(`Health: All synced, no issues`);
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

    // Check for watcher staleness (informational - no events is normal when user isn't working)
    const watcherIdleMinutes = Math.floor((now - lastWatcherEventTime) / 60000);
    if (watcherIdleMinutes >= 30) {
      logWarn(`Watcher idle for ${watcherIdleMinutes}min`);
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
      const sessionId = parts[parts.length - 1].replace(".jsonl", "");
      const projectDirName = parts[parts.length - 2];
      const projectPath = projectDirName.replace(/-/g, path.sep).replace(/^-/, "");

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

  const isRestart = process.env.CODECAST_RESTART === "1";
  logLifecycle("daemon_start", `v${daemonVersion} PID=${process.pid}${isRestart ? " (restart after update)" : ""}`);
  log(`PID: ${process.pid}`);

  if (isSyncPaused()) {
    log("⚠️  Sync is PAUSED via environment variable (CODE_CHAT_SYNC_PAUSED or CODECAST_PAUSED)");
  }

  saveDaemonState({ connected: false });

  const { config, convexUrl } = await waitForConfig();

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
  }, HEALTH_REPORT_INTERVAL_MS);

  // Send initial heartbeat
  sendHeartbeat().catch(() => {});

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
        for (const msg of pendingMessages[params.sessionId]) {
          try {
            await syncService.addMessage({
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
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to add pending message during retry: ${errMsg}`);
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
        const sessionId = parts[parts.length - 1].replace(".jsonl", "");
        const projectDirName = parts[parts.length - 2];
        const projectPath = projectDirName.replace(/-/g, path.sep).replace(/^-/, "");

        if (config.excluded_paths && isPathExcluded(projectPath, config.excluded_paths)) {
          continue;
        }

        if (!isProjectAllowedToSync(projectPath, config)) {
          continue;
        }

        log(`Startup scan: Syncing ${sessionId}`);

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
          updateState
        );
      }

      log(`Startup scan: Completed syncing ${unsyncedFiles.length} files`);
    } else {
      log("Startup scan: All files up to date");
    }
  };

  // Run startup scan in background (don't block daemon startup)
  performStartupScan().catch(err => {
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

  const subscriptionClient = syncService.getSubscriptionClient();
  let unsubscribe: (() => void) | null = null;
  let permissionUnsubscribe: (() => void) | null = null;
  const processedPermissionIds = new Set<string>();

  const setupSubscription = () => {
    try {
      log("Setting up pending messages subscription");
      unsubscribe = subscriptionClient.onUpdate(
        "pendingMessages:getPendingMessages" as any,
        { user_id: config.user_id, api_token: config.auth_token },
        async (messages: any) => {
          log(`Subscription update received: ${JSON.stringify(messages)?.slice(0, 200)}`);

          if (!messages) {
            log("No messages in update");
            return;
          }

          if (Array.isArray(messages)) {
            log(`Received array with ${messages.length} pending message(s)`);
            for (const msg of messages) {
              log(`Pending message: conversation_id=${msg.conversation_id} content="${msg.content.slice(0, 100)}"`);

              try {
                // Check if this session is managed (wrapper will handle delivery)
                const managedStatus = await syncService.checkManagedSession(msg.conversation_id);
                if (managedStatus?.managed) {
                  log(`Session is managed, skipping TTY injection (wrapper will deliver)`);
                  continue;
                }

                // Unmanaged session - try TTY injection
                log(`Unmanaged session, attempting TTY injection`);
                const processes = await findClaudeCodeProcesses();
                log(`Found ${processes.length} Claude Code process(es)`);

                if (processes.length === 0) {
                  log(`No Claude Code processes found, message will remain pending`);
                  continue;
                }

                let injected = false;
                for (const proc of processes) {
                  const ttyPath = await getTtyPath(proc.tty);
                  if (!ttyPath) {
                    log(`Could not resolve tty path for ${proc.tty}`);
                    continue;
                  }

                  try {
                    await injectMessageToStdin(ttyPath, msg.content);
                    log(`Successfully injected message to ${ttyPath} (pid ${proc.pid})`);

                    await syncService.updateMessageStatus({
                      messageId: msg._id,
                      status: "delivered",
                      deliveredAt: Date.now(),
                    });
                    log(`Updated message status to delivered`);
                    injected = true;
                    break;
                  } catch (writeErr) {
                    const writeErrMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                    log(`Failed to inject to ${ttyPath}: ${writeErrMsg}`);
                  }
                }

                if (!injected) {
                  log(`Failed to inject message to any process`);
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log(`Error handling pending message: ${errMsg}`);
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
              const processes = await findClaudeCodeProcesses();
              log(`Found ${processes.length} Claude Code process(es) for permission injection`);

              if (processes.length === 0) {
                log(`No Claude Code processes found, will retry on next update`);
                continue;
              }

              const response = permission.status === "approved" ? "y" : "n";
              let injected = false;

              for (const proc of processes) {
                const ttyPath = await getTtyPath(proc.tty);
                if (!ttyPath) {
                  log(`Could not resolve tty path for ${proc.tty}`);
                  continue;
                }

                try {
                  await injectMessageToStdin(ttyPath, response);
                  log(`Successfully injected permission response '${response}' to ${ttyPath} (pid ${proc.pid})`);
                  processedPermissionIds.add(permission._id);
                  injected = true;
                  break;
                } catch (writeErr) {
                  const writeErrMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                  log(`Failed to inject permission to ${ttyPath}: ${writeErrMsg}`);
                }
              }

              if (!injected) {
                log(`Failed to inject permission response to any process`);
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

  const shutdown = async () => {
    log("Shutting down gracefully");

    saveDaemonState({ connected: false });

    if (unsubscribe) {
      unsubscribe();
    }

    if (permissionUnsubscribe) {
      permissionUnsubscribe();
    }

    clearInterval(watchdogInterval);
    clearInterval(versionCheckInterval);
    clearInterval(reconciliationInterval);
    log("Watchdog and reconciliation stopped");

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

// Only run directly if executed as the main module (not when imported)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js")) {
  daemonStarted = true;
  main().catch((err) => {
    logError("Fatal error", err instanceof Error ? err : new Error(String(err)));
    flushRemoteLogs().finally(() => process.exit(1));
  });
}
