#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { parseSessionFile, extractSlug, type ParsedMessage } from "./parser.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { SyncService } from "./syncService.js";
import { redactSecrets, maskToken } from "./redact.js";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");

interface Config {
  user_id?: string;
  convex_url?: string;
  auth_token?: string;
}

interface ConversationCache {
  [sessionId: string]: string;
}

interface PendingMessages {
  [sessionId: string]: Array<{
    role: "human" | "assistant";
    content: string;
    timestamp: number;
    filePath: string;
    fileSize: number;
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

async function processSessionFile(
  filePath: string,
  sessionId: string,
  projectPath: string,
  syncService: SyncService,
  userId: string,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages
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

  if (messages.length === 0) {
    setPosition(filePath, stats.size);
    return;
  }

  let conversationId = conversationCache[sessionId];

  if (!conversationId) {
    try {
      const fullContent = fs.readFileSync(filePath, "utf-8");
      const slug = extractSlug(fullContent);

      conversationId = await syncService.createConversation({
        userId,
        sessionId,
        agentType: "claude_code",
        projectPath,
        slug,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for session ${sessionId}`);

      if (pendingMessages[sessionId]) {
        for (const msg of pendingMessages[sessionId]) {
          try {
            await syncService.addMessage({
              conversationId,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to add pending message, queueing for retry: ${errMsg}`);
            retryQueue.add("addMessage", {
              conversationId,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
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
          role: msg.role === "user" ? "human" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          filePath,
          fileSize: stats.size,
        });
      }

      const fullContent = fs.readFileSync(filePath, "utf-8");
      const slug = extractSlug(fullContent);

      retryQueue.add("createConversation", {
        userId,
        sessionId,
        agentType: "claude_code",
        projectPath,
        slug,
      }, errMsg);

      setPosition(filePath, stats.size);
      return;
    }
  }

  for (const msg of messages) {
    try {
      await syncService.addMessage({
        conversationId,
        role: msg.role === "user" ? "human" : "assistant",
        content: redactSecrets(msg.content),
        timestamp: msg.timestamp,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to add message, queueing for retry: ${errMsg}`);
      retryQueue.add("addMessage", {
        conversationId,
        role: msg.role === "user" ? "human" : "assistant",
        content: redactSecrets(msg.content),
        timestamp: msg.timestamp,
      }, errMsg);
    }
  }

  setPosition(filePath, stats.size);
  log(`Synced ${messages.length} messages for session ${sessionId}`);
}

async function main(): Promise<void> {
  ensureConfigDir();
  log("Daemon started");
  log(`PID: ${process.pid}`);

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
    userId: config.user_id,
  });
  const conversationCache = readConversationCache();
  const pendingMessages: PendingMessages = {};

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
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to add pending message during retry: ${errMsg}`);
            retryQueue.add("addMessage", {
              conversationId,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
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
        role: "human" | "assistant";
        content: string;
        timestamp: number;
      };
      await syncService.addMessage(params);
      return true;
    }

    return false;
  });

  const watcher = new SessionWatcher();

  watcher.on("ready", () => {
    log("Session watcher ready");
  });

  watcher.on("session", async (event: SessionEvent) => {
    log(`Session ${event.eventType}: ${event.sessionId} (${event.filePath})`);
    try {
      await processSessionFile(
        event.filePath,
        event.sessionId,
        event.projectPath,
        syncService,
        config.user_id!,
        conversationCache,
        retryQueue,
        pendingMessages
      );
    } catch (err) {
      log(`Error processing session: ${err}`);
    }
  });

  watcher.on("error", (error: Error) => {
    log(`Watcher error: ${error.message}`);
  });

  watcher.start();

  const shutdown = () => {
    log("Shutting down");
    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Warning: ${pendingOps} operations still pending in retry queue`);
    }
    retryQueue.stop();
    watcher.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await new Promise(() => {});
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
