#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";

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

  process.on("SIGTERM", () => {
    log("Received SIGTERM, shutting down");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    log("Received SIGINT, shutting down");
    process.exit(0);
  });

  while (true) {
    log("Daemon running...");
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
