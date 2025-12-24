#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { maskToken } from "./redact.js";
import { AuthServer } from "./authServer.js";
import { checkForUpdates, performUpdate, showUpdateNotice, getVersion } from "./update.js";

const program = new Command();

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_URL = process.env.CODE_CHAT_SYNC_WEB_URL || "https://codecast.sh";
const CONVEX_URL = process.env.CONVEX_URL || "https://marvelous-meerkat-539.convex.cloud";

interface Config {
  auth_token?: string;
  user_id?: string;
  convex_url?: string;
  web_url?: string;
  team_id?: string;
  created_at?: string;
  updated_at?: string;
}

interface DetectedAgent {
  name: string;
  type: "claude_code" | "codex" | "cursor";
  configPath: string;
  historyPath: string;
}

function detectAgents(): DetectedAgent[] {
  const agents: DetectedAgent[] = [];
  const home = process.env.HOME || "";

  const claudePath = path.join(home, ".claude");
  if (fs.existsSync(claudePath)) {
    agents.push({
      name: "Claude Code",
      type: "claude_code",
      configPath: claudePath,
      historyPath: path.join(claudePath, "projects"),
    });
  }

  const codexPath = path.join(home, ".codex");
  if (fs.existsSync(codexPath)) {
    agents.push({
      name: "Codex CLI",
      type: "codex",
      configPath: codexPath,
      historyPath: path.join(codexPath, "history"),
    });
  }

  const cursorPath = path.join(home, ".cursor");
  if (fs.existsSync(cursorPath)) {
    agents.push({
      name: "Cursor",
      type: "cursor",
      configPath: cursorPath,
      historyPath: path.join(cursorPath, "history"),
    });
  }

  return agents;
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
  const content = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(content) as Config;
}

function writeConfig(config: Config): void {
  ensureConfigDir();
  config.updated_at = new Date().toISOString();
  if (!config.created_at) {
    config.created_at = config.updated_at;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

function getDaemonPid(): number | null {
  if (!fs.existsSync(PID_FILE)) {
    return null;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.unlinkSync(PID_FILE);
    return null;
  }
}

function isDaemonRunning(): boolean {
  return getDaemonPid() !== null;
}

function showStatus(): void {
  const pid = getDaemonPid();
  const config = readConfig();

  console.log("");

  if (config?.auth_token) {
    console.log("  Auth: authenticated");
    if (config.user_id) {
      console.log(`  User: ${config.user_id}`);
    }
  } else {
    console.log("  Auth: not authenticated");
    console.log("  Run 'codecast auth' to authenticate");
  }

  console.log("");

  if (pid) {
    console.log(`  Daemon: running (PID: ${pid})`);
  } else {
    console.log("  Daemon: stopped");
    if (config?.auth_token) {
      console.log("  Run 'codecast start' to start syncing");
    }
  }

  console.log("");
}

function stopDaemon(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log("Daemon is not running (no PID file)");
    return;
  }

  const pidStr = fs.readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    console.log("Invalid PID file, removing it");
    fs.unlinkSync(PID_FILE);
    return;
  }

  try {
    process.kill(pid, 0);
  } catch {
    console.log("Daemon is not running (process not found)");
    fs.unlinkSync(PID_FILE);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(PID_FILE);
    console.log("Daemon stopped");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ESRCH") {
      console.log("Daemon already stopped");
      fs.unlinkSync(PID_FILE);
    } else {
      console.error(`Failed to stop daemon: ${error.message}`);
      process.exit(1);
    }
  }
}

function startDaemon(): void {
  ensureConfigDir();

  if (isDaemonRunning()) {
    const pid = fs.readFileSync(PID_FILE, "utf-8").trim();
    console.log(`Daemon is already running (PID: ${pid})`);
    return;
  }

  let child;
  const daemonTsPath = path.join(__dirname, "daemon.ts");
  const daemonJsPath = path.join(__dirname, "daemon.js");

  if (fs.existsSync(daemonTsPath)) {
    // Dev mode: run daemon.ts with bun
    child = spawn(process.execPath, [daemonTsPath], {
      detached: true,
      stdio: "ignore",
    });
  } else if (fs.existsSync(daemonJsPath)) {
    // Built JS mode: run daemon.js
    child = spawn(process.execPath, [daemonJsPath], {
      detached: true,
      stdio: "ignore",
    });
  } else {
    // Binary mode: spawn self with _daemon command
    child = spawn(process.argv[0], ["_daemon"], {
      detached: true,
      stdio: "ignore",
    });
  }

  child.unref();

  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
    console.log("Daemon started");
  } else {
    console.error("Failed to start daemon");
    process.exit(1);
  }
}

function getDeviceName(): string {
  const os = process.platform;
  const hostname = require("os").hostname();
  const platformName = os === "darwin" ? "macOS" : os === "win32" ? "Windows" : "Linux";
  return `${platformName} - ${hostname}`;
}

async function runLogin(setupToken: string): Promise<void> {
  console.log("\n=== codecast Login ===\n");
  console.log("Exchanging setup token...\n");

  try {
    const response = await fetch(`${CONVEX_URL.replace(".cloud", ".site")}/cli/exchange-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: setupToken }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 401) {
        console.error("Invalid or expired token.");
        console.error("Generate a new token at: codecast.sh/cli");
      } else {
        console.error(`Error: ${error.error || response.statusText}`);
      }
      process.exit(1);
    }

    const result = await response.json();

    const existingConfig = readConfig();
    const config: Config = {
      ...existingConfig,
      user_id: result.user_id,
      auth_token: result.auth_token,
      convex_url: result.convex_url || CONVEX_URL,
      web_url: WEB_URL,
    };

    writeConfig(config);

    console.log("Linked successfully!\n");
    console.log(`User ID: ${config.user_id}`);
    console.log(`API Token: ${maskToken(config.auth_token || "")}`);
    console.log(`Config: ${CONFIG_FILE}\n`);

    if (!isDaemonRunning()) {
      console.log("Starting daemon...");
      startDaemon();
    }

    console.log("\nStatus:");
    showStatus();
  } catch (err) {
    console.error("Failed to connect to server:", (err as Error).message);
    process.exit(1);
  }
}

async function runAuth(): Promise<void> {
  console.log("\n=== codecast Authentication ===\n");

  const agents = detectAgents();
  if (agents.length > 0) {
    console.log("Detected coding agents:");
    for (const agent of agents) {
      console.log(`  - ${agent.name}`);
    }
    console.log();
  }

  console.log("Opening browser for authentication...\n");

  const authServer = new AuthServer({ port: 42424, timeout: 300000 });
  const nonce = authServer.getNonce();
  const port = authServer.getPort();
  const deviceName = encodeURIComponent(getDeviceName());

  const cliUrl = `${WEB_URL}/auth/cli?nonce=${nonce}&port=${port}&device=${deviceName}`;

  console.log(`If the browser doesn't open, visit:\n  ${cliUrl}\n`);

  try {
    await open(cliUrl);
  } catch {
    console.log("Could not open browser automatically.");
  }

  console.log("Waiting for authentication...\n");

  const authResult = await authServer.start();

  if (!authResult || !authResult.apiToken) {
    console.error("\nAuthentication failed or timed out.");
    console.error("Please try again with 'codecast auth'");
    process.exit(1);
  }

  const existingConfig = readConfig();
  const config: Config = {
    ...existingConfig,
    user_id: authResult.userId,
    auth_token: authResult.apiToken,
    convex_url: CONVEX_URL,
    web_url: WEB_URL,
  };

  writeConfig(config);

  console.log("Authenticated successfully!\n");
  console.log(`User ID: ${config.user_id}`);
  console.log(`API Token: ${maskToken(config.auth_token || "")}`);
  console.log(`Config: ${CONFIG_FILE}\n`);

  if (!isDaemonRunning()) {
    console.log("Starting daemon...");
    startDaemon();
  }

  console.log("\nStatus:");
  showStatus();
}

program
  .name("codecast")
  .description("Sync coding agent conversations to a shared Convex database")
  .version(getVersion());

program
  .command("auth")
  .description("Authenticate with codecast (opens browser)")
  .action(async () => {
    await runAuth();
  });

program
  .command("login")
  .description("Link this device using a setup token from codecast.sh/cli")
  .argument("<token>", "Setup token from the web dashboard")
  .action(async (token: string) => {
    await runLogin(token);
  });

program
  .command("start")
  .description("Start the background daemon to watch and sync conversations")
  .action(() => {
    startDaemon();
  });

program
  .command("stop")
  .description("Stop the background daemon")
  .action(() => {
    stopDaemon();
  });

program
  .command("status")
  .description("Show daemon status and sync information")
  .action(() => {
    showStatus();
  });

program
  .command("sync")
  .description("Manually sync all unsynced conversations")
  .action(() => {
    console.log("Sync command - not yet implemented");
  });

program
  .command("config")
  .description("View or modify configuration")
  .argument("[key]", "Configuration key to get or set")
  .argument("[value]", "Value to set")
  .action((key, value) => {
    const config = readConfig();

    if (!key) {
      console.log("Configuration:");
      console.log(`  Path: ${CONFIG_FILE}`);
      if (config) {
        if (config.user_id) console.log(`  user_id: ${config.user_id}`);
        if (config.convex_url) console.log(`  convex_url: ${config.convex_url}`);
        if (config.team_id) console.log(`  team_id: ${config.team_id}`);
        if (config.auth_token) console.log(`  auth_token: ${maskToken(config.auth_token)}`);
        console.log(`  web_url: ${config.web_url || WEB_URL}`);
        if (config.created_at) console.log(`  created_at: ${config.created_at}`);
        if (config.updated_at) console.log(`  updated_at: ${config.updated_at}`);
      } else {
        console.log("  (no configuration found - run 'codecast setup')");
      }
      return;
    }

    const settableKeys = ["auth_token", "web_url", "user_id", "convex_url", "team_id"] as const;
    const sensitiveKeys = ["auth_token"];
    type SettableKey = (typeof settableKeys)[number];

    if (!settableKeys.includes(key as SettableKey)) {
      console.error(`Unknown config key: ${key}`);
      console.log(`Valid keys: ${settableKeys.join(", ")}`);
      process.exit(1);
    }

    const configKey = key as SettableKey;
    const currentValue = config?.[configKey];

    if (value === undefined) {
      const displayValue = sensitiveKeys.includes(configKey)
        ? maskToken(currentValue)
        : currentValue || "(not set)";
      console.log(`${configKey}: ${displayValue}`);
      return;
    }

    const newConfig: Config = config || {};
    newConfig[configKey] = value;
    writeConfig(newConfig);

    const displayValue = sensitiveKeys.includes(configKey) ? maskToken(value) : value;
    console.log(`Updated ${configKey}: ${displayValue}`);
  });

program
  .command("logs")
  .description("View daemon logs")
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output (like tail -f)")
  .action((options) => {
    const logFile = path.join(CONFIG_DIR, "daemon.log");

    if (!fs.existsSync(logFile)) {
      console.log("No log file found. Daemon may not have been started yet.");
      console.log(`Expected at: ${logFile}`);
      return;
    }

    if (options.follow) {
      console.log(`Following ${logFile} (Ctrl+C to stop)\n`);
      const tail = spawn("tail", ["-f", "-n", options.lines, logFile], {
        stdio: "inherit",
      });

      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });
    } else {
      const lines = parseInt(options.lines, 10);
      const content = fs.readFileSync(logFile, "utf-8");
      const allLines = content.trim().split("\n");
      const lastLines = allLines.slice(-lines);
      console.log(lastLines.join("\n"));
    }
  });

program
  .command("private")
  .description("Manage private conversations")
  .argument("[session-id]", "Session ID to mark as private")
  .option("--list", "List all private conversations")
  .option("--remove", "Remove private flag from conversation")
  .action((sessionId, options) => {
    console.log("Private command - not yet implemented");
  });

program
  .command("update")
  .description("Update codecast to the latest version")
  .action(async () => {
    const available = await checkForUpdates(true);
    if (!available) {
      console.log(`codecast v${getVersion()} is already the latest version`);
      return;
    }
    console.log(`Updating from v${getVersion()} to v${available}...`);
    const success = await performUpdate();
    if (success) {
      console.log("\nRestart codecast to use the new version");
    } else {
      process.exit(1);
    }
  });

program
  .command("_daemon", { hidden: true })
  .description("Run as daemon (internal use)")
  .action(async () => {
    const { runDaemon } = await import("./daemon.js");
    await runDaemon();
  });

// Check for updates in background (non-blocking)
checkForUpdates().then((available) => {
  if (available) {
    showUpdateNotice(available);
  }
});

program.parse();
