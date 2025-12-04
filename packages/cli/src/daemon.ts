#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { parseSessionFile, type ParsedMessage } from "./parser.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { SyncService } from "./syncService.js";
import { redactSecrets } from "./redact.js";

const CONFIG_DIR = process.env.HOME + "/.code-chat-sync";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");

interface Config {
  user_id?: string;
  convex_url?: string;
}

interface ConversationCache {
  [sessionId: string]: string;
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
  syncService: SyncService,
  userId: string,
  conversationCache: ConversationCache
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
      conversationId = await syncService.createConversation({
        userId,
        sessionId,
        agentType: "claude_code",
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for session ${sessionId}`);
    } catch (err) {
      log(`Failed to create conversation: ${err}`);
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
      log(`Failed to add message: ${err}`);
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
    log("No user_id configured. Run 'code-chat-sync setup' first.");
    console.error("No user_id configured. Run 'code-chat-sync setup' first.");
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

  const syncService = new SyncService({ convexUrl });
  const conversationCache = readConversationCache();
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
        syncService,
        config.user_id!,
        conversationCache
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
