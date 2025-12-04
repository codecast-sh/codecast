#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { HistoryWatcher, type FileChangeEvent } from "./watcher.js";
import { maskToken } from "./redact.js";

const CONFIG_DIR = process.env.HOME + "/.code-chat-sync";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");

interface Config {
  auth_token: string;
  web_url?: string;
}

function readConfig(): Config | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  const content = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(content) as Config;
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

async function main(): Promise<void> {
  ensureConfigDir();
  log("Daemon started");
  log(`PID: ${process.pid}`);

  const config = readConfig();
  if (config) {
    log(`Config loaded: auth_token=${maskToken(config.auth_token)}, web_url=${config.web_url || "(default)"}`);
  } else {
    log("No config found - run 'code-chat-sync setup'");
  }

  const watcher = new HistoryWatcher();

  watcher.on("ready", () => {
    log(`Watching: ${watcher.getHistoryPath()}`);
  });

  watcher.on("change", (event: FileChangeEvent) => {
    log(`File ${event.eventType}: ${event.filePath}`);
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
