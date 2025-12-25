#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { maskToken } from "./redact.js";
import { AuthServer } from "./authServer.js";
import { checkForUpdates, performUpdate, showUpdateNotice, getVersion } from "./update.js";
import { glob } from "glob";
import { getPosition, setPosition } from "./positionTracker.js";
import { parseSessionFile, extractSlug } from "./parser.js";
import { SyncService } from "./syncService.js";
import { hashPath } from "./hash.js";

const program = new Command();

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");

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
  excluded_paths?: string;
  created_at?: string;
  updated_at?: string;
}

interface DetectedAgent {
  name: string;
  type: "claude_code" | "codex" | "cursor";
  configPath: string;
  historyPath: string;
}

interface DaemonState {
  connected?: boolean;
  lastSyncTime?: number;
  pendingQueueSize?: number;
  authExpired?: boolean;
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

const CODECAST_SLASH_COMMAND = `---
description: Get codecast dashboard and share links for current session
allowed-tools: ["Bash"]
---

Run this bash command to get codecast links for the current session:

\`\`\`bash
PROJECT_DIR=$(echo "$PWD" | tr '/' '-')
SESSIONS_DIR="$HOME/.claude/projects/$PROJECT_DIR"
SESSION_FILE=$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | grep -E '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jsonl$' | head -1)

if [ -z "$SESSION_FILE" ]; then
  echo '{"error":"No session found for current project"}'
  exit 0
fi

SESSION_ID=$(basename "$SESSION_FILE" .jsonl)
API_TOKEN=$(grep '"auth_token"' ~/.codecast/config.json | sed 's/.*: *"\\([^"]*\\)".*/\\1/')
CONVEX_URL=$(grep '"convex_url"' ~/.codecast/config.json | sed 's/.*: *"\\([^"]*\\)".*/\\1/')

if [ -z "$API_TOKEN" ] || [ -z "$CONVEX_URL" ]; then
  echo '{"error":"Codecast not configured. Run: codecast auth"}'
  exit 0
fi

SITE_URL=$(echo "$CONVEX_URL" | sed 's/\\.cloud/.site/')
curl -s -X POST "$SITE_URL/cli/session-links" -H "Content-Type: application/json" -d "{\\"session_id\\":\\"$SESSION_ID\\",\\"api_token\\":\\"$API_TOKEN\\"}"
\`\`\`

Parse the JSON and display:
- **Dashboard**: dashboard_url
- **Share**: share_url (public link)
`;

function installSlashCommand(): void {
  const home = process.env.HOME || "";
  const commandsDir = path.join(home, ".claude", "commands");
  const commandFile = path.join(commandsDir, "codecast.md");

  try {
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(commandFile, CODECAST_SLASH_COMMAND);
  } catch {
    // Ignore errors - slash command is optional
  }
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

function readDaemonState(): DaemonState | null {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as DaemonState;
  } catch {
    return null;
  }
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return diffSec === 1 ? "1 second ago" : `${diffSec} seconds ago`;
  } else if (diffMin < 60) {
    return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
  } else if (diffHour < 24) {
    return diffHour === 1 ? "1 hour ago" : `${diffHour} hours ago`;
  } else {
    return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
  }
}

function showStatus(): void {
  const pid = getDaemonPid();
  const config = readConfig();
  const state = readDaemonState();

  console.log("");

  if (state?.authExpired) {
    console.log("  Auth: expired");
    console.log("  Run 'codecast auth' to re-authenticate");
  } else if (config?.auth_token) {
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

    if (state?.lastSyncTime) {
      console.log(`  Last sync: ${formatRelativeTime(state.lastSyncTime)}`);
    } else {
      console.log("  Last sync: never");
    }

    const queueSize = state?.pendingQueueSize ?? 0;
    console.log(`  Pending queue: ${queueSize} items`);
  } else {
    console.log("  Daemon: stopped");
    if (config?.auth_token) {
      console.log("  Run 'codecast start' to start syncing");
    }
  }

  const convexConnected = pid && (state?.connected ?? false);
  console.log(`  Convex: ${convexConnected ? "connected" : "disconnected"}`);

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

    const stateFile = path.join(CONFIG_DIR, "daemon.state");
    if (fs.existsSync(stateFile)) {
      try {
        const currentState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const newState = { ...currentState, authExpired: false };
        fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), { mode: 0o600 });
      } catch {
        // Ignore errors
      }
    }

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

  const stateFile = path.join(CONFIG_DIR, "daemon.state");
  if (fs.existsSync(stateFile)) {
    try {
      const currentState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const newState = { ...currentState, authExpired: false };
      fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), { mode: 0o600 });
    } catch {
      // Ignore errors
    }
  }

  installSlashCommand();

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

async function runSync(): Promise<void> {
  const config = readConfig();

  if (!config?.auth_token || !config?.user_id) {
    console.error("Not authenticated. Run 'codecast auth' first.");
    process.exit(1);
  }

  const projectsPath = path.join(process.env.HOME || "", ".claude", "projects");

  if (!fs.existsSync(projectsPath)) {
    console.log("No Claude Code projects found at:", projectsPath);
    return;
  }

  console.log("\nFinding unsynced conversations...\n");

  const sessionFiles = await glob("**/*.jsonl", {
    cwd: projectsPath,
    absolute: true,
  });

  if (sessionFiles.length === 0) {
    console.log("No session files found.");
    return;
  }

  const unsyncedFiles: Array<{ path: string; size: number; position: number }> = [];

  for (const filePath of sessionFiles) {
    try {
      const stats = fs.statSync(filePath);
      const position = getPosition(filePath);

      if (position < stats.size) {
        unsyncedFiles.push({
          path: filePath,
          size: stats.size,
          position,
        });
      }
    } catch (err) {
      continue;
    }
  }

  if (unsyncedFiles.length === 0) {
    console.log("All conversations are already synced.");
    return;
  }

  console.log(`Syncing ${unsyncedFiles.length} conversations...\n`);

  const syncService = new SyncService({
    convexUrl: config.convex_url || CONVEX_URL,
    authToken: config.auth_token,
    userId: config.user_id,
  });

  let syncedCount = 0;
  let errorCount = 0;

  for (const file of unsyncedFiles) {
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const lines = content.split("\n");
      const newLines = lines.slice(Math.floor(file.position / (file.size / lines.length)));

      if (newLines.length === 0) {
        continue;
      }

      const messages = parseSessionFile(newLines.join("\n"));

      if (messages.length === 0) {
        continue;
      }

      const sessionId = path.basename(file.path, ".jsonl");
      const projectDir = path.basename(path.dirname(file.path));
      const projectPath = projectDir.replace(/-/g, "/");
      const slug = extractSlug(content);

      let conversationId: string | null = null;

      try {
        conversationId = await syncService.createConversation({
          userId: config.user_id!,
          sessionId,
          agentType: "claude_code",
          projectPath,
          slug,
          startedAt: messages[0]?.timestamp || Date.now(),
        });
      } catch (err) {
        const errorMsg = (err as Error).message;
        if (errorMsg.includes("already exists")) {
          continue;
        }
        throw err;
      }

      if (conversationId) {
        for (const msg of messages) {
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
        }
      }

      setPosition(file.path, file.size);
      syncedCount++;

      process.stdout.write(`\rSynced ${syncedCount}/${unsyncedFiles.length} conversations...`);
    } catch (err) {
      errorCount++;
    }
  }

  console.log(`\n\nSync complete!`);
  console.log(`  Synced: ${syncedCount} conversations`);

  if (errorCount > 0) {
    console.log(`  Errors: ${errorCount}`);
  }
}

program
  .name("codecast")
  .description(
    "Sync coding agent conversations to a shared Convex database\n\n" +
    "Quick Start:\n" +
    "  1. codecast auth          # Authenticate with your account\n" +
    "  2. codecast start         # Start background sync daemon\n" +
    "  3. codecast status        # Check sync status"
  )
  .version(getVersion());

program
  .command("auth")
  .description("Authenticate with codecast using browser OAuth flow")
  .action(async () => {
    await runAuth();
  });

program
  .command("login")
  .description(
    "Link this device using a setup token (alternative to browser OAuth)\n\n" +
    "Get your token from: codecast.sh/cli"
  )
  .argument("<token>", "Setup token from the web dashboard")
  .action(async (token: string) => {
    await runLogin(token);
  });

program
  .command("start")
  .description("Start the background daemon to automatically watch and sync conversations")
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
  .description("Show daemon status, connection state, and sync information")
  .action(() => {
    showStatus();
  });

program
  .command("sync")
  .description("Manually sync all unsynced conversations (daemon does this automatically)")
  .action(async () => {
    await runSync();
  });

program
  .command("config")
  .description(
    "View or modify configuration settings\n\n" +
    "Examples:\n" +
    "  codecast config                    # View all configuration\n" +
    "  codecast config excluded_paths     # View specific setting\n" +
    "  codecast config excluded_paths \"**/node_modules/**\"  # Set value"
  )
  .argument("[key]", "Configuration key (auth_token, web_url, user_id, convex_url, team_id, excluded_paths)")
  .argument("[value]", "Value to set for the key")
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
        if (config.excluded_paths) console.log(`  excluded_paths: ${config.excluded_paths}`);
        if (config.created_at) console.log(`  created_at: ${config.created_at}`);
        if (config.updated_at) console.log(`  updated_at: ${config.updated_at}`);
      } else {
        console.log("  (no configuration found - run 'codecast setup')");
      }
      return;
    }

    const settableKeys = ["auth_token", "web_url", "user_id", "convex_url", "team_id", "excluded_paths"] as const;
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
  .description(
    "View daemon logs for troubleshooting\n\n" +
    "Examples:\n" +
    "  codecast logs              # View all logs\n" +
    "  codecast logs -n 50        # View last 50 lines\n" +
    "  codecast logs -f           # Follow logs in real-time"
  )
  .option("-n, --lines <number>", "Number of lines to show (default: all)")
  .option("-f, --follow", "Follow log output in real-time (Ctrl+C to stop)")
  .action((options) => {
    const logFile = path.join(CONFIG_DIR, "daemon.log");

    if (!fs.existsSync(logFile)) {
      console.log("No log file found. Daemon may not have been started yet.");
      console.log(`Expected at: ${logFile}`);
      return;
    }

    if (options.follow) {
      const followLines = options.lines || "50";
      console.log(`Following ${logFile} (Ctrl+C to stop)\n`);
      const tail = spawn("tail", ["-f", "-n", followLines, logFile], {
        stdio: "inherit",
      });

      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });
    } else {
      const content = fs.readFileSync(logFile, "utf-8");
      const allLines = content.trim().split("\n");

      if (options.lines) {
        const lines = parseInt(options.lines, 10);
        const lastLines = allLines.slice(-lines);
        console.log(lastLines.join("\n"));
      } else {
        console.log(allLines.join("\n"));
      }
    }
  });

program
  .command("search")
  .description(
    "Search across all conversations\n\n" +
    "Examples:\n" +
    "  codecast search \"auth implementation\"     # Basic search\n" +
    "  codecast search \"oauth\" -A 2 -B 1         # With context lines\n" +
    "  codecast search \"middleware\" -C 3         # Context before and after\n" +
    "  codecast search \"auth\" --limit 5          # Limit results"
  )
  .argument("<query>", "Search query (min 2 characters)")
  .option("-A, --after <n>", "Show N messages after each match", "0")
  .option("-B, --before <n>", "Show N messages before each match", "0")
  .option("-C, --context <n>", "Show N messages before and after each match")
  .option("-l, --limit <n>", "Maximum number of conversations to return", "10")
  .action(async (query, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const contextBefore = options.context ? parseInt(options.context) : parseInt(options.before);
    const contextAfter = options.context ? parseInt(options.context) : parseInt(options.after);
    const limit = parseInt(options.limit);

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    try {
      const response = await fetch(`${siteUrl}/cli/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          query,
          limit,
          context_before: contextBefore,
          context_after: contextAfter,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatSearchResults } = await import("./formatter.js");
      console.log(formatSearchResults(result));
    } catch (error) {
      console.error("Search failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("read")
  .description(
    "Read messages from a conversation\n\n" +
    "Examples:\n" +
    "  codecast read jx70ntf                   # Read all messages\n" +
    "  codecast read jx70ntf 12:20             # Read messages 12-20\n" +
    "  codecast read jx70ntf 12:               # Read from message 12 to end\n" +
    "  codecast read jx70ntf :20               # Read first 20 messages\n" +
    "  codecast read jx70ntf 15                # Read single message 15"
  )
  .argument("<conversation-id>", "Conversation ID (can be truncated)")
  .argument("[range]", "Message range (e.g., 12:20, 12:, :20, 15)")
  .action(async (conversationId, range) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    let startLine: number | undefined;
    let endLine: number | undefined;

    if (range) {
      if (range.includes(":")) {
        const [start, end] = range.split(":");
        if (start) startLine = parseInt(start);
        if (end) endLine = parseInt(end);
      } else {
        startLine = parseInt(range);
        endLine = parseInt(range);
      }
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    try {
      const response = await fetch(`${siteUrl}/cli/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          conversation_id: conversationId,
          start_line: startLine,
          end_line: endLine,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatReadResult } = await import("./formatter.js");
      console.log(formatReadResult(result));
    } catch (error) {
      console.error("Read failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("private")
  .description(
    "Manage private conversations (hidden from team view)\n\n" +
    "Examples:\n" +
    "  codecast private --list                  # List private conversations\n" +
    "  codecast private <session-id>            # Mark as private\n" +
    "  codecast private <session-id> --remove   # Make visible to team"
  )
  .argument("[session-id]", "Session ID to mark as private/public")
  .option("--list", "List all private conversations")
  .option("--remove", "Remove private flag (make visible to team)")
  .action(async (sessionId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.user_id) {
      console.error("Not authenticated. Run 'codecast auth' first.");
      process.exit(1);
    }

    const convexUrl = config.convex_url || CONVEX_URL;

    if (options.list) {
      try {
        const { ConvexHttpClient } = await import("convex/browser");
        const client = new ConvexHttpClient(convexUrl);

        const conversations = await client.query("conversations:listPrivateConversations" as any, {
          api_token: config.auth_token,
        });

        if (conversations.length === 0) {
          console.log("\nNo private conversations found.");
          console.log("Mark conversations as private using: codecast private <session-id>");
        } else {
          console.log(`\nPrivate conversations (${conversations.length}):\n`);
          for (const conv of conversations) {
            const date = new Date(conv.updated_at).toLocaleDateString();
            console.log(`  ${conv.session_id}`);
            console.log(`    Title: ${conv.title}`);
            console.log(`    Updated: ${date}`);
            console.log(`    Messages: ${conv.message_count}`);
            if (conv.project_path) {
              console.log(`    Project: ${conv.project_path}`);
            }
            console.log();
          }
        }
      } catch (err) {
        console.error("Failed to list private conversations:", (err as Error).message);
        process.exit(1);
      }
      return;
    }

    if (!sessionId) {
      console.error("Session ID is required");
      console.log("Usage: codecast private <session-id>");
      process.exit(1);
    }

    try {
      const { ConvexHttpClient } = await import("convex/browser");
      const client = new ConvexHttpClient(convexUrl);

      await client.mutation("conversations:setPrivacyBySessionId" as any, {
        session_id: sessionId,
        is_private: options.remove ? false : true,
        api_token: config.auth_token,
      });

      if (options.remove) {
        console.log(`Removed private flag from conversation: ${sessionId}`);
        console.log("This conversation will now appear in team view");
      } else {
        console.log(`Marked conversation as private: ${sessionId}`);
        console.log("This conversation will no longer appear in team view");
      }
    } catch (err) {
      console.error("Failed to update conversation:", (err as Error).message);
      process.exit(1);
    }
  });

function getExecutableInfo(): { executablePath: string; args: string[] } {
  const isBundle = __filename.includes("/dist/") || __filename.includes("/build/");
  const isBinary = !__filename.endsWith(".ts") && !__filename.endsWith(".js");

  if (isBinary) {
    return { executablePath: process.argv[0], args: ["_daemon"] };
  } else if (isBundle) {
    return { executablePath: process.execPath, args: [path.resolve(__dirname, "daemon.js")] };
  } else {
    return { executablePath: process.execPath, args: [path.resolve(__dirname, "daemon.ts")] };
  }
}

function setupMacOS(disable: boolean): void {
  const home = process.env.HOME;
  if (!home) {
    console.error("HOME environment variable not set");
    process.exit(1);
  }

  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, "sh.codecast.daemon.plist");

  if (disable) {
    if (!fs.existsSync(plistPath)) {
      console.log("Auto-start is not enabled");
      return;
    }
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
    fs.unlinkSync(plistPath);
    console.log("Auto-start disabled");
    console.log(`Removed: ${plistPath}`);
    return;
  }

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const { executablePath, args } = getExecutableInfo();
  const programArgs = [executablePath, ...args]
    .map((arg) => `    <string>${arg}</string>`)
    .join("\n");

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/launchd.err.log</string>
</dict>
</plist>
`;

  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });

  fs.writeFileSync(plistPath, plistContent, { mode: 0o644 });
  console.log("Auto-start enabled");
  console.log(`LaunchAgent created: ${plistPath}`);
  console.log(`Command: ${executablePath} ${args.join(" ")}`);

  const result = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
  if (result.status === 0) {
    console.log("\nLaunchAgent loaded successfully");
  } else {
    console.log("\nNote: LaunchAgent will start on next login");
    console.log("Or manually load with: launchctl bootstrap gui/$(id -u) " + plistPath);
  }
}

function setupLinux(disable: boolean): void {
  const home = process.env.HOME;
  if (!home) {
    console.error("HOME environment variable not set");
    process.exit(1);
  }

  const systemdUserDir = path.join(home, ".config", "systemd", "user");
  const servicePath = path.join(systemdUserDir, "codecast.service");

  if (disable) {
    if (!fs.existsSync(servicePath)) {
      console.log("Auto-start is not enabled");
      return;
    }
    spawnSync("systemctl", ["--user", "disable", "--now", "codecast.service"], { stdio: "inherit" });
    fs.unlinkSync(servicePath);
    console.log("Auto-start disabled");
    console.log(`Removed: ${servicePath}`);
    return;
  }

  if (!fs.existsSync(systemdUserDir)) {
    fs.mkdirSync(systemdUserDir, { recursive: true });
  }

  const { executablePath, args } = getExecutableInfo();
  const execStart = [executablePath, ...args].join(" ");

  const serviceContent = `[Unit]
Description=Codecast Sync Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
Environment=HOME=${home}

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(servicePath, serviceContent, { mode: 0o644 });
  console.log("Auto-start enabled");
  console.log(`Systemd service created: ${servicePath}`);
  console.log(`Command: ${execStart}`);

  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const result = spawnSync("systemctl", ["--user", "enable", "--now", "codecast.service"], { stdio: "inherit" });
  if (result.status === 0) {
    console.log("\nSystemd service enabled and started");
    console.log("Check status with: systemctl --user status codecast");
  } else {
    console.log("\nNote: Run these commands to enable:");
    console.log("  systemctl --user daemon-reload");
    console.log("  systemctl --user enable --now codecast.service");
  }
}

function setupWindows(disable: boolean): void {
  const taskName = "CodecastDaemon";

  if (disable) {
    const result = spawnSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { stdio: "inherit" });
    if (result.status === 0) {
      console.log("Auto-start disabled");
    } else {
      console.log("Auto-start is not enabled or could not be disabled");
    }
    return;
  }

  const { executablePath, args } = getExecutableInfo();
  const fullCommand = [executablePath, ...args].join(" ");

  const result = spawnSync("schtasks", [
    "/Create",
    "/TN", taskName,
    "/TR", fullCommand,
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/F"
  ], { stdio: "inherit" });

  if (result.status === 0) {
    console.log("Auto-start enabled");
    console.log(`Task Scheduler task created: ${taskName}`);
    console.log(`Command: ${fullCommand}`);
    console.log("\nThe daemon will start automatically on login");
    console.log("To start now, run: codecast start");
  } else {
    console.error("Failed to create scheduled task");
    console.log("\nManual setup:");
    console.log("1. Open Task Scheduler (taskschd.msc)");
    console.log("2. Create a new task that runs on login");
    console.log(`3. Set the action to: ${fullCommand}`);
  }
}

program
  .command("setup")
  .description(
    "Configure daemon to start automatically on login\n\n" +
    "Supported platforms:\n" +
    "  - macOS: LaunchAgent\n" +
    "  - Linux: systemd user service\n" +
    "  - Windows: Task Scheduler\n\n" +
    "Examples:\n" +
    "  codecast setup             # Enable auto-start\n" +
    "  codecast setup --disable   # Disable auto-start"
  )
  .option("--disable", "Disable auto-start on login")
  .action((options) => {
    switch (process.platform) {
      case "darwin":
        setupMacOS(options.disable);
        break;
      case "linux":
        setupLinux(options.disable);
        break;
      case "win32":
        setupWindows(options.disable);
        break;
      default:
        console.error(`Unsupported platform: ${process.platform}`);
        console.log("Supported: macOS, Linux, Windows");
        process.exit(1);
    }
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
