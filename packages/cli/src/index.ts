#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, spawnSync, execSync } from "child_process";
import { fileURLToPath } from "url";
import { maskToken } from "./redact.js";
import { AuthServer } from "./authServer.js";
import { c, fmt, icons } from "./colors.js";
import { checkForUpdates, performUpdate, showUpdateNotice, getVersion, getMemoryVersion } from "./update.js";
import { glob } from "glob";
import { getPosition, setPosition } from "./positionTracker.js";
import { getAllSyncRecords, findUnsyncedFiles } from "./syncLedger.js";
import { getLastReconciliation, performReconciliation, repairDiscrepancies } from "./reconciliation.js";
import { parseSessionFile, extractSlug } from "./parser.js";
import { SyncService } from "./syncService.js";
import {
  fetchExport,
  generateClaudeCodeJsonl,
  generateCodexJsonl,
  writeClaudeCodeSession,
  writeCodexSession,
  estimateClaudeImportTokens,
  chooseClaudeTailMessagesForTokenBudget,
} from "./jsonlGenerator.js";
import Anthropic from "@anthropic-ai/sdk";
import { checkbox, confirm, select } from "@inquirer/prompts";

const program = new Command();

// Get the real cwd - CODECAST_CWD is set by the dev wrapper script
// to preserve the original directory when running via bun run
function getRealCwd(): string {
  return process.env.CODECAST_CWD || process.cwd();
}

function truncatePath(p: string | null, maxLen: number = 38): string {
  if (!p) return "";
  const home = process.env.HOME || "";
  if (home && p.startsWith(home)) {
    p = "~" + p.slice(home.length);
  }
  if (p.length > maxLen) {
    const parts = p.split("/");
    if (parts.length > 3) {
      const prefix = parts[0];
      const suffix = parts.slice(-2).join("/");
      if ((prefix + "/.../" + suffix).length <= maxLen) {
        return prefix + "/.../" + suffix;
      }
      return ".../" + suffix;
    }
  }
  return p;
}

/**
 * Finds the session ID for the current Claude Code process by:
 * 1. Walking up process tree to find parent Claude process
 * 2. If Claude has --resume flag, extract session ID from it
 * 3. Otherwise, find session file matching Claude's start time
 */
function findCurrentSessionFromProcess(projectRoot: string): string | null {
  const debug = !!process.env.DEBUG;
  try {
    // Walk up process tree to find Claude parent
    let pid = process.ppid;
    let claudePid: number | null = null;
    let claudeArgs: string | null = null;

    if (debug) console.error(`[DEBUG] Starting process walk from ppid: ${pid}`);

    while (pid > 1) {
      try {
        const result = execSync(`ps -o ppid=,args= -p ${pid}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();

        const match = result.match(/^\s*(\d+)\s+(.*)$/);
        if (!match) {
          if (debug) console.error(`[DEBUG] No match for pid ${pid}, breaking`);
          break;
        }

        const ppid = parseInt(match[1]);
        const args = match[2];

        if (debug) console.error(`[DEBUG] PID ${pid}: ${args.slice(0, 60)}...`);

        if (args.includes("claude")) {
          claudePid = pid;
          claudeArgs = args;
          if (debug) console.error(`[DEBUG] Found Claude at PID ${pid}`);
          break;
        }

        pid = ppid;
      } catch (e) {
        if (debug) console.error(`[DEBUG] Error walking process tree: ${e}`);
        break;
      }
    }

    if (!claudePid || !claudeArgs) {
      if (debug) console.error(`[DEBUG] Could not find Claude process`);
      return null;
    }

    // Check if Claude was started with --resume <session_id>
    const resumeMatch = claudeArgs.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (resumeMatch) {
      return resumeMatch[1];
    }

    // Get Claude process start time
    const startTimeResult = execSync(`ps -o lstart= -p ${claudePid}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const claudeStartTime = new Date(startTimeResult).getTime();

    if (debug) console.error(`[DEBUG] Claude start time: ${startTimeResult} (${claudeStartTime})`);

    // Find session file with matching creation time
    const projectDir = projectRoot.replace(/\//g, "-");
    const sessionsDir = path.join(process.env.HOME || "", ".claude", "projects", projectDir);

    if (debug) console.error(`[DEBUG] Sessions dir: ${sessionsDir}`);

    if (!fs.existsSync(sessionsDir)) {
      if (debug) console.error(`[DEBUG] Sessions dir does not exist`);
      return null;
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
    const sessionFiles = fs.readdirSync(sessionsDir)
      .filter(f => uuidPattern.test(f))
      .map(f => {
        const filePath = path.join(sessionsDir, f);
        const stats = fs.statSync(filePath);
        // Read first line to get session start timestamp
        let firstTimestamp: number | null = null;
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const firstLine = content.split("\n")[0];
          if (firstLine) {
            const entry = JSON.parse(firstLine);
            // Try various timestamp formats
            if (entry.timestamp && typeof entry.timestamp === "number") {
              firstTimestamp = entry.timestamp;
            } else if (entry.snapshot?.timestamp) {
              firstTimestamp = new Date(entry.snapshot.timestamp).getTime();
            }
          }
        } catch {
          // Use birthtime as fallback
        }
        // Always fallback to birthtime if we couldn't parse timestamp
        if (!firstTimestamp) {
          firstTimestamp = stats.birthtime.getTime();
        }
        return {
          id: path.basename(f, ".jsonl"),
          firstTimestamp,
          birthtime: stats.birthtime.getTime(),
        };
      });

    // Find session that started closest to (and just after) Claude process start
    // Allow 30 second window for process startup
    const tolerance = 30000;

    if (debug) {
      console.error(`[DEBUG] Total session files: ${sessionFiles.length}`);
      // Show the 5 most recent sessions by timestamp
      const recentSessions = [...sessionFiles].sort((a, b) => b.firstTimestamp! - a.firstTimestamp!).slice(0, 5);
      for (const s of recentSessions) {
        const diff = s.firstTimestamp! - claudeStartTime;
        console.error(`[DEBUG] Session ${s.id.slice(0, 8)}: ts=${s.firstTimestamp} diff=${diff}ms`);
      }
    }

    const candidates = sessionFiles.filter(f =>
      f.firstTimestamp! >= claudeStartTime - tolerance &&
      f.firstTimestamp! <= claudeStartTime + tolerance * 2
    );

    if (debug) console.error(`[DEBUG] Candidates within tolerance: ${candidates.length}`);

    if (candidates.length === 1) {
      if (debug) console.error(`[DEBUG] Returning single candidate: ${candidates[0].id}`);
      return candidates[0].id;
    }

    // Multiple candidates - pick the one closest to Claude start time
    if (candidates.length > 1) {
      candidates.sort((a, b) =>
        Math.abs(a.firstTimestamp! - claudeStartTime) -
        Math.abs(b.firstTimestamp! - claudeStartTime)
      );
      if (debug) console.error(`[DEBUG] Returning closest of ${candidates.length}: ${candidates[0].id}`);
      return candidates[0].id;
    }

    if (debug) console.error(`[DEBUG] No candidates found`);
    return null;
  } catch (e) {
    if (process.env.DEBUG) console.error(`[DEBUG] Exception: ${e}`);
    return null;
  }
}

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");

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
  auto_update?: boolean;
  memory_enabled?: boolean;
  memory_version?: string;
  claude_args?: string;
  codex_args?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];
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

interface DiscoveredProject {
  path: string;
  dirName: string;
  sessionCount: number;
  lastModified: Date;
}

function discoverProjects(): DiscoveredProject[] {
  const projectsPath = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(projectsPath)) {
    return [];
  }

  const projects: DiscoveredProject[] = [];
  const entries = fs.readdirSync(projectsPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(projectsPath, entry.name);
    const projectPath = "/" + entry.name.replace(/-/g, "/").slice(1);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
    const sessionFiles = fs.readdirSync(dirPath).filter(f => uuidPattern.test(f));

    if (sessionFiles.length === 0) continue;

    let lastModified = new Date(0);
    for (const file of sessionFiles) {
      const stats = fs.statSync(path.join(dirPath, file));
      if (stats.mtime > lastModified) {
        lastModified = stats.mtime;
      }
    }

    projects.push({
      path: projectPath,
      dirName: entry.name,
      sessionCount: sessionFiles.length,
      lastModified,
    });
  }

  return projects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
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

function logCliCommand(command: string, args?: string): void {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) return;

  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const message = args ? `[CLI] ${command}: ${args}` : `[CLI] ${command}`;

  fetch(`${siteUrl}/cli/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: config.auth_token,
      level: "info",
      message,
      metadata: { command, args },
      cli_version: getVersion(),
      platform: process.platform,
    }),
  }).catch(() => {});
}

function logCliError(command: string, error: string): void {
  const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [CLI ERROR] ${command}: ${error}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
  }

  const config = readConfig();
  if (config?.auth_token && config?.convex_url) {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    fetch(`${siteUrl}/cli/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        level: "error",
        message: `[CLI] ${command}: ${error}`,
        metadata: { command, error },
        cli_version: getVersion(),
        platform: process.platform,
      }),
    }).catch(() => {});
  }
}

interface FullReadResult {
  conversation: {
    id: string;
    title: string;
    project_path: string | null;
    message_count: number;
    updated_at: string;
  };
  messages: Array<{
    line: number;
    role: string;
    content: string;
    timestamp: string;
    tool_calls?: Array<{ name?: string; input?: unknown }>;
    tool_results?: Array<{ content?: string; isError?: boolean }>;
  }>;
}

async function fetchAllMessages(
  siteUrl: string,
  apiToken: string,
  conversationId: string,
  maxMessages: number = 500
): Promise<FullReadResult | { error: string }> {
  const firstResponse = await fetch(`${siteUrl}/cli/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: apiToken,
      conversation_id: conversationId,
      start_line: 1,
      end_line: 25,
    }),
  });

  const firstResult = await firstResponse.json();
  if (firstResult.error) {
    return { error: firstResult.error };
  }

  const totalMessages = firstResult.conversation?.message_count || 0;
  const allMessages = [...(firstResult.messages || [])];

  let currentLine = 26;
  while (currentLine <= totalMessages && currentLine <= maxMessages) {
    const endLine = Math.min(currentLine + 24, totalMessages, maxMessages);
    const response = await fetch(`${siteUrl}/cli/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: apiToken,
        conversation_id: conversationId,
        start_line: currentLine,
        end_line: endLine,
      }),
    });

    const result = await response.json();
    if (result.error || !result.messages) break;

    allMessages.push(...result.messages);
    currentLine = endLine + 1;
  }

  return {
    conversation: firstResult.conversation,
    messages: allMessages,
  };
}

const CODECAST_SLASH_COMMAND = `---
description: Get codecast dashboard and share links for current session (user)
allowed-tools: ["Bash"]
---

Run this command to get codecast links for the current session:

\`\`\`bash
codecast links
\`\`\`

The output shows:
- **Session**: Title or identifier of the found session
- **Dashboard**: URL to view the session on codecast.sh
- **Share**: URL to share with others

IMPORTANT: Verify the "Session:" line matches this conversation's topic. If it shows a different/old session, tell the user to try \`codecast links -s <session-id>\` with the correct session ID from \`ls ~/.claude/projects/*/\`.

Note: If the session hasn't been synced yet, this command will automatically sync it first.
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

function showWelcome(): void {
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`\n  ${c.bold}Welcome to codecast${c.reset} ${fmt.muted("— sync & search your agent sessions")}\n`);

  const feature = (icon: string, title: string, desc: string) => {
    console.log(`  ${fmt.accent(icon)}  ${c.bold}${title}${c.reset}`);
    console.log(`     ${fmt.muted(desc)}`);
  };

  feature("◉", "Memory", "Your agent can search past conversations for context");
  feature("◉", "Dashboard", "Browse sessions at codecast.sh with full-text search");
  feature("◉", "Background Sync", "Sessions sync automatically as you work");

  console.log(`\n  ${fmt.muted("Commands")}`);
  console.log(`     ${fmt.cmd("codecast search")} ${fmt.muted("\"query\"")}   ${fmt.muted("Full-text search across sessions")}`);
  console.log(`     ${fmt.cmd("codecast resume")} ${fmt.muted("\"query\"")}   ${fmt.muted("Find a session and open it in Claude")}`);
  console.log(`     ${fmt.cmd("codecast ask")} ${fmt.muted("\"question\"")}   ${fmt.muted("Ask questions about past work")}`);
  console.log(`     ${fmt.cmd("codecast feed")}             ${fmt.muted("Browse recent sessions")}`);
  console.log(`     ${fmt.cmd("codecast status")}           ${fmt.muted("Check sync status")}`);
  console.log(`\n     ${fmt.muted("Run")} ${fmt.cmd("codecast -h")} ${fmt.muted("for all commands")}`);

  console.log(`\n${c.dim}${"─".repeat(50)}${c.reset}\n`);
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

  const row = (label: string, value: string) => {
    console.log(`  ${fmt.muted(label.padEnd(14))} ${value}`);
  };

  row("Version", fmt.value(`v${getVersion()}`));

  if (state?.authExpired) {
    row("Auth", fmt.warning("expired"));
    console.log(`  ${fmt.muted("Run")} ${fmt.cmd("codecast auth")} ${fmt.muted("to re-authenticate")}`);
  } else if (config?.auth_token) {
    row("Auth", fmt.success(icons.check + " authenticated"));
    if (config.user_id) {
      row("User", fmt.id(config.user_id));
    }
  } else {
    row("Auth", fmt.muted(icons.cross + " not authenticated"));
    console.log(`  ${fmt.muted("Run")} ${fmt.cmd("codecast auth")} ${fmt.muted("to authenticate")}`);
  }

  console.log("");

  if (pid) {
    row("Daemon", fmt.success(icons.check + " running") + fmt.muted(` (PID ${pid})`));

    if (state?.lastSyncTime) {
      row("Last sync", fmt.value(formatRelativeTime(state.lastSyncTime)));
    } else {
      row("Last sync", fmt.muted("never"));
    }

    const queueSize = state?.pendingQueueSize ?? 0;
    row("Queue", queueSize > 0 ? fmt.number(queueSize) + fmt.muted(" items") : fmt.muted("empty"));

    try {
      const fdCount = execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: "utf-8" }).trim();
      row("File handles", fmt.number(parseInt(fdCount, 10) || 0));
    } catch {
      row("File handles", fmt.muted("unavailable"));
    }
  } else {
    row("Daemon", fmt.muted(icons.cross + " stopped"));
    if (config?.auth_token) {
      console.log(`  ${fmt.muted("Run")} ${fmt.cmd("codecast start")} ${fmt.muted("to start syncing")}`);
    }
  }

  const convexConnected = pid && (state?.connected ?? false);
  row("Convex", convexConnected ? fmt.success(icons.check + " connected") : fmt.muted(icons.cross + " disconnected"));

  console.log("");

  const syncMode = config?.sync_mode || "all";
  const syncProjects = config?.sync_projects || [];

  console.log(`  ${fmt.muted("Sync Settings")}`);
  if (syncMode === "all") {
    row("  Mode", fmt.value("all projects"));
  } else {
    row("  Mode", fmt.value("selected") + fmt.muted(` (${syncProjects.length})`));
    if (syncProjects.length > 0) {
      for (const p of syncProjects.slice(0, 5)) {
        console.log(`      ${fmt.muted(icons.bullet)} ${fmt.path(p)}`);
      }
      if (syncProjects.length > 5) {
        console.log(`      ${fmt.muted(`... and ${syncProjects.length - 5} more`)}`);
      }
    }
  }
  console.log(`  ${fmt.muted("  Change:")} ${fmt.cmd("codecast sync-settings")}`);

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
    // Binary mode: spawn self with _daemon argument
    // Use process.execPath which is the actual executable path in compiled binaries
    child = spawn(process.execPath, ["_daemon"], {
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
      team_id: result.team_id,
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
  console.log(`\n${c.bold}codecast${c.reset} ${fmt.muted("Authentication")}\n`);

  const agents = detectAgents();
  if (agents.length > 0) {
    console.log(fmt.muted("Detected coding agents:"));
    for (const agent of agents) {
      console.log(`  ${fmt.muted(icons.bullet)} ${fmt.value(agent.name)}`);
    }
    console.log();
  }

  console.log(`${fmt.muted("Opening browser for authentication...")}\n`);

  const authServer = new AuthServer({ port: 42424, timeout: 300000 });
  const nonce = authServer.getNonce();
  const port = authServer.getPort();
  const deviceName = encodeURIComponent(getDeviceName());

  const cliUrl = `${WEB_URL}/auth/cli?nonce=${nonce}&port=${port}&device=${deviceName}`;

  console.log(`${fmt.muted("If the browser doesn't open, visit:")}\n  ${fmt.accent(cliUrl)}\n`);

  try {
    await open(cliUrl);
  } catch {
    console.log(fmt.muted("Could not open browser automatically."));
  }

  console.log(`${fmt.muted("Waiting for authentication...")}\n`);

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

  console.log(`${fmt.success(icons.check)} ${c.bold}Authenticated successfully!${c.reset}\n`);
  console.log(`  ${fmt.muted("User")}     ${fmt.id(config.user_id || "")}`);
  console.log(`  ${fmt.muted("Token")}    ${fmt.value(maskToken(config.auth_token || ""))}`);
  console.log(`  ${fmt.muted("Config")}   ${fmt.path(CONFIG_FILE)}\n`);

  showWelcome();

  await promptProjectSelection(config);

  await promptTeamSelection(config);

  if (!isDaemonRunning()) {
    console.log("Starting daemon...");
    startDaemon();
  }

  // Set up autostart so daemon restarts on reboot/crash
  if (ensureAutostart()) {
    console.log("Auto-start configured (daemon will restart automatically)");
  }

  await promptMemoryEnablement();

  console.log("\nStatus:");
  showStatus();
}

async function promptProjectSelection(config: Config): Promise<void> {
  const projects = discoverProjects();

  if (projects.length === 0) {
    console.log("No projects found to sync yet. Sessions will sync automatically.\n");
    config.sync_mode = "all";
    config.sync_projects = [];
    writeConfig(config);
    return;
  }

  console.log("--- Sync Settings ---");
  console.log(`Found ${projects.length} project${projects.length === 1 ? "" : "s"} with Claude Code sessions.\n`);

  const syncAll = await confirm({
    message: "Sync all projects? (recommended)",
    default: true,
  });

  if (syncAll) {
    config.sync_mode = "all";
    config.sync_projects = [];
    writeConfig(config);
    await updateSyncSettingsOnServer(config);
    console.log("\nAll sessions will be synced.\n");
    return;
  }

  const choices = projects.map(p => ({
    name: `${p.path} (${p.sessionCount} session${p.sessionCount === 1 ? "" : "s"})`,
    value: p.path,
    checked: true,
  }));

  console.log("\nSelect which projects to sync (use arrow keys and space to toggle):\n");

  const selectedProjects = await checkbox({
    message: "Projects to sync:",
    choices,
    pageSize: 15,
  });

  config.sync_mode = "selected";
  config.sync_projects = selectedProjects;
  writeConfig(config);
  await updateSyncSettingsOnServer(config);

  if (selectedProjects.length === 0) {
    console.log("\nNo projects selected. You can change this later with 'codecast config sync'.\n");
  } else {
    console.log(`\n${selectedProjects.length} project${selectedProjects.length === 1 ? "" : "s"} will be synced.\n`);
  }
}

async function updateSyncSettingsOnServer(config: Config): Promise<void> {
  if (!config.auth_token || !config.convex_url) return;

  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    await fetch(`${siteUrl}/cli/sync-settings/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        sync_mode: config.sync_mode,
        sync_projects: config.sync_projects,
      }),
    });
  } catch {
    // Silently fail - local config is the source of truth for daemon
  }
}

async function promptTeamSelection(config: Config): Promise<void> {
  const teams = await fetchTeams(config);

  if (teams.length === 0) {
    return;
  }

  console.log("--- Team Sharing ---");

  if (teams.length === 1) {
    console.log(`You're a member of ${fmt.accent(teams[0].name)}.`);
    const shareWithTeam = await confirm({
      message: `Share your sessions with ${teams[0].name} by default?`,
      default: true,
    });

    if (shareWithTeam) {
      config.team_id = teams[0]._id;
      writeConfig(config);
      console.log(`\nSessions will be shared with ${fmt.accent(teams[0].name)} by default.`);
      console.log(`${fmt.muted("You can configure per-project sharing with 'codecast sync-settings'")}\n`);
    } else {
      console.log(`\nSessions will be private by default.`);
      console.log(`${fmt.muted("You can share specific projects with 'codecast sync-settings'")}\n`);
    }
    return;
  }

  console.log(`You're a member of ${teams.length} teams:\n`);
  for (const team of teams) {
    const roleLabel = team.role === "admin" ? fmt.muted("(admin)") : "";
    console.log(`  ${icons.bullet} ${fmt.accent(team.name)} ${roleLabel}`);
  }
  console.log();

  const configureNow = await confirm({
    message: "Configure which projects share with which teams now?",
    default: true,
  });

  if (configureNow) {
    const projects = discoverProjects();
    const serverProjects = await fetchProjectsWithTeams(config);

    const projectMap = new Map<string, { sessionCount: number; teamId: string | null; teamName: string | null }>();
    for (const p of serverProjects) {
      projectMap.set(p.path, { sessionCount: p.session_count, teamId: p.team_id, teamName: p.team_name });
    }
    for (const p of projects) {
      if (!projectMap.has(p.path)) {
        projectMap.set(p.path, { sessionCount: p.sessionCount, teamId: null, teamName: null });
      }
    }

    const projectList = Array.from(projectMap.entries())
      .map(([path, data]) => ({ path, ...data }))
      .sort((a, b) => b.sessionCount - a.sessionCount)
      .slice(0, 15);

    if (projectList.length === 0) {
      console.log("No projects found yet. You can configure team sharing later.\n");
      return;
    }

    const maxNameLen = Math.min(20, Math.max(...projectList.map(p => (p.path.split("/").pop() || p.path).length)));

    console.log(`\n${c.bold}Your Projects${c.reset}\n`);
    console.log(`  ${"Project".padEnd(maxNameLen)} ${"Sessions".padEnd(10)} ${"Team"}`);
    console.log(`  ${"-".repeat(maxNameLen)} ${"-".repeat(10)} ${"-".repeat(15)}`);

    for (const p of projectList) {
      const name = (p.path.split("/").pop() || p.path).padEnd(maxNameLen);
      const sessions = `${p.sessionCount}`.padEnd(10);
      const team = p.teamName ? fmt.accent(p.teamName) : fmt.muted("Only Me");
      console.log(`  ${fmt.value(name)} ${fmt.muted(sessions)} ${team}`);
    }
    console.log();

    let continueEditing = true;
    while (continueEditing) {
      const projectChoices = [
        { name: fmt.success("Done - continue setup"), value: "__done__" },
        ...projectList.map(p => {
          const name = p.path.split("/").pop() || p.path;
          const team = p.teamName || "Only Me";
          return {
            name: `${name} ${fmt.muted(`→ ${team}`)}`,
            value: p.path,
          };
        }),
      ];

      const selectedPath = await select({
        message: "Select a project to change (or Done):",
        choices: projectChoices,
        pageSize: 12,
      });

      if (selectedPath === "__done__") {
        continueEditing = false;
        continue;
      }

      const project = projectList.find(p => p.path === selectedPath);
      if (!project) continue;

      const teamChoices = [
        { name: `Only Me ${fmt.muted("(private)")}`, value: null as string | null },
        ...teams.map(t => ({
          name: `${t.name} ${t.role === "admin" ? fmt.muted("(admin)") : ""}`,
          value: t._id,
        })),
      ];

      const selectedTeam = await select({
        message: `Share ${project.path.split("/").pop()} with:`,
        choices: teamChoices,
        default: project.teamId || null,
      });

      if (selectedTeam !== project.teamId) {
        await updateDirectoryMapping(config, project.path, selectedTeam);
        const teamName = selectedTeam
          ? teams.find(t => t._id === selectedTeam)?.name || "team"
          : "Only Me";
        project.teamId = selectedTeam;
        project.teamName = selectedTeam ? teamName : null;
        console.log(`${fmt.success(icons.check)} ${project.path.split("/").pop()} → ${fmt.accent(teamName)}\n`);
      }
    }

    console.log(`${fmt.muted("Configure more projects anytime with 'codecast sync-settings'")}\n`);
  } else {
    console.log(`\n${fmt.muted("Run 'codecast sync-settings' anytime to configure team sharing.")}\n`);
  }
}

const MEMORY_SNIPPET_END = "<!-- /codecast-memory -->";
const MEMORY_SNIPPET = `
## Memory

You are one session among many. Past conversations contain valuable context about decisions, patterns, and prior work. Search proactively and liberally - when starting tasks, debugging issues, or when the user references previous work. Parallelize searches when exploring multiple topics.

\`\`\`bash
# Search & Browse
codecast search "auth"                # search current project
codecast search "bug" -g -s 7d        # global, last 7 days
codecast feed                         # browse recent conversations
codecast read <id> 15:25              # read messages 15-25

# Analysis
codecast diff <id>                    # files changed, commits, tools used
codecast diff --today                 # aggregate today's work
codecast summary <id>                 # goal, approach, outcome, files
codecast context "implement auth"     # find relevant prior sessions
codecast ask "how does X work"        # query across sessions

# Handoff & Tracking
codecast handoff                      # generate context transfer doc
codecast bookmark <id> <msg> --name x # save shareable link
codecast decisions list               # view architectural decisions
codecast decisions add "title" --reason "why"
\`\`\`

Common options: -g (global), -s/-e (start/end: 7d, 2w, yesterday), -p (page), -n (limit)
${MEMORY_SNIPPET_END}
`;

interface SnippetTarget {
  filePath: string;
  dirPath: string;
  label: string;
}

function getSnippetTargets(): SnippetTarget[] {
  const home = os.homedir();
  const targets: SnippetTarget[] = [
    { filePath: path.join(home, ".claude", "CLAUDE.md"), dirPath: path.join(home, ".claude"), label: "~/.claude/CLAUDE.md" },
  ];

  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir)) {
    targets.push({ filePath: path.join(codexDir, "AGENTS.md"), dirPath: codexDir, label: "~/.codex/AGENTS.md" });
  }

  const cursorDir = path.join(home, ".cursor");
  if (fs.existsSync(cursorDir)) {
    const rulesDir = path.join(cursorDir, "rules");
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }
    targets.push({ filePath: path.join(rulesDir, "codecast.mdc"), dirPath: rulesDir, label: "~/.cursor/rules/codecast.mdc" });
  }

  return targets;
}

function installSnippetToFile(filePath: string, dirPath: string, update: boolean): { installed: boolean; updated: boolean } {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }

  const hasMemory = existing.includes("## Memory") && existing.includes("codecast search");
  if (hasMemory && !update) {
    return { installed: false, updated: false };
  }

  if (hasMemory && update) {
    const memoryStart = existing.indexOf("## Memory");
    let memoryEnd = existing.length;

    const endMarkerIdx = existing.indexOf(MEMORY_SNIPPET_END, memoryStart);
    if (endMarkerIdx !== -1) {
      memoryEnd = endMarkerIdx + MEMORY_SNIPPET_END.length;
      if (existing[memoryEnd] === "\n") memoryEnd++;
    } else {
      const nextSection = existing.slice(memoryStart + 10).match(/\n## [A-Z]/);
      if (nextSection && nextSection.index !== undefined) {
        memoryEnd = memoryStart + 10 + nextSection.index;
      }
    }

    const before = existing.slice(0, memoryStart);
    const after = existing.slice(memoryEnd);
    existing = before + after;
    fs.writeFileSync(filePath, existing.trimEnd() + "\n" + MEMORY_SNIPPET, { mode: 0o600 });
    return { installed: true, updated: true };
  }

  fs.writeFileSync(filePath, existing + MEMORY_SNIPPET, { mode: 0o600 });
  return { installed: true, updated: false };
}

function installMemorySnippet(update = false): { installed: boolean; updated: boolean } {
  const targets = getSnippetTargets();
  let anyInstalled = false;
  let anyUpdated = false;

  for (const target of targets) {
    const result = installSnippetToFile(target.filePath, target.dirPath, update);
    if (result.installed) anyInstalled = true;
    if (result.updated) anyUpdated = true;
  }

  return { installed: anyInstalled, updated: anyUpdated };
}

async function promptMemoryEnablement(): Promise<void> {
  const config = readConfig() || {};

  if (config.memory_enabled !== undefined && config.memory_version === getMemoryVersion()) {
    if (config.memory_enabled) {
      installMemorySnippet(false);
    }
    return;
  }

  if (config.memory_enabled && config.memory_version !== getMemoryVersion()) {
    const result = installMemorySnippet(true);
    config.memory_version = getMemoryVersion();
    writeConfig(config);
    if (result.updated) {
      const targets = getSnippetTargets();
      console.log(`Memory snippet updated to latest version in ${targets.map(t => t.label).join(", ")}.`);
    }
    return;
  }

  const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    if (content.includes("codecast search") && config.memory_enabled === undefined) {
      config.memory_enabled = true;
      config.memory_version = getMemoryVersion();
      writeConfig(config);
      installMemorySnippet(false);
      return;
    }
  }

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    console.log("\n--- Agent Memory ---");
    console.log("Would you like to enable memory for your coding agents?");
    console.log("This lets your agents search past conversations for context.\n");
    rl.question("Enable agent memory? [Y/n] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  if (answer === "" || answer === "y" || answer === "yes") {
    const result = installMemorySnippet(false);
    if (result.installed) {
      const targets = getSnippetTargets();
      console.log(`\nMemory enabled. Added to:`);
      for (const t of targets) { console.log(`  ${t.label}`); }
      console.log("Your agents can now use: codecast search \"query\"");
    }
    config.memory_enabled = true;
    config.memory_version = getMemoryVersion();
    writeConfig(config);
  } else {
    console.log("\nSkipped. Run 'codecast memory' later to enable.");
    config.memory_enabled = false;
    writeConfig(config);
  }
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

  console.log(`\n${fmt.muted("Finding unsynced conversations...")}\n`);

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
    console.log(`${fmt.success(icons.check)} ${fmt.muted("All conversations are already synced.")}`);
    return;
  }

  console.log(`${fmt.muted("Syncing")} ${fmt.number(unsyncedFiles.length)} ${fmt.muted("conversations...")}\n`);

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
          teamId: config.team_id,
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
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
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

  console.log(`\n\n${fmt.success(icons.check)} ${c.bold}Sync complete!${c.reset}`);
  console.log(`  ${fmt.muted("Synced")}  ${fmt.number(syncedCount)} ${fmt.muted("conversations")}`);

  if (errorCount > 0) {
    console.log(`  ${fmt.error("Errors")}  ${fmt.number(errorCount)}`);
  }
}

async function syncSingleSession(sessionId: string, projectRoot: string): Promise<boolean> {
  const config = readConfig();
  if (!config?.auth_token || !config?.user_id) {
    return false;
  }

  const projectDir = projectRoot.replace(/\//g, "-");
  const sessionsDir = path.join(process.env.HOME || "", ".claude", "projects", projectDir);
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) {
    return false;
  }

  try {
    const stats = fs.statSync(sessionFile);
    const content = fs.readFileSync(sessionFile, "utf-8");
    const messages = parseSessionFile(content);

    if (messages.length === 0) {
      return false;
    }

    const slug = extractSlug(content);
    const syncService = new SyncService({
      convexUrl: config.convex_url || CONVEX_URL,
      authToken: config.auth_token,
      userId: config.user_id,
    });

    let conversationId: string | null = null;
    const actualProjectPath = "/" + projectDir.slice(1).replace(/-/g, "/");

    try {
      conversationId = await syncService.createConversation({
        userId: config.user_id!,
        sessionId,
        agentType: "claude_code",
        projectPath: actualProjectPath,
        slug,
        startedAt: messages[0]?.timestamp || Date.now(),
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      if (!errorMsg.includes("already exists")) {
        throw err;
      }
      return true;
    }

    if (conversationId) {
      for (const msg of messages) {
        await syncService.addMessage({
          conversationId,
          messageUuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
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

    setPosition(sessionFile, stats.size);
    return true;
  } catch {
    return false;
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
  .version(getVersion())
  .action(() => {
    program.outputHelp();
  });

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
    // Ensure autostart is configured so daemon restarts on reboot/crash
    ensureAutostart();
  });

program
  .command("stop")
  .description("Stop the background daemon")
  .action(() => {
    stopDaemon();
  });

program
  .command("welcome", { hidden: true })
  .description("Show welcome message")
  .action(() => {
    showWelcome();
  });

program
  .command("status")
  .description("Show daemon status, connection state, and sync information")
  .action(() => {
    showStatus();
  });

program
  .command("repair")
  .description("Repair project paths that were stored incorrectly")
  .option("--dry-run", "Show what would be repaired without making changes")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    if (!fs.existsSync(claudeProjectsDir)) {
      console.log("No Claude projects directory found");
      process.exit(0);
    }

    const { extractCwd } = await import("./parser.js");

    console.log("Scanning local session files...\n");

    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory())
      .map((d: any) => d.name);

    const fixes: Array<{ sessionId: string; actualPath: string }> = [];

    for (const dir of projectDirs) {
      const dirPath = path.join(claudeProjectsDir, dir);
      const sessionFiles = fs.readdirSync(dirPath)
        .filter((f: string) => f.endsWith(".jsonl") && f !== "sessions-index.json");

      for (const file of sessionFiles) {
        const sessionId = file.replace(".jsonl", "");
        const filePath = path.join(dirPath, file);

        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const actualCwd = extractCwd(content);
          if (actualCwd) {
            fixes.push({ sessionId, actualPath: actualCwd });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    console.log(`Found ${fixes.length} sessions to check\n`);

    if (options.dryRun) {
      console.log("Dry run - no changes will be made\n");
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    let repaired = 0;

    for (const fix of fixes) {
      try {
        const response = await fetch(`${siteUrl}/api/mutation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "conversations:updateProjectPath",
            args: {
              session_id: fix.sessionId,
              project_path: fix.actualPath,
              api_token: config.auth_token,
            },
          }),
        });

        const result = await response.json();
        if (result.value?.updated) {
          console.log(`${fix.sessionId.slice(0, 8)} -> ${fix.actualPath}`);
          repaired++;
        }
      } catch {
        // Skip errors
      }
    }

    console.log(`\nRepaired ${repaired} project paths`);
  });

program
  .command("health")
  .description("Show detailed sync health information including dropped operations and pending files")
  .option("--clear-dropped", "Clear the dropped operations log")
  .option("--reconcile", "Run reconciliation against backend to find discrepancies")
  .action(async (options) => {
    console.log("");
    console.log(fmt.muted("  Sync Health Report"));
    console.log("");

    const row = (label: string, value: string, indent = 2) => {
      console.log(`${"  ".repeat(indent)}${fmt.muted(label.padEnd(18))} ${value}`);
    };

    // Check for dropped operations
    const droppedPath = path.join(CONFIG_DIR, "dropped-operations.json");
    let droppedOps: any[] = [];
    try {
      if (fs.existsSync(droppedPath)) {
        droppedOps = JSON.parse(fs.readFileSync(droppedPath, "utf-8"));
      }
    } catch {
      // ignore
    }

    if (options.clearDropped && droppedOps.length > 0) {
      fs.unlinkSync(droppedPath);
      console.log(fmt.success("  Cleared dropped operations log"));
      console.log("");
      return;
    }

    // Handle --reconcile option
    if (options.reconcile) {
      const config = readConfig();
      if (!config?.auth_token || !config?.convex_url) {
        console.log(fmt.error("  Not authenticated. Run 'codecast auth' first."));
        console.log("");
        return;
      }

      console.log(fmt.muted("  Running reconciliation against backend..."));
      console.log("");

      const syncService = new SyncService({
        convexUrl: config.convex_url,
        authToken: config.auth_token,
        userId: config.user_id,
      });

      try {
        const result = await performReconciliation(
          syncService,
          (msg, level) => {
            if (level === "warn") {
              console.log(`  ${fmt.warning(msg)}`);
            } else if (level === "error") {
              console.log(`  ${fmt.error(msg)}`);
            } else {
              console.log(`  ${fmt.muted(msg)}`);
            }
          },
          100
        );

        console.log("");
        console.log(`  ${fmt.muted("Reconciliation Results")}`);
        row("Checked", fmt.number(result.checked) + fmt.muted(" sessions"), 2);

        if (result.discrepancies.length === 0) {
          row("Status", fmt.success("All sessions match backend"), 2);
        } else {
          row("Discrepancies", fmt.warning(String(result.discrepancies.length)), 2);

          const confirm = await import("@inquirer/prompts").then(m => m.confirm);
          console.log("");
          const shouldRepair = await confirm({
            message: "Reset affected sessions for re-sync?",
            default: true,
          });

          if (shouldRepair) {
            const repaired = await repairDiscrepancies(result.discrepancies, (msg) => {
              console.log(`  ${fmt.muted(msg)}`);
            });
            console.log("");
            console.log(fmt.success(`  Reset ${repaired} sessions. They will re-sync on next daemon cycle.`));
          }
        }
      } catch (err) {
        console.log(fmt.error(`  Reconciliation failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      console.log("");
      return;
    }

    // Dropped operations
    console.log(`  ${fmt.muted("Dropped Operations")}`);
    if (droppedOps.length === 0) {
      row("Count", fmt.success("0") + fmt.muted(" (none dropped)"), 2);
    } else {
      row("Count", fmt.warning(String(droppedOps.length)), 2);
      const recentDropped = droppedOps.slice(-5);
      for (const op of recentDropped) {
        const time = formatRelativeTime(op.droppedAt);
        const sessionId = op.sessionId ? op.sessionId.slice(0, 8) + "..." : "unknown";
        console.log(`      ${fmt.muted(icons.bullet)} ${fmt.value(op.type)} ${fmt.muted(`(${sessionId})`)} ${fmt.muted(time)}`);
        if (op.lastError) {
          console.log(`        ${fmt.error(op.lastError.slice(0, 60))}`);
        }
      }
      if (droppedOps.length > 5) {
        console.log(`      ${fmt.muted(`... and ${droppedOps.length - 5} more`)}`);
      }
      console.log(`      ${fmt.muted("Use")} ${fmt.cmd("codecast health --clear-dropped")} ${fmt.muted("to clear")}`);
    }
    console.log("");

    // Pending files (files modified since last sync)
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    const unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);

    console.log(`  ${fmt.muted("Pending Sync")}`);
    if (unsyncedFiles.length === 0) {
      row("Files", fmt.success("0") + fmt.muted(" (all synced)"), 2);
    } else {
      row("Files", fmt.warning(String(unsyncedFiles.length)) + fmt.muted(" need syncing"), 2);
      for (const filePath of unsyncedFiles.slice(0, 5)) {
        const sessionId = path.basename(filePath, ".jsonl").slice(0, 8) + "...";
        console.log(`      ${fmt.muted(icons.bullet)} ${fmt.value(sessionId)}`);
      }
      if (unsyncedFiles.length > 5) {
        console.log(`      ${fmt.muted(`... and ${unsyncedFiles.length - 5} more`)}`);
      }
    }
    console.log("");

    // Retry queue
    const retryPath = path.join(CONFIG_DIR, "retry-queue.json");
    let retryOps: any[] = [];
    try {
      if (fs.existsSync(retryPath)) {
        retryOps = JSON.parse(fs.readFileSync(retryPath, "utf-8"));
      }
    } catch {
      // ignore
    }

    console.log(`  ${fmt.muted("Retry Queue")}`);
    if (retryOps.length === 0) {
      row("Items", fmt.success("0") + fmt.muted(" (empty)"), 2);
    } else {
      row("Items", fmt.number(retryOps.length) + fmt.muted(" pending retry"), 2);
      for (const op of retryOps.slice(0, 3)) {
        const attempts = op.attempts || 0;
        console.log(`      ${fmt.muted(icons.bullet)} ${fmt.value(op.type)} ${fmt.muted(`(attempt ${attempts}/${10})`)}`);
      }
      if (retryOps.length > 3) {
        console.log(`      ${fmt.muted(`... and ${retryOps.length - 3} more`)}`);
      }
    }
    console.log("");

    // Last reconciliation
    const lastRecon = getLastReconciliation();
    console.log(`  ${fmt.muted("Reconciliation")}`);
    if (lastRecon) {
      row("Last run", fmt.value(formatRelativeTime(lastRecon.timestamp)), 2);
      if (lastRecon.discrepancyCount === 0) {
        row("Result", fmt.success("No discrepancies"), 2);
      } else {
        row("Result", fmt.warning(`${lastRecon.discrepancyCount} discrepancies found`), 2);
      }
    } else {
      row("Last run", fmt.muted("never"), 2);
    }
    console.log(`      ${fmt.muted("Use")} ${fmt.cmd("codecast health --reconcile")} ${fmt.muted("to run now")}`);
    console.log("");

    // Sync ledger summary
    const syncRecords = getAllSyncRecords();
    const recordCount = Object.keys(syncRecords).length;

    console.log(`  ${fmt.muted("Sync Ledger")}`);
    row("Tracked files", fmt.number(recordCount), 2);

    if (recordCount > 0) {
      const records = Object.values(syncRecords);
      const totalMessages = records.reduce((sum, r) => sum + (r.messageCount || 0), 0);
      const lastSync = Math.max(...records.map(r => r.lastSyncedAt || 0));
      row("Total messages", fmt.number(totalMessages), 2);
      if (lastSync > 0) {
        row("Last activity", fmt.value(formatRelativeTime(lastSync)), 2);
      }
    }
    console.log("");
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
        if (config.claude_args) console.log(`  claude_args: ${config.claude_args}`);
        if (config.codex_args) console.log(`  codex_args: ${config.codex_args}`);
        if (config.created_at) console.log(`  created_at: ${config.created_at}`);
        if (config.updated_at) console.log(`  updated_at: ${config.updated_at}`);
      } else {
        console.log("  (no configuration found - run 'codecast setup')");
      }
      return;
    }

    const settableKeys = ["auth_token", "web_url", "user_id", "convex_url", "team_id", "excluded_paths", "claude_args", "codex_args"] as const;
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

interface Team {
  _id: string;
  name: string;
  icon: string;
  icon_color: string;
  role: string;
  visibility: string;
}

interface ProjectWithTeam {
  path: string;
  session_count: number;
  last_active: number;
  team_id: string | null;
  team_name: string | null;
}

async function fetchTeams(config: Config): Promise<Team[]> {
  if (!config.auth_token || !config.convex_url) return [];
  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const response = await fetch(`${siteUrl}/cli/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.teams || [];
  } catch {
    return [];
  }
}

async function fetchProjectsWithTeams(config: Config): Promise<ProjectWithTeam[]> {
  if (!config.auth_token || !config.convex_url) return [];
  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const response = await fetch(`${siteUrl}/cli/teams/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token, limit: 30 }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.projects || [];
  } catch {
    return [];
  }
}

async function updateDirectoryMapping(config: Config, pathPrefix: string, teamId: string | null): Promise<boolean> {
  if (!config.auth_token || !config.convex_url) return false;
  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const body: Record<string, unknown> = {
      api_token: config.auth_token,
      path_prefix: pathPrefix,
      auto_share: true,
    };
    if (teamId !== null) {
      body.team_id = teamId;
    }
    const response = await fetch(`${siteUrl}/cli/teams/mappings/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      if (process.env.DEBUG) {
        console.error("Update mapping failed:", response.status, text);
      }
    }
    return response.ok;
  } catch (err) {
    if (process.env.DEBUG) {
      console.error("Update mapping error:", err);
    }
    return false;
  }
}

function getProjectName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function getRelativeTime(timestamp: number): string {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  return `${days}d ago`;
}

program
  .command("sync-settings")
  .description(
    "View or modify sync and team sharing settings\n\n" +
    "Examples:\n" +
    "  codecast sync-settings           # Interactive project and team configuration\n" +
    "  codecast sync-settings --all     # Sync all projects\n" +
    "  codecast sync-settings --show    # Show current settings only"
  )
  .option("--all", "Sync all projects")
  .option("--show", "Show current settings without prompting")
  .action(async (options) => {
    const config = readConfig();

    if (!config?.auth_token) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const teams = await fetchTeams(config);
    const hasTeams = teams.length > 0;
    const serverProjects = await fetchProjectsWithTeams(config);
    const localProjects = discoverProjects();

    const projectMap = new Map<string, { sessionCount: number; lastActive: number; teamId: string | null; teamName: string | null }>();

    for (const p of serverProjects) {
      projectMap.set(p.path, {
        sessionCount: p.session_count,
        lastActive: p.last_active,
        teamId: p.team_id,
        teamName: p.team_name,
      });
    }

    for (const p of localProjects) {
      if (!projectMap.has(p.path)) {
        projectMap.set(p.path, {
          sessionCount: p.sessionCount,
          lastActive: Date.now(),
          teamId: null,
          teamName: null,
        });
      }
    }

    const projects = Array.from(projectMap.entries())
      .map(([path, data]) => ({ path, ...data }))
      .sort((a, b) => b.lastActive - a.lastActive);

    if (options.show) {
      console.log(`\n${c.bold}Sync Settings${c.reset}\n`);
      const mode = config.sync_mode === "selected" ? "Selected projects only" : "All projects";
      console.log(`  ${fmt.muted("Sync Mode:")} ${config.sync_mode === "selected" ? mode : fmt.accent(mode)}`);
      if (config.sync_mode === "selected" && config.sync_projects?.length) {
        console.log(`  ${fmt.muted("Syncing:")} ${config.sync_projects.length} of ${projects.length} projects`);
      }

      if (hasTeams) {
        console.log(`\n${c.bold}Teams${c.reset}`);
        for (const team of teams) {
          console.log(`  ${fmt.accent(team.name)} ${fmt.muted(`(${team.role})`)}`);
        }
      }

      console.log(`\n${c.bold}Projects${c.reset} (${projects.length})\n`);

      const maxNameLen = Math.min(30, Math.max(12, ...projects.map(p => getProjectName(p.path).length)));

      for (const p of projects.slice(0, 15)) {
        const name = getProjectName(p.path).padEnd(maxNameLen);
        const sessions = `${p.sessionCount} session${p.sessionCount !== 1 ? "s" : ""}`.padEnd(12);
        const time = getRelativeTime(p.lastActive).padEnd(10);
        if (hasTeams) {
          const team = p.teamName ? fmt.accent(p.teamName) : fmt.muted("Only Me");
          console.log(`  ${fmt.value(name)} ${fmt.muted(sessions)} ${fmt.muted(time)} ${team}`);
        } else {
          console.log(`  ${fmt.value(name)} ${fmt.muted(sessions)} ${fmt.muted(time)}`);
        }
      }
      if (projects.length > 15) {
        console.log(`  ${fmt.muted(`... and ${projects.length - 15} more`)}`);
      }
      return;
    }

    if (options.all) {
      config.sync_mode = "all";
      config.sync_projects = [];
      writeConfig(config);
      await updateSyncSettingsOnServer(config);
      console.log(`${fmt.success(icons.check)} All projects will be synced.`);
      return;
    }

    if (projects.length === 0) {
      console.log("No projects found with Claude Code sessions.");
      return;
    }

    console.log(`\n${c.bold}codecast${c.reset} ${fmt.muted("Sync Settings")}\n`);

    const displayProjects = projects.slice(0, 25);
    const maxNameLen = Math.min(25, Math.max(12, ...displayProjects.map(p => getProjectName(p.path).length)));

    const printProjectList = () => {
      if (hasTeams) {
        console.log(`  ${"Project".padEnd(maxNameLen)} ${"Sessions".padEnd(10)} ${"Team"}`);
        console.log(`  ${"-".repeat(maxNameLen)} ${"-".repeat(10)} ${"-".repeat(15)}`);
        displayProjects.forEach((p) => {
          const name = getProjectName(p.path).padEnd(maxNameLen);
          const sessions = `${p.sessionCount}`.padEnd(10);
          const team = p.teamName ? fmt.accent(p.teamName) : fmt.muted("Only Me");
          console.log(`  ${fmt.value(name)} ${fmt.muted(sessions)} ${team}`);
        });
      } else {
        console.log(`  ${"Project".padEnd(maxNameLen)} ${"Sessions"}`);
        console.log(`  ${"-".repeat(maxNameLen)} ${"-".repeat(10)}`);
        displayProjects.forEach((p) => {
          const name = getProjectName(p.path).padEnd(maxNameLen);
          const sessions = `${p.sessionCount}`;
          console.log(`  ${fmt.value(name)} ${fmt.muted(sessions)}`);
        });
      }
      if (projects.length > 25) {
        console.log(`  ${fmt.muted(`... and ${projects.length - 25} more`)}`);
      }
      console.log();
    };

    const syncModeDisplay = config.sync_mode === "selected" ? "Selected projects only" : "All projects";
    console.log(`${c.bold}Sync Mode:${c.reset} ${config.sync_mode === "selected" ? fmt.muted(syncModeDisplay) : fmt.accent(syncModeDisplay)}`);
    if (hasTeams) {
      console.log(`${c.bold}Teams:${c.reset} ${teams.map(t => fmt.accent(t.name)).join(", ")}`);
    }
    console.log(`${c.bold}Projects:${c.reset} ${projects.length}\n`);

    printProjectList();

    const isSyncAll = config.sync_mode !== "selected";
    const mainChoices = [
      { name: fmt.success("Done - save and exit"), value: "__done__" },
      {
        name: isSyncAll
          ? `Sync mode: All ${fmt.muted("→ change to Selected")}`
          : `Sync mode: Selected ${fmt.muted("→ change to All")}`,
        value: "__toggle_sync__"
      },
      ...(hasTeams ? displayProjects.map(p => ({
        name: `${getProjectName(p.path)} ${fmt.muted(`→ ${p.teamName || "Only Me"}`)}`,
        value: p.path,
      })) : []),
    ];

    if (!hasTeams && !isSyncAll) {
      mainChoices.push({
        name: `Select which projects to sync ${fmt.muted(`(${config.sync_projects?.length || 0} selected)`)}`,
        value: "__select_projects__"
      });
    }

    let continueEditing = true;
    while (continueEditing) {
      const action = await select({
        message: hasTeams ? "Change team sharing or sync mode:" : "Change sync settings:",
        choices: mainChoices,
        pageSize: 15,
      });

      if (action === "__done__") {
        continueEditing = false;
        continue;
      }

      if (action === "__toggle_sync__") {
        const wasAll = config.sync_mode !== "selected";
        if (wasAll) {
          config.sync_mode = "selected";
          config.sync_projects = projects.map(p => p.path);
          mainChoices[1].name = `Sync mode: Selected ${fmt.muted("→ change to All")}`;
          if (!hasTeams) {
            const existingSelectIdx = mainChoices.findIndex(c => c.value === "__select_projects__");
            if (existingSelectIdx === -1) {
              mainChoices.push({
                name: `Select which projects to sync ${fmt.muted(`(${config.sync_projects?.length || 0} selected)`)}`,
                value: "__select_projects__"
              });
            }
          }
        } else {
          config.sync_mode = "all";
          config.sync_projects = [];
          mainChoices[1].name = `Sync mode: All ${fmt.muted("→ change to Selected")}`;
          const selectIdx = mainChoices.findIndex(c => c.value === "__select_projects__");
          if (selectIdx !== -1) {
            mainChoices.splice(selectIdx, 1);
          }
        }
        writeConfig(config);
        await updateSyncSettingsOnServer(config);
        console.log(`${fmt.success(icons.check)} Sync mode: ${config.sync_mode === "all" ? "All projects" : "Selected projects"}\n`);
        continue;
      }

      if (action === "__select_projects__") {
        const choices = projects.map(p => ({
          name: `${getProjectName(p.path)} ${fmt.muted(`(${p.sessionCount} sessions)`)}`,
          value: p.path,
          checked: config.sync_projects?.includes(p.path) ?? true,
        }));

        const selectedProjects = await checkbox({
          message: "Select projects to sync:",
          choices,
          pageSize: 15,
        });

        config.sync_projects = selectedProjects;
        writeConfig(config);
        await updateSyncSettingsOnServer(config);

        const selectChoice = mainChoices.find(c => c.value === "__select_projects__");
        if (selectChoice) {
          selectChoice.name = `Select which projects to sync ${fmt.muted(`(${selectedProjects.length} selected)`)}`;
        }

        console.log(`${fmt.success(icons.check)} ${selectedProjects.length} project${selectedProjects.length === 1 ? "" : "s"} selected\n`);
        continue;
      }

      if (hasTeams) {
        const project = displayProjects.find(p => p.path === action);
        if (!project) continue;

        const teamChoices = [
          { name: `Only Me ${fmt.muted("(private)")}`, value: null as string | null },
          ...teams.map(t => ({
            name: `${t.name} ${t.role === "admin" ? fmt.muted("(admin)") : ""}`,
            value: t._id,
          })),
        ];

        const selectedTeam = await select({
          message: `Share ${getProjectName(project.path)} with:`,
          choices: teamChoices,
          default: project.teamId || null,
        });

        if (selectedTeam !== project.teamId) {
          const success = await updateDirectoryMapping(config, project.path, selectedTeam);
          if (success) {
            const newTeamName = selectedTeam
              ? teams.find(t => t._id === selectedTeam)?.name || "team"
              : "Only Me";
            project.teamId = selectedTeam;
            project.teamName = selectedTeam ? newTeamName : null;

            const choiceIdx = mainChoices.findIndex(c => c.value === project.path);
            if (choiceIdx !== -1) {
              mainChoices[choiceIdx].name = `${getProjectName(project.path)} ${fmt.muted(`→ ${newTeamName}`)}`;
            }

            console.log(`${fmt.success(icons.check)} ${getProjectName(project.path)} → ${fmt.accent(newTeamName)}\n`);
          } else {
            console.log(`${fmt.error("Failed to update")}\n`);
          }
        }
      }
    }

    if (hasTeams) {
      console.log(`${fmt.muted("Tip: Use")} codecast teams map <path> <team> ${fmt.muted("to map projects directly.")}`);
    } else {
      console.log(`${fmt.muted("Tip: Create or join a team at")} ${fmt.accent("codecast.sh/settings/team")}`);
    }
  });

program
  .command("teams")
  .description(
    "Manage teams and directory mappings\n\n" +
    "Examples:\n" +
    "  codecast teams                      # List your teams\n" +
    "  codecast teams mappings             # Show directory-to-team mappings\n" +
    "  codecast teams map <path> <team>    # Map a directory to a team\n" +
    "  codecast teams unmap <path>         # Remove a directory mapping"
  )
  .argument("[action]", "Action: mappings, map, unmap")
  .argument("[path]", "Directory path (for map/unmap)")
  .argument("[team]", "Team ID or name (for map)")
  .action(async (action, pathArg, teamArg) => {
    const config = readConfig();

    if (!config?.auth_token) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const teams = await fetchTeams(config);

    if (!action) {
      if (teams.length === 0) {
        console.log("\nYou are not a member of any teams.");
        console.log(`\n${fmt.muted("Create or join a team at")} ${fmt.accent("codecast.sh/settings/team")}`);
        return;
      }

      console.log(`\n${c.bold}Your Teams${c.reset}\n`);
      for (const team of teams) {
        const roleLabel = team.role === "admin" ? fmt.accent("admin") : fmt.muted("member");
        console.log(`  ${fmt.value(team.name.padEnd(20))} ${roleLabel.padEnd(12)} ${fmt.muted(team._id)}`);
      }
      console.log(`\n${fmt.muted("Run 'codecast teams mappings' to see which projects share with which teams.")}`);
      return;
    }

    if (action === "mappings") {
      const projects = await fetchProjectsWithTeams(config);

      if (projects.length === 0) {
        console.log("\nNo projects found.");
        return;
      }

      console.log(`\n${c.bold}Directory Team Mappings${c.reset}\n`);

      const mapped = projects.filter(p => p.team_name);
      const unmapped = projects.filter(p => !p.team_name);

      if (mapped.length > 0) {
        console.log(`${fmt.muted("Shared with teams:")}`);
        for (const p of mapped) {
          const name = getProjectName(p.path).padEnd(25);
          console.log(`  ${fmt.value(name)} ${fmt.accent(p.team_name || "")}`);
        }
        console.log();
      }

      if (unmapped.length > 0) {
        console.log(`${fmt.muted("Private (Only Me):")}`);
        for (const p of unmapped.slice(0, 10)) {
          console.log(`  ${fmt.muted(getProjectName(p.path))}`);
        }
        if (unmapped.length > 10) {
          console.log(`  ${fmt.muted(`... and ${unmapped.length - 10} more`)}`);
        }
      }
      return;
    }

    if (action === "map") {
      if (!pathArg || !teamArg) {
        console.error("Usage: codecast teams map <path> <team_id_or_name>");
        process.exit(1);
      }

      const team = teams.find(t => t._id === teamArg || t.name.toLowerCase() === teamArg.toLowerCase());
      if (!team) {
        console.error(`Team not found: ${teamArg}`);
        console.error(`Available teams: ${teams.map(t => t.name).join(", ")}`);
        process.exit(1);
      }

      const absPath = path.resolve(pathArg);
      const success = await updateDirectoryMapping(config, absPath, team._id);
      if (success) {
        console.log(`${fmt.success(icons.check)} ${getProjectName(absPath)} now shares with ${fmt.accent(team.name)}`);
      } else {
        console.error("Failed to update mapping.");
        process.exit(1);
      }
      return;
    }

    if (action === "unmap") {
      if (!pathArg) {
        console.error("Usage: codecast teams unmap <path>");
        process.exit(1);
      }

      const absPath = path.resolve(pathArg);
      const success = await updateDirectoryMapping(config, absPath, null);
      if (success) {
        console.log(`${fmt.success(icons.check)} ${getProjectName(absPath)} is now private (Only Me)`);
      } else {
        console.error("Failed to update mapping.");
        process.exit(1);
      }
      return;
    }

    console.error(`Unknown action: ${action}`);
    console.error("Available actions: mappings, map, unmap");
    process.exit(1);
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

function parseRelativeDate(input: string): number | null {
  const now = Date.now();
  const lowered = input.toLowerCase().trim();

  if (lowered === "today") return new Date().setHours(0, 0, 0, 0);
  if (lowered === "yesterday") return now - 24 * 60 * 60 * 1000;

  const relMatch = lowered.match(/^(\d+)\s*(d|day|days|h|hour|hours|w|week|weeks)(\s*ago)?$/);
  if (relMatch) {
    const num = parseInt(relMatch[1]);
    const unit = relMatch[2][0];
    const ms = unit === "d" ? num * 24 * 60 * 60 * 1000
             : unit === "h" ? num * 60 * 60 * 1000
             : unit === "w" ? num * 7 * 24 * 60 * 60 * 1000 : 0;
    return now - ms;
  }

  const parsed = Date.parse(input);
  return isNaN(parsed) ? null : parsed;
}

program
  .command("search")
  .description(
    "Search conversation history for context\n\n" +
    "By default uses hybrid search (keyword + semantic).\n" +
    "Quotes matter: \"error handling\" matches exact phrase, error handling matches both words anywhere.\n" +
    "Use -g to search all sessions globally.\n" +
    "Use -u to search only user messages.\n" +
    "Use --keyword for keyword-only, --semantic for semantic-only.\n\n" +
    "Time formats: 2024-01-15, yesterday, 7d, 2w, 24h\n\n" +
    "Examples:\n" +
    "  codecast search auth                 # word match\n" +
    "  codecast search \"error handling\"    # exact phrase match\n" +
    "  codecast search auth -g -s 7d        # global, last 7 days"
  )
  .argument("<query>", "Search query (min 2 characters)")
  .option("-u, --user-only", "Search only user messages (excludes assistant responses)")
  .option("-g, --global", "Search all sessions (not just current project)")
  .option("-m, --member <name>", "Filter by team member name or email")
  .option("--keyword", "Use keyword-only search (no semantic matching)")
  .option("--semantic", "Use semantic-only search (no keyword matching)")
  .option("-s, --start <date>", "Start date/time (e.g., 7d, 2w, yesterday)")
  .option("-e, --end <date>", "End date/time")
  .option("-n, --limit <n>", "Results per page", "10")
  .option("-p, --page <n>", "Page number", "1")
  .option("-A, --after <n>", "Show N messages after each match", "0")
  .option("-B, --before <n>", "Show N messages before each match", "0")
  .option("-C, --context <n>", "Show N messages before and after each match")
  .action(async (query, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const contextBefore = options.context ? parseInt(options.context) : parseInt(options.before);
    const contextAfter = options.context ? parseInt(options.context) : parseInt(options.after);
    const limit = parseInt(options.limit);
    const page = parseInt(options.page);
    const offset = (page - 1) * limit;
    const projectPath = options.global ? undefined : getRealCwd();
    const userOnly = options.userOnly ?? false;

    let startTime: number | undefined;
    let endTime: number | undefined;

    if (options.start) {
      startTime = parseRelativeDate(options.start) ?? undefined;
      if (!startTime) {
        console.error(`Invalid start date: ${options.start}`);
        process.exit(1);
      }
    }
    if (options.end) {
      endTime = parseRelativeDate(options.end) ?? undefined;
      if (!endTime) {
        console.error(`Invalid end date: ${options.end}`);
        process.exit(1);
      }
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    // Determine search mode: hybrid (default), keyword, or semantic
    let mode: "hybrid" | "keyword" | "semantic" = "hybrid";
    if (options.keyword && options.semantic) {
      console.error("Cannot use both --keyword and --semantic flags");
      process.exit(1);
    } else if (options.keyword) {
      mode = "keyword";
    } else if (options.semantic) {
      mode = "semantic";
    }

    try {
      const response = await fetch(`${siteUrl}/cli/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          query,
          limit,
          offset,
          start_time: startTime,
          end_time: endTime,
          context_before: contextBefore,
          context_after: contextAfter,
          project_path: projectPath,
          user_only: userOnly,
          mode,
          member_name: options.member,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatSearchResults } = await import("./formatter.js");
      console.log(formatSearchResults(result, { projectPath }));
    } catch (error) {
      console.error("Search failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("feed")
  .description(
    "Browse recent conversations like a feed\n\n" +
    "By default, shows sessions from the current project.\n" +
    "Use -g to view all sessions globally.\n" +
    "Use -q to filter by keyword while keeping recency order.\n\n" +
    "Time formats: 2024-01-15, yesterday, 7d, 2w, 24h\n\n" +
    "Examples:\n" +
    "  codecast feed                    # recent sessions\n" +
    "  codecast feed -g                 # all projects globally\n" +
    "  codecast feed -s 7d              # last 7 days\n" +
    "  codecast feed -q auth            # recent sessions mentioning 'auth'\n" +
    "  codecast feed -p 2               # page 2 (skip first 10)"
  )
  .option("-g, --global", "Show all sessions (not just current project)")
  .option("-q, --query <text>", "Filter by keyword (keeps recency order)")
  .option("-m, --member <name>", "Filter by team member name or email")
  .option("-n, --limit <n>", "Number of conversations per page", "10")
  .option("-p, --page <n>", "Page number (1-indexed)", "1")
  .option("-s, --start <date>", "Start date/time (e.g., 7d, 2w, yesterday, 2024-01-15)")
  .option("-e, --end <date>", "End date/time")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const limit = parseInt(options.limit);
    const page = parseInt(options.page);
    const offset = (page - 1) * limit;
    const projectPath = options.global ? undefined : getRealCwd();
    const siteUrl = config.convex_url.replace(".cloud", ".site");

    let startTime: number | undefined;
    let endTime: number | undefined;

    if (options.start) {
      startTime = parseRelativeDate(options.start) ?? undefined;
      if (!startTime) {
        console.error(`Invalid start date: ${options.start}`);
        process.exit(1);
      }
    }
    if (options.end) {
      endTime = parseRelativeDate(options.end) ?? undefined;
      if (!endTime) {
        console.error(`Invalid end date: ${options.end}`);
        process.exit(1);
      }
    }

    try {
      const response = await fetch(`${siteUrl}/cli/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          limit,
          offset,
          start_time: startTime,
          end_time: endTime,
          query: options.query,
          project_path: projectPath,
          member_name: options.member,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatFeedResults } = await import("./formatter.js");
      console.log(formatFeedResults(result, { projectPath, page }));
    } catch (error) {
      console.error("Feed failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

interface LiveProcess {
  pid: number;
  tty: string;
  sessionId: string;
  agentType: "claude_code" | "codex";
  tmuxSession: string | null;
  label: string;
  uptime: string;
}

function normalizePsTty(tty: string): string {
  if (tty.startsWith("/dev/")) return tty;
  if (/^s\d+$/.test(tty)) return `/dev/tty${tty}`;
  return `/dev/${tty}`;
}

function discoverLiveProcesses(): LiveProcess[] {
  const procs: LiveProcess[] = [];
  const seen = new Set<number>();
  const seenTty = new Set<string>();

  const tmuxPanes: Record<string, string> = {};
  try {
    const out = execSync("tmux list-panes -a -F '#{pane_tty} #{session_name}' 2>/dev/null", { encoding: "utf-8" });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const i = line.indexOf(" ");
      if (i > 0) tmuxPanes[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {}

  const formatUptime = (startStr: string): string => {
    const start = new Date(startStr).getTime();
    if (isNaN(start)) return "?";
    const mins = Math.floor((Date.now() - start) / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h${mins % 60}m`;
    return `${Math.floor(hours / 24)}d${hours % 24}h`;
  };

  const addProcess = (pid: number, tty: string, sessionId: string, agentType: "claude_code" | "codex") => {
    const normalTty = normalizePsTty(tty);
    if (seen.has(pid) || seenTty.has(normalTty)) return;
    seen.add(pid);
    seenTty.add(normalTty);

    let startTime = "";
    try { startTime = execSync(`ps -o lstart= -p ${pid}`, { encoding: "utf-8" }).trim(); } catch {}

    const tmuxSession = tmuxPanes[normalTty] || null;
    let label = "iTerm";
    if (tmuxSession) {
      if (tmuxSession.startsWith("codecast-")) label = "managed";
      else if (tmuxSession.startsWith("cc-resume") || tmuxSession.startsWith("cx-resume")) label = "resumed";
      else label = "tmux";
    }

    procs.push({ pid, tty: normalTty, sessionId, agentType, tmuxSession, label, uptime: formatUptime(startTime) });
  };

  const findSessionByCwd = (pid: number): string | null => {
    let cwd: string | null = null;
    try {
      const out = execSync(`lsof -d cwd -a -p ${pid} -F n 2>/dev/null`, { encoding: "utf-8" });
      const line = out.split("\n").find(l => l.startsWith("n"));
      if (line) cwd = line.slice(1);
    } catch {}
    if (!cwd) return null;

    const claudeDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(claudeDir)) return null;
    let best: string | null = null;
    let bestMtime = 0;
    for (const dir of fs.readdirSync(claudeDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(claudeDir, dir.name)).filter(f => f.endsWith(".jsonl"))) {
        const fp = path.join(claudeDir, dir.name, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs <= bestMtime || Date.now() - stat.mtimeMs > 86_400_000) continue;
          const head = fs.readFileSync(fp, "utf-8").slice(0, 5000);
          for (const hl of head.split("\n").slice(0, 5)) {
            try {
              const e = JSON.parse(hl);
              if (e.cwd && (e.cwd === cwd || cwd!.startsWith(e.cwd + "/"))) { bestMtime = stat.mtimeMs; best = path.basename(fp, ".jsonl"); break; }
            } catch {}
          }
        } catch {}
      }
    }
    return best;
  };

  const findCodexSessionByCwd = (pid: number): string | null => {
    let cwd: string | null = null;
    try {
      const out = execSync(`lsof -d cwd -a -p ${pid} -F n 2>/dev/null`, { encoding: "utf-8" });
      const line = out.split("\n").find(l => l.startsWith("n"));
      if (line) cwd = line.slice(1);
    } catch {}
    if (!cwd) return null;

    const { extractCodexCwd } = require("./parser.js");
    const codexDir = path.join(os.homedir(), ".codex", "sessions");
    if (!fs.existsSync(codexDir)) return null;
    const walk = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { const r = walk(full); if (r) return r; }
        else if (entry.name.endsWith(".jsonl")) {
          try {
            const stat = fs.statSync(full);
            if (Date.now() - stat.mtimeMs > 86_400_000) continue;
            const content = fs.readFileSync(full, "utf-8").slice(0, 2000);
            const fileCwd = extractCodexCwd(content);
            if (fileCwd && (fileCwd === cwd || cwd!.startsWith(fileCwd + "/"))) {
              for (const l of content.split("\n")) {
                try { const e = JSON.parse(l); if (e.type === "session_meta" && e.payload?.id) return e.payload.id; } catch {}
              }
            }
          } catch {}
        }
      }
      return null;
    };
    return walk(codexDir);
  };

  // Claude processes
  try {
    const psOut = execSync("ps aux | grep -w claude | grep -v grep | grep -v 'bash -c' | grep -v codecast | grep -v mcp", { encoding: "utf-8" });
    for (const line of psOut.trim().split("\n")) {
      if (!line.trim() || line.includes("mcp")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const pid = parseInt(parts[1], 10);
      const tty = parts[6];
      if (isNaN(pid) || tty === "?" || tty === "??") continue;
      const args = parts.slice(10).join(" ");
      const resumeMatch = args.match(/--resume\s+([0-9a-f-]{36})/i);
      const sid = resumeMatch ? resumeMatch[1] : findSessionByCwd(pid);
      addProcess(pid, tty, sid || `unknown-${pid}`, "claude_code");
    }
  } catch {}

  // Codex processes
  try {
    const psOut = execSync("ps aux | grep -E 'codex/codex|/codex\\b' | grep -v grep | grep -v 'Codex.app' | grep -v Sparkle | grep -v Autoupdate | grep -v Helper | grep -v Renderer | grep -v Crashpad | grep -v app-server", { encoding: "utf-8" });
    for (const line of psOut.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const pid = parseInt(parts[1], 10);
      const tty = parts[6];
      if (isNaN(pid) || tty === "?" || tty === "??") continue;
      const sid = findCodexSessionByCwd(pid);
      addProcess(pid, tty, sid || `unknown-codex-${pid}`, "codex");
    }
  } catch {}

  return procs;
}

async function enrichAndFormatLiveSessions(procs: LiveProcess[], config: Config, offset = 0, limit = 50): Promise<{ output: string; sessions: LiveProcess[]; total: number; hasMore: boolean }> {
  const lines: string[] = [];

  if (procs.length === 0) {
    lines.push(`${c.dim}No live sessions found${c.reset}`);
    lines.push("");
    lines.push(`${c.dim}Start a session with:${c.reset}  claude`);
    lines.push(`${c.dim}Search history with:${c.reset}  codecast resume <query>`);
    return { output: lines.join("\n"), sessions: [], total: 0, hasMore: false };
  }

  // Deduplicate: if multiple processes share the same session ID, keep the one
  // with the most specific label (managed > resumed > tmux > iTerm) or most recent
  const dedupMap = new Map<string, LiveProcess>();
  const labelRank: Record<string, number> = { managed: 3, resumed: 2, tmux: 1, iTerm: 0 };
  for (const p of procs) {
    const existing = dedupMap.get(p.sessionId);
    if (!existing || (labelRank[p.label] ?? 0) > (labelRank[existing.label] ?? 0)) {
      dedupMap.set(p.sessionId, p);
    }
  }
  const dedupedProcs = Array.from(dedupMap.values());

  const sessionIds = dedupedProcs.filter(p => !p.sessionId.startsWith("unknown")).map(p => p.sessionId);
  const siteUrl = config.convex_url!.replace(".cloud", ".site");
  let convexData: Record<string, { title: string; subtitle: string | null; message_count: number; updated_at: string; preview?: string | null; agent_type?: string | null; project_path: string | null }> = {};

  if (sessionIds.length > 0) {
    try {
      const resp = await fetch(`${siteUrl}/cli/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: config.auth_token, session_ids: sessionIds }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        for (const conv of data.conversations || []) {
          convexData[conv.session_id] = conv;
        }
      }
    } catch {}
  }

  dedupedProcs.sort((a, b) => {
    const ca = convexData[a.sessionId];
    const cb = convexData[b.sessionId];
    if (ca && cb) return new Date(cb.updated_at).getTime() - new Date(ca.updated_at).getTime();
    if (ca && !cb) return -1;
    if (!ca && cb) return 1;
    return 0;
  });

  const total = dedupedProcs.length;
  const pageProcs = dedupedProcs.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  const pageInfo = total > limit
    ? `${c.dim}Showing ${offset + 1}-${offset + pageProcs.length} of ${total} live sessions${c.reset}`
    : `${c.dim}${total} live session${total === 1 ? "" : "s"}${c.reset}`;
  lines.push(pageInfo);
  lines.push("");

  const { formatRelativeTime } = await import("./formatter.js");

  for (let i = 0; i < pageProcs.length; i++) {
    const p = pageProcs[i];
    const conv = convexData[p.sessionId];
    const num = `${c.bold}${c.cyan}[${i + 1}]${c.reset}`;

    const title = conv?.title || `Session ${p.sessionId.startsWith("unknown") ? `PID ${p.pid}` : p.sessionId.slice(0, 8)}`;
    const displayTitle = title.length > 70 ? title.slice(0, 70) + "..." : title;
    lines.push(`${num} ${c.bold}${displayTitle}${c.reset}`);

    const meta: string[] = [];
    if (conv) {
      meta.push(`${c.dim}${formatRelativeTime(conv.updated_at)}${c.reset}`);
      meta.push(`${c.dim}${conv.message_count} msgs${c.reset}`);
    } else {
      meta.push(`${c.dim}up ${p.uptime}${c.reset}`);
    }

    const labelColor = p.label === "managed" ? c.green : p.label === "resumed" ? c.yellow : c.dim;
    meta.push(`${labelColor}${p.label}${c.reset}`);

    if (p.agentType === "codex" || conv?.agent_type === "codex") {
      meta.push(`${c.yellow}Codex${c.reset}`);
    }

    const projectPath = conv?.project_path;
    if (projectPath) {
      const home = os.homedir();
      const short = projectPath.startsWith(home) ? "~" + projectPath.slice(home.length) : projectPath;
      meta.push(`${c.dim}${short}${c.reset}`);
    }

    lines.push(`    ${meta.join(" | ")}`);

    if (conv?.preview) {
      const msgLine = conv.preview.split("\n")[0].trim();
      const maxLen = 85;
      lines.push(`    ${c.green}>${c.reset} ${msgLine.length > maxLen ? msgLine.slice(0, maxLen) + "..." : msgLine}`);
    }

    if (conv?.subtitle) {
      const subtitleLines = conv.subtitle.split("\n").filter((l: string) => l.trim());
      for (let j = 0; j < Math.min(subtitleLines.length, 3); j++) {
        const raw = subtitleLines[j].trim();
        lines.push(`      ${raw.length > 83 ? raw.slice(0, 83) + "..." : raw}`);
      }
      if (subtitleLines.length > 3) {
        lines.push(`      ${c.dim}... (${subtitleLines.length - 3} more)${c.reset}`);
      }
    }

    lines.push("");
  }

  const promptParts = ["Enter number to attach"];
  if (hasMore) promptParts.push("n for next page");
  promptParts.push("q to quit");
  lines.push(`${c.dim}${promptParts.join(", ")}${c.reset}`);

  return { output: lines.join("\n"), sessions: pageProcs, total, hasMore };
}

program
  .command("resume")
  .description(
    "List live sessions or resume by search query\n\n" +
    "With no arguments, shows all running Claude/Codex sessions.\n" +
    "With a query, searches history and opens the matching session.\n\n" +
    "Multiple words are AND-ed (all must match).\n" +
    "Use \"quotes\" for exact phrase matching.\n\n" +
    "Configure default args:\n" +
    "  codecast config claude_args \"--dangerously-skip-permissions\"\n" +
    "  codecast config codex_args \"--dangerously-bypass-approvals-and-sandbox\"\n\n" +
    "Examples:\n" +
    "  codecast resume                          # list live sessions\n" +
    "  codecast resume logo design              # search: 'logo' AND 'design'\n" +
    "  codecast resume \"logo design\"            # exact phrase\n" +
    "  codecast resume <session-id> --as codex  # convert/resume by exact session id\n" +
    "  codecast resume auth --as codex          # resume Claude session in Codex"
  )
  .argument("[query...]", "Search terms (AND-ed, use quotes for exact phrase)")
  .option("-g, --global", "Search all sessions (not just current project)")
  .option("-n, --limit <n>", "Max results to show (use -n 10 for more)", "4")
  .option("--dry-run", "Show matches without opening Claude")
  .option("--here", "Open session in current directory (don't switch to session's project)")
  .option("--as <agent>", "Resume in a different agent (claude or codex)")
  .option("--claude-args <args>", "Additional args to pass to claude (overrides config)")
  .option("--claude-tail <n>", "When converting to Claude, keep only the last N messages (+ a truncation notice)")
  .option("--claude-full", "When converting to Claude, do not auto-trim (may create a session too large for /compact)")
  .action(async (queryWords: string[], options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    if (options.as && !["claude", "codex"].includes(options.as.toLowerCase())) {
      console.error(`Invalid --as value: "${options.as}". Use "claude" or "codex".`);
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");

    // No query: show live sessions
    if (!queryWords || queryWords.length === 0) {
      const rawProcs = discoverLiveProcesses();
      let currentOffset = 0;
      const pageSize = 50;

      const showPage = async (): Promise<void> => {
        const { output, sessions, total, hasMore } = await enrichAndFormatLiveSessions(rawProcs, config, currentOffset, pageSize);
        console.log(output);

        if (total === 0) process.exit(0);

        const choices: Array<{ name: string; value: string }> = sessions.map((p, idx) => {
          const agent = p.agentType === "claude_code" ? "claude" : "codex";
          const id = p.sessionId.startsWith("unknown") ? `PID ${p.pid}` : p.sessionId.slice(0, 8);
          const where = p.tmuxSession ? `tmux:${p.tmuxSession}` : p.tty;
          return { name: `[${agent}] ${id} ${fmt.muted(`(${where})`)}`, value: String(idx) };
        });

        if (currentOffset > 0) choices.push({ name: fmt.muted("Prev page"), value: "__prev__" });
        if (hasMore) choices.push({ name: fmt.muted("Next page"), value: "__next__" });
        choices.push({ name: fmt.muted("Quit"), value: "__quit__" });

        const selected = await select({
          message: "Select a live session:",
          choices,
          pageSize: Math.min(12, choices.length),
        });

        if (selected === "__quit__") process.exit(0);
        if (selected === "__next__") {
          currentOffset += pageSize;
          await showPage();
          return;
        }
        if (selected === "__prev__") {
          currentOffset = Math.max(0, currentOffset - pageSize);
          await showPage();
          return;
        }

        const idx = parseInt(selected, 10);
        const p = sessions[idx];
        if (!p) process.exit(0);

        if (p.tmuxSession) {
          console.log(`\nAttaching to tmux session: ${p.tmuxSession}`);
          try {
            spawnSync("tmux", ["attach-session", "-t", p.tmuxSession], { stdio: "inherit" });
          } catch (err) {
            console.error(`Failed to attach: ${err instanceof Error ? err.message : err}`);
          }
        } else if (!p.sessionId.startsWith("unknown")) {
          console.log(`\nResuming: ${p.sessionId.slice(0, 8)}`);
          const extraArgs = resolveAgentArgs(p.agentType, options.claudeArgs, config);
          launchSession(p.sessionId, p.agentType, extraArgs, !extraArgs);
        } else {
          console.log(`\nSession PID ${p.pid} on ${p.tty} -- attach manually or use tmux`);
        }
      };

      await showPage();
      return;
    }

    const query = queryWords.join(" ");
    const limit = parseInt(options.limit);
    const projectPath = options.global ? undefined : getRealCwd();
    const exactSessionId = queryWords.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queryWords[0])
      ? queryWords[0]
      : null;

    if (exactSessionId) {
      try {
        const sessionLookupResponse = await fetch(`${siteUrl}/cli/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            session_ids: [exactSessionId],
          }),
        });

        if (sessionLookupResponse.ok) {
          const sessionLookup = await sessionLookupResponse.json() as {
            error?: string;
            conversations?: Array<{
              conversation_id?: string;
              session_id: string;
              title: string;
              agent_type: string | null;
              project_path: string | null;
            }>;
          };

          const matched = sessionLookup.conversations?.find((conv) => conv.session_id === exactSessionId);
          if (matched && matched.conversation_id) {
            const targetAgent = options.as?.toLowerCase();
            const sourceAgent = matched.agent_type || "claude_code";
            const normalizedSource = sourceAgent === "claude_code" ? "claude" : sourceAgent;

            if (options.dryRun) {
              if (targetAgent && targetAgent !== normalizedSource) {
                console.log(`Would convert ${normalizedSource} session ${exactSessionId} to ${targetAgent}`);
              } else {
                const effectiveAgent = targetAgent === "claude" ? "claude_code" : targetAgent === "codex" ? "codex" : sourceAgent;
                const cmd = effectiveAgent === "codex"
                  ? `codex resume ${exactSessionId}`
                  : `claude --resume ${exactSessionId}`;
                console.log(`Would run: ${cmd}`);
              }
              return;
            }

            console.log(`Opening: ${matched.title}`);
            if (targetAgent && targetAgent !== normalizedSource) {
              await convertAndLaunch(
                matched.conversation_id,
                normalizedSource,
                targetAgent,
                config,
                options.claudeArgs,
                options.claudeTail,
                options.claudeFull,
                false,
                options.here ? undefined : matched.project_path,
              );
            } else {
              const effectiveAgent = targetAgent === "claude" ? "claude_code" : targetAgent === "codex" ? "codex" : sourceAgent;
              const extraArgs = resolveAgentArgs(effectiveAgent, options.claudeArgs, config);
              launchSession(exactSessionId, effectiveAgent, extraArgs, !extraArgs, options.here ? undefined : matched.project_path);
            }
            return;
          }
        }
      } catch {
        // Fall through to regular search path.
      }
    }

    const extractGoalFromPreview = (preview: Array<{ role: string; content: string }> | undefined): string | undefined => {
      if (!preview) return undefined;
      const firstUser = preview.find((m) => m.role === "user");
      return firstUser?.content;
    };

    const extractPreviewText = (preview: Array<{ role: string; content: string }> | undefined): string | undefined => {
      if (!preview || preview.length === 0) return undefined;
      const firstNonEmpty = preview.find((m) => m.content && m.content.trim().length > 0);
      return firstNonEmpty?.content;
    };

    const enrichResumeConversations = (convs: any[]): any[] => convs.map((conv: any) => ({
      ...conv,
      preview: extractPreviewText(conv.preview),
      goal: extractGoalFromPreview(conv.preview),
    }));

    const fetchResumePage = async (offset: number): Promise<{ conversations: any[]; hasMore: boolean }> => {
      const response = await fetch(`${siteUrl}/cli/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          limit: limit + 1,
          offset,
          query,
          project_path: projectPath,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logCliError("resume", `HTTP ${response.status}: ${text.slice(0, 200)}`);
        console.error(`Server error: ${response.status}`);
        process.exit(1);
      }

      const responseText = await response.text();
      let result: { error?: string; conversations?: Array<{ id: string; title: string; subtitle?: string | null; project_path: string | null; updated_at: string; message_count: number; session_id?: string; agent_type?: string; user?: { name: string | null; email: string | null }; preview?: Array<{ role: string; content: string }> }> };
      try {
        result = JSON.parse(responseText);
      } catch {
        logCliError("resume", `Invalid JSON response: ${responseText.slice(0, 200)}`);
        console.error("Server returned invalid response");
        process.exit(1);
      }

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      const raw = result.conversations || [];
      const hasMore = raw.length > limit;
      const pageItems = hasMore ? raw.slice(0, limit) : raw;
      return { conversations: enrichResumeConversations(pageItems), hasMore };
    };

    try {
      let offset = 0;
      let page: { conversations: any[]; hasMore: boolean } | null = null;

      // Fetch the first page once so we can keep "single result" behavior.
      page = await fetchResumePage(offset);
      const conversations = page.conversations || [];

      if (conversations.length === 0) {
        console.log(`No sessions found matching "${query}"`);
        console.log("");
        console.log("Try:");
        console.log("  codecast resume \"different query\"");
        console.log("  codecast feed -g  # browse all sessions");
        process.exit(0);
      }

      const enrichedConversations = conversations;

      if (conversations.length === 1 && !options.dryRun) {
        const conv = conversations[0];
        const sessionId = conv.session_id;
        if (!sessionId) {
          console.error("Session ID not found for this conversation");
          process.exit(1);
        }
        console.log(`Opening: ${conv.title}`);
        const targetAgent = options.as?.toLowerCase();
        const sourceAgent = conv.agent_type || "claude_code";
        const normalizedSource = sourceAgent === "claude_code" ? "claude" : sourceAgent;
        if (targetAgent && targetAgent !== normalizedSource) {
          await convertAndLaunch(conv.id, normalizedSource, targetAgent, config, options.claudeArgs, options.claudeTail, options.claudeFull, false, options.here ? undefined : conv.project_path);
        } else {
          const effectiveAgent = targetAgent === "claude" ? "claude_code" : targetAgent === "codex" ? "codex" : conv.agent_type;
          const extraArgs = resolveAgentArgs(effectiveAgent, options.claudeArgs, config);
          launchSession(sessionId, effectiveAgent, extraArgs, !extraArgs, options.here ? undefined : conv.project_path);
        }
        return;
      }

      if (options.dryRun) {
        const { formatResumeResults } = await import("./formatter.js");
        console.log(formatResumeResults({ conversations: enrichedConversations, query }));
        process.exit(0);
      }

      const getAgentLabel = (agentType?: string): string | null => {
        if (!agentType || agentType === "claude_code" || agentType === "claude") return "Claude";
        if (agentType === "codex" || agentType === "codex_cli") return "Codex";
        if (agentType === "cursor") return "Cursor";
        return agentType;
      };

      const formatResumeChoice = (conv: any): string => {
        const title = conv.title || "Untitled";
        const relTime = formatRelativeTime(conv.updated_at);
        const meta: string[] = [
          `${c.dim}${relTime}${c.reset}`,
          `${c.dim}${conv.message_count} msgs${c.reset}`,
        ];
        if (conv.user) {
          const name = conv.user.name || conv.user.email || "team member";
          meta.push(`${c.magenta}${name}${c.reset}`);
        }
        const label = getAgentLabel(conv.agent_type);
        if (label) meta.push(`${c.yellow}${label}${c.reset}`);
        if (conv.project_path) meta.push(`${c.dim}${truncatePath(conv.project_path)}${c.reset}`);

        const lines: string[] = [];
        lines.push(`${c.bold}${title}${c.reset}`);
        lines.push(`  ${meta.join(" | ")}`);

        const firstMessage = conv.goal || conv.preview;
        if (firstMessage) {
          const msgLine = String(firstMessage).split("\n")[0].trim();
          const maxLen = 85;
          lines.push(`  ${c.green}>${c.reset} ${msgLine.length > maxLen ? msgLine.slice(0, maxLen) + "..." : msgLine}`);
        }

        if (conv.subtitle) {
          const subtitleLines = String(conv.subtitle).split("\n").filter((l) => l.trim());
          const maxLines = 2;
          const maxLineLen = 83;
          for (let j = 0; j < Math.min(subtitleLines.length, maxLines); j++) {
            const rawLine = subtitleLines[j].trim();
            lines.push(`    ${rawLine.length > maxLineLen ? rawLine.slice(0, maxLineLen) + "..." : rawLine}`);
          }
          if (subtitleLines.length > maxLines) {
            lines.push(`    ${c.dim}... (${subtitleLines.length - maxLines} more)${c.reset}`);
          }
        }

        return lines.join("\n");
      };

      // Interactive picker with pagination + rich session cards.
      while (true) {
        const current = page?.conversations || [];
        if (current.length === 0) {
          console.log(`No sessions found matching "${query}"`);
          process.exit(0);
        }

        const choices: Array<{ name: string; value: string }> = current.map((conv: any) => {
          const sid = conv.session_id ? String(conv.session_id).slice(0, 8) : "unknown";
          return { name: `${formatResumeChoice(conv)}\n${fmt.muted(`  id: ${sid}`)}`, value: String(conv.id) };
        });

        if (offset > 0) choices.push({ name: fmt.muted("Prev page"), value: "__prev__" });
        if (page?.hasMore) choices.push({ name: fmt.muted("Next page"), value: "__next__" });
        choices.push({ name: fmt.muted("Quit"), value: "__quit__" });

        const selectedId = await select({
          message: `Select a session (${offset + 1}-${offset + current.length}${page?.hasMore ? "+" : ""}):`,
          choices,
          pageSize: Math.min(12, choices.length),
        });

        if (selectedId === "__quit__") process.exit(0);
        if (selectedId === "__next__") {
          offset += limit;
          page = await fetchResumePage(offset);
          continue;
        }
        if (selectedId === "__prev__") {
          offset = Math.max(0, offset - limit);
          page = await fetchResumePage(offset);
          continue;
        }

        const conv = current.find((c: any) => String(c.id) === selectedId) || conversations.find((c: any) => String(c.id) === selectedId);
        if (!conv) {
          console.error("Selected session not found");
          process.exit(1);
        }

        const sessionId = conv.session_id;
        if (!sessionId) {
          console.error("Session ID not found");
          process.exit(1);
        }

        const sourceAgent = conv.agent_type || "claude_code";
        const normalizedSource = sourceAgent === "claude_code" ? "claude" : sourceAgent;

        const targetAgent =
          options.as?.toLowerCase() ||
          await select({
            message: "Resume in:",
            choices: [
              { name: "claude", value: "claude" },
              { name: "codex", value: "codex" },
            ],
            default: normalizedSource === "codex" ? "codex" : "claude",
          });

        console.log(`\nOpening: ${conv.title}`);
        if (targetAgent && targetAgent !== normalizedSource) {
          await convertAndLaunch(conv.id, normalizedSource, targetAgent, config, options.claudeArgs, options.claudeTail, options.claudeFull, false, options.here ? undefined : conv.project_path);
        } else {
          const effectiveAgent = targetAgent === "claude" ? "claude_code" : targetAgent === "codex" ? "codex" : conv.agent_type;
          const extraArgs = resolveAgentArgs(effectiveAgent, options.claudeArgs, config);
          launchSession(sessionId, effectiveAgent, extraArgs, !extraArgs, options.here ? undefined : conv.project_path);
        }
        return;
      }
    } catch (error) {
      console.error("Resume failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

function resolveAgentArgs(agentType: string | undefined, cliOverride: string | undefined, config: Config): string | undefined {
  if (cliOverride) return cliOverride;
  if (agentType === "codex") return config.codex_args;
  return config.claude_args;
}

async function convertAndLaunch(
  conversationId: string,
  sourceAgent: string,
  targetAgent: string,
  config: Config,
  extraArgs?: string,
  claudeTail?: string,
  claudeFull?: boolean,
  showArgsHint?: boolean,
  projectPath?: string | null,
): Promise<void> {
  const siteUrl = config.convex_url!.replace(".cloud", ".site");
  console.log(`Converting ${sourceAgent} session to ${targetAgent} format...`);
  const data = await fetchExport(siteUrl, config.auth_token!, conversationId);
  console.log(`  ${data.messages.length} messages exported`);

  if (targetAgent === "codex") {
    const { jsonl, sessionId } = generateCodexJsonl(data);
    writeCodexSession(jsonl, sessionId, "cc-import");
    console.log(`  Written Codex session: ${sessionId}`);
    const resolvedArgs = extraArgs ?? config.codex_args;
    launchCodex(sessionId, resolvedArgs, showArgsHint, projectPath);
  } else {
    const CLAUDE_CONTEXT_LIMIT_TOKENS = 200_000;
    const AUTO_TRIM_THRESHOLD_TOKENS = 150_000;
    const AUTO_TRIM_TARGET_TOKENS = 120_000;

    const estimatedTokens = estimateClaudeImportTokens(data);
    let tailMessages: number | undefined;
    let noTrim = !!claudeFull;

    if (claudeTail != null) {
      const n = parseInt(String(claudeTail), 10);
      if (Number.isFinite(n) && n > 0) {
        tailMessages = n;
        console.log(`  Trimming Claude import to last ${tailMessages} messages (--claude-tail)`);
      } else {
        noTrim = true;
        console.log(`  Claude import trimming disabled (--claude-tail ${claudeTail})`);
      }
    } else if (!noTrim && estimatedTokens > AUTO_TRIM_THRESHOLD_TOKENS) {
      tailMessages = chooseClaudeTailMessagesForTokenBudget(data, AUTO_TRIM_TARGET_TOKENS);
      console.log(
        `  Claude context window is ~${CLAUDE_CONTEXT_LIMIT_TOKENS.toLocaleString()} tokens; import estimates ~${estimatedTokens.toLocaleString()} tokens.\n` +
        `  Auto-trimming to last ${tailMessages} messages (target ~${AUTO_TRIM_TARGET_TOKENS.toLocaleString()} tokens) to keep Claude Code /compact usable.\n` +
        `  Disable with --claude-full (or --claude-tail 0).`
      );
    }

    const { jsonl, sessionId } = generateClaudeCodeJsonl(data, { tailMessages });
    writeClaudeCodeSession(jsonl, sessionId, projectPath || undefined);
    console.log(`  Written Claude Code session: ${sessionId}`);
    const resolvedArgs = extraArgs ?? config.claude_args;
    launchClaude(sessionId, resolvedArgs, showArgsHint, projectPath);
  }
}

function launchSession(sessionId: string, agentType?: string, extraArgs?: string, showArgsHint?: boolean, projectPath?: string | null): void {
  if (agentType === "codex") {
    launchCodex(sessionId, extraArgs, showArgsHint, projectPath);
  } else if (agentType === "cursor") {
    console.error("Cursor sessions cannot be resumed from the command line.");
    console.log("Open Cursor IDE to continue this session.");
    process.exit(1);
  } else {
    launchClaude(sessionId, extraArgs, showArgsHint, projectPath);
  }
}

function launchCodex(sessionId: string, extraArgs?: string, showArgsHint?: boolean, projectPath?: string | null): void {
  const args = ["resume", sessionId];

  if (extraArgs) {
    const parsedArgs = extraArgs.split(/\s+/).filter((a) => a.length > 0);
    args.push(...parsedArgs);
    console.log(`Using: codex ${args.join(" ")}`);
  } else if (showArgsHint) {
    console.log(`\nTip: Set default codex args with: codecast config codex_args -- "--dangerously-bypass-approvals-and-sandbox"`);
  }

  let cwd = process.cwd();
  if (projectPath && projectPath !== process.cwd()) {
    if (fs.existsSync(projectPath)) {
      cwd = projectPath;
      console.log(`Switching to: ${projectPath}`);
    } else {
      console.log(`Warning: Session path not found: ${projectPath}`);
      console.log(`Using current directory instead`);
    }
  }

  console.log("");

  const codex = spawn("codex", args, {
    stdio: "inherit",
    shell: true,
    cwd,
  });

  codex.on("error", (err) => {
    console.error("Failed to launch Codex:", err.message);
    console.log("\nMake sure Codex CLI is installed:");
    console.log("  npm install -g @openai/codex");
    process.exit(1);
  });

  codex.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

function openInNewTab(cmd: string, cwd?: string | null): void {
  const dir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const escapedCmd = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedDir = dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "iTerm2"
    tell current window
      create tab with default profile
      tell current session
        write text "cd \\"${escapedDir}\\" && ${escapedCmd}"
      end tell
    end tell
  end tell`;
  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: "ignore" });
    console.log("Opened in new iTerm tab.");
  } catch {
    console.log(`\nCouldn't open iTerm tab. Run manually:\n  cd ${dir} && ${cmd}`);
  }
}

function launchClaude(sessionId: string, extraArgs?: string, showArgsHint?: boolean, projectPath?: string | null): void {
  const args = ["--resume", sessionId];

  if (extraArgs) {
    const parsedArgs = extraArgs.split(/\s+/).filter((a) => a.length > 0);
    args.push(...parsedArgs);
    console.log(`Using: claude ${args.join(" ")}`);
  } else if (showArgsHint) {
    console.log(`\nTip: Set default claude args with: codecast config claude_args -- "--dangerously-skip-permissions"`);
  }

  let cwd = process.cwd();
  if (projectPath && projectPath !== process.cwd()) {
    if (fs.existsSync(projectPath)) {
      cwd = projectPath;
      console.log(`Switching to: ${projectPath}`);
    } else {
      console.log(`Warning: Session path not found: ${projectPath}`);
      console.log(`Using current directory instead`);
    }
  }

  console.log("");

  const claude = spawn("claude", args, {
    stdio: "inherit",
    shell: true,
    cwd,
  });

  claude.on("error", (err) => {
    console.error("Failed to launch Claude:", err.message);
    console.log("\nMake sure Claude Code is installed:");
    console.log("  npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  });

  claude.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

program
  .command("read")
  .description(
    "Read messages from a conversation\n\n" +
    "Examples:\n" +
    "  codecast read jx70ntf                   # Read all messages\n" +
    "  codecast read jx70ntf 12:20             # Read messages 12-20\n" +
    "  codecast read jx70ntf 12:               # Read from message 12 to end\n" +
    "  codecast read jx70ntf :20               # Read first 20 messages\n" +
    "  codecast read jx70ntf 15                # Read single message 15\n" +
    "  codecast read jx70ntf 10:15 --full      # Show full tool call/result content"
  )
  .argument("<conversation-id>", "Conversation ID (can be truncated)")
  .argument("[range]", "Message range (e.g., 12:20, 12:, :20, 15)")
  .option("-f, --full", "Show full tool call and tool result content")
  .action(async (conversationId, range, options) => {
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
        const msg = result.details ? `${result.error}: ${result.details}` : result.error;
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      const { formatReadResult } = await import("./formatter.js");
      console.log(formatReadResult(result, { full: options.full }));
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

function getExecutableInfo(command = "_daemon"): { executablePath: string; args: string[] } {
  const isBundle = __filename.includes("/dist/") || __filename.includes("/build/");
  const isBinary = !__filename.endsWith(".ts") && !__filename.endsWith(".js");

  if (isBinary) {
    return { executablePath: process.argv[0], args: ["--", command] };
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
  const watchdogPlistPath = path.join(launchAgentsDir, "sh.codecast.watchdog.plist");
  const uid = `gui/${process.getuid!()}`;

  if (disable) {
    if (!fs.existsSync(plistPath) && !fs.existsSync(watchdogPlistPath)) {
      console.log("Auto-start is not enabled");
      return;
    }
    spawnSync("launchctl", ["bootout", uid, plistPath], { stdio: "ignore" });
    spawnSync("launchctl", ["bootout", uid, watchdogPlistPath], { stdio: "ignore" });
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    if (fs.existsSync(watchdogPlistPath)) fs.unlinkSync(watchdogPlistPath);
    console.log("Auto-start disabled (daemon + watchdog removed)");
    return;
  }

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Daemon plist
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

  spawnSync("launchctl", ["bootout", uid, plistPath], { stdio: "ignore" });
  fs.writeFileSync(plistPath, plistContent, { mode: 0o644 });
  spawnSync("launchctl", ["bootstrap", uid, plistPath], { stdio: "ignore" });
  console.log("Daemon LaunchAgent installed");

  // Watchdog plist (runs every 5 minutes, independent of daemon)
  const wdInfo = getExecutableInfo("_watchdog");
  const wdArgs = [wdInfo.executablePath, ...wdInfo.args]
    .map((arg) => `    <string>${arg}</string>`)
    .join("\n");

  const watchdogPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.watchdog</string>
  <key>ProgramArguments</key>
  <array>
${wdArgs}
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/watchdog.out.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/watchdog.err.log</string>
</dict>
</plist>
`;

  spawnSync("launchctl", ["bootout", uid, watchdogPlistPath], { stdio: "ignore" });
  fs.writeFileSync(watchdogPlistPath, watchdogPlistContent, { mode: 0o644 });
  const wdResult = spawnSync("launchctl", ["bootstrap", uid, watchdogPlistPath], { stdio: "ignore" });
  console.log("Watchdog LaunchAgent installed (checks every 5min)");

  console.log(`\nDaemon: ${executablePath} ${args.join(" ")}`);
  console.log("Auto-start enabled with watchdog");
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

function ensureAutostart(): boolean {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const home = process.env.HOME;
      if (!home) return false;
      const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
      const plistPath = path.join(launchAgentsDir, "sh.codecast.daemon.plist");
      const watchdogPlistPath = path.join(launchAgentsDir, "sh.codecast.watchdog.plist");
      const uid = `gui/${process.getuid!()}`;
      const daemonExists = fs.existsSync(plistPath);
      const watchdogExists = fs.existsSync(watchdogPlistPath);
      if (daemonExists && watchdogExists) return true;

      if (!fs.existsSync(launchAgentsDir)) {
        fs.mkdirSync(launchAgentsDir, { recursive: true });
      }

      if (!daemonExists) {
        const { executablePath, args } = getExecutableInfo();
        const programArgs = [executablePath, ...args].map((arg) => `    <string>${arg}</string>`).join("\n");
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
        fs.writeFileSync(plistPath, plistContent, { mode: 0o644 });
        spawnSync("launchctl", ["bootstrap", uid, plistPath], { stdio: "ignore" });
      }

      if (!watchdogExists) {
        const wdInfo = getExecutableInfo("_watchdog");
        const wdArgs = [wdInfo.executablePath, ...wdInfo.args].map((arg) => `    <string>${arg}</string>`).join("\n");
        const wdContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.watchdog</string>
  <key>ProgramArguments</key>
  <array>
${wdArgs}
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/watchdog.out.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/watchdog.err.log</string>
</dict>
</plist>
`;
        fs.writeFileSync(watchdogPlistPath, wdContent, { mode: 0o644 });
        spawnSync("launchctl", ["bootstrap", uid, watchdogPlistPath], { stdio: "ignore" });
      }
      return true;
    } else if (platform === "linux") {
      const home = process.env.HOME;
      if (!home) return false;
      const servicePath = path.join(home, ".config", "systemd", "user", "codecast.service");
      if (fs.existsSync(servicePath)) return true; // Already set up

      const systemdUserDir = path.join(home, ".config", "systemd", "user");
      if (!fs.existsSync(systemdUserDir)) {
        fs.mkdirSync(systemdUserDir, { recursive: true });
      }

      const { executablePath, args } = getExecutableInfo();
      const execStart = [executablePath, ...args].join(" ");
      const serviceContent = `[Unit]
Description=Codecast Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
      fs.writeFileSync(servicePath, serviceContent, { mode: 0o644 });
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      spawnSync("systemctl", ["--user", "enable", "codecast.service"], { stdio: "ignore" });
      return true;
    }
    return false;
  } catch {
    return false;
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
  .command("links")
  .description(
    "Get dashboard and share URLs for the current session\n\n" +
    "Examples:\n" +
    "  codecast links              # Get links for current project\n" +
    "  codecast links --json       # Output as JSON\n" +
    "  codecast links -s abc123    # Specific session ID"
  )
  .option("--json", "Output as JSON")
  .option("-s, --session <id>", "Specific session ID (default: most recent)")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    let sessionId = options.session;

    // Find git root - Claude Code stores sessions at the git root level
    let projectRoot = process.cwd();
    try {
      projectRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
    } catch {
      // Not a git repo, use CWD
    }

    if (!sessionId) {
      // First try: trace from parent Claude process (most reliable for concurrent sessions)
      sessionId = findCurrentSessionFromProcess(projectRoot);
      if (sessionId && process.env.DEBUG) {
        console.error(`[DEBUG] Found session from process: ${sessionId}`);
      }
    }

    if (!sessionId) {
      // Fallback: find most recently active session file
      const projectDir = projectRoot.replace(/\//g, "-");
      const sessionsDir = path.join(process.env.HOME || "", ".claude", "projects", projectDir);

      if (!fs.existsSync(sessionsDir)) {
        console.error("No Claude Code sessions found for current project");
        console.error(`Looked in: ${sessionsDir}`);
        process.exit(1);
      }

      const now = Date.now();
      const ACTIVE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

      const files = fs.readdirSync(sessionsDir)
        .filter(f => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(f))
        .map(f => ({
          name: f,
          path: path.join(sessionsDir, f),
          mtime: fs.statSync(path.join(sessionsDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        console.error("No session files found for current project");
        process.exit(1);
      }

      // Check if there's exactly one recently active session
      const activeSessions = files.filter(f => now - f.mtime < ACTIVE_THRESHOLD);

      if (process.env.DEBUG) {
        console.error(`[DEBUG] Found ${files.length} sessions, ${activeSessions.length} active in last 5min`);
        for (const f of files.slice(0, 5)) {
          const age = Math.round((now - f.mtime) / 1000);
          console.error(`[DEBUG]   ${path.basename(f.name, ".jsonl").slice(0, 8)}... age=${age}s`);
        }
      }

      if (activeSessions.length === 1) {
        sessionId = path.basename(activeSessions[0].name, ".jsonl");
      } else if (activeSessions.length > 1) {
        // Multiple active sessions - try self-validation: find session with most recent codecast command
        interface SessionWithCodecast {
          session: typeof activeSessions[0];
          timestamp: number;
        }
        const candidatesWithCodecast: SessionWithCodecast[] = [];
        const RECENT_THRESHOLD = 30000; // 30 seconds

        for (const session of activeSessions) {
          try {
            const content = fs.readFileSync(session.path, "utf-8");
            const lines = content.split("\n").slice(-100); // check last 100 lines
            for (let i = lines.length - 1; i >= 0; i--) {
              const line = lines[i];
              // Look for codecast links command (production or dev)
              const isCodecastCommand = (line.includes("codecast links") || line.includes("index.ts links")) && line.includes("Bash");
              if (isCodecastCommand) {
                try {
                  const entry = JSON.parse(line);
                  // Timestamp can be ISO string or number
                  let ts = 0;
                  if (typeof entry.timestamp === "string") {
                    ts = new Date(entry.timestamp).getTime();
                  } else if (typeof entry.timestamp === "number") {
                    ts = entry.timestamp;
                  }
                  if (ts > 0 && Date.now() - ts < RECENT_THRESHOLD) {
                    candidatesWithCodecast.push({ session, timestamp: ts });
                  }
                } catch {
                  // use mtime as fallback timestamp
                  if (Date.now() - session.mtime < RECENT_THRESHOLD) {
                    candidatesWithCodecast.push({ session, timestamp: session.mtime });
                  }
                }
                break;
              }
            }
          } catch {
            // ignore read errors
          }
        }

        if (candidatesWithCodecast.length > 0) {
          // Pick the one with the most recent codecast command
          candidatesWithCodecast.sort((a, b) => b.timestamp - a.timestamp);
          sessionId = path.basename(candidatesWithCodecast[0].session.name, ".jsonl");
          if (process.env.DEBUG) {
            console.error(`[DEBUG] Self-validated session: ${sessionId.slice(0, 8)} (${candidatesWithCodecast.length} candidates)`);
          }
        } else {
          // Fall back to most recent mtime
          sessionId = path.basename(activeSessions[0].name, ".jsonl");
          console.error(`Note: ${activeSessions.length} active sessions found. Using most recent. Use -s <id> to specify.`);
        }
      } else {
        // No active sessions - use most recent overall
        sessionId = path.basename(files[0].name, ".jsonl");
      }
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    const getLinks = async (): Promise<{ dashboard_url: string; share_url: string; title?: string; slug?: string; started_at?: number } | null> => {
      const response = await fetch(`${siteUrl}/cli/session-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          api_token: config.auth_token,
        }),
      });
      const result = await response.json();
      if (result.error) {
        return null;
      }
      return result;
    };

    try {
      let result = await getLinks();

      if (!result) {
        console.log("Session not found on server. Syncing...");
        const synced = await syncSingleSession(sessionId, projectRoot);
        if (synced) {
          console.log("Sync complete. Getting links...\n");
          result = await getLinks();
        }
      }

      if (!result) {
        console.error("Error: Session not found. Make sure the session exists and has been synced.");
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const context = result.title || result.slug || sessionId.slice(0, 8);
        console.log(`\nSession: ${context}`);
        console.log(`Share Link: ${result.dashboard_url}`);
      }
    } catch (error) {
      console.error("Failed to get links:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("diff")
  .description(
    "Show the impact of a session - files changed, commits made, tools used\n\n" +
    "Examples:\n" +
    "  codecast diff <session-id>     # show changes from session\n" +
    "  codecast diff --today          # aggregate today's sessions\n" +
    "  codecast diff --week           # this week's changes"
  )
  .argument("[session-id]", "Session ID to analyze")
  .option("--today", "Aggregate changes from today's sessions")
  .option("--week", "Aggregate changes from this week's sessions")
  .action(async (sessionId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const projectPath = process.cwd();

    if (options.today || options.week) {
      const now = Date.now();
      const startTime = options.today
        ? new Date().setHours(0, 0, 0, 0)
        : now - 7 * 24 * 60 * 60 * 1000;

      const feedResponse = await fetch(`${siteUrl}/cli/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          limit: 50,
          offset: 0,
          start_time: startTime,
          project_path: projectPath,
        }),
      });

      const feedResult = await feedResponse.json();
      if (feedResult.error) {
        console.error(`Error: ${feedResult.error}`);
        process.exit(1);
      }

      if (!feedResult.conversations || feedResult.conversations.length === 0) {
        console.log(`No sessions found for ${options.today ? "today" : "this week"}`);
        process.exit(0);
      }

      const allSessions: Array<{
        id: string;
        title: string;
        messages: Array<{ tool_calls?: Array<{ name?: string; input?: unknown }>; timestamp?: string }>;
      }> = [];

      for (const conv of feedResult.conversations) {
        const result = await fetchAllMessages(siteUrl, config.auth_token, conv.id, 200);
        if ("error" in result) {
          console.error(`Error: ${result.error}`);
          continue;
        }
        allSessions.push({
          id: conv.id,
          title: conv.title,
          messages: result.messages,
        });
      }

      const { formatDiffResults } = await import("./formatter.js");
      console.log(formatDiffResults({
        sessions: allSessions,
        aggregated: true,
        period: options.today ? "today" : "week",
      }));
    } else {
      if (!sessionId) {
        let projectRoot = process.cwd();
        try {
          projectRoot = execSync("git rev-parse --show-toplevel", {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
          }).trim();
        } catch {
          // Not a git repo
        }

        const historyPath = path.join(process.env.HOME || "", ".claude", "history.jsonl");
        if (fs.existsSync(historyPath)) {
          const historyContent = fs.readFileSync(historyPath, "utf-8");
          const lines = historyContent.trim().split("\n").reverse();
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.project === projectRoot && entry.sessionId) {
                sessionId = entry.sessionId;
                break;
              }
            } catch {
              // Skip malformed
            }
          }
        }

        if (!sessionId) {
          console.error("No session ID provided and could not detect current session");
          console.error("Usage: codecast diff <session-id>");
          process.exit(1);
        }
      }

      const result = await fetchAllMessages(siteUrl, config.auth_token, sessionId);
      if ("error" in result) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatDiffResults } = await import("./formatter.js");
      console.log(formatDiffResults({
        sessions: [{
          id: result.conversation.id,
          title: result.conversation.title,
          messages: result.messages,
        }],
        aggregated: false,
      }));
    }
  });

program
  .command("handoff")
  .description(
    "Generate a context transfer document for the next session/agent\n\n" +
    "Examples:\n" +
    "  codecast handoff                        # from current/recent session\n" +
    "  codecast handoff --session abc123       # from specific session\n" +
    "  codecast handoff --to-file /tmp/h.md    # save to file"
  )
  .option("-s, --session <id>", "Specific session ID (default: most recent)")
  .option("-o, --to-file <path>", "Save output to file instead of stdout")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    let sessionId = options.session;

    if (!sessionId) {
      let projectRoot = process.cwd();
      try {
        projectRoot = execSync("git rev-parse --show-toplevel", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch {
      }

      try {
        const feedResponse = await fetch(`${siteUrl}/cli/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            project_path: projectRoot,
            limit: 1,
          }),
        });
        const feedResult = await feedResponse.json();
        if (feedResult.conversations && feedResult.conversations.length > 0) {
          sessionId = feedResult.conversations[0].id;
        }
      } catch {
      }

      if (!sessionId) {
        console.error("No synced sessions found for current project. Use -s to specify a session ID.");
        process.exit(1);
      }
    }

    try {
      const result = await fetchAllMessages(siteUrl, config.auth_token, sessionId);

      if ("error" in result) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatHandoff } = await import("./formatter.js");
      const output = formatHandoff(result);

      if (options.toFile) {
        fs.writeFileSync(options.toFile, output);
        console.log(`Handoff saved to: ${options.toFile}`);
      } else {
        console.log(output);
      }
    } catch (error) {
      console.error("Handoff failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("summary")
  .description(
    "Generate a concise summary of a session\n\n" +
    "Examples:\n" +
    "  codecast summary <session-id>    # Summarize specific session\n" +
    "  codecast summary --today         # Summarize today's work"
  )
  .argument("[session-id]", "Session ID to summarize")
  .option("--today", "Summarize today's most recent session")
  .action(async (sessionId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    if (!sessionId && !options.today) {
      console.error("Provide a session-id or use --today");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (options.today) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const feedResponse = await fetch(`${siteUrl}/cli/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          limit: 1,
          offset: 0,
          start_time: todayStart.getTime(),
        }),
      });

      const feedResult = await feedResponse.json();
      if (feedResult.error) {
        console.error(`Error: ${feedResult.error}`);
        process.exit(1);
      }

      if (!feedResult.conversations || feedResult.conversations.length === 0) {
        console.error("No sessions found today");
        process.exit(1);
      }

      sessionId = feedResult.conversations[0].id;
    }

    try {
      const result = await fetchAllMessages(siteUrl, config.auth_token, sessionId);

      if ("error" in result) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatSummary } = await import("./formatter.js");
      console.log(formatSummary(result));
    } catch (error) {
      console.error("Summary failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("memory")
  .description("Install or update the agent memory component")
  .option("--disable", "Disable memory (remove snippet and save preference)")
  .action(async (options) => {
    const config = readConfig() || {};

    if (options.disable) {
      config.memory_enabled = false;
      writeConfig(config);
      console.log("Memory disabled. Snippet will not be added/updated.");
      console.log("Run 'codecast memory' to re-enable.");
      return;
    }

    const result = installMemorySnippet(true);
    config.memory_enabled = true;
    config.memory_version = getMemoryVersion();
    writeConfig(config);

    const targets = getSnippetTargets();
    const targetList = targets.map(t => t.label).join(", ");
    if (result.updated) {
      console.log(`Memory snippet updated in ${targetList}`);
    } else if (result.installed) {
      console.log(`Memory snippet installed in ${targetList}`);
    } else {
      console.log("Memory snippet is up to date.");
    }
  });

program
  .command("bookmark")
  .description(
    "Bookmark a specific message in a conversation\n\n" +
    "Examples:\n" +
    "  codecast bookmark abc123 42                     # bookmark message 42\n" +
    "  codecast bookmark abc123 42 --name auth-fix    # with a name\n" +
    "  codecast bookmark abc123 42 --note \"key insight\"  # with a note\n" +
    "  codecast bookmark --list                        # list all bookmarks\n" +
    "  codecast bookmark --delete auth-fix             # delete by name"
  )
  .argument("[session-id]", "Session ID of the conversation")
  .argument("[message-index]", "Message number to bookmark (1-indexed)")
  .option("--name <name>", "Name for the bookmark (must be unique)")
  .option("--note <note>", "Optional note for the bookmark")
  .option("--list", "List all bookmarks")
  .option("--delete <name>", "Delete bookmark by name")
  .option("-n, --limit <n>", "Number of bookmarks to list", "20")
  .action(async (sessionId, messageIndex, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (options.list) {
      try {
        const response = await fetch(`${siteUrl}/cli/bookmark/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            limit: parseInt(options.limit),
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        if (!result.bookmarks || result.bookmarks.length === 0) {
          console.log("\nNo bookmarks found.");
          console.log("Create one with: codecast bookmark <session-id> <message-index>");
          return;
        }

        console.log(`\nBookmarks (${result.count}):\n`);
        for (const bm of result.bookmarks) {
          const name = bm.name ? `[${bm.name}]` : "[unnamed]";
          console.log(`  ${name}`);
          console.log(`    Session: ${bm.session_id} message ${bm.message_index}`);
          console.log(`    ${bm.message_role}: ${bm.message_preview}...`);
          if (bm.note) {
            console.log(`    Note: ${bm.note}`);
          }
          console.log(`    URL: ${bm.url}`);
          console.log(`    Created: ${new Date(bm.created_at).toLocaleDateString()}`);
          console.log();
        }
      } catch (error) {
        console.error("List failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    if (options.delete) {
      try {
        const response = await fetch(`${siteUrl}/cli/bookmark/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            name: options.delete,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        console.log(`Deleted bookmark: ${options.delete}`);
      } catch (error) {
        console.error("Delete failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    if (!sessionId || !messageIndex) {
      console.error("Usage: codecast bookmark <session-id> <message-index>");
      console.error("Or use --list to view bookmarks, --delete <name> to remove one");
      process.exit(1);
    }

    const msgIdx = parseInt(messageIndex);
    if (isNaN(msgIdx) || msgIdx < 1) {
      console.error("message-index must be a positive integer");
      process.exit(1);
    }

    try {
      const response = await fetch(`${siteUrl}/cli/bookmark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          session_id: sessionId,
          message_index: msgIdx,
          name: options.name,
          note: options.note,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const displayName = result.name || "unnamed";
      console.log(`\nBookmark created: ${displayName}`);
      console.log(`Session: ${result.session_id} message ${result.message_index}`);
      console.log(`URL: ${result.url}\n`);
    } catch (error) {
      console.error("Bookmark failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("decisions")
  .description(
    "Track and retrieve architectural decisions\n\n" +
    "Examples:\n" +
    "  codecast decisions                            # list recent decisions\n" +
    "  codecast decisions --project .                # current project only\n" +
    "  codecast decisions --search \"database\"        # search decisions\n" +
    "  codecast decisions --tags db,arch             # filter by tags\n" +
    "  codecast decisions add \"Use Convex\" --reason \"Better TypeScript\"  # add decision\n" +
    "  codecast decisions add \"Cursor pagination\" --reason \"Better for realtime\" --tags api,perf\n" +
    "  codecast decisions delete <id>                # delete a decision"
  )
  .argument("[action]", "Action: add, delete, or omit to list")
  .argument("[title-or-id]", "Title for add, ID for delete")
  .option("--project <path>", "Filter by project path (use . for current)")
  .option("--search <query>", "Search decisions by title")
  .option("--tags <tags>", "Filter by tags (comma-separated)")
  .option("--reason <text>", "Rationale for the decision (required for add)")
  .option("-n, --limit <n>", "Number of results", "20")
  .option("-p, --page <n>", "Page number", "1")
  .action(async (action, titleOrId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (action === "add") {
      if (!titleOrId) {
        console.error("Usage: codecast decisions add \"Title\" --reason \"Why\"");
        process.exit(1);
      }
      if (!options.reason) {
        console.error("--reason is required when adding a decision");
        process.exit(1);
      }

      const tags = options.tags ? options.tags.split(",").map((t: string) => t.trim()) : undefined;

      try {
        const response = await fetch(`${siteUrl}/cli/decisions/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            title: titleOrId,
            rationale: options.reason,
            tags,
            project_path: options.project === "." ? process.cwd() : options.project,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        console.log(`Decision recorded: ${titleOrId}`);
        if (tags) {
          console.log(`Tags: ${tags.join(", ")}`);
        }
      } catch (error) {
        console.error("Add failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    if (action === "delete") {
      if (!titleOrId) {
        console.error("Usage: codecast decisions delete <decision-id>");
        process.exit(1);
      }

      try {
        const response = await fetch(`${siteUrl}/cli/decisions/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            decision_id: titleOrId,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        console.log(`Decision deleted: ${titleOrId}`);
      } catch (error) {
        console.error("Delete failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    const limit = parseInt(options.limit);
    const page = parseInt(options.page);
    const offset = (page - 1) * limit;
    const tags = options.tags ? options.tags.split(",").map((t: string) => t.trim()) : undefined;
    const projectPath = options.project === "." ? process.cwd() : options.project;

    try {
      const response = await fetch(`${siteUrl}/cli/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          project_path: projectPath,
          tags,
          search: options.search,
          limit,
          offset,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatDecisionsResults } = await import("./formatter.js");
      console.log(formatDecisionsResults(result));
    } catch (error) {
      console.error("Decisions failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("learn")
  .description(
    "Save and retrieve code patterns for reuse\n\n" +
    "Examples:\n" +
    "  codecast learn                              # list saved patterns\n" +
    "  codecast learn add \"convex-http\" --description \"HTTP action pattern\" --content \"...\"\n" +
    "  codecast learn show \"convex-http\"           # show pattern content\n" +
    "  codecast learn search \"webhook\"             # search patterns\n" +
    "  codecast learn delete \"convex-http\"         # delete pattern"
  )
  .argument("[action]", "Action: add, show, search, delete, or omit to list")
  .argument("[name-or-query]", "Pattern name for add/show/delete, or search query")
  .option("--description <text>", "Description for the pattern (required for add)")
  .option("--content <text>", "Content/code for the pattern (required for add)")
  .option("--tags <tags>", "Tags (comma-separated)")
  .option("--session <id>", "Source session ID")
  .option("--range <range>", "Source message range (e.g., 15:25)")
  .option("-n, --limit <n>", "Number of results", "20")
  .action(async (action, nameOrQuery, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (action === "add") {
      if (!nameOrQuery) {
        console.error("Usage: codecast learn add \"name\" --description \"...\" --content \"...\"");
        process.exit(1);
      }
      if (!options.description) {
        console.error("--description is required when adding a pattern");
        process.exit(1);
      }
      if (!options.content) {
        console.error("--content is required when adding a pattern");
        process.exit(1);
      }

      const tags = options.tags ? options.tags.split(",").map((t: string) => t.trim()) : undefined;

      try {
        const response = await fetch(`${siteUrl}/cli/patterns/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            name: nameOrQuery,
            description: options.description,
            content: options.content,
            tags,
            source_session_id: options.session,
            source_range: options.range,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        console.log(`Pattern saved: ${nameOrQuery}`);
        if (tags) {
          console.log(`Tags: ${tags.join(", ")}`);
        }
      } catch (error) {
        console.error("Add failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    if (action === "show") {
      if (!nameOrQuery) {
        console.error("Usage: codecast learn show \"pattern-name\"");
        process.exit(1);
      }

      try {
        const response = await fetch(`${siteUrl}/cli/patterns/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            name: nameOrQuery,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        const { formatPatternShow } = await import("./formatter.js");
        console.log(formatPatternShow(result));
      } catch (error) {
        console.error("Show failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    if (action === "search") {
      const limit = parseInt(options.limit);

      try {
        const response = await fetch(`${siteUrl}/cli/patterns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            search: nameOrQuery,
            limit,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        const { formatPatternsResults } = await import("./formatter.js");
        console.log(formatPatternsResults(result));
      } catch (error) {
        console.error("Search failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    if (action === "delete") {
      if (!nameOrQuery) {
        console.error("Usage: codecast learn delete \"pattern-name\"");
        process.exit(1);
      }

      try {
        const response = await fetch(`${siteUrl}/cli/patterns/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            name: nameOrQuery,
          }),
        });

        const result = await response.json();

        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        console.log(`Pattern deleted: ${nameOrQuery}`);
      } catch (error) {
        console.error("Delete failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
      return;
    }

    const limit = parseInt(options.limit);
    const tags = options.tags ? options.tags.split(",").map((t: string) => t.trim()) : undefined;

    try {
      const response = await fetch(`${siteUrl}/cli/patterns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          tags,
          limit,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatPatternsResults } = await import("./formatter.js");
      console.log(formatPatternsResults(result));
    } catch (error) {
      console.error("Learn failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("similar")
  .description(
    "Find sessions that touched the same file or are similar to a session\n\n" +
    "Examples:\n" +
    "  codecast similar --file src/auth.ts     # sessions that touched this file\n" +
    "  codecast similar --session abc123       # sessions similar to this one\n\n" +
    "Note: File touch data may be sparse for older sessions."
  )
  .option("-f, --file <path>", "Find sessions that touched this file")
  .option("-s, --session <id>", "Find sessions similar to this one")
  .option("-n, --limit <n>", "Number of results", "10")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    if (!options.file && !options.session) {
      console.error("Must specify --file or --session");
      console.error("Usage: codecast similar --file <path>");
      console.error("       codecast similar --session <id>");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const limit = parseInt(options.limit);

    try {
      const response = await fetch(`${siteUrl}/cli/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          file_path: options.file,
          session_id: options.session,
          limit,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatSimilarResults } = await import("./formatter.js");
      console.log(formatSimilarResults(result, { file: options.file, session: options.session }));
    } catch (error) {
      console.error("Similar search failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("blame")
  .description(
    "Find sessions that touched a specific file\n\n" +
    "Examples:\n" +
    "  codecast blame src/auth.ts             # sessions that touched this file\n" +
    "  codecast blame src/auth.ts:42          # sessions that touched line 42"
  )
  .argument("<file>", "File path, optionally with line number (e.g., src/auth.ts:42)")
  .option("-n, --limit <n>", "Number of results", "20")
  .action(async (file, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    let filePath = file;
    let lineNumber: number | undefined;

    const lineMatch = file.match(/^(.+):(\d+)$/);
    if (lineMatch) {
      filePath = lineMatch[1];
      lineNumber = parseInt(lineMatch[2]);
    }

    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(process.cwd(), filePath);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const limit = parseInt(options.limit);

    try {
      const response = await fetch(`${siteUrl}/cli/blame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          file_path: filePath,
          limit,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatBlameResults } = await import("./formatter.js");
      console.log(formatBlameResults({
        ...result,
        file_path: filePath,
        line: lineNumber,
      }));
    } catch (error) {
      console.error("Blame failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("fork")
  .description(
    "Fork a conversation from a specific message\n\n" +
    "Creates a new conversation branching from a specific point.\n" +
    "Like git branching for conversations.\n\n" +
    "Examples:\n" +
    "  codecast fork                            # fork current session\n" +
    "  codecast fork --from 15                  # fork current session from message 15\n" +
    "  codecast fork --from 15 --resume         # fork and open in Claude\n" +
    "  codecast fork abc1234                    # fork specific conversation\n" +
    "  codecast fork abc1234 --from 15          # fork specific conversation from message 15"
  )
  .argument("[id]", "Conversation ID or short ID (auto-detects current session if omitted)")
  .option("--from <index>", "1-based message index to fork from")
  .option("--resume", "Open forked conversation in Claude/Codex after creating")
  .option("--as <agent>", "Agent to resume with (claude or codex)")
  .option("--claude-args <args>", "Additional args to pass to claude")
  .option("--claude-tail <n>", "When resuming in Claude, keep only the last N messages (+ a truncation notice)")
  .option("--claude-full", "When resuming in Claude, do not auto-trim (may create a session too large for /compact)")
  .action(async (id: string | undefined, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (!id) {
      let sessionId: string | null = null;
      let projectRoot = process.cwd();
      try {
        projectRoot = execSync("git rev-parse --show-toplevel", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch {}

      sessionId = findCurrentSessionFromProcess(projectRoot);

      if (!sessionId) {
        const projectDir = projectRoot.replace(/\//g, "-");
        const sessionsDir = path.join(process.env.HOME || "", ".claude", "projects", projectDir);
        if (fs.existsSync(sessionsDir)) {
          const now = Date.now();
          const files = fs.readdirSync(sessionsDir)
            .filter(f => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(f))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtime.getTime() }))
            .sort((a, b) => b.mtime - a.mtime);
          const active = files.filter(f => now - f.mtime < 5 * 60 * 1000);
          if (active.length >= 1) {
            sessionId = path.basename(active[0].name, ".jsonl");
          } else if (files.length > 0) {
            sessionId = path.basename(files[0].name, ".jsonl");
          }
        }
      }

      if (!sessionId) {
        console.error("Could not detect current session. Pass a conversation ID: codecast fork <id>");
        process.exit(1);
      }

      const linksResp = await fetch(`${siteUrl}/cli/session-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, api_token: config.auth_token }),
      });
      const linksResult = await linksResp.json() as any;
      if (!linksResult.conversation_id) {
        console.error("Could not resolve session to conversation. Try: codecast fork <id>");
        process.exit(1);
      }
      id = linksResult.conversation_id;
      console.log(`Detected conversation: ${linksResult.title || id!.slice(0, 7)}`);
    }

    let messageUuid: string | undefined;

    if (options.from) {
      const fromIndex = parseInt(options.from);
      if (isNaN(fromIndex) || fromIndex < 1) {
        console.error("--from must be a positive integer (1-based message index)");
        process.exit(1);
      }

      console.log(`Fetching conversation to resolve message ${fromIndex}...`);
      const data = await fetchExport(siteUrl, config.auth_token!, id!);
      const userMessages = data.messages.filter((m: any) =>
        m.role === "user" || m.role === "assistant"
      );

      if (fromIndex > userMessages.length) {
        console.error(`Message index ${fromIndex} out of range (conversation has ${userMessages.length} messages)`);
        process.exit(1);
      }

      const targetMsg = userMessages[fromIndex - 1];
      messageUuid = targetMsg.message_uuid;
      if (!messageUuid) {
        console.error(`Message ${fromIndex} has no UUID, cannot fork from it`);
        process.exit(1);
      }
    }

    try {
      console.log(messageUuid ? `Forking from message...` : `Forking entire conversation...`);
      const response = await fetch(`${siteUrl}/cli/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          conversation_id: id,
          message_uuid: messageUuid,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        console.error(`Fork failed: ${body.error || response.statusText}`);
        process.exit(1);
      }

      const result = await response.json();
      const shortId = result.short_id || result.conversation_id?.toString().slice(0, 7);
      console.log(`Forked! New conversation: ${shortId}`);
      console.log(`View: https://codecast.sh/conversation/${result.conversation_id}`);

      if (options.resume) {
        const targetAgent = options.as?.toLowerCase() || "claude";
        console.log(`\nPreparing ${targetAgent} session...`);
        const data = await fetchExport(siteUrl, config.auth_token!, result.conversation_id);
        console.log(`  ${data.messages.length} messages exported`);

        if (targetAgent === "codex") {
          const { jsonl, sessionId } = generateCodexJsonl(data);
          writeCodexSession(jsonl, sessionId, "cc-import");
          const resolvedArgs = options.claudeArgs ?? config.codex_args ?? "";
          const cmd = `codex resume ${sessionId}${resolvedArgs ? " " + resolvedArgs : ""}`;
          console.log(`\nResume command:\n  ${cmd}`);
          openInNewTab(cmd, data.conversation.project_path);
        } else {
          const CLAUDE_CONTEXT_LIMIT_TOKENS = 200_000;
          const AUTO_TRIM_THRESHOLD_TOKENS = 150_000;
          const AUTO_TRIM_TARGET_TOKENS = 120_000;

          const estimatedTokens = estimateClaudeImportTokens(data);
          let tailMessages: number | undefined;
          let noTrim = !!options.claudeFull;

          if (options.claudeTail != null) {
            const n = parseInt(String(options.claudeTail), 10);
            if (Number.isFinite(n) && n > 0) {
              tailMessages = n;
              console.log(`  Trimming Claude import to last ${tailMessages} messages (--claude-tail)`);
            } else {
              noTrim = true;
              console.log(`  Claude import trimming disabled (--claude-tail ${options.claudeTail})`);
            }
          } else if (!noTrim && estimatedTokens > AUTO_TRIM_THRESHOLD_TOKENS) {
            tailMessages = chooseClaudeTailMessagesForTokenBudget(data, AUTO_TRIM_TARGET_TOKENS);
            console.log(
              `  Claude context window is ~${CLAUDE_CONTEXT_LIMIT_TOKENS.toLocaleString()} tokens; import estimates ~${estimatedTokens.toLocaleString()} tokens.\n` +
              `  Auto-trimming to last ${tailMessages} messages (target ~${AUTO_TRIM_TARGET_TOKENS.toLocaleString()} tokens) to keep Claude Code /compact usable.\n` +
              `  Disable with --claude-full (or --claude-tail 0).`
            );
          }

          const { jsonl, sessionId } = generateClaudeCodeJsonl(data, { tailMessages });
          writeClaudeCodeSession(jsonl, sessionId, data.conversation.project_path || undefined);
          const resolvedArgs = options.claudeArgs ?? config.claude_args ?? "";
          const cmd = `claude --resume ${sessionId}${resolvedArgs ? " " + resolvedArgs : ""}`;
          console.log(`\nResume command:\n  ${cmd}`);
          openInNewTab(cmd, data.conversation.project_path);
        }
      }
    } catch (error) {
      console.error("Fork failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("tree")
  .description("Show fork tree for a conversation")
  .argument("<id>", "Conversation ID or short ID")
  .action(async (id: string) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    try {
      const response = await fetch(`${siteUrl}/cli/tree`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          conversation_id: id,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        console.error(`Error: ${body.error || response.statusText}`);
        process.exit(1);
      }

      const result = await response.json();
      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (!result.tree) {
        console.log("No fork tree found for this conversation.");
        process.exit(0);
      }

      const { formatTree } = await import("./formatter.js");
      console.log(formatTree(result.tree));
    } catch (error) {
      console.error("Tree failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("update")
  .description("Update codecast to the latest version")
  .option("--no-auto", "Disable auto-updates")
  .option("--auto", "Enable auto-updates (default)")
  .action(async (options) => {
    const config = readConfig() || {};

    if (options.auto === false) {
      config.auto_update = false;
      writeConfig(config);
      console.log("Auto-updates disabled. Run 'codecast update' manually to update.");
      return;
    }

    if (options.auto === true) {
      config.auto_update = true;
      writeConfig(config);
      console.log("Auto-updates enabled.");
    }

    const available = await checkForUpdates(true);
    if (!available) {
      console.log(`codecast v${getVersion()} is already the latest version`);
      return;
    }
    console.log(`Updating from v${getVersion()} to v${available}...`);

    // Check if daemon is running before update
    const daemonWasRunning = getDaemonPid() !== null;
    if (daemonWasRunning) {
      console.log("Stopping daemon...");
      stopDaemon();
    }

    const success = await performUpdate();
    if (success) {
      if (config.memory_enabled) {
        installMemorySnippet(true);
      }

      // Restart daemon if it was running
      if (daemonWasRunning) {
        console.log("Restarting daemon...");
        startDaemon();
        console.log(`Updated to v${available} and restarted daemon`);
      } else {
        console.log(`Updated to v${available}`);
      }
    } else {
      // Try to restart daemon even if update failed
      if (daemonWasRunning) {
        console.log("Restarting daemon...");
        startDaemon();
      }
      process.exit(1);
    }
  });

program
  .command("force-update")
  .description("Set minimum CLI version to force remote clients to update (admin only)")
  .argument("<version>", "Minimum version required (e.g., 1.0.12)")
  .action(async (version) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      console.error("Invalid version format. Use semver (e.g., 1.0.12)");
      process.exit(1);
    }

    const syncService = new SyncService({
      convexUrl: config.convex_url,
      authToken: config.auth_token,
      userId: config.user_id,
    });

    try {
      await syncService.getClient().mutation(
        "systemConfig:setMinCliVersion" as any,
        { version, api_token: config.auth_token }
      );
      console.log(`Minimum CLI version set to ${version}`);
      console.log("Remote daemons will auto-update within 5 minutes");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to set min version: ${errMsg}`);
      process.exit(1);
    }
  });

program
  .command("ask")
  .description(
    "Natural language query over conversation history\n\n" +
    "Examples:\n" +
    "  codecast ask \"when did we last refactor the feed?\"\n" +
    "  codecast ask \"what's the pattern for adding CLI commands?\"\n" +
    "  codecast ask \"why did we switch to Convex?\"\n" +
    "  codecast ask \"auth bug\" -g         # search globally\n" +
    "  codecast ask \"auth\" -s 7d          # search last 7 days"
  )
  .argument("<query>", "Natural language question")
  .option("-g, --global", "Search all sessions (not just current project)")
  .option("-n, --limit <n>", "Number of sessions to analyze", "3")
  .option("-s, --start <date>", "Start date/time (e.g., 7d, 2w, yesterday)")
  .option("-e, --end <date>", "End date/time")
  .option("-d, --debug", "Show context sent to LLM")
  .action(async (query, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not set. Export it to use RAG-powered answers.");
      process.exit(1);
    }

    const anthropic = new Anthropic({ apiKey });

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const limit = parseInt(options.limit);
    const paddingLines = 8;
    const messageCharLimit = 4000;

    let suggestedGlobal = false;
    let suggestedStart: string | undefined;
    let suggestedEnd: string | undefined;
    let startTime: number | undefined;
    let endTime: number | undefined;

    const stopWords = new Set(["the", "did", "was", "what", "when", "why", "how", "for", "with", "does", "have", "has", "had", "do", "are", "is", "were", "been", "being"]);

    const baseSearchTerms = query
      .toLowerCase()
      .replace(/[?'"]/g, "")
      .split(/\s+/)
      .filter((w: string) => w.length > 2 && !stopWords.has(w));

    // Let Haiku propose richer search tokens to capture intent (e.g., feature names or file paths)
    let llmSearchTerms: string[] = [];
    try {
      const expansion = await anthropic.messages.create({
        model: "claude-3-5-haiku-latest",
        max_tokens: 128,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content:
`Turn the user's question into 3-6 concise, high-signal search terms that will be ANDed together by the search engine (too many terms over-filters).
Also, suggest flags if useful; include {"global":true} only if the question clearly implies cross-project or global scope.
Return JSON like {"terms":["a","b"],"flags":{"global":true,"start":"30d","end":"7d"}}.
Omit flags you are unsure about.
Question: ${query}`,
          },
        ],
      });
      const expansionText = expansion.content[0].type === "text" ? expansion.content[0].text : "";
      try {
        const parsed = JSON.parse(expansionText);
        if (Array.isArray(parsed?.terms)) {
          llmSearchTerms = parsed.terms.map((w: string) => w.trim().toLowerCase()).filter((w: string) => w.length > 2);
        }
        if (parsed?.flags) {
          suggestedGlobal = !!parsed.flags.global;
          if (typeof parsed.flags.start === "string") suggestedStart = parsed.flags.start;
          if (typeof parsed.flags.end === "string") suggestedEnd = parsed.flags.end;
        }
      } catch {
        llmSearchTerms = expansionText
          .split(/[,\n]/)
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w.length > 2);
      }
    } catch {
      // If expansion fails, fall back to the base terms without interrupting the flow.
    }

    const searchTerms = Array.from(new Set([...baseSearchTerms, ...llmSearchTerms]));
    const searchQuery = searchTerms.slice(0, 8).join(" ");
    const baseQuery = baseSearchTerms.slice(0, 8).join(" ");

    const projectPath = (options.global || suggestedGlobal) ? undefined : getRealCwd();

    const startHint = options.start ?? suggestedStart;
    if (startHint) {
      startTime = parseRelativeDate(startHint) ?? undefined;
      if (!startTime) {
        console.error(`Invalid start date: ${startHint}`);
        process.exit(1);
      }
    }
    const endHint = options.end ?? suggestedEnd;
    if (endHint) {
      endTime = parseRelativeDate(endHint) ?? undefined;
      if (!endTime) {
        console.error(`Invalid end date: ${endHint}`);
        process.exit(1);
      }
    }

    if (!searchQuery) {
      console.error("Query too vague. Include more specific terms.");
      process.exit(1);
    }

    try {
      if (process.env.ASK_DEBUG) {
        console.error(`[ask] query="${query}" search="${searchQuery}" start=${startTime} end=${endTime} project_path=${projectPath || "GLOBAL"} terms=${JSON.stringify(searchTerms)}`);
      }
      const runSearch = async (q: string) => {
        if (process.env.ASK_DEBUG) console.error(`[ask] hitting search with query="${q}"`);
        const resp = await fetch(`${siteUrl}/cli/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            query: q,
            limit: limit * 3,
            offset: 0,
            start_time: startTime,
            end_time: endTime,
            context_before: paddingLines,
            context_after: paddingLines,
            project_path: projectPath,
          }),
        });
        return resp.json();
      };

      let searchResult = await runSearch(searchQuery);

      if ((!searchResult.conversations || searchResult.conversations.length === 0) && llmSearchTerms.length > 0) {
        if (process.env.ASK_DEBUG) console.error("[ask] first search empty, retrying with base terms only");
        searchResult = await runSearch(baseQuery || searchQuery);
      }

      if (!searchResult.conversations || searchResult.conversations.length === 0) {
        const minimalQuery = (baseSearchTerms[0] ? [baseSearchTerms[0], baseSearchTerms[1]].filter(Boolean).join(" ") : "") || "recent work";
        if (process.env.ASK_DEBUG) console.error(`[ask] second search empty, retrying with minimal query "${minimalQuery}"`);
        searchResult = await runSearch(minimalQuery);
      }

      if (searchResult.error) {
        console.error(`Error: ${searchResult.error}`);
        process.exit(1);
      }

      const normalizePath = (p?: string | null) => p ? path.resolve(p).replace(/\/$/, "") : null;
      const targetPath = normalizePath(projectPath);
      const conversations = (searchResult.conversations || []).filter((conv: any) => {
        if (!targetPath) return true;
        const convPath = normalizePath(conv.project_path);
        return convPath === targetPath;
      });

      if (process.env.ASK_DEBUG) {
        const sample = conversations.slice(0, 5).map((c: any) => `${c.id.slice(0,7)}:${c.project_path || "null"}`);
        console.error(`[ask] conversations after project filter (${conversations.length}): ${sample.join(", ")}`);
      }

      if (conversations.length === 0) {
        if (process.env.ASK_DEBUG) {
          console.error("[ask] search returned empty result after project filter");
        }
        console.log(`<ANSWER query="${query}">`);
        console.log("No matching conversations found.");
        if (projectPath) {
          console.log("\nTry: codecast ask \"" + query + "\" -g   # search globally");
        }
        console.log("</ANSWER>");
        process.exit(0);
      }

      const topSessions = conversations.slice(0, limit);
      const sessionDetails: Array<{
        id: string;
        title: string;
        messages: Array<{ line: number; role: string; content: string }>;
      }> = [];

      for (const conv of topSessions) {
        const matchLines = conv.matches.map((m: { line: number }) => m.line);
        const minLine = Math.max(1, Math.min(...matchLines) - paddingLines);
        const maxLine = Math.max(...matchLines) + paddingLines;

        const readResponse = await fetch(`${siteUrl}/cli/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            conversation_id: conv.id,
            start_line: minLine,
            end_line: maxLine,
          }),
        });

        const readResult = await readResponse.json();

        if (!readResult.error && readResult.messages) {
          sessionDetails.push({
            id: conv.id,
            title: conv.title,
            messages: readResult.messages,
          });
        }
      }

      if (sessionDetails.length === 0) {
        console.log(`<ANSWER query="${query}">`);
        console.log("Found sessions but couldn't retrieve messages.");
        console.log("</ANSWER>");
        process.exit(0);
      }

      // Format context for RAG
      const contextParts: string[] = [];
      for (const session of sessionDetails) {
        const sessionContext = [`## Session: ${session.title} [${session.id.slice(0, 7)}]`];
        for (const msg of session.messages) {
          if (msg.content) {
            const role = msg.role === "user" ? "User" : "Assistant";
            const truncated = msg.content.length > messageCharLimit
              ? msg.content.slice(0, messageCharLimit) + "..."
              : msg.content;
            sessionContext.push(`${role} (line ${msg.line}): ${truncated}`);
          }
        }
        contextParts.push(sessionContext.join("\n"));
      }
      const context = contextParts.join("\n\n---\n\n");

      if (options.debug) {
        console.log("=== CONTEXT SENT TO LLM ===\n");
        console.log(context);
        console.log("\n=== END CONTEXT ===");
        process.exit(0);
      }

      // Call Haiku for RAG
      const response = await anthropic.messages.create({
        model: "claude-3-5-haiku-latest",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `You are answering questions about past coding sessions. Use the provided context to answer the question. Be concise and direct. If the context doesn't contain enough information, say so.

<context>
${context}
</context>

Question: ${query}

Answer the question based on the context above. Include specific details like values, file paths, or code snippets when relevant. At the end, list the source sessions used.`,
          },
        ],
      });

      const answer = response.content[0].type === "text" ? response.content[0].text : "";

      console.log(`<ANSWER query="${query}">`);
      console.log(answer);
      console.log("\nSources:");
      for (const session of sessionDetails) {
        console.log(`- [${session.id.slice(0, 7)}] ${session.title}`);
      }
      console.log("</ANSWER>");
    } catch (error) {
      console.error("Ask failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("context")
  .description(
    "Pre-work intelligence: find relevant past sessions before starting work\n\n" +
    "Searches for conversations related to your task, combining text search\n" +
    "and file-based similarity to surface relevant context.\n\n" +
    "Examples:\n" +
    "  codecast context \"add stripe integration\"   # search by description\n" +
    "  codecast context --file src/auth.ts         # sessions that touched file\n" +
    "  codecast context --auto                     # infer from git diff/status"
  )
  .argument("[query]", "Search query describing the work")
  .option("-f, --file <path>", "Find sessions that touched this file")
  .option("-a, --auto", "Infer context from git diff and status")
  .option("-g, --global", "Search all sessions (not just current project)")
  .option("-n, --limit <n>", "Maximum results", "10")
  .action(async (query, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: codecast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const projectPath = options.global ? undefined : getRealCwd();
    const limit = parseInt(options.limit);

    let searchQuery = query;
    let filePaths: string[] = [];

    if (options.file) {
      const absPath = path.isAbsolute(options.file)
        ? options.file
        : path.resolve(process.cwd(), options.file);
      filePaths.push(absPath);
    }

    if (options.auto) {
      try {
        const statusOutput = execSync("git status --porcelain", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();

        if (statusOutput) {
          const changedFiles = statusOutput
            .split("\n")
            .map((line) => line.slice(3).trim())
            .filter((f) => f && !f.includes(" -> "))
            .slice(0, 5);

          for (const f of changedFiles) {
            const absPath = path.resolve(process.cwd(), f);
            if (!filePaths.includes(absPath)) {
              filePaths.push(absPath);
            }
          }
        }

        if (!searchQuery) {
          const branchName = execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
          }).trim();

          if (branchName && branchName !== "main" && branchName !== "master") {
            searchQuery = branchName.replace(/[-_/]/g, " ");
          }
        }
      } catch {
        // Not a git repo or git not available
      }
    }

    if (!searchQuery && filePaths.length === 0) {
      console.error("Provide a query, --file, or use --auto in a git repo");
      console.error("\nUsage:");
      console.error("  codecast context \"add stripe integration\"");
      console.error("  codecast context --file src/auth.ts");
      console.error("  codecast context --auto");
      process.exit(1);
    }

    try {
      const sessions: Map<string, {
        id: string;
        title: string;
        project_path: string | null;
        updated_at: string;
        message_count: number;
        preview?: string;
        match_type: string;
        match_detail?: string;
        files?: string[];
      }> = new Map();

      const relatedFiles: Map<string, number> = new Map();

      if (searchQuery) {
        const searchResponse = await fetch(`${siteUrl}/cli/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            query: searchQuery,
            limit: limit,
            offset: 0,
            project_path: projectPath,
          }),
        });

        const searchResult = await searchResponse.json();

        if (!searchResult.error && searchResult.conversations) {
          for (const conv of searchResult.conversations) {
            const preview = conv.matches?.[0]?.content?.slice(0, 100) + "..." || "";
            sessions.set(conv.id, {
              id: conv.id,
              title: conv.title,
              project_path: conv.project_path,
              updated_at: conv.updated_at,
              message_count: conv.message_count,
              preview,
              match_type: "text",
              match_detail: searchQuery,
            });
          }
        }
      }

      for (const filePath of filePaths) {
        const similarResponse = await fetch(`${siteUrl}/cli/similar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            file_path: filePath,
            limit: limit,
          }),
        });

        const similarResult = await similarResponse.json();

        if (!similarResult.error && similarResult.sessions) {
          for (const sess of similarResult.sessions) {
            if (!sessions.has(sess.conversation_id)) {
              sessions.set(sess.conversation_id, {
                id: sess.conversation_id,
                title: sess.title,
                project_path: sess.project_path,
                updated_at: sess.updated_at,
                message_count: sess.message_count,
                match_type: "file",
                match_detail: filePath,
              });
            }

            const shortPath = filePath.replace(process.env.HOME || "", "~");
            relatedFiles.set(shortPath, (relatedFiles.get(shortPath) || 0) + 1);
          }
        }
      }

      if (sessions.size > 0) {
        for (const [sessId] of Array.from(sessions).slice(0, 5)) {
          try {
            const touchesResponse = await fetch(`${siteUrl}/cli/blame`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_token: config.auth_token,
                conversation_id: sessId,
                limit: 20,
              }),
            });

            const touchesResult = await touchesResponse.json();

            if (!touchesResult.error && touchesResult.files) {
              const sess = sessions.get(sessId);
              if (sess) {
                sess.files = touchesResult.files
                  .slice(0, 5)
                  .map((f: { file_path: string }) =>
                    f.file_path.replace(process.env.HOME || "", "~")
                  );
              }

              for (const f of touchesResult.files) {
                const shortPath = f.file_path.replace(process.env.HOME || "", "~");
                relatedFiles.set(shortPath, (relatedFiles.get(shortPath) || 0) + 1);
              }
            }
          } catch {
            // Continue even if individual request fails
          }
        }
      }

      const { formatContextResults } = await import("./formatter.js");
      console.log(formatContextResults({
        query: searchQuery,
        sessions: Array.from(sessions.values()).slice(0, limit),
        related_files: Array.from(relatedFiles.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([filePath, count]) => ({ path: filePath, session_count: count })),
      }));
    } catch (error) {
      console.error("Context failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("claude")
  .description("Launch Claude Code with managed session (enables reliable message delivery)")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (_options, command) => {
    const { runClaudeWrapper } = await import("./claudeWrapper.js");
    const config = readConfig();
    const defaultArgs = config?.claude_args ? config.claude_args.split(/\s+/).filter(Boolean) : [];
    const args = [...defaultArgs, ...command.args];
    await runClaudeWrapper(args);
  });

program
  .command("_daemon", { hidden: true })
  .description("Run as daemon (internal use)")
  .action(async () => {
    const { runDaemon } = await import("./daemon.js");
    await runDaemon();
  });

program
  .command("_watchdog", { hidden: true })
  .description("Watchdog health check (internal use)")
  .action(async () => {
    const { runWatchdog } = await import("./daemon.js");
    await runWatchdog();
  });

// Check for updates in background (non-blocking)
checkForUpdates().then(async (available) => {
  if (!available) return;

  const config = readConfig();
  if (config?.auto_update === false) {
    showUpdateNotice(available);
    return;
  }

  console.log(`\nAuto-updating to v${available}...`);
  const success = await performUpdate();
  if (success) {
    if (config?.memory_enabled) {
      installMemorySnippet(true);
    }
    console.log("Update complete. Restart codecast to use the new version.\n");
  } else {
    showUpdateNotice(available);
  }
});

program.on("command:*", (operands) => {
  if (operands.length > 0) {
    logCliError("unknown-command", `Unknown command: ${operands.join(" ")}`);
    console.error(`error: unknown command '${operands.join(" ")}'`);
    process.exit(1);
  }
});

// Show help if no command provided
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

// Log all CLI commands
program.hook('preAction', (thisCommand, actionCommand) => {
  const cmdName = actionCommand.name();
  const args = actionCommand.args?.join(' ') || '';
  if (process.env.DEBUG_CLI) {
    console.error(`[DEBUG] preAction hook: cmd=${cmdName} args=${args}`);
  }
  // Skip logging for daemon-internal commands
  if (!['start', 'stop', 'daemon', 'codecast'].includes(cmdName)) {
    logCliCommand(cmdName, args);
  }
});

program.parse();
