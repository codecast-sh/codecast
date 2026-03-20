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
import { ensureTmux, hasTmux, tryInstallTmux } from "./tmux.js";
import { checkForUpdates, performUpdate, showUpdateNotice, getVersion, getMemoryVersion, getTaskVersion, getWorkVersion, getWorkflowVersion, ensureCastAlias } from "./update.js";
import { glob } from "glob";
import { getPosition, setPosition } from "./positionTracker.js";
import { getAllSyncRecords, findUnsyncedFiles } from "./syncLedger.js";
import { getLastReconciliation, performReconciliation, repairDiscrepancies } from "./reconciliation.js";
import { parseSessionFile, extractSlug } from "./parser.js";
import { SyncService } from "./syncService.js";
import * as readline from "readline";
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
import { detectRuntime, parseAgentMarkers as _parseAgentMarkers, type AgentRuntime, type AgentHandle } from "./agents/index.js";
import { buildImplementerPrompt as _buildImplementerPrompt, buildReviewerPrompt, buildCriticPrompt, resolveTaskModel, resolveTaskModelFull, resolveFidelity, buildRetroPrompt, type FidelityLevel, type TypedRetro } from "./agents/index.js";
import { checkbox, confirm, input, select } from "@inquirer/prompts";

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

function detectCurrentSessionId(): string | null {
  const envId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID;
  if (envId) return envId;

  try {
    let projectRoot = process.cwd();
    try {
      projectRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
    } catch {}

    const fromProcess = findCurrentSessionFromProcess(projectRoot);
    if (fromProcess) return fromProcess;

    const projectDir = projectRoot.replace(/\//g, "-");
    const sessionsDir = path.join(process.env.HOME || "", ".claude", "projects", projectDir);
    if (!fs.existsSync(sessionsDir)) return null;

    const now = Date.now();
    const ACTIVE_THRESHOLD = 5 * 60 * 1000;
    const files = fs.readdirSync(sessionsDir)
      .filter(f => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(f))
      .map(f => ({
        name: f,
        path: path.join(sessionsDir, f),
        mtime: fs.statSync(path.join(sessionsDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const activeSessions = files.filter(f => now - f.mtime < ACTIVE_THRESHOLD);
    if (activeSessions.length === 1) {
      return path.basename(activeSessions[0].name, ".jsonl");
    } else if (activeSessions.length > 1) {
      return path.basename(activeSessions[0].name, ".jsonl");
    } else {
      return path.basename(files[0].name, ".jsonl");
    }
  } catch {
    return null;
  }
}

const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const VERSION_FILE = path.join(CONFIG_DIR, "daemon.version");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const WATCHDOG_SCRIPT_PATH = path.join(CONFIG_DIR, "watchdog.sh");

function shellEscapeForSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildWatchdogShellScript(): string {
  const execPath = process.execPath;
  const isBinary = !execPath.endsWith("/bun") && !execPath.endsWith("/node") && !execPath.includes("node_modules");
  const { executablePath, args } = getExecutableInfo("_watchdog");
  const watchdogCommand = [executablePath, ...args].map(shellEscapeForSh).join(" ");

  if (!isBinary) {
    return `#!/bin/sh
LOGFILE="\${HOME}/.codecast/watchdog-shell.log"
log() { printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$LOGFILE"; }

LAUNCHD_UID="gui/\$(id -u)"
if launchctl print "\$LAUNCHD_UID/sh.codecast.daemon" 2>/dev/null | grep -q 'state = running'; then
  exit 0
fi

log "Dev-mode watchdog kickstarting launchd daemon"
launchctl kickstart -k "\$LAUNCHD_UID/sh.codecast.daemon" >>"\$LOGFILE" 2>&1 || log "Failed to kickstart dev daemon"
exit 0
`;
  }

  return `#!/bin/sh
LOGFILE="\${HOME}/.codecast/watchdog-shell.log"
log() { printf '[%s] %s\\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$LOGFILE"; }

${watchdogCommand} 2>>"\$LOGFILE" && exit 0
log "Watchdog failed (exit \$?), checking for update"

DL_HOST="https://dl.codecast.sh"
LATEST="\$(curl -fsSL "\$DL_HOST/latest.json" 2>/dev/null)" || { log "Failed to fetch latest.json"; exit 1; }
VERSION="\$(printf '%s' "\$LATEST" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
[ -z "\$VERSION" ] && { log "Could not parse version"; exit 1; }

LAST_DL_FILE="\${HOME}/.codecast/last_download_version"
LAST_DL="\$(cat "\$LAST_DL_FILE" 2>/dev/null || true)"
if [ "\$VERSION" = "\$LAST_DL" ]; then
  log "v\$VERSION already tried and failed, waiting for new release"
  exit 1
fi

OS="\$(uname -s)"; ARCH="\$(uname -m)"
case "\$OS" in Darwin*) P="darwin";; Linux*) P="linux";; *) log "Unsupported OS: \$OS"; exit 1;; esac
case "\$ARCH" in x86_64|amd64) A="x64";; arm64|aarch64) A="arm64";; *) log "Unsupported arch: \$ARCH"; exit 1;; esac

DIR="\${HOME}/.local/bin"; mkdir -p "\$DIR"
TMP="\$(mktemp)"
log "Downloading codecast v\$VERSION (\$P-\$A)"
curl -fsSL "\$DL_HOST/codecast-\$P-\$A" -o "\$TMP" 2>>"\$LOGFILE" || { rm -f "\$TMP"; log "Download failed"; exit 1; }
mv "\$TMP" "\$DIR/codecast" && chmod +x "\$DIR/codecast"
printf '%s' "\$VERSION" > "\$LAST_DL_FILE"
log "Installed v\$VERSION, retrying watchdog"

"\$DIR/codecast" -- _watchdog 2>>"\$LOGFILE" || { log "Still failed after update"; exit 1; }
`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_URL = process.env.CODE_CHAT_SYNC_WEB_URL || "https://codecast.sh";
const CONVEX_URL = process.env.CONVEX_URL || "https://convex.codecast.sh";

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
  task_enabled?: boolean;
  task_version?: string;
  work_enabled?: boolean;
  work_version?: string;
  plan_enabled?: boolean;
  plan_version?: string;
  workflow_enabled?: boolean;
  workflow_version?: string;
  claude_args?: string;
  codex_args?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];
  stable_mode?: "solo" | "team";
  stable_global?: boolean;
  team_share_mode?: "full" | "summary";
  agent_default_params?: {
    claude?: Record<string, string>;
    codex?: Record<string, string>;
    gemini?: Record<string, string>;
    cursor?: Record<string, string>;
  };
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

function readProjectPathFromSession(sessionFilePath: string): string | null {
  try {
    const fd = fs.openSync(sessionFilePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return parsed.cwd || parsed.project_path || null;
  } catch {
    return null;
  }
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

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
    const sessionFiles = fs.readdirSync(dirPath).filter(f => uuidPattern.test(f));

    if (sessionFiles.length === 0) continue;

    let lastModified = new Date(0);
    let projectPath: string | null = null;
    for (const file of sessionFiles) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      if (stats.mtime > lastModified) {
        lastModified = stats.mtime;
      }
      if (!projectPath) {
        projectPath = readProjectPathFromSession(filePath);
      }
    }

    if (!projectPath) {
      // Fallback to lossy decode if no session file has a path
      projectPath = "/" + entry.name.replace(/-/g, "/").slice(1);
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
  maxMessages: number = 500,
  fullContent: boolean = false
): Promise<FullReadResult | { error: string }> {
  const firstResponse = await fetch(`${siteUrl}/cli/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: apiToken,
      conversation_id: conversationId,
      start_line: 1,
      end_line: 25,
      full_content: fullContent || undefined,
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
        full_content: fullContent || undefined,
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
cast links
\`\`\`

The output shows:
- **Session**: Title or identifier of the found session
- **Dashboard**: URL to view the session on codecast.sh
- **Share**: URL to share with others

IMPORTANT: Verify the "Session:" line matches this conversation's topic. If it shows a different/old session, tell the user to try \`cast links -s <session-id>\` with the correct session ID from \`ls ~/.claude/projects/*/\`.

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

const SESSION_REGISTER_HOOK = `#!/bin/bash
# Registers session-to-PID/TTY mapping for codecast daemon process discovery
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

# Walk up to find the claude process PID
CLAUDE_PID=""
CHECK_PID=$PPID
for _ in 1 2 3 4; do
  [ -z "$CHECK_PID" ] || [ "$CHECK_PID" = "1" ] && break
  CMD=$(ps -o comm= -p "$CHECK_PID" 2>/dev/null)
  if echo "$CMD" | grep -qiE 'claude|2\\.1\\.' 2>/dev/null; then
    CLAUDE_PID=$CHECK_PID
    break
  fi
  CHECK_PID=$(ps -o ppid= -p "$CHECK_PID" 2>/dev/null | tr -d ' ')
done

[ -z "$CLAUDE_PID" ] && exit 0

TTY=$(ps -o tty= -p "$CLAUDE_PID" 2>/dev/null | tr -d ' ')
[ -z "$TTY" ] || [ "$TTY" = "??" ] && exit 0

REGISTRY_DIR="$HOME/.codecast/session-registry"
mkdir -p "$REGISTRY_DIR"
echo "{\\"pid\\":$CLAUDE_PID,\\"tty\\":\\"$TTY\\",\\"ts\\":$(date +%s),\\"term\\":\\"$\{TERM_PROGRAM:-unknown}\\"}" > "$REGISTRY_DIR/$SESSION_ID.json"
exit 0
`;

const CODECAST_STATUS_HOOK = `#!/bin/bash
# Reports Claude Code lifecycle events to codecast daemon via status files
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

EVENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hook_event_name',''))" 2>/dev/null)
NOTIF_TYPE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('notification_type',''))" 2>/dev/null)
SOURCE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('source',''))" 2>/dev/null)
PERM_MODE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('permission_mode',''))" 2>/dev/null)

STATUS=""
EXTRA=""
case "$EVENT" in
  UserPromptSubmit) STATUS="thinking" ;;
  PreToolUse) STATUS="working" ;;
  PreCompact) STATUS="compacting" ;;
  Stop) STATUS="idle" ;;
  Notification)
    case "$NOTIF_TYPE" in
      permission_prompt)
        STATUS="permission_blocked"
        EXTRA=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
parts=[]
m=d.get('message','')
t=d.get('transcript_path','')
if m: parts.append(',\"message\":'+json.dumps(m))
if t: parts.append(',\"transcript_path\":'+json.dumps(t))
print(''.join(parts))
" 2>/dev/null)
        ;;
      idle_prompt) STATUS="idle" ;;
    esac
    ;;
  SessionStart)
    [ "$SOURCE" = "compact" ] && STATUS="working"
    ;;
esac

[ -z "$STATUS" ] && exit 0

STATUS_DIR="$HOME/.codecast/agent-status"
mkdir -p "$STATUS_DIR"
PERM_FIELD=""
[ -n "$PERM_MODE" ] && PERM_FIELD=",\\"permission_mode\\":\\"$PERM_MODE\\""
echo "{\\"status\\":\\"$STATUS\\",\\"ts\\":$(date +%s)$PERM_FIELD$EXTRA}" > "$STATUS_DIR/$SESSION_ID.json"
exit 0
`;

function installStatusHook(): void {
  const home = process.env.HOME || "";
  const hooksDir = path.join(home, ".claude", "hooks");
  const hookFile = path.join(hooksDir, "codecast-status.sh");
  const settingsFile = path.join(home, ".claude", "settings.json");

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookFile, CODECAST_STATUS_HOOK, { mode: 0o755 });

    let settings: any = {};
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    }

    if (!settings.hooks) settings.hooks = {};

    const hookEntry = {
      type: "command",
      command: hookFile,
      timeout: 5,
    };

    for (const event of ["UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "Notification", "SessionStart"] as const) {
      if (!settings.hooks[event]) settings.hooks[event] = [];

      const hookArray = settings.hooks[event] as any[];
      const alreadyPresent = hookArray.some((matcher: any) => {
        const hooks = matcher.hooks || [];
        return hooks.some((h: any) => h.command?.includes("codecast-status.sh"));
      });

      if (!alreadyPresent) {
        if (hookArray.length > 0 && hookArray[0].matcher === "") {
          hookArray[0].hooks = hookArray[0].hooks || [];
          hookArray[0].hooks.push(hookEntry);
        } else {
          hookArray.unshift({ matcher: "", hooks: [hookEntry] });
        }
      }
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
  } catch {
    // Ignore errors - hook is optional enhancement
  }
}

function installSessionRegisterHook(): void {
  const home = process.env.HOME || "";
  const hooksDir = path.join(home, ".claude", "hooks");
  const hookFile = path.join(hooksDir, "session-register.sh");
  const settingsFile = path.join(home, ".claude", "settings.json");

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookFile, SESSION_REGISTER_HOOK, { mode: 0o755 });

    let settings: any = {};
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    }

    if (!settings.hooks) settings.hooks = {};

    const hookEntry = {
      type: "command",
      command: hookFile,
      timeout: 5,
    };

    for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
      if (!settings.hooks[event]) settings.hooks[event] = [];

      const hookArray = settings.hooks[event] as any[];
      const alreadyPresent = hookArray.some((matcher: any) => {
        const hooks = matcher.hooks || [];
        return hooks.some((h: any) => h.command?.includes("session-register.sh"));
      });

      if (!alreadyPresent) {
        if (hookArray.length > 0 && hookArray[0].matcher === "") {
          hookArray[0].hooks = hookArray[0].hooks || [];
          hookArray[0].hooks.push(hookEntry);
        } else {
          hookArray.unshift({ matcher: "", hooks: [hookEntry] });
        }
      }
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
  } catch {
    // Ignore errors - hook is optional enhancement
  }
}

function showWelcome(): void {
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`\n  ${c.bold}Welcome to cast${c.reset} ${fmt.muted("— sync & search your agent sessions")}\n`);

  const feature = (icon: string, title: string, desc: string) => {
    console.log(`  ${fmt.accent(icon)}  ${c.bold}${title}${c.reset}`);
    console.log(`     ${fmt.muted(desc)}`);
  };

  feature("◉", "Memory", "Your agent can search past conversations for context");
  feature("◉", "Dashboard", "Browse sessions at codecast.sh with full-text search");
  feature("◉", "Background Sync", "Sessions sync automatically as you work");

  console.log(`\n  ${fmt.muted("Commands")}`);
  console.log(`     ${fmt.cmd("cast search")} ${fmt.muted("\"query\"")}   ${fmt.muted("Full-text search across sessions")}`);
  console.log(`     ${fmt.cmd("cast resume")} ${fmt.muted("\"query\"")}   ${fmt.muted("Find a session and open it in Claude")}`);
  console.log(`     ${fmt.cmd("cast ask")} ${fmt.muted("\"question\"")}   ${fmt.muted("Ask questions about past work")}`);
  console.log(`     ${fmt.cmd("cast feed")}             ${fmt.muted("Browse recent sessions")}`);
  console.log(`     ${fmt.cmd("cast status")}           ${fmt.muted("Check sync status")}`);
  console.log(`\n     ${fmt.muted("Run")} ${fmt.cmd("cast -h")} ${fmt.muted("for all commands")}`);

  console.log(`\n${c.dim}${"─".repeat(50)}${c.reset}\n`);
}

function getDaemonPid(): number | null {
  if (!fs.existsSync(PID_FILE)) {
    return getLaunchdDaemonPid();
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    return getLaunchdDaemonPid();
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.unlinkSync(PID_FILE);
    return getLaunchdDaemonPid();
  }
}

function isDaemonRunning(): boolean {
  return getDaemonPid() !== null;
}

function getMacLaunchdDaemonStatus(): { configured: boolean; state: string | null; pid: number | null } | null {
  if (process.platform !== "darwin" || !process.getuid) return null;

  const home = process.env.HOME;
  if (!home) return null;

  const plistPath = path.join(home, "Library", "LaunchAgents", "sh.codecast.daemon.plist");
  if (!fs.existsSync(plistPath)) {
    return null;
  }

  const domain = `gui/${process.getuid!()}/sh.codecast.daemon`;
  const result = spawnSync("launchctl", ["print", domain], { encoding: "utf-8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const stateMatch = output.match(/^\s*state = ([^\n]+)/m);
  const pidMatch = output.match(/^\s*pid = (\d+)/m);

  return {
    configured: true,
    state: stateMatch ? stateMatch[1].trim() : null,
    pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
  };
}

function getLaunchdDaemonPid(): number | null {
  const status = getMacLaunchdDaemonStatus();
  if (!status?.pid || Number.isNaN(status.pid)) return null;
  try {
    process.kill(status.pid, 0);
    return status.pid;
  } catch {
    return null;
  }
}

function kickstartManagedDaemon(): boolean {
  const status = getMacLaunchdDaemonStatus();
  if (!status?.configured || !process.getuid) return false;

  const domain = `gui/${process.getuid!()}/sh.codecast.daemon`;
  const result = spawnSync("launchctl", ["kickstart", "-k", domain], { stdio: "ignore" });
  return result.status === 0;
}

function ensureDaemonRunning(): void {
  const config = readConfig();
  if (!config?.auth_token) return;
  if (isDaemonRunning()) {
    try {
      const runningVersion = fs.existsSync(VERSION_FILE)
        ? fs.readFileSync(VERSION_FILE, "utf-8").trim()
        : null;
      if (runningVersion && runningVersion !== getVersion()) {
        const pid = getDaemonPid();
        if (pid) {
          try { process.kill(pid, "SIGTERM"); } catch {}
          try { fs.unlinkSync(PID_FILE); } catch {}
          startDaemonQuiet();
        }
      }
    } catch {}
    return;
  }
  try {
    startDaemonQuiet();
  } catch {}
}

function startDaemonQuiet(): void {
  ensureConfigDir();
  if (isDaemonRunning()) return;

  if (kickstartManagedDaemon()) {
    return;
  }

  let child;
  const daemonTsPath = path.join(__dirname, "daemon.ts");
  const daemonJsPath = path.join(__dirname, "daemon.js");

  if (fs.existsSync(daemonTsPath)) {
    child = spawn(process.execPath, [daemonTsPath], { detached: true, stdio: "ignore" });
  } else if (fs.existsSync(daemonJsPath)) {
    child = spawn(process.execPath, [daemonJsPath], { detached: true, stdio: "ignore" });
  } else {
    child = spawn(process.execPath, ["_daemon"], { detached: true, stdio: "ignore" });
  }

  child.unref();
  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
  }
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

function formatRelativeTime(timestamp: string | number): string {
  const ts = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return "unknown";
  const now = Date.now();
  const diffMs = now - ts;
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
  } else if (diffDay >= 0) {
    return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
  } else {
    return "unknown";
  }
}

function getAgentLabel(agentType?: string): string | null {
  if (!agentType || agentType === "claude_code" || agentType === "claude") return "Claude";
  if (agentType === "codex" || agentType === "codex_cli") return "Codex";
  if (agentType === "cursor") return "Cursor";
  return agentType;
}

function showStatus(): void {
  const pid = getDaemonPid();
  const launchdStatus = getMacLaunchdDaemonStatus();
  const config = readConfig();
  const state = readDaemonState();

  console.log("");

  const row = (label: string, value: string) => {
    console.log(`  ${fmt.muted(label.padEnd(14))} ${value}`);
  };

  row("Version", fmt.value(`v${getVersion()}`));

  if (state?.authExpired) {
    row("Auth", fmt.warning("expired"));
    console.log(`  ${fmt.muted("Run")} ${fmt.cmd("cast auth")} ${fmt.muted("to re-authenticate")}`);
  } else if (config?.auth_token) {
    row("Auth", fmt.success(icons.check + " authenticated"));
    if (config.user_id) {
      row("User", fmt.id(config.user_id));
    }
  } else {
    row("Auth", fmt.muted(icons.cross + " not authenticated"));
    console.log(`  ${fmt.muted("Run")} ${fmt.cmd("cast auth")} ${fmt.muted("to authenticate")}`);
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
    const restarting = launchdStatus?.state === "spawn scheduled";
    row("Daemon", restarting ? fmt.warning("restarting") : fmt.muted(icons.cross + " stopped"));
    if (config?.auth_token) {
      if (restarting) {
        console.log(`  ${fmt.muted("Launchd is restarting the daemon")}`);
      } else {
        console.log(`  ${fmt.muted("Run")} ${fmt.cmd("cast start")} ${fmt.muted("to start syncing")}`);
      }
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
  console.log(`  ${fmt.muted("  Change:")} ${fmt.cmd("cast sync-settings")}`);

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

  if (!ensureTmux()) {
    console.log("Session management features (attach, remote control) will be unavailable.\n");
  }

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
  console.log("\n=== cast Login ===\n");
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
        console.error("Invalid or expired setup token.");
        console.error("\nTo fix this:");
        console.error("  1. Generate a new token at: https://codecast.sh/settings/cli");
        console.error("  2. Or authenticate via browser: cast auth");
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

    if (!hasTmux()) {
      console.log("tmux is recommended for full functionality (auto-resume, session management).\n");
      try {
        const shouldInstall = await confirm({ message: "Install tmux now?", default: true });
        if (shouldInstall) {
          tryInstallTmux();
        }
      } catch {}
    }

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
  console.log(`\n${c.bold}cast${c.reset} ${fmt.muted("Authentication")}\n`);

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
    console.error("Please try again with 'cast auth'");
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
  installSessionRegisterHook();
  installStatusHook();

  console.log(`${fmt.success(icons.check)} ${c.bold}Authenticated successfully!${c.reset}\n`);
  console.log(`  ${fmt.muted("User")}     ${fmt.id(config.user_id || "")}`);
  console.log(`  ${fmt.muted("Token")}    ${fmt.value(maskToken(config.auth_token || ""))}`);
  console.log(`  ${fmt.muted("Config")}   ${fmt.path(CONFIG_FILE)}\n`);

  showWelcome();

  await promptProjectSelection(config);

  await promptTeamSelection(config);

  await promptMemoryEnablement();

  await promptStableEnablement();

  if (!ensureTmux()) {
    try {
      const shouldInstall = await confirm({ message: "Install tmux now?", default: true });
      if (shouldInstall) {
        tryInstallTmux();
      }
    } catch {}
  }

  if (!isDaemonRunning()) {
    console.log("Starting daemon...");
    startDaemon();
  }

  // Set up autostart so daemon restarts on reboot/crash
  if (ensureAutostart()) {
    console.log("Auto-start configured (daemon will restart automatically)");
  }

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
    console.log("\nNo projects selected. You can change this later with 'cast config sync'.\n");
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

      const shareMode = await select({
        message: "What should teammates see?",
        choices: [
          { name: `Full ${fmt.muted("— complete session transcripts")}`, value: "full" as const },
          { name: `Summary ${fmt.muted("— goals, outcomes, and files changed only")}`, value: "summary" as const },
        ],
        default: "full",
      });

      config.team_share_mode = shareMode;
      writeConfig(config);
      const modeLabel = shareMode === "full" ? "full transcripts" : "summaries only";
      console.log(`\nSessions will be shared with ${fmt.accent(teams[0].name)} (${modeLabel}).`);
      console.log(`${fmt.muted("You can configure per-project sharing with 'cast sync-settings'")}\n`);
    } else {
      console.log(`\nSessions will be private by default.`);
      console.log(`${fmt.muted("You can share specific projects with 'cast sync-settings'")}\n`);
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

    console.log(`${fmt.muted("Configure more projects anytime with 'cast sync-settings'")}\n`);
  } else {
    console.log(`\n${fmt.muted("Run 'cast sync-settings' anytime to configure team sharing.")}\n`);
  }
}

const MEMORY_SNIPPET_END = "<!-- /codecast-memory -->";
const MEMORY_SNIPPET = `
## Memory

You are one session among many. Past conversations contain valuable context about decisions, patterns, and prior work. Search proactively and liberally - when starting tasks, debugging issues, or when the user references previous work. Parallelize searches when exploring multiple topics.

\`\`\`bash
# Search & Browse
cast search "auth"                # search current project
cast search "bug" -g -s 7d        # global, last 7 days
cast feed                         # browse recent conversations
cast read <id> 15:25              # read messages 15-25

# Analysis
cast diff <id>                    # files changed, commits, tools used
cast diff --today                 # aggregate today's work
cast summary <id>                 # goal, approach, outcome, files
cast context "implement auth"     # find relevant prior sessions
cast ask "how does X work"        # query across sessions

# Handoff & Tracking
cast handoff                      # generate context transfer doc
cast bookmark <id> <msg> --name x # save shareable link
cast decisions list               # view architectural decisions
cast decisions add "title" --reason "why"
\`\`\`

Common options: -g (global), -s/-e (start/end: 7d, 2w, yesterday), -p (page), -n (limit)
${MEMORY_SNIPPET_END}
`;

const TASK_SNIPPET_END = "<!-- /codecast-tasks -->";
const TASK_SNIPPET = `
## Async Tasks

You can schedule follow-up work that runs autonomously after this session ends. Use this for anything that should happen later: checking CI, reviewing PRs, continuing long-running refactors, or responding to events.

\`\`\`bash
# Schedule tasks
cast schedule add "Check if CI is green on main" --in 30m
cast schedule add "Review open PRs and summarize findings" --every 4h
cast schedule add "Respond to new PR review comments" --on pr_comment
cast schedule add "Continue the auth refactor" --in 2h --context current --mode apply

# Report completion (when running inside a task)
cast schedule complete <task_id> --summary "what was done"

# Manage tasks
cast schedule ls                       # list active tasks
cast schedule ls --all                 # include completed/failed
cast schedule pause <id>               # pause a task
cast schedule run <id>                 # run immediately
cast schedule cancel <id>              # cancel a task
cast schedule log <id>                 # show last run conversation
\`\`\`

Options:
- \`--in <duration>\`: delay before run (30m, 2h, 1d)
- \`--every <duration>\`: recurring interval
- \`--on <event>\`: trigger on webhook (pr_comment, pr_opened, pr_merged, push)
- \`--context current\`: capture current session context for the follow-up
- \`--mode apply\`: allow the task agent to make changes (default: propose = read-only)
- \`--project <path>\`: set working directory (defaults to current)
- \`--max-runtime <duration>\`: override max runtime (default: 10m)

When a task fires, a new agent session spawns with your prompt and the task ID. The agent should call \`cast schedule complete <task_id> --summary "..."\` when done to report results back.
${TASK_SNIPPET_END}
`;

const WORK_SNIPPET_END = "<!-- /codecast-work -->";
const WORK_SNIPPET = `
## Tasks & Plans

You operate within a structured work system. Tasks are specific work items with acceptance criteria. Plans group tasks toward a goal. A human monitors progress through a dashboard — communicate status through the system, not through chat.

### Orientation

Before diving into implementation, understand where your work fits:
- If bound to a task: you own that task. Read its acceptance criteria carefully. Check sibling tasks to understand what's adjacent and avoid conflicts.
- If bound to a plan: you coordinate across tasks. Keep the goal coherent as work progresses.
- If unbound: you're in freeform mode. If the work becomes structured enough to track, suggest creating a task or plan.

When work spans multiple turns or survives compaction, re-read your task or plan context (\`cast task context <id>\` / \`cast plan show <id>\`) to reground yourself. Don't rely on memory of earlier conversation alone.

### Communicating status

The dashboard is the source of truth. Update it as you work:
- \`cast task start <id>\` — claim a task, binds your session
- \`cast task comment <id> "progress" -t progress\` — log what you've done
- \`cast task done <id> -m "summary"\` — mark complete with what you verified
- \`cast plan decide <plan_id> "rationale"\` — record decisions that affect the plan

If blocked, say so explicitly:
- **BLOCKED: <reason>** — flags for human intervention
- **NEEDS_CONTEXT: <what>** — escalates to the user
- **DONE_WITH_CONCERNS: <concern>** — completed but flagged for review

### Keeping the plan coherent

You see your slice of the work, but the plan is bigger. If you notice:
- A task is larger than expected — suggest splitting it
- Your work creates a dependency for another task — flag it
- A decision you're making affects the plan's direction — record it with \`cast plan decide\`
- Acceptance criteria are ambiguous or contradictory — ask before assuming

### Commands

\`\`\`bash
cast task ready                             # Find available work
cast task start/done/comment <id>           # Task lifecycle
cast task create "Title" -t task -p high    # Create task
cast task create "Title" --plan <plan_id>   # Create task bound to plan
cast task update <id> --plan <plan_id>      # Bind existing task to plan
cast task context <id>                      # Full context (re-read after compaction)
cast plan create "Title" -g "goal" -b "body"  # Create plan with inline body
cast plan create "Title" --body-file plan.md  # Create plan from file
cast plan bind <plan_id>                    # Bind session to plan
cast plan unbind <plan_id>                  # Unbind session from plan
cast plan decompose <plan_id>              # Generate tasks from goal
cast plan orchestrate <plan_id>            # Spawn agents for ready tasks
cast plan show/status <plan_id>            # Plan details
cast plan update <plan_id> -n "note"       # Log progress
cast plan decide <plan_id> "decision" --rationale "why"
cast plan done/drop <plan_id>             # Close or abandon a plan
\`\`\`
${WORK_SNIPPET_END}
`;

const PLAN_SNIPPET_END = "<!-- /codecast-plans -->";

const WORKFLOW_SNIPPET_END = "<!-- /codecast-workflows -->";
const WORKFLOW_SNIPPET = `
## Workflows

Workflows are execution graphs (DOT syntax) that define multi-step processes with loops, conditions, and human approval gates. They bind to tasks or plans.

\`\`\`bash
cast workflow run flow.cast --task ct-xxxx  # Execute workflow for a task
cast workflow run flow.cast --plan pl-xxxx  # Execute workflow for a plan
cast workflow list                          # Available templates
cast workflow push                          # Push workflow to web UI
\`\`\`

Workflow nodes can be: agent sessions (\`backend=claude\`), shell commands, human approval gates, or conditionals. The web dashboard shows workflow progress and gate buttons.

When collaborating on workflow creation, use DOT syntax:
\`\`\`dot
digraph my_flow {
  graph [goal="$task_title"]
  start [shape=Mdiamond]
  implement [label="Implement", backend=claude, prompt="..."]
  verify [label="Verify", shape=parallelogram, script="npx tsc --noEmit"]
  review [label="Review", shape=hexagon]
  exit [shape=Msquare]
  start -> implement -> verify
  verify -> review [condition="outcome = success"]
  verify -> implement [condition="outcome = failure"]
  review -> exit [label="[A] Approve"]
  review -> implement [label="[R] Revise"]
}
\`\`\`
${WORKFLOW_SNIPPET_END}
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

  const hasMemory = existing.includes("## Memory") && (existing.includes("codecast search") || existing.includes("cast search"));
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

function installTaskSnippetToFile(filePath: string, dirPath: string, update: boolean): { installed: boolean; updated: boolean } {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }

  const hasTask = existing.includes("## Async Tasks") && (existing.includes("codecast task") || existing.includes("cast task"));
  if (hasTask && !update) {
    return { installed: false, updated: false };
  }

  if (hasTask && update) {
    const taskStart = existing.indexOf("## Async Tasks");
    let taskEnd = existing.length;

    const endMarkerIdx = existing.indexOf(TASK_SNIPPET_END, taskStart);
    if (endMarkerIdx !== -1) {
      taskEnd = endMarkerIdx + TASK_SNIPPET_END.length;
      if (existing[taskEnd] === "\n") taskEnd++;
    } else {
      const nextSection = existing.slice(taskStart + 10).match(/\n## [A-Z]/);
      if (nextSection && nextSection.index !== undefined) {
        taskEnd = taskStart + 10 + nextSection.index;
      }
    }

    const before = existing.slice(0, taskStart);
    const after = existing.slice(taskEnd);
    existing = before + after;
    fs.writeFileSync(filePath, existing.trimEnd() + "\n" + TASK_SNIPPET, { mode: 0o600 });
    return { installed: true, updated: true };
  }

  fs.writeFileSync(filePath, existing + TASK_SNIPPET, { mode: 0o600 });
  return { installed: true, updated: false };
}

function installTaskSnippet(update = false): { installed: boolean; updated: boolean } {
  const targets = getSnippetTargets();
  let anyInstalled = false;
  let anyUpdated = false;

  for (const target of targets) {
    const result = installTaskSnippetToFile(target.filePath, target.dirPath, update);
    if (result.installed) anyInstalled = true;
    if (result.updated) anyUpdated = true;
  }

  return { installed: anyInstalled, updated: anyUpdated };
}

function installWorkSnippetToFile(filePath: string, dirPath: string, update: boolean): { installed: boolean; updated: boolean } {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }

  const hasWork = (existing.includes("## Issue Tracking with codecast task") || existing.includes("## Issue Tracking with cast task") || existing.includes("## Tasks, Plans & Workflows") || existing.includes("## Tasks & Plans")) && existing.includes(WORK_SNIPPET_END);
  if (hasWork && !update) {
    return { installed: false, updated: false };
  }

  if (hasWork && update) {
    let workStart = existing.indexOf("## Tasks & Plans");
    if (workStart === -1) workStart = existing.indexOf("## Tasks, Plans & Workflows");
    if (workStart === -1) workStart = existing.indexOf("## Issue Tracking with codecast task");
    if (workStart === -1) workStart = existing.indexOf("## Issue Tracking with cast task");
    let workEnd = existing.length;

    const endMarkerIdx = existing.indexOf(WORK_SNIPPET_END, workStart);
    if (endMarkerIdx !== -1) {
      workEnd = endMarkerIdx + WORK_SNIPPET_END.length;
      if (existing[workEnd] === "\n") workEnd++;
    }

    const before = existing.slice(0, workStart);
    const after = existing.slice(workEnd);
    existing = before + after;
    fs.writeFileSync(filePath, existing.trimEnd() + "\n" + WORK_SNIPPET, { mode: 0o600 });
    return { installed: true, updated: true };
  }

  fs.writeFileSync(filePath, existing + WORK_SNIPPET, { mode: 0o600 });
  return { installed: true, updated: false };
}

function installWorkSnippet(update = false): { installed: boolean; updated: boolean } {
  const targets = getSnippetTargets();
  let anyInstalled = false;
  let anyUpdated = false;

  for (const target of targets) {
    const result = installWorkSnippetToFile(target.filePath, target.dirPath, update);
    if (result.installed) anyInstalled = true;
    if (result.updated) anyUpdated = true;
  }

  return { installed: anyInstalled, updated: anyUpdated };
}


function installWorkflowSnippetToFile(filePath: string, dirPath: string, update: boolean): { installed: boolean; updated: boolean } {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  }

  const hasWorkflow = existing.includes("## Workflows") && existing.includes(WORKFLOW_SNIPPET_END);
  if (hasWorkflow && !update) {
    return { installed: false, updated: false };
  }

  if (hasWorkflow && update) {
    const wfStart = existing.indexOf("## Workflows");
    let wfEnd = existing.length;

    const endMarkerIdx = existing.indexOf(WORKFLOW_SNIPPET_END, wfStart);
    if (endMarkerIdx !== -1) {
      wfEnd = endMarkerIdx + WORKFLOW_SNIPPET_END.length;
      if (existing[wfEnd] === "\n") wfEnd++;
    }

    const before = existing.slice(0, wfStart);
    const after = existing.slice(wfEnd);
    existing = before + after;
    fs.writeFileSync(filePath, existing.trimEnd() + "\n" + WORKFLOW_SNIPPET, { mode: 0o600 });
    return { installed: true, updated: true };
  }

  fs.writeFileSync(filePath, existing + WORKFLOW_SNIPPET, { mode: 0o600 });
  return { installed: true, updated: false };
}

function installWorkflowSnippet(update = false): { installed: boolean; updated: boolean } {
  const targets = getSnippetTargets();
  let anyInstalled = false;
  let anyUpdated = false;

  for (const target of targets) {
    const result = installWorkflowSnippetToFile(target.filePath, target.dirPath, update);
    if (result.installed) anyInstalled = true;
    if (result.updated) anyUpdated = true;
  }

  return { installed: anyInstalled, updated: anyUpdated };
}

async function promptMemoryEnablement(): Promise<void> {
  const config = readConfig() || {};

  // Auto-update already-enabled snippets
  // Work snippet is auto-installed with memory; schedule, workflow, plan are opt-in via their install commands
  if (config.work_enabled && config.work_version !== getWorkVersion()) {
    const workResult = installWorkSnippet(true);
    config.work_version = getWorkVersion();
    writeConfig(config);
    if (workResult.updated) {
      const targets = getSnippetTargets();
      console.log(`Work snippet updated to latest version in ${targets.map(t => t.label).join(", ")}.`);
    }
  } else if (config.work_enabled) {
    installWorkSnippet(false);
  }
  if (config.task_enabled && config.task_version !== getTaskVersion()) {
    const result = installTaskSnippet(true);
    config.task_version = getTaskVersion();
    writeConfig(config);
    if (result.updated) {
      const targets = getSnippetTargets();
      console.log(`Schedule snippet updated to latest version in ${targets.map(t => t.label).join(", ")}.`);
    }
  }
  if (config.workflow_enabled && config.workflow_version !== getWorkflowVersion()) {
    const result = installWorkflowSnippet(true);
    config.workflow_version = getWorkflowVersion();
    writeConfig(config);
    if (result.updated) {
      const targets = getSnippetTargets();
      console.log(`Workflow snippet updated to latest version in ${targets.map(t => t.label).join(", ")}.`);
    }
  }

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
    if ((content.includes("codecast search") || content.includes("cast search")) && config.memory_enabled === undefined) {
      config.memory_enabled = true;
      config.memory_version = getMemoryVersion();
      config.work_enabled = true;
      config.work_version = getWorkVersion();
      writeConfig(config);
      installMemorySnippet(false);
      installWorkSnippet(false);
      return;
    }
  }

  console.log("--- Agent Memory ---");
  console.log("Lets your agents search and learn from past conversations.");
  console.log(`${fmt.muted("Adds cast commands to your agent config so they can recall prior work.")}\n`);

  const enableMemory = await confirm({
    message: "Enable agent memory?",
    default: true,
  });

  if (enableMemory) {
    const result = installMemorySnippet(false);
    installWorkSnippet(false);
    if (result.installed) {
      const targets = getSnippetTargets();
      console.log(`\nMemory enabled. Added to:`);
      for (const t of targets) { console.log(`  ${t.label}`); }
    }
    config.memory_enabled = true;
    config.memory_version = getMemoryVersion();
    config.work_enabled = true;
    config.work_version = getWorkVersion();
    writeConfig(config);
    console.log();
  } else {
    console.log(`\nSkipped. Run ${fmt.cmd("cast memory")} later to enable.\n`);
    config.memory_enabled = false;
    writeConfig(config);
  }
}

async function promptStableEnablement(): Promise<void> {
  const config = readConfig() || {};

  if (config.stable_mode !== undefined) {
    return;
  }

  console.log("--- Stable Context ---");
  console.log("Injects recent session summaries into every new conversation,");
  console.log("so your agent starts each session aware of recent work.");
  console.log(`${fmt.muted("Adds a lightweight hook on session start. Minimal prompt overhead.")}\n`);

  const enableStable = await confirm({
    message: "Enable stable context?",
    default: false,
  });

  if (enableStable) {
    (config as any).stable_mode = "solo";
    (config as any).stable_global = false;
    writeConfig(config);
    installStableHook();
    console.log(`\nStable context enabled (solo, current project).`);
    console.log(`${fmt.muted("Run")} ${fmt.cmd("cast stable team")} ${fmt.muted("for team-wide context, or")} ${fmt.cmd("cast stable off")} ${fmt.muted("to disable.")}\n`);
  } else {
    console.log(`\nSkipped. Run ${fmt.cmd("cast stable solo")} later to enable.\n`);
  }
}

async function runSync(): Promise<void> {
  const config = readConfig();

  if (!config?.auth_token || !config?.user_id) {
    console.error("Not authenticated. Run 'cast auth' first.");
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
      const projectPath = readProjectPathFromSession(file.path) || ("/" + projectDir.slice(1).replace(/-/g, "/"));
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
    const actualProjectPath = readProjectPathFromSession(sessionFile) || ("/" + projectDir.slice(1).replace(/-/g, "/"));

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
  .name("cast")
  .description(
    "Sync coding agent conversations to a shared Convex database\n\n" +
    "Quick Start:\n" +
    "  1. cast auth          # Authenticate with your account\n" +
    "  2. cast start         # Start background sync daemon\n" +
    "  3. cast status        # Check sync status"
  )
  .version(getVersion())
  .action(() => {
    program.outputHelp();
  });

program
  .command("auth")
  .description("Authenticate with cast using browser OAuth flow")
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
  .command("restart")
  .description("Restart the background daemon (update if available, then start)")
  .action(async () => {
    stopDaemon();
    const available = await checkForUpdates(true);
    if (available) {
      console.log(`Update available: v${getVersion()} -> v${available}, updating...`);
      const success = await performUpdate();
      if (success) {
        console.log(`Updated to v${available}`);
      } else {
        console.log("Update failed, restarting with current version");
      }
    }
    startDaemon();
    ensureAutostart();
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
  .command("attach")
  .description("Open live tmux session TUI and attach/switch quickly")
  .option("--plain", "Use plain list mode (no TUI)")
  .option("--gc", "Kill sessions idle for more than 1 hour, then open TUI")
  .option("--gc-mins <minutes>", "Idle threshold in minutes (default: 60)")
  .action(async (options) => {
    if (!ensureTmux()) return;

    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }

    if (options.gc) {
      const mins = Number.parseInt(options.gcMins || "60", 10) || 60;
      const { gcStaleSessions } = await import("./attachTui.js");
      const { killed } = gcStaleSessions(mins * 60);
      if (killed.length > 0) {
        console.log(`Killed ${killed.length} stale session${killed.length === 1 ? "" : "s"}: ${killed.join(", ")}`);
      } else {
        console.log("No stale sessions to clean up.");
      }
    }

    if (options.plain || !process.stdout.isTTY || !process.stdin.isTTY) {
      await selectAndAttachFromLiveSessions(config, { tmuxOnly: true });
      return;
    }

    const { runAttachTui } = await import("./attachTui.js");
    await runAttachTui({
      authToken: config.auth_token,
      convexUrl: config.convex_url,
    });
  });

program
  .command("gc")
  .description("Kill tmux sessions idle for more than the specified threshold")
  .option("-m, --mins <minutes>", "Idle threshold in minutes (default: 60)")
  .option("--dry-run", "Show what would be killed without actually killing")
  .action(async (options) => {
    if (!ensureTmux()) return;

    const mins = Number.parseInt(options.mins || "60", 10) || 60;
    const { gcStaleSessions, discoverWithIdleTimes } = await import("./attachTui.js");

    if (options.dryRun) {
      const sessions = discoverWithIdleTimes();
      const nowSec = Math.floor(Date.now() / 1000);
      const stale = sessions.filter((s) => s.idleSec >= mins * 60);
      if (stale.length === 0) {
        console.log(`No sessions idle for >${mins}m.`);
        return;
      }
      console.log(`Would kill ${stale.length} session${stale.length === 1 ? "" : "s"}:`);
      for (const s of stale) {
        const idleMins = Math.floor(s.idleSec / 60);
        console.log(`  ${s.tmuxSession}  (idle ${idleMins}m)`);
      }
      return;
    }

    const { killed } = gcStaleSessions(mins * 60);
    if (killed.length > 0) {
      console.log(`Killed ${killed.length} stale session${killed.length === 1 ? "" : "s"}: ${killed.join(", ")}`);
    } else {
      console.log(`No sessions idle for >${mins}m.`);
    }
  });

program
  .command("repair")
  .description("Repair project paths that were stored incorrectly")
  .option("--dry-run", "Show what would be repaired without making changes")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
        console.log(fmt.error("  Not authenticated. Run 'cast auth' first."));
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
      console.log(`      ${fmt.muted("Use")} ${fmt.cmd("cast health --clear-dropped")} ${fmt.muted("to clear")}`);
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
    console.log(`      ${fmt.muted("Use")} ${fmt.cmd("cast health --reconcile")} ${fmt.muted("to run now")}`);
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
    "  cast config                    # View all configuration\n" +
    "  cast config excluded_paths     # View specific setting\n" +
    "  cast config excluded_paths \"**/node_modules/**\"  # Set value"
  )
  .argument("[key]", "Configuration key (auth_token, web_url, user_id, convex_url, team_id, excluded_paths)")
  .argument("[value]", "Value to set for the key")
  .allowUnknownOption()
  .action(async (key, value) => {
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
        const adp = config.agent_default_params;
        if (adp && Object.keys(adp).some(a => {
          const p = adp[a as keyof typeof adp];
          return p && Object.keys(p).length > 0;
        })) {
          console.log("  agent_default_params:");
          for (const [agent, params] of Object.entries(adp)) {
            if (params && Object.keys(params).length > 0) {
              for (const [k, v] of Object.entries(params)) {
                console.log(`    ${agent}: --${k} ${v}`);
              }
            }
          }
        }
      } else {
        console.log("  (no configuration found - run 'cast setup')");
      }
      return;
    }

    if (key === "agent") {
      const idx = process.argv.indexOf("config");
      const extraArgs = process.argv.slice(idx + 2);
      const agentArg = extraArgs[0];

      if (!agentArg) {
        const allParams = config?.agent_default_params;
        if (!allParams || Object.keys(allParams).every(a => {
          const p = allParams[a as keyof typeof allParams];
          return !p || Object.keys(p).length === 0;
        })) {
          console.log("No agent default params configured.");
          console.log("\nUsage: cast config agent <agent> --<flag> <value> [--<flag> <value> ...]");
          console.log("  cast config agent claude --effort max");
          console.log("  cast config agent claude --effort max --model claude-opus-4-6");
          return;
        }
        for (const [agent, params] of Object.entries(allParams)) {
          if (params && Object.keys(params).length > 0) {
            console.log(`\n${agent}:`);
            for (const [k, v] of Object.entries(params)) {
              console.log(`  --${k} ${v}`);
            }
          }
        }
        return;
      }

      const validAgents = ["claude", "codex", "gemini", "cursor"];
      if (!validAgents.includes(agentArg)) {
        console.error(`Unknown agent: ${agentArg}`);
        console.log(`Valid agents: ${validAgents.join(", ")}`);
        process.exit(1);
      }

      const flagArgs = extraArgs.slice(1);
      if (flagArgs.length === 0) {
        const params = config?.agent_default_params?.[agentArg as keyof NonNullable<Config["agent_default_params"]>];
        if (!params || Object.keys(params).length === 0) {
          console.log(`No default params for ${agentArg}.`);
          return;
        }
        console.log(`${agentArg}:`);
        for (const [k, v] of Object.entries(params)) {
          console.log(`  --${k} ${v}`);
        }
        return;
      }

      const parsedFlags: Record<string, string> = {};
      for (let i = 0; i < flagArgs.length; i++) {
        const arg = flagArgs[i];
        if (arg.startsWith("--")) {
          const flagName = arg.replace(/^--/, "");
          const flagValue = flagArgs[i + 1];
          if (!flagValue || flagValue.startsWith("--")) {
            console.error(`Missing value for --${flagName}`);
            process.exit(1);
          }
          parsedFlags[flagName] = flagValue;
          i++;
        } else {
          const flagName = arg;
          const flagValue = flagArgs[i + 1];
          if (!flagValue || flagValue.startsWith("--")) {
            const params = config?.agent_default_params?.[agentArg as keyof NonNullable<Config["agent_default_params"]>];
            const val = params?.[flagName];
            console.log(`${agentArg} --${flagName}: ${val || "(not set)"}`);
            return;
          }
          parsedFlags[flagName] = flagValue;
          i++;
        }
      }

      const updatedConfig: Config = config || {};
      const allParams: any = updatedConfig.agent_default_params || {};
      const agentParams = { ...(allParams[agentArg] || {}), ...parsedFlags };
      allParams[agentArg] = agentParams;
      updatedConfig.agent_default_params = allParams;
      writeConfig(updatedConfig);
      for (const [k, v] of Object.entries(parsedFlags)) {
        console.log(`Updated ${agentArg} --${k} ${v}`);
      }

      try {
        const { ConvexHttpClient } = await import("convex/browser");
        const client = new ConvexHttpClient(updatedConfig.convex_url!);
        await (client as any).mutation("users:updateAgentDefaultParams", {
          api_token: updatedConfig.auth_token,
          agent: agentArg,
          params: agentParams,
        });
      } catch (_e) {
        // Server sync failed silently - local config is updated
      }

      return;
    }

    const settableKeys = ["auth_token", "web_url", "user_id", "convex_url", "team_id", "excluded_paths", "claude_args", "codex_args"] as const;
    const sensitiveKeys = ["auth_token"];
    type SettableKey = (typeof settableKeys)[number];

    if (!settableKeys.includes(key as SettableKey)) {
      console.error(`Unknown config key: ${key}`);
      console.log(`Valid keys: ${settableKeys.join(", ")}, agent`);
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
    "  cast sync-settings           # Interactive project and team configuration\n" +
    "  cast sync-settings --all     # Sync all projects\n" +
    "  cast sync-settings --show    # Show current settings only"
  )
  .option("--all", "Sync all projects")
  .option("--show", "Show current settings without prompting")
  .action(async (options) => {
    const config = readConfig();

    if (!config?.auth_token) {
      console.error("Not authenticated. Run: cast auth");
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

    console.log(`\n${c.bold}cast${c.reset} ${fmt.muted("Sync Settings")}\n`);

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
      console.log(`${fmt.muted("Tip: Use")} cast teams map <path> <team> ${fmt.muted("to map projects directly.")}`);
    } else {
      console.log(`${fmt.muted("Tip: Create or join a team at")} ${fmt.accent("codecast.sh/settings/team")}`);
    }
  });

program
  .command("teams")
  .description(
    "Manage teams and directory mappings\n\n" +
    "Examples:\n" +
    "  cast teams                      # List your teams\n" +
    "  cast teams mappings             # Show directory-to-team mappings\n" +
    "  cast teams map <path> <team>    # Map a directory to a team\n" +
    "  cast teams unmap <path>         # Remove a directory mapping"
  )
  .argument("[action]", "Action: mappings, map, unmap")
  .argument("[path]", "Directory path (for map/unmap)")
  .argument("[team]", "Team ID or name (for map)")
  .action(async (action, pathArg, teamArg) => {
    const config = readConfig();

    if (!config?.auth_token) {
      console.error("Not authenticated. Run: cast auth");
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
      console.log(`\n${fmt.muted("Run 'cast teams mappings' to see which projects share with which teams.")}`);
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
        console.error("Usage: cast teams map <path> <team_id_or_name>");
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
        console.error("Usage: cast teams unmap <path>");
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
    "  cast logs              # View all logs\n" +
    "  cast logs -n 50        # View last 50 lines\n" +
    "  cast logs -f           # Follow logs in real-time"
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
    "  cast search auth                 # word match\n" +
    "  cast search \"error handling\"    # exact phrase match\n" +
    "  cast search auth -g -s 7d        # global, last 7 days"
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
      console.error("Not authenticated. Run: cast auth");
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
    "  cast feed                    # recent sessions\n" +
    "  cast feed -g                 # all projects globally\n" +
    "  cast feed -s 7d              # last 7 days\n" +
    "  cast feed -q auth            # recent sessions mentioning 'auth'\n" +
    "  cast feed -p 2               # page 2 (skip first 10)"
  )
  .option("-g, --global", "Show all sessions (not just current project)")
  .option("-q, --query <text>", "Filter by keyword (keeps recency order)")
  .option("-m, --member <name>", "Filter by team member name or email")
  .option("-n, --limit <n>", "Number of conversations per page", "10")
  .option("-p, --page <n>", "Page number (1-indexed)", "1")
  .option("-s, --start <date>", "Start date/time (e.g., 7d, 2w, yesterday, 2024-01-15)")
  .option("-e, --end <date>", "End date/time")
  .option("-l, --live", "Show only live sessions (currently running)")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
          ...(options.live ? { live_only: true } : {}),
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

program
  .command("list")
  .description(
    "Chronological list of sessions with title, summary, and link\n\n" +
    "Examples:\n" +
    "  cast list                    # recent sessions\n" +
    "  cast list -g                 # all projects\n" +
    "  cast list -n 20              # show 20 sessions\n" +
    "  cast list -s 7d              # last 7 days"
  )
  .option("-g, --global", "Show all sessions (not just current project)")
  .option("-n, --limit <n>", "Number of sessions to show", "10")
  .option("-p, --page <n>", "Page number", "1")
  .option("-s, --start <date>", "Start date/time (e.g., 7d, 2w, yesterday)")
  .option("-e, --end <date>", "End date/time")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
          project_path: projectPath,
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { formatListResults } = await import("./formatter.js");
      console.log(formatListResults(result, { projectPath, page }));
    } catch (error) {
      console.error("List failed:", error instanceof Error ? error.message : error);
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

interface LiveProcessDiscoveryOptions {
  tmuxOnly?: boolean;
  fastSessionLookup?: boolean;
}

function normalizePsTty(tty: string): string {
  if (tty.startsWith("/dev/")) return tty;
  if (/^s\d+$/.test(tty)) return `/dev/tty${tty}`;
  return `/dev/${tty}`;
}

function loadSessionRegistryLookups(): { byPid: Map<number, string>; byTty: Map<string, string> } {
  const byPid = new Map<number, string>();
  const byTty = new Map<string, string>();
  const registryDir = path.join(os.homedir(), ".codecast", "session-registry");

  if (!fs.existsSync(registryDir)) return { byPid, byTty };

  const nowSec = Math.floor(Date.now() / 1000);
  for (const file of fs.readdirSync(registryDir)) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.slice(0, -5);
    const filePath = path.join(registryDir, file);
    try {
      const reg = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { pid?: unknown; tty?: unknown; ts?: unknown };
      const ts = typeof reg.ts === "number" ? reg.ts : 0;
      if (!ts || nowSec - ts > 2 * 24 * 60 * 60) continue;
      if (typeof reg.pid === "number" && reg.pid > 0) byPid.set(reg.pid, sessionId);
      if (typeof reg.tty === "string" && reg.tty && reg.tty !== "?" && reg.tty !== "??") {
        byTty.set(normalizePsTty(reg.tty), sessionId);
      }
    } catch {}
  }

  return { byPid, byTty };
}

function discoverLiveProcesses(options: LiveProcessDiscoveryOptions = {}): LiveProcess[] {
  const tmuxOnly = !!options.tmuxOnly;
  const fastSessionLookup = !!options.fastSessionLookup;
  const procs: LiveProcess[] = [];
  const seen = new Set<number>();
  const seenTty = new Set<string>();
  const sessionRegistry = loadSessionRegistryLookups();

  const tmuxPanes: Record<string, string> = {};
  try {
    const out = execSync("tmux list-panes -a -F '#{pane_tty} #{session_name}' 2>/dev/null", { encoding: "utf-8", timeout: 10_000 });
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
    const tmuxSession = tmuxPanes[normalTty] || null;
    if (tmuxOnly && !tmuxSession) return;
    if (seen.has(pid) || seenTty.has(normalTty)) return;
    seen.add(pid);
    seenTty.add(normalTty);

    let startTime = "";
    try { startTime = execSync(`ps -o lstart= -p ${pid}`, { encoding: "utf-8" }).trim(); } catch {}

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
      const normalTty = normalizePsTty(tty);
      if (tmuxOnly && !tmuxPanes[normalTty]) continue;
      const args = parts.slice(10).join(" ");
      const resumeMatch = args.match(/--resume\s+([0-9a-f-]{36})/i);
      const sidFromRegistry = sessionRegistry.byPid.get(pid) || sessionRegistry.byTty.get(normalTty) || null;
      const sid = resumeMatch ? resumeMatch[1] : sidFromRegistry || (fastSessionLookup ? null : findSessionByCwd(pid));
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
      const normalTty = normalizePsTty(tty);
      if (tmuxOnly && !tmuxPanes[normalTty]) continue;
      const sidFromRegistry = sessionRegistry.byPid.get(pid) || sessionRegistry.byTty.get(normalTty) || null;
      const sid = sidFromRegistry || (fastSessionLookup ? null : findCodexSessionByCwd(pid));
      addProcess(pid, tty, sid || `unknown-codex-${pid}`, "codex");
    }
  } catch {}

  return procs;
}

async function selectAndAttachFromLiveSessions(
  config: Config,
  options: { cliOverrideArgs?: string; tmuxOnly?: boolean } = {},
): Promise<void> {
  const rawProcs = discoverLiveProcesses({
    tmuxOnly: options.tmuxOnly,
    fastSessionLookup: !!options.tmuxOnly,
  });

  if (rawProcs.length === 0) {
    if (options.tmuxOnly) {
      console.log(`${c.dim}No live tmux sessions found${c.reset}`);
      console.log(`\n${c.dim}Start one in tmux, then run:${c.reset}  cast attach`);
    } else {
      console.log(`${c.dim}No live sessions found${c.reset}`);
      console.log(`\n${c.dim}Start a session with:${c.reset}  claude`);
      console.log(`${c.dim}Search history with:${c.reset}  cast resume <query>`);
    }
    return;
  }

  const dedupMap = new Map<string, LiveProcess>();
  const labelRank: Record<string, number> = { managed: 3, resumed: 2, tmux: 1, iTerm: 0 };
  for (const p of rawProcs) {
    const existing = dedupMap.get(p.sessionId);
    if (!existing || (labelRank[p.label] ?? 0) > (labelRank[existing.label] ?? 0)) {
      dedupMap.set(p.sessionId, p);
    }
  }
  const sessions = Array.from(dedupMap.values());

  const sessionIds = sessions.filter(p => !p.sessionId.startsWith("unknown")).map(p => p.sessionId);
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

  sessions.sort((a, b) => {
    const ca = convexData[a.sessionId];
    const cb = convexData[b.sessionId];
    if (ca && cb) return new Date(cb.updated_at).getTime() - new Date(ca.updated_at).getTime();
    if (ca && !cb) return -1;
    if (!ca && cb) return 1;
    return 0;
  });

  const { formatRelativeTime } = await import("./formatter.js");
  const home = os.homedir();

  const choices: Array<{ name: string; value: string; description?: string }> = sessions.map((p, idx) => {
    const conv = convexData[p.sessionId];
    const title = conv?.title || `Session ${p.sessionId.startsWith("unknown") ? `PID ${p.pid}` : p.sessionId.slice(0, 8)}`;
    const displayTitle = title.length > 65 ? title.slice(0, 65) + "..." : title;

    const meta: string[] = [];
    if (conv) {
      meta.push(`last msg ${formatRelativeTime(conv.updated_at)}`);
      meta.push(`${conv.message_count} msgs`);
    } else {
      meta.push(`up ${p.uptime}`);
    }
    meta.push(p.label);
    if (p.agentType === "codex" || conv?.agent_type === "codex") meta.push("Codex");
    const projectPath = conv?.project_path;
    if (projectPath) {
      meta.push(projectPath.startsWith(home) ? "~" + projectPath.slice(home.length) : projectPath);
    }

    let desc = meta.join(" | ");
    if (conv?.preview) {
      const msgLine = conv.preview.split("\n")[0].trim();
      desc += `\n     ${c.green}>${c.reset} ${msgLine.length > 75 ? msgLine.slice(0, 75) + "..." : msgLine}`;
    }

    return { name: `${c.bold}${displayTitle}${c.reset}`, value: String(idx), description: desc };
  });

  const liveLabel = options.tmuxOnly ? "tmux sessions" : "sessions";
  console.log(`\n${c.dim}${sessions.length} live ${liveLabel}${c.reset}\n`);

  const selected = await select({
    message: "Attach to session",
    choices,
    pageSize: Math.min(12, choices.length),
  });

  const session = sessions[parseInt(selected, 10)];
  if (!session) return;

  if (session.tmuxSession) {
    console.log(`\nAttaching to tmux session: ${session.tmuxSession}`);
    spawnSync("tmux", ["attach-session", "-t", session.tmuxSession], { stdio: "inherit" });
    return;
  }

  if (!session.sessionId.startsWith("unknown")) {
    console.log(`\nResuming: ${session.sessionId.slice(0, 8)}`);
    const extraArgs = resolveAgentArgs(session.agentType, options.cliOverrideArgs, config);
    launchSession(session.sessionId, session.agentType, extraArgs, !extraArgs);
    return;
  }

  console.log(`\nSession PID ${session.pid} on ${session.tty} -- attach manually or use tmux`);
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
    "  cast config claude_args \"--dangerously-skip-permissions\"\n" +
    "  cast config codex_args \"--dangerously-bypass-approvals-and-sandbox\"\n\n" +
    "Examples:\n" +
    "  cast resume                          # list live sessions\n" +
    "  cast resume logo design              # search: 'logo' AND 'design'\n" +
    "  cast resume \"logo design\"            # exact phrase\n" +
    "  cast resume <session-id> --as codex  # convert/resume by exact session id\n" +
    "  cast resume auth --as codex          # resume Claude session in Codex"
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
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }

    if (options.as && !["claude", "codex"].includes(options.as.toLowerCase())) {
      console.error(`Invalid --as value: "${options.as}". Use "claude" or "codex".`);
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");

    // No query: show live sessions
    if (!queryWords || queryWords.length === 0) {
      await selectAndAttachFromLiveSessions(config, { cliOverrideArgs: options.claudeArgs });
      return;
    }

    const query = queryWords.join(" ");
    const limit = parseInt(options.limit);
    const projectPath = options.global ? undefined : getRealCwd();
    const isExactUuid = queryWords.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queryWords[0]);
    const isAgentSessionId = queryWords.length === 1 && /^agent-[0-9a-f]+$/i.test(queryWords[0]);
    const exactSessionId = (isExactUuid || isAgentSessionId) ? queryWords[0] : null;

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

    // Try short codecast ID (e.g. "jx7c6wr") - resolve via export endpoint
    const isShortId = queryWords.length === 1 && /^[a-z0-9]{5,10}$/i.test(queryWords[0]) && !exactSessionId;
    if (isShortId) {
      try {
        const exportResp = await fetch(`${siteUrl}/cli/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            conversation_id: queryWords[0],
            limit: 1,
          }),
        });
        if (exportResp.ok) {
          const exportData = await exportResp.json() as {
            error?: string;
            conversation?: {
              id: string;
              title: string;
              session_id: string;
              agent_type: string;
              project_path: string | null;
            };
          };
          if (exportData.conversation && !exportData.error) {
            const conv = exportData.conversation;
            const targetAgent = options.as?.toLowerCase();
            const sourceAgent = conv.agent_type || "claude_code";
            const normalizedSource = sourceAgent === "claude_code" ? "claude" : sourceAgent;

            if (options.dryRun) {
              if (targetAgent && targetAgent !== normalizedSource) {
                console.log(`Would convert ${normalizedSource} session ${conv.session_id} to ${targetAgent}`);
              } else {
                const effectiveAgent = targetAgent === "claude" ? "claude_code" : targetAgent === "codex" ? "codex" : sourceAgent;
                const cmd = effectiveAgent === "codex"
                  ? `codex resume ${conv.session_id}`
                  : `claude --resume ${conv.session_id}`;
                console.log(`Would run: ${cmd}`);
              }
              return;
            }

            console.log(`Opening: ${conv.title}`);
            if (targetAgent && targetAgent !== normalizedSource) {
              await convertAndLaunch(
                conv.id,
                normalizedSource,
                targetAgent,
                config,
                options.claudeArgs,
                options.claudeTail,
                options.claudeFull,
                false,
                options.here ? undefined : conv.project_path,
              );
            } else {
              const effectiveAgent = targetAgent === "claude" ? "claude_code" : targetAgent === "codex" ? "codex" : sourceAgent;
              const extraArgs = resolveAgentArgs(effectiveAgent, options.claudeArgs, config);
              launchSession(conv.session_id, effectiveAgent, extraArgs, !extraArgs, options.here ? undefined : conv.project_path);
            }
            return;
          }
        }
      } catch {
        // Fall through to search
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
        console.log("  cast resume \"different query\"");
        console.log("  cast feed -g  # browse all sessions");
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

      const renderResumeCards = (current: any[], selectedIndex: number, currentOffset: number, hasMore: boolean) => {
        const lines: string[] = [];
        lines.push(`${c.dim}Found sessions matching "${query}"${c.reset}`);
        lines.push(`${c.dim}Showing ${currentOffset + 1}-${currentOffset + current.length}${hasMore ? "+" : ""}${c.reset}`);
        lines.push("");

        for (let i = 0; i < current.length; i++) {
          const conv = current[i];
          const isSelected = i === selectedIndex;
          const cursor = isSelected ? `${c.cyan}>${c.reset}` : " ";
          const title = conv.title || "Untitled";
          const relTime = formatRelativeTime(conv.updated_at);

          const metaParts: string[] = [
            `${c.dim}${relTime}${c.reset}`,
            `${c.dim}${conv.message_count} msgs${c.reset}`,
          ];
          if (conv.user) {
            const name = conv.user.name || conv.user.email || "team member";
            metaParts.push(`${c.magenta}${name}${c.reset}`);
          }
          const label = getAgentLabel(conv.agent_type);
          if (label) metaParts.push(`${c.yellow}${label}${c.reset}`);
          if (conv.project_path) metaParts.push(`${c.dim}${truncatePath(conv.project_path)}${c.reset}`);

          lines.push(`${cursor} ${isSelected ? c.bold : ""}${title}${c.reset}`);
          lines.push(`  ${metaParts.join(" | ")}`);

          const firstMessage = conv.goal || conv.preview;
          if (firstMessage) {
            const msgLine = String(firstMessage).split("\n")[0].trim();
            const maxLen = 90;
            lines.push(`  ${c.green}>${c.reset} ${msgLine.length > maxLen ? msgLine.slice(0, maxLen) + "..." : msgLine}`);
          }

          if (conv.subtitle) {
            const subtitleLines = String(conv.subtitle).split("\n").filter((l) => l.trim());
            const maxLines = 4;
            const maxLineLen = 86;
            for (let j = 0; j < Math.min(subtitleLines.length, maxLines); j++) {
              const rawLine = subtitleLines[j].trim();
              lines.push(`    ${rawLine.length > maxLineLen ? rawLine.slice(0, maxLineLen) + "..." : rawLine}`);
            }
            if (subtitleLines.length > maxLines) {
              lines.push(`    ${c.dim}... (${subtitleLines.length - maxLines} more)${c.reset}`);
            }
          }

          lines.push("");
        }

        lines.push(`${c.dim}Use arrows to pick (up/down), page (left/right), enter to open, q to quit${c.reset}`);

        return lines.join("\n");
      };

      const pickConversation = async (): Promise<{ conv: any; normalizedSource: string }> => {
        let currentOffset = offset;
        let currentPage = page!;
        let selectedIndex = 0;
        let busy = false;

        const cleanup = () => {
          try { process.stdin.setRawMode(false); } catch {}
          process.stdin.removeAllListeners("keypress");
        };

        const render = () => {
          process.stdout.write("\x1b[2J\x1b[H");
          process.stdout.write(renderResumeCards(currentPage.conversations || [], selectedIndex, currentOffset, !!currentPage.hasMore));
        };

        const setPage = async (newOffset: number) => {
          currentOffset = newOffset;
          currentPage = await fetchResumePage(currentOffset);
          selectedIndex = 0;
        };

        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);

        render();

        return await new Promise((resolve) => {
          process.stdin.on("keypress", async (_str, key) => {
            if (busy) return;
            busy = true;
            try {
              const current = currentPage.conversations || [];

              if (key?.name === "q" || key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
                cleanup();
                process.exit(0);
              }

              if (key?.name === "down") {
                if (selectedIndex < current.length - 1) {
                  selectedIndex += 1;
                } else if (currentPage.hasMore) {
                  await setPage(currentOffset + limit);
                }
                render();
                return;
              }

              if (key?.name === "up") {
                if (selectedIndex > 0) {
                  selectedIndex -= 1;
                } else if (currentOffset > 0) {
                  await setPage(Math.max(0, currentOffset - limit));
                }
                render();
                return;
              }

              if (key?.name === "right") {
                if (currentPage.hasMore) {
                  await setPage(currentOffset + limit);
                  render();
                }
                return;
              }

              if (key?.name === "left") {
                if (currentOffset > 0) {
                  await setPage(Math.max(0, currentOffset - limit));
                  render();
                }
                return;
              }

              if (key?.name === "return" || key?.name === "enter") {
                const conv = current[selectedIndex];
                if (!conv) return;
                cleanup();
                const sourceAgent = conv.agent_type || "claude_code";
                const normalizedSource = sourceAgent === "claude_code" ? "claude" : sourceAgent;
                resolve({ conv, normalizedSource });
              }
            } finally {
              busy = false;
            }
          });
        });
      };

      const picked = await pickConversation();
      const conv = picked.conv;
      const normalizedSource = picked.normalizedSource;

        const sessionId = conv.session_id;
        if (!sessionId) {
          console.error("Session ID not found");
          process.exit(1);
        }

        const targetAgent =
          options.as?.toLowerCase() ||
          await select({
            message: "Resume in:",
            choices: [
              { name: normalizedSource === "claude" ? "claude (current)" : "claude", value: "claude" },
              { name: normalizedSource === "codex" ? "codex (current)" : "codex", value: "codex" },
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
    const AUTO_TRIM_THRESHOLD_TOKENS = 120_000;
    const AUTO_TRIM_TARGET_TOKENS = 100_000;

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
    console.log(`\nTip: Set default codex args with: cast config codex_args -- "--dangerously-bypass-approvals-and-sandbox"`);
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
  let resumeId = sessionId;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionId)) {
    const newUuid = crypto.randomUUID();
    const projectSlug = (projectPath || process.cwd()).replace(/\//g, "-");
    const projectDir = path.join(os.homedir(), ".claude", "projects", projectSlug);
    const oldPath = path.join(projectDir, `${sessionId}.jsonl`);
    const newPath = path.join(projectDir, `${newUuid}.jsonl`);
    if (fs.existsSync(oldPath)) {
      const raw = fs.readFileSync(oldPath, "utf-8");
      const rewritten = raw.replace(
        new RegExp(`"sessionId"\\s*:\\s*"${sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, "g"),
        `"sessionId":"${newUuid}"`
      );
      fs.writeFileSync(newPath, rewritten);
      console.log(`Converted subagent session ${sessionId} -> ${newUuid}`);
      resumeId = newUuid;
    } else {
      console.error(`Session file not found: ${oldPath}`);
      console.error(`Non-UUID session IDs (subagent sessions) require a local JSONL file to resume.`);
      process.exit(1);
    }
  }
  const args = ["--resume", resumeId];

  if (extraArgs) {
    const parsedArgs = extraArgs.split(/\s+/).filter((a) => a.length > 0);
    args.push(...parsedArgs);
    console.log(`Using: claude ${args.join(" ")}`);
  } else if (showArgsHint) {
    console.log(`\nTip: Set default claude args with: cast config claude_args -- "--dangerously-skip-permissions"`);
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
    "  cast read jx70ntf                   # Read all messages\n" +
    "  cast read jx70ntf 12:20             # Read messages 12-20\n" +
    "  cast read jx70ntf 12:               # Read from message 12 to end\n" +
    "  cast read jx70ntf :20               # Read first 20 messages\n" +
    "  cast read jx70ntf 15                # Read single message 15\n" +
    "  cast read jx70ntf 10:15 --full      # Show full tool call/result content"
  )
  .argument("<conversation-id>", "Conversation ID (can be truncated)")
  .argument("[range]", "Message range (e.g., 12:20, 12:, :20, 15)")
  .option("-f, --full", "Show full tool call and tool result content")
  .action(async (conversationId, range, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
    "  cast private --list                  # List private conversations\n" +
    "  cast private <session-id>            # Mark as private\n" +
    "  cast private <session-id> --remove   # Make visible to team"
  )
  .argument("[session-id]", "Session ID to mark as private/public")
  .option("--list", "List all private conversations")
  .option("--remove", "Remove private flag (make visible to team)")
  .action(async (sessionId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.user_id) {
      console.error("Not authenticated. Run 'cast auth' first.");
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
          console.log("Mark conversations as private using: cast private <session-id>");
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
      console.log("Usage: cast private <session-id>");
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
  const execPath = process.execPath;
  const isBinary = !execPath.endsWith("/bun") && !execPath.endsWith("/node") && !execPath.includes("node_modules");

  if (isBinary) {
    return { executablePath: execPath, args: ["--", command] };
  } else {
    const isBundle = __filename.includes("/dist/") || __filename.includes("/build/");
    const script = isBundle
      ? path.resolve(__dirname, command === "_watchdog" ? "index.js" : "daemon.js")
      : path.resolve(__dirname, command === "_watchdog" ? "index.ts" : "daemon.ts");
    return { executablePath: execPath, args: [script, command] };
  }
}

function installWatchdogScript(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(WATCHDOG_SCRIPT_PATH, buildWatchdogShellScript(), { mode: 0o755 });
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

  // Watchdog plist (runs every 5 minutes via shell wrapper for self-healing)
  installWatchdogScript();
  const watchdogPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${WATCHDOG_SCRIPT_PATH}</string>
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
  spawnSync("launchctl", ["bootstrap", uid, watchdogPlistPath], { stdio: "ignore" });
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

      const plistNeedsRepair = (ppath: string): boolean => {
        try {
          const content = fs.readFileSync(ppath, "utf-8");
          return content.includes("<string>bun</string>") || content.includes("<string>node</string>");
        } catch { return false; }
      };
      const watchdogNeedsUpgrade = (ppath: string): boolean => {
        try {
          const content = fs.readFileSync(ppath, "utf-8");
          return !content.includes("/bin/sh");
        } catch { return false; }
      };
      const daemonBroken = daemonExists && plistNeedsRepair(plistPath);
      const watchdogBroken = watchdogExists && (plistNeedsRepair(watchdogPlistPath) || watchdogNeedsUpgrade(watchdogPlistPath));

      installWatchdogScript();

      if (daemonBroken) {
        spawnSync("launchctl", ["bootout", uid, plistPath], { stdio: "ignore" });
        fs.unlinkSync(plistPath);
      }
      if (watchdogBroken) {
        spawnSync("launchctl", ["bootout", uid, watchdogPlistPath], { stdio: "ignore" });
        fs.unlinkSync(watchdogPlistPath);
      }
      if (!daemonBroken && !watchdogBroken && daemonExists && watchdogExists) {
        return true;
      }

      if (!fs.existsSync(launchAgentsDir)) {
        fs.mkdirSync(launchAgentsDir, { recursive: true });
      }

      if (!fs.existsSync(plistPath)) {
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

      if (!fs.existsSync(watchdogPlistPath)) {
        const wdContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.codecast.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${WATCHDOG_SCRIPT_PATH}</string>
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
    console.log("To start now, run: cast start");
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
    "  cast setup             # Enable auto-start\n" +
    "  cast setup --disable   # Disable auto-start"
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
  .command("uninstall")
  .description("Completely remove cast from this machine")
  .option("--keep-config", "Keep ~/.codecast config directory")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options) => {
    if (!options.yes) {
      const rl = await import("readline");
      const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        iface.question("This will remove cast, its daemon, auto-start config, and all local data. Continue? [y/N] ", resolve);
      });
      iface.close();
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("Aborted");
        process.exit(0);
      }
    }

    const home = process.env.HOME || "";

    // 1. Stop daemon
    if (fs.existsSync(PID_FILE)) {
      console.log("Stopping daemon...");
      stopDaemon();
    }

    // 2. Remove auto-start
    switch (process.platform) {
      case "darwin": {
        const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
        const plistPath = path.join(launchAgentsDir, "sh.codecast.daemon.plist");
        const watchdogPlistPath = path.join(launchAgentsDir, "sh.codecast.watchdog.plist");
        const uid = `gui/${process.getuid!()}`;
        spawnSync("launchctl", ["bootout", uid, plistPath], { stdio: "ignore" });
        spawnSync("launchctl", ["bootout", uid, watchdogPlistPath], { stdio: "ignore" });
        if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
        if (fs.existsSync(watchdogPlistPath)) fs.unlinkSync(watchdogPlistPath);
        console.log("Removed LaunchAgents");
        break;
      }
      case "linux": {
        const servicePath = path.join(home, ".config", "systemd", "user", "codecast.service");
        if (fs.existsSync(servicePath)) {
          spawnSync("systemctl", ["--user", "disable", "--now", "codecast.service"], { stdio: "ignore" });
          fs.unlinkSync(servicePath);
          spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
          console.log("Removed systemd service");
        }
        break;
      }
      case "win32": {
        spawnSync("schtasks", ["/Delete", "/TN", "CodecastDaemon", "/F"], { stdio: "ignore" });
        console.log("Removed scheduled task");
        break;
      }
    }

    // 3. Remove hooks from ~/.claude/settings.json and hook scripts
    const claudeDir = path.join(home, ".claude");
    const settingsFile = path.join(claudeDir, "settings.json");
    const hookFiles = ["codecast-status.sh", "session-register.sh", "stable-feed.sh"];

    if (fs.existsSync(settingsFile)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
        if (settings.hooks) {
          let modified = false;
          for (const event of Object.keys(settings.hooks)) {
            const hookArray = settings.hooks[event];
            if (!Array.isArray(hookArray)) continue;
            for (const matcher of hookArray) {
              if (!Array.isArray(matcher.hooks)) continue;
              const before = matcher.hooks.length;
              matcher.hooks = matcher.hooks.filter((h: any) =>
                !h.command || !hookFiles.some(f => h.command.includes(f))
              );
              if (matcher.hooks.length !== before) modified = true;
            }
            settings.hooks[event] = hookArray.filter((m: any) =>
              !Array.isArray(m.hooks) || m.hooks.length > 0
            );
            if (settings.hooks[event].length === 0) delete settings.hooks[event];
          }
          if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
          if (modified) {
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
            console.log("Removed hooks from ~/.claude/settings.json");
          }
        }
      } catch {
        // settings.json parse error, skip
      }
    }

    const hooksDir = path.join(claudeDir, "hooks");
    for (const f of hookFiles) {
      const p = path.join(hooksDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // 4. Remove slash command
    const commandFile = path.join(claudeDir, "commands", "codecast.md");
    if (fs.existsSync(commandFile)) {
      fs.unlinkSync(commandFile);
      console.log("Removed ~/.claude/commands/codecast.md");
    }

    // 5. Remove memory/task snippets from CLAUDE.md, AGENTS.md, cursor rules
    const snippetFiles = [
      path.join(claudeDir, "CLAUDE.md"),
      path.join(home, ".codex", "AGENTS.md"),
      path.join(home, ".cursor", "rules", "codecast.mdc"),
    ];

    for (const filePath of snippetFiles) {
      if (!fs.existsSync(filePath)) continue;

      // cursor rules file is entirely ours, just delete it
      if (filePath.endsWith("codecast.mdc")) {
        fs.unlinkSync(filePath);
        console.log(`Removed ${filePath.replace(home, "~")}`);
        continue;
      }

      let content = fs.readFileSync(filePath, "utf-8");
      let changed = false;

      // Remove memory snippet
      const memStart = content.indexOf("## Memory");
      if (memStart !== -1 && (content.includes("codecast search") || content.includes("cast search"))) {
        const memEndMarker = content.indexOf(MEMORY_SNIPPET_END, memStart);
        let memEnd = memEndMarker !== -1 ? memEndMarker + MEMORY_SNIPPET_END.length : content.length;
        if (content[memEnd] === "\n") memEnd++;
        content = content.slice(0, memStart) + content.slice(memEnd);
        changed = true;
      }

      // Remove task snippet
      const taskStart = content.indexOf("## Async Tasks");
      if (taskStart !== -1 && (content.includes("codecast task") || content.includes("codecast schedule") || content.includes("cast task") || content.includes("cast schedule"))) {
        const taskEndMarker = content.indexOf(TASK_SNIPPET_END, taskStart);
        let taskEnd = taskEndMarker !== -1 ? taskEndMarker + TASK_SNIPPET_END.length : content.length;
        if (content[taskEnd] === "\n") taskEnd++;
        content = content.slice(0, taskStart) + content.slice(taskEnd);
        changed = true;
      }

      // Remove work snippet
      let workStart = content.indexOf("## Tasks & Plans");
      if (workStart === -1) workStart = content.indexOf("## Tasks, Plans & Workflows");
      if (workStart === -1) workStart = content.indexOf("## Issue Tracking with cast task");
      if (workStart === -1) workStart = content.indexOf("## Issue Tracking with codecast task");
      if (workStart !== -1 && content.includes(WORK_SNIPPET_END)) {
        const workEndMarker = content.indexOf(WORK_SNIPPET_END, workStart);
        let workEnd = workEndMarker !== -1 ? workEndMarker + WORK_SNIPPET_END.length : content.length;
        if (content[workEnd] === "\n") workEnd++;
        content = content.slice(0, workStart) + content.slice(workEnd);
        changed = true;
      }

      // Remove plan snippet
      const planStart = content.indexOf("## Plans");
      if (planStart !== -1 && content.includes(PLAN_SNIPPET_END)) {
        const planEndMarker = content.indexOf(PLAN_SNIPPET_END, planStart);
        let planEnd = planEndMarker !== -1 ? planEndMarker + PLAN_SNIPPET_END.length : content.length;
        if (content[planEnd] === "\n") planEnd++;
        content = content.slice(0, planStart) + content.slice(planEnd);
        changed = true;
      }

      // Remove workflow snippet
      const wfStart = content.indexOf("## Workflows");
      if (wfStart !== -1 && content.includes(WORKFLOW_SNIPPET_END)) {
        const wfEndMarker = content.indexOf(WORKFLOW_SNIPPET_END, wfStart);
        let wfEnd = wfEndMarker !== -1 ? wfEndMarker + WORKFLOW_SNIPPET_END.length : content.length;
        if (content[wfEnd] === "\n") wfEnd++;
        content = content.slice(0, wfStart) + content.slice(wfEnd);
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(filePath, content.trimEnd() + "\n");
        console.log(`Removed codecast snippets from ${filePath.replace(home, "~")}`);
      }
    }

    // 6. Remove config directory
    if (!options.keepConfig) {
      if (fs.existsSync(CONFIG_DIR)) {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
        console.log(`Removed ${CONFIG_DIR}`);
      }
    } else {
      console.log(`Kept ${CONFIG_DIR}`);
    }

    // 7. Remove binary and cast symlink
    const binaryPath = path.join(home, ".local", "bin", "codecast");
    if (fs.existsSync(binaryPath)) {
      fs.unlinkSync(binaryPath);
      console.log(`Removed ${binaryPath}`);
    }
    const castPath = path.join(home, ".local", "bin", "cast");
    try {
      const target = fs.readlinkSync(castPath);
      if (target === binaryPath || target.endsWith("/codecast")) {
        fs.unlinkSync(castPath);
        console.log(`Removed ${castPath}`);
      }
    } catch {}

    console.log("\nCodecast has been uninstalled.");
  });

program
  .command("links")
  .description(
    "Get dashboard and share URLs for the current session\n\n" +
    "Examples:\n" +
    "  cast links              # Get links for current project\n" +
    "  cast links --json       # Output as JSON\n" +
    "  cast links -s abc123    # Specific session ID"
  )
  .option("--json", "Output as JSON")
  .option("-s, --session <id>", "Specific session ID (default: most recent)")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
              const isCodecastCommand = (line.includes("codecast links") || line.includes("cast links") || line.includes("index.ts links")) && line.includes("Bash");
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
    "  cast diff <session-id>     # show changes from session\n" +
    "  cast diff --today          # aggregate today's sessions\n" +
    "  cast diff --week           # this week's changes\n" +
    "  cast diff --full           # include full file diffs\n" +
    "  cast diff --patch          # show only the patch (no stats)"
  )
  .argument("[session-id]", "Session ID to analyze")
  .option("--today", "Aggregate changes from today's sessions")
  .option("--week", "Aggregate changes from this week's sessions")
  .option("--full", "Include full file content diffs")
  .option("--patch", "Show only the unified diff patch")
  .action(async (sessionId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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

      const needFullContent = options.full || options.patch;
      for (const conv of feedResult.conversations) {
        const result = await fetchAllMessages(siteUrl, config.auth_token, conv.id, 200, needFullContent);
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
        mode: options.patch ? "patch" : options.full ? "full" : "summary",
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
          console.error("Usage: cast diff <session-id>");
          process.exit(1);
        }
      }

      const needFullContent = options.full || options.patch;
      const result = await fetchAllMessages(siteUrl, config.auth_token, sessionId, 500, needFullContent);
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
        mode: options.patch ? "patch" : options.full ? "full" : "summary",
      }));
    }
  });

program
  .command("handoff")
  .description(
    "Generate a context transfer document for the next session/agent\n\n" +
    "Examples:\n" +
    "  cast handoff                        # from current/recent session\n" +
    "  cast handoff --session abc123       # from specific session\n" +
    "  cast handoff --to-file /tmp/h.md    # save to file"
  )
  .option("-s, --session <id>", "Specific session ID (default: most recent)")
  .option("-o, --to-file <path>", "Save output to file instead of stdout")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
    "  cast summary <session-id>    # Summarize specific session\n" +
    "  cast summary --today         # Summarize today's work"
  )
  .argument("[session-id]", "Session ID to summarize")
  .option("--today", "Summarize today's most recent session")
  .action(async (sessionId, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
      console.log("Run 'cast memory' to re-enable.");
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
    "  cast bookmark abc123 42                     # bookmark message 42\n" +
    "  cast bookmark abc123 42 --name auth-fix    # with a name\n" +
    "  cast bookmark abc123 42 --note \"key insight\"  # with a note\n" +
    "  cast bookmark --list                        # list all bookmarks\n" +
    "  cast bookmark --delete auth-fix             # delete by name"
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
      console.error("Not authenticated. Run: cast auth");
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
          console.log("Create one with: cast bookmark <session-id> <message-index>");
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
      console.error("Usage: cast bookmark <session-id> <message-index>");
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
    "  cast decisions                            # list recent decisions\n" +
    "  cast decisions --project .                # current project only\n" +
    "  cast decisions --search \"database\"        # search decisions\n" +
    "  cast decisions --tags db,arch             # filter by tags\n" +
    "  cast decisions add \"Use Convex\" --reason \"Better TypeScript\"  # add decision\n" +
    "  cast decisions add \"Cursor pagination\" --reason \"Better for realtime\" --tags api,perf\n" +
    "  cast decisions delete <id>                # delete a decision"
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
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (action === "add") {
      if (!titleOrId) {
        console.error("Usage: cast decisions add \"Title\" --reason \"Why\"");
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
        console.error("Usage: cast decisions delete <decision-id>");
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
    "  cast learn                              # list saved patterns\n" +
    "  cast learn add \"convex-http\" --description \"HTTP action pattern\" --content \"...\"\n" +
    "  cast learn show \"convex-http\"           # show pattern content\n" +
    "  cast learn search \"webhook\"             # search patterns\n" +
    "  cast learn delete \"convex-http\"         # delete pattern"
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
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }

    const siteUrl = config.convex_url.replace(".cloud", ".site");

    if (action === "add") {
      if (!nameOrQuery) {
        console.error("Usage: cast learn add \"name\" --description \"...\" --content \"...\"");
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
        console.error("Usage: cast learn show \"pattern-name\"");
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
        console.error("Usage: cast learn delete \"pattern-name\"");
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
    "  cast similar --file src/auth.ts     # sessions that touched this file\n" +
    "  cast similar --session abc123       # sessions similar to this one\n\n" +
    "Note: File touch data may be sparse for older sessions."
  )
  .option("-f, --file <path>", "Find sessions that touched this file")
  .option("-s, --session <id>", "Find sessions similar to this one")
  .option("-n, --limit <n>", "Number of results", "10")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }

    if (!options.file && !options.session) {
      console.error("Must specify --file or --session");
      console.error("Usage: cast similar --file <path>");
      console.error("       cast similar --session <id>");
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
    "  cast blame src/auth.ts             # sessions that touched this file\n" +
    "  cast blame src/auth.ts:42          # sessions that touched line 42"
  )
  .argument("<file>", "File path, optionally with line number (e.g., src/auth.ts:42)")
  .option("-n, --limit <n>", "Number of results", "20")
  .action(async (file, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
    "  cast fork                            # fork current session\n" +
    "  cast fork --from 15                  # fork current session from message 15\n" +
    "  cast fork --from 15 --resume         # fork and open in Claude\n" +
    "  cast fork abc1234                    # fork specific conversation\n" +
    "  cast fork abc1234 --from 15          # fork specific conversation from message 15"
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
      console.error("Not authenticated. Run: cast auth");
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
        console.error("Could not detect current session. Pass a conversation ID: cast fork <id>");
        process.exit(1);
      }

      const linksResp = await fetch(`${siteUrl}/cli/session-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, api_token: config.auth_token }),
      });
      const linksResult = await linksResp.json() as any;
      if (!linksResult.conversation_id) {
        console.error("Could not resolve session to conversation. Try: cast fork <id>");
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
          const AUTO_TRIM_THRESHOLD_TOKENS = 120_000;
          const AUTO_TRIM_TARGET_TOKENS = 100_000;

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
      console.error("Not authenticated. Run: cast auth");
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
  .description("Update cast to the latest version")
  .option("--no-auto", "Disable auto-updates")
  .option("--auto", "Enable auto-updates (default)")
  .action(async (options) => {
    const config = readConfig() || {};

    if (options.auto === false) {
      config.auto_update = false;
      writeConfig(config);
      console.log("Auto-updates disabled. Run 'cast update' manually to update.");
      return;
    }

    if (options.auto === true) {
      config.auto_update = true;
      writeConfig(config);
      console.log("Auto-updates enabled.");
    }

    const available = await checkForUpdates(true);
    if (!available) {
      // Even if version matches, force reinstall to fix corrupted binaries
      console.log(`cast v${getVersion()} matches latest. Reinstalling to ensure integrity...`);
    } else {
      console.log(`Updating from v${getVersion()} to v${available}...`);
    }

    // Check if daemon is running before update
    const daemonWasRunning = getDaemonPid() !== null;
    if (daemonWasRunning) {
      console.log("Stopping daemon...");
      stopDaemon();
    }

    const success = await performUpdate();
    if (success) {
      if (config.memory_enabled) installMemorySnippet(true);
      if (config.task_enabled) installTaskSnippet(true);
      if (config.work_enabled) installWorkSnippet(true);
      if (config.workflow_enabled) installWorkflowSnippet(true);
      installSessionRegisterHook();
      installStatusHook();

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
      console.error("Not authenticated. Run: cast auth");
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
      process.exit(0);
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
    "  cast ask \"when did we last refactor the feed?\"\n" +
    "  cast ask \"what's the pattern for adding CLI commands?\"\n" +
    "  cast ask \"why did we switch to Convex?\"\n" +
    "  cast ask \"auth bug\" -g         # search globally\n" +
    "  cast ask \"auth\" -s 7d          # search last 7 days"
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
      console.error("Not authenticated. Run: cast auth");
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
        model: "claude-haiku-4-5-20251001",
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
          console.log("\nTry: cast ask \"" + query + "\" -g   # search globally");
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
        model: "claude-haiku-4-5-20251001",
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
    "  cast context \"add stripe integration\"   # search by description\n" +
    "  cast context --file src/auth.ts         # sessions that touched file\n" +
    "  cast context --auto                     # infer from git diff/status"
  )
  .argument("[query]", "Search query describing the work")
  .option("-f, --file <path>", "Find sessions that touched this file")
  .option("-a, --auto", "Infer context from git diff and status")
  .option("-g, --global", "Search all sessions (not just current project)")
  .option("-n, --limit <n>", "Maximum results", "10")
  .action(async (query, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
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
      console.error("  cast context \"add stripe integration\"");
      console.error("  cast context --file src/auth.ts");
      console.error("  cast context --auto");
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

// --- Agent Tasks ---

function parseDuration(input: string): number | undefined {
  const match = input.toLowerCase().trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/);
  if (!match) return undefined;
  const num = parseInt(match[1]);
  const unit = match[2][0];
  if (unit === "s") return num * 1000;
  if (unit === "m") return num * 60 * 1000;
  if (unit === "h") return num * 60 * 60 * 1000;
  if (unit === "d") return num * 24 * 60 * 60 * 1000;
  return undefined;
}

const EVENT_SHORTHANDS: Record<string, { event_type: string; action?: string }> = {
  pr_comment: { event_type: "pull_request_review_comment", action: "created" },
  pr_opened: { event_type: "pull_request", action: "opened" },
  pr_merged: { event_type: "pull_request", action: "closed" },
  push: { event_type: "push" },
};

const schedule = program
  .command("schedule")
  .alias("sched")
  .description("Manage scheduled agent tasks");

schedule
  .command("add")
  .description("Schedule a new agent task")
  .argument("<prompt>", "Task instruction for the agent")
  .option("--in <duration>", "Run after delay (e.g., 30m, 2h, 1d)")
  .option("--every <duration>", "Run on interval (e.g., 4h, 1d)")
  .option("--on <event>", "Run on event (pr_comment, pr_opened, pr_merged, push)")
  .option("--title <title>", "Short title (defaults to first 60 chars of prompt)")
  .option("--context <mode>", "Context capture: 'current' to grab running session")
  .option("--mode <mode>", "Agent mode: propose (default) or apply", "propose")
  .option("--project <path>", "Project path for agent cwd")
  .option("--agent <type>", "Agent type: claude (default) or codex", "claude")
  .option("--max-runtime <duration>", "Max runtime (default: 10m)")
  .action(async (prompt, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");

    let schedule_type: "once" | "recurring" | "event" = "once";
    let run_at: number | undefined;
    let interval_ms: number | undefined;
    let event_filter: { event_type: string; action?: string; repository?: string } | undefined;

    if (options.every) {
      schedule_type = "recurring";
      interval_ms = parseDuration(options.every);
      if (!interval_ms) {
        console.error(`Invalid duration: ${options.every}`);
        process.exit(1);
      }
      run_at = Date.now() + interval_ms;
    } else if (options.on) {
      schedule_type = "event";
      const shorthand = EVENT_SHORTHANDS[options.on];
      if (!shorthand) {
        console.error(`Unknown event: ${options.on}. Valid: ${Object.keys(EVENT_SHORTHANDS).join(", ")}`);
        process.exit(1);
      }
      event_filter = shorthand;
    } else if (options.in) {
      const delay = parseDuration(options.in);
      if (!delay) {
        console.error(`Invalid duration: ${options.in}`);
        process.exit(1);
      }
      run_at = Date.now() + delay;
    } else {
      run_at = Date.now();
    }

    const title = options.title || prompt.slice(0, 60);
    const maxRuntimeMs = options.maxRuntime ? parseDuration(options.maxRuntime) : undefined;

    let context_summary: string | undefined;
    let originating_conversation_id: string | undefined;
    if (options.context === "current") {
      const sessionId = findCurrentSessionFromProcess(getRealCwd());
      if (sessionId) {
        console.log(fmt.muted(`Capturing context from session ${sessionId.slice(0, 8)}...`));
        // Look up conversation ID from session
        try {
          const resp = await fetch(`${siteUrl}/cli/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_token: config.auth_token, session_id: sessionId }),
          });
          const data = await resp.json();
          if (data?.conversation_id) {
            originating_conversation_id = data.conversation_id;
          }
        } catch {}
      }
    }

    try {
      const response = await fetch(`${siteUrl}/cli/tasks/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          title,
          prompt,
          context_summary,
          originating_conversation_id,
          project_path: options.project || getRealCwd(),
          agent_type: options.agent,
          schedule_type,
          run_at,
          interval_ms,
          event_filter,
          mode: options.mode,
          max_runtime_ms: maxRuntimeMs,
        }),
      });

      const result = await response.json();
      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const taskId = result.task_id;
      const shortId = taskId.slice(-8);

      if (schedule_type === "recurring") {
        console.log(`${c.green}+${c.reset} Task ${c.cyan}${shortId}${c.reset} scheduled every ${options.every}: ${c.bold}${title}${c.reset}`);
      } else if (schedule_type === "event") {
        console.log(`${c.green}+${c.reset} Task ${c.cyan}${shortId}${c.reset} on ${c.yellow}${options.on}${c.reset}: ${c.bold}${title}${c.reset}`);
      } else if (options.in) {
        console.log(`${c.green}+${c.reset} Task ${c.cyan}${shortId}${c.reset} in ${options.in}: ${c.bold}${title}${c.reset}`);
      } else {
        console.log(`${c.green}+${c.reset} Task ${c.cyan}${shortId}${c.reset} queued now: ${c.bold}${title}${c.reset}`);
      }
    } catch (error) {
      console.error("Failed to create task:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

schedule
  .command("ls")
  .description("List agent tasks")
  .option("-s, --status <status>", "Filter by status (scheduled, running, completed, failed, paused)")
  .option("-a, --all", "Show all statuses including completed")
  .action(async (options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");

    try {
      const body: any = { api_token: config.auth_token };
      if (options.status) body.status = options.status;

      const response = await fetch(`${siteUrl}/cli/tasks/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const tasks = await response.json();
      if (tasks.error) {
        console.error(`Error: ${tasks.error}`);
        process.exit(1);
      }

      if (!Array.isArray(tasks) || tasks.length === 0) {
        console.log(fmt.muted("No tasks found."));
        return;
      }

      // Filter out completed/failed by default unless --all
      const filtered = options.all || options.status
        ? tasks
        : tasks.filter((t: any) => !["completed", "failed"].includes(t.status));

      if (filtered.length === 0) {
        console.log(fmt.muted("No active tasks. Use --all to see completed tasks."));
        return;
      }

      const statusColorMap: Record<string, string> = {
        scheduled: c.yellow,
        running: c.green,
        paused: c.dim,
        completed: c.cyan,
        failed: c.red,
      };

      for (const t of filtered) {
        const shortId = t._id.slice(-8);
        const color = statusColorMap[t.status] || "";
        const statusStr = `${color}${t.status.padEnd(10)}${c.reset}`;
        const scheduleInfo = t.schedule_type === "recurring"
          ? fmt.muted(`every ${formatMs(t.interval_ms)}`)
          : t.schedule_type === "event"
            ? fmt.muted(`on ${t.event_filter?.event_type || "event"}`)
            : t.run_at
              ? fmt.muted(formatRunAt(t.run_at))
              : "";

        console.log(`  ${c.cyan}${shortId}${c.reset}  ${statusStr}  ${t.title}  ${scheduleInfo}`);
        if (t.last_run_summary) {
          console.log(`           ${fmt.muted(t.last_run_summary.slice(0, 80))}`);
        }
      }

      console.log(fmt.muted(`\n${filtered.length} task(s)`));
    } catch (error) {
      console.error("Failed to list tasks:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

schedule
  .command("complete")
  .description("Mark a running task as completed (called by the agent)")
  .argument("<id>", "Task ID (full or last 8 chars)")
  .option("--summary <text>", "Summary of what was done")
  .action(async (id, options) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const taskId = await resolveTaskId(config, siteUrl, id);
    if (!taskId) return;

    try {
      const response = await fetch(`${siteUrl}/cli/tasks/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          task_id: taskId,
          summary: options.summary,
        }),
      });
      const result = await response.json();
      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      if (result.success) {
        console.log(`${c.green}ok${c.reset} Task completed: ${c.cyan}${id}${c.reset}`);
      } else {
        console.error("Failed to complete task (may not be in running state)");
        process.exit(1);
      }
    } catch (error) {
      console.error(`Failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

schedule
  .command("cancel")
  .description("Cancel a task")
  .argument("<id>", "Task ID (full or last 8 chars)")
  .action(async (id) => {
    await taskAction("cancel", id, "Cancelled");
  });

schedule
  .command("pause")
  .description("Pause a scheduled task")
  .argument("<id>", "Task ID (full or last 8 chars)")
  .action(async (id) => {
    await taskAction("pause", id, "Paused");
  });

schedule
  .command("run")
  .description("Run a task immediately")
  .argument("<id>", "Task ID (full or last 8 chars)")
  .action(async (id) => {
    await taskAction("run", id, "Queued for immediate run");
  });

schedule
  .command("log")
  .description("Show last run conversation for a task")
  .argument("<id>", "Task ID (full or last 8 chars)")
  .action(async (id) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast auth");
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");

    const taskId = await resolveTaskId(config, siteUrl, id);
    if (!taskId) return;

    // Get task details to find last_run_conversation_id
    const response = await fetch(`${siteUrl}/cli/tasks/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token }),
    });
    const tasks = await response.json();
    const t = Array.isArray(tasks) ? tasks.find((x: any) => x._id === taskId) : null;

    if (!t) {
      console.error("Task not found");
      process.exit(1);
    }

    if (!t.last_run_conversation_id) {
      console.log(fmt.muted("No run history yet."));
      return;
    }

    console.log(`Last run conversation: ${c.cyan}${t.last_run_conversation_id}${c.reset}`);
    console.log(fmt.muted(`Use: cast read ${t.last_run_conversation_id}`));
  });

schedule
  .command("install")
  .description("Install task snippet into agent config (CLAUDE.md, AGENTS.md)")
  .option("--disable", "Remove task snippet and disable")
  .action(async (options) => {
    const config = readConfig() || {};

    if (options.disable) {
      config.task_enabled = false;
      writeConfig(config);
      console.log("Schedule snippet disabled. Run 'cast schedule install' to re-enable.");
      return;
    }

    const result = installTaskSnippet(true);
    config.task_enabled = true;
    config.task_version = getTaskVersion();
    writeConfig(config);

    const targets = getSnippetTargets();
    const targetList = targets.map(t => t.label).join(", ");
    if (result.updated) {
      console.log(`Schedule snippet updated in ${targetList}`);
    } else if (result.installed) {
      console.log(`Schedule snippet installed in ${targetList}`);
      console.log("Your agents can now schedule follow-up work autonomously.");
    } else {
      console.log("Schedule snippet is up to date.");
    }
  });

async function taskAction(action: string, id: string, successMsg: string): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    console.error("Not authenticated. Run: cast auth");
    process.exit(1);
  }
  const siteUrl = config.convex_url.replace(".cloud", ".site");

  const taskId = await resolveTaskId(config, siteUrl, id);
  if (!taskId) return;

  try {
    const response = await fetch(`${siteUrl}/cli/tasks/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token, task_id: taskId }),
    });
    const result = await response.json();
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.success) {
      console.log(`${c.green}ok${c.reset} ${successMsg}: ${c.cyan}${id}${c.reset}`);
    } else {
      console.error("Action failed (task may not be in the right state)");
      process.exit(1);
    }
  } catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

async function resolveTaskId(config: any, siteUrl: string, idInput: string): Promise<string | null> {
  // If it looks like a full Convex ID, use as-is
  if (idInput.length > 16) return idInput;

  // Otherwise, search by suffix
  try {
    const response = await fetch(`${siteUrl}/cli/tasks/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token }),
    });
    const tasks = await response.json();
    if (!Array.isArray(tasks)) {
      console.error("Failed to fetch tasks");
      return null;
    }
    const matches = tasks.filter((t: any) => t._id.endsWith(idInput));
    if (matches.length === 0) {
      console.error(`No task found matching: ${idInput}`);
      return null;
    }
    if (matches.length > 1) {
      console.error(`Ambiguous ID, ${matches.length} matches. Use a longer suffix.`);
      return null;
    }
    return matches[0]._id;
  } catch {
    console.error("Failed to resolve task ID");
    return null;
  }
}

function formatMs(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

function formatRunAt(timestamp: number): string {
  const diff = timestamp - Date.now();
  if (diff < 0) return "overdue";
  return `in ${formatMs(diff)}`;
}

// --- Work Items (codecast task) ---

function getCliEndpoint(): { siteUrl: string; apiToken: string } {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    console.error("Not authenticated. Run: cast auth");
    process.exit(1);
  }
  return {
    siteUrl: config.convex_url.replace(".cloud", ".site"),
    apiToken: config.auth_token,
  };
}

async function cliPost(urlPath: string, body: Record<string, any>): Promise<any> {
  const { siteUrl, apiToken } = getCliEndpoint();
  const response = await fetch(`${siteUrl}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    console.error(`API error (${response.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }
  if (result.error) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  return result;
}

async function emitOrchEvent(planShortId: string, eventType: string, taskShortId?: string, detail?: string, metadata?: any) {
  try {
    await cliPost("/cli/orchestration/emit", {
      plan_short_id: planShortId,
      task_short_id: taskShortId,
      event_type: eventType,
      detail,
      metadata,
    });
  } catch {}
  try {
    await cliPost("/cli/progress/append", {
      plan_short_id: planShortId,
      task_short_id: taskShortId,
      event_type: eventType,
      detail,
      metadata,
    });
  } catch {}
  appendLocalProgress(planShortId, { event_type: eventType, task_short_id: taskShortId, detail, metadata });
}

function eventTypeColor(eventType: string): string {
  if (eventType.includes("completed") || eventType.includes("succeeded") || eventType.includes("done")) return c.green;
  if (eventType.includes("failed") || eventType.includes("blocked") || eventType.includes("timeout")) return c.red;
  if (eventType.includes("spawned") || eventType.includes("started")) return c.blue;
  if (eventType.includes("needs") || eventType.includes("retry") || eventType.includes("concern")) return c.yellow;
  return c.dim;
}

function evaluateCondition(task: any, outcomes: Map<string, string>): boolean {
  if (!task.condition) return true;
  const cond = task.condition.trim();
  const outcomeMatch = cond.match(/^outcome\s*=\s*(\w+)$/);
  if (outcomeMatch) {
    const expected = outcomeMatch[1];
    if (!task.blocked_by?.length) return true;
    return task.blocked_by.some((dep: string) => outcomes.get(dep) === expected);
  }
  const statusMatch = cond.match(/^status\s*=\s*(\w+)$/);
  if (statusMatch) {
    const expected = statusMatch[1];
    if (!task.blocked_by?.length) return true;
    return task.blocked_by.some((dep: string) => {
      const outcome = outcomes.get(dep);
      return outcome === expected || (expected === "success" && outcome === "done");
    });
  }
  const allMatch = cond.match(/^all\s*=\s*(\w+)$/);
  if (allMatch) {
    const expected = allMatch[1];
    if (!task.blocked_by?.length) return true;
    return task.blocked_by.every((dep: string) => {
      const outcome = outcomes.get(dep);
      return outcome === expected || (expected === "success" && outcome === "done");
    });
  }
  return true;
}

function appendLocalProgress(planShortId: string, event: Record<string, any>) {
  try {
    const dir = path.join(getRealCwd(), ".codecast");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const progressFile = path.join(dir, `progress-${planShortId}.jsonl`);
    const liveFile = path.join(dir, `live-${planShortId}.json`);
    const entry = { ...event, timestamp: Date.now() };
    fs.appendFileSync(progressFile, JSON.stringify(entry) + "\n");
    fs.writeFileSync(liveFile, JSON.stringify(entry, null, 2));
  } catch {}
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: c.red,
  high: c.yellow,
  medium: "",
  low: c.dim,
  none: c.dim,
};

const STATUS_ICONS: Record<string, string> = {
  backlog: "○",
  open: "◎",
  in_progress: "◉",
  in_review: "◈",
  done: "●",
  dropped: "✕",
};

function formatWorkItem(t: any, verbose = false): string {
  const icon = STATUS_ICONS[t.status] || "?";
  const pcolor = PRIORITY_COLORS[t.priority] || "";
  const pri = t.priority !== "medium" ? ` ${pcolor}${t.priority}${c.reset}` : "";
  const labels = t.labels?.length ? ` ${c.dim}[${t.labels.join(", ")}]${c.reset}` : "";
  const blocked = t.blocked_by?.length ? ` ${c.red}blocked${c.reset}` : "";
  let line = `  ${icon} ${c.cyan}${t.short_id}${c.reset} ${t.title}${pri}${labels}${blocked}`;
  if (verbose && t.description) {
    line += `\n    ${c.dim}${t.description.slice(0, 120)}${c.reset}`;
  }
  return line;
}

program
  .command("overview")
  .alias("ov")
  .description("Top-down view of all plans and tasks")
  .option("--plain", "Plain text output (no colors, for injection into agent context)")
  .option("--all", "Include completed plans/tasks (last 14d)")
  .action(async (options: any) => {
    const o = options.plain ? { bold: "", reset: "", dim: "", cyan: "", green: "", yellow: "", red: "", blue: "", magenta: "" } : c;

    const projectPath = getRealCwd();
    const [plans, tasks] = await Promise.all([
      cliPost("/cli/plans/list", { include_all: true, project_path: projectPath }),
      cliPost("/cli/work/list", { limit: 200, project_path: projectPath }),
    ]);

    const allTasks: any[] = Array.isArray(tasks) ? tasks : [];
    const allPlans: any[] = Array.isArray(plans) ? plans : [];

    let doneTasks: any[] = [];
    if (options.all) {
      doneTasks = (await cliPost("/cli/work/list", { limit: 50, project_path: projectPath, status: "done" })) || [];
    }

    const now = Date.now();
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

    // Read agent-status files for live session state
    const agentStatusDir = path.join(os.homedir(), ".codecast", "agent-status");
    const sessionStates = new Map<string, { status: string; ts: number }>();
    try {
      if (fs.existsSync(agentStatusDir)) {
        for (const f of fs.readdirSync(agentStatusDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(agentStatusDir, f), "utf-8"));
            const sessionId = f.replace(".json", "");
            if (data.status && data.ts && (now / 1000 - data.ts) < 3600) {
              sessionStates.set(sessionId, { status: data.status, ts: data.ts });
            }
          } catch {}
        }
      }
    } catch {}

    // Index tasks by plan_id
    const tasksByPlanId = new Map<string, any[]>();
    const unplannedTasks: any[] = [];
    for (const t of allTasks) {
      if (t.plan_id) {
        const list = tasksByPlanId.get(t.plan_id) || [];
        list.push(t);
        tasksByPlanId.set(t.plan_id, list);
      } else {
        unplannedTasks.push(t);
      }
    }

    // Partition plans — suppress stale active plans (no tasks, no recent activity)
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const isLively = (p: any): boolean => {
      const hasTasks = tasksByPlanId.has(p._id) && (tasksByPlanId.get(p._id)?.length || 0) > 0;
      if (hasTasks) return true;
      // Empty plans only show if very recently touched (likely being set up)
      return p.updated_at && (now - p.updated_at) < ONE_DAY;
    };
    const activePlans = allPlans
      .filter((p: any) => p.status === "active" || p.status === "paused")
      .filter((p: any) => options.all || isLively(p));
    const stalePlanCount = allPlans
      .filter((p: any) => (p.status === "active" || p.status === "paused") && !isLively(p)).length;
    const draftPlans = allPlans.filter((p: any) => p.status === "draft")
      .filter((p: any) => options.all || isLively(p));
    const recentDonePlans = allPlans.filter((p: any) =>
      (p.status === "done" || p.status === "abandoned") && p.updated_at && (now - p.updated_at) < FOURTEEN_DAYS
    );

    // Sort helpers
    const statusOrder: Record<string, number> = { in_progress: 0, in_review: 1, open: 2, backlog: 3, done: 4, dropped: 5 };
    const sortTasks = (arr: any[]) => arr.sort((a: any, b: any) => {
      const aBlocked = a.blocked_by?.length > 0;
      const bBlocked = b.blocked_by?.length > 0;
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
      return (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    });

    const taskIcon = (t: any): string => {
      if (t.status === "done") return `${o.green}✓${o.reset}`;
      if (t.status === "dropped") return `${o.dim}✕${o.reset}`;
      if (t.blocked_by?.length > 0) return `${o.dim}◌${o.reset}`;
      if (t.status === "in_progress") return `${o.yellow}●${o.reset}`;
      if (t.status === "in_review") return `${o.magenta}◈${o.reset}`;
      return `○`;
    };

    // Session annotation for a task
    const sessionTag = (t: any): string => {
      const sid = t.agent_session_id;
      if (!sid) return "";
      const state = sessionStates.get(sid);
      const liveTag = state ? ` [${state.status}]` : "";
      const summary = t.last_session_summary ? `: ${t.last_session_summary.slice(0, 60)}` : "";
      if (options.plain) return `  <- session ${sid.slice(0, 8)}${liveTag}${summary}`;
      return `  ${o.dim}<- ${sid.slice(0, 8)}${liveTag}${summary}${o.reset}`;
    };

    const lines: string[] = [];

    if (activePlans.length === 0 && draftPlans.length === 0 && unplannedTasks.length === 0 && recentDonePlans.length === 0) {
      lines.push(options.plain ? "No active plans or tasks." : `${o.dim}No active plans or tasks.${o.reset}`);
      console.log(lines.join("\n"));
      return;
    }

    // Active plans
    if (activePlans.length > 0) {
      lines.push(`${o.bold}ACTIVE PLANS${o.reset}`);
      for (const p of activePlans) {
        const planTasks = sortTasks(tasksByPlanId.get(p._id) || []);
        const total = p.task_total || planTasks.length;
        const done = p.task_done || planTasks.filter((t: any) => t.status === "done").length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const statusTag = p.status === "paused" ? ` ${o.yellow}paused${o.reset}` : "";
        const age = p.updated_at ? formatAge(now - p.updated_at) : "";

        if (options.plain) {
          lines.push(`  ${PLAN_STATUS_ICONS[p.status] || "?"} ${p.short_id}  ${p.title}  ${done}/${total} tasks  ${pct}%${p.status === "paused" ? " (paused)" : ""}  updated ${age}`);
        } else {
          const barWidth = 20;
          const filled = Math.round(barWidth * pct / 100);
          const bar = `${o.green}${"█".repeat(filled)}${o.dim}${"░".repeat(barWidth - filled)}${o.reset}`;
          lines.push(`  ${PLAN_STATUS_ICONS[p.status] || "?"} ${o.cyan}${p.short_id}${o.reset}  ${o.bold}${p.title}${o.reset}  ${done}/${total} tasks  ${bar} ${pct}%${statusTag}  ${o.dim}${age}${o.reset}`);
        }

        for (const t of planTasks) {
          const icon = taskIcon(t);
          const blocked = t.blocked_by?.length > 0 ? (options.plain ? ` (blocked by ${t.blocked_by.join(", ")})` : ` ${o.dim}blocked by ${t.blocked_by.join(", ")}${o.reset}`) : "";
          const concern = t.execution_status === "done_with_concerns" ? (options.plain ? " [concerns]" : ` ${o.yellow}!${o.reset}`) : "";
          const session = sessionTag(t);
          if (options.plain) {
            lines.push(`    ${icon} ${t.short_id}  ${t.title}  ${t.status}${blocked}${concern}${session}`);
          } else {
            lines.push(`    ${icon} ${o.cyan}${t.short_id}${o.reset}  ${t.title}  ${o.dim}${t.status}${o.reset}${blocked}${concern}${session}`);
          }
        }
        lines.push("");
      }
    }

    // Draft plans (compact)
    if (draftPlans.length > 0) {
      lines.push(`${o.bold}DRAFTS${o.reset}`);
      for (const p of draftPlans) {
        if (options.plain) {
          lines.push(`  ○ ${p.short_id}  ${p.title}`);
        } else {
          lines.push(`  ○ ${o.cyan}${p.short_id}${o.reset}  ${o.dim}${p.title}${o.reset}`);
        }
      }
      lines.push("");
    }

    // Unplanned tasks
    if (unplannedTasks.length > 0) {
      const sorted = sortTasks(unplannedTasks);
      lines.push(`${o.bold}UNPLANNED TASKS${o.reset}`);
      for (const t of sorted) {
        const icon = taskIcon(t);
        const pri = t.priority && t.priority !== "none" && t.priority !== "medium" ? `  ${t.priority}` : "";
        const session = sessionTag(t);
        if (options.plain) {
          lines.push(`  ${icon} ${t.short_id}  ${t.title}${pri}  ${t.status}${session}`);
        } else {
          const priColor = PRIORITY_COLORS[t.priority] || "";
          lines.push(`  ${icon} ${o.cyan}${t.short_id}${o.reset}  ${t.title}${pri ? `  ${priColor}${t.priority}${o.reset}` : ""}  ${o.dim}${t.status}${o.reset}${session}`);
        }
      }
      lines.push("");
    }

    // Recently completed
    if (recentDonePlans.length > 0 || (options.all && doneTasks.length > 0)) {
      const recentDoneTasksFiltered = doneTasks.filter((t: any) => !t.plan_id && t.updated_at && (now - t.updated_at) < FOURTEEN_DAYS);
      if (recentDonePlans.length > 0 || recentDoneTasksFiltered.length > 0) {
        lines.push(`${o.dim}RECENTLY COMPLETED${o.reset}`);
        for (const p of recentDonePlans.slice(0, 5)) {
          const age = formatAge(now - p.updated_at);
          if (options.plain) {
            lines.push(`  ✓ ${p.short_id}  ${p.title}  ${p.task_done || "?"}/${p.task_total || "?"} tasks  done ${age}`);
          } else {
            lines.push(`  ${o.green}✓${o.reset} ${o.cyan}${p.short_id}${o.reset}  ${o.dim}${p.title}  ${p.task_done || "?"}/${p.task_total || "?"} tasks  done ${age}${o.reset}`);
          }
        }
        for (const t of recentDoneTasksFiltered.slice(0, 5)) {
          const age = formatAge(now - t.updated_at);
          if (options.plain) {
            lines.push(`  ✓ ${t.short_id}  ${t.title}  done ${age}`);
          } else {
            lines.push(`  ${o.green}✓${o.reset} ${o.cyan}${t.short_id}${o.reset}  ${o.dim}${t.title}  done ${age}${o.reset}`);
          }
        }
        lines.push("");
      }
    }

    // Summary line
    const totalPlans = activePlans.length + draftPlans.length;
    const inProgress = allTasks.filter((t: any) => t.status === "in_progress").length;
    const ready = allTasks.filter((t: any) => (t.status === "open" || t.status === "backlog") && (!t.blocked_by || t.blocked_by.length === 0)).length;
    const blocked = allTasks.filter((t: any) => t.blocked_by?.length > 0 && t.status !== "done" && t.status !== "dropped").length;
    const doneCount = allTasks.filter((t: any) => t.status === "done").length;
    const staleNote = stalePlanCount > 0 ? ` (${stalePlanCount} stale plans hidden, use --all)` : "";

    if (options.plain) {
      lines.push(`${totalPlans} plans · ${allTasks.length} tasks (${inProgress} active, ${ready} ready, ${blocked} blocked, ${doneCount} done)${staleNote}`);
    } else {
      lines.push(`${o.dim}${totalPlans} plans · ${allTasks.length} tasks (${o.yellow}${inProgress} active${o.dim}, ${o.blue}${ready} ready${o.dim}, ${blocked} blocked, ${o.green}${doneCount} done${o.dim})${staleNote}${o.reset}`);
    }

    console.log(lines.join("\n"));
  });

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const work = program
  .command("task")
  .alias("t")
  .description("Manage work items (tasks, bugs, features)");

work
  .command("create")
  .description("Create a new work item")
  .argument("<title>", "Task title")
  .option("-d, --description <text>", "Description")
  .option("-t, --type <type>", "Type: task, feature, bug, chore", "task")
  .option("-p, --priority <level>", "Priority: urgent, high, medium, low", "medium")
  .option("--project <id>", "Project ID")
  .option("--blocked-by <ids>", "Comma-separated short_ids this is blocked by")
  .option("--labels <labels>", "Comma-separated labels")
  .option("--assignee <name>", "Assignee")
  .option("--status <status>", "Initial status (default: open)", "open")
  .option("--plan <plan_id>", "Plan short ID to associate this task with")
  .action(async (title: string, options: any) => {
    const body: Record<string, any> = {
      title,
      task_type: options.type,
      status: options.status,
      priority: options.priority,
    };
    if (options.description) body.description = options.description;
    if (options.project) body.project_id = options.project;
    if (options.assignee) body.assignee = options.assignee;
    if (options.blockedBy) body.blocked_by = options.blockedBy.split(",").map((s: string) => s.trim());
    if (options.labels) body.labels = options.labels.split(",").map((s: string) => s.trim());
    if (options.plan) body.plan_id = options.plan;

    const sessionId = detectCurrentSessionId();
    if (sessionId) body.conversation_id = sessionId;
    body.project_path = getRealCwd();

    const result = await cliPost("/cli/work/create", body);
    console.log(`${c.green}ok${c.reset} Created ${c.cyan}${result.short_id}${c.reset}: ${title}`);
  });

work
  .command("ls")
  .description("List work items")
  .option("-p, --project <id>", "Filter by project ID")
  .option("-s, --status <status>", "Filter by status")
  .option("-r, --ready", "Show only ready items (open, no blockers)")
  .option("-a, --all", "Include derived/mined tasks (hidden by default)")
  .option("-n, --limit <n>", "Max results", "50")
  .option("-v, --verbose", "Show descriptions")
  .action(async (options: any) => {
    const body: Record<string, any> = { limit: parseInt(options.limit) };
    if (options.project) body.project_id = options.project;
    if (options.status) body.status = options.status;
    if (options.ready) body.ready = true;
    if (options.all) body.include_derived = true;
    body.project_path = getRealCwd();

    const tasks = await cliPost("/cli/work/list", body);
    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.log(fmt.muted("No tasks found."));
      return;
    }
    for (const t of tasks) {
      console.log(formatWorkItem(t, options.verbose));
    }
    console.log(fmt.muted(`\n  ${tasks.length} items`));
  });

work
  .command("show")
  .description("Show task details")
  .argument("<short_id>", "Task short ID (e.g., ct-a1b2)")
  .option("-c, --comments", "Show all comments")
  .action(async (shortId: string, options: any) => {
    const result = await cliPost("/cli/work/get", { short_id: shortId });
    if (!result) {
      console.error("Task not found");
      process.exit(1);
    }
    const t = result;
    const icon = STATUS_ICONS[t.status] || "?";
    const pcolor = PRIORITY_COLORS[t.priority] || "";
    const pri = pcolor ? `${pcolor}${t.priority}${c.reset}` : t.priority;
    console.log(`\n  ${icon} ${c.bold}${t.title}${c.reset}`);
    console.log(`  ${c.cyan}${t.short_id}${c.reset} | ${t.status} | ${pri} | ${t.task_type}`);
    if (t.execution_status && t.execution_status !== t.status) {
      console.log(`  ${c.dim}Execution: ${t.execution_status}${c.reset}`);
    }
    if (t.description) console.log(`\n  ${t.description}`);
    if (t.acceptance_criteria?.length) {
      console.log(`\n  ${c.bold}Acceptance Criteria${c.reset}`);
      for (const ac of t.acceptance_criteria) {
        console.log(`  ${c.dim}-${c.reset} ${ac}`);
      }
    }
    if (t.steps?.length) {
      console.log(`\n  ${c.bold}Steps${c.reset}`);
      for (const s of t.steps) {
        const check = s.done ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
        console.log(`  ${check} ${s.title}`);
      }
    }
    if (t.labels?.length) console.log(`  ${c.dim}Labels: ${t.labels.join(", ")}${c.reset}`);
    if (t.assignee) console.log(`  ${c.dim}Assignee: ${t.assignee}${c.reset}`);
    if (t.blocked_by?.length) console.log(`  ${c.red}Blocked by: ${t.blocked_by.join(", ")}${c.reset}`);
    if (t.blocks?.length) console.log(`  ${c.dim}Blocks: ${t.blocks.join(", ")}${c.reset}`);
    if (t.execution_concerns) console.log(`  ${c.yellow}Concerns: ${t.execution_concerns}${c.reset}`);
    if (t.comments?.length) {
      const COMMENT_TYPE_ICONS: Record<string, string> = {
        progress: `${c.blue}↳${c.reset}`,
        blocker: `${c.red}!${c.reset}`,
        review: `${c.magenta}◇${c.reset}`,
        note: `${c.dim}·${c.reset}`,
      };
      const showAll = options.comments;
      const comments = showAll ? t.comments : t.comments.slice(-5);
      const truncated = !showAll && t.comments.length > 5;
      console.log(`\n  ${c.bold}Comments (${t.comments.length})${c.reset}${truncated ? ` ${c.dim}showing last 5, use -c for all${c.reset}` : ""}`);
      for (const cm of comments) {
        const ago = formatMs(Date.now() - cm.created_at);
        const typeIcon = COMMENT_TYPE_ICONS[cm.comment_type] || COMMENT_TYPE_ICONS.note;
        console.log(`  ${typeIcon} ${c.dim}${cm.author} (${ago} ago):${c.reset} ${cm.text}`);
      }
    }
    console.log();
  });

work
  .command("start")
  .description("Start working on a task (set in_progress)")
  .argument("<short_id>", "Task short ID")
  .action(async (shortId: string) => {
    const sessionId = detectCurrentSessionId();
    const body: Record<string, any> = { short_id: shortId, status: "in_progress" };
    if (sessionId) body.conversation_id = sessionId;
    const result = await cliPost("/cli/work/update", body);
    console.log(`${c.green}ok${c.reset} Started ${c.cyan}${shortId}${c.reset}`);

    if (result.plan_id && sessionId) {
      try {
        await cliPost("/cli/plans/bind", { short_id: result.plan_id, session_id: sessionId });
        console.log(`${c.dim}Session bound to plan ${result.plan_id}${c.reset}`);
      } catch {}
    }
  });

work
  .command("done")
  .description("Mark a task as done")
  .argument("<short_id>", "Task short ID")
  .option("-m, --message <text>", "Completion comment")
  .option("--concerns <text>", "Mark done with concerns")
  .action(async (shortId: string, options: any) => {
    const sessionId = detectCurrentSessionId();
    const body: Record<string, any> = { short_id: shortId, status: "done" };
    if (sessionId) body.conversation_id = sessionId;
    if (options.concerns) {
      body.execution_status = "done_with_concerns";
      body.execution_concerns = options.concerns;
    } else {
      body.execution_status = "done";
    }
    if (options.message) body.verification_evidence = options.message;
    await cliPost("/cli/work/update", body);
    if (options.message) {
      await cliPost("/cli/work/comment", { short_id: shortId, text: options.message, comment_type: "note" });
    }
    console.log(`${c.green}ok${c.reset} Completed ${c.cyan}${shortId}${c.reset}`);
  });

work
  .command("drop")
  .description("Drop/cancel a task")
  .argument("<short_id>", "Task short ID")
  .option("-m, --message <text>", "Reason for dropping")
  .action(async (shortId: string, options: any) => {
    await cliPost("/cli/work/update", { short_id: shortId, status: "dropped" });
    if (options.message) {
      await cliPost("/cli/work/comment", { short_id: shortId, text: options.message, comment_type: "note" });
    }
    console.log(`${c.green}ok${c.reset} Dropped ${c.cyan}${shortId}${c.reset}`);
  });

work
  .command("update")
  .description("Update a task")
  .argument("<short_id>", "Task short ID")
  .option("-s, --status <status>", "New status")
  .option("-p, --priority <level>", "New priority")
  .option("-t, --title <title>", "New title")
  .option("-d, --description <text>", "New description")
  .option("--assignee <name>", "New assignee")
  .option("--labels <labels>", "Comma-separated labels")
  .option("--project <id>", "Project ID")
  .option("--plan <plan_id>", "Plan short ID to associate this task with")
  .action(async (shortId: string, options: any) => {
    const body: Record<string, any> = { short_id: shortId };
    if (options.status) body.status = options.status;
    if (options.priority) body.priority = options.priority;
    if (options.title) body.title = options.title;
    if (options.description !== undefined) body.description = options.description;
    if (options.assignee !== undefined) body.assignee = options.assignee;
    if (options.labels) body.labels = options.labels.split(",").map((s: string) => s.trim());
    if (options.project !== undefined) body.project_id = options.project;
    if (options.plan) body.plan_id = options.plan;
    await cliPost("/cli/work/update", body);
    console.log(`${c.green}ok${c.reset} Updated ${c.cyan}${shortId}${c.reset}`);
  });

work
  .command("comment")
  .description("Add a comment to a task")
  .argument("<short_id>", "Task short ID")
  .argument("<text>", "Comment text")
  .option("-t, --type <type>", "Comment type: note, progress, blocker, review", "note")
  .action(async (shortId: string, text: string, options: any) => {
    const sessionId = detectCurrentSessionId();
    const body: Record<string, any> = { short_id: shortId, text, comment_type: options.type };
    if (sessionId) body.conversation_id = sessionId;
    await cliPost("/cli/work/comment", body);
    console.log(`${c.green}ok${c.reset} Comment added to ${c.cyan}${shortId}${c.reset}`);
  });

work
  .command("dep")
  .description("Add a dependency between tasks")
  .argument("<short_id>", "Task short ID")
  .option("--blocks <id>", "This task blocks <id>")
  .option("--blocked-by <id>", "This task is blocked by <id>")
  .action(async (shortId: string, options: any) => {
    if (!options.blocks && !options.blockedBy) {
      console.error("Specify --blocks or --blocked-by");
      process.exit(1);
    }
    const body: Record<string, any> = { short_id: shortId };
    if (options.blocks) body.blocks = options.blocks;
    if (options.blockedBy) body.blocked_by = options.blockedBy;
    await cliPost("/cli/work/dep", body);
    console.log(`${c.green}ok${c.reset} Dependency added`);
  });

work
  .command("context")
  .description("Get full context for a task (for agents)")
  .argument("<short_id>", "Task short ID")
  .action(async (shortId: string) => {
    const result = await cliPost("/cli/work/context", { short_id: shortId });
    if (!result) {
      console.error("Task not found");
      process.exit(1);
    }
    const t = result.task;
    console.log(`\n# ${t.title}`);
    console.log(`ID: ${t.short_id} | Status: ${t.status} | Priority: ${t.priority} | Type: ${t.task_type}`);
    if (t.description) console.log(`\n${t.description}`);
    if (result.project) {
      console.log(`\nProject: ${result.project.title}`);
      if (result.project.description) console.log(result.project.description);
    }
    if (t.blocked_by?.length) console.log(`\nBlocked by: ${t.blocked_by.join(", ")}`);
    if (t.blocks?.length) console.log(`Blocks: ${t.blocks.join(", ")}`);
    if (result.comments?.length) {
      console.log(`\n## Comments`);
      for (const cm of result.comments) {
        console.log(`- [${cm.author}] ${cm.text}`);
      }
    }
    if (result.relatedDocs?.length) {
      console.log(`\n## Related Plans`);
      for (const d of result.relatedDocs) {
        console.log(`- ${d.title} (${d.doc_type})`);
        if (d.content) console.log(`  ${d.content.slice(0, 200)}`);
      }
    }
    if (result.sessionSummaries?.length) {
      console.log(`\n## Session History`);
      for (const s of result.sessionSummaries) {
        console.log(`- ${s}`);
      }
    }
    console.log();
  });

work
  .command("ready")
  .description("Show tasks ready to work on (open, no blockers)")
  .option("-p, --project <id>", "Filter by project")
  .option("--plan <plan_id>", "Filter by plan")
  .action(async (options: any) => {
    const body: Record<string, any> = { ready: true };
    if (options.project) body.project_id = options.project;
    if (options.plan) body.plan_id = options.plan;
    body.project_path = getRealCwd();
    const tasks = await cliPost("/cli/work/list", body);
    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.log(fmt.muted("No ready tasks."));
      return;
    }
    for (const t of tasks) {
      console.log(formatWorkItem(t));
    }
    console.log(fmt.muted(`\n  ${tasks.length} ready`));
  });

work
  .command("promote")
  .description("Promote a mined/derived task to a real task")
  .argument("<short_id>", "Task short ID")
  .action(async (shortId: string) => {
    await cliPost("/cli/work/promote", { short_id: shortId });
    console.log(`${c.green}ok${c.reset} Promoted ${c.cyan}${shortId}${c.reset}`);
  });

work
  .command("snippet")
  .description("Show current team task context (what agents see)")
  .action(async () => {
    const sessionId = detectCurrentSessionId();
    const body: Record<string, any> = {};
    if (sessionId) body.conversation_id = sessionId;
    body.project_path = getRealCwd();
    const result = await cliPost("/cli/work/snippet", body);
    if (result.snippet) {
      console.log(result.snippet);
    } else {
      console.log(fmt.muted("No active tasks or plans."));
    }
    console.log(fmt.muted(`\n  ${result.task_count} tasks, ${result.plan_count} plans`));
  });

work
  .command("install")
  .description("Install work item snippet into agent config (CLAUDE.md, AGENTS.md)")
  .option("--disable", "Remove work snippet and disable")
  .action(async (options: any) => {
    const config = readConfig() || {};

    if (options.disable) {
      config.work_enabled = false;
      writeConfig(config);
      console.log("Work snippet disabled. Run 'cast task install' to re-enable.");
      return;
    }

    const result = installWorkSnippet(true);
    config.work_enabled = true;
    config.work_version = getWorkVersion();
    writeConfig(config);

    const targets = getSnippetTargets();
    const targetList = targets.map(t => t.label).join(", ");
    if (result.updated) {
      console.log(`Work snippet updated in ${targetList}`);
    } else if (result.installed) {
      console.log(`Work snippet installed in ${targetList}`);
      console.log("Your agents can now track and manage work items.");
    } else {
      console.log("Work snippet is up to date.");
    }
  });

// --- Plans ---

const PLAN_STATUS_ICONS: Record<string, string> = {
  draft: "○",
  active: "◉",
  paused: "◫",
  done: "●",
  abandoned: "✕",
};

function formatPlanItem(p: any): string {
  const icon = PLAN_STATUS_ICONS[p.status] || "?";
  const progress = p.task_total ? ` (${p.task_done}/${p.task_total})` : "";
  return `  ${icon} ${c.cyan}${p.short_id}${c.reset} ${p.title} ${c.dim}${p.status}${progress}${c.reset}`;
}

const plan = program
  .command("plan")
  .alias("p")
  .description("Manage multi-session plans");

plan
  .command("create")
  .description("Create a new plan")
  .argument("<title>", "Plan title")
  .option("-g, --goal <text>", "Plan goal")
  .option("-b, --body <text>", "Plan body (short text)")
  .option("--body-file <path>", "Plan body from file (for longer content)")
  .option("-a, --acceptance <criteria>", "Acceptance criterion (repeatable)", (val: string, prev: string[]) => prev.concat([val]), [] as string[])
  .option("--from-session", "Promote from current session")
  .option("--project <id>", "Project ID")
  .option("-t, --template <name>", "Use a workflow template (plan-implement-verify, implement-review-fix, full-lifecycle)")
  .option("--model-stylesheet <stylesheet>", "CSS-like model routing rules")
  .action(async (title: string, options: any) => {
    const body: Record<string, any> = { title };
    if (options.goal) body.goal = options.goal;
    if (options.bodyFile) {
      const fs = await import("fs");
      body.body = fs.readFileSync(options.bodyFile, "utf-8");
    } else if (options.body) {
      body.body = options.body;
    }
    if (options.acceptance?.length) body.acceptance_criteria = options.acceptance;
    if (options.project) body.project_id = options.project;
    if (options.modelStylesheet) body.model_stylesheet = options.modelStylesheet;

    const sessionId = detectCurrentSessionId();
    if (options.fromSession) {
      body.source = "promoted";
      if (sessionId) body.session_id = sessionId;
    } else {
      body.source = "human";
    }
    body.project_path = getRealCwd();

    const result = await cliPost("/cli/plans/create", body);
    console.log(`${c.green}ok${c.reset} Created plan ${c.cyan}${result.short_id}${c.reset}: ${title}`);

    if (options.template) {
      const templates: Record<string, Array<{ title: string; description: string; blocked_by?: string[]; labels?: string[] }>> = {
        "plan-implement-verify": [
          { title: "Research and plan approach", description: "Investigate the codebase, understand requirements, and outline the implementation strategy.", labels: ["planning"] },
          { title: "Implement core changes", description: "Build the feature or fix based on the plan.", blocked_by: ["Research and plan approach"], labels: ["coding"] },
          { title: "Write tests", description: "Add unit and integration tests covering the implementation.", blocked_by: ["Implement core changes"], labels: ["testing"] },
          { title: "Verify and polish", description: "Run full test suite, typecheck, review diff, fix issues.", blocked_by: ["Write tests"], labels: ["verification"] },
        ],
        "implement-review-fix": [
          { title: "Initial implementation", description: "Build the feature or fix.", labels: ["coding"] },
          { title: "Self-review and identify issues", description: "Review the diff, run tests, identify problems.", blocked_by: ["Initial implementation"], labels: ["review"] },
          { title: "Fix identified issues", description: "Address all issues found during review.", blocked_by: ["Self-review and identify issues"], labels: ["coding"] },
          { title: "Final verification", description: "Confirm all issues resolved, tests pass, code is clean.", blocked_by: ["Fix identified issues"], labels: ["verification"] },
        ],
        "full-lifecycle": [
          { title: "Research and scope", description: "Understand the problem space, read relevant code, define scope.", labels: ["planning"] },
          { title: "Design approach", description: "Outline the technical approach, identify risks and dependencies.", blocked_by: ["Research and scope"], labels: ["planning"] },
          { title: "Implement", description: "Build the feature following the design.", blocked_by: ["Design approach"], labels: ["coding"] },
          { title: "Test", description: "Write and run tests.", blocked_by: ["Implement"], labels: ["testing"] },
          { title: "Review", description: "Self-review the changes, check for issues.", blocked_by: ["Test"], labels: ["review"] },
          { title: "Fix review findings", description: "Address any issues found during review.", blocked_by: ["Review"], labels: ["coding"] },
          { title: "Final verification and cleanup", description: "Run full CI, clean up dead code, verify everything.", blocked_by: ["Fix review findings"], labels: ["verification"] },
        ],
      };

      const tmpl = templates[options.template];
      if (!tmpl) {
        console.log(`${c.yellow}Unknown template:${c.reset} ${options.template}`);
        console.log(fmt.muted(`  Available: ${Object.keys(templates).join(", ")}`));
        return;
      }

      const shortIdMap = new Map<string, string>();
      for (const t of tmpl) {
        const blockedBy = t.blocked_by?.map((dep: string) => shortIdMap.get(dep)).filter(Boolean) as string[] | undefined;
        const taskResult = await cliPost("/cli/work/create", {
          title: t.title, description: t.description,
          plan_id: result.short_id, labels: t.labels,
          blocked_by: blockedBy?.length ? blockedBy : undefined,
          project_path: getRealCwd(),
        });
        shortIdMap.set(t.title, taskResult.short_id);
        console.log(`  ${c.green}+${c.reset} ${c.cyan}${taskResult.short_id}${c.reset}: ${t.title}`);
      }
      console.log(fmt.muted(`\n  ${tmpl.length} tasks from template "${options.template}"`));
    }
  });

plan
  .command("ls")
  .description("List plans")
  .option("--active", "Show active plans (default)")
  .option("--draft", "Show draft plans")
  .option("--done", "Show done plans")
  .option("--all", "Show all statuses")
  .option("--project <id>", "Filter by project")
  .action(async (options: any) => {
    const body: Record<string, any> = {};
    if (options.all) body.include_all = true;
    else if (options.draft) body.status = "draft";
    else if (options.done) body.status = "done";
    else if (options.active) body.status = "active";
    if (options.project) body.project_id = options.project;
    body.project_path = getRealCwd();

    const plans = await cliPost("/cli/plans/list", body);
    if (!Array.isArray(plans) || plans.length === 0) {
      console.log(fmt.muted("No plans found."));
      return;
    }
    for (const p of plans) {
      console.log(formatPlanItem(p));
    }
    console.log(fmt.muted(`\n  ${plans.length} plans`));
  });

plan
  .command("show")
  .description("Show plan details")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const result = await cliPost("/cli/plans/get", { short_id: planId });
    if (!result) {
      console.error("Plan not found");
      process.exit(1);
    }
    const p = result;
    const icon = PLAN_STATUS_ICONS[p.status] || "?";
    const progress = p.task_total ? `${p.task_done}/${p.task_total} tasks done` : "no tasks";
    console.log(`\n  ${icon} ${c.bold}${p.title}${c.reset}`);
    console.log(`  ${c.cyan}${p.short_id}${c.reset} | ${p.status} | ${progress}`);
    if (p.doc_content) console.log(`\n  ${p.doc_content}`);
    if (p.goal) console.log(`\n  ${c.bold}Goal:${c.reset} ${p.goal}`);
    if (p.acceptance_criteria?.length) {
      console.log(`\n  ${c.bold}Acceptance Criteria:${c.reset}`);
      for (const ac of p.acceptance_criteria) {
        console.log(`    - ${ac}`);
      }
    }
    if (p.tasks?.length) {
      console.log(`\n  ${c.bold}Tasks:${c.reset}`);
      for (const t of p.tasks) {
        const tIcon = STATUS_ICONS[t.status] || "?";
        console.log(`    ${tIcon} ${c.cyan}${t.short_id}${c.reset} ${t.title} ${c.dim}(${t.status})${c.reset}`);
      }
    }
    if (p.progress_log?.length) {
      console.log(`\n  ${c.bold}Progress (recent):${c.reset}`);
      for (const entry of p.progress_log.slice(-10)) {
        const ts = new Date(entry.timestamp).toLocaleString();
        console.log(`    ${c.dim}${ts}:${c.reset} ${entry.entry}`);
      }
    }
    if (p.decision_log?.length) {
      console.log(`\n  ${c.bold}Decisions:${c.reset}`);
      for (const d of p.decision_log) {
        console.log(`    ${d.decision} ${c.dim}(${d.rationale})${c.reset}`);
      }
    }
    if (p.discoveries?.length) {
      console.log(`\n  ${c.bold}Discoveries:${c.reset}`);
      for (const d of p.discoveries) {
        console.log(`    ${d.finding}`);
      }
    }
    if (p.context_pointers?.length) {
      console.log(`\n  ${c.bold}Context:${c.reset}`);
      for (const cp of p.context_pointers) {
        console.log(`    ${cp.label}: ${cp.path_or_url}`);
      }
    }
    console.log();
  });

plan
  .command("bind")
  .description("Bind current session to a plan and inject context")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const sessionId = detectCurrentSessionId();
    if (!sessionId) {
      console.error("Could not detect current session. Set CLAUDE_CODE_SESSION_ID or run from within a Claude Code session.");
      process.exit(1);
    }
    await cliPost("/cli/plans/bind", { short_id: planId, conversation_id: sessionId });
    console.log(`${c.green}ok${c.reset} Session bound to plan ${c.cyan}${planId}${c.reset}`);
    // Inject plan context into project directory
    try {
      const snippetResult = await cliPost("/cli/plans/snippet", { plan_short_id: planId });
      if (snippetResult?.snippet) {
        const fs = await import("fs");
        const path = await import("path");
        const contextDir = path.join(process.cwd(), ".claude");
        if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
        const contextFile = path.join(contextDir, "plan-context.md");
        fs.writeFileSync(contextFile, `# Active Plan Context\n\n${snippetResult.snippet}\n`, { mode: 0o644 });
        console.log(`${c.green}ok${c.reset} Plan context written to ${c.dim}.claude/plan-context.md${c.reset}`);
      }
    } catch {
      // Non-critical, continue
    }
  });

plan
  .command("unbind")
  .description("Unbind current session from its plan")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    await cliPost("/cli/plans/unbind", { short_id: planId });
    console.log(`${c.green}ok${c.reset} Session unbound from plan ${c.cyan}${planId}${c.reset}`);
  });

plan
  .command("update")
  .description("Update plan or log progress")
  .argument("<plan_id>", "Plan short ID")
  .option("--log <entry>", "Add progress log entry")
  .option("--goal <text>", "Update goal")
  .option("--title <text>", "Update title")
  .option("-b, --body <text>", "Update body (short text)")
  .option("--body-file <path>", "Update body from file (for longer content)")
  .action(async (planId: string, options: any) => {
    const sessionId = detectCurrentSessionId();
    if (options.log) {
      const body: Record<string, any> = { short_id: planId, entry: options.log };
      if (sessionId) body.session_id = sessionId;
      await cliPost("/cli/plans/log", body);
      console.log(`${c.green}ok${c.reset} Progress logged to ${c.cyan}${planId}${c.reset}`);
    }
    let bodyContent: string | undefined;
    if (options.bodyFile) {
      const fs = await import("fs");
      bodyContent = fs.readFileSync(options.bodyFile, "utf-8");
    } else if (options.body) {
      bodyContent = options.body;
    }
    if (options.goal || options.title || bodyContent !== undefined) {
      const body: Record<string, any> = { short_id: planId };
      if (options.goal) body.goal = options.goal;
      if (options.title) body.title = options.title;
      if (bodyContent !== undefined) body.body = bodyContent;
      await cliPost("/cli/plans/update", body);
      console.log(`${c.green}ok${c.reset} Updated plan ${c.cyan}${planId}${c.reset}`);
    }
    if (!options.log && !options.goal && !options.title && bodyContent === undefined) {
      console.error("Specify --log, --goal, --title, --body, or --body-file");
      process.exit(1);
    }
  });

plan
  .command("set-workflow")
  .description("Bind a workflow to a plan")
  .argument("<plan_id>", "Plan short ID")
  .argument("<workflow_slug>", "Workflow slug")
  .action(async (planId: string, workflowSlug: string) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) {
      console.error(`Plan ${planId} not found`);
      process.exit(1);
    }
    const result = await cliPost("/cli/workflows/list", {});
    const workflows = result.workflows || [];
    const workflow = workflows.find((w: any) => w.slug === workflowSlug);
    if (!workflow) {
      console.error(`Workflow "${workflowSlug}" not found`);
      if (workflows.length > 0) {
        console.log(fmt.muted(`  Available: ${workflows.map((w: any) => w.slug).join(", ")}`));
      }
      process.exit(1);
    }
    await cliPost("/cli/plans/update", { short_id: planId, workflow_id: workflow._id });
    console.log(`${c.green}ok${c.reset} Bound workflow ${c.cyan}${workflowSlug}${c.reset} to plan ${c.cyan}${planId}${c.reset}`);
  });

plan
  .command("decide")
  .description("Log a decision on a plan")
  .argument("<plan_id>", "Plan short ID")
  .argument("<decision>", "The decision")
  .option("--rationale <why>", "Rationale for the decision")
  .action(async (planId: string, decision: string, options: any) => {
    const sessionId = detectCurrentSessionId();
    const body: Record<string, any> = { short_id: planId, decision };
    if (options.rationale) body.rationale = options.rationale;
    if (sessionId) body.session_id = sessionId;
    await cliPost("/cli/plans/decide", body);
    console.log(`${c.green}ok${c.reset} Decision logged to ${c.cyan}${planId}${c.reset}`);
  });

plan
  .command("discover")
  .description("Log a discovery on a plan")
  .argument("<plan_id>", "Plan short ID")
  .argument("<finding>", "The finding")
  .action(async (planId: string, finding: string) => {
    const sessionId = detectCurrentSessionId();
    const body: Record<string, any> = { short_id: planId, finding };
    if (sessionId) body.session_id = sessionId;
    await cliPost("/cli/plans/discover", body);
    console.log(`${c.green}ok${c.reset} Discovery logged to ${c.cyan}${planId}${c.reset}`);
  });

plan
  .command("pointer")
  .description("Add a context pointer to a plan")
  .argument("<plan_id>", "Plan short ID")
  .argument("<label>", "Pointer label")
  .argument("<path>", "Path or URL")
  .action(async (planId: string, label: string, pathOrUrl: string) => {
    await cliPost("/cli/plans/pointer", { short_id: planId, label, path_or_url: pathOrUrl });
    console.log(`${c.green}ok${c.reset} Pointer added to ${c.cyan}${planId}${c.reset}`);
  });

plan
  .command("activate")
  .description("Activate a plan (draft -> active)")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    await cliPost("/cli/plans/status", { short_id: planId, status: "active" });
    console.log(`${c.green}ok${c.reset} Plan ${c.cyan}${planId}${c.reset} activated`);
  });

plan
  .command("pause")
  .description("Pause a plan (active -> paused)")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    await cliPost("/cli/plans/status", { short_id: planId, status: "paused" });
    console.log(`${c.green}ok${c.reset} Plan ${c.cyan}${planId}${c.reset} paused`);
  });

plan
  .command("done")
  .description("Mark a plan as done")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    await cliPost("/cli/plans/status", { short_id: planId, status: "done" });
    console.log(`${c.green}ok${c.reset} Plan ${c.cyan}${planId}${c.reset} done`);
  });

plan
  .command("drop")
  .description("Abandon a plan")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    await cliPost("/cli/plans/status", { short_id: planId, status: "abandoned" });
    console.log(`${c.green}ok${c.reset} Plan ${c.cyan}${planId}${c.reset} abandoned`);
  });

plan
  .command("promote")
  .description("Promote current session's ad-hoc plan to a persistent plan")
  .action(async () => {
    const sessionId = detectCurrentSessionId();
    if (!sessionId) {
      console.error("Could not detect current session. Set CLAUDE_CODE_SESSION_ID or run from within a Claude Code session.");
      process.exit(1);
    }
    const result = await cliPost("/cli/plans/create", { title: "Promoted from session", source: "promoted", session_id: sessionId });
    console.log(`${c.green}ok${c.reset} Created plan ${c.cyan}${result.short_id}${c.reset} from session`);
  });


// --- Plan Orchestration ---

let _agentRuntime: AgentRuntime | null = null;
function getAgentRuntime(): AgentRuntime {
  if (!_agentRuntime) _agentRuntime = detectRuntime();
  return _agentRuntime;
}

const activeHandles = new Map<string, AgentHandle>();

function captureAgentOutput(sessionName: string, lines = 500): string {
  const handle = activeHandles.get(sessionName);
  if (handle) return getAgentRuntime().getOutput(handle, lines).text;
  const sr = spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", `${sessionName}:0.0`, "-S", `-${lines}`], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return sr.status === 0 ? (sr.stdout || "") : "";
}

function parseAgentMarkers(output: string) {
  return _parseAgentMarkers(output);
}

function buildImplementerPrompt(plan: any, task: any): string {
  return _buildImplementerPrompt(plan, task);
}

plan
  .command("orchestrate")
  .alias("orch")
  .description("Spawn parallel agents to implement plan tasks")
  .argument("<plan_id>", "Plan short ID")
  .option("--dry-run", "Show what would be spawned without doing it")
  .option("--max <n>", "Max parallel agents", "3")
  .option("--watch", "Monitor agents after spawning")
  .action(async (planId: string, options: any) => {
    const result = await cliPost("/cli/plans/get", { short_id: planId });
    if (!result) {
      console.error("Plan not found");
      process.exit(1);
    }

    const plan = result;
    const allTasks = plan.tasks || [];
    const openTasks = allTasks.filter((t: any) => t.status === "open" || t.status === "backlog");

    if (openTasks.length === 0) {
      console.log(fmt.muted("No open tasks to orchestrate."));
      const done = allTasks.filter((t: any) => t.status === "done").length;
      const inProg = allTasks.filter((t: any) => t.status === "in_progress").length;
      if (allTasks.length) console.log(fmt.muted(`  ${done} done, ${inProg} in progress, ${allTasks.length} total`));
      return;
    }

    const resolvedIds = new Set(allTasks.filter((t: any) => t.status === "done" || t.status === "dropped").flatMap((t: any) => [t._id, t.short_id]));
    const readyTasks = openTasks.filter((t: any) => {
      if (!t.blocked_by || t.blocked_by.length === 0) return true;
      return t.blocked_by.every((d: string) => resolvedIds.has(d));
    });

    const maxAgents = parseInt(options.max, 10) || 3;
    const toSpawn = readyTasks.slice(0, maxAgents);

    console.log(`\n  ${c.bold}Plan:${c.reset} ${plan.title} ${c.dim}(${planId})${c.reset}`);
    console.log(`  ${c.bold}Ready:${c.reset} ${readyTasks.length} tasks, spawning ${toSpawn.length}`);
    if (readyTasks.length > maxAgents) console.log(fmt.muted(`  ${readyTasks.length - maxAgents} queued for next wave`));

    const blocked = openTasks.filter((t: any) => t.blocked_by?.length && !t.blocked_by.every((d: string) => resolvedIds.has(d)));
    if (blocked.length) console.log(fmt.muted(`  ${blocked.length} blocked on dependencies`));
    console.log();

    for (let i = 0; i < toSpawn.length; i++) {
      const task = toSpawn[i];
      const sessionName = `impl-${task.short_id}`;
      const prompt = buildImplementerPrompt(plan, task);

      if (options.dryRun) {
        console.log(`  ${c.cyan}${task.short_id}${c.reset} ${task.title}`);
        console.log(fmt.muted(`    session: ${sessionName}`));
        continue;
      }

      try {
        const runtime = getAgentRuntime();
        const taskModel = resolveTaskModel(plan, task);
        const handle = runtime.spawn({
          sessionName,
          prompt,
          model: taskModel,
          workingDir: getRealCwd(),
          resourceIndex: i,
          taskShortId: task.short_id,
        });
        activeHandles.set(sessionName, handle);
        const modelTag = taskModel !== "opus" ? ` ${c.dim}[${taskModel}]${c.reset}` : "";
        console.log(`  ${c.green}spawned${c.reset} ${c.cyan}${task.short_id}${c.reset} ${task.title}${modelTag} ${c.dim}(${runtime.name})${c.reset}`);
        try { await cliPost("/cli/work/update", { short_id: task.short_id, status: "in_progress" }); } catch {}
        await emitOrchEvent(planId, "agent_spawned", task.short_id, task.title, { model: taskModel, runtime: runtime.name });
      } catch (err: any) {
        console.error(`  ${c.red}error${c.reset} spawning ${task.short_id}: ${err.message}`);
      }
    }

    if (options.dryRun) {
      console.log(fmt.muted("\n  --dry-run: no agents spawned"));
      return;
    }

    console.log(fmt.muted(`\n  Monitor: cast plan agents ${planId}`));

    try {
      const taskIds = toSpawn.map((t: any) => t.short_id).join(", ");
      await cliPost("/cli/plans/log", { short_id: planId, entry: `Orchestrated ${toSpawn.length} agents: ${taskIds}` });
    } catch {}

    if (options.watch) {
      console.log(fmt.muted("\n  Watching agents (Ctrl+C to stop)...\n"));
      const checkAgents = () => {
        const ts = new Date().toLocaleTimeString();
        console.log(fmt.muted(`  --- ${ts} ---`));
        for (const task of toSpawn) {
          const sn = `impl-${task.short_id}`;
          const h = activeHandles.get(sn);
          const alive = h ? getAgentRuntime().isAlive(h) : spawnSync("tmux", ["has-session", "-t", sn], { stdio: ["pipe", "pipe", "pipe"] }).status === 0;
          if (!alive) {
            const lastOutput = captureAgentOutput(sn);
            const markers = parseAgentMarkers(lastOutput);
            if (markers.status === "done_with_concerns") {
              console.log(`  ${c.yellow}done*${c.reset} ${c.cyan}${task.short_id}${c.reset} ${task.title}: ${markers.detail}`);
            } else if (markers.status === "blocked") {
              console.log(`  ${c.red}block${c.reset} ${c.cyan}${task.short_id}${c.reset} ${task.title}: ${markers.detail}`);
            } else if (markers.status === "needs_context") {
              console.log(`  ${c.yellow}needs${c.reset} ${c.cyan}${task.short_id}${c.reset} ${task.title}: ${markers.detail}`);
            } else {
              console.log(`  ${c.dim}exit${c.reset}  ${c.cyan}${task.short_id}${c.reset}`);
            }
          } else {
            const out = captureAgentOutput(sn, 100);
            if (out.includes("Status: DONE") || out.includes("task done") || out.includes("cast task done")) {
              console.log(`  ${c.green}done${c.reset}  ${c.cyan}${task.short_id}${c.reset} ${task.title}`);
            } else {
              const markers = parseAgentMarkers(out);
              if (markers.status) {
                const label = markers.status === "blocked" ? `${c.red}block${c.reset}` :
                  markers.status === "needs_context" ? `${c.yellow}needs${c.reset}` :
                  `${c.yellow}done*${c.reset}`;
                console.log(`  ${label} ${c.cyan}${task.short_id}${c.reset} ${task.title}: ${markers.detail}`);
              } else {
                console.log(`  ${c.yellow}work${c.reset}  ${c.cyan}${task.short_id}${c.reset}`);
              }
            }
          }
        }
      };
      checkAgents();
      const interval = setInterval(checkAgents, 30_000);
      process.on("SIGINT", () => { clearInterval(interval); console.log("\n  Stopped watching."); process.exit(0); });
      await new Promise(() => {});
    }
  });

plan
  .command("decompose")
  .description("Decompose a plan into granular implementation tasks")
  .argument("<plan_id>", "Plan short ID")
  .option("--depth <level>", "Decomposition depth: shallow (5-10 tasks), medium (20-50), deep (100+)", "medium")
  .action(async (planId: string, options: any) => {
    const result = await cliPost("/cli/plans/get", { short_id: planId });
    if (!result) {
      console.error("Plan not found");
      process.exit(1);
    }

    const plan = result;
    const existingTasks = plan.tasks || [];

    console.log(`\n  ${c.bold}Plan:${c.reset} ${plan.title}`);
    console.log(`  ${c.bold}Goal:${c.reset} ${plan.goal || "none"}`);
    console.log(`  ${c.bold}Existing tasks:${c.reset} ${existingTasks.length}`);

    const depthGuide: Record<string, string> = {
      shallow: "5-10 high-level tasks, each ~30-60 minutes of work",
      medium: "20-50 tasks, each ~10-15 minutes of focused work",
      deep: "100+ granular tasks, each ~2-5 minutes (single file, single function, single test)",
    };

    const systemPrompt = `You are a task decomposition engine for software projects.
Given a plan and the project's file structure, break it into implementation tasks at the "${options.depth}" level: ${depthGuide[options.depth] || depthGuide.medium}.

Each task must have:
- title: Clear, actionable (starts with verb), references specific files/modules
- description: What specifically to implement, which files to modify, which functions to add/change
- task_type: "feature", "bug", "task", or "chore"
- priority: "high", "medium", or "low"
- acceptance_criteria: Array of verifiable criteria (e.g. "X query returns Y", "Z component renders W")
- steps: Array of ordered steps with title and verification string
- estimated_minutes: How long this should take
- blocked_by: Array of task titles this depends on (empty if independent)

Rules:
- Reference actual files and directories from the codebase context provided
- Tasks should be independently implementable where possible
- Each task should produce a testable, committable change
- Include test-writing as part of feature tasks, not separate tasks
- Order: schema/data model changes first, then backend logic, then UI, then polish
- For "deep" level: one task per function/component, one test per task
- Descriptions should name specific files, functions, database tables, API endpoints
- Avoid generic task names like "Create validation framework" -- be specific like "Add execution_status field to tasks schema and update mutation"

Output valid JSON array of task objects. Nothing else.`;

    // Gather codebase context for better task generation
    let codebaseContext = "";
    try {
      const cwd = getRealCwd();
      const treeResult = spawnSync("find", [cwd, "-maxdepth", "3", "-type", "f", "-name", "*.ts", "-o", "-name", "*.tsx", "-o", "-name", "*.py", "-o", "-name", "*.go", "-o", "-name", "*.rs"], {
        encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
      });
      if (treeResult.stdout) {
        const files = treeResult.stdout.trim().split("\n")
          .map((f: string) => f.replace(cwd + "/", ""))
          .filter((f: string) => !f.includes("node_modules") && !f.includes(".next") && !f.includes("dist/"))
          .slice(0, 200);
        codebaseContext += `\nCodebase files (${files.length} relevant):\n${files.join("\n")}`;
      }
      const gitLog = spawnSync("git", ["log", "--oneline", "-20"], { encoding: "utf-8", cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      if (gitLog.stdout) {
        codebaseContext += `\n\nRecent commits:\n${gitLog.stdout.trim()}`;
      }
    } catch {}

    const planContext = [
      `Plan: ${plan.title}`,
      plan.goal ? `Goal: ${plan.goal}` : "",
      plan.acceptance_criteria?.length ? `Acceptance Criteria:\n${plan.acceptance_criteria.map((ac: string) => `- ${ac}`).join("\n")}` : "",
      existingTasks.length ? `\nExisting tasks (avoid duplicates):\n${existingTasks.map((t: any) => `- ${t.title} (${t.status})`).join("\n")}` : "",
      codebaseContext,
    ].filter(Boolean).join("\n");

    // Check for plan doc content
    let docContent = "";
    if (plan.doc_id) {
      try {
        const doc = await cliPost("/cli/docs/get", { id: plan.doc_id });
        if (doc?.content) docContent = `\n\nPlan Document:\n${doc.content.slice(0, 8000)}`;
      } catch {}
    }

    console.log(fmt.muted(`\n  Decomposing at ${options.depth} level...`));

    try {
      const anthropic = new Anthropic();
      const maxToks = options.depth === "deep" ? 16000 : 8000;
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxToks,
        system: systemPrompt,
        messages: [{ role: "user", content: `${planContext}${docContent}` }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error("Failed to parse decomposition output");
        console.error(fmt.muted(text.slice(0, 500)));
        process.exit(1);
      }
      // Try to repair truncated JSON by finding the last complete object
      let jsonStr = jsonMatch[0];
      try { JSON.parse(jsonStr); } catch {
        const lastBrace = jsonStr.lastIndexOf("}");
        if (lastBrace > 0) {
          jsonStr = jsonStr.slice(0, lastBrace + 1) + "]";
          try { JSON.parse(jsonStr); } catch {
            const secondLastBrace = jsonStr.lastIndexOf("}", lastBrace - 1);
            if (secondLastBrace > 0) jsonStr = jsonStr.slice(0, secondLastBrace + 1) + "]";
          }
        }
      }

      const tasks = JSON.parse(jsonStr);
      console.log(`\n  Generated ${tasks.length} tasks:\n`);

      const priorityColor: Record<string, string> = { high: c.red, medium: c.yellow, low: c.dim };
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const pc = priorityColor[t.priority] || c.dim;
        const mins = t.estimated_minutes ? ` ${c.dim}(~${t.estimated_minutes}m)${c.reset}` : "";
        const deps = t.blocked_by?.length ? ` ${c.dim}← ${t.blocked_by.join(", ")}${c.reset}` : "";
        console.log(`  ${c.dim}${String(i + 1).padStart(3)}.${c.reset} ${pc}${t.priority?.slice(0, 1).toUpperCase()}${c.reset} ${t.title}${mins}${deps}`);
      }

      const totalMinutes = tasks.reduce((sum: number, t: any) => sum + (t.estimated_minutes || 0), 0);
      if (totalMinutes > 0) {
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        console.log(`\n  ${c.dim}Estimated total: ${hours > 0 ? `${hours}h ` : ""}${mins}m${c.reset}`);
      }

      const shouldCreate = await confirm({
        message: `Create ${tasks.length} tasks for plan ${planId}?`,
        default: true,
      });

      if (!shouldCreate) {
        console.log(fmt.muted("\n  Cancelled."));
        return;
      }

      const titleToId = new Map<string, string>();
      for (const et of existingTasks) {
        titleToId.set(et.title, et.short_id);
      }

      let created_count = 0;
      for (const task of tasks) {
        try {
          const body: Record<string, any> = {
            title: task.title,
            description: task.description,
            task_type: task.task_type || "task",
            priority: task.priority || "medium",
            plan_id: planId,
            project_path: getRealCwd(),
            ...(task.estimated_minutes && { estimated_minutes: task.estimated_minutes }),
            ...(task.acceptance_criteria?.length && { acceptance_criteria: task.acceptance_criteria }),
            ...(task.steps?.length && { steps: task.steps }),
          };

          const created = await cliPost("/cli/work/create", body);
          titleToId.set(task.title, created.short_id);
          created_count++;
          console.log(`  ${c.green}+${c.reset} ${c.cyan}${created.short_id}${c.reset} ${task.title}`);

          if (task.acceptance_criteria?.length) {
            const acText = `Acceptance Criteria:\n${task.acceptance_criteria.map((ac: string) => `- [ ] ${ac}`).join("\n")}`;
            try { await cliPost("/cli/work/comment", { short_id: created.short_id, text: acText, comment_type: "note" }); } catch {}
          }

          if (task.blocked_by?.length) {
            for (const dep of task.blocked_by) {
              const depId = titleToId.get(dep);
              if (depId) {
                try { await cliPost("/cli/work/dep", { short_id: created.short_id, blocked_by: depId }); } catch {}
              }
            }
          }
        } catch (taskErr: any) {
          console.error(`  ${c.red}x${c.reset} ${task.title}: ${taskErr.message?.slice(0, 80)}`);
        }
      }

      console.log(fmt.muted(`\n  ${created_count}/${tasks.length} tasks created for plan ${planId}`));
      console.log(fmt.muted(`  Run: cast plan orchestrate ${planId} --dry-run`));

      await cliPost("/cli/plans/log", { short_id: planId, entry: `Decomposed into ${created_count} tasks at ${options.depth} depth` });
    } catch (err: any) {
      console.error(`Decomposition failed: ${err.message}`);
      process.exit(1);
    }
  });

plan
  .command("autopilot")
  .description("Continuously orchestrate a plan: spawn agents, monitor, spawn next wave")
  .argument("<plan_id>", "Plan short ID")
  .option("--max <n>", "Max parallel agents per wave", "3")
  .option("--interval <mins>", "Minutes between status checks", "2")
  .option("--max-runtime <duration>", "Max runtime before self-rescheduling (e.g., 30m, 2h)")
  .option("--max-waves <n>", "Max number of waves before stopping")
  .option("--dry-run", "Show what would be spawned without doing it")
  .option("--verify", "Run typecheck verification before merging")
  .option("--no-reschedule", "Disable automatic self-continuation on exit")
  .action(async (planId: string, options: any) => {
    const maxAgents = parseInt(options.max, 10) || 3;
    const maxWaves = options.maxWaves ? parseInt(options.maxWaves, 10) : undefined;
    const intervalMs = (parseInt(options.interval, 10) || 2) * 60_000;
    const maxRuntimeMs = options.maxRuntime ? parseDuration(options.maxRuntime) : undefined;
    const reschedule = options.reschedule !== false;
    const runtime = getAgentRuntime();
    const startTime = Date.now();

    const scheduleResume = (reason: string) => {
      if (!reschedule) return;
      const resumePrompt = `Run this command to continue autopilot orchestration: cast plan autopilot ${planId} --max-runtime 2h`;
      const args = [
        "schedule", "add",
        resumePrompt,
        "--in", "5m",
        "--mode", "apply",
        "--project", getRealCwd(),
        "--title", `autopilot-resume:${planId}`,
        "--max-runtime", "15m",
      ];
      const castBin = process.argv[1];
      const sr = spawnSync(castBin, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      if (sr.status === 0) {
        console.log(`  ${c.green}scheduled${c.reset} autopilot resume in 5m (${reason})`);
      } else {
        console.error(`  ${c.red}failed${c.reset} to schedule resume: ${(sr.stderr || "").trim().slice(0, 120)}`);
      }
    };

    if (options.dryRun) {
      const plan = await cliPost("/cli/plans/get", { short_id: planId });
      if (!plan) { console.error("Plan not found"); process.exit(1); }
      const allTasks = plan.tasks || [];
      const resolvedIds = new Set(allTasks.filter((t: any) => t.status === "done" || t.status === "dropped").flatMap((t: any) => [t._id, t.short_id]));
      const open = allTasks.filter((t: any) => t.status === "open" || t.status === "backlog");
      const ready = open.filter((t: any) => {
        if (!t.blocked_by || t.blocked_by.length === 0) return true;
        return t.blocked_by.every((d: string) => resolvedIds.has(d));
      });
      console.log(`\n  ${c.bold}Autopilot dry-run${c.reset} for ${c.cyan}${planId}${c.reset}`);
      console.log(`  ${ready.length} ready tasks, would spawn ${Math.min(ready.length, maxAgents)} agents:\n`);
      for (const t of ready.slice(0, maxAgents)) {
        console.log(`  ${c.cyan}${t.short_id}${c.reset} ${t.title}`);
      }
      if (ready.length > maxAgents) console.log(fmt.muted(`  ... and ${ready.length - maxAgents} queued`));
      return;
    }

    console.log(`\n  ${c.bold}Autopilot${c.reset} for plan ${c.cyan}${planId}${c.reset}`);
    const runtimeLabel = maxRuntimeMs ? `, max runtime ${options.maxRuntime}` : "";
    const wavesLabel = maxWaves ? `, max ${maxWaves} waves` : "";
    console.log(fmt.muted(`  Max ${maxAgents} agents, checking every ${options.interval}m${runtimeLabel}${wavesLabel}\n`));

    const activeAgents = new Map<string, { task: any; spawnedAt: number }>();
    let waveCount = 0;
    let totalSpawned = 0, totalCompleted = 0, totalFailed = 0, totalMerged = 0;

    const runCycle = async () => {
      const plan = await cliPost("/cli/plans/get", { short_id: planId });
      if (!plan) { console.error("Plan not found"); return false; }

      const allTasks = plan.tasks || [];
      const done = allTasks.filter((t: any) => t.status === "done").length;
      const total = allTasks.length;

      // Check active agents -- detect completion via task status, then cleanup tmux
      for (const [shortId, info] of activeAgents) {
        const sn = `impl-${shortId}`;
        const task = allTasks.find((t: any) => t.short_id === shortId);
        const handle = activeHandles.get(sn);
        const agentAlive = handle ? runtime.isAlive(handle) : spawnSync("tmux", ["has-session", "-t", sn], { stdio: ["pipe", "pipe", "pipe"] }).status === 0;

        if (task?.status === "done") {
          console.log(`  ${c.green}done${c.reset}  ${c.cyan}${shortId}${c.reset} ${info.task.title}`);
          totalCompleted++;
          await emitOrchEvent(planId, "task_completed", shortId, info.task.title);
          if (agentAlive && handle) runtime.kill(handle);

          if (task.verify_with) {
            const verifyTask = allTasks.find((t: any) => t.short_id === task.verify_with);
            if (verifyTask && verifyTask.status !== "done" && verifyTask.status !== "dropped" && !activeAgents.has(verifyTask.short_id)) {
              const visitCount = verifyTask.retry_count || 0;
              const maxVisits = verifyTask.max_visits || verifyTask.max_retries || 3;
              if (visitCount < maxVisits) {
                console.log(`  ${c.dim}verify${c.reset} ${c.cyan}${shortId}${c.reset} -> spawning ${c.cyan}${verifyTask.short_id}${c.reset} (visit ${visitCount + 1}/${maxVisits})`);
                const vSessionName = `impl-${verifyTask.short_id}`;
                const vPrompt = buildImplementerPrompt(plan, verifyTask);
                const vModel = resolveTaskModel(plan, verifyTask, "sonnet");
                try {
                  const vHandle = runtime.spawn({
                    sessionName: vSessionName, prompt: vPrompt, model: vModel,
                    workingDir: getRealCwd(), taskShortId: verifyTask.short_id,
                  });
                  activeHandles.set(vSessionName, vHandle);
                  activeAgents.set(verifyTask.short_id, { task: verifyTask, spawnedAt: Date.now() });
                  try { await cliPost("/cli/work/update", { short_id: verifyTask.short_id, status: "in_progress", retry_count: visitCount + 1 }); } catch {}
                  await emitOrchEvent(planId, "verification_spawned", verifyTask.short_id, `Visit ${visitCount + 1}/${maxVisits}`);
                } catch {}
              } else {
                console.log(`  ${c.yellow}verify-max${c.reset} ${c.cyan}${verifyTask.short_id}${c.reset} max visits (${maxVisits}) reached`);
                const retryTarget = verifyTask.retry_target || task.short_id;
                if (retryTarget && retryTarget !== verifyTask.short_id) {
                  console.log(`  ${c.dim}retry-target${c.reset} resetting ${c.cyan}${retryTarget}${c.reset} for re-implementation`);
                  try { await cliPost("/cli/work/update", { short_id: retryTarget, status: "open" }); } catch {}
                }
              }
            }
          }

          // Git checkpoint after task completion
          try {
            const cwd = getRealCwd();
            const hasChanges = spawnSync("git", ["status", "--porcelain"], { encoding: "utf-8", cwd, stdio: ["pipe", "pipe", "pipe"] });
            if (hasChanges.stdout?.trim()) {
              spawnSync("git", ["add", "-A"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
              const commitMsg = `checkpoint(${planId}): ${shortId} completed\n\nCodecast-Plan: ${planId}\nCodecast-Task: ${shortId}\nCodecast-Wave: ${waveCount}\nCodecast-Status: done`;
              spawnSync("git", ["commit", "-m", commitMsg], { encoding: "utf-8", cwd, stdio: ["pipe", "pipe", "pipe"] });
              await emitOrchEvent(planId, "checkpoint_committed" as any, shortId, `Wave ${waveCount}`);
            }
          } catch {}

          // Optional verification before merge
          if (options.verify) {
            const verifyResult = spawnSync("npx", ["tsc", "--noEmit"], {
              encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: getRealCwd(), timeout: 60_000,
            });
            if (verifyResult.status !== 0) {
              console.log(`  ${c.yellow}verify-fail${c.reset} ${c.cyan}${shortId}${c.reset} typecheck failed, skipping merge`);
              try {
                await cliPost("/cli/work/comment", { short_id: shortId, text: "Typecheck failed after completion, merge skipped", comment_type: "blocker" });
              } catch {}
              activeAgents.delete(shortId);
              continue;
            }
            console.log(`  ${c.green}verified${c.reset} ${c.cyan}${shortId}${c.reset}`);
          }

          // Auto-merge the agent's branch if it exists
          const branch = `ashot/${shortId}`;
          const branchCheck = spawnSync("git", ["rev-parse", "--verify", branch], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: getRealCwd() });
          if (branchCheck.status === 0) {
            const mergeResult = spawnSync("git", ["merge", branch, "--no-edit"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: getRealCwd() });
            if (mergeResult.status === 0) {
              console.log(`  ${c.green}merge${c.reset} ${c.cyan}${branch}${c.reset}`);
              totalMerged++;
              await emitOrchEvent(planId, "merge_succeeded", shortId, branch);
              spawnSync("git", ["push", "origin", "main"], { stdio: ["pipe", "pipe", "pipe"], cwd: getRealCwd() });
            } else {
              console.log(`  ${c.yellow}merge-conflict${c.reset} ${c.cyan}${branch}${c.reset} -- needs manual resolution`);
              await emitOrchEvent(planId, "merge_failed", shortId, `Conflict on ${branch}`);
              spawnSync("git", ["merge", "--abort"], { stdio: ["pipe", "pipe", "pipe"], cwd: getRealCwd() });
            }
          }
          activeAgents.delete(shortId);
        } else if (!agentAlive) {
          // Agent died -- parse output for structured markers, then fall back to auto-retry
          const lastOutput = captureAgentOutput(sn);
          const markers = parseAgentMarkers(lastOutput);
          const retryCount = task?.retry_count || 0;
          const maxRetries = task?.max_retries || 3;

          if (markers.status === "blocked") {
            console.log(`  ${c.red}block${c.reset} ${c.cyan}${shortId}${c.reset} ${info.task.title}: ${markers.detail}`);
            try {
              await cliPost("/cli/work/update", { short_id: shortId, execution_status: "blocked" });
              await cliPost("/cli/work/comment", { short_id: shortId, text: `BLOCKED: ${markers.detail}`, comment_type: "blocker" });
            } catch {}
          } else if (markers.status === "needs_context") {
            console.log(`  ${c.yellow}needs${c.reset} ${c.cyan}${shortId}${c.reset} ${info.task.title}: ${markers.detail}`);
            try {
              await cliPost("/cli/work/update", { short_id: shortId, execution_status: "needs_context" });
              await cliPost("/cli/work/comment", { short_id: shortId, text: `NEEDS_CONTEXT: ${markers.detail}`, comment_type: "blocker" });
            } catch {}
          } else if (markers.status === "done_with_concerns") {
            console.log(`  ${c.yellow}done*${c.reset} ${c.cyan}${shortId}${c.reset} ${info.task.title}: ${markers.detail}`);
            try {
              await cliPost("/cli/work/update", { short_id: shortId, status: "done", execution_status: "done_with_concerns", execution_concerns: markers.detail });
            } catch {}
          } else if (retryCount < maxRetries) {
            console.log(`  ${c.yellow}retry${c.reset} ${c.cyan}${shortId}${c.reset} agent died, retrying (${retryCount + 1}/${maxRetries})`);
            try {
              await cliPost("/cli/work/update", { short_id: shortId, status: "open", retry_count: retryCount + 1 });
              await cliPost("/cli/work/comment", { short_id: shortId, text: `Agent session \`${sn}\` exited without completing. Auto-retrying (attempt ${retryCount + 1}/${maxRetries}).`, comment_type: "progress" });
            } catch {}
          } else {
            console.log(`  ${c.red}failed${c.reset} ${c.cyan}${shortId}${c.reset} agent died, max retries exceeded`);
            totalFailed++;
            try {
              await cliPost("/cli/work/update", { short_id: shortId, execution_status: "needs_context" });
              await cliPost("/cli/work/comment", { short_id: shortId, text: `Agent session \`${sn}\` exited without completing after ${retryCount} retries. Needs human attention.`, comment_type: "blocker" });
            } catch {}
          }
          activeAgents.delete(shortId);
        } else {
          // Agent alive -- check for structured markers or timeout
          const lastOutput = captureAgentOutput(sn);
          const markers = parseAgentMarkers(lastOutput);
          const killAgent = () => { if (handle) runtime.kill(handle); activeHandles.delete(sn); };
          if (markers.status === "blocked") {
            console.log(`  ${c.red}block${c.reset} ${c.cyan}${shortId}${c.reset} ${info.task.title}: ${markers.detail}`);
            try {
              await cliPost("/cli/work/update", { short_id: shortId, execution_status: "blocked" });
              await cliPost("/cli/work/comment", { short_id: shortId, text: `BLOCKED: ${markers.detail}`, comment_type: "blocker" });
            } catch {}
            killAgent();
            activeAgents.delete(shortId);
          } else if (markers.status === "needs_context") {
            console.log(`  ${c.yellow}needs${c.reset} ${c.cyan}${shortId}${c.reset} ${info.task.title}: ${markers.detail}`);
            try {
              await cliPost("/cli/work/update", { short_id: shortId, execution_status: "needs_context" });
              await cliPost("/cli/work/comment", { short_id: shortId, text: `NEEDS_CONTEXT: ${markers.detail}`, comment_type: "blocker" });
            } catch {}
            killAgent();
            activeAgents.delete(shortId);
          } else {
            const elapsed = Date.now() - info.spawnedAt;
            const taskTimeout = 30 * 60_000;
            if (elapsed > taskTimeout) {
              console.log(`  ${c.red}timeout${c.reset} ${c.cyan}${shortId}${c.reset} exceeded ${Math.round(taskTimeout / 60_000)}m`);
              killAgent();
              const retryCount = task?.retry_count || 0;
              try {
                await cliPost("/cli/work/update", { short_id: shortId, status: "open", retry_count: retryCount + 1 });
                await cliPost("/cli/work/comment", { short_id: shortId, text: `Agent timed out after ${Math.round(elapsed / 60_000)}m. Auto-retrying.`, comment_type: "progress" });
              } catch {}
              activeAgents.delete(shortId);
            }
          }
        }
      }

      // Check completion using join policy (dropped tasks don't block completion)
      const dropped = allTasks.filter((t: any) => t.status === "dropped").length;
      const actionable = total - dropped;
      const joinPolicy = plan.join_policy || "wait_all";
      const joinK = plan.join_k || Math.ceil(actionable / 2);
      let planDone = false;

      if (activeAgents.size === 0 && actionable > 0) {
        switch (joinPolicy) {
          case "wait_all":
            planDone = done >= actionable;
            break;
          case "first_success":
            planDone = done >= 1;
            break;
          case "k_of_n":
            planDone = done >= joinK;
            break;
          case "quorum":
            planDone = done > actionable / 2;
            break;
          default:
            planDone = done >= actionable;
        }
      }

      if (planDone) {
        const policyLabel = joinPolicy !== "wait_all" ? ` (${joinPolicy}${joinPolicy === "k_of_n" ? `: ${joinK}/${actionable}` : ""})` : "";
        console.log(`\n  ${c.green}${c.bold}Plan complete!${c.reset} ${done}/${actionable} done${policyLabel}${dropped ? `, ${dropped} dropped` : ""}`);
        try { await cliPost("/cli/plans/status", { short_id: planId, status: "done" }); } catch {}
        try { await cliPost("/cli/plans/log", { short_id: planId, entry: `Autopilot completed (${joinPolicy}): ${done} done, ${dropped} dropped` }); } catch {}
        await emitOrchEvent(planId, "plan_completed", undefined, `${done} done, ${dropped} dropped`, { totalSpawned, totalCompleted, totalMerged, totalFailed, joinPolicy });
        return false;
      }

      // Find ready tasks (dropped dependencies count as resolved)
      const resolvedIds = new Set(allTasks.filter((t: any) => t.status === "done" || t.status === "dropped").flatMap((t: any) => [t._id, t.short_id]));
      const taskOutcomes = new Map<string, string>();
      for (const t of allTasks) {
        if (t.status === "done") taskOutcomes.set(t.short_id, t.execution_status || "done");
        else if (t.status === "dropped") taskOutcomes.set(t.short_id, "dropped");
      }
      const openTasks = allTasks.filter((t: any) => t.status === "open" || t.status === "backlog");
      const readyTasks = openTasks.filter((t: any) => {
        if (activeAgents.has(t.short_id)) return false;
        if (!t.blocked_by || t.blocked_by.length === 0) return evaluateCondition(t, taskOutcomes);
        if (!t.blocked_by.every((d: string) => resolvedIds.has(d))) return false;
        return evaluateCondition(t, taskOutcomes);
      });

      const slots = maxAgents - activeAgents.size;
      const toSpawn = readyTasks.slice(0, Math.max(0, slots));

      // Check max-waves limit
      if (maxWaves && toSpawn.length > 0 && activeAgents.size === 0) {
        waveCount++;
        if (waveCount > maxWaves) {
          console.log(`\n  Max waves (${maxWaves}) reached. Stopping.`);
          scheduleResume("max waves");
          return false;
        }
        console.log(`  ${c.dim}Wave ${waveCount}${maxWaves ? `/${maxWaves}` : ""}${c.reset}`);
      }

      const ts = new Date().toLocaleTimeString();
      console.log(`  ${c.dim}${ts}${c.reset} ${done}/${actionable} done, ${activeAgents.size} active, ${readyTasks.length} ready`);
      try { await cliPost("/cli/plans/log", { short_id: planId, entry: `Cycle: ${done}/${actionable} done, ${activeAgents.size} active, ${readyTasks.length} ready` }); } catch {}

      for (let i = 0; i < toSpawn.length; i++) {
        const task = toSpawn[i];
        const sessionName = `impl-${task.short_id}`;
        const prompt = buildImplementerPrompt(plan, task);
        const resourceIdx = [...activeAgents.values()].length + i;

        try {
          const taskModel = resolveTaskModel(plan, task);
          const handle = runtime.spawn({
            sessionName,
            prompt,
            model: taskModel,
            workingDir: getRealCwd(),
            resourceIndex: resourceIdx % 4,
            taskShortId: task.short_id,
          });
          activeHandles.set(sessionName, handle);
          activeAgents.set(task.short_id, { task, spawnedAt: Date.now() });
          totalSpawned++;
          const modelTag = taskModel !== "opus" ? ` [${taskModel}]` : "";
          console.log(`  ${c.green}spawn${c.reset} ${c.cyan}${task.short_id}${c.reset} ${task.title}${modelTag}`);
          try { await cliPost("/cli/work/update", { short_id: task.short_id, status: "in_progress" }); } catch {}
          await emitOrchEvent(planId, "agent_spawned", task.short_id, task.title, { model: taskModel });
        } catch (err: any) {
          console.error(`  ${c.red}fail${c.reset}  ${task.short_id}: ${err.message}`);
          await emitOrchEvent(planId, "agent_failed", task.short_id, err.message);
        }
      }

      return true;
    };

    // Initial cycle
    const shouldContinue = await runCycle();
    if (!shouldContinue) return;

    // Loop
    const interval = setInterval(async () => {
      try {
        if (maxRuntimeMs && (Date.now() - startTime) >= maxRuntimeMs) {
          clearInterval(interval);
          const elapsed = Math.round((Date.now() - startTime) / 60_000);
          console.log(`\n  Max runtime reached (${elapsed}m). ${activeAgents.size} agents still running.`);
          console.log(`  ${c.dim}Metrics: ${totalSpawned} spawned, ${totalCompleted} completed, ${totalMerged} merged, ${totalFailed} failed${c.reset}`);
          scheduleResume("max runtime");
          process.exit(0);
        }
        const cont = await runCycle();
        if (!cont) { clearInterval(interval); process.exit(0); }
      } catch (err: any) {
        console.error(fmt.muted(`  Error: ${err.message}`));
      }
    }, intervalMs);

    process.on("SIGINT", () => {
      clearInterval(interval);
      const elapsed = Math.round((Date.now() - startTime) / 60_000);
      console.log(`\n  Stopped autopilot after ${elapsed}m. ${activeAgents.size} agents still running.`);
      console.log(`  ${c.dim}Metrics: ${totalSpawned} spawned, ${totalCompleted} completed, ${totalMerged} merged, ${totalFailed} failed${c.reset}`);
      scheduleResume("SIGINT");
      process.exit(0);
    });

    await new Promise(() => {});
  });

plan
  .command("status")
  .description("Show plan health: progress, active agents, blocked tasks, timing")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const done = tasks.filter((t: any) => t.status === "done");
    const inProgress = tasks.filter((t: any) => t.status === "in_progress");
    const open = tasks.filter((t: any) => t.status === "open" || t.status === "backlog");
    const dropped = tasks.filter((t: any) => t.status === "dropped");

    const resolvedIds = new Set([...done, ...dropped].flatMap((t: any) => [t._id, t.short_id]));
    const ready = open.filter((t: any) => {
      if (!t.blocked_by || t.blocked_by.length === 0) return true;
      return t.blocked_by.every((d: string) => resolvedIds.has(d));
    });
    const blocked = open.filter((t: any) => t.blocked_by?.length > 0 && !t.blocked_by.every((d: string) => resolvedIds.has(d)));

    const withConcerns = tasks.filter((t: any) => t.execution_status === "done_with_concerns");
    const needsContext = tasks.filter((t: any) => t.execution_status === "needs_context");
    const execBlocked = tasks.filter((t: any) => t.execution_status === "blocked");

    const totalMins = done.reduce((s: number, t: any) => s + (t.actual_minutes || 0), 0);
    const estRemaining = [...inProgress, ...open].reduce((s: number, t: any) => s + (t.estimated_minutes || 10), 0);

    const pct = tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0;
    const barWidth = 30;
    const filled = Math.round(barWidth * pct / 100);
    const bar = `${c.green}${"█".repeat(filled)}${c.dim}${"░".repeat(barWidth - filled)}${c.reset}`;

    console.log(`\n  ${c.bold}${plan.title}${c.reset} ${c.dim}(${plan.short_id})${c.reset}`);
    console.log(`  ${bar} ${pct}%\n`);
    console.log(`  ${c.green}${done.length}${c.reset} done  ${c.yellow}${inProgress.length}${c.reset} in-progress  ${c.blue}${ready.length}${c.reset} ready  ${c.dim}${blocked.length}${c.reset} blocked  ${c.dim}${dropped.length}${c.reset} dropped`);

    if (withConcerns.length || needsContext.length || execBlocked.length) {
      console.log(`\n  ${c.yellow}${withConcerns.length}${c.reset} with concerns  ${c.red}${execBlocked.length}${c.reset} exec-blocked  ${c.magenta || c.dim}${needsContext.length}${c.reset} needs context`);
    }

    const totalRetries = tasks.reduce((s: number, t: any) => s + (t.retry_count || 0), 0);
    const exceededMax = tasks.filter((t: any) => t.retry_count > 0 && t.max_retries > 0 && t.retry_count >= t.max_retries);
    if (totalRetries > 0 || exceededMax.length > 0) {
      console.log(`\n  ${c.dim}Retries:${c.reset} ${totalRetries} total${exceededMax.length > 0 ? `  ${c.red}${exceededMax.length}${c.reset} exceeded max` : ""}`);
      for (const t of exceededMax) {
        console.log(`  ${c.red}!${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title} ${c.dim}(${t.retry_count}/${t.max_retries} retries)${c.reset}`);
      }
    }

    if (totalMins > 0) {
      const hrs = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      console.log(`\n  ${c.dim}Time spent:${c.reset} ${hrs > 0 ? `${hrs}h ` : ""}${mins}m`);
    }
    if (estRemaining > 0) {
      const hrs = Math.floor(estRemaining / 60);
      const mins = estRemaining % 60;
      console.log(`  ${c.dim}Est remaining:${c.reset} ${hrs > 0 ? `${hrs}h ` : ""}${mins}m`);
    }

    // Check for active tmux agent sessions
    const agentListScript = path.join(os.homedir(), ".claude", "scripts", "agent-list.sh");
    try {
      const sr = spawnSync(agentListScript, [], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      if (sr.status === 0 && sr.stdout?.trim()) {
        const agents = sr.stdout.trim().split("\n").filter((l: string) => l.includes("impl-ct-"));
        if (agents.length > 0) {
          console.log(`\n  ${c.bold}Active agents:${c.reset}`);
          for (const a of agents) {
            const match = a.match(/impl-(ct-\w+)/);
            if (match) {
              const taskId = match[1];
              const task = tasks.find((t: any) => t.short_id === taskId);
              console.log(`  ${c.green}*${c.reset} ${c.cyan}${taskId}${c.reset} ${task ? task.title : ""}`);
            }
          }
        }
      }
    } catch {}

    if (withConcerns.length > 0) {
      console.log(`\n  ${c.bold}Concerns:${c.reset}`);
      for (const t of withConcerns) {
        console.log(`  ${c.yellow}!${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title}`);
        if (t.execution_concerns) console.log(`    ${c.dim}${t.execution_concerns.slice(0, 100)}${c.reset}`);
      }
    }

    const progressLog = plan.progress_log || [];
    const lastOrch = [...progressLog].reverse().find((e: any) => /orchestrat/i.test(e.entry));
    if (lastOrch) {
      const ts = new Date(lastOrch.timestamp).toLocaleString();
      console.log(`\n  ${c.dim}Last orchestrated:${c.reset} ${ts}`);
    }

    console.log();
  });

plan
  .command("retry")
  .description("Reset stuck tasks (needs_context/blocked) back to open")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const stuck = tasks.filter((t: any) =>
      t.execution_status === "needs_context" || t.execution_status === "blocked"
    );

    if (stuck.length === 0) {
      console.log(fmt.muted("No stuck tasks to retry."));
      return;
    }

    let resetCount = 0;
    for (const t of stuck) {
      try {
        await cliPost("/cli/work/update", {
          short_id: t.short_id,
          status: "open",
          execution_status: "",
          attempt_count: 0,
        });
        console.log(`  ${c.green}reset${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title} ${c.dim}(was ${t.execution_status})${c.reset}`);
        resetCount++;
      } catch (e: any) {
        console.error(`  ${c.red}fail${c.reset}  ${t.short_id}: ${e.message || e}`);
      }
    }

    console.log(`\n${c.green}ok${c.reset} Reset ${resetCount}/${stuck.length} tasks in plan ${c.cyan}${planId}${c.reset}`);
    try {
      await cliPost("/cli/plans/log", { short_id: planId, entry: `Retried ${resetCount} stuck tasks` });
    } catch {}
  });

plan
  .command("wave")
  .description("Show current wave tasks and next wave preview")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const resolvedIds = new Set(
      tasks.filter((t: any) => t.status === "done" || t.status === "dropped")
        .flatMap((t: any) => [t._id, t.short_id])
    );
    const open = tasks.filter((t: any) => t.status === "open" || t.status === "backlog");
    const inProgress = tasks.filter((t: any) => t.status === "in_progress");

    const ready = open.filter((t: any) => {
      if (!t.blocked_by || t.blocked_by.length === 0) return true;
      return t.blocked_by.every((d: string) => resolvedIds.has(d));
    });
    const blocked = open.filter((t: any) =>
      t.blocked_by?.length > 0 && !t.blocked_by.every((d: string) => resolvedIds.has(d))
    );

    console.log(`\n  ${c.bold}${plan.title}${c.reset} ${c.dim}(${planId})${c.reset}\n`);

    if (inProgress.length > 0) {
      console.log(`  ${c.yellow}${c.bold}Current wave${c.reset} (${inProgress.length} in progress):`);
      for (const t of inProgress) {
        console.log(`  ${c.yellow}*${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title}`);
      }
      console.log();
    }

    console.log(`  ${c.blue}${c.bold}Next wave${c.reset} (${ready.length} ready):`);
    for (const t of ready.slice(0, 20)) {
      const pri = t.priority === "urgent" ? c.red + "!" : t.priority === "high" ? c.yellow + "^" : c.dim + " ";
      console.log(`  ${pri}${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title}`);
    }
    if (ready.length > 20) console.log(fmt.muted(`  ... and ${ready.length - 20} more`));

    if (blocked.length > 0) {
      console.log(`\n  ${c.dim}Blocked${c.reset} (${blocked.length}):`);
      for (const t of blocked.slice(0, 10)) {
        const deps = (t.blocked_by || []).join(", ");
        console.log(`  ${c.dim}x${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title} ${c.dim}(waiting: ${deps})${c.reset}`);
      }
      if (blocked.length > 10) console.log(fmt.muted(`  ... and ${blocked.length - 10} more`));
    }
    console.log();
  });

plan
  .command("progress")
  .description("Detailed progress report with ETA")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const done = tasks.filter((t: any) => t.status === "done");
    const total = tasks.length;
    const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;
    const barWidth = 40;
    const filled = Math.round(barWidth * pct / 100);
    const bar = `${c.green}${"█".repeat(filled)}${c.dim}${"░".repeat(barWidth - filled)}${c.reset}`;

    console.log(`\n  ${c.bold}${plan.title}${c.reset}`);
    console.log(`  ${bar} ${pct}% (${done.length}/${total})\n`);

    const byType: Record<string, number> = {};
    for (const t of tasks) { byType[t.task_type || "task"] = (byType[t.task_type || "task"] || 0) + 1; }
    const doneByType: Record<string, number> = {};
    for (const t of done) { doneByType[t.task_type || "task"] = (doneByType[t.task_type || "task"] || 0) + 1; }
    for (const [type, count] of Object.entries(byType)) {
      const doneCount = doneByType[type] || 0;
      console.log(`  ${c.dim}${type}:${c.reset} ${doneCount}/${count}`);
    }

    const totalMins = done.reduce((s: number, t: any) => s + (t.actual_minutes || 0), 0);
    const avgMins = done.length > 0 ? Math.round(totalMins / done.length) : 10;
    const remaining = total - done.length;
    const estMins = remaining * avgMins;
    const estHrs = Math.floor(estMins / 60);

    console.log(`\n  ${c.dim}Avg task time:${c.reset} ${avgMins}m`);
    console.log(`  ${c.dim}Remaining:${c.reset} ${remaining} tasks`);
    console.log(`  ${c.dim}Est time:${c.reset} ${estHrs > 0 ? `${estHrs}h ` : ""}${estMins % 60}m`);

    const progressLog = plan.progress_log || [];
    if (progressLog.length > 0) {
      console.log(`\n  ${c.bold}Recent activity:${c.reset}`);
      for (const e of progressLog.slice(-10)) {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        console.log(`  ${c.dim}${ts}${c.reset} ${e.entry}`);
      }
    }
    console.log();
  });

plan
  .command("agents")
  .description("List active agents and their current tasks")
  .argument("<plan_id>", "Plan short ID")
  .action(async (planId: string) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const agentStatusScript = path.join(os.homedir(), ".claude", "scripts", "agent-status.sh");
    const agentListScript = path.join(os.homedir(), ".claude", "scripts", "agent-list.sh");

    let tmuxSessions: string[] = [];
    try {
      const sr = spawnSync(agentListScript, [], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      if (sr.status === 0 && sr.stdout?.trim()) {
        tmuxSessions = sr.stdout.trim().split("\n");
      }
    } catch {}

    const agentSessions = tmuxSessions.filter((s: string) => s.includes("impl-ct-"));
    console.log(`\n  ${c.bold}${plan.title}${c.reset} ${c.dim}(${planId})${c.reset}\n`);

    if (agentSessions.length === 0) {
      console.log(fmt.muted("  No active agents."));
      const inProg = tasks.filter((t: any) => t.status === "in_progress");
      if (inProg.length > 0) {
        console.log(`\n  ${c.yellow}${inProg.length} tasks still in_progress (agents may have exited):${c.reset}`);
        for (const t of inProg) {
          console.log(`  ${c.yellow}!${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title}`);
        }
      }
    } else {
      console.log(`  ${c.green}${agentSessions.length}${c.reset} active agents:\n`);
      for (const session of agentSessions) {
        const match = session.match(/impl-(ct-\w+)/);
        if (!match) continue;
        const taskId = match[1];
        const task = tasks.find((t: any) => t.short_id === taskId);
        const sessionName = `impl-${taskId}`;

        let status = "working";
        try {
          const sr = spawnSync(agentStatusScript, [sessionName], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
          const out = (sr.stdout || "").trim();
          if (out.includes("DONE")) status = "done";
          else if (out.includes("BLOCKED")) status = "blocked";
          else if (out.includes("NEEDS_CONTEXT")) status = "needs_context";
        } catch {}

        const statusColor = status === "done" ? c.green : status === "blocked" ? c.red : status === "needs_context" ? c.yellow : c.blue;
        console.log(`  ${statusColor}${status}${c.reset} ${c.cyan}${taskId}${c.reset} ${task?.title || ""}`);
        console.log(fmt.muted(`    tmux attach -t ${sessionName}`));
      }
    }
    console.log();
  });

plan
  .command("kill")
  .description("Kill all agents working on a plan")
  .argument("<plan_id>", "Plan short ID")
  .option("--reset", "Also reset task status to open")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const inProgress = tasks.filter((t: any) => t.status === "in_progress");
    let killed = 0;

    const killRuntime = getAgentRuntime();
    for (const t of inProgress) {
      const sessionName = `impl-${t.short_id}`;
      const handle = activeHandles.get(sessionName);
      const isAlive = handle ? killRuntime.isAlive(handle) : spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: ["pipe", "pipe", "pipe"] }).status === 0;
      if (isAlive) {
        if (handle) killRuntime.kill(handle);
        else spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: ["pipe", "pipe", "pipe"] });
        activeHandles.delete(sessionName);
        console.log(`  ${c.red}killed${c.reset} ${c.cyan}${t.short_id}${c.reset} ${t.title}`);
        killed++;
      }
      if (options.reset) {
        try {
          await cliPost("/cli/work/update", { short_id: t.short_id, status: "open" });
          console.log(`  ${c.green}reset${c.reset} ${c.cyan}${t.short_id}${c.reset} -> open`);
        } catch {}
      }
    }

    console.log(`\n${c.green}ok${c.reset} Killed ${killed} agents${options.reset ? `, reset ${inProgress.length} tasks` : ""}`);
    try {
      await cliPost("/cli/plans/log", { short_id: planId, entry: `Killed ${killed} agents${options.reset ? ", reset tasks to open" : ""}` });
    } catch {}
  });

plan
  .command("merge")
  .description("Manually merge all completed task branches")
  .argument("<plan_id>", "Plan short ID")
  .option("--dry-run", "Show what would be merged")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const done = tasks.filter((t: any) => t.status === "done");
    const cwd = getRealCwd();
    let merged = 0, conflicts = 0;

    console.log(`\n  ${c.bold}${plan.title}${c.reset} - merging ${done.length} completed task branches\n`);

    for (const t of done) {
      const branch = `ashot/${t.short_id}`;
      const check = spawnSync("git", ["rev-parse", "--verify", branch], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd });
      if (check.status !== 0) continue;

      if (options.dryRun) {
        console.log(`  ${c.dim}merge${c.reset} ${c.cyan}${branch}${c.reset}`);
        merged++;
        continue;
      }

      const result = spawnSync("git", ["merge", branch, "--no-edit"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd });
      if (result.status === 0) {
        console.log(`  ${c.green}merged${c.reset} ${c.cyan}${branch}${c.reset}`);
        merged++;
      } else {
        console.log(`  ${c.red}conflict${c.reset} ${c.cyan}${branch}${c.reset}`);
        spawnSync("git", ["merge", "--abort"], { stdio: ["pipe", "pipe", "pipe"], cwd });
        conflicts++;
      }
    }

    if (options.dryRun) {
      console.log(fmt.muted(`\n  --dry-run: ${merged} branches would be merged`));
    } else {
      console.log(`\n${c.green}ok${c.reset} Merged ${merged} branches${conflicts > 0 ? `, ${conflicts} conflicts` : ""}`);
    }
  });

plan
  .command("verify")
  .description("Run verification checks on completed tasks")
  .argument("<plan_id>", "Plan short ID")
  .option("--typecheck", "Run TypeScript type checking")
  .option("--test", "Run test suite")
  .option("--lint", "Run linter")
  .option("--all", "Run all verification checks")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const cwd = getRealCwd();
    const checks: { name: string; cmd: string; args: string[] }[] = [];

    if (options.all || options.typecheck) {
      checks.push({ name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] });
    }
    if (options.all || options.test) {
      checks.push({ name: "test", cmd: "npm", args: ["test", "--if-present"] });
    }
    if (options.all || options.lint) {
      checks.push({ name: "lint", cmd: "npx", args: ["eslint", ".", "--max-warnings=0"] });
    }

    if (checks.length === 0) {
      checks.push({ name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] });
    }

    console.log(`\n  ${c.bold}Verifying plan ${planId}${c.reset}\n`);

    let passed = 0, failed = 0;
    for (const check of checks) {
      process.stdout.write(`  ${c.dim}${check.name}...${c.reset} `);
      const result = spawnSync(check.cmd, check.args, {
        encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd, timeout: 120_000,
      });
      if (result.status === 0) {
        console.log(`${c.green}pass${c.reset}`);
        passed++;
      } else {
        console.log(`${c.red}fail${c.reset}`);
        const output = (result.stderr || result.stdout || "").trim();
        if (output) console.log(fmt.muted(`    ${output.split("\n").slice(0, 5).join("\n    ")}`));
        failed++;
      }
    }

    console.log(`\n  ${passed} passed, ${failed} failed`);
    try {
      await cliPost("/cli/plans/log", {
        short_id: planId,
        entry: `Verification: ${passed} passed, ${failed} failed (${checks.map((ch: any) => ch.name).join(", ")})`,
      });
    } catch {}
  });

plan
  .command("drive")
  .description("Iterative polish loop: critic -> fix -> validate rounds")
  .argument("<plan_id>", "Plan short ID")
  .option("--rounds <n>", "Number of drive rounds", "3")
  .option("--scope <path>", "Focus area (directory or file pattern)")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const totalRounds = parseInt(options.rounds, 10) || 3;
    const cwd = getRealCwd();
    const driveRuntime = getAgentRuntime();

    console.log(`\n  ${c.bold}Drive${c.reset} for ${c.cyan}${planId}${c.reset} - ${totalRounds} rounds\n`);

    for (let round = 1; round <= totalRounds; round++) {
      console.log(`  ${c.bold}Round ${round}/${totalRounds}${c.reset}`);

      try {
        await cliPost("/cli/plans/drive-state", { short_id: planId, current_round: round, total_rounds: totalRounds });
      } catch {}

      console.log(`  ${c.dim}critic...${c.reset}`);
      const criticSession = `critic-${planId}-r${round}`;
      const scope = options.scope || cwd;
      const criticPrompt = buildCriticPrompt(plan, scope, round);

      let criticHandle: AgentHandle;
      try {
        criticHandle = driveRuntime.spawn({
          sessionName: criticSession,
          prompt: criticPrompt,
          model: "sonnet",
          workingDir: cwd,
          taskShortId: `critic-r${round}`,
        });
      } catch {
        console.log(`  ${c.yellow}critic skipped${c.reset} (spawn failed)`);
        continue;
      }

      let criticDone = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        if (!driveRuntime.isAlive(criticHandle)) { criticDone = true; break; }
      }

      if (!criticDone) {
        console.log(`  ${c.yellow}critic timed out${c.reset}`);
        driveRuntime.kill(criticHandle);
      }

      // Record findings (agent should have output to task system)
      try {
        await cliPost("/cli/plans/drive-findings", {
          short_id: planId, round, findings: [`Round ${round} critic pass completed`], fixed: [], deferred: [],
        });
      } catch {}

      console.log(`  ${c.green}round ${round} complete${c.reset}`);
    }

    console.log(`\n  ${c.green}Drive complete${c.reset} - ${totalRounds} rounds finished`);
    try {
      await cliPost("/cli/plans/log", { short_id: planId, entry: `Drive completed: ${totalRounds} rounds` });
    } catch {}
  });

plan
  .command("retro")
  .description("Generate a typed retrospective for a completed plan")
  .argument("<plan_id>", "Plan short ID")
  .option("--from-progress", "Feed progress.jsonl events into the retro")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    let progressLog = plan.progress_log;

    if (options.fromProgress) {
      try {
        const progressFile = path.join(getRealCwd(), ".codecast", `progress-${planId}.jsonl`);
        if (fs.existsSync(progressFile)) {
          const lines = fs.readFileSync(progressFile, "utf-8").trim().split("\n").filter(Boolean);
          const events = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          progressLog = events.map((e: any) => ({ timestamp: e.timestamp, entry: `${e.event_type}${e.detail ? `: ${e.detail}` : ""}` }));
        }
      } catch {}
    }

    const prompt = buildRetroPrompt(plan, tasks, progressLog);

    console.log(`\n  ${c.bold}Generating typed retro${c.reset} for ${c.cyan}${planId}${c.reset}...\n`);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY || "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        console.error(`  API error: ${response.status}`);
        process.exit(1);
      }

      const data = await response.json() as any;
      const raw = data.content?.[0]?.text?.trim();
      if (!raw) { console.error("  Empty response"); process.exit(1); }

      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      const retro = JSON.parse(cleaned);

      const smoothnessIndicator: Record<string, string> = {
        effortless: "++", smooth: "+", bumpy: "~", struggled: "-", failed: "--",
      };

      console.log(`  ${c.bold}Smoothness:${c.reset} ${retro.smoothness} ${smoothnessIndicator[retro.smoothness] || ""}`);
      console.log(`  ${c.bold}Summary:${c.reset} ${retro.headline}\n`);

      if (retro.learnings?.length) {
        console.log(`  ${c.bold}Learnings:${c.reset}`);
        for (const l of retro.learnings) {
          const cat = typeof l === "string" ? "" : ` ${c.dim}[${l.category}]${c.reset}`;
          const text = typeof l === "string" ? l : l.text;
          console.log(`    - ${text}${cat}`);
        }
        console.log();
      }

      if (retro.friction_points?.length) {
        console.log(`  ${c.bold}Friction:${c.reset}`);
        for (const f of retro.friction_points) {
          const kind = typeof f === "string" ? "" : ` ${c.dim}[${f.kind}/${f.severity}]${c.reset}`;
          const text = typeof f === "string" ? f : f.text;
          console.log(`    - ${text}${kind}`);
        }
        console.log();
      }

      if (retro.open_items?.length) {
        console.log(`  ${c.bold}Open items:${c.reset}`);
        for (const o of retro.open_items) {
          const kind = typeof o === "string" ? "" : ` ${c.dim}[${o.kind}/${o.priority}]${c.reset}`;
          const text = typeof o === "string" ? o : o.text;
          console.log(`    - ${text}${kind}`);
        }
        console.log();
      }

      try {
        await cliPost("/cli/plans/save-retro", {
          short_id: planId,
          ...retro,
        });
        console.log(fmt.muted("  Retro saved to plan."));
      } catch {
        console.log(fmt.muted("  (Could not save retro to backend)"));
      }

      await emitOrchEvent(planId, "retro_generated", undefined, retro.headline, { smoothness: retro.smoothness });

      try {
        await cliPost("/cli/plans/log", {
          short_id: planId,
          entry: `Retro generated: ${retro.smoothness} - ${retro.headline}`,
        });
      } catch {}
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
  });

plan
  .command("eval")
  .description("Evaluate a plan's execution metrics with detailed grading")
  .argument("<plan_id>", "Plan short ID")
  .option("--compare <plan_ids>", "Compare against other plan evaluations (comma-separated)")
  .option("--json", "Output as JSON")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const tasks = plan.tasks || [];
    const done = tasks.filter((t: any) => t.status === "done");
    const dropped = tasks.filter((t: any) => t.status === "dropped");
    const blocked = tasks.filter((t: any) => t.execution_status === "blocked");
    const needsCtx = tasks.filter((t: any) => t.execution_status === "needs_context");
    const withConcerns = tasks.filter((t: any) => t.execution_status === "done_with_concerns");

    const totalRetries = tasks.reduce((sum: number, t: any) => sum + (t.retry_count || 0), 0);
    const totalAttempts = tasks.reduce((sum: number, t: any) => sum + (t.attempt_count || 0), 0);
    const totalTime = tasks.reduce((sum: number, t: any) => sum + (t.actual_minutes || 0), 0);

    const waves = tasks.reduce((max: number, t: any) => Math.max(max, t.wave_number || 0), 0);
    const actionable = tasks.length - dropped.length;

    const completionRate = actionable > 0 ? ((done.length / actionable) * 100) : 0;
    const retryRate = totalAttempts > 0 ? ((totalRetries / totalAttempts) * 100) : 0;

    const driveRounds = plan.drive_state?.rounds?.length || 0;
    const totalFindings = plan.drive_state?.rounds?.reduce(
      (sum: number, r: any) => sum + (r.findings?.length || 0), 0
    ) || 0;
    const totalFixed = plan.drive_state?.rounds?.reduce(
      (sum: number, r: any) => sum + (r.fixed?.length || 0), 0
    ) || 0;

    // Progress event stats
    let eventStats: Record<string, number> = {};
    let mergeConflictRate = 0;
    try {
      const progressFile = path.join(getRealCwd(), ".codecast", `progress-${planId}.jsonl`);
      if (fs.existsSync(progressFile)) {
        const lines = fs.readFileSync(progressFile, "utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            eventStats[e.event_type] = (eventStats[e.event_type] || 0) + 1;
          } catch {}
        }
        const mergeAttempts = (eventStats["merge_succeeded"] || 0) + (eventStats["merge_failed"] || 0);
        mergeConflictRate = mergeAttempts > 0 ? ((eventStats["merge_failed"] || 0) / mergeAttempts) * 100 : 0;
      }
    } catch {}

    // Detailed scoring rubric
    const completionScore = (done.length / Math.max(1, actionable)) * 30;
    const reliabilityScore = (1 - Math.min(1, totalRetries / Math.max(1, tasks.length))) * 20;
    const blockerScore = blocked.length === 0 && needsCtx.length === 0 ? 15 : Math.max(0, 15 - (blocked.length + needsCtx.length) * 3);
    const concernScore = withConcerns.length === 0 ? 10 : Math.max(0, 10 - withConcerns.length * 2);
    const mergeScore = mergeConflictRate === 0 ? 10 : Math.max(0, 10 - mergeConflictRate / 10);
    const retroScore = plan.retro ? 5 : 0;
    const driveScore = driveRounds > 0 ? Math.min(5, driveRounds * 2) : 0;
    const verificationScore = tasks.some((t: any) => t.verify_with) ? 5 : 0;

    const score = Math.round(completionScore + reliabilityScore + blockerScore + concernScore + mergeScore + retroScore + driveScore + verificationScore);

    const evalResult = {
      plan_id: planId,
      title: plan.title,
      score,
      breakdown: {
        completion: { score: Math.round(completionScore), max: 30, rate: completionRate.toFixed(1) + "%" },
        reliability: { score: Math.round(reliabilityScore), max: 20, retry_rate: retryRate.toFixed(1) + "%" },
        blockers: { score: Math.round(blockerScore), max: 15, count: blocked.length + needsCtx.length },
        concerns: { score: Math.round(concernScore), max: 10, count: withConcerns.length },
        merge: { score: Math.round(mergeScore), max: 10, conflict_rate: mergeConflictRate.toFixed(1) + "%" },
        retro: { score: retroScore, max: 5, has_retro: !!plan.retro },
        drive: { score: driveScore, max: 5, rounds: driveRounds },
        verification: { score: verificationScore, max: 5, has_gates: tasks.some((t: any) => t.verify_with) },
      },
      stats: { tasks: tasks.length, done: done.length, dropped: dropped.length, blocked: blocked.length, retries: totalRetries, waves, time_minutes: totalTime },
      event_counts: eventStats,
    };

    if (options.json) {
      console.log(JSON.stringify(evalResult, null, 2));
      return;
    }

    console.log(`\n  ${c.bold}Plan Evaluation: ${plan.title}${c.reset} ${c.dim}(${planId})${c.reset}\n`);
    console.log(`  ${c.bold}Completion${c.reset}`);
    console.log(`    Tasks:         ${done.length}/${tasks.length} done (${completionRate.toFixed(1)}%)`);
    console.log(`    Dropped:       ${dropped.length}`);
    console.log(`    Blocked:       ${blocked.length}`);
    console.log(`    Needs context: ${needsCtx.length}`);
    console.log(`    With concerns: ${withConcerns.length}`);

    console.log(`\n  ${c.bold}Reliability${c.reset}`);
    console.log(`    Retry rate:    ${retryRate.toFixed(1)}% (${totalRetries} retries / ${totalAttempts || tasks.length} attempts)`);
    console.log(`    Merge conflicts: ${mergeConflictRate.toFixed(1)}%`);
    console.log(`    Waves:         ${waves || "N/A"}`);
    console.log(`    Time:          ${totalTime ? `${totalTime}m` : "not tracked"}`);

    if (driveRounds > 0) {
      console.log(`\n  ${c.bold}Drive${c.reset}`);
      console.log(`    Rounds:        ${driveRounds}`);
      console.log(`    Findings:      ${totalFindings}`);
      console.log(`    Fixed:         ${totalFixed}`);
    }

    if (plan.retro) {
      console.log(`\n  ${c.bold}Retro${c.reset}`);
      console.log(`    Smoothness:    ${plan.retro.smoothness}`);
      console.log(`    Headline:      ${plan.retro.headline}`);
    }

    if (Object.keys(eventStats).length > 0) {
      console.log(`\n  ${c.bold}Event Summary${c.reset}`);
      for (const [type, count] of Object.entries(eventStats).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        console.log(`    ${type}: ${count}`);
      }
    }

    console.log(`\n  ${c.bold}Score Breakdown${c.reset}`);
    for (const [name, b] of Object.entries(evalResult.breakdown)) {
      const { score: s, max } = b as any;
      const bar = `${c.green}${"█".repeat(Math.round(s / max * 10))}${c.dim}${"░".repeat(10 - Math.round(s / max * 10))}${c.reset}`;
      console.log(`    ${name.padEnd(14)} ${bar} ${s}/${max}`);
    }

    console.log(`\n  ${c.bold}Score: ${score}/100${c.reset}`);

    // Compare with other plans
    if (options.compare) {
      const compareIds = options.compare.split(",").map((s: string) => s.trim());
      console.log(`\n  ${c.bold}Comparison${c.reset}`);
      for (const cid of compareIds) {
        try {
          const cplan = await cliPost("/cli/plans/get", { short_id: cid });
          if (cplan) {
            const ctasks = cplan.tasks || [];
            const cdone = ctasks.filter((t: any) => t.status === "done").length;
            const cdropped = ctasks.filter((t: any) => t.status === "dropped").length;
            const cactionable = ctasks.length - cdropped;
            const crate = cactionable > 0 ? ((cdone / cactionable) * 100).toFixed(1) : "0";
            console.log(`    ${c.cyan}${cid}${c.reset} ${cplan.title}: ${cdone}/${ctasks.length} (${crate}%)`);
          }
        } catch {}
      }
    }

    console.log();

    try {
      await cliPost("/cli/plans/log", {
        short_id: planId,
        entry: `Eval: ${score}/100 (${completionRate}% completion, ${retryRate}% retry, ${blocked.length} blocked)`,
      });
    } catch {}
  });

plan
  .command("replay")
  .description("Replay progress events for a plan (from local .jsonl or Convex)")
  .argument("<plan_id>", "Plan short ID")
  .option("--local", "Read from local .codecast/progress-<id>.jsonl")
  .option("--from <n>", "Start from sequence number")
  .option("--follow", "Follow mode: watch for new events")
  .option("--json", "Output raw JSON")
  .action(async (planId: string, options: any) => {
    if (options.local) {
      const progressFile = path.join(getRealCwd(), ".codecast", `progress-${planId}.jsonl`);
      if (!fs.existsSync(progressFile)) {
        console.error(`No local progress file: ${progressFile}`);
        process.exit(1);
      }
      const lines = fs.readFileSync(progressFile, "utf-8").trim().split("\n").filter(Boolean);
      const from = options.from ? parseInt(options.from, 10) : 0;

      console.log(`\n  ${c.bold}Replay${c.reset} ${c.cyan}${planId}${c.reset} (local, ${lines.length} events)\n`);

      for (let i = from; i < lines.length; i++) {
        try {
          const event = JSON.parse(lines[i]);
          if (options.json) {
            console.log(JSON.stringify(event));
          } else {
            const ts = new Date(event.timestamp).toLocaleTimeString();
            const task = event.task_short_id ? ` ${c.cyan}${event.task_short_id}${c.reset}` : "";
            const detail = event.detail ? ` ${event.detail}` : "";
            console.log(`  ${c.dim}${ts}${c.reset} ${eventTypeColor(event.event_type)}${event.event_type}${c.reset}${task}${detail}`);
          }
        } catch {}
      }

      if (options.follow) {
        console.log(fmt.muted("\n  Following..."));
        let lastSize = lines.length;
        const check = () => {
          try {
            const newLines = fs.readFileSync(progressFile, "utf-8").trim().split("\n").filter(Boolean);
            for (let i = lastSize; i < newLines.length; i++) {
              const event = JSON.parse(newLines[i]);
              const ts = new Date(event.timestamp).toLocaleTimeString();
              const task = event.task_short_id ? ` ${c.cyan}${event.task_short_id}${c.reset}` : "";
              console.log(`  ${c.dim}${ts}${c.reset} ${eventTypeColor(event.event_type)}${event.event_type}${c.reset}${task}`);
            }
            lastSize = newLines.length;
          } catch {}
        };
        setInterval(check, 2000);
        process.on("SIGINT", () => process.exit(0));
        await new Promise(() => {});
      }
    } else {
      try {
        const events = await cliPost("/cli/progress/replay", {
          plan_short_id: planId,
          from_sequence: options.from ? parseInt(options.from, 10) : undefined,
        });
        if (!events?.length) {
          console.log(fmt.muted("No progress events found."));
          return;
        }

        console.log(`\n  ${c.bold}Replay${c.reset} ${c.cyan}${planId}${c.reset} (${events.length} events)\n`);

        for (const event of events) {
          if (options.json) {
            console.log(JSON.stringify(event));
          } else {
            const ts = new Date(event.created_at).toLocaleTimeString();
            const task = event.task_short_id ? ` ${c.cyan}${event.task_short_id}${c.reset}` : "";
            const detail = event.detail ? ` ${event.detail}` : "";
            console.log(`  ${c.dim}#${event.sequence} ${ts}${c.reset} ${eventTypeColor(event.event_type)}${event.event_type}${c.reset}${task}${detail}`);
          }
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    }
    console.log();
  });

plan
  .command("export")
  .description("Export a plan to markdown")
  .argument("<plan_id>", "Plan short ID")
  .option("-o, --output <file>", "Output file (default: stdout)")
  .action(async (planId: string, options: any) => {
    const plan = await cliPost("/cli/plans/get", { short_id: planId });
    if (!plan) { console.error("Plan not found"); process.exit(1); }

    const lines: string[] = [];
    lines.push(`# Plan: ${plan.title}`);
    lines.push(`**Goal:** ${plan.goal || "N/A"}`);
    lines.push(`**Status:** ${plan.status}`);
    if (plan.acceptance_criteria?.length) {
      lines.push("");
      lines.push("## Acceptance Criteria");
      for (const ac of plan.acceptance_criteria) {
        lines.push(`- ${ac}`);
      }
    }
    if (plan.tasks?.length) {
      lines.push("");
      lines.push("## Tasks");
      for (const t of plan.tasks) {
        const done = t.status === "done";
        const check = done ? "x" : " ";
        let suffix = `(${t.status})`;
        if (t.priority) suffix = `(${t.status}, ${t.priority})`;
        const deps = t.blocked_by?.length ? ` [blocked by: ${t.blocked_by.join(", ")}]` : "";
        lines.push(`- [${check}] ${t.short_id}: ${t.title} ${suffix}${deps}`);
      }
    }
    lines.push("");

    const md = lines.join("\n");
    if (options.output) {
      fs.writeFileSync(options.output, md, "utf-8");
      console.log(`${c.green}ok${c.reset} Exported plan ${c.cyan}${planId}${c.reset} to ${options.output}`);
    } else {
      process.stdout.write(md);
    }
  });

plan
  .command("import")
  .description("Import a plan from a YAML file")
  .argument("<file>", "YAML file path")
  .option("--project <id>", "Project ID")
  .action(async (file: string, options: any) => {
    const filePath = path.resolve(getRealCwd(), file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, "utf-8");

    // Simple YAML parser for the expected structure
    let title = "";
    let goal = "";
    const tasks: { title: string; priority?: string; blocked_by?: string[] }[] = [];
    let inTasks = false;
    let currentTask: { title: string; priority?: string; blocked_by?: string[] } | null = null;

    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!inTasks) {
        if (line.startsWith("title:")) title = line.slice(6).trim().replace(/^["']|["']$/g, "");
        else if (line.startsWith("goal:")) goal = line.slice(5).trim().replace(/^["']|["']$/g, "");
        else if (line === "tasks:" || line.startsWith("tasks:")) inTasks = true;
      } else {
        if (line.startsWith("- title:")) {
          if (currentTask) tasks.push(currentTask);
          currentTask = { title: line.slice(8).trim().replace(/^["']|["']$/g, "") };
        } else if (line.startsWith("title:") && currentTask) {
          currentTask.title = line.slice(6).trim().replace(/^["']|["']$/g, "");
        } else if (line.startsWith("priority:") && currentTask) {
          currentTask.priority = line.slice(9).trim().replace(/^["']|["']$/g, "");
        } else if (line.startsWith("blocked_by:") && currentTask) {
          const val = line.slice(11).trim();
          const match = val.match(/^\[(.+)\]$/);
          if (match) {
            currentTask.blocked_by = match[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
          }
        } else if (line.startsWith("- ") && !line.startsWith("- title:") && currentTask && line.match(/^- ["']?.+["']?$/)) {
          if (!currentTask.blocked_by) currentTask.blocked_by = [];
          currentTask.blocked_by.push(line.slice(2).trim().replace(/^["']|["']$/g, ""));
        }
      }
    }
    if (currentTask) tasks.push(currentTask);

    if (!title) {
      console.error("No title found in file");
      process.exit(1);
    }

    const planBody: Record<string, any> = { title, source: "imported", project_path: getRealCwd() };
    if (goal) planBody.goal = goal;
    if (options.project) planBody.project_id = options.project;

    const planResult = await cliPost("/cli/plans/create", planBody);
    console.log(`${c.green}ok${c.reset} Created plan ${c.cyan}${planResult.short_id}${c.reset}: ${title}`);

    const titleToShortId: Record<string, string> = {};
    for (const t of tasks) {
      const taskBody: Record<string, any> = {
        title: t.title,
        task_type: "task",
        status: "open",
        priority: t.priority || "medium",
        plan_id: planResult.short_id,
        project_path: getRealCwd(),
      };
      if (t.blocked_by?.length) {
        const resolvedDeps = t.blocked_by.map(dep => titleToShortId[dep] || dep).filter(Boolean);
        if (resolvedDeps.length) taskBody.blocked_by = resolvedDeps;
      }
      const taskResult = await cliPost("/cli/work/create", taskBody);
      titleToShortId[t.title] = taskResult.short_id;
      console.log(`  ${c.green}+${c.reset} ${c.cyan}${taskResult.short_id}${c.reset}: ${t.title}`);
    }

    console.log(fmt.muted(`\n  ${tasks.length} tasks imported`));
  });

// --- Stable Mode ---

const STABLE_FEED_HOOK = `#!/bin/bash
# CodeCast Stable Mode - injects recent session history on SessionStart
set -uo pipefail

CONFIG_FILE="$HOME/.codecast/config.json"
[ -f "$CONFIG_FILE" ] || exit 0

# Ensure codecast is on PATH (hooks run non-interactively)
export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

STABLE_MODE=$(python3 -c "import sys,json; print(json.load(open('$CONFIG_FILE')).get('stable_mode',''))" 2>/dev/null)
[ -z "$STABLE_MODE" ] || [ "$STABLE_MODE" = "null" ] && exit 0

STABLE_GLOBAL=$(python3 -c "import sys,json; print(json.load(open('$CONFIG_FILE')).get('stable_global',False))" 2>/dev/null)

GLOBAL_FLAG=""
if [ "$STABLE_GLOBAL" = "True" ]; then
  GLOBAL_FLAG="-g"
fi

if [ "$STABLE_MODE" = "team" ]; then
  FEED=$(codecast feed $GLOBAL_FLAG -n 15 -s 14d 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g')
else
  FEED=$(codecast feed $GLOBAL_FLAG -n 10 -s 7d 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g')
fi

[ -z "$FEED" ] && exit 0

if [ "$STABLE_MODE" = "team" ]; then
  INSTRUCTION="Review this feed of recent team activity. Start your session with a brief, natural message acknowledging what the team has been working on recently (2-3 sentences max, referencing specific projects or themes you see). Then ask: where do you want to go next?"
else
  INSTRUCTION="Review this feed of your recent activity. Start your session with a brief, natural message acknowledging what you've been working on recently (2-3 sentences max, referencing specific projects or themes you see). Then ask: where do you want to go next?"
fi

cat <<EOF
<stable-context mode="$STABLE_MODE">
$INSTRUCTION

$FEED
</stable-context>
EOF
`;

function installStableHook(): void {
  const home = process.env.HOME || "";
  const hooksDir = path.join(home, ".claude", "hooks");
  const hookFile = path.join(hooksDir, "stable-feed.sh");
  const settingsFile = path.join(home, ".claude", "settings.json");

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookFile, STABLE_FEED_HOOK, { mode: 0o755 });

    let settings: any = {};
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    }
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

    const hookArray = settings.hooks.SessionStart as any[];
    const alreadyPresent = hookArray.some((matcher: any) =>
      (matcher.hooks || []).some((h: any) => h.command?.includes("stable-feed.sh"))
    );

    if (!alreadyPresent) {
      const hookEntry = { type: "command", command: hookFile, timeout: 30 };
      if (hookArray.length > 0 && hookArray[0].matcher === "") {
        hookArray[0].hooks = hookArray[0].hooks || [];
        hookArray[0].hooks.push(hookEntry);
      } else {
        hookArray.unshift({ matcher: "", hooks: [hookEntry] });
      }
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
  } catch {
    // Ignore errors - hook is optional enhancement
  }
}

function removeStableHook(): void {
  const home = process.env.HOME || "";
  const settingsFile = path.join(home, ".claude", "settings.json");

  if (!fs.existsSync(settingsFile)) return;

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  if (!settings.hooks?.SessionStart) return;

  for (const matcher of settings.hooks.SessionStart) {
    if (matcher.hooks) {
      matcher.hooks = matcher.hooks.filter((h: any) => !h.command?.includes("stable-feed.sh"));
    }
  }
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
    (m: any) => m.hooks && m.hooks.length > 0
  );

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
}

program
  .command("stable")
  .description(
    "Enable stable mode — inject recent session history into every new conversation\n\n" +
    "Modes:\n" +
    "  solo   Your recent sessions (last 7 days)\n" +
    "  team   All team activity (last 14 days)\n" +
    "  off    Disable stable mode\n\n" +
    "By default, feeds are scoped to the current project.\n" +
    "Use -g to include sessions from all projects.\n\n" +
    "Examples:\n" +
    "  cast stable solo       # Current project only\n" +
    "  cast stable solo -g    # All projects\n" +
    "  cast stable team -g    # Team, all projects\n" +
    "  cast stable off        # Disable\n" +
    "  cast stable            # Show current status"
  )
  .argument("[mode]", "solo, team, or off")
  .option("-g, --global", "Include sessions from all projects (default: current project only)")
  .action(async (mode, options) => {
    const config = readConfig() || {} as Config;

    if (!mode) {
      const current = (config as any).stable_mode;
      if (current) {
        const isGlobal = (config as any).stable_global === true;
        const scope = isGlobal ? "all projects" : "current project";
        console.log(`${fmt.accent("◉")} Stable mode: ${c.bold}${current}${c.reset} ${fmt.muted(`(${scope})`)}`);
        if (current === "solo") {
          console.log(`  ${fmt.muted("Injects your last 10 sessions (7d) on session start")}`);
        } else {
          console.log(`  ${fmt.muted("Injects team's last 15 sessions (14d) on session start")}`);
        }
      } else {
        console.log(`${fmt.muted("○")} Stable mode: ${fmt.muted("off")}`);
        console.log(`  ${fmt.muted("Run")} ${fmt.cmd("cast stable solo")} ${fmt.muted("or")} ${fmt.cmd("cast stable team")} ${fmt.muted("to enable")}`);
      }
      return;
    }

    if (!["solo", "team", "off"].includes(mode)) {
      console.error(`Unknown mode: ${mode}. Use solo, team, or off.`);
      process.exit(1);
    }

    if (mode === "off") {
      delete (config as any).stable_mode;
      delete (config as any).stable_global;
      writeConfig(config);
      removeStableHook();
      console.log(`${fmt.muted("○")} Stable mode disabled`);
      return;
    }

    const isGlobal = !!options.global;
    (config as any).stable_mode = mode;
    (config as any).stable_global = isGlobal;
    writeConfig(config);
    installStableHook();

    const scope = isGlobal ? "all projects" : "current project";
    console.log(`${fmt.accent("◉")} Stable mode: ${c.bold}${mode}${c.reset} ${fmt.muted(`(${scope})`)}`);
    if (mode === "solo") {
      console.log(`  ${fmt.muted("Each session will start with your recent 10 sessions (7d)")}`);
    } else {
      console.log(`  ${fmt.muted("Each session will start with team's recent 15 sessions (14d)")}`);
    }
    console.log(`  ${fmt.muted("Run")} ${fmt.cmd("cast stable off")} ${fmt.muted("to disable")}`);
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

// ─── Workflow commands ────────────────────────────────────────────────────────

const workflow = program
  .command("workflow")
  .alias("wf")
  .description("Manage and run workflow templates (.cast files)");

workflow
  .command("run <file>")
  .description("Run a workflow file")
  .option("-g, --goal <text>", "Override the workflow goal")
  .option("--dry-run", "Validate and print the workflow without executing")
  .option("--auto-approve", "Skip human gate prompts, auto-select first option")
  .option("--task <short_id>", "Bind workflow to a task (injects task context)")
  .option("--plan <short_id>", "Bind workflow to a plan (injects plan context)")
  .action(async (file: string, options: any) => {
    const { parseWorkflowFile } = await import("./workflow/parser.js");
    const { runWorkflow } = await import("./workflow/runner.js");
    const path = await import("path");
    const fs = await import("fs");

    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const graph = parseWorkflowFile(filePath);

    const { siteUrl, apiToken } = getCliEndpoint();
    const projectPath = process.cwd();

    const runOpts: any = {
      goalOverride: options.goal,
      dryRun: options.dryRun,
      autoApprove: options.autoApprove,
      cwd: projectPath,
      convexSiteUrl: siteUrl,
      apiToken,
    };

    if (options.task) {
      const task = await cliPost("/cli/work/get", { short_id: options.task });
      if (!task) { console.error(`Task not found: ${options.task}`); process.exit(1); }
      runOpts.taskId = task.short_id;
      if (!runOpts.goalOverride) runOpts.goalOverride = task.title;
    }

    if (options.plan) {
      const plan = await cliPost("/cli/plans/get", { short_id: options.plan });
      if (!plan) { console.error(`Plan not found: ${options.plan}`); process.exit(1); }
      runOpts.planId = plan.short_id;
      if (!runOpts.goalOverride) runOpts.goalOverride = plan.goal || plan.title;
    }

    if (!options.dryRun && apiToken) {
      // Push workflow to Convex so the web UI can render it
      const source = fs.readFileSync(filePath, "utf-8");
      const slug = graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const nodes = [...graph.nodes.values()].map((n: any) => ({
        id: n.id, label: n.label, shape: n.shape, type: n.type,
        ...(n.prompt ? { prompt: n.prompt } : {}),
        ...(n.script ? { script: n.script } : {}),
        ...(n.model ? { model: n.model } : {}),
        ...(n.backend ? { backend: n.backend } : {}),
        ...(n.reasoning_effort ? { reasoning_effort: n.reasoning_effort } : {}),
        ...(n.max_visits !== undefined ? { max_visits: n.max_visits } : {}),
        ...(n.max_retries !== undefined ? { max_retries: n.max_retries } : {}),
        ...(n.retry_target ? { retry_target: n.retry_target } : {}),
        ...(n.goal_gate !== undefined ? { goal_gate: n.goal_gate } : {}),
      }));
      const edges = graph.edges.map((e: any) => ({
        from: e.from, to: e.to,
        ...(e.label ? { label: e.label } : {}),
        ...(e.condition ? { condition: e.condition } : {}),
      }));

      try {
        const pushResult = await cliPost("/cli/workflows/upsert", {
          name: graph.name, slug, goal: graph.goal, source,
          nodes, edges, model_stylesheet: graph.model_stylesheet,
        });
        const workflowId = pushResult?.id;

        const createResult = await cliPost("/cli/workflow-runs/create", {
          workflow_name: graph.name,
          workflow_goal: graph.goal,
          workflow_id: workflowId,
          task_id: runOpts.taskId,
          plan_id: runOpts.planId,
          goal_override: runOpts.goalOverride,
          project_path: projectPath,
        });
        if (createResult?.run_id) {
          runOpts.runId = createResult.run_id;
        }
      } catch (err: any) {
        console.error(`Warning: failed to register workflow run: ${err.message}`);
      }
    }

    await runWorkflow(graph, runOpts);
  });

workflow
  .command("run-daemon <run_id>")
  .description("Execute a workflow run from the daemon (internal)")
  .action(async (runId: string) => {
    const config = readConfig();
    if (!config?.auth_token || !config?.convex_url) {
      console.error("Not authenticated. Run: cast login");
      process.exit(1);
    }
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const resp = await fetch(`${siteUrl}/cli/workflow-runs/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token, run_id: runId }),
    });
    const data = await resp.json() as any;
    if (data.error) {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }
    const { run, workflow: wf } = data;
    if (!wf.nodes?.length) {
      console.error("Workflow has no nodes — cannot execute. Was the workflow pushed to Convex?");
      process.exit(1);
    }
    const { runWorkflow } = await import("./workflow/runner.js");
    const nodesMap = new Map<string, any>();
    for (const n of wf.nodes) nodesMap.set(n.id, n);
    const graph = {
      name: wf.name,
      goal: run.goal_override || wf.goal,
      model_stylesheet: wf.model_stylesheet,
      nodes: nodesMap,
      edges: wf.edges,
    };
    const projectPath = run.project_path || process.cwd();
    await runWorkflow(graph as any, {
      runId,
      convexSiteUrl: siteUrl,
      apiToken: config.auth_token,
      goalOverride: run.goal_override,
      cwd: projectPath,
      taskId: run.task_short_id,
      planId: run.plan_short_id,
    });
  });

workflow
  .command("validate <file>")
  .description("Validate a workflow file without running it")
  .action(async (file: string) => {
    const { parseWorkflowFile, validateWorkflow } = await import("./workflow/parser.js");
    const path = await import("path");
    const fs = await import("fs");

    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const graph = parseWorkflowFile(filePath);
    const errors = validateWorkflow(graph);

    console.log(`Workflow: ${graph.name}`);
    if (graph.goal) console.log(`Goal: ${graph.goal}`);
    console.log(`Nodes: ${graph.nodes.size}, Edges: ${graph.edges.length}`);
    console.log();

    for (const [id, node] of graph.nodes) {
      const shape = node.shape !== "box" ? ` [${node.shape}]` : "";
      console.log(`  ${id}${shape}: ${node.label}`);
    }
    console.log();
    for (const edge of graph.edges) {
      const cond = edge.condition ? ` [if: ${edge.condition}]` : "";
      const label = edge.label ? ` "${edge.label}"` : "";
      console.log(`  ${edge.from} → ${edge.to}${label}${cond}`);
    }

    if (errors.length > 0) {
      console.log();
      for (const err of errors) console.error(`  ✗ ${err}`);
      process.exit(1);
    } else {
      console.log("\n  ✓ Workflow is valid");
    }
  });

workflow
  .command("list")
  .description("List available workflow templates")
  .action(async () => {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const builtinDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "workflows");
    const searchDirs = [
      path.join(process.cwd(), "workflows"),
      path.join(os.homedir(), ".cast", "workflows"),
      builtinDir,
    ];

    let found = false;
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const wfFile = path.join(dir, entry.name, "workflow.cast");
        if (!fs.existsSync(wfFile)) continue;

        try {
          const { parseWorkflowFile } = await import("./workflow/parser.js");
          const graph = parseWorkflowFile(wfFile);
          console.log(`  ${entry.name.padEnd(24)} ${graph.goal || graph.name}`);
          console.log(`  ${" ".repeat(24)} ${wfFile}`);
          found = true;
        } catch {
          console.log(`  ${entry.name} (parse error)`);
          found = true;
        }
      }
    }

    if (!found) console.log("No workflow templates found.\nAdd .cast files under workflows/<name>/workflow.cast");
  });

workflow
  .command("create <name>")
  .description("Create a new workflow template")
  .option("-g, --goal <text>", "Workflow goal")
  .action(async (name: string, options: any) => {
    const fs = await import("fs");
    const path = await import("path");

    const dir = path.join(process.cwd(), "workflows", name);
    const file = path.join(dir, "workflow.cast");

    if (fs.existsSync(file)) {
      console.error(`Workflow already exists: ${file}`);
      process.exit(1);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `digraph ${name.replace(/[^a-zA-Z0-9]/g, "_")} {
    graph [goal="${options.goal || name}"]
    rankdir=LR

    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare,  label="Exit"]

    main [label="Main Task", prompt="Accomplish the goal: ${options.goal || name}"]

    start -> main -> exit
}
`);
    console.log(`Created: ${file}`);
  });

workflow
  .command("push [file]")
  .description("Push a workflow to the web UI")
  .action(async (file: string | undefined, _options: any) => {
    const path = await import("path");
    const fs = await import("fs");
    const { parseWorkflowFile } = await import("./workflow/parser.js");

    let filePath = file;
    if (!filePath) {
      // Try common locations
      const candidates = [
        path.join(process.cwd(), "workflow.cast"),
        path.join(process.cwd(), "workflows", path.basename(process.cwd()), "workflow.cast"),
      ];
      filePath = candidates.find(f => fs.existsSync(f));
      if (!filePath) {
        console.error("No .cast file specified and none found in current directory.");
        process.exit(1);
      }
    }

    const config = readConfig();
    const siteUrl = (config?.convex_url || CONVEX_URL).replace(".cloud", ".site");
    const apiToken = config?.auth_token;
    if (!apiToken) {
      console.error("Not authenticated. Run `cast login`.");
      process.exit(1);
    }

    const graph = parseWorkflowFile(filePath);
    const slug = graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const source = fs.readFileSync(filePath, "utf-8");

    const nodes = [...graph.nodes.values()].map(n => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      type: n.type,
      ...(n.prompt ? { prompt: n.prompt } : {}),
      ...(n.script ? { script: n.script } : {}),
      ...(n.reasoning_effort ? { reasoning_effort: n.reasoning_effort } : {}),
      ...(n.model ? { model: n.model } : {}),
      ...(n.max_visits !== undefined ? { max_visits: n.max_visits } : {}),
      ...(n.max_retries !== undefined ? { max_retries: n.max_retries } : {}),
      ...(n.retry_target ? { retry_target: n.retry_target } : {}),
      ...(n.goal_gate !== undefined ? { goal_gate: n.goal_gate } : {}),
    }));

    const response = await fetch(`${siteUrl}/cli/workflows/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: apiToken,
        name: graph.name,
        slug,
        goal: graph.goal,
        source,
        nodes,
        edges: graph.edges.map(e => ({
          from: e.from,
          to: e.to,
          ...(e.label ? { label: e.label } : {}),
          ...(e.condition ? { condition: e.condition } : {}),
        })),
        model_stylesheet: graph.model_stylesheet,
      }),
    });

    const result = await response.json() as any;
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    console.log(`${result.updated ? "Updated" : "Created"} workflow: ${graph.name} (${slug})`);
    console.log(`View at: https://codecast.sh/workflows`);
  });

workflow
  .command("install")
  .description("Install workflow snippet into agent config (CLAUDE.md, AGENTS.md)")
  .option("--disable", "Remove workflow snippet and disable")
  .action(async (options: any) => {
    const config = readConfig() || {};

    if (options.disable) {
      config.workflow_enabled = false;
      writeConfig(config);
      console.log("Workflow snippet disabled. Run 'cast workflow install' to re-enable.");
      return;
    }

    const result = installWorkflowSnippet(true);
    config.workflow_enabled = true;
    config.workflow_version = getWorkflowVersion();
    writeConfig(config);

    const targets = getSnippetTargets();
    const targetList = targets.map(t => t.label).join(", ");
    if (result.updated) {
      console.log(`Workflow snippet updated in ${targetList}`);
    } else if (result.installed) {
      console.log(`Workflow snippet installed in ${targetList}`);
      console.log("Your agents can now use DOT-based workflow templates.");
    } else {
      console.log("Workflow snippet is up to date.");
    }
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
    if (config?.task_enabled) {
      installTaskSnippet(true);
    }
    if (config?.workflow_enabled) {
      installWorkflowSnippet(true);
    }
    installSessionRegisterHook();
    installStatusHook();
    console.log("Update complete. Restart cast to use the new version.\n");
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
  const internalCmds = ['start', 'stop', 'status', 'daemon', 'codecast', '_daemon', '_watchdog', 'auth', 'login', 'update'];
  if (!internalCmds.includes(cmdName)) {
    logCliCommand(cmdName, args);
    ensureDaemonRunning();
  }
});

ensureCastAlias();
program.parse();
