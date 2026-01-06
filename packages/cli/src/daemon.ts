#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { execSync, exec } from "child_process";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { CodexWatcher, type CodexSessionEvent } from "./codexWatcher.js";
import { parseSessionFile, extractSlug, extractParentUuid, extractSummaryTitle, type ParsedMessage } from "./parser.js";
import { extractMessagesFromCursorDb } from "./cursorProcessor.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { SyncService, AuthExpiredError } from "./syncService.js";
import { redactSecrets, maskToken } from "./redact.js";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";
import { InvalidateSync } from "./invalidateSync.js";
import { promisify } from "util";
import { detectPermissionPrompt } from "./permissionDetector.js";
import { handlePermissionRequest } from "./permissionHandler.js";

const execAsync = promisify(exec);

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");

interface Config {
  user_id?: string;
  convex_url?: string;
  auth_token?: string;
  excluded_paths?: string;
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
}

const AUTH_FAILURE_THRESHOLD = 5;


function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
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
    log(`Auth failed ${currentCount} times consecutively - marking auth as expired`);
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
      const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        sessionId,
        agentType: "claude_code",
        projectPath,
        slug,
        title,
        startedAt: firstMessageTimestamp,
        parentMessageUuid,
        gitInfo,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for session ${sessionId}`);

      if ((global as any).activeSessions) {
        (global as any).activeSessions.set(conversationId, {
          sessionId,
          conversationId,
          projectPath: projectPath || "",
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
      const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

      retryQueue.add("createConversation", {
        userId,
        sessionId,
        agentType: "claude_code",
        projectPath,
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
        const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

        try {
          const firstUserMessage = messages.find(msg => msg.role === "user");
          const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

          conversationId = await syncService.createConversation({
            userId,
            sessionId,
            agentType: "claude_code",
            projectPath,
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
    log(`Synced ${messages.length} messages for session ${sessionId}`);

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
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  updateStateCallback: () => void
): Promise<void> {
  const lastRowId = getPosition(dbPath);

  let result: { messages: ParsedMessage[]; maxRowId: number };
  try {
    result = extractMessagesFromCursorDb(dbPath, lastRowId);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${dbPath}. Will retry when permissions are restored.`);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to extract messages from Cursor DB: ${errMsg}`);
    return;
  }

  const { messages, maxRowId } = result;

  if (messages.length === 0) {
    if (maxRowId > lastRowId) {
      setPosition(dbPath, maxRowId);
    }
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
          setPosition(dbPath, maxRowId);
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
          fileSize: maxRowId,
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
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        startedAt: firstMsgTimestamp,
      }, errMsg);

      setPosition(dbPath, maxRowId);
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

  setPosition(dbPath, maxRowId);
  log(`Synced ${messages.length} Cursor messages for session ${sessionId}`);

  updateStateCallback();
}

async function processCodexSession(
  filePath: string,
  sessionId: string,
  syncService: SyncService,
  userId: string,
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
    const messages = parseSessionFile(newContent);

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
        const slug = extractSlug(fullContent);
        const parentMessageUuid = extractParentUuid(fullContent);
        const firstMessageTimestamp = messages[0]?.timestamp;

        const firstUserMessage = messages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

        conversationId = await syncService.createConversation({
          userId,
          sessionId,
          agentType: "codex",
          projectPath: undefined,
          slug,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid,
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
    log(`Synced ${messages.length} Codex messages for session ${sessionId}`);

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

async function main(): Promise<void> {
  ensureConfigDir();

  if (!acquireLock()) {
    const existingPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    console.error(`Daemon already running (PID: ${existingPid}). Exiting.`);
    process.exit(0);
  }

  process.on("uncaughtException", (err) => {
    log(`Uncaught exception: ${err.message}`);
    log(err.stack || "");
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log(`Unhandled rejection: ${msg}`);
  });

  log("Daemon started");
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
  const conversationCache = readConversationCache();
  const titleCache = readTitleCache();
  const pendingMessages: PendingMessages = {};
  const activeSessions = new Map<string, ActiveSession>();

  const retryQueue = new RetryQueue({
    initialDelayMs: 3000,
    maxDelayMs: 60000,
    maxAttempts: 15,
    onLog: log,
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

  const watcher = new SessionWatcher();
  const fileSyncs = new Map<string, InvalidateSync>();

  watcher.on("ready", () => {
    log("Session watcher ready");
  });

  watcher.on("session", (event: SessionEvent) => {
    const filePath = event.filePath;

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

    let sync = fileSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processSessionFile(
          filePath,
          event.sessionId,
          event.projectPath,
          syncService,
          config.user_id!,
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
    log(`Watcher error: ${error.message}`);
  });

  watcher.start();

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

    let sync = cursorSyncs.get(dbPath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorSession(
          dbPath,
          event.sessionId,
          event.workspacePath,
          syncService,
          config.user_id!,
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
    log(`Cursor watcher error: ${error.message}`);
  });

  cursorWatcher.start();

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
    log(`Codex watcher error: ${error.message}`);
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
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Subscription error: ${errMsg}`);
      saveDaemonState({ connected: false });
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      const delay = getReconnectDelay();
      log(`Reconnecting in ${delay}ms`);
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
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Permission subscription error: ${errMsg}`);
      if (permissionUnsubscribe) {
        permissionUnsubscribe();
        permissionUnsubscribe = null;
      }

      const delay = getReconnectDelay();
      log(`Reconnecting permission subscription in ${delay}ms`);
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

    watcher.stop();
    cursorWatcher.stop();

    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Waiting for ${pendingOps} pending operations to complete...`);

      const completed = await retryQueue.waitForCompletion(10000);
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

    if (fs.existsSync(PID_FILE)) {
      try {
        fs.unlinkSync(PID_FILE);
        log("PID file removed");
      } catch (err) {
        log(`Failed to remove PID file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log("Shutdown complete");
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

export async function runDaemon(): Promise<void> {
  return main();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js")) {
  main().catch((err) => {
    log(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
