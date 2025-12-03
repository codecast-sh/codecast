#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const program = new Command();

const CONFIG_DIR = process.env.HOME + "/.code-chat-sync";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_URL = process.env.CODE_CHAT_SYNC_WEB_URL || "http://localhost:3000";

interface Config {
  auth_token: string;
  web_url?: string;
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

  if (pid) {
    console.log(`Daemon: running (PID: ${pid})`);
  } else {
    console.log("Daemon: stopped");
  }

  console.log(`Config: ${CONFIG_FILE}`);

  if (config) {
    const authStatus = config.auth_token ? "configured" : "not configured";
    console.log(`Auth: ${authStatus}`);
    console.log(`Web URL: ${config.web_url || WEB_URL}`);
  } else {
    console.log("Auth: not configured");
    console.log(`Web URL: ${WEB_URL}`);
  }
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

  const daemonPath = path.join(__dirname, "daemon.js");
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
    console.log("Daemon started");
  } else {
    console.error("Failed to start daemon");
    process.exit(1);
  }
}

async function promptForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function runSetup(): Promise<void> {
  console.log("\n=== code-chat-sync Setup ===\n");

  const agents = detectAgents();
  if (agents.length > 0) {
    console.log("Detected coding agents:");
    for (const agent of agents) {
      console.log(`  - ${agent.name}`);
      console.log(`    Config: ${agent.configPath}`);
      console.log(`    History: ${agent.historyPath}`);
    }
    console.log();
  } else {
    console.log("No coding agents detected.");
    console.log("Supported agents: Claude Code (~/.claude), Codex CLI (~/.codex), Cursor (~/.cursor)\n");
  }

  console.log("To use code-chat-sync, you need to authenticate with your account.");
  console.log("This will open a browser window where you can sign in or create an account.\n");

  const loginUrl = `${WEB_URL}/login?cli=true`;

  console.log("Opening browser for authentication...");
  console.log(`\nIf the browser doesn't open, visit this URL manually:\n  ${loginUrl}\n`);

  try {
    await open(loginUrl);
  } catch {
    console.log("Could not open browser automatically.");
    console.log(`Please visit: ${loginUrl}\n`);
  }

  await promptForEnter("Press Enter after you've completed authentication in the browser...");

  const placeholderToken = `cli_setup_${Date.now()}`;
  const config: Config = {
    auth_token: placeholderToken,
    web_url: WEB_URL,
  };
  writeConfig(config);

  console.log("\nAuthentication flow completed.");
  console.log(`Configuration stored in: ${CONFIG_FILE}`);
  console.log("\nNext steps:");
  console.log("  1. Run 'code-chat-sync start' to begin syncing conversations");
  console.log("  2. Visit the web dashboard to view your synced conversations\n");
}

program
  .name("code-chat-sync")
  .description("Sync coding agent conversations to a shared Convex database")
  .version("0.1.0");

program
  .command("setup")
  .description("Configure code-chat-sync with authentication and team settings")
  .action(async () => {
    await runSetup();
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
    console.log("Config command - not yet implemented");
  });

program
  .command("logs")
  .description("View daemon logs")
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .action((options) => {
    console.log("Logs command - not yet implemented");
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

program.parse();
