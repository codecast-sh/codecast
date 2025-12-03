#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { HistoryWatcher, type FileChangeEvent } from "./watcher.js";

const CONFIG_DIR = process.env.HOME + "/.code-chat-sync";
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");

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
