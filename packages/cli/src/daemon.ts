#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { execSync, exec } from "child_process";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { parseSessionFile, extractSlug, extractParentUuid, extractSummaryTitle, type ParsedMessage } from "./parser.js";
import { extractMessagesFromCursorDb } from "./cursorProcessor.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { SyncService } from "./syncService.js";
import { redactSecrets, maskToken } from "./redact.js";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";
import { InvalidateSync } from "./invalidateSync.js";
import { promisify } from "util";

const execAsync = promisify(exec);

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");

interface Config {
  user_id?: string;
  convex_url?: string;
  auth_token?: string;
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

function writeDaemonState(connected: boolean): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ connected, timestamp: Date.now() }), { mode: 0o600 });
  } catch (err) {
    log(`Failed to write daemon state: ${err instanceof Error ? err.message : String(err)}`);
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
  titleCache: TitleCache
): Promise<void> {
  const lastPosition = getPosition(filePath);
  const stats = fs.statSync(filePath);

  if (stats.size <= lastPosition) {
    return;
  }

  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(stats.size - lastPosition);
  fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
  fs.closeSync(fd);

  const newContent = buffer.toString("utf-8");
  const messages = parseSessionFile(newContent);

  let conversationId = conversationCache[sessionId];

  // Check for summary title even if no new messages
  if (conversationId) {
    const fullContent = fs.readFileSync(filePath, "utf-8");
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
    try {
      const fullContent = fs.readFileSync(filePath, "utf-8");
      const slug = extractSlug(fullContent);
      const parentMessageUuid = extractParentUuid(fullContent);
      const firstMessageTimestamp = messages[0]?.timestamp;
      const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        sessionId,
        agentType: "claude_code",
        projectPath,
        slug,
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

      const fullContent = fs.readFileSync(filePath, "utf-8");
      const slug = extractSlug(fullContent);
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Conversation not found")) {
        log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
        delete conversationCache[sessionId];
        saveConversationCache(conversationCache);

        const fullContent = fs.readFileSync(filePath, "utf-8");
        const slug = extractSlug(fullContent);
        const firstMessageTimestamp = messages[0]?.timestamp;
        const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

        try {
          conversationId = await syncService.createConversation({
            userId,
            sessionId,
            agentType: "claude_code",
            projectPath,
            slug,
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
}

async function processCursorSession(
  dbPath: string,
  sessionId: string,
  workspacePath: string,
  syncService: SyncService,
  userId: string,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages
): Promise<void> {
  const lastRowId = getPosition(dbPath);

  let result: { messages: ParsedMessage[]; maxRowId: number };
  try {
    result = extractMessagesFromCursorDb(dbPath, lastRowId);
  } catch (err) {
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

      conversationId = await syncService.createConversation({
        userId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Conversation not found")) {
        log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
        delete conversationCache[sessionId];
        saveConversationCache(conversationCache);

        const firstMessageTimestamp = messages[0]?.timestamp;

        try {
          conversationId = await syncService.createConversation({
            userId,
            sessionId,
            agentType: "cursor",
            projectPath: workspacePath,
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

async function main(): Promise<void> {
  ensureConfigDir();
  log("Daemon started");
  log(`PID: ${process.pid}`);
  writeDaemonState(false);

  const config = readConfig();
  if (!config?.user_id) {
    log("No user_id configured. Run 'codecast setup' first.");
    console.error("No user_id configured. Run 'codecast setup' first.");
    process.exit(1);
  }

  const convexUrl = config.convex_url || process.env.CONVEX_URL;
  if (!convexUrl) {
    log("No Convex URL configured.");
    console.error("No Convex URL configured. Set convex_url in config or CONVEX_URL env var.");
    process.exit(1);
  }

  log(`User ID: ${config.user_id}`);
  log(`Convex URL: ${convexUrl}`);
  if (config.auth_token) {
    log(`Auth token: ${maskToken(config.auth_token)}`);
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
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    maxAttempts: 10,
    onLog: log,
  });

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
          titleCache
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
          pendingMessages
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

  const subscriptionClient = syncService.getSubscriptionClient();
  let unsubscribe: (() => void) | null = null;

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
      writeDaemonState(true);
      resetReconnectDelay();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Subscription error: ${errMsg}`);
      writeDaemonState(false);
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

  const shutdown = () => {
    log("Shutting down");
    writeDaemonState(false);
    if (unsubscribe) {
      unsubscribe();
    }
    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Warning: ${pendingOps} operations still pending in retry queue`);
    }
    retryQueue.stop();
    watcher.stop();
    cursorWatcher.stop();
    for (const sync of fileSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorSyncs.values()) {
      sync.stop();
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

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
