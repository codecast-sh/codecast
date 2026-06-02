#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { randomUUID, createHash } from "node:crypto";
import * as http from "http";
import { Database } from "bun:sqlite";
import { execSync, execFileSync, exec, execFile, spawn, spawnSync } from "child_process";
import { watch as chokidarWatch } from "chokidar";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";
import { deviceId, deviceLabel } from "./remote/device.js";
import { loadRemoteHost, performMoveToRemote } from "./remote/session-move.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { CursorTranscriptWatcher, type CursorTranscriptEvent } from "./cursorTranscriptWatcher.js";
import { CodexWatcher, type CodexSessionEvent } from "./codexWatcher.js";
import { watchdogHeartbeatStale, WATCHDOG_HEARTBEAT_FILENAME } from "./supervision.js";
import {
  CodexAppServer,
  threadItemsToMessages,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ThreadItem,
} from "./codexAppServer.js";
import {
  choosePreferredCodexCandidate,
  hasCodexSessionFileOpen,
  isResumeInvocation,
  matchStartedConversation,
} from "./sessionProcessMatcher.js";
import { GeminiWatcher, type GeminiSessionEvent } from "./geminiWatcher.js";
import { parseSessionFile, parseCodexSessionFile, parseGeminiSessionFile, parseCursorTranscriptFile, extractSlug, extractParentUuid, extractSummaryTitle, extractCwd, extractCodexCwd, extractGeminiProjectHash, detectCliFlags, type ParsedMessage } from "./parser.js";
import { extractMessagesFromCursorDb } from "./cursorProcessor.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { encryptToken, decryptToken, isEncryptedToken, TokenDecryptError } from "./tokenEncryption.js";
import { markSynced, getSyncRecord, findUnsyncedFiles, type SyncRecord } from "./syncLedger.js";
import { SyncService, AuthExpiredError } from "./syncService.js";
import { redactSecrets, maskToken } from "./redact.js";
import { RetryQueue, type RetryOperation } from "./retryQueue.js";
import { InvalidateSync, type InvalidateSyncOptions } from "./invalidateSync.js";
import { promisify } from "util";
import { detectPermissionPrompt } from "./permissionDetector.js";
import { handlePermissionRequest } from "./permissionHandler.js";
import { getVersion, performUpdate, ensureCastAlias } from "./update.js";
import { checkForDesktopUpdate } from "./desktopUpdate.js";
import { performReconciliation, repairDiscrepancies } from "./reconciliation.js";
import { TaskScheduler } from "./taskScheduler.js";
import { hasTmux } from "./tmux.js";
import { formatFeedResults } from "./formatter.js";
import { collectSessionResources, formatResourcesLog, nextAwakeIdleMs, shouldReportMetrics, type ReportedMetrics, type SessionResources } from "./resourceMonitor.js";
import {
  fetchExport,
  generateClaudeCodeJsonl,
  generateCodexJsonl,
  writeClaudeCodeSession,
  writeCodexSession,
  chooseClaudeTailMessagesForTokenBudget,
} from "./jsonlGenerator.js";
import {
  CLAUDE_UUID_RE,
  chooseClaudeAutoTrim,
  combineClaudeResumeFlags,
  extractJsonlPermissionMode,
  rewriteSubagentJsonlToUuid,
} from "./resumeCommand.js";
import { resolveLocalProjectPath, resolveResumeCwd, pickProjectPath } from "./projectPathResolver.js";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
const EXEC_TIMEOUT_MS = 10_000;
// Hold references to spawned children so they can't be GC'd before exit/reaping
const _activeChildren = new Set<ReturnType<typeof exec>>();
const execAsync = (cmd: string, opts?: any): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      ...opts,
      env: { ...process.env, PATH: ENRICHED_PATH, ...(opts?.env || {}) },
    }, (err, stdout, stderr) => {
      _activeChildren.delete(child);
      if (err) return reject(err);
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    _activeChildren.add(child);
  });
};

const _execFileAsync = promisify(execFile);

const SAFE_ENV = { ...process.env, PATH: ENRICHED_PATH };

// tmux clients can wedge in a busy loop when their server dies mid-protocol,
// and a wedged client ignores SIGTERM — leaving 100%-CPU zombies that survive
// Node's exec timeout. Default to SIGKILL so a timeout actually reaps the process.
function tmuxExecSync(args: string[], opts?: { timeout?: number; killSignal?: string; env?: Record<string, string | undefined> }): string {
  return execFileSync("tmux", args, {
    timeout: opts?.timeout ?? EXEC_TIMEOUT_MS,
    killSignal: (opts?.killSignal ?? "SIGKILL") as any,
    encoding: "utf-8",
    env: { ...SAFE_ENV, ...opts?.env },
  }).toString();
}

async function tmuxExec(args: string[], opts?: { timeout?: number; killSignal?: string; env?: Record<string, string | undefined> }): Promise<{ stdout: string; stderr: string }> {
  return _execFileAsync("tmux", args, {
    timeout: opts?.timeout ?? EXEC_TIMEOUT_MS,
    killSignal: (opts?.killSignal ?? "SIGKILL") as any,
    env: { ...SAFE_ENV, ...opts?.env },
  });
}

async function getTmuxSessionOption(sessionName: string, optionName: string): Promise<string | null> {
  try {
    const { stdout } = await tmuxExec(["show-options", "-qv", "-t", sessionName, optionName]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function setTmuxSessionOption(sessionName: string, optionName: string, value: string): Promise<void> {
  await tmuxExec(["set-option", "-q", "-t", sessionName, optionName, value]);
}

export function isTmuxSessionMetadataMatch(storedSessionId: string | null | undefined, sessionId: string): boolean {
  return typeof storedSessionId === "string" && storedSessionId === sessionId;
}

async function tmuxSessionMatchesFullSessionId(sessionName: string, sessionId: string): Promise<boolean> {
  const stored = await getTmuxSessionOption(sessionName, "@codecast_session_id");
  return isTmuxSessionMetadataMatch(stored, sessionId);
}

function resolveLocalRepo(remotePath: string): string | null {
  if (!remotePath) return null;
  if (fs.existsSync(remotePath)) return remotePath;
  const parts = remotePath.split(path.sep).filter(Boolean);
  const repoName = parts[parts.length - 1];
  if (!repoName) return null;

  // 1. Explicit user override (config.json `project_mappings`): full recorded path wins,
  //    then basename. Authoritative and never auto-clobbered.
  const userMap = readConfig()?.project_mappings;
  if (userMap) {
    for (const key of [remotePath, repoName]) {
      const mapped = userMap[key];
      if (mapped && fs.existsSync(mapped)) {
        log(`Resolved remote CWD ${remotePath} -> ${mapped} (user mapping)`);
        return mapped;
      }
    }
  }

  // 2. Learned map: paths/basenames the daemon has observed running locally. This is what
  //    lets a fork of a conversation recorded on another machine resolve to wherever the
  //    repo actually lives here, even when that's off the convention paths below.
  const learned = readProjectMap();
  for (const key of [remotePath, repoName]) {
    const mapped = learned[key];
    if (mapped && fs.existsSync(mapped)) {
      log(`Resolved remote CWD ${remotePath} -> ${mapped} (learned mapping)`);
      return mapped;
    }
  }

  // 3. Convention search. On a hit, learn it so future lookups — and other-machine forks
  //    sharing this basename — resolve in one step.
  const home = process.env.HOME || "/tmp";
  const candidates = [
    path.join(home, "src", repoName),
    path.join(home, "projects", repoName),
    path.join(home, "code", repoName),
    path.join(home, "repos", repoName),
    path.join(home, repoName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      log(`Resolved remote CWD ${remotePath} -> ${candidate}`);
      recordProjectMapping(repoName, candidate);
      return candidate;
    }
  }
  return null;
}

// Claude indexes a session by the slug of the cwd it runs in:
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. When we reconstitute a session
// whose origin path lives on another machine (a fork, or any cross-host resume),
// the JSONL must land under the *locally-resolved* repo path — the same cwd
// `claude --resume` will actually use — or Claude reports "No conversation found
// with session ID" and the resume crashes, poisoning the fatal-reason cache and
// falling back to a blank session. Resolve the write dir the same way we resolve
// the resume cwd so the two always agree.
function localSessionDir(remotePath?: string): string | undefined {
  if (!remotePath) return undefined;
  return resolveLocalRepo(remotePath) ?? remotePath;
}

// Resolve the cwd a resume/reconstitute must run in, or null to REFUSE. Wires the
// daemon's resolveLocalRepo + (when a conversation is known) a git-remote remap
// through the sync service. Mirrors the start_session contract so a resume that
// lands on a machine without the checkout never silently runs in $HOME (which
// mislabels the project as the home dir — see resolveResumeCwd).
async function resolveResumeCwdOrRefuse(opts: {
  recordedCwd?: string;
  cwdOverride?: string;
  conversationId?: string;
}): Promise<string | null> {
  const conversationId = opts.conversationId;
  return resolveResumeCwd({
    cwdOverride: opts.cwdOverride,
    recordedCwd: opts.recordedCwd,
    resolveLocalRepo,
    remapViaRemote: (conversationId && syncServiceRef)
      ? async () => {
          const svc = syncServiceRef!;
          const info = await svc.getProjectInfo(conversationId).catch(() => null);
          const resolved = await resolveLocalProjectPath({
            projectPath: info?.project_path ?? opts.recordedCwd ?? null,
            gitRoot: info?.git_root ?? null,
            gitRemoteUrl: info?.git_remote_url ?? null,
            findCandidates: (url) => svc.findLocalCheckouts(url).catch(() => []),
          });
          return resolved?.path ?? null;
        }
      : undefined,
  });
}

// "Clone it first" is only an actionable banner when we can name what's missing:
// a git remote to clone, or a concrete recorded path that simply isn't here. A
// remote session that carried NEITHER (e.g. a Codex run resumed from another host
// with no cwd and no remote) gives the daemon zero evidence a local checkout is
// even expected — stamping "No local checkout for <unknown remote> (recorded path
// unknown)" is a non-actionable false positive. Returns false in that case so the
// caller stays silent (and clears any stale banner) instead.
export function noLocalCheckoutBannerActionable(args: {
  remote: string | null | undefined;
  recordedPath: string | null | undefined;
}): boolean {
  return !!(args.remote || args.recordedPath);
}

// When a resume can't be placed in a real local checkout, mirror start_session:
// stay silent if another device owns the conversation (it will run it), else
// surface "clone it first" on the conversation. Never falls back to $HOME.
async function refuseResumeNoLocalCheckout(
  sessionId: string,
  conversationId: string | undefined,
  recordedCwd: string | undefined,
): Promise<void> {
  const short = sessionId.slice(0, 8);
  if (conversationId && syncServiceRef) {
    const owner = await syncServiceRef.getConversationOwner(conversationId).catch(() => null);
    if (owner && owner !== deviceId()) {
      log(`[REMOTE] resume ${short}: no local checkout for ${recordedCwd ?? "<unknown>"}, owned by ${owner.slice(0, 8)} — staying silent`);
      return;
    }
    const info = await syncServiceRef.getProjectInfo(conversationId).catch(() => null);
    const remote = info?.git_remote_url ?? null;
    // Nothing to clone, nothing to point at → clear any stale banner and stay
    // silent rather than scaring the user with a dead-end "clone it first".
    if (!noLocalCheckoutBannerActionable({ remote, recordedPath: recordedCwd })) {
      syncServiceRef.setSessionError(conversationId).catch(() => {});
      log(`[REMOTE] resume ${short}: no local checkout and no remote/path to act on — staying silent (cleared any stale banner)`);
      return;
    }
    const err = `No local checkout for ${remote ?? "<unknown remote>"} (recorded path ${recordedCwd ?? "unknown"} doesn't exist here). Clone it first.`;
    syncServiceRef.setSessionError(conversationId, err).catch(() => {});
    log(`[REMOTE] resume refused for ${short}: ${err}`);
  } else {
    log(`Cannot auto-resume ${short}: recorded cwd ${recordedCwd ?? "<unknown>"} not found locally; refusing (no $HOME fallback)`);
  }
}

function validatePath(p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (!path.isAbsolute(p)) return null;
  if (/[;|&`$(){}<>"\r\n\0]/.test(p)) return null;
  const resolved = path.resolve(p);
  if (resolved !== p && resolved !== p.replace(/\/+$/, "")) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

const SAFE_ARG_RE = /^[a-zA-Z0-9_.\/=:@%+, -]+$/;
function sanitizeBinaryArgs(args: string[]): string[] {
  return args.filter(a => {
    if (!SAFE_ARG_RE.test(a)) {
      log(`[SECURITY] Rejected unsafe binary arg: ${a}`);
      return false;
    }
    return true;
  });
}

function validateTmuxTarget(target: string): boolean {
  return /^[a-zA-Z0-9_.:-]+$/.test(target);
}

// SIGKILL a process AND every descendant. `tmux kill-session` only SIGHUPs the
// pane's foreground group, so claude's children — MCP servers, `caffeinate`,
// tool subprocesses in their own process groups — routinely survive, orphaned to
// init. Walk the parent→child tree with `pgrep -P` and kill leaves-first so a
// dying parent can't reparent a child out from under us before we reach it.
async function reapPidTree(rootPid: number): Promise<number> {
  if (!Number.isInteger(rootPid) || rootPid <= 1 || rootPid === process.pid) return 0;
  const ordered: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const pid = queue.shift()!;
    ordered.push(pid);
    try {
      const { stdout } = await execAsync(`pgrep -P ${pid}`, { timeout: 3000, killSignal: "SIGKILL" });
      for (const tok of stdout.trim().split(/\s+/)) {
        const child = parseInt(tok, 10);
        if (Number.isInteger(child) && child > 1 && child !== process.pid && !seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    } catch {}
  }
  let killed = 0;
  for (const pid of ordered.reverse()) {
    try { process.kill(pid, "SIGKILL"); killed++; } catch {}
  }
  return killed;
}

// Fully terminate a tmux session: reap each pane's whole process tree (so no
// orphaned claude/MCP/caffeinate survives), THEN kill the session. Order matters
// — once the session is gone we can't enumerate its pane pids.
async function killTmuxSessionAndTree(tmuxSession: string): Promise<void> {
  if (!validateTmuxTarget(tmuxSession)) return;
  try {
    const { stdout } = await tmuxExec(
      ["list-panes", "-t", tmuxSession, "-F", "#{pane_pid}"],
      { timeout: 3000, killSignal: "SIGKILL" },
    );
    for (const tok of stdout.trim().split(/\s+/)) {
      const panePid = parseInt(tok, 10);
      if (Number.isInteger(panePid)) await reapPidTree(panePid);
    }
  } catch {}
  try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
}

// Sleep/wake detection: if the last tick was more than 30s ago, we probably just woke from sleep.
// During the wake grace period, skip polling to let tmux recover and avoid zombie accumulation.
let lastTickTime = Date.now();
const SLEEP_DETECTION_THRESHOLD_MS = 30_000;
const WAKE_GRACE_PERIOD_MS = 5_000;
let wakeGraceUntil = 0;
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTickTime;
  if (elapsed > SLEEP_DETECTION_THRESHOLD_MS) {
    wakeGraceUntil = now + WAKE_GRACE_PERIOD_MS;
    log(`Sleep detected (${Math.round(elapsed / 1000)}s gap), grace period until ${new Date(wakeGraceUntil).toISOString()}`);
  }
  lastTickTime = now;
}, 5_000);
function isInWakeGrace(): boolean { return Date.now() < wakeGraceUntil; }


const CONFIG_DIR = process.env.HOME + "/.codecast";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const STATE_FILE = path.join(CONFIG_DIR, "daemon.state");
const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const VERSION_FILE = path.join(CONFIG_DIR, "daemon.version");
const HOOK_PORT_FILE = path.join(CONFIG_DIR, "hook-port");
const STARTED_SESSIONS_FILE = path.join(CONFIG_DIR, "started-sessions.json");
// Learned project-path map: basename/recorded-path -> local dir, auto-populated from
// repos observed locally (see recordProjectMapping). Lets cross-machine forks resume
// in the right working directory even when the repo lives off the convention paths.
const PROJECT_MAP_FILE = path.join(CONFIG_DIR, "project-paths.json");
const APP_SERVER_THREADS_FILE = path.join(CONFIG_DIR, "app-server-threads.json");
const PID_FILE_STALE_GRACE_MS = 2_000;

interface Config {
  user_id?: string;
  team_id?: string;
  convex_url?: string;
  auth_token?: string;
  stable_mode?: "solo" | "team";
  stable_global?: boolean;
  excluded_paths?: string;
  claude_args?: string;
  codex_args?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];
  agent_permission_modes?: {
    claude?: "default" | "bypass";
    codex?: "default" | "full_auto" | "bypass";
    gemini?: "default" | "bypass";
  };
  agent_default_params?: {
    claude?: Record<string, string>;
    codex?: Record<string, string>;
    gemini?: Record<string, string>;
    cursor?: Record<string, string>;
  };
  // Opt out of the daemon updating the desktop app out-of-band (default: on).
  desktop_auto_update?: boolean;
  // Explicit project-path overrides for resuming sessions/forks recorded on another
  // machine. Keys are the recorded (remote) project path OR its basename; values are
  // the local directory to resume in. Authoritative — checked before the learned map
  // and the convention search in resolveLocalRepo, and never auto-clobbered.
  project_mappings?: Record<string, string>;
  // Tier 3 "warm pool": proactively re-resume up to N most-recently-active sessions
  // whose agent died unexpectedly (terminal closed / crash) while the conversation was
  // still hot, so the next message lands on a live agent instead of a cold boot. 0 (the
  // default) disables it — re-warming is speculative (it can resurrect a session the
  // user deliberately closed and costs a claude process per slot), so it's opt-in.
  warm_pool_size?: number;
}

function getPermissionFlags(agentType: "claude" | "codex" | "cursor" | "gemini", config?: Config | null): string | null {
  const modes = config?.agent_permission_modes;

  if (agentType === "claude") {
    if (modes?.claude === "bypass") return "--permission-mode bypassPermissions";
    if (modes?.claude === "default") return "--allow-dangerously-skip-permissions";
    // No explicit config: match codex behavior and default to bypass so sessions launched
    // from the web (or any non-CLI surface) inherit the user's expected dev defaults.
    return "--permission-mode bypassPermissions";
  } else if (agentType === "codex") {
    const existing = config?.codex_args || "";
    if (existing.includes("--full-auto") || existing.includes("--ask-for-approval") || existing.includes("--dangerously-bypass")) return null;
    if (modes?.codex === "full_auto") return "--full-auto";
    if (modes?.codex === "default") return null;
    // Default to bypass when no explicit config is set
    return "--dangerously-bypass-approvals-and-sandbox";
  } else if (agentType === "gemini") {
    // gemini flags TBD
  }

  return null;
}

function resolveCodexApprovalPolicy(config?: Config | null): ApprovalPolicy {
  const flags = getPermissionFlags("codex", config);
  const codexArgs = config?.codex_args || "";
  if (flags?.includes("--dangerously-bypass") || codexArgs.includes("--dangerously-bypass") || flags?.includes("--full-auto") || codexArgs.includes("--full-auto")) {
    return "never";
  }
  return "on-request";
}

function getDefaultParamFlags(agentType: "claude" | "codex" | "cursor" | "gemini", config?: Config | null): string | null {
  const params = config?.agent_default_params?.[agentType];
  if (!params || Object.keys(params).length === 0) return null;
  return Object.entries(params).map(([k, v]) => `--${k} ${v}`).join(" ");
}

interface ConversationCache {
  [sessionId: string]: string;
}

interface TitleCache {
  [sessionId: string]: string;
}

interface PendingMessages {
  [sessionId: string]: Array<{
    uuid?: string;
    role: "human" | "assistant" | "system";
    content: string;
    timestamp: number;
    filePath: string;
    fileSize: number;
    thinking?: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
    images?: Array<{ mediaType: string; data: string }>;
    subtype?: string;
  }>;
}

interface DaemonState {
  connected?: boolean;
  lastSyncTime?: number;
  pendingQueueSize?: number;
  timestamp?: number;
  authExpired?: boolean;
  authFailureCount?: number;
  lastWatchdogCheck?: number;
  watchdogRestarts?: number;
  lastHeartbeatTick?: number;
  runtimeVersion?: string;
  lastSelfHealRestart?: number;
}

const AUTH_FAILURE_THRESHOLD = 5;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WATCHDOG_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_FLUSH_INTERVAL_MS = 15 * 1000; // 15 seconds - flush more frequently
const MAX_LOG_QUEUE_SIZE = 500;
const LOG_QUEUE_FILE = path.join(process.env.HOME || "", ".codecast", "log-queue.json");
const EVENT_LOOP_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
const EVENT_LOOP_LAG_THRESHOLD_MS = 60 * 1000; // 1 minute of lag = frozen
const HEARTBEAT_STALE_THRESHOLD_MS = 3 * 60 * 1000; // external watchdog: 3 min (6 missed 30s heartbeats) = deadlocked. Tight so recovery beats the 5-min "blocked" display after a sleep.
const STUCK_CONNECTION_THRESHOLD_MS = 3 * 60 * 1000; // 3 min disconnected = stuck, trigger self-heal
const SELF_HEAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between self-heal restarts

type LogLevel = "debug" | "info" | "warn" | "error";

interface RemoteLog {
  level: LogLevel;
  message: string;
  metadata?: {
    session_id?: string;
    error_code?: string;
    stack?: string;
  };
  timestamp: number;
}

let remoteLogQueue: RemoteLog[] = [];
let syncServiceRef: SyncService | null = null;
let retryQueueRef: RetryQueue | null = null;
let conversationCacheRef: ConversationCache | null = null;
let daemonVersion: string | undefined;
let activeConfig: Config | null = null;
const platform = process.platform;

function loadPersistedLogQueue(): void {
  try {
    if (fs.existsSync(LOG_QUEUE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOG_QUEUE_FILE, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        remoteLogQueue = [...data, ...remoteLogQueue].slice(-MAX_LOG_QUEUE_SIZE);
        fs.unlinkSync(LOG_QUEUE_FILE);
      }
    }
  } catch {}
}

function persistLogQueue(): void {
  if (remoteLogQueue.length === 0) return;
  try {
    fs.writeFileSync(LOG_QUEUE_FILE, JSON.stringify(remoteLogQueue), { mode: 0o600 });
  } catch {}
}

function getSiteUrl(): string | null {
  const config = activeConfig || readConfig();
  if (!config?.convex_url) return null;
  return config.convex_url.replace(".cloud", ".site");
}

function getAuthToken(): string | null {
  const config = activeConfig || readConfig();
  return config?.auth_token || null;
}

async function flushRemoteLogsViaHttp(): Promise<void> {
  if (remoteLogQueue.length === 0) return;
  const siteUrl = getSiteUrl();
  const token = getAuthToken();
  if (!siteUrl || !token) return;

  const logsToSend = remoteLogQueue.splice(0, 100);
  const logsWithMeta = logsToSend.map(l => ({
    ...l,
    daemon_version: daemonVersion,
    platform,
  }));

  try {
    const response = await fetch(`${siteUrl}/cli/log-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: token, logs: logsWithMeta }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      remoteLogQueue.unshift(...logsToSend);
      persistLogQueue();
    }
  } catch {
    remoteLogQueue.unshift(...logsToSend);
    persistLogQueue();
  }
}

function sendLogImmediate(level: LogLevel, message: string, metadata?: RemoteLog["metadata"]): void {
  const siteUrl = getSiteUrl();
  const token = getAuthToken();
  if (!siteUrl || !token) return;

  fetch(`${siteUrl}/cli/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: token,
      level,
      message: message.slice(0, 2000),
      metadata,
      cli_version: daemonVersion,
      platform,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

const IDLE_DEBOUNCE_MS = 5_000;
// Coalesce a streaming agent's rapid JSONL appends into fewer, fatter addMessages
// batches. Each batch is a server mutation that reads+patches the conversation
// hot-doc and schedules side-effects, so cutting batch count is the cheapest way to
// relieve a saturated backend when many sessions sync at once. 300ms keeps the web
// view feeling near-live; maxWait flushes a session that never pauses.
const MESSAGE_SYNC_DEBOUNCE: InvalidateSyncOptions = { debounceMs: 300, maxWaitMs: 2_000 };
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastIdleNotifiedSize = new Map<string, number>();
const lastWorkingStatusSent = new Map<string, number>();
const WORKING_STATUS_THROTTLE_MS = 10_000;
const lastSentAgentStatus = new Map<string, AgentStatus>();
const workingPhaseStart = new Map<string, number>();
const MIN_WORKING_DURATION_FOR_NOTIF_MS = 10_000;
const lastHeartbeatLogged = new Map<string, { status: string; ts: number; since: number }>();
const HEARTBEAT_LOG_THROTTLE_MS = 5 * 60 * 1000;

type AgentStatus = "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "resuming";
type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
type HookStatusData = { status: AgentStatus; ts: number; permission_mode?: PermissionMode; message?: string; transcript_path?: string };
type AppServerThreadStatus = { type?: string; activeFlags?: string[] };
const lastHookStatus = new Map<string, HookStatusData>();
const pendingInteractivePrompts = new Map<string, { timestamp: number; options: Array<{ label: string; description?: string }>; isConfirmation?: boolean }>();
// Last synthetic-prompt uuid emitted per session. The heartbeat clears the pending
// guard whenever the pane momentarily stops showing a menu, so a resumed session that
// re-renders the same blocking menu would otherwise re-emit (and re-surface, since the
// card carries timestamp:now) the identical prompt over and over. Suppress that here;
// it's cleared on answer delivery so a genuine re-ask of the same question re-emits.
const lastEmittedSyntheticPrompt = new Map<string, string>();
const AGENT_STATUS_DIR = path.join(process.env.HOME || "", ".codecast", "agent-status");
const skillsSyncedConversations = new Set<string>();

// Post-compaction message recovery: CC sometimes goes idle after compacting instead of
// continuing to process the user's message. Track compaction events and recent injections
// so we can detect this pattern and re-inject the dropped message.
const recentCompactionTs = new Map<string, number>(); // sessionId -> when compaction was detected
const recentSessionInjections = new Map<string, { messageId: string; content: string; ts: number }>(); // conversationId -> last injection
const postCompactionRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>(); // sessionId -> pending recovery
const compactionRedeliveryBypass = new Set<string>(); // messageIds that should bypass injection dedup

// Message delivery dedup/in-flight tracking. Module-scoped so kill_session can clear entries
// for a conversation when its tmux pane is killed mid-delivery — otherwise the daemon's
// 60s dedup window would skip re-delivery of the message Convex just reset back to pending.
// Each entry stores the conversation_id so kill_session can find matching ids without
// maintaining a reverse index.
const messagesInFlight = new Map<string, { ts: number; conversationId: string }>();
const injectedMessageTs = new Map<string, { ts: number; conversationId: string }>();
const IN_FLIGHT_HARD_TTL_MS = 240_000; // > DELIVERY_TIMEOUT_MS (180s)
const INJECTION_DEDUP_TTL_MS = 60_000;
// Per-conversation delivery lock: prevents multiple messages targeting the same tmux pane
// from being injected concurrently (which causes an interrupt storm where each injection
// Escapes the previous, none complete, and the retry cron resets them all to pending).
const conversationDeliveryActive = new Set<string>();

// A web message's whole point is the local tmux paste; that must never be blocked by a Convex
// round-trip. The "injected" status is only an intermediate UI signal — the durable ack is the
// content-matched promote-to-delivered in addMessages when the agent echoes the message to its
// JSONL. So mark injected best-effort with a hard timeout and swallow failures: an un-timed
// updateMessageStatus before the paste was wedging deliverMessage for the full 180s timeout
// under Convex load, so the send-keys never ran and the message never reached the agent.
const MARK_INJECTED_TIMEOUT_MS = 8_000;
export function markInjectedBestEffort(
  syncService: Pick<SyncService, "updateMessageStatus">,
  messageId: string,
  timeoutMs: number = MARK_INJECTED_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    syncService.updateMessageStatus({ messageId, status: "injected" }),
    new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("mark_injected_timeout")), timeoutMs);
    }),
  ]).catch(err => {
    logDelivery(`mark-injected best-effort skipped for msg=${messageId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => { if (timer) clearTimeout(timer); });
}

function clearMessageDeliveryStateForConversation(conversationId: string): { inFlight: number; dedup: number } {
  let inFlight = 0;
  let dedup = 0;
  for (const [id, entry] of messagesInFlight) {
    if (entry.conversationId === conversationId) {
      messagesInFlight.delete(id);
      inFlight++;
    }
  }
  for (const [id, entry] of injectedMessageTs) {
    if (entry.conversationId === conversationId) {
      injectedMessageTs.delete(id);
      dedup++;
    }
  }
  conversationDeliveryActive.delete(conversationId);
  return { inFlight, dedup };
}

// Single source of truth for "this session/conversation just lost its tmux pane".
// Every kill path (user-triggered kill_session, auto-kill on dismissed-idle, crash
// reconstitution) must call this — otherwise the next pending message Convex re-fires
// hits the 60s injection-dedup branch ("injected Ns ago, updating status only") and
// never reaches the freshly-resumed tmux. Mirrored Convex state (injected→pending) is
// reset here too so the message becomes eligible for redelivery from the subscription.
async function clearConversationDeliveryAndResumeState(
  conversationId: string | undefined,
  sessionId: string | undefined,
  context: string,
): Promise<void> {
  if (sessionId) {
    resumeFatalReasons.delete(sessionId);
    sessionDeliveryFailures.delete(sessionId);
    repairAttempts.delete(sessionId);
  }
  if (!conversationId) return;
  conversationResumeFailures.delete(conversationId);
  repairAttempts.delete(conversationId);

  if (syncServiceRef) {
    syncServiceRef.resetInjectedMessages(conversationId).catch(logConvexFailure);
  }

  const cleared = clearMessageDeliveryStateForConversation(conversationId);
  if (cleared.inFlight || cleared.dedup) {
    log(`[${context}] Cleared delivery state for conversation ${conversationId.slice(0, 12)}: ${cleared.inFlight} in-flight, ${cleared.dedup} dedup`);
  }
  recentSessionInjections.delete(conversationId);
}

export function mapCodexAppServerThreadStatusToAgentStatus(status: AppServerThreadStatus | null | undefined): AgentStatus | null {
  if (!status?.type) return null;
  switch (status.type) {
    case "idle":
      return "idle";
    case "active":
      return status.activeFlags?.includes("waitingOnApproval") || status.activeFlags?.includes("waitingOnUserInput")
        ? "permission_blocked"
        : "working";
    case "systemError":
      return "stopped";
    default:
      return null;
  }
}

function readAvailableSkills(projectPath?: string): Array<{ name: string; description: string }> {
  const skills: Array<{ name: string; description: string }> = [];
  const seen = new Set<string>();
  const home = process.env.HOME || "";
  const commandDirs = [
    path.join(home, ".claude", "commands"),
    ...(projectPath ? [path.join(projectPath, ".claude", "commands")] : []),
  ];
  for (const dir of commandDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const name = file.replace(/\.md$/, "");
        if (seen.has(name)) continue;
        seen.add(name);
        try {
          const content = fs.readFileSync(path.join(dir, file), "utf-8");
          const m = content.match(/^---[\s\S]*?description:\s*(.+?)[\r\n]/m);
          skills.push({ name, description: m?.[1]?.trim() || "" });
        } catch {}
      }
    } catch {}
  }
  const skillDirs = [
    path.join(home, ".claude", "skills"),
    ...(projectPath ? [path.join(projectPath, ".claude", "skills")] : []),
  ];
  for (const dir of skillDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const skillMd = path.join(dir, entry, "SKILL.md");
        const standalone = path.join(dir, entry);
        let content = "";
        if (fs.existsSync(skillMd)) {
          content = fs.readFileSync(skillMd, "utf-8");
        } else if (entry.endsWith(".md")) {
          content = fs.readFileSync(standalone, "utf-8");
        } else continue;
        const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)[\r\n]/m);
        const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)[\r\n]/m);
        const invocable = /user_invocable:\s*true/i.test(content);
        const name = nameMatch?.[1]?.trim() || entry.replace(/\.md$/, "");
        if (!invocable || seen.has(name)) continue;
        seen.add(name);
        skills.push({ name, description: descMatch?.[1]?.trim() || "" });
      }
    } catch {}
  }
  return skills;
}

function syncSkillsForConversation(conversationId: string, projectPath: string | undefined, syncService: SyncService): void {
  if (skillsSyncedConversations.has(conversationId)) return;
  skillsSyncedConversations.add(conversationId);
  const allSkills = readAvailableSkills(projectPath);
  if (allSkills.length === 0) return;
  syncService.setAvailableSkills(conversationId, JSON.stringify(allSkills)).catch(logConvexFailure);
  if (projectPath) {
    const globalSkills = readAvailableSkills();
    const globalNames = new Set(globalSkills.map(s => s.name));
    const projectOnly = allSkills.filter(s => !globalNames.has(s.name));
    if (projectOnly.length > 0) {
      syncService.setAvailableSkills(undefined, JSON.stringify(projectOnly), projectPath).catch(logConvexFailure);
    }
  }
}

function sendAgentStatus(
  syncService: SyncService,
  conversationId: string,
  sessionId: string,
  status: AgentStatus,
  clientTs?: number,
  permissionMode?: PermissionMode,
  idleMessage?: string,
): void {
  const prevStatus = lastSentAgentStatus.get(sessionId);
  const isTransition = prevStatus !== status;
  if (status === "working" && !permissionMode && !isTransition) {
    const last = lastWorkingStatusSent.get(sessionId) ?? 0;
    if (Date.now() - last < WORKING_STATUS_THROTTLE_MS) return;
  }
  if (status === "working") {
    lastWorkingStatusSent.set(sessionId, Date.now());
    if (!workingPhaseStart.has(sessionId)) {
      workingPhaseStart.set(sessionId, Date.now());
    }
  }
  lastSentAgentStatus.set(sessionId, status);
  syncService.updateSessionAgentStatus(conversationId, status, clientTs, permissionMode).catch((err) => { log(`[sendAgentStatus] error: ${err?.message || err}`); });
  if (status === "idle" && idleMessage) {
    const workStart = workingPhaseStart.get(sessionId);
    workingPhaseStart.delete(sessionId);
    if (workStart) {
      const workingDuration = Date.now() - workStart;
      if (workingDuration >= MIN_WORKING_DURATION_FOR_NOTIF_MS) {
        syncService.createSessionNotification({
          conversation_id: conversationId,
          type: "session_idle",
          title: "Claude done",
          message: idleMessage,
        }).catch(() => {});
        log(`Sent idle notification for session ${sessionId.slice(0, 8)} (worked ${Math.round(workingDuration / 1000)}s)`);
      } else {
        log(`Skipped idle notification for session ${sessionId.slice(0, 8)} (worked only ${Math.round(workingDuration / 1000)}s < ${MIN_WORKING_DURATION_FOR_NOTIF_MS / 1000}s)`);
      }
    }
  }
  if (status === "stopped") {
    workingPhaseStart.delete(sessionId);
  }
}

// Log the status carried on a heartbeat. Throttled per-session to once every
// 5 minutes for same-status heartbeats; always logs on status change. The
// "stuck=<seconds>" field is the dwell time in the current status — if we see
// "status=working stuck=61234" in logs, that's the "session stuck in working"
// bug. If we see status transitions in the log but the server still shows
// stale status, the fault is in the transport, not the daemon's state tracking.
function logHeartbeatStatus(sessionId: string, status: AgentStatus | undefined): void {
  if (!status) return;
  const now = Date.now();
  const prev = lastHeartbeatLogged.get(sessionId);
  const since = prev && prev.status === status ? prev.since : now;
  if (prev && prev.status === status && now - prev.ts < HEARTBEAT_LOG_THROTTLE_MS) return;
  lastHeartbeatLogged.set(sessionId, { status, ts: now, since });
  const stuckSec = Math.round((now - since) / 1000);
  log(`[HEARTBEAT] session=${sessionId.slice(0, 8)} status=${status} stuck=${stuckSec}s`);
}

// --- HTTP Hook Server ---
// Provides a push endpoint for agent status events at localhost:{port}/hook/status.
// The hook script (codecast-status.sh) sends events here via curl for instant delivery.
// The file-based chokidar watcher on ~/.codecast/agent-status/ remains as a fallback
// when the HTTP server is unreachable (e.g. daemon restart, port contention).
//
// Permission flow via HTTP: when status=permission_blocked arrives, handleStatusData
// processes it identically to the file path. The filePath parameter is only used for
// unlinkSync on "stopped" events; findTranscriptForSession uses sessionId to locate
// JSONL files independently, so permission handling works without a filePath.

let hookServer: http.Server | null = null;
let hookServerPort = 0;

function startHookServer(
  handleStatus: (sessionId: string, data: HookStatusData) => void,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/hook/status")) {
      const url = new URL(req.url, `http://localhost`);
      const sessionId = url.searchParams.get("session_id");
      const status = url.searchParams.get("status") as AgentStatus | null;
      const ts = url.searchParams.get("ts");
      const permissionMode = url.searchParams.get("permission_mode") as PermissionMode | undefined;
      const message = url.searchParams.get("message") || undefined;
      const transcriptPath = url.searchParams.get("transcript_path") || undefined;

      if (!sessionId || !status || !ts) {
        res.writeHead(400);
        res.end("missing params");
        return;
      }

      const data: HookStatusData = {
        status,
        ts: parseInt(ts, 10),
        ...(permissionMode && { permission_mode: permissionMode }),
        ...(message && { message }),
        ...(transcriptPath && { transcript_path: transcriptPath }),
      };

      handleStatus(sessionId, data);

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      hookServerPort = addr.port;
      try {
        fs.writeFileSync(HOOK_PORT_FILE, String(hookServerPort));
      } catch {}
      log(`Hook server listening on 127.0.0.1:${hookServerPort}`);
    }
  });

  server.on("error", (err) => {
    log(`Hook server error: ${err.message}`);
  });

  return server;
}

function stopHookServer(): void {
  if (hookServer) {
    hookServer.close();
    hookServer = null;
  }
  try { fs.unlinkSync(HOOK_PORT_FILE); } catch {}
}

function truncateForNotification(text: string, maxLen = 200): string {
  let result = text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (result.length > maxLen) {
    result = result.slice(0, maxLen) + "...";
  }
  return result;
}

function extractPendingToolUseFromTranscript(transcriptPath: string): { tool_name: string; arguments_preview: string } | null {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const tailContent = readFileTail(transcriptPath, 32768);
    const lines = tailContent.trim().split("\n");
    const tail = lines.slice(-20);

    let lastToolUse: { name: string; input: any } | null = null;
    const completedToolIds = new Set<string>();

    for (const line of tail) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === "tool_result") completedToolIds.add(block.tool_use_id);
          if (block.type === "tool_use") lastToolUse = { name: block.name, input: block.input };
        }
      } catch {}
    }

    if (!lastToolUse) return null;

    let preview = "";
    if (lastToolUse.input) {
      if (typeof lastToolUse.input.command === "string") {
        preview = lastToolUse.input.command;
      } else if (typeof lastToolUse.input.file_path === "string") {
        preview = lastToolUse.input.file_path;
      } else if (typeof lastToolUse.input.pattern === "string") {
        preview = lastToolUse.input.pattern;
      } else {
        preview = JSON.stringify(lastToolUse.input).slice(0, 300);
      }
    }
    if (lastToolUse.input?.description) {
      preview = `${lastToolUse.input.description}\n${preview}`;
    }

    return { tool_name: lastToolUse.name, arguments_preview: preview.slice(0, 500) };
  } catch {
    return null;
  }
}

const permissionRecordPending = new Set<string>();
const permissionJustResolved = new Set<string>();
// One-shot cleanup tracking: when a session is first observed in
// bypassPermissions mode (post-daemon-restart or post-upgrade), sweep any
// stale pending_permissions records left over from before the phantom-suppression
// fix shipped. After the first sweep per session we leave it alone.
const bypassPermissionsCleaned = new Set<string>();
// Sessions currently blocked on an AskUserQuestion. A PreToolUse AskUserQuestion hook
// is the one timely, reliable signal that the agent is waiting for input: Claude Code
// buffers the tool_use so the JSONL stays empty until answered, and a raw-iTerm
// (non-tmux) session has no pane to scrape. The follow-up Notification events that
// arrive during the wait are context-free (no tool name) and look identical to a
// phantom bypass auto-approve, so without this memory they downgrade the honest
// permission_blocked status back to "working" — leaving the web showing "working/stuck"
// for the entire wait. We hold the block until a non-blocked status arrives (the answer
// landed and the agent moved on). See classifyBypassBlock.
const awaitingAskUserQuestion = new Set<string>();

const syncStats = {
  messagesSynced: 0,
  conversationsCreated: 0,
  sessionsActive: new Set<string>(),
  lastReportTime: Date.now(),
  errors: 0,
  warnings: 0,
};

let lastWatcherEventTime = Date.now();

const HEALTH_REPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Only actionable levels are worth uploading. debug/info (dominated by the
// [HEARTBEAT] firehose) bloated the server's daemon_logs table, so they stay
// local-only. The server also drops them on insert; this just avoids the upload.
function shouldUploadLog(level: LogLevel): boolean {
  return level === "warn" || level === "error";
}

function enqueueRemoteLog(entry: RemoteLog): void {
  if (!shouldUploadLog(entry.level)) return;
  remoteLogQueue.push(entry);
  if (remoteLogQueue.length > MAX_LOG_QUEUE_SIZE) {
    remoteLogQueue.shift();
  }
}

function log(message: string, level: LogLevel = "info", metadata?: RemoteLog["metadata"]): void {
  const timestamp = new Date().toISOString();
  const levelTag = level === "info" ? "" : `[${level.toUpperCase()}] `;
  const line = `[${timestamp}] ${levelTag}${message}\n`;
  fs.appendFileSync(LOG_FILE, line);

  enqueueRemoteLog({
    level,
    message: message.slice(0, 2000),
    metadata,
    timestamp: Date.now(),
  });
}

function logError(message: string, error?: Error, sessionId?: string): void {
  const errMsg = error ? `${message}: ${error.message}` : message;
  log(errMsg, "error", {
    session_id: sessionId,
    error_code: error?.name,
    stack: error?.stack?.slice(0, 1000),
  });
}

function logWarn(message: string, sessionId?: string): void {
  log(message, "warn", { session_id: sessionId });
}

function logDelivery(message: string, metadata?: RemoteLog["metadata"]): void {
  log(message, "info", metadata);
  enqueueRemoteLog({
    level: "info",
    message: `[DELIVERY] ${message.slice(0, 2000)}`,
    metadata,
    timestamp: Date.now(),
  });
}

// Standard catch handler for fire-and-forget Convex calls. Previously these used
// `.catch(() => {})` and silently swallowed errors, which hid Convex outages,
// auth-token expiry, and stuck mutations. Logs at info level to keep noise reasonable
// while still leaving a breadcrumb when the sync layer fails.
function logConvexFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log(`[convex-bg] mutation failed: ${msg}`);
}

function logLifecycle(event: string, details?: string): void {
  const message = details ? `[LIFECYCLE] ${event}: ${details}` : `[LIFECYCLE] ${event}`;
  log(message, "info");
  enqueueRemoteLog({
    level: "info",
    message,
    metadata: { error_code: event },
    timestamp: Date.now(),
  });
}

function getSystemMetrics(): { rss_mb: number; heap_mb: number; heap_total_mb: number; uptime_min: number; fds: number; cpu_user_ms: number; cpu_system_ms: number } {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  let fds = 0;
  try {
    fds = fs.readdirSync(`/dev/fd`).length;
  } catch {
    try {
      fds = parseInt(execSync("lsof -p " + process.pid + " 2>/dev/null | wc -l", { timeout: 5000 }).toString().trim(), 10) || 0;
    } catch {}
  }
  return {
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    uptime_min: Math.round(process.uptime() / 60),
    fds,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000),
  };
}

const FD_WARN_THRESHOLD = 5000;
const RSS_WARN_THRESHOLD_MB = 1500;

function logHealthSummary(): void {
  const now = Date.now();
  const periodMinutes = Math.round((now - syncStats.lastReportTime) / 60000);
  const sessionsCount = syncStats.sessionsActive.size;
  const metrics = getSystemMetrics();

  const metricStr = `rss=${metrics.rss_mb}MB heap=${metrics.heap_mb}/${metrics.heap_total_mb}MB fds=${metrics.fds} cpu=${metrics.cpu_user_ms}+${metrics.cpu_system_ms}ms uptime=${metrics.uptime_min}min`;
  const syncStr = `${syncStats.messagesSynced}msgs ${syncStats.conversationsCreated}convos ${sessionsCount}sessions ${syncStats.errors}errs`;
  const summary = `Health: ${syncStr} | ${metricStr} (${periodMinutes}min)`;

  log(summary, "info");

  enqueueRemoteLog({
    level: "info",
    message: summary,
    metadata: {
      error_code: syncStats.errors > 0 ? `${syncStats.errors} errors` : undefined,
    },
    timestamp: now,
  });

  if (metrics.fds > FD_WARN_THRESHOLD) {
    const msg = `HIGH FD COUNT: ${metrics.fds} open file descriptors (threshold: ${FD_WARN_THRESHOLD})`;
    logWarn(msg);
    sendLogImmediate("warn", msg, { error_code: "high_fd_count" });
  }

  if (metrics.rss_mb > RSS_WARN_THRESHOLD_MB) {
    const msg = `HIGH MEMORY: ${metrics.rss_mb}MB RSS (threshold: ${RSS_WARN_THRESHOLD_MB}MB)`;
    logWarn(msg);
    sendLogImmediate("warn", msg, { error_code: "high_memory" });
  }

  syncStats.messagesSynced = 0;
  syncStats.conversationsCreated = 0;
  syncStats.sessionsActive.clear();
  syncStats.errors = 0;
  syncStats.warnings = 0;
  syncStats.lastReportTime = now;
}

function isAutostartEnabled(): boolean {
  const home = process.env.HOME || "";
  if (platform === "darwin") {
    const plistPath = path.join(home, "Library", "LaunchAgents", "sh.codecast.daemon.plist");
    return fs.existsSync(plistPath);
  } else if (platform === "linux") {
    const servicePath = path.join(home, ".config", "systemd", "user", "codecast.service");
    return fs.existsSync(servicePath);
  }
  return false;
}

const processedPollCommandIds = new Set<string>();
let backendDownSince = 0;

async function pollDaemonCommands(): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) return;
  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonVersion || "unknown",
        platform,
        pid: process.pid,
        autostart_enabled: isAutostartEnabled(),
        has_tmux: hasTmux(),
        ...syncHealthFields(),
      }),
    });
    if (!response.ok) {
      if (backendDownSince === 0) backendDownSince = Date.now();
      return;
    }
    if (backendDownSince > 0) {
      const downFor = Date.now() - backendDownSince;
      backendDownSince = 0;
      if (downFor > STUCK_CONNECTION_THRESHOLD_MS) {
        const state = readDaemonState();
        const lastHeal = state.lastSelfHealRestart || 0;
        if (Date.now() - lastHeal > SELF_HEAL_COOLDOWN_MS) {
          const downSec = Math.round(downFor / 1000);
          logLifecycle("self_heal_restart", `Backend recovered after ${downSec}s down, restarting`);
          sendLogImmediate("warn", `[LIFECYCLE] self_heal_restart: backend recovered after ${downSec}s down`, { error_code: "self_heal_restart" });
          saveDaemonState({ lastSelfHealRestart: Date.now() });
          flushRemoteLogs().then(() => triggerSelfRestart()).catch(() => triggerSelfRestart());
          return;
        }
      }
    }
    const data = await response.json();
    if (data.commands && data.commands.length > 0) {
      log(`[POLL] Received ${data.commands.length} command(s): ${data.commands.map((c: any) => c.command).join(", ")}`);
      for (const cmd of data.commands) {
        if (processedPollCommandIds.has(cmd.id)) continue;
        processedPollCommandIds.add(cmd.id);
        await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
      }
    }
  } catch {
    if (backendDownSince === 0) backendDownSince = Date.now();
  }
}

// Enumerate first-level children of the conventional project parent dirs
// ("src", "projects", "repos", "code"). Matches the same path shape produced
// by `normalizeProjectPath` in users.ts so the convex side can do a Set lookup.
// Bounded scan: only directories that actually exist on this host.
function computeLocalProjectRoots(): string[] {
  const home = process.env.HOME;
  if (!home) return [];
  const roots = new Set<string>();
  const parents = ["src", "Projects", "projects", "repos", "code"];
  for (const parent of parents) {
    const parentPath = path.join(home, parent);
    try {
      const stat = fs.statSync(parentPath);
      if (!stat.isDirectory()) continue;
      for (const child of fs.readdirSync(parentPath)) {
        if (child.startsWith(".")) continue;
        const full = path.join(parentPath, child);
        try {
          if (fs.statSync(full).isDirectory()) roots.add(full);
        } catch {}
      }
    } catch {}
  }
  // Also include any project_paths we've actually started a session in — covers
  // non-conventional locations the user has used recently.
  for (const info of startedSessionTmux.values()) {
    if (info.projectPath) {
      try {
        if (fs.statSync(info.projectPath).isDirectory()) roots.add(info.projectPath);
      } catch {}
    }
  }
  return Array.from(roots).slice(0, 300);
}

// Sync-backlog fields published on every heartbeat so the web can show a
// "sync stalled" warning while the daemon is still alive (fresh heartbeat but
// data isn't flowing). Reads the live retry queue, not the persisted state
// snapshot (which only refreshes inside the retry executor).
function syncHealthFields(): { pending_sync_count: number; oldest_pending_ms: number } {
  const health = retryQueueRef?.getHealth();
  return {
    pending_sync_count: health?.pending ?? 0,
    oldest_pending_ms: health?.oldestPendingMs ?? 0,
  };
}

async function sendHeartbeat(): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    return;
  }

  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    // Bound the request: an untimed fetch here can hang indefinitely (observed
    // on a long-running daemon), starving device presence. Fail fast + retry.
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonVersion || "unknown",
        platform,
        pid: process.pid,
        autostart_enabled: isAutostartEnabled(),
        has_tmux: hasTmux(),
        local_project_roots: computeLocalProjectRoots(),
        device_id: deviceId(),
        device_label: deviceLabel(),
        is_remote_device: process.env.CODECAST_REMOTE_DEVICE === "1",
        ...syncHealthFields(),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log(`Heartbeat failed: ${response.status} ${text}`);
      return;
    }

    const data = await response.json();
    if (data.commands && data.commands.length > 0) {
      log(`Received ${data.commands.length} remote command(s)`);
      for (const cmd of data.commands) {
        if (processedPollCommandIds.has(cmd.id)) continue;
        processedPollCommandIds.add(cmd.id);
        await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
      }
    }

    if (data.sync_mode !== undefined) {
      const currentConfig = readConfig();
      const serverMode = data.sync_mode as "all" | "selected";
      const serverProjects: string[] = data.sync_projects ?? [];
      const localMode = currentConfig?.sync_mode ?? "all";
      const localProjects = currentConfig?.sync_projects ?? [];

      if (serverMode !== localMode || JSON.stringify(serverProjects) !== JSON.stringify(localProjects)) {
        log(`Sync settings updated from server: mode=${serverMode}, projects=${serverProjects.length}`);
        patchConfig({ sync_mode: serverMode, sync_projects: serverProjects });
        if (activeConfig) {
          activeConfig.sync_mode = serverMode;
          activeConfig.sync_projects = serverProjects;
        }
      }
    }

    if (data.team_id !== undefined) {
      const currentConfig = readConfig();
      if (currentConfig && currentConfig.team_id !== data.team_id) {
        log(`Team ID updated from server: ${data.team_id}`);
        patchConfig({ team_id: data.team_id });
        if (activeConfig) {
          activeConfig.team_id = data.team_id;
        }
      }
    }

    if (data.agent_permission_modes !== undefined) {
      const currentConfig = readConfig();
      const serverModes = data.agent_permission_modes;
      const localModes = currentConfig?.agent_permission_modes;
      if (JSON.stringify(serverModes) !== JSON.stringify(localModes)) {
        log(`Agent permission modes updated from server: ${JSON.stringify(serverModes)}`);
        patchConfig({ agent_permission_modes: serverModes });
        if (activeConfig) {
          activeConfig.agent_permission_modes = serverModes;
        }
      }
    }

    if (data.agent_default_params !== undefined) {
      const currentConfig = readConfig();
      const serverParams = data.agent_default_params;
      const localParams = currentConfig?.agent_default_params;
      if (JSON.stringify(serverParams) !== JSON.stringify(localParams)) {
        log(`Agent default params updated from server: ${JSON.stringify(serverParams)}`);
        patchConfig({ agent_default_params: serverParams });
        if (activeConfig) {
          activeConfig.agent_default_params = serverParams;
        }
      }
    }
  } catch (err) {
    log(`Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function executeRemoteCommand(
  commandId: string,
  command: string,
  config: Config,
  commandArgs?: string
): Promise<void> {
  const siteUrl = config.convex_url?.replace(".cloud", ".site");
  if (!siteUrl || !config.auth_token) return;

  let result: string | undefined;
  let error: string | undefined;

  // Single-owner guard: skip session-targeted commands for conversations owned
  // by ANOTHER LIVE LOCAL device. Both daemons poll the same user-scoped command
  // queue, so without this a non-owner daemon would race the owner.
  //
  // A REMOTE owner does NOT cause a skip: it can only serve a session that was
  // explicitly moved to it, so if THIS (local) daemon received the command it has
  // the checkout and should run it — reclaiming a session the remote auto-owned
  // but can't serve. (registerManagedSession then stamps ownership back here.)
  const SESSION_COMMANDS = new Set(["resume_session", "kill_session", "send_keys", "escape", "rewind"]);
  if (SESSION_COMMANDS.has(command) && commandArgs && syncServiceRef) {
    try {
      const convId = JSON.parse(commandArgs)?.conversation_id;
      if (convId) {
        const info = await syncServiceRef.getConversationOwnerInfo(convId);
        if (info && info.ownerDeviceId !== deviceId() && info.ownerOnline && !info.ownerIsRemote) {
          log(`[OWNER] skipping ${command} for ${String(convId).slice(0, 12)} — owned by live local device ${info.ownerDeviceId.slice(0, 8)} (not ${deviceId().slice(0, 8)})`);
          return; // leave the command for the owner device
        }
      }
    } catch { /* on any error, fall through and execute (fail-open) */ }
  }

  try {
    switch (command) {
      case "status": {
        const state = readDaemonState();
        result = JSON.stringify({
          version: daemonVersion,
          platform,
          pid: process.pid,
          uptime: process.uptime(),
          autostart: isAutostartEnabled(),
          lastSync: state?.lastSyncTime,
          queueSize: state?.pendingQueueSize,
          stats: {
            messagesSynced: syncStats.messagesSynced,
            conversationsCreated: syncStats.conversationsCreated,
            activeSessions: syncStats.sessionsActive.size,
          },
        });
        log(`[REMOTE] Status requested, responding`);
        break;
      }
      case "version": {
        result = daemonVersion || "unknown";
        log(`[REMOTE] Version requested: ${result}`);
        break;
      }
      case "restart": {
        log(`[REMOTE] Restart requested`);
        result = "restarting";
        // Report result first, then restart
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            command_id: commandId,
            result,
          }),
        });
        setTimeout(() => {
          log("Restarting daemon per remote command...");
          if (isManagedByLaunchd()) {
            log("Launchd will restart daemon after exit");
          } else {
            const spawned = spawnReplacement();
            if (spawned) {
              skipRespawn = true;
            } else {
              log("spawnReplacement failed, letting exit handler respawn");
            }
          }
          setTimeout(() => process.exit(0), 500);
        }, 1000);
        return;
      }
      case "force_update": {
        const currentVersion = daemonVersion || "unknown";
        logLifecycle("update_start", `Remote update requested from v${currentVersion}`);
        result = "updating";
        // Report result first, then update
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            command_id: commandId,
            result,
          }),
        });
        // Flush logs before update
        await flushRemoteLogs();
        setTimeout(async () => {
          const result = await performUpdate();
          if (result.success) {
            logLifecycle("update_complete", `Binary replaced from v${currentVersion}, restarting`);
            await flushRemoteLogs();
            log("Update successful, restarting...");
            if (isManagedByLaunchd()) {
              log("Launchd will restart daemon after update");
            } else {
              const spawned = spawnReplacement();
              if (spawned) {
                skipRespawn = true;
              } else {
                log("spawnReplacement failed, letting exit handler respawn");
              }
            }
            setTimeout(() => process.exit(0), 500);
          } else {
            logLifecycle("update_failed", `Update failed from v${currentVersion} error=${result.error}`);
            await flushRemoteLogs();
          }
        }, 1000);
        return;
      }
      case "reinstall": {
        const currentVersion = daemonVersion || "unknown";
        log(`[REMOTE] Reinstall requested from v${currentVersion}`);
        result = "reinstalling";
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_token: config.auth_token, command_id: commandId, result }),
        }).catch(() => {});
        await flushRemoteLogs();
        setTimeout(() => {
          try {
            const { execSync } = require("child_process");
            execSync("curl -fsSL codecast.sh/install | sh", { timeout: 120000, stdio: "ignore" });
            logLifecycle("reinstall_complete", `Reinstalled from v${currentVersion}`);
          } catch (e) {
            logLifecycle("reinstall_failed", `Failed from v${currentVersion}: ${e instanceof Error ? e.message : String(e)}`);
          }
          flushRemoteLogs().finally(() => {
            setTimeout(() => process.exit(0), 500);
          });
        }, 1000);
        return;
      }
      case "run_workflow": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const workflowRunId = parsed.workflow_run_id;
        if (!workflowRunId) {
          error = "Missing workflow_run_id";
          break;
        }

        let projectPath = process.env.HOME || "/tmp";
        try {
          const resp = await fetch(`${siteUrl}/cli/workflow-runs/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_token: config.auth_token, run_id: workflowRunId }),
          });
          const data = await resp.json() as any;
          if (data.run?.project_path) {
            const vp = validatePath(data.run.project_path);
            if (vp) projectPath = vp;
          }
        } catch {}

        const shortId = workflowRunId.slice(-6);
        const tmuxSession = `wf-${shortId}`;

        if (!hasTmux()) {
          error = "tmux is not installed";
          break;
        }

        const argv1 = process.argv[1] || "";
        let castBin: string;
        if (argv1.endsWith("daemon.ts") || argv1.endsWith("daemon.js")) {
          const ext = argv1.endsWith(".ts") ? ".ts" : ".js";
          const indexPath = path.join(path.dirname(argv1), `index${ext}`);
          castBin = `${process.argv[0]} ${indexPath}`;
        } else if (argv1 === "_daemon" || !argv1.includes("/")) {
          castBin = process.execPath;
        } else {
          castBin = "cast";
        }
        const cmdText = `${castBin} workflow run-daemon ${workflowRunId}`;

        try {
          tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", projectPath], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", cmdText], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          result = JSON.stringify({ tmux_session: tmuxSession, workflow_run_id: workflowRunId });
          log(`[REMOTE] Started workflow run ${workflowRunId} in tmux: ${tmuxSession}`);
        } catch (spawnErr) {
          error = `Failed to start workflow: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
        }
        break;
      }
      case "start_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const rawAgentType = parsed.agent_type;
        const agentType: "claude" | "codex" | "cursor" | "gemini" =
          rawAgentType === "codex" || rawAgentType === "cursor" || rawAgentType === "gemini" ? rawAgentType : "claude";
        const rawPath: string = parsed.project_path || process.env.HOME || "/tmp";
        const conversationId: string | undefined = parsed.conversation_id;
        const expectedSessionId: string | undefined = parsed.session_id;
        const isolated: boolean = parsed.isolated === true;
        const worktreeName: string | undefined = parsed.worktree_name;

        const shortId = Math.random().toString(36).slice(2, 8);
        // Deterministic name keyed by conversation_id so kill/restart is a single
        // `tmux kill-session -t cc-<agent>-<convId>` with no lookup tables involved.
        const convSuffix = conversationId ? conversationId.slice(-12) : shortId;
        const tmuxSession = `cc-${agentType}-${convSuffix}`;

        // Assign claude's session id up front. `claude --session-id <uuid>` writes
        // its transcript to <uuid>.jsonl, so the daemon knows the JSONL path before
        // the process starts — no filesystem/process discovery, no cwd-based
        // matching, no hijack races. Reuse a caller-supplied id only if it's a real
        // UUID (the conversation_id is not), otherwise mint one.
        const assignedClaudeSessionId =
          agentType === "claude"
            ? (expectedSessionId && CLAUDE_UUID_RE.test(expectedSessionId) ? expectedSessionId : randomUUID())
            : undefined;

        // Resolve a usable local cwd. If `rawPath` doesn't exist on this
        // machine (conversation came from another host or was forked from
        // someone else's session), look up a local checkout for the same
        // git_remote_url. Refuse to start the session if no local checkout
        // exists — silently falling back to $HOME hides the problem and
        // makes the user's messages land in a totally wrong agent context.
        let cwd: string;
        const validatedRaw = validatePath(rawPath);
        if (validatedRaw) {
          cwd = validatedRaw;
        } else if (conversationId && syncServiceRef) {
          const projectInfo = await syncServiceRef.getProjectInfo(conversationId).catch(() => null);
          const resolved = await resolveLocalProjectPath({
            projectPath: projectInfo?.project_path ?? rawPath,
            gitRoot: projectInfo?.git_root ?? null,
            gitRemoteUrl: projectInfo?.git_remote_url ?? null,
            findCandidates: (url) => syncServiceRef!.findLocalCheckouts(url).catch(() => []),
          });
          if (!resolved) {
            // Don't clobber a session another device already owns. With device
            // routing this daemon shouldn't even receive a start_session it can't
            // run, but if it does (untargeted broadcast fallback), the machine
            // that actually has the checkout wins — we stay silent rather than
            // stamping a bogus "clone it first" banner over a live session.
            const owner = await syncServiceRef.getConversationOwner(conversationId).catch(() => null);
            if (owner && owner !== deviceId()) {
              log(`[REMOTE] start_session: no local checkout, but ${String(conversationId).slice(0, 12)} is owned by ${owner.slice(0, 8)} — staying silent`);
              break;
            }
            const remote = projectInfo?.git_remote_url ?? null;
            // Nothing to clone, nothing to point at → clear any stale banner and
            // stay silent. (Same rule as refuseResumeNoLocalCheckout.)
            if (!noLocalCheckoutBannerActionable({ remote, recordedPath: rawPath })) {
              syncServiceRef.setSessionError(conversationId).catch(() => {});
              log(`[REMOTE] start_session: no local checkout and no remote/path to act on — staying silent (cleared any stale banner)`);
              break;
            }
            error = `No local checkout for ${remote ?? "<unknown remote>"} (recorded path ${rawPath} doesn't exist here). Clone it first.`;
            log(`[REMOTE] start_session refused: ${error}`);
            syncServiceRef.setSessionError(conversationId, error).catch(() => {});
            break;
          }
          cwd = resolved.path;
          if (resolved.remapped) {
            log(`[REMOTE] start_session remapped path: ${resolved.reason}`);
          }
        } else {
          error = `Project path ${rawPath} doesn't exist`;
          log(`[REMOTE] start_session refused: ${error}`);
          break;
        }

        // Atomic pre-spawn claim: this daemon has resolved a runnable cwd, so now
        // race for ownership BEFORE spawning. Targeted commands already own the
        // conversation (no-op win). For a broadcast start_session (target couldn't
        // be resolved → every daemon with the checkout reaches here), Convex
        // serializes the claim so exactly one daemon wins; the losers skip,
        // preventing a double-spawn across machines.
        if (conversationId && syncServiceRef) {
          const claim = await syncServiceRef.claimConversationForStart(conversationId);
          if (!claim.won) {
            log(`[REMOTE] start_session: ${String(conversationId).slice(0, 12)} owned by ${claim.owner?.slice(0, 8) ?? "another live device"} — skipping spawn`);
            break;
          }
        }

        let worktreeResult: WorktreeResult | null = null;

        if (isolated && cwd) {
          const gitRoot = (() => {
            try {
              return execSync("git rev-parse --show-toplevel", {
                cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
              }).trim();
            } catch { return null; }
          })();
          if (gitRoot) {
            const wtName = worktreeName || `session-${shortId}`;
            worktreeResult = await createWorktree(gitRoot, wtName);
            if (worktreeResult) {
              cwd = worktreeResult.worktreePath;
              log(`[WORKTREE] Created isolated worktree: ${worktreeResult.worktreeName} at ${cwd}`);
            } else {
              log(`[WORKTREE] Failed to create worktree, falling back to repo root`);
            }
          }
        }

        if (agentType === "codex" && codexAppServerInstance?.binaryMissing) {
          error = "Codex is not installed. Install it from https://codex.openai.com then restart your daemon.";
          if (conversationId) {
            syncServiceRef?.setSessionError(conversationId, error).catch(() => {});
          }
          break;
        }

        let binary: string;
        let binaryArgs: string[] = [];
        if (agentType === "codex") {
          binary = "codex";
          const extraArgs = config.codex_args || "";
          if (extraArgs) binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
            if (!config.codex_args && !config.agent_permission_modes?.codex) {
              const flagFile = path.join(CONFIG_DIR, ".codex-bypass-notified");
              if (!fs.existsSync(flagFile)) {
                fs.writeFileSync(flagFile, new Date().toISOString());
                if (conversationId) {
                  syncServiceRef?.createSessionNotification({
                    conversation_id: conversationId,
                    type: "info" as any,
                    title: "Codex running in full-access mode",
                    message: "Codex is running without permission prompts by default. Configure with: cast config codex_args",
                  }).catch(() => {});
                }
              }
            }
          }
        } else if (agentType === "cursor") {
          binary = "cursor-agent";
        } else if (agentType === "gemini") {
          binary = "gemini";
        } else {
          binary = "claude";
          const extraArgs = config.claude_args || "";
          if (extraArgs) binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags && !extraArgs.includes("--dangerously-skip-permissions") && !extraArgs.includes("--permission-mode") && !extraArgs.includes("--allow-dangerously-skip-permissions")) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
          }
          if (assignedClaudeSessionId && !extraArgs.includes("--session-id")) {
            binaryArgs.push("--session-id", assignedClaudeSessionId);
          }
        }

        const defaultFlags = getDefaultParamFlags(agentType as "claude" | "codex" | "cursor" | "gemini", config);
        if (defaultFlags) {
          binaryArgs.push(...defaultFlags.split(/\s+/).filter(Boolean));
        }

        binaryArgs = sanitizeBinaryArgs(binaryArgs);
        const envPrefix = worktreeResult
          ? `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT AGENT_RESOURCE_INDEX=${worktreeResult.portIndex}`
          : `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`;
        let cmdText = `${envPrefix} ${[binary, ...binaryArgs].join(" ")}`;

        let codexThreadId: string | null = null;
        const codexSkipApprovals = binaryArgs.includes("--full-auto") || binaryArgs.includes("--dangerously-bypass-approvals-and-sandbox");
        const codexApprovalPolicy: ApprovalPolicy = codexSkipApprovals ? "never" : "on-request";
        if (agentType === "codex" && codexAppServerInstance?.running) {
          try {
            const sandbox = codexSkipApprovals ? "danger-full-access" as const : "workspace-write" as const;
            const developerInstructions = await buildCodexStableContext(config, cwd);
            const resp = await codexAppServerInstance.threadStart({
              cwd,
              sandbox,
              approvalPolicy: codexApprovalPolicy,
              ...(developerInstructions ? { developerInstructions } : {}),
            });
            codexThreadId = resp.thread.id;
            log(`[codex-app-server] pre-created thread ${codexThreadId.slice(0, 8)} (approvalPolicy=${codexApprovalPolicy})`);
          } catch (err) {
            log(`[codex-app-server] thread pre-create failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (agentType === "codex" && codexThreadId) {
          const resultObj: Record<string, any> = { agent_type: agentType, project_path: cwd, app_server_thread_id: codexThreadId };
          if (worktreeResult) {
            resultObj.worktree_name = worktreeResult.worktreeName;
            resultObj.worktree_branch = worktreeResult.worktreeBranch;
            resultObj.worktree_path = worktreeResult.worktreePath;
            resultObj.port_index = worktreeResult.portIndex;
          }
          result = JSON.stringify(resultObj);
          log(`[REMOTE] Started ${agentType} session via app-server: ${codexThreadId.slice(0, 8)} (cwd: ${cwd})`);
          if (conversationId) {
            const initialManagedSessionId = getInitialManagedSessionId(agentType, expectedSessionId, codexThreadId);
            registerAppServerConversation(conversationId, codexThreadId, { cwd, approvalPolicy: codexApprovalPolicy });
            // This device now owns and runs the session — claim it and clear any
            // stale "clone it first" error a different device may have left.
            syncServiceRef?.claimSession(conversationId).catch(logConvexFailure);
            if (initialManagedSessionId && syncServiceRef) {
              syncServiceRef.markSessionActive(conversationId).catch(logConvexFailure);
              syncServiceRef.registerManagedSession(initialManagedSessionId, process.pid, undefined, conversationId).catch(logConvexFailure);
              syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(logConvexFailure);
              ensureManagedSessionHeartbeat(initialManagedSessionId);
            }
            log(`[codex-app-server] registered conv=${conversationId.slice(0, 12)} -> thread=${codexThreadId.slice(0, 8)}`);
          }
          break;
        }

        if (!hasTmux()) {
          error = "tmux is not installed";
          break;
        }

        try {
          // Kill-before-create makes start_session idempotent: clicking the folder
          // switcher repeatedly just keeps respawning into the latest cwd.
          if (conversationId) {
            try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
            deleteStartedSession(conversationId);
            await clearConversationDeliveryAndResumeState(conversationId, undefined, "RECONFIG");
          }
          tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", cwd], { timeout: 5000 });
          // Tag the tmux so warm-restart can rebuild startedSessionTmux from `tmux ls`.
          if (conversationId) {
            await setTmuxSessionOption(tmuxSession, "@codecast_conversation_id", conversationId).catch(() => {});
          }
          await setTmuxSessionOption(tmuxSession, "@codecast_agent_type", agentType).catch(() => {});
          await setTmuxSessionOption(tmuxSession, "@codecast_project_path", cwd).catch(() => {});
          tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", cmdText], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          const resultObj: Record<string, any> = { tmux_session: tmuxSession, agent_type: agentType, project_path: cwd };
          if (worktreeResult) {
            resultObj.worktree_name = worktreeResult.worktreeName;
            resultObj.worktree_branch = worktreeResult.worktreeBranch;
            resultObj.worktree_path = worktreeResult.worktreePath;
            resultObj.port_index = worktreeResult.portIndex;
          }
          result = JSON.stringify(resultObj);
          log(`[REMOTE] Started ${agentType} session in tmux: ${tmuxSession} (cwd: ${cwd})`);
          if (conversationId) {
            const initialManagedSessionId = assignedClaudeSessionId ?? getInitialManagedSessionId(agentType, expectedSessionId);
            startedSessionTmux.set(conversationId, {
              tmuxSession,
              projectPath: cwd,
              startedAt: Date.now(),
              agentType,
              sessionId: initialManagedSessionId,
              worktreeName: worktreeResult?.worktreeName,
              worktreeBranch: worktreeResult?.worktreeBranch,
              worktreePath: worktreeResult?.worktreePath,
            });
            log(`[REMOTE] Registered started session tmux for conversation ${conversationId.slice(0, 12)}`);
            // This device now owns and runs the session — claim it and clear any
            // stale "clone it first" error a different device may have left.
            syncServiceRef?.claimSession(conversationId).catch(logConvexFailure);
            if (initialManagedSessionId) {
              registerManagedStartedSession(conversationId, initialManagedSessionId, tmuxSession);
            }
            if (agentType === "claude") {
              // `--session-id <uuid>` makes the JSONL deterministically named and
              // ensures it lands in THIS conversation's tmux, so discovery
              // tmux-exact-matches it (no cwd-fallback hijack) and the server's
              // session_id already equals the uuid (no mismatch/overwrite). We do
              // NOT pre-register conversationCache here: that would let
              // deliverMessage resolve sessionId immediately and skip the
              // readiness-gated started-tmux path, injecting the first message
              // into a still-booting prompt. Let discovery/the watcher link it.
              discoverAndLinkSession(conversationId, tmuxSession, cwd).catch(err => {
                log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
              });
            }
          }
        } catch (spawnErr) {
          error = `Failed to start session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
          log(`[REMOTE] start_session error: ${error}`);
        }
        break;
      }
      case "escape": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        if (!conversationId) {
          error = "Missing conversation_id";
          break;
        }

        const escapeThreadId = appServerConversations.get(conversationId);
        if (escapeThreadId && codexAppServerInstance?.running) {
          const activeTurnId = findActiveTurnForThread(escapeThreadId);
          if (activeTurnId) {
            await codexAppServerInstance.turnInterrupt(escapeThreadId, activeTurnId);
            result = "escape_interrupted";
            log(`[REMOTE] Interrupted app-server turn ${activeTurnId.slice(0, 8)} on thread ${escapeThreadId.slice(0, 8)}`);
          } else {
            result = "escape_no_active_turn";
            log(`[REMOTE] No active turn to interrupt on app-server thread ${escapeThreadId.slice(0, 8)}`);
          }
          break;
        }

        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape", "Escape"]);
          result = "escape_sent";
          log(`[REMOTE] Sent double Escape to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
        } else {
          try {
            process.kill(proc.pid, "SIGINT");
            result = "escape_sent_sigint";
            log(`[REMOTE] Sent SIGINT to session ${sessionId.slice(0, 8)} pid=${proc.pid}`);
          } catch (killErr) {
            error = `Failed to send SIGINT to pid ${proc.pid}: ${killErr}`;
          }
        }
        break;
      }
      case "rewind": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        const stepsBack = parsed.steps_back;
        if (!conversationId || stepsBack === undefined || stepsBack < 1) {
          error = "Missing conversation_id or invalid steps_back";
          break;
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const agentType = detectSessionAgentType(sessionId);
        if (agentType !== "claude") {
          error = `Rewind not yet supported for ${agentType} sessions`;
          break;
        }
        const proc = await findSessionProcess(sessionId, agentType);
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (!tmuxTarget || !validateTmuxTarget(tmuxTarget)) {
          error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
          break;
        }

        const safeSteps = Math.min(Math.max(1, Math.floor(Number(stepsBack))), 50);

        const PROMPT_RE = /[❯›]/;
        const BUSY_RE = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Wandering|Vibing|Coasting|Working|thinking/;
        const NAVIGATOR_RE = /Enter to continue/;
        const RESTORE_RE = /Restore conversation/;

        const captureLast = async (): Promise<string> => {
          const { stdout } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxTarget, "-S", "-8"]);
          return stdout.split("\n").slice(-15).join("\n");
        };

        const isAtPrompt = async (): Promise<boolean> => {
          const last = await captureLast();
          return PROMPT_RE.test(last) && !BUSY_RE.test(last);
        };

        const waitFor = async (test: (text: string) => boolean, label: string, maxWait = 10000): Promise<boolean> => {
          const start = Date.now();
          while (Date.now() - start < maxWait) {
            const last = await captureLast();
            if (test(last)) return true;
            await new Promise(r => setTimeout(r, 300));
          }
          log(`[REWIND] Timed out waiting for: ${label}`);
          return false;
        };

        // Step 1: Get to idle prompt (double Escape to interrupt if busy)
        if (!(await isAtPrompt())) {
          log(`[REWIND] Session not at prompt, sending double Escape to interrupt`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape", "Escape"]);
          const gotPrompt = await waitFor(
            (text) => PROMPT_RE.test(text) && !BUSY_RE.test(text),
            "prompt after interrupt",
            30000,
          );
          if (!gotPrompt) {
            error = "Timed out waiting for prompt after interrupt";
            break;
          }
          log(`[REWIND] Got prompt after interrupt`);
        }

        // Step 2: Clear any existing text (double Escape clears in CC)
        log(`[REWIND] Clearing prompt with double Escape`);
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape", "Escape"]);
        await new Promise(r => setTimeout(r, 300));

        // Step 3: Navigate history with Up arrows
        // First Up opens the visual navigator, subsequent Ups move back
        log(`[REWIND] Sending ${safeSteps} Up arrows to open navigator`);
        const upKeys = Array.from({ length: safeSteps }, () => "Up");
        await tmuxExec(["send-keys", "-t", tmuxTarget, ...upKeys]);

        // Step 4: Verify navigator opened
        const navigatorOpened = await waitFor(
          (text) => NAVIGATOR_RE.test(text),
          "navigator to open",
        );
        if (!navigatorOpened) {
          log(`[REWIND] Navigator did not open after ${safeSteps} Up arrows`);
          error = `No message found at history position ${safeSteps}`;
          break;
        }

        // Step 5: Select message in navigator (first Enter)
        log(`[REWIND] Selecting message in navigator`);
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);

        // Step 6: Confirm "Restore conversation" (second Enter)
        const atRestore = await waitFor(
          (text) => RESTORE_RE.test(text),
          "restore confirmation",
        );
        if (atRestore) {
          log(`[REWIND] Confirming restore`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
        } else {
          log(`[REWIND] No restore confirmation shown, sending Enter anyway`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
        }

        // Wait for forked session prompt with the rewound message pre-filled
        // Don't submit — let the user review/edit the message in the web UI
        await waitFor(
          (text) => PROMPT_RE.test(text) && !BUSY_RE.test(text),
          "prompt with rewound message",
          15000,
        );

        result = "rewind_sent";
        log(`[REWIND] Rewind ${stepsBack} steps sent to session ${sessionId.slice(0, 8)}`);
        break;
      }
      case "send_keys": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        const keys = parsed.keys;
        if (!conversationId || !keys) {
          error = "Missing conversation_id or keys";
          break;
        }
        const ALLOWED_KEYS = new Set(["BTab", "Escape", "Enter", "Tab", "Up", "Down", "Left", "Right", "Space", "BSpace"]);
        const keyList = keys.split(" ");
        const invalidKey = keyList.find((k: string) => !ALLOWED_KEYS.has(k));
        if (invalidKey) {
          error = `Key '${invalidKey}' not in allowlist`;
          break;
        }
        let sessionId: string | undefined;
        {
          const cache = readConversationCache();
          const reverse = buildReverseConversationCache(cache);
          sessionId = reverse[conversationId];
        }
        if (!sessionId) {
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500));
            const freshCache = readConversationCache();
            const freshReverse = buildReverseConversationCache(freshCache);
            sessionId = freshReverse[conversationId];
            if (sessionId) break;
          }
        }
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          const groups: string[][] = [];
          for (const k of keyList) {
            if (k === "Escape" || k === "Enter" || (groups.length > 0 && k !== groups[groups.length - 1][0])) {
              groups.push([k]);
            } else if (groups.length === 0) {
              groups.push([k]);
            } else {
              groups[groups.length - 1].push(k);
            }
          }
          for (let i = 0; i < groups.length; i++) {
            if (i > 0) {
              const prevKey = groups[i - 1][0];
              const needsDelay = prevKey === "Escape" || prevKey === "Enter";
              await new Promise((r) => setTimeout(r, needsDelay ? 600 : 150));
            }
            await tmuxExec(["send-keys", "-t", tmuxTarget, ...groups[i]]);
          }
          result = "keys_sent";
          log(`[REMOTE] Sent ${keys} (${groups.length} groups) to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
        } else {
          error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
        }
        break;
      }
      case "kill_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        if (!conversationId) {
          error = "Missing conversation_id";
          break;
        }

        const killThreadId = appServerConversations.get(conversationId);
        if (killThreadId && codexAppServerInstance?.running) {
          const activeTurnId = findActiveTurnForThread(killThreadId);
          if (activeTurnId) {
            try {
              await codexAppServerInstance.turnInterrupt(killThreadId, activeTurnId);
            } catch {}
          }
          removeAppServerThreadRegistration(appServerThreads, appServerConversations, conversationId, killThreadId);
          forgetPersistedAppServerConversation(conversationId);
          stopManagedSessionHeartbeat(killThreadId);
          if (syncServiceRef) {
            syncServiceRef.markSessionCompleted(conversationId).catch(logConvexFailure);
            sendAgentStatus(syncServiceRef, conversationId, killThreadId, "stopped");
          }
          result = "killed_app_server";
          log(`[REMOTE] Killed app-server thread ${killThreadId.slice(0, 8)} for conversation ${conversationId.slice(0, 12)}`);
          break;
        }

        const started = startedSessionTmux.get(conversationId);
        if (started && validateTmuxTarget(started.tmuxSession)) {
          await killTmuxSessionAndTree(started.tmuxSession);
          log(`[REMOTE] Killed started tmux session ${started.tmuxSession} (+process tree) for conversation ${conversationId.slice(0, 12)}`);
          deleteStartedSession(conversationId);
          result = "killed_tmux";
        }

        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (sessionId && !result) {
          const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
          if (proc) {
            const tmuxTarget = await findTmuxPaneForTty(proc.tty);
            if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
              const tmuxSessionName = tmuxTarget.split(":")[0];
              await killTmuxSessionAndTree(tmuxSessionName);
              await reapPidTree(proc.pid); // belt-and-suspenders for anything outside the pane
              result = "killed_tmux";
              log(`[REMOTE] Killed tmux ${tmuxSessionName} + process tree for conversation ${conversationId.slice(0, 12)}`);
            } else {
              const n = await reapPidTree(proc.pid);
              if (n > 0) {
                result = "killed_sigkill";
                log(`[REMOTE] SIGKILLed pid ${proc.pid} + descendants (${n} procs) for conversation ${conversationId.slice(0, 12)}`);
              } else {
                error = `Failed to kill pid ${proc.pid}`;
              }
            }
          }
        }

        if (sessionId) {
          const cachedTmux = resumeSessionCache.get(sessionId);
          if (cachedTmux && validateTmuxTarget(cachedTmux)) {
            await killTmuxSessionAndTree(cachedTmux);
            log(`[REMOTE] Killed cached resume tmux ${cachedTmux} (+process tree) for session ${sessionId.slice(0, 8)}`);
            resumeSessionCache.delete(sessionId);
            if (!result) result = "killed_tmux";
          }
          stopManagedSessionHeartbeat(sessionId);
          stopCodexPermissionPoller(sessionId);
          sessionProcessCache.delete(sessionId);
          resumeInFlight.delete(sessionId);
          resumeInFlightStarted.delete(sessionId);

          try {
            const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
            for (const tmuxName of tmuxList.trim().split("\n")) {
              if (!tmuxName || !(await tmuxSessionMatchesFullSessionId(tmuxName, sessionId))) continue;
              if (!validateTmuxTarget(tmuxName)) continue;
              const alive = await isTmuxAgentAlive(tmuxName);
              if (!alive) {
                await killTmuxSessionAndTree(tmuxName);
                log(`[REMOTE] Killed zombie tmux session ${tmuxName} (+process tree) for session ${sessionId}`);
                if (!result) result = "killed_zombie";
              }
            }
          } catch {}
        }

        // A kill is a clean slate. Wipe per-session/per-conversation caches that
        // would otherwise block a subsequent resume or silently suppress the next
        // injected message.
        await clearConversationDeliveryAndResumeState(conversationId, sessionId, "REMOTE");

        if (!result) result = sessionId ? "no_process" : "no_session";
        break;
      }
      case "resume_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const sessionId = parsed.session_id;
        const conversationId = parsed.conversation_id;
        if (!sessionId) {
          error = "Missing session_id";
          break;
        }
        // Fresh-session guard. If the conversation just had a session spawned
        // (startedSessionTmux still tracks it) and there's no linked Claude
        // session_id yet, an auto-resume from the UI's stuck-banner heuristic
        // will try `claude --resume <nanoid>` which can't succeed — the nanoid
        // is the optimistic id from the inline new-session flow, not a real
        // Claude UUID. We were churning through kill → repair → reconstitute
        // → start-fresh for every such call, racing the tryStartedTmux path
        // that was already about to deliver the user's first message.
        if (conversationId) {
          const startedEntry = startedSessionTmux.get(conversationId);
          if (startedEntry) {
            const cache = readConversationCache();
            const reverseCache = buildReverseConversationCache(cache);
            const linkedSessionId = reverseCache[conversationId];
            if (!linkedSessionId) {
              log(`[REMOTE] Skipping resume for ${sessionId.slice(0, 8)} — conversation ${conversationId.slice(0, 12)} has a freshly started tmux (${startedEntry.tmuxSession}) that hasn't been linked yet; tryStartedTmux will handle delivery.`);
              result = JSON.stringify({ skipped: true, reason: "fresh_session_unlinked" });
              break;
            }
          }
        }
        const projectPath = parsed.project_path;
        const forceReconstitute = parsed.force_reconstitute === true;
        const resumeAgentType: "claude" | "codex" | "cursor" | "gemini" | undefined =
          parsed.agent_type === "codex" || parsed.agent_type === "cursor" || parsed.agent_type === "gemini"
            ? parsed.agent_type : undefined;
        // Skip if a resume is already in flight for this session
        if (resumeInFlight.has(sessionId)) {
          log(`[REMOTE] Resume already in flight for ${sessionId.slice(0, 8)}, skipping`);
          result = JSON.stringify({ skipped: true, reason: "resume_in_flight" });
          break;
        }
        if (conversationId) {
          const convFailures = conversationResumeFailures.get(conversationId);
          if (convFailures && convFailures.count >= CONVERSATION_RESUME_MAX_FAILURES) {
            if (Date.now() - convFailures.lastFailure < CONVERSATION_RESUME_COOLDOWN_MS) {
              log(`[REMOTE] Resume circuit breaker for conv=${conversationId.slice(0, 12)}: ${convFailures.count} failures, cooling down`);
              result = JSON.stringify({ skipped: true, reason: "circuit_breaker" });
              break;
            }
            conversationResumeFailures.delete(conversationId);
          }
        }
        restartingSessionIds.set(sessionId, Date.now());
        let resumed = false;
        if (forceReconstitute) {
          log(`[REMOTE] Force-reconstituting session ${sessionId.slice(0, 8)} from DB${projectPath ? ` in ${projectPath}` : ""}`);
          resumed = await repairAndResumeSession(sessionId, "", readTitleCache(), projectPath, conversationId, resumeAgentType);
        } else {
          log(`[REMOTE] Force-resuming session ${sessionId.slice(0, 8)}${projectPath ? ` in ${projectPath}` : ""}`);
          resumed = await autoResumeSession(sessionId, "", readTitleCache(), projectPath, conversationId, resumeAgentType);
          if (!resumed) {
            log(`[REMOTE] Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
            resumed = await repairAndResumeSession(sessionId, "", readTitleCache(), projectPath, conversationId, resumeAgentType);
          }
        }
        if (resumed) {
          if (conversationId) {
            const cache = readConversationCache();
            cache[sessionId] = conversationId;
            saveConversationCache(cache);
            if (syncServiceRef) {
              syncServiceRef.markSessionActive(conversationId).catch(logConvexFailure);
              // Don't force "connected" here — autoResumeSession already publishes the
              // accurate status (connected once the input prompt is visible, else resuming).
              // Overriding it would re-report the false-live signal fix #1 removes.
            }
          }
          restartingSessionIds.delete(sessionId);
          if (conversationId) conversationResumeFailures.delete(conversationId);
          // A resume revives the tmux pane just like a kill+restart does, so it shares the
          // same redelivery contract: clear the local injection dedup and re-pend injected
          // messages, else the re-queued pending message hits the "injected Ns ago" dedup
          // branch and never reaches the freshly-resumed pane. (Server resumeSession already
          // re-pends in Convex; this clears the *local* state that would otherwise suppress it.)
          await clearConversationDeliveryAndResumeState(conversationId, sessionId, "resume_session");
          result = JSON.stringify({ resumed: true, session_id: sessionId });
          log(`[REMOTE] Force-resume succeeded for ${sessionId.slice(0, 8)}`);
        } else if (conversationId && projectPath) {
          // Reconstitution AND the blank-session fallback below both run in `cwd`.
          // Resolve it to a real local checkout or refuse — never $HOME, which
          // would reconstitute/spawn in the home dir and mislabel the project.
          const cwd = await resolveResumeCwdOrRefuse({ recordedCwd: projectPath, cwdOverride: projectPath, conversationId });
          if (!cwd) {
            await refuseResumeNoLocalCheckout(sessionId, conversationId, projectPath);
            restartingSessionIds.delete(sessionId);
            break;
          }
          log(`[REMOTE] Resume failed for ${sessionId.slice(0, 8)}, reconstituting session from DB in ${cwd}...`);
          let reconstituted = false;

          if (config?.convex_url && config?.auth_token) {
            try {
              const siteUrl = config.convex_url.replace(".cloud", ".site");
              const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
              if (exportData.messages.length > 0) {
                const reconAgent = resumeAgentType || "claude";
                let reconJsonl: string;
                let newSessionId: string;
                let reconFilePath: string;
                if (reconAgent === "codex") {
                  ({ jsonl: reconJsonl, sessionId: newSessionId } = generateCodexJsonl(exportData, { sessionId }));
                  reconFilePath = writeCodexSession(reconJsonl, newSessionId);
                } else {
                  const TOKEN_BUDGET = 100_000;
                  const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
                  ({ jsonl: reconJsonl, sessionId: newSessionId } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId }));
                  ({ filePath: reconFilePath } = writeClaudeCodeSession(reconJsonl, newSessionId, cwd));
                }
                setPosition(reconFilePath, fs.statSync(reconFilePath).size);
                log(`[REMOTE] Reconstituted ${reconAgent} JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} msgs)`);

                const reconResumed = await autoResumeSession(newSessionId, "", readTitleCache(), cwd, conversationId, resumeAgentType);
                if (reconResumed) {
                  const cache = readConversationCache();
                  cache[newSessionId] = conversationId;
                  saveConversationCache(cache);
                  if (syncServiceRef) {
                    syncServiceRef.markSessionActive(conversationId).catch(logConvexFailure);
                    syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(logConvexFailure);
                  }
                  restartingSessionIds.delete(sessionId);
                  if (conversationId) conversationResumeFailures.delete(conversationId);
                  // Same redelivery contract as the plain-resume branch above — clear local
                  // dedup so re-pended messages reach the reconstituted pane.
                  await clearConversationDeliveryAndResumeState(conversationId, newSessionId, "resume_session_reconstitute");
                  result = JSON.stringify({ reconstituted: true, session_id: newSessionId });
                  log(`[REMOTE] Reconstituted + resumed session ${sessionId.slice(0, 8)}`);
                  reconstituted = true;
                }
              }
            } catch (reconErr) {
              log(`[REMOTE] Reconstitution failed for ${sessionId.slice(0, 8)}: ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`);
            }
          }

          // resume_session is only triggered by explicit user actions (kill & restart,
          // repair). Always fall through to blank session — the user is asking us to restart,
          // not silently give up. Clear any stale fatal reason so it doesn't block future
          // auto-resume attempts either.
          if (!reconstituted) {
            resumeFatalReasons.delete(sessionId);
          }

          if (!reconstituted) {
            const existingStarted = startedSessionTmux.get(conversationId);
            if (existingStarted && (Date.now() - existingStarted.startedAt) < 60_000) {
              log(`[REMOTE] Fresh session ${existingStarted.tmuxSession} already started for ${conversationId.slice(0, 12)}, skipping duplicate`);
              result = JSON.stringify({ started_fresh: true, tmux_session: existingStarted.tmuxSession, deduplicated: true });
              break;
            }
            const blankAgentType = resumeAgentType || "claude";
            log(`[REMOTE] Starting blank ${blankAgentType} session in ${cwd}`);
            const shortId = Math.random().toString(36).slice(2, 8);
            const tmuxSession = `cc-${blankAgentType}-${shortId}`;
            let blankBinary: string;
            let extraFlags: string;
            if (blankAgentType === "codex") {
              blankBinary = "codex";
              extraFlags = config.codex_args || "";
            } else if (blankAgentType === "cursor") {
              blankBinary = "cursor-agent";
              extraFlags = "";
            } else if (blankAgentType === "gemini") {
              blankBinary = "gemini";
              extraFlags = "";
            } else {
              blankBinary = "claude";
              extraFlags = config.claude_args || "";
            }
            const blankArgs = extraFlags ? extraFlags.split(/\s+/).filter(Boolean) : [];
            const safeBlankArgs = sanitizeBinaryArgs(blankArgs);
            const blankCmdText = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${[blankBinary, ...safeBlankArgs].join(" ")}`;
            try {
              tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", cwd], { timeout: 5000 });
              // Tag like the other creation paths so this session is discoverable
              // by conversation (findLiveTmuxForConversation / warm-restart). Without
              // the tag it is orphaned: a later fresh-start can't see it and spawns
              // a duplicate.
              await setTmuxSessionOption(tmuxSession, "@codecast_conversation_id", conversationId).catch(() => {});
              await setTmuxSessionOption(tmuxSession, "@codecast_agent_type", blankAgentType).catch(() => {});
              await setTmuxSessionOption(tmuxSession, "@codecast_project_path", cwd).catch(() => {});
              tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", blankCmdText], { timeout: 5000 });
              tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
              startedSessionTmux.set(conversationId, {
                tmuxSession,
                projectPath: cwd,
                startedAt: Date.now(),
                agentType: blankAgentType,
              });
              discoverAndLinkSession(conversationId, tmuxSession, cwd).catch(err => {
                log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
              });
              result = JSON.stringify({ started_fresh: true, tmux_session: tmuxSession });
              log(`[REMOTE] Started fresh session ${tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
            } catch (spawnErr) {
              error = `Failed to start fresh session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
            }
          }
        } else {
          error = `Failed to resume session ${sessionId.slice(0, 8)} — session file may not exist locally`;
        }
        if (!resumed && conversationId) {
          const prev = conversationResumeFailures.get(conversationId) || { count: 0, lastFailure: 0 };
          conversationResumeFailures.set(conversationId, { count: prev.count + 1, lastFailure: Date.now() });
        }
        break;
      }
      case "config_list": {
        const home = process.env.HOME || "";
        const claudeDir = path.join(home, ".claude");
        const codexDir = path.join(home, ".codex");

        type ConfigFile = { path: string; type: string; label: string; tool: string };
        const files: ConfigFile[] = [];

        const addFile = (filePath: string, type: string, label: string, tool: string) => {
          if (fs.existsSync(filePath)) files.push({ path: filePath, type, label, tool });
        };

        const addDir = (dir: string, type: string, tool: string) => {
          if (!fs.existsSync(dir)) return;
          try {
            for (const f of fs.readdirSync(dir)) {
              const fullPath = path.join(dir, f);
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                // Skills are directories containing SKILL.md
                const skillFile = path.join(fullPath, "SKILL.md");
                if (fs.existsSync(skillFile)) {
                  files.push({ path: skillFile, type, label: f, tool });
                }
              } else if (f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".toml")) {
                files.push({ path: fullPath, type, label: f.replace(/\.(md|json|toml)$/, ""), tool });
              }
            }
          } catch {}
        };

        // Claude global files
        addFile(path.join(claudeDir, "CLAUDE.md"), "instructions", "Global CLAUDE.md", "claude");
        addFile(path.join(claudeDir, "settings.json"), "settings", "settings.json", "claude");
        addFile(path.join(claudeDir, "settings.local.json"), "settings", "settings.local.json", "claude");
        addFile(path.join(claudeDir, "keybindings.json"), "keybindings", "keybindings.json", "claude");
        addDir(path.join(claudeDir, "agents"), "agent", "claude");
        addDir(path.join(claudeDir, "commands"), "command", "claude");
        addDir(path.join(claudeDir, "skills"), "skill", "claude");
        addDir(path.join(claudeDir, "prompts"), "prompt", "claude");

        // Codex global files
        addFile(path.join(codexDir, "AGENTS.md"), "instructions", "Global AGENTS.md", "codex");
        addFile(path.join(codexDir, "AGENTS.override.md"), "instructions", "AGENTS.override.md", "codex");
        addFile(path.join(codexDir, "config.toml"), "settings", "config.toml", "codex");
        addDir(path.join(codexDir, "prompts"), "command", "codex");
        addDir(path.join(codexDir, "skills"), "skill", "codex");
        if (fs.existsSync(path.join(codexDir, "rules"))) {
          for (const f of fs.readdirSync(path.join(codexDir, "rules"))) {
            files.push({ path: path.join(codexDir, "rules", f), type: "rules", label: f, tool: "codex" });
          }
        }

        // Per-project files from known project paths
        const args_parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const projectPaths: string[] = args_parsed.project_paths || [];
        for (const pp of projectPaths) {
          const p = validatePath(pp);
          if (!p) continue;
          const name = path.basename(p);
          addFile(path.join(p, "CLAUDE.md"), "project_instructions", `${name}/CLAUDE.md`, "claude");
          addFile(path.join(p, "AGENTS.md"), "project_instructions", `${name}/AGENTS.md`, "codex");
          addFile(path.join(p, ".claude", "settings.json"), "project_settings", `${name}/.claude/settings.json`, "claude");
          addFile(path.join(p, ".claude", "settings.local.json"), "project_settings", `${name}/.claude/settings.local.json`, "claude");
          addFile(path.join(p, ".mcp.json"), "mcp", `${name}/.mcp.json`, "claude");
          addFile(path.join(p, ".codex", "config.toml"), "project_settings", `${name}/.codex/config.toml`, "codex");
          addDir(path.join(p, ".claude", "agents"), "project_agent", "claude");
          addDir(path.join(p, ".claude", "skills"), "project_skill", "claude");
          addDir(path.join(p, ".claude", "commands"), "project_command", "claude");
        }

        result = JSON.stringify(files);
        break;
      }
      case "config_read": {
        const { file_path: readPath } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!readPath || typeof readPath !== "string") {
          error = "Missing file_path";
          break;
        }
        const home = process.env.HOME || "";
        const allowed = [path.join(home, ".claude"), path.join(home, ".codex")];
        const resolved = path.resolve(readPath);
        const isAllowed = allowed.some((a) => resolved.startsWith(a + path.sep) || resolved === a) ||
          readPath.endsWith("/CLAUDE.md") || readPath.endsWith("/AGENTS.md") ||
          readPath.endsWith("/.mcp.json") || readPath.endsWith("/settings.json") ||
          readPath.endsWith("/settings.local.json") || readPath.endsWith("/config.toml") ||
          readPath.includes("/.claude/") || readPath.includes("/.codex/");
        if (!isAllowed) {
          error = "Path not allowed";
          break;
        }
        if (!fs.existsSync(resolved)) {
          result = JSON.stringify({ content: null, exists: false });
        } else {
          const content = fs.readFileSync(resolved, "utf-8");
          result = JSON.stringify({ content, exists: true });
        }
        break;
      }
      case "config_write": {
        const { file_path: writePath, content: writeContent } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!writePath || typeof writePath !== "string" || typeof writeContent !== "string") {
          error = "Missing file_path or content";
          break;
        }
        const home = process.env.HOME || "";
        const allowed = [path.join(home, ".claude"), path.join(home, ".codex")];
        const resolved = path.resolve(writePath);
        const isAllowed = allowed.some((a) => resolved.startsWith(a + path.sep)) ||
          writePath.endsWith("/CLAUDE.md") || writePath.endsWith("/AGENTS.md") ||
          writePath.endsWith("/.mcp.json") || writePath.endsWith("/settings.json") ||
          writePath.endsWith("/settings.local.json") || writePath.endsWith("/config.toml") ||
          writePath.includes("/.claude/") || writePath.includes("/.codex/");
        if (!isAllowed) {
          error = "Path not allowed";
          break;
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, writeContent, "utf-8");
        result = JSON.stringify({ success: true });
        log(`[CONFIG] Wrote ${resolved}`);
        break;
      }
      case "config_create": {
        const { dir_path, filename, content: createContent = "" } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!dir_path || !filename) {
          error = "Missing dir_path or filename";
          break;
        }
        const home = process.env.HOME || "";
        const allowedDirs = [
          path.join(home, ".claude", "agents"),
          path.join(home, ".claude", "commands"),
          path.join(home, ".claude", "skills"),
          path.join(home, ".claude", "prompts"),
          path.join(home, ".codex", "prompts"),
          path.join(home, ".codex", "skills"),
        ];
        const expandedDir = dir_path.startsWith("~/") ? path.join(home, dir_path.slice(2)) : dir_path;
        const resolvedDir = path.resolve(expandedDir);
        if (!allowedDirs.some((a) => resolvedDir === a || resolvedDir.startsWith(a + path.sep))) {
          error = "Dir not allowed";
          break;
        }
        if (!/^[a-zA-Z0-9_-]+\.(md|json|toml)$/.test(filename)) {
          error = "Invalid filename";
          break;
        }
        const newPath = path.join(resolvedDir, filename);
        if (fs.existsSync(newPath)) {
          error = "File already exists";
          break;
        }
        fs.mkdirSync(resolvedDir, { recursive: true });
        fs.writeFileSync(newPath, createContent, "utf-8");
        result = JSON.stringify({ success: true, path: newPath });
        log(`[CONFIG] Created ${newPath}`);
        break;
      }
      case "config_delete": {
        const { file_path: deletePath } = commandArgs ? JSON.parse(commandArgs) : {};
        if (!deletePath || typeof deletePath !== "string") {
          error = "Missing file_path";
          break;
        }
        const home = process.env.HOME || "";
        const allowedDirs = [
          path.join(home, ".claude", "agents"),
          path.join(home, ".claude", "commands"),
          path.join(home, ".claude", "skills"),
          path.join(home, ".claude", "prompts"),
          path.join(home, ".codex", "prompts"),
          path.join(home, ".codex", "skills"),
        ];
        const expandedDelete = deletePath.startsWith("~/") ? path.join(home, deletePath.slice(2)) : deletePath;
        const resolved = path.resolve(expandedDelete);
        if (!allowedDirs.some((a) => resolved.startsWith(a + path.sep))) {
          error = "Only files in agents/commands/skills/prompts dirs can be deleted";
          break;
        }
        if (!fs.existsSync(resolved)) {
          error = "File not found";
          break;
        }
        fs.unlinkSync(resolved);
        result = JSON.stringify({ success: true });
        log(`[CONFIG] Deleted ${resolved}`);
        break;
      }
      case "move_to_device": {
        // Web-triggered move: THIS (source) daemon performs the local-only
        // transfer to the destination device, then flips ownership + resumes
        // there. Only reaches us because the command was target_device_id'd to us.
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const sessionId: string | undefined = parsed.session_id;
        const conversationId: string | undefined = parsed.conversation_id;
        const toDeviceId: string | undefined = parsed.to_device_id;
        if (!sessionId || !conversationId || !toDeviceId) {
          error = "move_to_device: missing session_id/conversation_id/to_device_id";
          break;
        }
        log(`[MOVE] moving ${sessionId.slice(0, 8)} -> device ${toDeviceId.slice(0, 8)}`);
        const host = loadRemoteHost();
        const move = performMoveToRemote(host, sessionId);
        log(`[MOVE] transferred to ${host.user}@${host.address}:${move.remoteCwd}; flipping ownership + resuming`);
        await syncServiceRef!.getClient().mutation("devices:moveSessionToDevice" as any, {
          api_token: config.auth_token,
          conversation_id: conversationId,
          owner_device_id: toDeviceId,
          project_path: move.remoteCwd,
          resume: true,
        });
        // Stop the local copy of this session so only the destination runs it.
        await clearConversationDeliveryAndResumeState(conversationId, sessionId, "move_to_device").catch(() => {});
        result = JSON.stringify({ moved: true, to: toDeviceId, remoteCwd: move.remoteCwd });
        log(`[MOVE] done — ${sessionId.slice(0, 8)} now owned by ${toDeviceId.slice(0, 8)}`);
        break;
      }
      default:
        error = `Unknown command: ${command}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Report result
  try {
    await fetch(`${siteUrl}/cli/command-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        command_id: commandId,
        result,
        error,
      }),
    });
  } catch {
    // Ignore
  }
}

async function flushRemoteLogs(): Promise<void> {
  await flushRemoteLogsViaHttp();
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

type ConfigDiagnosis =
  | { ok: true; config: Config; convexUrl: string }
  | { ok: false; reason: string };

function diagnoseConfig(): ConfigDiagnosis {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { ok: false, reason: "Waiting for configuration... (run 'cast auth' to set up)" };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  } catch (err) {
    return {
      ok: false,
      reason: `[ERROR] Cannot read ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let config: Config;
  try {
    config = JSON.parse(raw) as Config;
  } catch (err) {
    return {
      ok: false,
      reason: `[ERROR] ${CONFIG_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)} — run 'cast auth' to recreate`,
    };
  }
  if (config.auth_token && isEncryptedToken(config.auth_token)) {
    try {
      config.auth_token = decryptToken(config.auth_token);
    } catch (err) {
      if (err instanceof TokenDecryptError) {
        return {
          ok: false,
          reason: `[ERROR] Auth token cannot be decrypted on this machine (${err.message}) — run 'cast auth' to re-encrypt`,
        };
      }
      throw err;
    }
  }
  if (!config.user_id) {
    return { ok: false, reason: `[ERROR] ${CONFIG_FILE} is missing user_id — run 'cast auth' to fix` };
  }
  const convexUrl = config.convex_url || process.env.CONVEX_URL;
  if (!convexUrl) {
    return {
      ok: false,
      reason: `[ERROR] ${CONFIG_FILE} is missing convex_url and CONVEX_URL is not set — run 'cast auth' to fix`,
    };
  }
  return { ok: true, config, convexUrl };
}

function readConfig(): Config | null {
  const diag = diagnoseConfig();
  return diag.ok ? diag.config : null;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export async function buildCodexStableContext(config: Config | null, cwd?: string): Promise<string | undefined> {
  const stableMode = config?.stable_mode;
  if (!stableMode || !config?.auth_token || !config?.convex_url) return undefined;

  const projectPath = config.stable_global ? undefined : cwd;
  const lookbackDays = stableMode === "team" ? 14 : 7;
  const limit = stableMode === "team" ? 15 : 10;
  const siteUrl = config.convex_url.replace(".cloud", ".site");

  try {
    const response = await fetch(`${siteUrl}/cli/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        limit,
        offset: 0,
        start_time: Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
        project_path: projectPath,
      }),
    });

    const result = await response.json() as any;
    if (!response.ok || result?.error) return undefined;

    const feed = stripAnsi(formatFeedResults(result, { projectPath }));
    const instruction = stableMode === "team"
      ? "This gives you bigger-picture visibility on what has been and is being worked on by the team."
      : "This gives you bigger-picture visibility on what you have been and are currently working on.";

    return `<stable-context mode="${stableMode}">
${instruction}

${feed}
</stable-context>`;
  } catch {
    return undefined;
  }
}

function patchConfig(updates: Partial<Config>): void {
  const config = readConfig();
  if (!config) return;
  Object.assign(config, updates);
  const toWrite = { ...config };
  if (toWrite.auth_token && !isEncryptedToken(toWrite.auth_token)) {
    toWrite.auth_token = encryptToken(toWrite.auth_token);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
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

let projectMapCache: Record<string, string> | null = null;
function readProjectMap(): Record<string, string> {
  if (projectMapCache) return projectMapCache;
  try {
    projectMapCache = JSON.parse(fs.readFileSync(PROJECT_MAP_FILE, "utf-8")) as Record<string, string>;
  } catch {
    projectMapCache = {};
  }
  return projectMapCache;
}

// Remember that a repo identified by `key` (its basename, or a recorded remote path)
// lives at `localDir` on this machine. Gated to actual git-repo roots so the map stays a
// small, accurate index — this excludes $HOME, /tmp, and parent dirs like ~/src that a
// project-dir scan would otherwise decode and record as misleading entries. Only persists
// real, changed entries.
function recordProjectMapping(key: string, localDir: string): void {
  if (!key || !localDir) return;
  if (!fs.existsSync(path.join(localDir, ".git"))) return;
  const map = readProjectMap();
  if (map[key] === localDir) return;
  map[key] = localDir;
  try {
    fs.writeFileSync(PROJECT_MAP_FILE, JSON.stringify(map, null, 2));
    projectMapCache = map;
  } catch {}
}

function readTitleCache(): TitleCache {
  const cacheFile = path.join(CONFIG_DIR, "titles.json");
  if (!fs.existsSync(cacheFile)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as TitleCache;
  } catch {
    return {};
  }
}

function saveTitleCache(cache: TitleCache): void {
  const cacheFile = path.join(CONFIG_DIR, "titles.json");
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

function generateTitleFromMessage(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const cmdNameMatch = trimmed.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmdNameMatch) return `/${cmdNameMatch[1].replace(/^\//, "")}`;

  const cmdMsgMatch = trimmed.match(/<command-message>([^<]*)<\/command-message>/);
  if (cmdMsgMatch) return `/${cmdMsgMatch[1].replace(/^\//, "")}`;

  const cleaned = trimmed
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  const result = cleaned || trimmed;
  if (result.length <= 50) {
    return result;
  }

  return result.slice(0, 50) + "...";
}

function readDaemonState(): DaemonState {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as DaemonState;
  } catch {
    return {};
  }
}

function saveDaemonState(updates: Partial<DaemonState>): void {
  try {
    const current = readDaemonState();
    const newState = { ...current, ...updates, timestamp: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`Failed to write daemon state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleAuthFailure(): boolean {
  const state = readDaemonState();
  const currentCount = (state.authFailureCount || 0) + 1;

  if (currentCount >= AUTH_FAILURE_THRESHOLD) {
    logError(`Auth failed ${currentCount} times consecutively - marking auth as expired`);
    saveDaemonState({ authExpired: true, authFailureCount: currentCount });
    return true;
  }

  log(`Auth failure ${currentCount}/${AUTH_FAILURE_THRESHOLD} - will retry`);
  saveDaemonState({ authFailureCount: currentCount });
  return false;
}

function resetAuthFailureCount(): void {
  const state = readDaemonState();
  if (state.authFailureCount && state.authFailureCount > 0) {
    saveDaemonState({ authFailureCount: 0 });
  }
}

interface GitInfo {
  commitHash?: string;
  branch?: string;
  remoteUrl?: string;
  status?: string;
  diff?: string;
  diffStaged?: string;
  root?: string;
  repoRoot?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
}

function isPathExcluded(projectPath: string, excludedPaths?: string): boolean {
  if (!excludedPaths || !projectPath) {
    return false;
  }

  const paths = excludedPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);

  for (const excludedPath of paths) {
    const normalizedExcluded = path.resolve(excludedPath);
    const normalizedProject = path.resolve(projectPath);

    if (normalizedProject.startsWith(normalizedExcluded)) {
      return true;
    }
  }

  return false;
}

function isProjectAllowedToSync(projectPath: string, config: Config): boolean {
  if (!config.sync_mode || config.sync_mode === "all") {
    return true;
  }

  if (!config.sync_projects || config.sync_projects.length === 0) {
    return false;
  }

  const normalizedProject = path.resolve(projectPath);
  return config.sync_projects.some(allowed => {
    const normalizedAllowed = path.resolve(allowed);
    return normalizedProject === normalizedAllowed || normalizedProject.startsWith(normalizedAllowed + path.sep);
  });
}

function getGitInfo(projectPath: string): GitInfo | undefined {
  const execGit = (args: string): string | undefined => {
    try {
      return execSync(`git ${args}`, {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch {
      return undefined;
    }
  };

  const commitHash = execGit("rev-parse HEAD");
  if (!commitHash) {
    return undefined;
  }

  const branch = execGit("rev-parse --abbrev-ref HEAD");
  const remoteUrl = execGit("remote get-url origin");
  const status = execGit("status --porcelain");
  const diff = execGit("diff");
  const diffStaged = execGit("diff --cached");
  const root = execGit("rev-parse --show-toplevel");

  const commonDir = execGit("rev-parse --path-format=absolute --git-common-dir");
  const repoRoot = commonDir?.endsWith("/.git") ? commonDir.slice(0, -5) : root;

  const worktreeMatch = projectPath.match(/(?:\.codecast\/worktrees|\.conductor|\.claude-worktrees\/[^/]+)\/([^/]+)/);
  const worktreeName = worktreeMatch ? worktreeMatch[1] : undefined;

  return {
    commitHash,
    branch,
    remoteUrl,
    status,
    diff: diff ? diff.slice(0, 100000) : undefined,
    diffStaged: diffStaged ? diffStaged.slice(0, 100000) : undefined,
    root,
    repoRoot,
    worktreeName,
    worktreeBranch: worktreeName ? branch : undefined,
    worktreePath: worktreeName ? projectPath : undefined,
  };
}

const CODECAST_WORKTREE_DIR = ".codecast/worktrees";

interface WorktreeResult {
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  portIndex: number;
}

/**
 * Create or attach to a worktree.
 *
 * Two paths:
 *   1. NEW: if .codecast/workspace.toml exists, delegate to the workspace
 *      module (full manifest-driven setup: copy, install, hooks, contract).
 *      Project the resulting Workspace to the legacy WorktreeResult shape.
 *   2. LEGACY: minimal git worktree + .wt-setup-files copy. Preserved
 *      verbatim for repos that haven't opted in.
 *
 * On any failure of the new path, we fall through to the legacy path so the
 * daemon never regresses below pre-integration capability.
 */
async function createWorktree(
  repoRoot: string,
  name: string,
): Promise<WorktreeResult | null> {
  const manifestPath = path.join(repoRoot, ".codecast/workspace.toml");
  if (fs.existsSync(manifestPath)) {
    try {
      const ws = await import("./workspace/index.js");
      const result = await ws.acquireWorkspace(repoRoot, name);
      log(
        `[WORKTREE] new-path: ${name} state=${result.workspace.state} detected=${result.workspace.manifest.detected ?? "none"}`,
      );
      if (result.workspace.state === "ready") {
        return ws.toWorktreeResult(result.workspace);
      }
      // Broken contract — log details and fall through to legacy as safety net.
      const failures = result.workspace.contract?.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}${c.reason ? `: ${c.reason}` : ""}`)
        .join("; ");
      log(`[WORKTREE] new-path ${name} broken, falling back. failures: ${failures}`);
    } catch (err) {
      log(`[WORKTREE] new-path ${name} threw, falling back: ${(err as Error).message}`);
    }
  }
  return createWorktreeLegacy(repoRoot, name);
}

function createWorktreeLegacy(repoRoot: string, name: string): WorktreeResult | null {
  const worktreeDir = path.join(repoRoot, CODECAST_WORKTREE_DIR);
  const worktreePath = path.join(worktreeDir, name);
  const branchName = `codecast/${name}`;

  if (fs.existsSync(worktreePath)) {
    const existingBranch = (() => {
      try {
        return execSync(`git rev-parse --abbrev-ref HEAD`, {
          cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch { return branchName; }
    })();
    return {
      worktreePath,
      worktreeName: name,
      worktreeBranch: existingBranch,
      portIndex: assignPortIndex(repoRoot),
    };
  }

  fs.mkdirSync(worktreeDir, { recursive: true });

  // Retry loop to handle concurrent git lock contention
  let created = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      try { execSync(`sleep ${(200 + attempt * 300) / 1000}`, { stdio: "ignore" }); } catch {}
    }
    try {
      execSync(`git worktree add -b ${branchName} ${worktreePath}`, {
        cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
      created = true;
      break;
    } catch (err) {
      // Branch already exists — try without -b
      try {
        execSync(`git worktree add ${worktreePath} ${branchName}`, {
          cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        created = true;
        break;
      } catch (err2) {
        lastErr = err2;
      }
    }
  }

  if (!created) {
    log(`[WORKTREE] Failed to create worktree: ${lastErr}`);
    return null;
  }

  // Remove large build artifact directories that bloat the worktree
  const LARGE_ARTIFACT_DIRS = ["packages/desktop/src-tauri/target"];
  for (const dir of LARGE_ARTIFACT_DIRS) {
    const fullPath = path.join(worktreePath, dir);
    if (fs.existsSync(fullPath)) {
      try { execSync(`/bin/rm -rf ${JSON.stringify(fullPath)}`, { stdio: "ignore" }); } catch {}
    }
  }

  copySetupFiles(repoRoot, worktreePath);

  return {
    worktreePath,
    worktreeName: name,
    worktreeBranch: branchName,
    portIndex: assignPortIndex(repoRoot),
  };
}

function assignPortIndex(repoRoot: string): number {
  const worktreeDir = path.join(repoRoot, CODECAST_WORKTREE_DIR);
  if (!fs.existsSync(worktreeDir)) return 0;
  const existing = fs.readdirSync(worktreeDir).filter(f => {
    try { return fs.statSync(path.join(worktreeDir, f)).isDirectory(); } catch { return false; }
  });
  return Math.min(existing.length - 1, 9);
}

function copySetupFiles(mainRoot: string, worktreePath: string): void {
  const configFile = path.join(mainRoot, ".wt-setup-files");
  const patterns = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    : [".env", ".env.local"];

  for (const pattern of patterns) {
    const src = path.join(mainRoot, pattern);
    const dest = path.join(worktreePath, pattern);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      const destDir = path.dirname(dest);
      fs.mkdirSync(destDir, { recursive: true });
      if (fs.statSync(src).isDirectory()) {
        execSync(`cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" });
      } else {
        fs.copyFileSync(src, dest);
      }
    } catch {}
  }
}

function decodeProjectDirName(dirName: string): string {
  const stripped = dirName.startsWith("-") ? dirName.slice(1) : dirName;
  const tokens = stripped.split("-");

  let resolved = "/";
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i] === "") { i++; continue; }
    let matched = false;
    for (let len = tokens.length - i; len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join("-");
      if (fs.existsSync(path.join(resolved, candidate))) {
        resolved = path.join(resolved, candidate);
        i += len;
        matched = true;
        break;
      }
      if (fs.existsSync(path.join(resolved, "." + candidate))) {
        resolved = path.join(resolved, "." + candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      resolved = path.join(resolved, tokens[i]);
      i++;
    }
  }

  return resolved;
}

// A transcript's cwd never changes, so memoize the (small) head read by file.
const transcriptProjectPathCache = new Map<string, string>();

/**
 * Project path for a discovered transcript file. Trusts the cwd recorded INSIDE
 * the transcript over the (lossy, copyable) ~/.claude/projects folder slug — a
 * transcript resumed/copied into a foreign or $HOME dir would otherwise mislabel
 * the conversation (e.g. "/Users/m1"). See pickProjectPath for the rule.
 * `dirName` is the project-dir slug (the folder name).
 */
function resolveTranscriptProjectPath(filePath: string, dirName: string): string {
  const cached = transcriptProjectPathCache.get(filePath);
  if (cached !== undefined) return cached;
  const decodedSlugPath = decodeProjectDirName(dirName);
  let recordedCwd: string | undefined;
  try { recordedCwd = extractCwd(readFileHead(filePath, 65536)); } catch {}
  const result = pickProjectPath({ decodedSlugPath, recordedCwd, home: process.env.HOME });
  // Only memoize a trustworthy answer: a found cwd, or a slug that resolved to a
  // real non-$HOME project. A not-yet-populated transcript (no cwd line yet)
  // stays re-checkable so a transient guess isn't cached for the session's life.
  if (recordedCwd || (decodedSlugPath && decodedSlugPath !== process.env.HOME)) {
    transcriptProjectPathCache.set(filePath, result);
  }
  return result;
}

async function flushPendingMessagesBatch(
  pendingMsgs: Array<{ uuid?: string; role: "human" | "assistant" | "system"; content: string; timestamp: number; thinking?: string; toolCalls?: any; toolResults?: any; images?: any; subtype?: string }>,
  conversationId: string,
  syncService: SyncService,
  retryQueue: RetryQueue,
): Promise<void> {
  try {
    await syncService.addMessages({
      conversationId,
      messages: pendingMsgs.map(msg => ({
        messageUuid: msg.uuid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype,
      })),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isStaleConversationError(errMsg)) {
      log(`Batch pending flush hit stale conversation ${conversationId}; dropping batch so the caller can re-resolve: ${errMsg}`);
      return;
    }
    log(`Batch pending flush failed, queueing individually: ${errMsg}`);
    for (const msg of pendingMsgs) {
      retryQueue.add("addMessage", {
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
      }, errMsg);
    }
  }
}

type RawMessage = { uuid?: string; role: string; content: string; timestamp: number; thinking?: string; toolCalls?: any; toolResults?: any; images?: any; subtype?: string };

// A cached conversation_id can become invalid against the current api_token in two ways:
// the conversation was deleted (Convex returns "Conversation not found") or the auth token
// now belongs to a different user (Convex returns "Unauthorized: can only add messages to
// your own conversations"). Both mean: drop the cache, let createConversation re-resolve
// by (session_id, current user_id). Retrying without re-resolving spins forever.
function isStaleConversationError(errMsg: string): boolean {
  return errMsg.includes("Conversation not found") ||
    errMsg.includes("Unauthorized: can only add messages to your own conversations");
}

function mapRole(role: string): "human" | "assistant" | "system" {
  return role === "user" ? "human" : role === "system" ? "system" : "assistant";
}

function prepMessageForSync(msg: RawMessage): { messageUuid?: string; role: "human" | "assistant" | "system"; content: string; timestamp: number; thinking?: string; toolCalls?: any; toolResults?: any; images?: any; subtype?: string } {
  return {
    messageUuid: msg.uuid,
    role: mapRole(msg.role),
    content: redactSecrets(msg.content),
    timestamp: msg.timestamp,
    thinking: msg.thinking,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
    images: msg.images,
    subtype: msg.subtype,
  };
}

async function syncMessagesBatch(
  messages: RawMessage[],
  conversationId: string,
  syncService: SyncService,
  retryQueue: RetryQueue,
): Promise<{ authExpired: boolean; conversationNotFound: boolean }> {
  // Prepare + offload images ONCE. offloadImages mutates the prepared messages in
  // place (raw base64 → storageId, or drops oversized images), so the same small
  // array is reused for the send, the inline retry, and the retry-queue enqueue.
  // Previously each of those re-ran messages.map(prepMessageForSync), so the queue
  // persisted the full raw base64 and every retry re-uploaded the same image.
  const prepared = messages.map(prepMessageForSync);
  await syncService.offloadImages(prepared);
  if (retryQueue.hasPendingConversation(conversationId)) {
    log(`Conversation ${conversationId.slice(0, 12)} already has retry backlog; buffering ${messages.length} new msgs into retry queue`);
    retryQueue.add("addMessages", {
      conversationId,
      messages: prepared,
    }, "conversation backlog already queued");
    return { authExpired: false, conversationNotFound: false };
  }
  try {
    await syncService.addMessages({
      conversationId,
      messages: prepared,
    });
    resetAuthFailureCount();
    // If we just synced a user message from the JSONL, ack any injected pending messages
    // This confirms the session received the injected text
    if (messages.some(m => m.role === "user")) {
      syncService.ackInjectedMessages(conversationId).catch(logConvexFailure);
    }
    return { authExpired: false, conversationNotFound: false };
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      if (handleAuthFailure()) {
        return { authExpired: true, conversationNotFound: false };
      }
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    if (isStaleConversationError(errMsg)) {
      return { authExpired: false, conversationNotFound: true };
    }

    log(`Batch sync failed (${messages.length} msgs), retrying batch once: ${errMsg}`);
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await syncService.addMessages({
        conversationId,
        messages: prepared,
      });
      resetAuthFailureCount();
      log(`Batch retry succeeded for ${messages.length} messages`);
      return { authExpired: false, conversationNotFound: false };
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (isStaleConversationError(retryErrMsg)) {
        return { authExpired: false, conversationNotFound: true };
      }
      log(`Batch retry also failed, queueing as batch: ${retryErrMsg}`);
      retryQueue.add("addMessages", {
        conversationId,
        messages: prepared,
      }, retryErrMsg);
      return { authExpired: false, conversationNotFound: false };
    }
  }
}

function readFileHead(filePath: string, maxBytes: number = 8192): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readFileTail(filePath: string, maxBytes: number = 8192): string {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const offset = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readFileHeadAndTail(filePath: string, headBytes: number = 8192, tailBytes: number = 8192): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= headBytes + tailBytes) {
    return fs.readFileSync(filePath, "utf-8");
  }
  const head = readFileHead(filePath, headBytes);
  const tail = readFileTail(filePath, tailBytes);
  return head + "\n" + tail;
}

const bakImageRecoveryDone = new Set<string>();

function recoverImagesFromBackup(
  messages: ParsedMessage[],
  bakPath: string,
  logFn: (msg: string) => void,
): ParsedMessage[] {
  const unavailableToolIds = new Set<string>();
  for (const msg of messages) {
    if (!msg.toolResults) continue;
    for (const tr of msg.toolResults) {
      if (tr.content === "[result unavailable]") {
        unavailableToolIds.add(tr.toolUseId);
      }
    }
  }
  if (unavailableToolIds.size === 0) return messages;

  let bakContent: string;
  try {
    bakContent = fs.readFileSync(bakPath, "utf-8");
  } catch {
    return messages;
  }

  const bakMessages = parseSessionFile(bakContent);
  const imageMap = new Map<string, { mediaType: string; data: string; toolUseId?: string }>();
  for (const bm of bakMessages) {
    if (!bm.images) continue;
    for (const img of bm.images) {
      if (img.toolUseId && unavailableToolIds.has(img.toolUseId)) {
        imageMap.set(img.toolUseId, img);
      }
    }
  }

  if (imageMap.size === 0) return messages;
  logFn(`Recovered ${imageMap.size} images from backup file`);

  for (const msg of messages) {
    if (!msg.toolResults) continue;
    const recovered: typeof msg.images = [];
    for (const tr of msg.toolResults) {
      const img = imageMap.get(tr.toolUseId);
      if (img) {
        recovered.push(img);
      }
    }
    if (recovered.length > 0) {
      msg.images = [...(msg.images || []), ...recovered];
    }
  }

  return messages;
}

/**
 * Resolve which queued subagent→parent links can be established now that
 * `justCreatedSessionId` has been created and cached.
 *
 * Two orderings can leave a subagent orphaned, so both are handled here:
 *  - this session is the PARENT of children still in the pending map, or
 *  - this session is itself a pending CHILD whose parent was created while
 *    our own createConversation await was still in flight (the parent-side
 *    drain ran before we were cached and could not see us).
 *
 * Pure so it can be unit-tested without the daemon's async machinery.
 */
export function resolvePendingSubagentLinks(
  justCreatedSessionId: string,
  justCreatedConvId: string,
  pending: Map<string, string>,
  cache: Record<string, string>,
): Array<{ parentConvId: string; childConvId: string; childSessionId: string; parentSessionId: string }> {
  const links: Array<{ parentConvId: string; childConvId: string; childSessionId: string; parentSessionId: string }> = [];
  for (const [childSessionId, parentSessionId] of pending) {
    if (parentSessionId === justCreatedSessionId) {
      // We are the parent: link any child already cached.
      const childConvId = cache[childSessionId];
      if (childConvId) {
        links.push({ parentConvId: justCreatedConvId, childConvId, childSessionId, parentSessionId });
      }
    } else if (childSessionId === justCreatedSessionId) {
      // We are the child: link to our parent if it is now cached.
      const parentConvId = cache[parentSessionId];
      if (parentConvId) {
        links.push({ parentConvId, childConvId: justCreatedConvId, childSessionId, parentSessionId });
      }
    }
  }
  return links;
}

// Cap how many bytes a single sync pass reads from a file. A large unsynced
// backlog (e.g. an old, image-heavy session that gets resumed) used to be re-read
// in full every pass and synced as one all-or-nothing batch — which never completed
// within the sync window on an actively-growing file, so the position never advanced
// and the backlog grew without bound. Reading a bounded window and advancing the
// position after each successfully-synced chunk makes progress monotonic and
// guarantees convergence.
const SYNC_BYTES_PER_PASS = 4 * 1024 * 1024;
// How many bounded passes one invocation will chain before yielding to the next
// file-watch event / watchdog. Drains up to SYNC_BYTES_PER_PASS * this per trigger
// so a large idle backlog catches up fast instead of trickling at the 5-min watchdog.
const MAX_SYNC_CONTINUATIONS = 6;

async function processSessionFile(
  filePath: string,
  sessionId: string,
  projectPath: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  titleCache: TitleCache,
  updateStateCallback: () => void,
  parentConversationId?: string,
  overrideAgentType?: "claude_code",
  continuationDepth: number = 0,
): Promise<void> {
  const isSubagent = filePath.split(path.sep).includes("subagents");
    let lastPosition = getPosition(filePath);
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }

  
  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }

  if (stats.size <= lastPosition) {
    // Nothing new to read, but the watchdog uses sync-ledger.json (NOT
    // positions.json) to decide which files are "stale". If we return without
    // updating the ledger, findStaleSessionFiles will re-detect this file
    // forever — burning ~15s of event-loop time every 5 min and head-of-line-
    // blocking incoming Convex commands (start_session etc.). Bring the ledger
    // up to the actual read position so the file stops re-appearing as stale.
    const existing = getSyncRecord(filePath);
    if (!existing || existing.lastSyncedPosition < lastPosition) {
      const knownConvId = conversationCache[sessionId];
      markSynced(filePath, lastPosition, 0, knownConvId);
    }
    return;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const available = stats.size - lastPosition;
    // Read at most SYNC_BYTES_PER_PASS so a large backlog drains in bounded,
    // convergent steps (see constant above) rather than one giant batch.
    let readLen = Math.min(available, SYNC_BYTES_PER_PASS);
    let buffer = Buffer.alloc(readLen);
    fs.readSync(fd, buffer, 0, readLen, lastPosition);
    let rawContent = buffer.toString("utf-8");
    let lastNewline = rawContent.lastIndexOf("\n");
    // A single JSONL entry larger than the cap (e.g. a big inlined image) has no
    // newline within the capped window. Read the whole remaining file so we never
    // stall forever on one oversized line.
    if (lastNewline < 0 && readLen < available) {
      readLen = available;
      buffer = Buffer.alloc(readLen);
      fs.readSync(fd, buffer, 0, readLen, lastPosition);
      rawContent = buffer.toString("utf-8");
      lastNewline = rawContent.lastIndexOf("\n");
    }
    fs.closeSync(fd);

    // Only process complete lines — a trailing partial line (no newline at end)
    // may be a large JSONL entry (e.g. screenshot) still being written.
    // By not advancing the position past incomplete data, we re-read it next poll.
    const newContent = lastNewline >= 0 ? rawContent.slice(0, lastNewline + 1) : "";
    const bytesConsumed = lastNewline >= 0 ? Buffer.byteLength(rawContent.slice(0, lastNewline + 1), "utf-8") : 0;
    if (!newContent) {
      // No complete lines yet — don't advance position
      return;
    }
    const LARGE_BATCH_BYTES = 64 * 1024;
    if (bytesConsumed >= LARGE_BATCH_BYTES) {
      log(`Processing ${bytesConsumed} bytes for session ${sessionId.slice(0, 8)} (from position ${lastPosition})`);
    }
    let messages = parseSessionFile(newContent);

    const bakPath = filePath + ".bak";
    if (!bakImageRecoveryDone.has(filePath) && fs.existsSync(bakPath)) {
      bakImageRecoveryDone.add(filePath);
      messages = recoverImagesFromBackup(messages, bakPath, log);
    }

    if (permissionJustResolved.has(sessionId)) {
      const before = messages.length;
      messages = messages.filter(m => !(m.role === "user" && /^[yn]$/i.test(m.content?.trim())));
      if (messages.length < before) {
        log(`Filtered ${before - messages.length} permission response message(s) for session ${sessionId.slice(0, 8)}`);
      }
      permissionJustResolved.delete(sessionId);
    }

    let conversationId = conversationCache[sessionId];

    // Check for summary title using the already-read new chunk + small tail read
    if (conversationId) {
      let titleContent: string;
      try {
        titleContent = newContent + "\n" + readFileTail(filePath, 4096);
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, lastPosition + bytesConsumed);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(titleContent);
      if (summaryTitle && titleCache[sessionId] !== summaryTitle) {
        try {
          await syncService.updateTitle(conversationId, summaryTitle);
          titleCache[sessionId] = summaryTitle;
          saveTitleCache(titleCache);
          log(`Updated title for session ${sessionId}: ${summaryTitle}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Failed to update title: ${errMsg}`);
        }
      }

      if (!planHandoffChecked.has(sessionId)) {
        planHandoffChecked.add(sessionId);
        let headContent: string;
        try {
          headContent = readFileHead(filePath, 16384);
        } catch { headContent = ""; }
        const headMessages = parseSessionFile(headContent);
        const userMsgs = headMessages.filter(m => m.role === "user").slice(0, 3);
        for (const msg of userMsgs) {
          if (!msg.content) continue;
          const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
          if (handoffMatch) {
            const jsonlPath = handoffMatch[1];
            const parentSessionMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (parentSessionMatch) {
              const parentSessionId = parentSessionMatch[1];
              const parentConvId = conversationCache[parentSessionId];
              if (parentConvId) {
                try {
                  await syncService.linkPlanHandoff(parentConvId, conversationId);
                  planHandoffChildren.set(parentConvId, conversationId);
                  log(`Retroactive plan handoff: linked ${sessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
                } catch (err) {
                  log(`Failed retroactive plan handoff link: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
            break;
          }
        }
      }
    }

  if (messages.length === 0) {
    setPosition(filePath, lastPosition + bytesConsumed);
    return;
  }

  if (!conversationId) {
    let headContent: string;
    try {
      headContent = readFileHead(filePath, 16384);
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
        return;
      }
      throw err;
    }

    try {
      const slug = extractSlug(headContent);
      const parentMessageUuid = extractParentUuid(headContent);
      const firstMessageTimestamp = messages[0]?.timestamp;
      const dirName = path.basename(path.dirname(filePath));
      const decodedPath = dirName ? decodeProjectDirName(dirName) : undefined;
      const actualProjectPath = pickProjectPath({
        decodedSlugPath: decodedPath || projectPath,
        recordedCwd: extractCwd(headContent),
        home: process.env.HOME,
      });
      const gitInfo = actualProjectPath ? getGitInfo(actualProjectPath) : undefined;

      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      // Detect parent conversation from file path (subagents/) or content (plan handoff)
      let isPlanHandoff = false;
      if (!parentConversationId) {
        const parts = filePath.split(path.sep);
        const isSubagentFile = parts.includes("subagents");
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          const parentSessionId = parts[subagentsIdx - 1];
          if (parentSessionId && conversationCache[parentSessionId]) {
            parentConversationId = conversationCache[parentSessionId];
            log(`Detected subagent parent for ${sessionId}: ${parentConversationId}`);
          } else if (parentSessionId) {
            pendingSubagentParents.set(sessionId, parentSessionId);
            log(`Subagent ${sessionId} parent ${parentSessionId} not cached yet, queued for linking`);
          }
        }
      }
      if (!parentConversationId) {
        const userMessages = messages.filter(msg => msg.role === "user").slice(0, 3);
        for (const msg of userMessages) {
          if (!msg.content) continue;
          const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
          if (handoffMatch) {
            const jsonlPath = handoffMatch[1];
            const parentSessionMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (parentSessionMatch) {
              const parentSessionId = parentSessionMatch[1];
              if (conversationCache[parentSessionId]) {
                parentConversationId = conversationCache[parentSessionId];
                isPlanHandoff = true;
                log(`Detected plan handoff parent for ${sessionId}: ${parentConversationId} (from ${parentSessionId})`);
              }
            }
            break;
          }
        }
      }

      // Detect parent from tmux spawn tracking (agent-spawn.sh / tmux new-session called by another session)
      if (!parentConversationId && tmuxSpawnedBySession.size > 0) {
        const spawnProc = await findSessionProcess(sessionId, "claude").catch(() => null);
        if (spawnProc) {
          let childTmuxName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
          if (!childTmuxName) {
            const pane = await findTmuxPaneForTty(spawnProc.tty);
            if (pane) {
              childTmuxName = pane.split(":")[0];
              cacheSessionProcess(sessionId, spawnProc, pane);
            }
          }
          if (childTmuxName && tmuxSpawnedBySession.has(childTmuxName)) {
            parentConversationId = tmuxSpawnedBySession.get(childTmuxName)!;
            log(`Detected tmux-spawned parent for ${sessionId.slice(0, 8)}: ${parentConversationId.slice(0, 12)} via tmux session ${childTmuxName}`);
          }
        }
      }

      if (!conversationId) {
        const freshCache = readConversationCache();
        if (freshCache[sessionId]) {
          conversationId = freshCache[sessionId];
          conversationCache[sessionId] = conversationId;
          log(`Session ${sessionId.slice(0, 8)} already linked to ${conversationId.slice(0, 12)} by background discovery, skipping match`);
        }
      }

      let matchedStartedConversation: string | null = null;
      if (!conversationId && startedSessionTmux.size > 0 && !isSubagent && !parentConversationId) {
        const startedClaudeEntries = Array.from(startedSessionTmux.entries())
          .filter(([, entry]) => entry.agentType === "claude");
        const proc = await findSessionProcess(sessionId, "claude").catch(() => null);
        let tmuxSessionName: string | null = null;
        if (proc) {
          tmuxSessionName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
          if (!tmuxSessionName) {
            const tmuxPane = await findTmuxPaneForTty(proc.tty);
            if (tmuxPane) {
              tmuxSessionName = tmuxPane.split(":")[0];
              cacheSessionProcess(sessionId, proc, tmuxPane);
            }
          }
        }
        matchedStartedConversation = matchStartedConversation(startedClaudeEntries, {
          tmuxSessionName,
          // Only allow the cwd fallback when the process wasn't found at all
          // (still spawning). A located process that isn't in our tmux belongs
          // to someone else — see matchStartedConversation.
          projectPath: proc ? null : actualProjectPath,
        });
        if (matchedStartedConversation && tmuxSessionName) {
          log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via tmux ${tmuxSessionName}`);
        } else if (matchedStartedConversation && actualProjectPath) {
          log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via projectPath fallback`);
        }
      }

      // Re-check after async gap: discoverAndLinkSession may have linked during findSessionProcess/findTmuxPaneForTty
      if (!conversationId && conversationCache[sessionId]) {
        conversationId = conversationCache[sessionId];
        matchedStartedConversation = null;
        log(`Session ${sessionId.slice(0, 8)} already linked to ${conversationId.slice(0, 12)} by discovery (post-async), skipping match/create`);
      }

        if (conversationId) {
          // Already linked by background discovery — skip matching and creation
        } else if (matchedStartedConversation) {
          conversationId = matchedStartedConversation;
          const tmuxEntry = startedSessionTmux.get(matchedStartedConversation);
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          // Reconcile project_path/git_root to the real session cwd: the stub
          // was created (e.g. from the web) before this session existed, so its
          // stored path is a guess that may not match where the session runs.
          syncService.updateSessionId(conversationId, sessionId, actualProjectPath || undefined, gitInfo?.repoRoot || gitInfo?.root).catch(logConvexFailure);
          if (tmuxEntry) {
          registerManagedStartedSession(conversationId, sessionId, tmuxEntry.tmuxSession);
          if (tmuxEntry.sessionId && tmuxEntry.sessionId !== sessionId) {
            stopManagedSessionHeartbeat(tmuxEntry.sessionId);
          }
          }
          deleteStartedSession(matchedStartedConversation);
          log(`Linked session ${sessionId} to existing started conversation ${conversationId}`);
        if (parentConversationId) {
          syncService.linkSessions(parentConversationId, conversationId, subagentDescriptions.get(sessionId)).then(() => {
            log(`Linked started conversation ${conversationId.slice(0, 12)} to parent ${parentConversationId!.slice(0, 12)}`);
          }).catch((err) => {
            log(`Failed to link started conversation to parent: ${err}`);
          });
        }
      } else {
        const cliFlags = detectCliFlags(headContent + "\n" + newContent);
        let subagentDescription: string | undefined;
        let subagentAgentType: string | undefined;
        if (isSubagent) {
          try {
            const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
              if (meta.description) {
                subagentDescription = meta.description;
                subagentDescriptions.set(sessionId, meta.description);
              }
              if (meta.agentType) subagentAgentType = meta.agentType;
            }
          } catch {}
        }
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: overrideAgentType || "claude_code",
          projectPath: actualProjectPath,
          slug,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: isPlanHandoff ? "plan-handoff" : (parentConversationId ? undefined : parentMessageUuid),
          parentConversationId,
          gitInfo,
          cliFlags: cliFlags || undefined,
          subagentDescription,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        if (isPlanHandoff && parentConversationId) {
          planHandoffChildren.set(parentConversationId, conversationId);
          log(`Registered plan handoff: parent ${parentConversationId.slice(0, 12)} -> child ${conversationId.slice(0, 12)}`);
        }
        log(`Created conversation ${conversationId} for session ${sessionId}`);
        syncStats.conversationsCreated++;
        syncSkillsForConversation(conversationId, actualProjectPath, syncService);

        // Create plan entity for Plan-type subagents and bind to parent conversation
        if (subagentAgentType === "Plan" && parentConversationId && !planModeSynced.has(sessionId)) {
          planModeSynced.add(sessionId);
          const pathParts = filePath.split(path.sep);
          const subIdx = pathParts.lastIndexOf("subagents");
          const parentSessionUuid = subIdx >= 1 ? pathParts[subIdx - 1] : undefined;
          if (parentSessionUuid) {
            syncService.syncPlanFromPlanMode({
              sessionId: parentSessionUuid,
              planContent: `# ${subagentDescription || "Plan"}`,
              projectPath: actualProjectPath,
            }).then((planShortId) => {
              if (planShortId) {
                planModePlanMap.set(sessionId, planShortId);
                savePlanModeCache();
                log(`Created plan ${planShortId} for Plan subagent ${sessionId.slice(0, 8)}, bound to parent ${parentSessionUuid.slice(0, 8)}`);
              }
            }).catch((err) => {
              log(`Failed to create plan for Plan subagent: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }

        // Detect tmux and register managed session
        findSessionProcess(sessionId, "claude").then((proc) => {
          if (!proc) return;
          findTmuxPaneForTty(proc.tty).then((tmuxPane) => {
            const tmuxSessionName = tmuxPane?.split(":")[0];
            syncService.registerManagedSession(sessionId, proc.pid, tmuxSessionName, conversationId).catch(logConvexFailure);
            if (tmuxSessionName) log(`Registered managed session for ${sessionId.slice(0, 8)} (tmux: ${tmuxSessionName})`);
          }).catch(() => {
            syncService.registerManagedSession(sessionId, process.pid, undefined, conversationId).catch(logConvexFailure);
          });
        }).catch(() => {
          syncService.registerManagedSession(sessionId, process.pid, undefined, conversationId).catch(logConvexFailure);
        });

        // Resolve pending subagent links now that this session is cached —
        // both when it is the parent of queued children AND when it is itself a
        // queued child whose parent appeared during our in-flight create.
        for (const link of resolvePendingSubagentLinks(sessionId, conversationId, pendingSubagentParents, conversationCache)) {
          syncService.linkSessions(link.parentConvId, link.childConvId, subagentDescriptions.get(link.childSessionId)).then(() => {
            log(`Linked pending subagent ${link.childSessionId.slice(0, 8)} -> parent ${link.parentSessionId.slice(0, 8)}`);
          }).catch((err) => {
            log(`Failed to link subagent ${link.childSessionId.slice(0, 8)}: ${err}`);
          });
          pendingSubagentParents.delete(link.childSessionId);
        }
      }

      if ((global as any).activeSessions) {
        (global as any).activeSessions.set(conversationId, {
          sessionId,
          conversationId,
          projectPath: actualProjectPath || "",
        });
      }

      if (pendingMessages[sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
        delete pendingMessages[sessionId];
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          setPosition(filePath, lastPosition + bytesConsumed);
          return;
        }
        // Let it fall through to retry queue
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to create conversation, queueing for retry: ${errMsg}`);

      if (!pendingMessages[sessionId]) {
        pendingMessages[sessionId] = [];
      }
      for (const msg of messages) {
        pendingMessages[sessionId].push({
          uuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          filePath,
          fileSize: stats.size,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype,
        });
      }

      let retryHeadContent: string;
      try {
        retryHeadContent = readFileHead(filePath, 16384);
      } catch (readErr: any) {
        if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for retry queue. Skipping.`);
          setPosition(filePath, lastPosition + bytesConsumed);
          return;
        }
        throw readErr;
      }

      const slug = extractSlug(retryHeadContent);
      const firstMsgTimestamp = messages[0]?.timestamp;
      const retryDirName = path.basename(path.dirname(filePath));
      const retryDecoded = retryDirName ? decodeProjectDirName(retryDirName) : undefined;
      const retryProjectPath = pickProjectPath({
        decodedSlugPath: retryDecoded || projectPath,
        recordedCwd: extractCwd(retryHeadContent),
        home: process.env.HOME,
      });
      const gitInfo = retryProjectPath ? getGitInfo(retryProjectPath) : undefined;

      retryQueue.add("createConversation", {
        userId,
        teamId,
        sessionId,
        agentType: overrideAgentType || "claude_code",
        projectPath: retryProjectPath,
        slug,
        startedAt: firstMsgTimestamp,
        gitInfo,
      }, errMsg);

      setPosition(filePath, lastPosition + bytesConsumed);
      return;
    }
  }

  // Intercept plan mode tool calls (ExitPlanMode, TaskCreate, TaskUpdate) and sync to Convex
  if (conversationId && (newContent.includes("ExitPlanMode") || newContent.includes("TaskCreate") || newContent.includes("TaskUpdate"))) {
    const lines = newContent.split("\n");
    for (const line of lines) {
      if (!line.includes("ExitPlanMode") && !line.includes("TaskCreate") && !line.includes("TaskUpdate")) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type !== "tool_use") continue;

          if (block.name === "ExitPlanMode" && block.input?.plan && !planModeSynced.has(sessionId)) {
            planModeSynced.add(sessionId);
            const dirName = path.basename(path.dirname(filePath));
            const projPath = dirName ? resolveTranscriptProjectPath(filePath, dirName) : undefined;
            try {
              const planShortId = await syncService.syncPlanFromPlanMode({
                sessionId,
                planContent: block.input.plan,
                projectPath: projPath,
              });
              if (planShortId) {
                planModePlanMap.set(sessionId, planShortId);
                savePlanModeCache();
              }
              log(`Synced plan_mode plan ${planShortId} for session ${sessionId.slice(0, 8)} (${block.input.plan.length} chars)`);
            } catch (err) {
              log(`Failed to sync plan_mode: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (block.name === "TaskCreate" && block.input?.subject) {
            const taskMap = planModeTaskMap.get(sessionId) || new Map();
            const localId = String(taskMap.size + 1);
            try {
              const shortId = await syncService.syncTaskFromPlanMode({
                sessionId,
                title: block.input.subject,
                description: block.input.description,
                planShortId: planModePlanMap.get(sessionId),
              });
              if (shortId) {
                taskMap.set(localId, shortId);
                planModeTaskMap.set(sessionId, taskMap);
                savePlanModeCache();
                log(`Synced task ${shortId} from TaskCreate in session ${sessionId.slice(0, 8)}: ${block.input.subject}`);
              }
            } catch (err) {
              log(`Failed to sync TaskCreate: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (block.name === "TaskUpdate" && block.input?.taskId && block.input?.status) {
            const taskMap = planModeTaskMap.get(sessionId);
            const shortId = taskMap?.get(String(block.input.taskId));
            if (shortId) {
              const rawStatus = String(block.input.status);
              const statusMap: Record<string, string> = {
                pending: "open",
                open: "open",
                backlog: "backlog",
                in_progress: "in_progress",
                in_review: "in_review",
                completed: "done",
                done: "done",
                deleted: "dropped",
                cancelled: "dropped",
                dropped: "dropped",
              };
              const status = statusMap[rawStatus];
              if (!status) {
                log(`Skipping TaskUpdate sync for ${shortId}: unknown status "${rawStatus}"`);
              } else {
                try {
                  await syncService.updateTaskStatus(shortId, status, sessionId);
                  log(`Updated task ${shortId} -> ${status} in session ${sessionId.slice(0, 8)}`);
                } catch (err) {
                  log(`Failed to sync TaskUpdate: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  // Detect tmux session spawns in bash tool calls (agent-spawn.sh, tmux new-session)
  if (conversationId && (newContent.includes("agent-spawn") || newContent.includes("tmux new-session") || newContent.includes("new-session"))) {
    const spawnLines = newContent.split("\n");
    for (const spawnLine of spawnLines) {
      if (!spawnLine.includes("agent-spawn") && !spawnLine.includes("new-session")) continue;
      try {
        const entry = JSON.parse(spawnLine);
        const msg = entry.message || entry;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type !== "tool_use") continue;
          const cmd = block.input?.command;
          if (typeof cmd !== "string") continue;
          let spawnMatch = cmd.match(/agent-spawn(?:\.sh)?\s+\S+\s+["']?([^\s"']+)["']?/);
          if (!spawnMatch) {
            spawnMatch = cmd.match(/tmux\s+new-session\s+(?:.*?\s)?-s\s+["']?([^\s"']+)["']?/);
          }
          if (spawnMatch) {
            const tmuxName = spawnMatch[1];
            tmuxSpawnedBySession.set(tmuxName, conversationId);
            log(`Tracked tmux spawn: ${tmuxName} -> parent ${conversationId.slice(0, 12)}`);
            // Retroactively link if child session was already created
            for (const [childSid, info] of sessionProcessCache) {
              if (info.tmuxTarget?.split(":")[0] === tmuxName && conversationCache[childSid]) {
                const childConvId = conversationCache[childSid];
                syncService.linkSessions(conversationId, childConvId).then(() => {
                  log(`Retroactively linked tmux-spawned child ${childSid.slice(0, 8)} -> parent ${conversationId.slice(0, 12)}`);
                }).catch(err => {
                  log(`Failed retroactive tmux spawn link: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            }
          }
        }
      } catch {}
    }
  }

  syncSkillsForConversation(conversationId, projectPath, syncService);

  const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
  if (batchResult.authExpired) {
    log("⚠️  Authentication expired - sync paused");
    return;
  }
  if (batchResult.conversationNotFound) {
    log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
    delete conversationCache[sessionId];
    saveConversationCache(conversationCache);

    let recreateHeadContent: string;
    try {
      recreateHeadContent = readFileHead(filePath, 16384);
    } catch (readErr: any) {
      if (readErr.code === 'EACCES' || readErr.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath} for conversation recreation. Skipping.`);
        setPosition(filePath, lastPosition + bytesConsumed);
        return;
      }
      throw readErr;
    }

    const slug = extractSlug(recreateHeadContent);
    const firstMessageTimestamp = messages[0]?.timestamp;
    const recreateDirName = path.basename(path.dirname(filePath));
    const recreateDecoded = recreateDirName ? decodeProjectDirName(recreateDirName) : undefined;
    const recreateProjectPath = pickProjectPath({
      decodedSlugPath: recreateDecoded || projectPath,
      recordedCwd: extractCwd(recreateHeadContent),
      home: process.env.HOME,
    });
    const gitInfo = recreateProjectPath ? getGitInfo(recreateProjectPath) : undefined;

    try {
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: overrideAgentType || "claude_code",
        projectPath: recreateProjectPath,
        slug,
        title,
        startedAt: firstMessageTimestamp,
        gitInfo,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Recreated conversation ${conversationId} for session ${sessionId}`);

      await syncService.addMessages({
        conversationId,
        messages: messages.map(prepMessageForSync),
      });
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log(`Failed to recreate conversation and add messages: ${retryErrMsg}`);
    }
  }

    setPosition(filePath, lastPosition + bytesConsumed);
    markSynced(filePath, lastPosition + bytesConsumed, messages.length, conversationId);
    log(`Synced ${messages.length} messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "claude");

    const askTc = messages.flatMap(m => m.toolCalls || []).find((tc: any) => tc.name === "AskUserQuestion");
    if (askTc && !pendingInteractivePrompts.has(sessionId)) {
      const inp = askTc.input as any;
      const options = inp?.questions?.[0]?.options || [];
      pendingInteractivePrompts.set(sessionId, { timestamp: Date.now(), options });
      log(`AskUserQuestion in JSONL for ${sessionId.slice(0, 8)}, set pending prompt guard`);
      if (conversationId) {
        sendAgentStatus(syncService, conversationId, sessionId, "permission_blocked");
      }
    }

    const lastMessage = messages[messages.length - 1];
    const wasInterrupted = lastMessage?.role === "user" &&
      isInterruptControlMessage(lastMessage.content);

    const lastAssistantMessage = messages.filter(m => m.role === "assistant").pop();
    if (lastAssistantMessage && conversationId) {
      const permissionPrompt = detectPermissionPrompt(lastAssistantMessage.content);
      if (permissionPrompt && !permissionRecordPending.has(sessionId)) {
        log(`Permission prompt detected for tool: ${permissionPrompt.tool_name}`);
        permissionRecordPending.add(sessionId);
        permissionJustResolved.add(sessionId);
        sendAgentStatus(syncService, conversationId, sessionId, "permission_blocked");

        const permArgPreview = truncateForNotification(
          `${permissionPrompt.tool_name}: ${permissionPrompt.arguments_preview || ""}`, 150
        );
        syncService.createSessionNotification({
          conversation_id: conversationId,
          type: "permission_request",
          title: `codecast - Permission needed`,
          message: permArgPreview,
        }).catch(() => {});

        handlePermissionRequest(
          syncService,
          conversationId,
          sessionId,
          permissionPrompt,
          log
        ).then((decision) => {
          if (decision) {
            const key = decision.approved ? "Enter" : "Escape";
            log(`Attempting to inject '${key}' to session ${sessionId.slice(0, 8)}`);

            findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
              if (!proc) {
                log("No process found for session");
                return;
              }
              findTmuxPaneForTty(proc.tty).then(async (tmuxTarget) => {
                try {
                  if (tmuxTarget) {
                    await tmuxExec(["send-keys", "-t", tmuxTarget, key]);
                    log(`Injected '${key}' via tmux for session ${sessionId.slice(0, 8)}`);
                  } else {
                    await injectViaTerminal(proc.tty, decision.approved ? "\r" : "\x1b", proc.termProgram);
                    log(`Injected '${key}' via terminal for session ${sessionId.slice(0, 8)}`);
                  }
                } catch (err) {
                  log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                }
              });
            }).catch((err) => {
              log(`Failed to find Claude session: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else {
            log("Permission request timed out or failed");
          }
          permissionRecordPending.delete(sessionId);
        }).catch((err) => {
          log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
          permissionRecordPending.delete(sessionId);
        });
      }

      if (!permissionPrompt) {
        const existingTimer = idleTimers.get(sessionId);
        if (existingTimer) clearTimeout(existingTimer);

        if (wasInterrupted) {
          idleTimers.delete(sessionId);
          lastIdleNotifiedSize.set(sessionId, stats.size);
          sendAgentStatus(syncService, conversationId, sessionId, "idle");
        } else if (lastHookStatus.has(sessionId)) {
          // Single-writer rule: when the status hook is active for a session,
          // its handler is the only emitter of agent_status. The transcript
          // watcher used to second-guess it via a 30s recency cliff plus a
          // size-debounced fallback, which produced working/idle flap whenever
          // the model paused mid-turn between tool calls.
          idleTimers.delete(sessionId);
        } else {
          // No hook history — fall back to transcript heuristics. This path is
          // for sessions where the codecast status hook isn't installed.
          const hasPendingToolCalls = (lastAssistantMessage.toolCalls?.length ?? 0) > 0 &&
            !messages.some(m => m.role === "assistant" && (m.toolResults?.length ?? 0) > 0 &&
              m.timestamp >= lastAssistantMessage.timestamp);

          if (hasPendingToolCalls) {
            sendAgentStatus(syncService, conversationId, sessionId, "working");
            idleTimers.delete(sessionId);
          } else if (lastAssistantMessage.stopReason === "end_turn") {
            idleTimers.delete(sessionId);
            const capturedSize = stats.size;
            if (capturedSize !== lastIdleNotifiedSize.get(sessionId)) {
              lastIdleNotifiedSize.set(sessionId, capturedSize);
              const preview = isSubagent ? undefined : truncateForNotification(lastAssistantMessage.content);
              sendAgentStatus(syncService, conversationId, sessionId, "idle", undefined, undefined, preview);
            }
          } else {
            sendAgentStatus(syncService, conversationId, sessionId, "working");
            const capturedSize = stats.size;
            const capturedConvId = conversationId;

            if (capturedSize !== lastIdleNotifiedSize.get(sessionId)) {
              lastIdleNotifiedSize.set(sessionId, capturedSize);
              idleTimers.set(sessionId, setTimeout(() => {
                idleTimers.delete(sessionId);
                const preview = isSubagent ? undefined : truncateForNotification(lastAssistantMessage.content);
                sendAgentStatus(syncService, capturedConvId, sessionId, "idle", undefined, undefined, preview);
              }, IDLE_DEBOUNCE_MS));
            }
          }
        }
      }
    } else if (conversationId) {
      const existingTimer = idleTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        idleTimers.delete(sessionId);
      }
      if (wasInterrupted) {
        // Interruption message arrived without an assistant message in this batch
        // (assistant messages were already synced earlier). Transition to idle immediately.
        log(`Interrupted session detected (no assistant msg in batch): ${sessionId.slice(0, 8)}, setting idle`);
        lastIdleNotifiedSize.set(sessionId, stats.size);
        sendAgentStatus(syncService, conversationId, sessionId, "idle");
      } else {
        lastIdleNotifiedSize.delete(sessionId);
      }
    }

    updateStateCallback();

    // Drain any remaining known backlog in bounded passes instead of waiting for the
    // next file-watch event or the 5-min watchdog. markSynced/setPosition above have
    // already advanced the position, so each continuation is durable forward progress
    // and the next pass picks up from the new position.
    if (
      bytesConsumed > 0 &&
      lastPosition + bytesConsumed < stats.size &&
      continuationDepth < MAX_SYNC_CONTINUATIONS
    ) {
      await processSessionFile(
        filePath,
        sessionId,
        projectPath,
        syncService,
        userId,
        teamId,
        conversationCache,
        retryQueue,
        pendingMessages,
        titleCache,
        updateStateCallback,
        parentConversationId,
        overrideAgentType,
        continuationDepth + 1,
      );
    }
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
    log(`processSessionFile failed for ${sessionId.slice(0, 8)} at position=${lastPosition}: ${errMsg}${stack}`);
    throw err;
  }
}

async function processCursorSession(
  dbPath: string,
  sessionId: string,
  workspacePath: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  updateStateCallback: () => void
): Promise<void> {
  const syncedCount = getPosition(dbPath);

  let result: { messages: ParsedMessage[]; maxRowId: number; totalCount: number };
  try {
    result = extractMessagesFromCursorDb(dbPath, syncedCount);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${dbPath}. Will retry when permissions are restored.`);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to extract messages from Cursor DB: ${errMsg}`);
    return;
  }

  const { messages, totalCount } = result;

  if (messages.length === 0) {
    return;
  }

  let conversationId = conversationCache[sessionId];

  if (!conversationId) {
    try {
      const firstMessageTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        title,
        startedAt: firstMessageTimestamp,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for Cursor session ${sessionId}`);

      if (pendingMessages[sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
        delete pendingMessages[sessionId];
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          setPosition(dbPath, totalCount);
          return;
        }
        // Let it fall through to retry queue
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to create Cursor conversation, queueing for retry: ${errMsg}`);

      if (!pendingMessages[sessionId]) {
        pendingMessages[sessionId] = [];
      }
      for (const msg of messages) {
        pendingMessages[sessionId].push({
          uuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          filePath: dbPath,
          fileSize: totalCount,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype,
        });
      }

      const firstMsgTimestamp = messages[0]?.timestamp;

      retryQueue.add("createConversation", {
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        startedAt: firstMsgTimestamp,
      }, errMsg);

      setPosition(dbPath, totalCount);
      return;
    }
  }

  const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
  if (batchResult.authExpired) {
    log("⚠️  Authentication expired - sync paused");
    return;
  }
  if (batchResult.conversationNotFound) {
    log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
    delete conversationCache[sessionId];
    saveConversationCache(conversationCache);

    const firstMessageTimestamp = messages[0]?.timestamp;
    const firstUserMessage = messages.find(msg => msg.role === "user");
    const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

    try {
      conversationId = await syncService.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        title,
        startedAt: firstMessageTimestamp,
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Recreated conversation ${conversationId} for Cursor session ${sessionId}`);

      await syncService.addMessages({
        conversationId,
        messages: messages.map(prepMessageForSync),
      });
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log(`Failed to recreate conversation and add messages: ${retryErrMsg}`);
    }
  }

  setPosition(dbPath, totalCount);
  log(`Synced ${messages.length} Cursor messages for session ${sessionId}`);
  syncStats.messagesSynced += messages.length;
  syncStats.sessionsActive.add(sessionId);

  updateStateCallback();
}

async function processCursorTranscriptFile(
  filePath: string,
  sessionId: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  updateStateCallback: () => void
): Promise<void> {
  let lastPosition = getPosition(filePath);
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }

  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }

  if (stats.size <= lastPosition) {
    return;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    const rawContent = buffer.toString("utf-8");
    const lastNewline = rawContent.lastIndexOf("\n");
    const newContent = lastNewline >= 0 ? rawContent.slice(0, lastNewline + 1) : "";
    const bytesConsumed = lastNewline >= 0 ? Buffer.byteLength(rawContent.slice(0, lastNewline + 1), "utf-8") : 0;
    if (!newContent) return;
    const messages = parseCursorTranscriptFile(newContent);

    let conversationId = conversationCache[sessionId];

    if (messages.length === 0) {
      setPosition(filePath, lastPosition + bytesConsumed);
      return;
    }

    if (!conversationId) {
      let projectPath: string | undefined;
      try {
        projectPath = findWorkspacePathForCursorConversation(sessionId) || undefined;
      } catch {
        projectPath = undefined;
      }

      const firstMessageTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
      const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

      try {
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          slug: undefined,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: undefined,
          gitInfo,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Created conversation ${conversationId} for Cursor transcript ${sessionId}`);
        syncStats.conversationsCreated++;

        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, lastPosition + bytesConsumed);
            return;
          }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Cursor conversation, queueing for retry: ${errMsg}`);

        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        }

        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          title,
          startedAt: firstMessageTimestamp,
          gitInfo,
        }, errMsg);

        setPosition(filePath, lastPosition + bytesConsumed);
        return;
      }
    }

    const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);

      try {
        const projectPath = findWorkspacePathForCursorConversation(sessionId) || undefined;
        const firstMessageTimestamp = messages[0]?.timestamp;
        const firstUserMessage = messages.find(m => m.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;

        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          slug: undefined,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: undefined,
          gitInfo,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Cursor transcript ${sessionId}`);

        await syncService.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync),
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Cursor conversation and add messages: ${retryErrMsg}`);
      }
    }

    setPosition(filePath, lastPosition + bytesConsumed);
    markSynced(filePath, lastPosition + bytesConsumed, messages.length, conversationId);
    log(`Synced ${messages.length} Cursor transcript messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Cursor transcript file ${filePath}: ${errMsg}`);
  }
}

async function processCodexSession(
  filePath: string,
  sessionId: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  titleCache: TitleCache,
  updateStateCallback: () => void
): Promise<void> {
  let lastPosition = getPosition(filePath);
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }

  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }

  if (stats.size <= lastPosition) {
    return;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    const rawContent = buffer.toString("utf-8");
    const lastNewline = rawContent.lastIndexOf("\n");
    const newContent = lastNewline >= 0 ? rawContent.slice(0, lastNewline + 1) : "";
    const bytesConsumed = lastNewline >= 0 ? Buffer.byteLength(rawContent.slice(0, lastNewline + 1), "utf-8") : 0;
    if (!newContent) return;
    let sessionMetaHead: string;
    try {
      sessionMetaHead = readFileHead(filePath, 4096);
    } catch (err: any) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        log(`Warning: Permission denied reading ${filePath} for Codex session metadata. Skipping.`);
        return;
      }
      throw err;
    }
    if (isAppServerManagedCodexSessionHead(sessionMetaHead)) {
      setPosition(filePath, lastPosition + bytesConsumed);
      markSynced(filePath, lastPosition + bytesConsumed, 0);
      log(`Skipping app-server-managed Codex transcript ${sessionId}`);
      return;
    }
    const messages = parseCodexSessionFile(newContent);

    let conversationId = conversationCache[sessionId];

    if (conversationId) {
      let titleContent: string;
      try {
        titleContent = newContent + "\n" + readFileTail(filePath, 4096);
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, lastPosition + bytesConsumed);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(titleContent);
      if (summaryTitle && titleCache[sessionId] !== summaryTitle) {
        try {
          await syncService.updateTitle(conversationId, summaryTitle);
          titleCache[sessionId] = summaryTitle;
          saveTitleCache(titleCache);
          log(`Updated title for Codex session ${sessionId}: ${summaryTitle}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Failed to update title: ${errMsg}`);
        }
      }
    }

    if (messages.length === 0) {
      setPosition(filePath, lastPosition + bytesConsumed);
      return;
    }

    if (!conversationId) {
      try {
        const headContent = sessionMetaHead.length >= 16384 ? sessionMetaHead : readFileHead(filePath, 16384);
        const projectPath = extractCodexCwd(headContent);
        const firstMessageTimestamp = messages[0]?.timestamp;
        let matchedStartedConversation: string | null = null;

        if (startedSessionTmux.size > 0) {
          const startedCodexEntries = Array.from(startedSessionTmux.entries())
            .filter(([, entry]) => entry.agentType === "codex");
          const proc = await findSessionProcess(sessionId, "codex").catch(() => null);
          let tmuxSessionName: string | null = null;

          if (proc) {
            tmuxSessionName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
            if (!tmuxSessionName) {
              const tmuxPane = await findTmuxPaneForTty(proc.tty);
              if (tmuxPane) {
                tmuxSessionName = tmuxPane.split(":")[0];
                cacheSessionProcess(sessionId, proc, tmuxPane);
              }
            }
          }

          matchedStartedConversation = matchStartedConversation(startedCodexEntries, {
            tmuxSessionName,
            // Only allow the cwd fallback when the process wasn't found at all
            // (see claude branch / matchStartedConversation).
            projectPath: proc ? null : projectPath,
          });

          if (matchedStartedConversation && tmuxSessionName) {
            log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via tmux ${tmuxSessionName}`);
          } else if (matchedStartedConversation && projectPath) {
            log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via projectPath fallback`);
          }
        }

        if (matchedStartedConversation) {
          conversationId = matchedStartedConversation;
          const tmuxEntry = startedSessionTmux.get(matchedStartedConversation);
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          // Reconcile project_path/git_root to the real session cwd (see Claude
          // match branch): the stub's stored path was a guess made before the
          // session existed and may not match where it actually runs.
          const codexGitInfo = projectPath ? getGitInfo(projectPath) : undefined;
          syncService.updateSessionId(conversationId, sessionId, projectPath || undefined, codexGitInfo?.repoRoot || codexGitInfo?.root).catch(logConvexFailure);
          if (tmuxEntry) {
            registerManagedStartedSession(conversationId, sessionId, tmuxEntry.tmuxSession);
            if (tmuxEntry.sessionId && tmuxEntry.sessionId !== sessionId) {
              stopManagedSessionHeartbeat(tmuxEntry.sessionId);
            }
            startCodexPermissionPoller(sessionId, tmuxEntry.tmuxSession, conversationId, syncService);
          }
          deleteStartedSession(matchedStartedConversation);
          log(`Linked Codex session ${sessionId} to existing started conversation ${conversationId}`);
        } else {

          const firstUserMessage = messages.find(msg => msg.role === "user");
          const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

          conversationId = await syncService.createConversation({
            userId,
            teamId,
            sessionId,
            agentType: "codex",
            projectPath,
            slug: undefined,
            title,
            startedAt: firstMessageTimestamp,
            parentMessageUuid: undefined,
            gitInfo: undefined,
          });
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          log(`Created conversation ${conversationId} for Codex session ${sessionId}`);

          if ((global as any).activeSessions) {
            (global as any).activeSessions.set(conversationId, {
              sessionId,
              conversationId,
              projectPath: "",
            });
          }

          if (pendingMessages[sessionId]) {
            await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
            delete pendingMessages[sessionId];
          }
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, lastPosition + bytesConsumed);
            return;
          }
          // Let it fall through to retry queue
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Codex conversation, queueing for retry: ${errMsg}`);

        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        }

        const firstMsgTimestamp = messages[0]?.timestamp;
        const firstUserMessage = messages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "codex",
          title,
          startedAt: firstMsgTimestamp,
        }, errMsg);

        setPosition(filePath, lastPosition + bytesConsumed);
        return;
      }
    }

    const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);

      const firstMsgTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      try {
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "codex",
          title,
          startedAt: firstMsgTimestamp,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Codex session ${sessionId}`);

        await syncService.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync),
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Codex conversation and add messages: ${retryErrMsg}`);
      }
    }

    setPosition(filePath, lastPosition + bytesConsumed);
    markSynced(filePath, lastPosition + bytesConsumed, messages.length, conversationId);
    log(`Synced ${messages.length} Codex messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "codex");

    // Agent status tracking for Codex sessions (skip if managed by app-server)
    if (conversationId && !appServerConversations.has(conversationId)) {
      sendAgentStatus(syncService, conversationId, sessionId, "working");
    }

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Codex session file ${filePath}: ${errMsg}`);
  }
}

const geminiSyncedCounts = new Map<string, number>();

async function processGeminiSession(
  filePath: string,
  sessionId: string,
  projectHash: string,
  syncService: SyncService,
  userId: string,
  teamId: string | undefined,
  conversationCache: ConversationCache,
  retryQueue: RetryQueue,
  pendingMessages: PendingMessages,
  titleCache: TitleCache,
  updateStateCallback: () => void
): Promise<void> {
  try {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        log(`Warning: Permission denied reading ${filePath}. Will retry later.`);
        return;
      }
      throw err;
    }

    const allMessages = parseGeminiSessionFile(content);
    const previousCount = geminiSyncedCounts.get(filePath) || 0;

    if (allMessages.length <= previousCount) {
      return;
    }

    const newMessages = allMessages.slice(previousCount);
    let conversationId = conversationCache[sessionId];

    if (!conversationId) {
      try {
        const firstUserMessage = allMessages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        const startTime = allMessages[0]?.timestamp;

        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          projectPath: undefined,
          slug: undefined,
          title,
          startedAt: startTime,
          parentMessageUuid: undefined,
          gitInfo: undefined,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Created conversation ${conversationId} for Gemini session ${sessionId}`);

        if ((global as any).activeSessions) {
          (global as any).activeSessions.set(conversationId, {
            sessionId,
            conversationId,
            projectPath: "",
          });
        }

        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            geminiSyncedCounts.set(filePath, allMessages.length);
            return;
          }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Gemini conversation, queueing for retry: ${errMsg}`);

        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of newMessages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: content.length,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
        }

        const firstUserMessage = allMessages.find(msg => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          title,
          startedAt: allMessages[0]?.timestamp,
        }, errMsg);

        geminiSyncedCounts.set(filePath, allMessages.length);
        return;
      }
    }

    const batchResult = await syncMessagesBatch(newMessages, conversationId, syncService, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);

      const firstUserMessage = allMessages.find(msg => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;

      try {
        conversationId = await syncService.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          title,
          startedAt: allMessages[0]?.timestamp,
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Gemini session ${sessionId}`);

        await syncService.addMessages({
          conversationId,
          messages: newMessages.map(prepMessageForSync),
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Gemini conversation and add messages: ${retryErrMsg}`);
      }
    }

    geminiSyncedCounts.set(filePath, allMessages.length);
    log(`Synced ${newMessages.length} Gemini messages for session ${sessionId}`);
    syncStats.messagesSynced += newMessages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "gemini");

    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Gemini session file ${filePath}: ${errMsg}`);
  }
}

interface ActiveSession {
  sessionId: string;
  conversationId: string;
  projectPath: string;
}

let reconnectAttempt = 0;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

function getReconnectDelay(): number {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, reconnectAttempt), MAX_DELAY_MS);
  reconnectAttempt++;
  return delay;
}

function resetReconnectDelay(): void {
  reconnectAttempt = 0;
}

interface ClaudeSessionInfo {
  pid: number;
  tty: string;
  sessionId: string;
  termProgram?: string;
}

function normalizeTty(tty: string): string {
  if (tty.startsWith("/dev/")) return tty;
  if (tty.startsWith("ttys")) return `/dev/${tty}`;
  if (tty.match(/^s\d+$/)) return `/dev/tty${tty}`;
  return `/dev/${tty}`;
}

function buildReverseConversationCache(cache: ConversationCache): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const [sessionId, convId] of Object.entries(cache)) {
    reverse[convId] = sessionId;
  }
  return reverse;
}

function detectSessionAgentType(sessionId: string): "claude" | "codex" | "cursor" | "gemini" {
  if (sessionId.startsWith("session-")) return "gemini";
  const sessionFile = findSessionFile(sessionId);
  return sessionFile?.agentType ?? "claude";
}

function tryRegisterSessionProcess(sessionId: string, agentType: "claude" | "codex" | "cursor" | "gemini"): void {
  try {
    // Heartbeat membership is in-memory and lost on daemon restart, while registry
    // files persist on disk. Always ensure heartbeat is running for known sessions,
    // even when skipping the expensive process discovery below.
    if (syncServiceRef && !managedHeartbeatSessions.has(sessionId)) {
      const cache = readConversationCache();
      const conversationId = cache[sessionId];
      if (conversationId) {
        ensureManagedSessionHeartbeat(sessionId);
      }
    }

    const registryDir = path.join(CONFIG_DIR, "session-registry");
    const registryFile = path.join(registryDir, `${sessionId}.json`);

    if (fs.existsSync(registryFile)) {
      const stat = fs.statSync(registryFile);
      if (Date.now() - stat.mtimeMs < 300_000) return;
    }

    findSessionProcess(sessionId, agentType).then((result) => {
      if (!result) return;
      try {
        fs.mkdirSync(registryDir, { recursive: true });
        fs.writeFileSync(registryFile, JSON.stringify({ pid: result.pid, tty: result.tty, ts: Math.floor(Date.now() / 1000) }));
        log(`Opportunistically registered session ${sessionId.slice(0, 8)}: pid=${result.pid}, tty=${result.tty}`);
      } catch {}
      if (syncServiceRef) {
        const cache = readConversationCache();
        const conversationId = cache[sessionId];
        if (conversationId) {
          findTmuxPaneForTty(result.tty).then((tmuxPane) => {
            const tmuxSessionName = tmuxPane?.split(":")[0];
            syncServiceRef!.registerManagedSession(sessionId, result.pid, tmuxSessionName, conversationId).catch(() => {});
          }).catch(() => {
            syncServiceRef!.registerManagedSession(sessionId, result.pid, undefined, conversationId).catch(() => {});
          });
          ensureManagedSessionHeartbeat(sessionId);
        }
      }
    }).catch(() => {});
  } catch {}
}

const findSessionProcessInflight = new Map<string, Promise<ClaudeSessionInfo | null>>();

async function findSessionProcess(sessionId: string, agentType: "claude" | "codex" | "cursor" | "gemini" = "claude"): Promise<ClaudeSessionInfo | null> {
  const key = `${sessionId}:${agentType}`;
  const inflight = findSessionProcessInflight.get(key);
  if (inflight) return inflight;

  const promise = findSessionProcessImpl(sessionId, agentType);
  findSessionProcessInflight.set(key, promise);
  return promise.finally(() => findSessionProcessInflight.delete(key));
}

async function findSessionProcessImpl(sessionId: string, agentType: "claude" | "codex" | "cursor" | "gemini" = "claude"): Promise<ClaudeSessionInfo | null> {
  // Check process cache first
  const cached = await getCachedSessionProcess(sessionId);
  if (cached) {
    log(`Process cache hit for session ${sessionId.slice(0, 8)}: pid=${cached.pid}`);
    return cached;
  }

  const binaryPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "claude";

  try {
    const codexResumeCandidates: Array<{ pid: number; tty: string }> = [];
    // Strategy 0: Check session registry (written by SessionStart hook)
    try {
      const registryFile = path.join(CONFIG_DIR, "session-registry", `${sessionId}.json`);
      if (fs.existsSync(registryFile)) {
        const reg = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        const pid = reg.pid;
        const tty = normalizeTty(reg.tty);
        const termProgram = reg.term || undefined;
        // Verify process is still alive and is a claude-like process
        const { stdout: checkPs } = await execAsync(`ps -o comm= -p ${pid} 2>/dev/null`);
        if (checkPs.trim()) {
          if (agentType === "codex") {
            log(`Ignoring registry candidate for codex session ${sessionId.slice(0, 8)} (pid=${pid})`);
          } else {
          const result = { pid, tty, sessionId, termProgram };
          cacheSessionProcess(sessionId, result);
          log(`Found session ${sessionId.slice(0, 8)} via registry: pid=${pid}, tty=${tty}, term=${termProgram ?? "unknown"}`);
          return result;
          }
        } else {
          // Process is dead, clean up stale registry
          try { fs.unlinkSync(registryFile); } catch {}
        }
      }
    } catch {}

    // Strategy A: find resumed sessions by command line
    try {
      const { stdout } = await execAsync(`ps aux | grep -E '${binaryPattern}' | grep -v grep | grep -v 'codecast'`);
      const lines = stdout.trim().split("\n");
      const geminiCandidates: Array<{ pid: number; tty: string }> = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const isResume = isResumeInvocation(agentType, line);
        if (!isResume && agentType !== "gemini") continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) continue;
        const pid = parseInt(parts[1], 10);
        const tty = parts[6];
        if (isNaN(pid) || tty === "?" || tty === "??") continue;
        const normalizedTty = normalizeTty(tty);
        if (line.includes(sessionId)) {
          if (agentType === "codex") {
            codexResumeCandidates.push({ pid, tty: normalizedTty });
            continue;
          }
          const result = { pid, tty: normalizedTty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found session ${sessionId.slice(0, 8)} via resume process match: pid=${pid}`);
          return result;
        }
        if (agentType === "gemini") {
          geminiCandidates.push({ pid, tty: normalizedTty });
        }
      }

      if (agentType === "gemini" && geminiCandidates.length > 0) {
        if (geminiCandidates.length === 1) {
          const only = geminiCandidates[0];
          const result = { pid: only.pid, tty: only.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found Gemini session ${sessionId.slice(0, 8)} via single process candidate: pid=${only.pid}`);
          return result;
        }

        // Gemini CLI may not expose session ids in argv; pick most recently started candidate.
        let newest: { pid: number; tty: string; startedAt: number } | null = null;
        for (const c of geminiCandidates) {
          try {
            const { stdout: startOut } = await execAsync(`ps -o lstart= -p ${c.pid}`);
            const startedAt = new Date(startOut.trim()).getTime();
            if (!isNaN(startedAt) && (!newest || startedAt > newest.startedAt)) {
              newest = { pid: c.pid, tty: c.tty, startedAt };
            }
          } catch {}
        }

        if (newest) {
          const result = { pid: newest.pid, tty: newest.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found Gemini session ${sessionId.slice(0, 8)} via newest process heuristic: pid=${newest.pid}`);
          return result;
        }

        const fallback = geminiCandidates[0];
        const result = { pid: fallback.pid, tty: fallback.tty, sessionId };
        cacheSessionProcess(sessionId, result);
        log(`Found Gemini session ${sessionId.slice(0, 8)} via fallback process candidate: pid=${fallback.pid}`);
        return result;
      }
    } catch {}

    // Strategy A2: Codex live-session matching by open JSONL file (works for non-resume iTerm sessions)
    if (agentType === "codex") {
      try {
        const { stdout } = await execAsync(`ps aux | grep -E 'codex' | grep -v grep | grep -v 'codecast'`);
        const lines = stdout.trim().split("\n");
        const candidates: Array<{ pid: number; tty: string; tmuxTarget: string | null }> = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length < 7) continue;
          const pid = parseInt(parts[1], 10);
          const tty = parts[6];
          if (isNaN(pid) || tty === "?" || tty === "??") continue;

          try {
            const { stdout: lsofOut } = await execAsync(`lsof -p ${pid} 2>/dev/null`);
            if (!hasCodexSessionFileOpen(lsofOut, sessionId)) continue;
            const normalizedTty = normalizeTty(tty);
            let tmuxTarget: string | null = null;
            try {
              tmuxTarget = await findTmuxPaneForTty(normalizedTty);
            } catch {}
            candidates.push({ pid, tty: normalizedTty, tmuxTarget });
          } catch {}
        }

        if (candidates.length > 0) {
          const preferred = choosePreferredCodexCandidate(candidates);
          if (!preferred) return null;
          const result = { pid: preferred.pid, tty: preferred.tty, sessionId };
          cacheSessionProcess(sessionId, result, preferred.tmuxTarget || undefined);
          if (preferred.tmuxTarget) {
            log(`Found codex session ${sessionId.slice(0, 8)} via lsof session file match (tmux): pid=${preferred.pid}`);
          } else {
            log(`Found codex session ${sessionId.slice(0, 8)} via lsof session file match (non-tmux preferred): pid=${preferred.pid}`);
          }
          return result;
        }

        if (codexResumeCandidates.length > 0) {
          const candidate = codexResumeCandidates[0];
          const result = { pid: candidate.pid, tty: candidate.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found codex session ${sessionId.slice(0, 8)} via resume process fallback: pid=${candidate.pid}`);
          return result;
        }
      } catch {}
    }

    // Strategy B: Scan tmux sessions named cc-resume-* or codecast-*
    try {
      const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
      for (const tmuxName of tmuxList.trim().split("\n")) {
        if (!(await tmuxSessionMatchesFullSessionId(tmuxName, sessionId))) continue;
        // Get the pane TTY for this tmux session
        try {
          const { stdout: paneInfo } = await tmuxExec(["list-panes", "-t", tmuxName, "-F", "#{pane_tty} #{pane_pid}"]);
          const paneLine = paneInfo.trim().split("\n")[0];
          if (paneLine) {
            const [paneTty, panePidStr] = paneLine.split(" ");
            const panePid = parseInt(panePidStr, 10);
            if (!isNaN(panePid) && paneTty) {
              try {
                const { stdout: childPs } = await execAsync(`pgrep -P ${panePid} -f ${binaryPattern} 2>/dev/null`);
                const childPid = parseInt(childPs.trim().split("\n")[0]?.trim(), 10);
                if (!isNaN(childPid)) {
                  const result = { pid: childPid, tty: normalizeTty(paneTty), sessionId };
                  cacheSessionProcess(sessionId, result, `${tmuxName}:0.0`);
                  log(`Found session ${sessionId.slice(0, 8)} via tmux session ${tmuxName}: pid=${childPid}`);
                  return result;
                }
                // No agent child process found - check if pane shell itself is an agent
                if (isAgentProcess(panePid)) {
                  const result = { pid: panePid, tty: normalizeTty(paneTty), sessionId };
                  cacheSessionProcess(sessionId, result, `${tmuxName}:0.0`);
                  log(`Found session ${sessionId.slice(0, 8)} via tmux session ${tmuxName}: pid=${panePid} (direct)`);
                  return result;
                }
                log(`Tmux session ${tmuxName} has no active agent (shell pid=${panePid}), skipping`);
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}

    // Strategy C: CWD-based matching for non-resumed sessions
    const jsonlPath = findSessionJsonlPath(sessionId);
    if (jsonlPath) {
      const jsonlStat = fs.statSync(jsonlPath);
      const recentlyModified = Date.now() - jsonlStat.mtimeMs < 60_000;

      if (recentlyModified) {
        // Determine the project directory from the JSONL content
        const jsonlContent = readFileHead(jsonlPath, 5000);
        const projectCwd = extractCwd(jsonlContent) || (agentType === "codex" ? extractCodexCwd(jsonlContent) : null);

        if (projectCwd) {
          try {
            const psPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "/claude\\b|claude-code";
            const { stdout: psOut } = await execAsync(`ps aux | grep -E '${psPattern}' | grep -v grep | grep -v 'codecast'`);
            const candidates: Array<{ pid: number; tty: string }> = [];

            for (const line of psOut.trim().split("\n")) {
              if (!line.trim()) continue;
              const parts = line.trim().split(/\s+/);
              if (parts.length < 7) continue;
              const pid = parseInt(parts[1], 10);
              const tty = parts[6];
              if (isNaN(pid) || tty === "?" || tty === "??") continue;

              // Check CWD of this process
              try {
                const { stdout: lsofOut } = await execAsync(`lsof -d cwd -a -p ${pid} -F n 2>/dev/null`);
                const cwdLine = lsofOut.split("\n").find(l => l.startsWith("n"));
                if (cwdLine) {
                  const processCwd = cwdLine.slice(1);
                  // Match if CWD is the project dir or a subdirectory of it
                  if (processCwd === projectCwd || processCwd.startsWith(projectCwd + "/")) {
                    candidates.push({ pid, tty: normalizeTty(tty) });
                  }
                }
              } catch {}
            }

            // Filter out candidates already cached for a different session
            const unclaimed = candidates.filter(c => {
              for (const [cachedSid, cachedInfo] of sessionProcessCache) {
                if (cachedSid !== sessionId && cachedInfo.pid === c.pid) return false;
              }
              return true;
            });

            if (unclaimed.length === 1) {
              const result = { pid: unclaimed[0].pid, tty: unclaimed[0].tty, sessionId };
              cacheSessionProcess(sessionId, result);
              log(`Found session ${sessionId.slice(0, 8)} via CWD match: pid=${unclaimed[0].pid}, cwd=${projectCwd}`);
              return result;
            } else if (unclaimed.length > 1) {
              // Disambiguate using JSONL birth time vs process start time
              const jsonlBirthMs = jsonlStat.birthtimeMs;
              let bestCandidate: { pid: number; tty: string } | null = null;
              let bestDelta = Infinity;

              for (const c of unclaimed) {
                try {
                  const { stdout: etimeOut } = await execAsync(`ps -o lstart= -p ${c.pid}`);
                  const processStart = new Date(etimeOut.trim()).getTime();
                  const delta = Math.abs(processStart - jsonlBirthMs);
                  if (delta < bestDelta) {
                    bestDelta = delta;
                    bestCandidate = c;
                  }
                } catch {}
              }

              if (bestCandidate && bestDelta < 300_000) {
                const result = { pid: bestCandidate.pid, tty: bestCandidate.tty, sessionId };
                cacheSessionProcess(sessionId, result);
                log(`Found session ${sessionId.slice(0, 8)} via CWD+timing match: pid=${bestCandidate.pid}, delta=${Math.round(bestDelta / 1000)}s`);
                return result;
              }
              log(`CWD match found ${unclaimed.length} unclaimed candidates for ${sessionId.slice(0, 8)}, could not disambiguate`);
            } else {
              log(`CWD match found ${candidates.length} candidates for ${sessionId.slice(0, 8)} but all claimed by other sessions`);
            }
          } catch {}
        }
      }
    }

    return null;
  } catch (err) {
    log(`Error finding Claude session process: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function findTmuxPaneForTty(tty: string): Promise<string | null> {
  if (!hasTmux()) return null;
  try {
    const { stdout } = await tmuxExec(["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]);
    const normalizedTty = normalizeTty(tty);

    for (const line of stdout.trim().split("\n")) {
      const [paneTty, target] = line.split(" ");
      if (paneTty === normalizedTty && target) {
        return target;
      }
    }
    return null;
  } catch {
    return null;
  }
}

type InteractivePrompt = { question: string; options: Array<{ label: string; description?: string }>; isConfirmation?: boolean; header?: string };

// Unicode "Box Drawing" block (┌┐└┘─│ …). An AskUserQuestion option's `preview`
// renders as a box to the RIGHT of the options; tmux capture-pane flattens those
// columns onto the option rows, so naive parsing captures "│ … │" as a description.
// Such content is never an option's own description — we drop it so a scraped card
// never carries box-drawing glyphs (the full-fidelity card comes from the JSONL).
const BOX_DRAWING_CHARS = /[─-╿]/;

// Newer AskUserQuestion menus print a short label "chip" on its own line above the
// question — e.g. "□ Stale pending policy". The glyph is a box/ballot character
// (NOT in the Box Drawing block, so BOX_DRAWING_CHARS won't catch it). The web card
// renders this as `header`; the scrape used to drop it so scraped cards had no chip.
const HEADER_CHIP = /^[□☐☑☒▢▣◻◼◽◾■]\s*(.+)$/;
const SEPARATOR_LINE = /^[─━═\-_]{5,}$/;

// A multiSelect AskUserQuestion renders a checkbox between the number and the
// label — "1. [ ] Restart" / "2. [x] Redeploy" (or a unicode ballot box). It's a
// selection-state glyph, not part of the label, so strip it off the front. Only a
// 0-or-1-char bracket pair counts, so real bracketed labels like "[Recommended]"
// survive.
const CHECKBOX_PREFIX = /^\s*(?:\[[ xX*✓✔·]?\]|[□☐☑☒▢▣◻◼◽◾])\s*/;
// Claude Code appends two synthetic affordance rows to every AskUserQuestion menu:
// a free-text "Type something" row and a "Chat about this" escape hatch. They carry
// no real description — and the free-text row renders a "Submit" button beneath it
// that must not be scraped as its description.
const SYNTHETIC_OPTION = /^(?:type something\.?|chat about this)$/i;

// Pull the header chip and the (possibly multi-line) question out of the lines above
// the first option. The question can wrap across several rows; the menu renderer
// breaks it mid-sentence, so taking only the last line truncated it. Walk upward from
// the first option, stitching contiguous text until a blank line, separator, cursor
// row, or the chip bounds it — anything past those belongs to a prior turn. The chip
// itself can sit a blank line above the question, so scan for it independently.
function extractPromptHeading(lines: string[], firstOptionIdx: number): { header?: string; question: string } {
  const start = Math.max(0, firstOptionIdx - 8);
  let header: string | undefined;
  for (let i = firstOptionIdx - 1; i >= start; i--) {
    const chip = lines[i].trim().match(HEADER_CHIP);
    if (chip) { header = chip[1].trim(); break; }
  }
  const qLines: string[] = [];
  for (let i = firstOptionIdx - 1; i >= start; i--) {
    const trimmed = lines[i].trim();
    if (HEADER_CHIP.test(trimmed)) break;
    if (!trimmed) { if (qLines.length) break; else continue; }
    if (/^[❯>]/.test(trimmed) || SEPARATOR_LINE.test(trimmed)) break;
    qLines.unshift(trimmed);
  }
  const question = qLines.join(" ") || header || "Select an option";
  return { header, question };
}

export function parseInteractivePrompt(text: string): InteractivePrompt | null {
  const lines = text.split("\n");
  const optionPattern = /^\s*[❯>)]*\s*(\d+)[.)]\s+(.+?)(?:\s{2,}(.+?))?$/;
  const options: Array<{ label: string; description?: string }> = [];
  let firstOptionIdx = -1;
  let lastOptionIdx = -1;
  let gapCount = 0;
  let hasCursorIndicator = false;
  // The AskUserQuestion menu renders each option's description on indented
  // continuation lines BELOW the numbered label. We scan bottom-up, so those
  // lines arrive before their option; buffer them and attach on the next match.
  let pendingDesc: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(optionPattern);
    if (m) {
      if (lastOptionIdx < 0) lastOptionIdx = i;
      firstOptionIdx = i;
      if (/^\s*[❯>]\s*\d/.test(lines[i])) hasCursorIndicator = true;
      const label = m[2]
        .replace(CHECKBOX_PREFIX, "")        // multiSelect checkbox: "[ ]" / "[x]" / "☐"
        .replace(/\s*[✓✗✔☑]\s*/g, "")        // stray selection glyphs anywhere
        .trim();
      if (label.length > 200) { pendingDesc = []; continue; }
      // A same-line trailing segment is a real description only if it isn't the
      // right-hand preview box flattened onto this row (see BOX_DRAWING_CHARS).
      const inlineDesc = m[3]?.trim();
      const descParts = [
        inlineDesc && !BOX_DRAWING_CHARS.test(inlineDesc) ? inlineDesc : undefined,
        ...pendingDesc,
      ].filter((s): s is string => !!s);
      // The synthetic "Type something" / "Chat about this" rows never have a real
      // description; the "Submit" button under the free-text row would otherwise be
      // mis-scraped as one.
      const description = SYNTHETIC_OPTION.test(label)
        ? undefined
        : descParts.length ? descParts.join(" ") : undefined;
      if (label) options.unshift({ label, description });
      pendingDesc = [];
      gapCount = 0;
    } else if (options.length > 0) {
      const trimmed = lines[i].trim();
      // A continuation/description line is indented past the flush-left question.
      // multiSelect menus indent descriptions only 2 spaces — the same column as
      // non-cursor option rows ("  2.") — so the old 4-space floor treated every
      // such description as prose and broke the bottom-up scan, dropping options.
      const isIndented = /^\s{2,}/.test(lines[i]);
      const isSeparator = /^[─━═\-_]{3,}$/.test(trimmed);
      // A row carrying any box-drawing glyph is the side-panel preview, not a
      // continuation of the option's description — treat it as a gap, not text.
      const isBoxArt = BOX_DRAWING_CHARS.test(trimmed);
      if (trimmed && isIndented && !isSeparator && !isBoxArt && trimmed.length <= 300) {
        // Indented continuation line = description for the option just above it.
        pendingDesc.unshift(trimmed);
      } else if (!trimmed || isIndented || isSeparator || isBoxArt) {
        gapCount++;
        if (gapCount > 8) break;
      } else {
        break;
      }
    }
  }

  if (options.length >= 2 && firstOptionIdx >= 0) {
    const tail = lines.slice(firstOptionIdx).join("\n");
    const hasFooter = /enter to (confirm|select)|esc(ape)? to (exit|cancel)|↑.*↓|←.*→|arrow keys|(?:press\s+)?n\s+to\s+add\s+notes/i.test(tail);
    if (hasCursorIndicator || hasFooter) {
      const { header, question } = extractPromptHeading(lines, firstOptionIdx);
      return { question, options, ...(header ? { header } : {}) };
    }
  }

  // Detect confirmation prompts: "Press Enter to continue..." / "Esc to cancel"
  const joined = lines.slice(-15).join("\n");
  const enterMatch = joined.match(/(?:press\s+)?enter\s+to\s+(continue|confirm|proceed|accept)[\s.…]*/i);
  const escMatch = joined.match(/esc(?:ape)?\s+to\s+(cancel|exit|quit|go back)[\s.…]*/i);
  if (enterMatch) {
    const contextLines = lines.filter(l => l.trim().length > 0).slice(-8);
    const headerLine = contextLines.find(l => !/(press|enter|esc|─|━)/i.test(l) && l.trim().length > 5);
    const question = headerLine?.trim() || "Continue?";
    const confirmOptions: Array<{ label: string; description?: string }> = [
      { label: `Continue (${enterMatch[1]})` },
    ];
    if (escMatch) {
      confirmOptions.push({ label: `Cancel (${escMatch[1]})` });
    }
    return { question, options: confirmOptions, isConfirmation: true };
  }

  return null;
}

type PollMessage = { keys?: string[]; steps?: Array<{ key: string; text?: string }>; text?: string; display?: string };

function parsePollMessage(content: string): PollMessage | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__cc_poll && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps))) return parsed;
  } catch {}
  return null;
}

// The synthetic poll the daemon emits for a live interactive prompt must carry a
// STABLE message id. checkForInteractivePrompt fires from several call sites
// (post-inject, post-resume, heartbeat) that can race inside the capture-delay
// window — all pass the pending guard before any of them sets it — and a
// timestamped uuid made each emit a distinct server row, so the same prompt
// rendered 4-5x in the UI. Keying the uuid on the prompt's *content* makes
// addMessages idempotent: addMessages upserts by (conversation_id, message_uuid),
// so identical prompts collapse to a single row no matter how many callers detect
// them. Distinct prompts still get distinct ids and render separately.
export function interactivePromptMessageUuid(sessionId: string, prompt: InteractivePrompt): string {
  const canonical = JSON.stringify({
    q: prompt.question,
    o: prompt.options.map(o => [o.label, o.description ?? ""]),
    c: !!prompt.isConfirmation,
  });
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `interactive-prompt-${sessionId}-${digest}`;
}

// A real AskUserQuestion writes its tool_use to the session JSONL the instant it's
// emitted and blocks there until answered (verified: a ~17-min gap between the
// tool_use line and its tool_result). The file watcher syncs that tool_use as a
// full-fidelity AskUserQuestion card — header, multiSelect, and option descriptions
// intact. So when the live tmux menu IS that AskUserQuestion, a scraped card would be
// a degraded duplicate (bare labels, synthetic "Type something"/"Chat about this"
// rows, no header). Detect the pending tool_use so the scrape can defer to the
// authoritative JSONL path. Returns true only when the latest AskUserQuestion in the
// tail has no matching tool_result yet (i.e. still blocking).
export function jsonlHasPendingAskUserQuestion(jsonlText: string): boolean {
  let lastAskId: string | null = null;
  const resultIds = new Set<string>();
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && block?.name === "AskUserQuestion" && block?.id) {
        lastAskId = block.id;
      } else if (block?.type === "tool_result" && block?.tool_use_id) {
        resultIds.add(block.tool_use_id);
      }
    }
  }
  return lastAskId !== null && !resultIds.has(lastAskId);
}

export function sessionHasPendingAskUserQuestion(sessionId: string): boolean {
  const jsonlPath = findSessionJsonlPath(sessionId);
  if (!jsonlPath) return false;
  try { return jsonlHasPendingAskUserQuestion(readFileTail(jsonlPath, 65536)); } catch { return false; }
}

async function checkForInteractivePrompt(
  tmuxTarget: string,
  sessionId: string,
  conversationId: string,
  syncService: SyncService,
  delayMs = 2000,
): Promise<void> {
  if (pendingInteractivePrompts.has(sessionId)) { log(`Skipping prompt check: pending prompt exists for ${sessionId.slice(0, 8)}`); return; }

  await new Promise(resolve => setTimeout(resolve, delayMs));

  try {
    const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxTarget, "-S", "-50"]);
    const prompt = parseInteractivePrompt(paneContent);
    if (!prompt) {
      log(`No interactive prompt found in ${tmuxTarget} for session ${sessionId.slice(0, 8)}`);
      // Backstop: with no blocking prompt on screen, the live pane is the ground
      // truth for whether this agent is idle or working. Correct a latched status
      // (a lost lifecycle hook, or one wiped by a daemon restart) before returning.
      // This runs both periodically (heartbeatHealthCheck) and right after a warm
      // restart (the recovered-session scan), so a stale "working" can't persist.
      reconcileStatusFromPane(paneContent, sessionId, conversationId, syncService);
      return;
    }

    log(`Interactive prompt detected in session ${sessionId.slice(0, 8)}: "${prompt.question}" with ${prompt.options.length} options (confirmation=${!!prompt.isConfirmation})`);

    // If this live menu is a real AskUserQuestion tool call, its tool_use is already
    // in the JSONL and the file watcher syncs it as a full-fidelity card. Emitting a
    // scraped card here would be a degraded duplicate, so defer to that path — it also
    // sets the pending-prompt guard and the permission_blocked status.
    //
    // The tool_use write can lag the on-screen render by a beat, and the heartbeat
    // path calls us with delayMs=0, so a single point-in-time check can read the
    // JSONL *before* the flush lands and wrongly fall through to a scraped card
    // (this is how the "Disk headroom" poll shipped a garbled card). Poll briefly so
    // the deferral wins the flush race. A genuine non-JSONL menu (e.g. the `--model`
    // picker) never gains a pending tool_use, so it just costs this short settle.
    if (!prompt.isConfirmation) {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (sessionHasPendingAskUserQuestion(sessionId)) {
          log(`Deferring to JSONL AskUserQuestion card for ${sessionId.slice(0, 8)} (skipping scraped duplicate)`);
          return;
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 500));
      }
    }

    const now = Date.now();
    pendingInteractivePrompts.set(sessionId, { timestamp: now, options: prompt.options, isConfirmation: prompt.isConfirmation });

    // Content-deterministic id: the same prompt detected by racing callers
    // upserts to one server row instead of N duplicate poll cards.
    const promptUuid = interactivePromptMessageUuid(sessionId, prompt);

    // Don't re-emit (and re-surface) a synthetic prompt we already emitted for this
    // session — a re-rendered blocking menu after a heartbeat guard-clear is the same
    // prompt, not a new one. Distinct prompts have distinct uuids and still emit.
    if (lastEmittedSyntheticPrompt.get(sessionId) === promptUuid) {
      log(`Skipping re-emit of identical synthetic prompt for ${sessionId.slice(0, 8)}`);
      return;
    }

    await syncService.addMessages({
      conversationId,
      messages: [{
        messageUuid: promptUuid,
        role: "assistant" as const,
        content: "",
        timestamp: now,
        toolCalls: [{
          id: promptUuid,
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: prompt.question,
              ...(prompt.header ? { header: prompt.header } : {}),
              options: prompt.options,
              ...(prompt.isConfirmation ? { isConfirmation: true } : {}),
            }],
          },
        }],
      }],
    });

    lastEmittedSyntheticPrompt.set(sessionId, promptUuid);
    log(`Synced interactive prompt as AskUserQuestion for session ${sessionId.slice(0, 8)}`);
  } catch (err) {
    log(`Interactive prompt check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function tmuxPromptStillHasInput(paneContent: string, input: string): boolean {
  const normalizedInput = normalizePromptText(input);
  if (!normalizedInput) return false;
  const lines = paneContent.split("\n");
  const recent = lines.slice(-80).join("\n");
  const lastPromptIndex = Math.max(recent.lastIndexOf("❯"), recent.lastIndexOf("›"));
  if (lastPromptIndex === -1) return false;
  const fromPrompt = recent.slice(lastPromptIndex);
  return normalizePromptText(fromPrompt).includes(normalizedInput);
}

// The Claude Code TUI renders its live UI (input box, or modal that replaces it) at the
// very bottom of the pane, bracketed by box-drawing separator runs. Everything above
// those separators is transcript — immutable history rendered as text — and must not
// influence inject decisions. Extracting the live region first means scrollback can
// never produce a false positive (the original bug: stale "Interrupted · What should
// Claude do instead?" transcript matched forever).
export function extractTmuxLiveRegion(paneContent: string): string {
  const lines = paneContent.replace(/\s+$/, "").split("\n");
  const TAIL = 25;
  const tail = lines.slice(-TAIL);
  const isSep = (line: string) => /[─━]{20,}/.test(line);
  const sepIdx: number[] = [];
  for (let i = 0; i < tail.length; i++) {
    if (isSep(tail[i])) sepIdx.push(i);
  }
  if (sepIdx.length >= 2) {
    // Input box: take the box body AND everything below the box (the footer).
    // The footer is where Claude Code renders "esc to interrupt" while it is
    // generating — and the input box (❯) stays visible the whole time for
    // type-ahead. Slicing to `bot` (box body only) hid that marker, so a busy
    // agent showing its input box was misclassified "idle" and we pasted into
    // it; the queued text never submitted, never acked, and retried forever.
    // Nothing but the live footer renders below the box, so this can't pull in
    // scrollback (the reason the region is narrowed in the first place).
    const top = sepIdx[sepIdx.length - 2];
    return tail.slice(top + 1).join("\n");
  }
  if (sepIdx.length === 1) {
    // Modal or busy indicator: one separator, content lives below it.
    return tail.slice(sepIdx[0] + 1).join("\n");
  }
  // No separators visible — could be spinner-only or unusual UI. Use a tight tail
  // (5 lines) so transcript text from older turns can't reach the classifier.
  return tail.slice(-5).join("\n");
}

export type TmuxLiveState =
  | "idle"          // empty input prompt — safe to paste
  | "busy"          // spinner / "esc to interrupt" — wait
  | "interrupted"   // "What should Claude do instead?" dialog — Escape to clear
  | "rewind"        // Rewind/Restore modal — Escape to cancel (NEVER Enter, that rewinds)
  | "warning"       // dismissable banner — Enter to ack
  | "exited"        // bare shell, agent has exited — abort
  | "unknown";      // anything we don't recognize — defer, do not guess

// Classifies the live region only. Ordering matters: more-specific dialogs are
// matched before more-general ones (e.g. Rewind contains "Interrupted" in its option
// list, so check Rewind first). Idle is a positive whitelist — never inferred from
// absence of other patterns.
export function classifyTmuxLiveState(region: string): TmuxLiveState {
  if (/Resume this session with:/i.test(region)) return "exited";
  if (/-(?:ba)?sh:.*(?:No such file|command not found)/.test(region)) return "exited";
  if (/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|esc to interrupt/i.test(region)) return "busy";
  // Rewind / cancel-able modal: distinguished from warnings by an Esc option.
  // Warnings have only "Press enter to continue" (no Esc). The "❯ (current)" marker
  // is also unique to the Rewind option list.
  if (/Esc to cancel|❯\s*\(current\)/i.test(region)) return "rewind";
  if (/What should Claude do instead\?/i.test(region)) return "interrupted";
  if (/Press enter to continue|Update available|weekly limit|recorded with model|⚠/i.test(region)) return "warning";
  // Ready: the live region contains an input-prompt glyph and none of the modal
  // patterns above matched. Draft text typed into the input by the user counts as
  // ready — the paste path's mandatory Escape+C-u clears it before pasting. The
  // safety net is the modal pattern set above being checked first; if Claude Code
  // ever ships a modal that uses `❯` with no other marker, the post-paste
  // verification (input-still-has-our-text → reschedule) will catch it.
  if (region.includes("❯") || region.includes("›")) return "idle";
  return "unknown";
}

// Pane-state status reconcile — the tmux-session counterpart to
// reconcileStatusFromTranscript. For a tmux-managed session the live pane is the
// authoritative "is the agent busy right now" signal: the transcript can't tell
// that a finished agent is idle when its last turn was cut off mid-tool (the JSONL
// ends without an `end_turn` and reads "active" forever), and a daemon restart
// wipes lastSentAgentStatus so the heartbeat re-asserts the server's stale active
// status indefinitely. The pure decision below corrects only on a positive pane
// signal, mirroring reconciledStatus:
//   - idle pane + stale-active (or post-restart unknown) status -> idle
//   - busy pane + quiet (or post-restart unknown) status        -> working
// Modal/exited/unknown panes defer. classifyTmuxLiveState checks busy/modal
// patterns before "idle" (a busy agent's type-ahead input box reads "busy", not
// "idle"), so a false idle can't slip through.
export function paneReconcileTarget(
  state: TmuxLiveState,
  stored: AgentStatus | undefined,
): AgentStatus | null {
  if (state === "idle") {
    const staleActive = stored === "working" || stored === "thinking" || stored === "connected";
    return stored === undefined || staleActive ? "idle" : null;
  }
  if (state === "busy") {
    const quiet = stored === undefined || stored === "idle" || stored === "connected";
    return quiet ? "working" : null;
  }
  return null;
}

function reconcileStatusFromPane(
  paneContent: string,
  sessionId: string,
  conversationId: string,
  syncService: SyncService,
): void {
  const state = classifyTmuxLiveState(extractTmuxLiveRegion(paneContent));
  const stored = lastSentAgentStatus.get(sessionId);
  const target = paneReconcileTarget(state, stored);
  if (!target) return;
  log(`[STATUS-PANE-RECONCILE] ${sessionId.slice(0, 8)} stored=${stored ?? "none"} pane=${state} -> ${target}`);
  sendAgentStatus(syncService, conversationId, sessionId, target);
}

// Recognizes the synthetic control message Claude Code appends when the user
// interrupts a turn (ESC / Ctrl-C): "[Request interrupted ...]" or
// "[Request cancelled ...]". It is NOT a fresh prompt — the agent was stopped
// and is now parked at the prompt waiting on the user. Mirrors the web's
// isInterruptControlMessage and the server's isInterruptMsg so all three layers
// agree that an interrupt is not "the agent's move."
export function isInterruptControlMessage(text: string | null | undefined): boolean {
  const t = text?.trim();
  if (!t) return false;
  return t.startsWith("[Request interrupted") || t.startsWith("[Request cancelled");
}

// Leading surface text of a JSONL message's `content`, which is either a raw
// string or an array of content blocks (text / tool_use / tool_result …).
// Returns the first text block's text (or the string itself); "" when there is
// no surface text. Enough to recognize the interrupt control message above.
function jsonlMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
    }
  }
  return "";
}

// Turn-completion state derived from a Claude JSONL transcript tail. This is the
// universal ground truth for "is the agent mid-turn or done" -- every session
// writes a transcript, unlike a tmux pane (a bare-terminal session has none).
export type TranscriptTurnState =
  | "idle"     // last real message is an assistant turn that ended (end_turn etc.)
  | "active"   // mid-turn: a pending tool_use, or a user/tool_result awaiting reply
  | "unknown"; // streaming/partial/no parseable real message -> defer, never guess

// Classifies the most recent *real* message in a JSONL tail. `system`/meta lines
// (and any partially-written final line that won't parse) are skipped so we land
// on the last genuine user/assistant turn. The signal is structural:
//   - assistant + stop_reason end_turn/stop_sequence/max_tokens -> turn ended (idle)
//   - assistant + stop_reason tool_use                          -> mid-turn (active)
//   - user (fresh prompt or tool_result)                        -> agent's move (active)
//   - assistant with no/streaming stop_reason, or nothing real  -> unknown (defer)
// AskUserQuestion-blocked sessions read as `active` (their last assistant turn is a
// pending tool_use), so they are never mistaken for idle; the open-poll/needs-input
// path owns that case.
export function classifyTranscriptTail(tailContent: string): TranscriptTurnState {
  const lines = tailContent.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d: { type?: string; message?: { role?: string; stop_reason?: string | null; content?: unknown } };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line (e.g. mid-write tail) -> skip
    }
    const role = d.message?.role ?? (d.type === "user" || d.type === "assistant" ? d.type : undefined);
    if (role === "assistant") {
      const sr = d.message?.stop_reason;
      if (sr === "tool_use") return "active";
      if (sr === "end_turn" || sr === "stop_sequence" || sr === "max_tokens") return "idle";
      return "unknown"; // streaming / unrecognized stop_reason -> defer
    }
    if (role === "user") {
      // A [Request interrupted]/[Request cancelled] control message is not a fresh
      // prompt: the user stopped the agent mid-turn and it is now parked at the
      // prompt. Reading it as "active" (the agent's move) is exactly what kept
      // bare-terminal interrupted sessions latched in "working" — the reconcile
      // heartbeat re-derived "active" every cycle, so reconciledStatus flipped a
      // freshly-idle session back to working forever, and the server never saw an
      // idle status to route into needs-input. An interrupt is turn-ended (idle),
      // mirroring Codex's task_aborted. (tmux sessions self-heal via the pane
      // reconcile; bare-terminal ones have only this transcript signal.)
      if (isInterruptControlMessage(jsonlMessageText(d.message?.content))) return "idle";
      return "active";
    }
    // system/meta entry -> keep scanning for the last real message
  }
  return "unknown";
}

// Codex's rollout JSONL marks turn boundaries with `event_msg` records instead of
// a per-message stop_reason. A turn ends with `task_complete` (and `turn_aborted`/
// `task_aborted` for interrupted ones); a turn is in flight after `task_started`
// or a fresh `user_message`. Everything else (`agent_message`, `token_count`,
// `response_item` deltas) is intra-turn noise we scan past. We read the tail back
// to front and decide on the first boundary event, mirroring classifyTranscriptTail
// so reconciledStatus can treat both agent types identically.
export function classifyCodexTranscriptTail(tailContent: string): TranscriptTurnState {
  const lines = tailContent.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d: { type?: string; payload?: { type?: string } };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line (mid-write tail) -> skip
    }
    if (d.type !== "event_msg") continue;
    const t = d.payload?.type;
    if (t === "task_complete" || t === "turn_complete" || t === "task_aborted" || t === "turn_aborted") return "idle";
    if (t === "task_started" || t === "user_message") return "active";
    // token_count / agent_message / reasoning etc. -> intra-turn, keep scanning
  }
  return "unknown";
}

// Decides whether the hook-driven status (lastSentAgentStatus) should be corrected
// against the transcript turn-state. The status hook is a last-write-wins latch: if
// a lifecycle transition is lost end-to-end (e.g. the Stop hook never reaches the
// daemon), the latch freezes at the wrong value and the heartbeat re-broadcasts it
// forever. The 2026-04-14 heartbeat-carries-status fix only repairs server<-daemon
// drift; it cannot repair a wrong *local* value -- this does.
//
// Corrects only on a positive structural signal in either direction, deferring on
// anything ambiguous, so it can never be wrong:
//   - active (working/thinking) but transcript ended its turn  -> idle (lost Stop)
//   - quiet (idle/connected) but transcript is mid-turn         -> working (lost activity hook)
// Everything else is untouched: a genuine long tool run is `active` (never flipped to
// idle), `unknown` defers, and permission_blocked/resuming/stopped/compacting are
// owned by other code paths.
export function reconciledStatus(
  stored: AgentStatus | undefined,
  turn: TranscriptTurnState,
): AgentStatus | null {
  const isActive = stored === "working" || stored === "thinking";
  const isQuiet = stored === "idle" || stored === "connected";
  if (isActive && turn === "idle") return "idle";
  if (isQuiet && turn === "active") return "working";
  return null;
}

// The role of the most recent *real* (non-system/meta) message in a Claude JSONL
// tail, or null if none parses. Mirrors classifyTranscriptTail's role logic so the
// two stay consistent. Used to recover a stuck permission_blocked: an answered
// prompt's tail ends in a USER turn (the AskUserQuestion answer / a permissioned
// tool's tool_result is a type:"user" entry appended after the blocking assistant
// tool_use), while a still-pending prompt ends in the assistant tool_use.
export function transcriptTailLastRealRole(tailContent: string): "user" | "assistant" | null {
  const lines = tailContent.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d: { type?: string; message?: { role?: string } };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line (mid-write tail) -> skip
    }
    const role = d.message?.role ?? (d.type === "user" || d.type === "assistant" ? d.type : undefined);
    if (role === "user" || role === "assistant") return role;
    // system/meta entry -> keep scanning for the last real message
  }
  return null;
}

// permission_blocked is a latch with no other recovery path: the daemon doesn't
// drive AskUserQuestion resolution, reconciledStatus deliberately skips it, and the
// pane reconcile can't tell an answered poll from a pending one. So a lost resume
// "working" hook freezes the session in "Needs Input". Recover only on the positive
// signal that the prompt was answered -- the transcript tail's last real message is
// a user turn. A still-pending prompt ends in the assistant tool_use (lastRole
// "assistant") and is left untouched, so this can never clear a live prompt.
export function permissionBlockedRecoveryTarget(
  stored: AgentStatus | undefined,
  lastRealRole: "user" | "assistant" | null,
): AgentStatus | null {
  if (stored !== "permission_blocked") return null;
  return lastRealRole === "user" ? "working" : null;
}

// In bypassPermissions mode Claude Code still emits permission_prompt
// Notifications for tools it auto-approves; those are phantom blocks (the agent
// never pauses) and must be rewritten to "working" to avoid a dangling web
// Approve/Deny dialog. AskUserQuestion is the exception: it genuinely blocks the
// agent on a user prompt regardless of permission mode, so the status hook tags
// it via `message` and we let that one through to the "needs input" bucket.
export function isPhantomBypassPermissionBlock(
  status: string | undefined,
  permissionMode: string | undefined,
  message: string | undefined,
): boolean {
  if (status !== "permission_blocked") return false;
  if (permissionMode !== "bypassPermissions") return false;
  return !(message || "").startsWith("AskUserQuestion");
}

// Decide whether one hook event's permission_blocked should be suppressed as a phantom
// bypass auto-approve, accounting for an in-progress AskUserQuestion block. `blocked` is
// mutated in place across the event stream for a session:
//   - a PreToolUse AskUserQuestion hook (message="AskUserQuestion") opens the block
//   - any non-blocked status closes it (the answer landed and the agent moved on)
// While the block is open, a context-free permission_blocked Notification is the agent
// genuinely waiting — not a phantom — so it must not be suppressed. This is what keeps
// the web honest ("waiting for input", not "working/stuck") for raw-iTerm sessions whose
// question can't be scraped from a pane or read from the buffered JSONL until answered.
export function classifyBypassBlock(
  blocked: Set<string>,
  sessionId: string,
  status: string | undefined,
  permissionMode: string | undefined,
  message: string | undefined,
): { suppress: boolean } {
  if (status === "permission_blocked" && (message || "").startsWith("AskUserQuestion")) {
    blocked.add(sessionId);
  } else if (status && status !== "permission_blocked") {
    blocked.delete(sessionId);
  }
  const suppress =
    isPhantomBypassPermissionBlock(status, permissionMode, message) && !blocked.has(sessionId);
  return { suppress };
}

const tmuxTargetLocks = new Map<string, Promise<void>>();
// Cap how long a new caller will wait on an existing lock holder. Combined with the
// Promise.race timeout in deliverMessage, this keeps a single hung inject from wedging
// every subsequent inject for the same tmux session. Set well above typical inject
// (~5s) but below the deliverMessage ceiling (180s).
const TMUX_LOCK_WAIT_MS = 60_000;

async function withTmuxLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const baseTarget = target.split(":")[0];
  const start = Date.now();
  while (tmuxTargetLocks.has(baseTarget)) {
    const elapsed = Date.now() - start;
    if (elapsed >= TMUX_LOCK_WAIT_MS) {
      log(`tmux lock for ${baseTarget} held >${Math.round(elapsed / 1000)}s, forcing release and proceeding`);
      tmuxTargetLocks.delete(baseTarget);
      break;
    }
    const existing = tmuxTargetLocks.get(baseTarget);
    if (!existing) break;
    // Race the held lock against a short slice so the elapsed check runs even if
    // the holder never resolves.
    await Promise.race([
      existing,
      new Promise<void>(r => setTimeout(r, Math.min(1000, TMUX_LOCK_WAIT_MS - elapsed))),
    ]);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  tmuxTargetLocks.set(baseTarget, lock);
  try {
    return await fn();
  } finally {
    // Only delete if we still own the slot — a forced release may have replaced us
    // with a successor whose entry must not be removed by our finally.
    if (tmuxTargetLocks.get(baseTarget) === lock) {
      tmuxTargetLocks.delete(baseTarget);
    }
    resolve!();
  }
}

// Drives the live UI to "idle" through repeated classify→act→re-classify steps.
// Throws a structured error (SESSION_EXITED, AGENT_BUSY, AGENT_UNKNOWN_STATE, …)
// so retryStuckMessages can decide whether to redrive. Per-state actions are
// hardcoded to safe choices (Escape for both interrupted and rewind — Enter would
// rewind the conversation), and the stall guard fails fast if our action doesn't
// change the live state, instead of hammering the same key forever.
export async function ensureTmuxReady(target: string): Promise<void> {
  const BUSY_WAIT_MS = 90_000;
  const STUCK_BUDGET_MS = 8_000;
  const startedAt = Date.now();
  let busyLogged = false;
  let lastCorrectiveState: TmuxLiveState | null = null;
  let sameStateAttempts = 0;

  while (true) {
    let region: string;
    try {
      const { stdout } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", "-25"]);
      region = extractTmuxLiveRegion(stdout);
    } catch (err) {
      throw new Error(`AGENT_CAPTURE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    const state = classifyTmuxLiveState(region);

    if (state === "idle") return;
    if (state === "exited") {
      throw new Error("SESSION_EXITED: agent has exited, refusing to inject into bare shell");
    }

    if (state === "busy") {
      if (Date.now() - startedAt >= BUSY_WAIT_MS) {
        throw new Error("AGENT_BUSY: agent did not become idle within wait window, deferring");
      }
      if (!busyLogged) {
        log(`Agent busy in ${target}, waiting up to ${Math.round(BUSY_WAIT_MS / 1000)}s for idle before inject`);
        busyLogged = true;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }

    // Corrective states: cap total time and bail if our key didn't move the state.
    if (Date.now() - startedAt >= STUCK_BUDGET_MS) {
      throw new Error(`AGENT_NOT_READY: live state '${state}' did not settle within ${STUCK_BUDGET_MS}ms`);
    }
    if (state === lastCorrectiveState) {
      if (++sameStateAttempts >= 3) {
        throw new Error(`AGENT_STUCK_${state.toUpperCase()}: corrective input did not change live state`);
      }
    } else {
      sameStateAttempts = 0;
      lastCorrectiveState = state;
    }

    if (state === "unknown") {
      log(`Unrecognized live UI in ${target}, deferring: ${region.replace(/\s+/g, " ").slice(0, 240)}`);
      throw new Error("AGENT_UNKNOWN_STATE: deferring");
    }

    if (state === "interrupted") {
      log(`Clearing Interrupted dialog in ${target}`);
      await tmuxExec(["send-keys", "-t", target, "Escape"]);
      await new Promise(resolve => setTimeout(resolve, 500));
    } else if (state === "rewind") {
      log(`Cancelling Rewind dialog in ${target} (Escape, never Enter)`);
      await tmuxExec(["send-keys", "-t", target, "Escape"]);
      await new Promise(resolve => setTimeout(resolve, 500));
    } else if (state === "warning") {
      log(`Dismissing warning banner in ${target}`);
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
}

export async function injectViaTmux(target: string, content: string): Promise<void> {
  return withTmuxLock(target, () => injectViaTmuxInner(target, content));
}

async function injectViaTmuxInner(target: string, content: string): Promise<void> {
  const poll = parsePollMessage(content);
  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
    for (const step of steps) {
      if (step.text) {
        await tmuxExec(["send-keys", "-t", target, "Escape"]);
        await new Promise(resolve => setTimeout(resolve, 500));
        await tmuxExec(["send-keys", "-t", target, "-l", step.text]);
        await new Promise(resolve => setTimeout(resolve, 150));
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        await tmuxExec(["send-keys", "-t", target, step.key]);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (poll.text) {
      await new Promise(resolve => setTimeout(resolve, 300));
      await tmuxExec(["send-keys", "-t", target, "-l", poll.text]);
      await new Promise(resolve => setTimeout(resolve, 150));
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
    }
    log(`Injected poll response via tmux to ${target}`);
    return;
  }
  const sanitized = content.replace(/\r?\n/g, " ");

  // Closed-loop pre-flight: classify the live UI region only (transcript ignored),
  // dispatch the correct clearing key per state, re-classify, stop when idle. Never
  // sends a key without first proving which modal it'll act against — that's the
  // invariant that prevents Escape-at-idle from spuriously opening the Rewind dialog.
  await ensureTmuxReady(target);

  const contentLines = content.split(/\r?\n/).length;
  const captureLines = Math.max(30, contentLines + Math.ceil(sanitized.length / 60) + 10);
  const contentPrefix = sanitized.slice(0, 40);

  const doPaste = async () => {
    const id = `cc-${process.pid}-${Date.now()}`;
    const tmpFile = `/tmp/${id}`;
    try {
      fs.writeFileSync(tmpFile, sanitized);
      await tmuxExec(["load-buffer", "-b", id, tmpFile]);
      await tmuxExec(["paste-buffer", "-t", target, "-b", id, "-d"]);
    } catch (err) {
      await tmuxExec(["send-keys", "-t", target, "-l", sanitized]);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  };

  // Clear any stale input before pasting to prevent draft text from being
  // prepended to the injected message or submitted by the trailing Enter.
  //
  // Why C-u alone is not enough: in Claude Code 2.1.x's TUI input box, a single
  // C-u does not reliably empty the buffer when stale text is present (e.g. a
  // prompt recalled via Up arrow, or a partial draft). When that happens, the
  // paste-buffer content gets appended to whatever was left over and the
  // trailing Enter submits the concatenated string as a single user message —
  // the "old prompt + new follow-up" duplication seen on 2026-05-19.
  // Cycling C-a (move to start of line) + C-k (kill to end) reliably drains
  // the box, and three cycles handles multi-line drafts too. See
  // daemon.inject-clear.test.ts for the reproduction.
  await tmuxExec(["send-keys", "-t", target, "Escape"]);
  await new Promise(resolve => setTimeout(resolve, 50));
  for (let i = 0; i < 3; i++) {
    await tmuxExec(["send-keys", "-t", target, "C-a"]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await tmuxExec(["send-keys", "-t", target, "C-k"]);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 50));

  // Capture pane before paste for before/after comparison
  let prePaste = "";
  try {
    const { stdout } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
    prePaste = stdout;
  } catch {}

  // Paste once
  await doPaste();

  // Brief confirmation: did the pane change? (4 checks, 100ms apart = 400ms max).
  // Tightened from 5×200ms (1s) — observation: pane redraw after a tmux paste
  // is sub-100ms in practice; the long budget was defensive and rarely useful.
  // The post-submit verify loop below is the real safety net for "did the
  // payload actually reach the agent" — this is just an early signal.
  let pasteConfirmed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const { stdout: postPaste } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
      if (postPaste !== prePaste) {
        pasteConfirmed = true;
        break;
      }
    } catch {}
  }

  if (!pasteConfirmed) {
    log(`Paste may not have landed in ${target} (pane unchanged after 400ms), proceeding anyway`);
  }

  // Send Enter to submit. The adaptive delay scales with content length so
  // tmux paste-buffer has time to flush before Enter — but the 200ms floor
  // was overly generous: tmux paste + Enter are queued in the same pty
  // stream so order is preserved even for short pastes.
  const enterDelay = Math.max(100, Math.min(1000, Math.ceil(sanitized.length / 100) * 50));
  await new Promise(resolve => setTimeout(resolve, enterDelay));
  await tmuxExec(["send-keys", "-t", target, "Enter"]);

  // Post-submit: verify the agent started processing, and re-press Enter if it didn't. The
  // ultimate backstop for a lost message is the Convex healer (it revives any never-acked row,
  // including a stranded "pending", once the session is idle), but that takes minutes — this loop
  // recovers a dropped Enter in seconds, which is the common case ("text landed, Enter never
  // came through"). 5×400ms (2s) gives a lost Enter several corrective presses.
  let rePasted = false;
  for (let retry = 0; retry < 5; retry++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    try {
      const { stdout: postCheck } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
      const lastLines = postCheck.split("\n").slice(-15).join("\n");
      const hasPrompt = /[❯›]/.test(lastLines);
      const hasActivity = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|●|thinking|Bash|Read|Edit|Write|Glob|Grep/.test(lastLines);

      if (/-(?:ba)?sh:.*(?:No such file|command not found)/.test(lastLines) ||
          /Resume this session with:/i.test(postCheck)) {
        throw new Error("SESSION_EXITED: message was pasted into a bare shell");
      }

      if (hasActivity) {
        break;
      }

      // Check if text is still sitting in the input (look at full capture, not just last lines)
      const inputStuck = tmuxPromptStillHasInput(postCheck, contentPrefix);

      if (!hasPrompt && !inputStuck) {
        // No prompt visible AND text not in input = agent is processing
        break;
      }

      // Re-press Enter if either the input-detection heuristic still sees our text in the box,
      // OR we positively confirmed the paste landed yet see no sign the agent picked it up. The
      // second clause is the safety net for when tmuxPromptStillHasInput misses (a prompt glyph it
      // doesn't recognize, or TUI line-wrapping breaking the 40-char prefix match) while our text
      // is provably still sitting there unsubmitted — the exact "text landed but Enter never came
      // through" failure. Re-pressing Enter is safe: the only text in the box is the message we
      // want to submit, so it either submits that text or no-ops on an already-cleared prompt.
      if (inputStuck || (pasteConfirmed && hasPrompt)) {
        log(`Enter may not have submitted (retry ${retry + 1}, stuck=${inputStuck}), sending Enter again to ${target}`);
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        continue;
      }

      // Empty prompt, no activity -- paste may have been silently dropped
      if (hasPrompt && !pasteConfirmed && !rePasted && retry >= 2) {
        const promptLine = lastLines.split("\n").find(l => /[❯›]/.test(l));
        const afterPrompt = promptLine ? (promptLine.match(/[❯›]/) ? promptLine.slice(promptLine.match(/[❯›]/)!.index! + 1).trim() : "") : "";
        if (!afterPrompt) {
          log(`Paste likely dropped (empty prompt, no activity), re-pasting once to ${target}`);
          await tmuxExec(["send-keys", "-t", target, "C-u"]);
          await new Promise(resolve => setTimeout(resolve, 200));
          await doPaste();
          await new Promise(resolve => setTimeout(resolve, enterDelay));
          await tmuxExec(["send-keys", "-t", target, "Enter"]);
          rePasted = true;
          continue;
        }
      }

      break;
    } catch { break; }
  }

  log(`Injected via tmux to ${target}${pasteConfirmed ? "" : " (unconfirmed)"}${rePasted ? " (re-pasted)" : ""}`)
}

function buildAppleScript(
  app: "iTerm2" | "Terminal",
  normalizedTty: string,
  content: string,
  poll: ReturnType<typeof parsePollMessage>,
): { script: string; args: string } {
  const isIterm = app === "iTerm2";

  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));

    let stepActions: string;
    if (isIterm) {
      stepActions = steps.map((step, i) => {
        const lines: string[] = [];
        if (step.text) {
          lines.push(`            tell s to write text (ASCII character 27)`);
          lines.push("            delay 0.5");
          const escapedText = step.text.replace(/"/g, '\\"');
          lines.push(`            tell s to write text "${escapedText}" without newline`);
          lines.push("            delay 0.15");
          lines.push(`            tell s to write text ""`);
        } else {
          lines.push(`            tell s to write text "${step.key}" without newline`);
        }
        if (i < steps.length - 1) lines.push("            delay 0.5");
        return lines.join("\n");
      }).join("\n");
    } else {
      stepActions = steps.map((step, i) => {
        const lines: string[] = [];
        if (step.text) {
          lines.push(`          do script (ASCII character 27) in t`);
          lines.push("          delay 0.5");
          const escapedText = step.text.replace(/"/g, '\\"');
          lines.push(`          do script "${escapedText}" in t`);
        } else {
          lines.push(`          do script "${step.key}" in t`);
        }
        if (i < steps.length - 1) lines.push("          delay 0.5");
        return lines.join("\n");
      }).join("\n");
    }

    const textAction = poll.text
      ? isIterm
        ? `\n            delay 0.3\n            tell s to write text "${poll.text.replace(/"/g, '\\"')}" without newline\n            delay 0.15\n            tell s to write text ""`
        : `\n          delay 0.3\n          do script "${poll.text.replace(/"/g, '\\"')}" in t`
      : "";

    const script = isIterm
      ? `on run argv
  set targetTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
${stepActions}${textAction}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run`
      : `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
${stepActions}${textAction}
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
    return { script, args: `'${normalizedTty}'` };
  }

  const escapedContent = content.replace(/'/g, "'\\''");
  const script = isIterm
    ? `on run argv
  set msgText to item 1 of argv
  set targetTty to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
            tell s to write text msgText without newline
            delay 0.15
            tell s to write text ""
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run`
    : `on run argv
  set msgText to item 1 of argv
  set targetTty to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          do script msgText in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
  return { script, args: `'${escapedContent}' '${normalizedTty}'` };
}

// ── Terminal label helper ───────────────────────────────────────────────────
function getTerminalLabel(termProgram?: string): string {
  switch (termProgram) {
    case "Apple_Terminal": return "Terminal.app";
    case "iTerm.app": return "iTerm2";
    case "ghostty": return "Ghostty";
    case "kitty": return "Kitty";
    case "WezTerm": return "WezTerm";
    case "Alacritty": return "Alacritty";
    default: return termProgram || "iTerm2";
  }
}

// Terminals where we know there's no direct injection API — tmux required
const TMUX_ONLY_TERMINALS = new Set(["ghostty", "Alacritty"]);

// ── AppleScript injection (iTerm2 + Terminal.app) ──────────────────────────
// Extracted from original injectViaTerminal — logic is identical
async function injectViaAppleScript(tty: string, content: string, termProgram?: string): Promise<void> {
  const normalizedTty = normalizeTty(tty);
  const poll = parsePollMessage(content);

  const app: "iTerm2" | "Terminal" = termProgram === "Apple_Terminal" ? "Terminal" : "iTerm2";
  const { script, args } = buildAppleScript(app, normalizedTty, content, poll);

  const tmpFile = path.join(CONFIG_DIR, "terminal-inject.scpt");
  fs.writeFileSync(tmpFile, script);
  try {
    const { stdout } = await execAsync(`osascript "${tmpFile}" ${args}`);
    if (stdout.trim() === "not_found") {
      throw new Error(`${app} session not found for TTY ${normalizedTty}`);
    }
    log(`Injected ${poll ? "poll response" : "message"} via ${app} for TTY ${normalizedTty}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Kitty injection via remote control (`kitty @`) ─────────────────────────
// Requires allow_remote_control in kitty.conf

function mapKeyForKitty(key: string): string {
  const map: Record<string, string> = {
    Return: "enter", Enter: "enter", Escape: "escape",
    Up: "up", Down: "down", Left: "left", Right: "right",
    Tab: "tab", Space: "space", Backspace: "backspace", Delete: "delete",
  };
  return map[key] || key.toLowerCase();
}

async function findKittyWindowId(normalizedTty: string): Promise<number | null> {
  const { stdout } = await execAsync("kitty @ ls");
  const osWindows = JSON.parse(stdout);
  for (const osWindow of osWindows) {
    for (const tab of osWindow.tabs) {
      for (const window of tab.windows) {
        try {
          const { stdout: ttyOut } = await execAsync(`ps -o tty= -p ${window.pid}`);
          const windowTty = normalizeTty(ttyOut.trim());
          if (windowTty === normalizedTty) return window.id;
        } catch {}
      }
    }
  }
  return null;
}

async function injectViaKitty(tty: string, content: string): Promise<void> {
  const normalizedTty = normalizeTty(tty);
  const windowId = await findKittyWindowId(normalizedTty);
  if (windowId === null) {
    throw new Error(`Kitty window not found for TTY ${normalizedTty}`);
  }
  const match = `--match id:${windowId}`;

  const poll = parsePollMessage(content);
  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map((k: string) => ({ key: k }));
    for (const step of steps) {
      if (step.text) {
        await execAsync(`kitty @ send-key ${match} escape`);
        await new Promise(r => setTimeout(r, 500));
        const escaped = step.text.replace(/'/g, "'\\''");
        await execAsync(`kitty @ send-text ${match} '${escaped}'`);
        await new Promise(r => setTimeout(r, 150));
        await execAsync(`kitty @ send-key ${match} enter`);
      } else {
        await execAsync(`kitty @ send-key ${match} ${mapKeyForKitty(step.key)}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (poll.text) {
      await new Promise(r => setTimeout(r, 300));
      const escaped = poll.text.replace(/'/g, "'\\''");
      await execAsync(`kitty @ send-text ${match} '${escaped}'`);
      await new Promise(r => setTimeout(r, 150));
      await execAsync(`kitty @ send-key ${match} enter`);
    }
    log(`Injected poll response via Kitty for TTY ${normalizedTty}`);
    return;
  }

  const escaped = content.replace(/'/g, "'\\''");
  await execAsync(`kitty @ send-text ${match} '${escaped}'`);
  log(`Injected message via Kitty for TTY ${normalizedTty}`);
}

// ── WezTerm injection via CLI (`wezterm cli`) ──────────────────────────────

const WEZTERM_KEY_SEQUENCES: Record<string, string> = {
  Return: "\r", Enter: "\r", Escape: "\x1b",
  Up: "\x1b[A", Down: "\x1b[B", Left: "\x1b[D", Right: "\x1b[C",
  Tab: "\t", Backspace: "\x7f", Delete: "\x1b[3~", Space: " ",
};

async function findWezTermPaneId(normalizedTty: string): Promise<number | null> {
  const { stdout } = await execAsync("wezterm cli list --format json");
  const panes = JSON.parse(stdout);
  for (const pane of panes) {
    if (pane.tty_name && normalizeTty(pane.tty_name) === normalizedTty) {
      return pane.pane_id;
    }
  }
  return null;
}

async function weztermSendText(paneId: number, text: string): Promise<void> {
  const escaped = text.replace(/'/g, "'\\''");
  await execAsync(`printf '%s' '${escaped}' | wezterm cli send-text --pane-id ${paneId} --no-paste`);
}

async function injectViaWezTerm(tty: string, content: string): Promise<void> {
  const normalizedTty = normalizeTty(tty);
  const paneId = await findWezTermPaneId(normalizedTty);
  if (paneId === null) {
    throw new Error(`WezTerm pane not found for TTY ${normalizedTty}`);
  }

  const poll = parsePollMessage(content);
  if (poll) {
    const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map((k: string) => ({ key: k }));
    for (const step of steps) {
      if (step.text) {
        await weztermSendText(paneId, "\x1b"); // Escape
        await new Promise(r => setTimeout(r, 500));
        await weztermSendText(paneId, step.text);
        await new Promise(r => setTimeout(r, 150));
        await weztermSendText(paneId, "\r"); // Enter
      } else {
        const seq = WEZTERM_KEY_SEQUENCES[step.key];
        await weztermSendText(paneId, seq || step.key);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (poll.text) {
      await new Promise(r => setTimeout(r, 300));
      await weztermSendText(paneId, poll.text);
      await new Promise(r => setTimeout(r, 150));
      await weztermSendText(paneId, "\r");
    }
    log(`Injected poll response via WezTerm for TTY ${normalizedTty}`);
    return;
  }

  await weztermSendText(paneId, content);
  log(`Injected message via WezTerm for TTY ${normalizedTty}`);
}

// ── Terminal injection router ──────────────────────────────────────────────
// Routes to the appropriate strategy based on TERM_PROGRAM.
// AppleScript path (iTerm2/Terminal.app) is the default fallback for
// unknown terminals — preserves existing behavior exactly.
async function injectViaTerminal(tty: string, content: string, termProgram?: string): Promise<void> {
  if (termProgram === "kitty") {
    return injectViaKitty(tty, content);
  }
  if (termProgram === "WezTerm") {
    return injectViaWezTerm(tty, content);
  }
  if (termProgram && TMUX_ONLY_TERMINALS.has(termProgram)) {
    throw new Error(`${getTerminalLabel(termProgram)} does not support direct injection — use tmux for this terminal`);
  }
  // Apple_Terminal, iTerm.app, unknown → existing AppleScript path
  return injectViaAppleScript(tty, content, termProgram);
}


type SessionFileInfo = { path: string; agentType: "claude" | "codex" | "cursor" | "gemini" };

function findSessionJsonlPath(sessionId: string): string | null {
  return findSessionFile(sessionId)?.path ?? null;
}

function findSessionFile(sessionId: string): SessionFileInfo | null {
  // Claude sessions: ~/.claude/projects/<hash>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (fs.existsSync(claudeProjectsDir)) {
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const dir of projectDirs) {
      const jsonlPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) return { path: jsonlPath, agentType: "claude" };
      // Check subagent directories: <parent-session-id>/subagents/<sessionId>.jsonl
      const dirPath = path.join(claudeProjectsDir, dir);
      try {
        const subEntries = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const subDir of subEntries) {
          const subPath = path.join(dirPath, subDir.name, `${sessionId}.jsonl`);
          if (fs.existsSync(subPath)) return { path: subPath, agentType: "claude" };
        }
      } catch {}
    }
  }

  // Codex sessions: ~/.codex/sessions/YYYY/MM/DD/<name>-<timestamp>-<sessionId>.jsonl
  const codexSessionsDir = path.join(process.env.HOME || "", ".codex", "sessions");
  if (fs.existsSync(codexSessionsDir)) {
    try {
      const findCodex = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findCodex(fullPath);
            if (found) return found;
          } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
            return fullPath;
          }
        }
        return null;
      };
      const codexPath = findCodex(codexSessionsDir);
      if (codexPath) return { path: codexPath, agentType: "codex" };
    } catch {}
  }

  // Gemini sessions: ~/.gemini/tmp/<hash>/chats/<sessionId>.json
  const geminiTmpDir = path.join(process.env.HOME || "", ".gemini", "tmp");
  if (fs.existsSync(geminiTmpDir)) {
    try {
      const projectDirs = fs.readdirSync(geminiTmpDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
      for (const dir of projectDirs) {
        const chatsDir = path.join(geminiTmpDir, dir, "chats");
        if (!fs.existsSync(chatsDir)) continue;
        const jsonPath = path.join(chatsDir, `${sessionId}.json`);
        if (fs.existsSync(jsonPath)) return { path: jsonPath, agentType: "gemini" };
      }
    } catch {}
  }

  return null;
}

const resumeSessionCache = new Map<string, string>();
// Sessions whose liveness we heartbeat. A single global flush loop batches all
// of these into ONE mutation per tick (flushManagedHeartbeats) instead of one
// mutation per session — so the inbox/plans/tasks subscriptions, which collect
// every managed_sessions row, are invalidated once per flush rather than once
// per session per 30s. See managedSessions:heartbeatBatch.
const managedHeartbeatSessions = new Set<string>();
let heartbeatFlushTimer: NodeJS.Timeout | null = null;
let heartbeatFlushInProgress = false;
let heartbeatFlushCount = 0;
const HEARTBEAT_FLUSH_INTERVAL_MS = 30_000;
// Cap the per-transaction slice so a write conflict retries a bounded number of
// rows, not the whole fleet.
const HEARTBEAT_BATCH_SIZE = 25;
const HEALTH_CHECK_EVERY_N_HEARTBEATS = 3;

// Tmux-kill policy: the daemon only tears down a managed tmux session in
// response to an *unambiguous* death signal — the session is no longer listed
// by tmux at all (a `tmux has-session` failure). Passive indicators ("no agent
// process visible in the pane's process tree", "JSONL hasn't been written for
// N minutes", "CPU is near zero") are never enough to justify auto-killing
// a worker. Operators drive repair via the UI's Kill & restart action when
// they see a session looks wedged.

// Heartbeat responses are intentionally ignored. The old "dismissed + idle for
// 1h → kill" auto-reap was removed: dismissal is a UI state, not a worker
// lifecycle signal — a user can dismiss a card and still expect the agent
// running when they return. Workers live until the user explicitly kills them.
// (The batched heartbeat therefore returns only a count, not per-session state.)

// Codex tmux pane monitoring for permission prompts
const codexPermissionPollers = new Map<string, NodeJS.Timeout>();
const codexPermissionPending = new Set<string>(); // sessionIds currently waiting for permission decision
const codexPermissionRunning = new Set<string>(); // sessionIds with an in-flight tmux capture

let codexAppServerInstance: CodexAppServer | null = null;
type AppServerThreadEntry = { threadId: string; conversationId: string; cwd?: string; approvalPolicy?: ApprovalPolicy };
type PersistedAppServerThreadRecord = { threadId: string; updatedAt: number; cwd?: string };
type AppServerTurnProgress = { threadId: string; items: ThreadItem[]; lastSyncedSignature?: string };
const appServerThreads = new Map<string, AppServerThreadEntry>();
const appServerConversations = new Map<string, string>();
const persistedAppServerThreads = new Map<string, PersistedAppServerThreadRecord>();
const appServerTurnProgress = new Map<string, AppServerTurnProgress>();
const APP_SERVER_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let rehydratePersistedAppServerThreadsPromise: Promise<void> | null = null;

export function upsertAppServerThreadRegistration(
  threads: Map<string, AppServerThreadEntry>,
  conversations: Map<string, string>,
  conversationId: string,
  threadId: string,
  extra?: Partial<AppServerThreadEntry>,
): void {
  const existingThreadId = conversations.get(conversationId);
  if (existingThreadId && existingThreadId !== threadId) {
    const existingThreadEntry = threads.get(existingThreadId);
    if (existingThreadEntry?.conversationId === conversationId) {
      threads.delete(existingThreadId);
    }
  }

  const existingConversation = threads.get(threadId)?.conversationId;
  if (existingConversation && existingConversation !== conversationId) {
    conversations.delete(existingConversation);
  }

  threads.set(threadId, { threadId, conversationId, ...extra });
  conversations.set(conversationId, threadId);
}

export function removeAppServerThreadRegistration(
  threads: Map<string, AppServerThreadEntry>,
  conversations: Map<string, string>,
  conversationId: string,
  threadId?: string,
): void {
  const resolvedThreadId = threadId ?? conversations.get(conversationId);
  conversations.delete(conversationId);
  if (!resolvedThreadId) return;
  const existing = threads.get(resolvedThreadId);
  if (existing?.conversationId === conversationId) {
    threads.delete(resolvedThreadId);
  }
}

function findActiveTurnForThread(threadId: string): string | undefined {
  for (const [turnId, progress] of appServerTurnProgress) {
    if (progress.threadId === threadId) return turnId;
  }
  return undefined;
}

function clearLiveAppServerThreadRegistrations(): void {
  appServerThreads.clear();
  appServerConversations.clear();
  appServerTurnProgress.clear();
}

function buildAppServerProgressSignature(messages: RawMessage[]): string {
  return JSON.stringify(messages.map((message) => ({
    uuid: message.uuid,
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    images: message.images,
    subtype: message.subtype,
  })));
}

async function syncAppServerTurnMessagesIfChanged(
  turnId: string,
  conversationId: string,
  messages: RawMessage[],
  syncService: SyncService,
  retryQueue: RetryQueue,
  threadIdForLog: string,
): Promise<void> {
  if (messages.length === 0) return;
  const progress = appServerTurnProgress.get(turnId);
  if (!progress) return;
  const signature = buildAppServerProgressSignature(messages);
  if (progress.lastSyncedSignature === signature) return;
  const batchResult = await syncMessagesBatch(messages, conversationId, syncService, retryQueue);
  if (!batchResult.authExpired && !batchResult.conversationNotFound) {
    progress.lastSyncedSignature = signature;
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(threadIdForLog);
    log(`[codex-app-server] live synced ${messages.length} messages for thread ${threadIdForLog}`);
  }
}

function persistAppServerThreadRegistrations(): void {
  try {
    const data: Record<string, PersistedAppServerThreadRecord> = {};
    const now = Date.now();
    for (const [conversationId, record] of persistedAppServerThreads) {
      if (now - record.updatedAt < APP_SERVER_THREAD_TTL_MS) {
        data[conversationId] = record;
      }
    }
    fs.writeFileSync(APP_SERVER_THREADS_FILE, JSON.stringify(data), "utf-8");
  } catch {}
}

function registerAppServerConversation(
  conversationId: string,
  threadId: string,
  opts: {
    cwd?: string;
    updatedAt?: number;
    persist?: boolean;
    approvalPolicy?: ApprovalPolicy;
  } = {},
): void {
  const updatedAt = opts.updatedAt ?? Date.now();
  const existingThreadId = appServerConversations.get(conversationId);
  const existingConversation = appServerThreads.get(threadId)?.conversationId;
  upsertAppServerThreadRegistration(appServerThreads, appServerConversations, conversationId, threadId, { cwd: opts.cwd, approvalPolicy: opts.approvalPolicy });
  if (!opts.persist) return;
  if (existingConversation && existingConversation !== conversationId) {
    persistedAppServerThreads.delete(existingConversation);
  }
  persistedAppServerThreads.set(conversationId, { threadId, updatedAt, cwd: opts.cwd });
  if (existingThreadId && existingThreadId !== threadId) {
    persistedAppServerThreads.delete(conversationId);
  }
  persistAppServerThreadRegistrations();
}

function forgetPersistedAppServerConversation(conversationId: string): void {
  if (!persistedAppServerThreads.delete(conversationId)) return;
  persistAppServerThreadRegistrations();
}

function markAppServerConversationResumable(
  conversationId: string,
  threadId?: string,
  updatedAt: number = Date.now(),
): void {
  const resolvedThreadId = threadId ?? appServerConversations.get(conversationId);
  if (!resolvedThreadId) return;
  const liveEntry = appServerThreads.get(resolvedThreadId);
  persistedAppServerThreads.set(conversationId, {
    threadId: resolvedThreadId,
    updatedAt,
    cwd: liveEntry?.cwd,
  });
  persistAppServerThreadRegistrations();
}

async function rehydratePersistedAppServerThreads(): Promise<void> {
  if (!codexAppServerInstance?.running || persistedAppServerThreads.size === 0) return;

  const entries = [...persistedAppServerThreads.entries()];
  let resumed = 0;
  let dropped = 0;

  for (const [conversationId, record] of entries) {
    if (appServerConversations.has(conversationId)) continue;
    try {
      await codexAppServerInstance.threadResume({
        threadId: record.threadId,
        ...(record.cwd ? { cwd: record.cwd } : {}),
      });
      const rehydratedPolicy = resolveCodexApprovalPolicy(activeConfig);
      registerAppServerConversation(conversationId, record.threadId, {
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        persist: false,
        approvalPolicy: rehydratedPolicy,
      });
      ensureManagedSessionHeartbeat(record.threadId);
      resumed++;
    } catch (err) {
      dropped++;
      persistedAppServerThreads.delete(conversationId);
      log(`[codex-app-server] dropping persisted thread ${record.threadId.slice(0, 8)} for conv=${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (dropped > 0) {
    persistAppServerThreadRegistrations();
  }
  if (resumed > 0 || dropped > 0) {
    log(`[codex-app-server] rehydrated ${resumed} persisted thread(s), dropped ${dropped}`);
  }
}

function loadPersistedAppServerThreadRegistrations(): void {
  try {
    if (!fs.existsSync(APP_SERVER_THREADS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(APP_SERVER_THREADS_FILE, "utf-8")) as Record<string, { threadId: string; updatedAt?: number; cwd?: string }>;
    const now = Date.now();
    let loaded = 0;
    for (const [conversationId, record] of Object.entries(raw)) {
      if (!record?.threadId) continue;
      const updatedAt = record.updatedAt ?? now;
      if (now - updatedAt >= APP_SERVER_THREAD_TTL_MS) continue;
      persistedAppServerThreads.set(conversationId, {
        threadId: record.threadId,
        updatedAt,
        cwd: record.cwd,
      });
      loaded++;
    }
    if (loaded > 0) {
      log(`Loaded ${loaded} app-server thread registration(s) from disk`);
    }
  } catch {}
}

const CODEX_PERMISSION_PATTERNS = [
  /Would you like to run the following command\?/,
  /Press enter to confirm or esc to cancel/,
  /Do you want to proceed\?/,
];

function detectCodexPermissionFromPane(paneContent: string): { reason: string; command: string } | null {
  if (!CODEX_PERMISSION_PATTERNS.some(p => p.test(paneContent))) return null;

  let reason = "";
  let command = "";
  const lines = paneContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("Reason:")) {
      reason = line.replace(/.*Reason:\s*/, "").trim();
    }
    if (line.startsWith("$ ")) {
      command = line.slice(2).trim();
      // Collect continuation lines (long commands wrap)
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("1.") && !next.startsWith("2.") && !next.startsWith("3.") && !next.startsWith("Press ")) {
          command += " " + next;
        } else break;
      }
    }
  }

  return { reason: reason || "Command approval requested", command: command.slice(0, 300) };
}

function startCodexPermissionPoller(sessionId: string, tmuxSession: string, conversationId: string, syncService: SyncService): void {
  if (codexPermissionPollers.has(sessionId)) return;

  const interval = setInterval(async () => {
    if (codexPermissionPending.has(sessionId)) return;
    if (codexPermissionRunning.has(sessionId)) return;
    if (isInWakeGrace()) return;

    codexPermissionRunning.add(sessionId);
    try {
      const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-30"], { timeout: 3000, killSignal: "SIGKILL" });
      const prompt = detectCodexPermissionFromPane(paneContent);
      if (!prompt) return;

      codexPermissionPending.add(sessionId);
      log(`Codex permission prompt detected in tmux for session ${sessionId.slice(0, 8)}: ${prompt.reason.slice(0, 100)}`);

      sendAgentStatus(syncService, conversationId, sessionId, "permission_blocked");

      const preview = truncateForNotification(
        `${prompt.command || prompt.reason}`, 200
      );
      syncService.createSessionNotification({
        conversation_id: conversationId,
        type: "permission_request",
        title: "codecast - Permission needed",
        message: preview,
      }).catch(() => {});

      const permissionPrompt = {
        tool_name: "exec_command",
        arguments_preview: prompt.command || prompt.reason,
      };

      handlePermissionRequest(syncService, conversationId, sessionId, permissionPrompt, log)
        .then(async (decision) => {
          if (decision) {
            const key = decision.approved ? "Enter" : "Escape";
            log(`Injecting Codex permission '${key}' for session ${sessionId.slice(0, 8)}`);
            try {
              await tmuxExec(["send-keys", "-t", tmuxSession, key]);
            } catch (err) {
              log(`Failed to inject Codex permission key: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          sendAgentStatus(syncService, conversationId, sessionId, "working");
          codexPermissionPending.delete(sessionId);
        })
        .catch((err) => {
          log(`Codex permission handling error: ${err instanceof Error ? err.message : String(err)}`);
          codexPermissionPending.delete(sessionId);
        });
    } catch {
      // tmux session may have ended
    } finally {
      codexPermissionRunning.delete(sessionId);
    }
  }, 3000);

  codexPermissionPollers.set(sessionId, interval);
  log(`Started Codex permission poller for session ${sessionId.slice(0, 8)} on tmux ${tmuxSession}`);
}

function stopCodexPermissionPoller(sessionId: string): void {
  const interval = codexPermissionPollers.get(sessionId);
  if (interval) {
    clearInterval(interval);
    codexPermissionPollers.delete(sessionId);
    codexPermissionPending.delete(sessionId);
  }
}

type StartedSessionInfo = {
  tmuxSession: string;
  projectPath: string;
  startedAt: number;
  agentType: "claude" | "codex" | "cursor" | "gemini";
  sessionId?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
};

const STARTED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

class PersistedStartedSessions extends Map<string, StartedSessionInfo> {
  constructor() {
    super();
    this.load();
  }

  set(key: string, value: StartedSessionInfo): this {
    super.set(key, value);
    this.save();
    return this;
  }

  delete(key: string): boolean {
    const result = super.delete(key);
    if (result) this.save();
    return result;
  }

  private save(): void {
    try {
      const data: Record<string, StartedSessionInfo> = {};
      const now = Date.now();
      for (const [k, v] of this) {
        if (now - v.startedAt < STARTED_SESSION_TTL_MS) data[k] = v;
      }
      fs.writeFileSync(STARTED_SESSIONS_FILE, JSON.stringify(data), "utf-8");
    } catch {}
  }

  private load(): void {
    try {
      if (!fs.existsSync(STARTED_SESSIONS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(STARTED_SESSIONS_FILE, "utf-8"));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw) as [string, StartedSessionInfo][]) {
        if (now - v.startedAt < STARTED_SESSION_TTL_MS) {
          super.set(k, v);
        }
      }
      if (this.size > 0) {
        log(`Loaded ${this.size} started session(s) from disk`);
      }
    } catch {}
  }
}

loadPersistedAppServerThreadRegistrations();
const startedSessionTmux = new PersistedStartedSessions();
const restartingSessionIds = new Map<string, number>();
const RESTART_GUARD_TTL_MS = 60_000;

// Prevent concurrent resume attempts on the same session
const resumeInFlight = new Map<string, Promise<boolean>>();
const resumeInFlightStarted = new Map<string, number>();
const RESUME_IN_FLIGHT_TIMEOUT_MS = 120_000;

// How long to wait for a cold-resumed agent to render its prompt before giving up.
// A `claude --resume` replays the whole transcript on boot, so the window scales
// with JSONL size. The floor was 15s, which was too tight for a from-scratch
// (reconstituted) session — the boot would still be initializing when the poll
// gave up, and the optimistic inject pasted into a half-booted/dead shell. 30s
// floor gives a normal cold boot room to finish.
export function resumeReadinessPollMs(jsonlSizeBytes: number): number {
  if (jsonlSizeBytes > 10_000_000) return 90_000;
  if (jsonlSizeBytes > 1_000_000) return 45_000;
  return 30_000;
}

// ---- Tier 3: warm pool selection (pure policy, unit-tested) ----
// Only an ACTIVE recent session whose agent has DIED is a warm candidate. The
// recency window is deliberately short and mirrors the watchdog's idle-stale cutoff:
// once a session has been idle long enough to be marked completed it is no longer
// "hot", and re-warming it would resurrect work the user (or the agent) finished.
// Circuit-broken and fatally-failed sessions are excluded so we never pile resume
// attempts onto something that's already failing.
export const WARM_POOL_ACTIVE_STATUSES = new Set(["idle", "working", "thinking", "connected"]);

export interface WarmCandidate {
  sessionId: string;
  status: string;      // last hook status for the session
  tsMs: number;        // when that status was observed (ms epoch)
  agentAlive: boolean; // is a live agent already attached?
  circuitOpen: boolean;
  fatal: boolean;
}

export function selectSessionsToWarm(
  candidates: WarmCandidate[],
  nowMs: number,
  opts: { recencyWindowMs: number; cap: number },
): string[] {
  if (opts.cap <= 0) return [];
  return candidates
    .filter(c => WARM_POOL_ACTIVE_STATUSES.has(c.status))
    .filter(c => nowMs - c.tsMs <= opts.recencyWindowMs)
    .filter(c => !c.agentAlive)   // already warm — nothing to do
    .filter(c => !c.circuitOpen)  // already failing — don't pile on
    .filter(c => !c.fatal)        // unrecoverable — don't try
    .sort((a, b) => b.tsMs - a.tsMs) // most-recently-active first
    .slice(0, opts.cap)
    .map(c => c.sessionId);
}

type ResumeFatalReason = "missing_conversation" | "session_not_found";
const resumeFatalReasons = new Map<string, ResumeFatalReason>();
const conversationResumeFailures = new Map<string, { count: number; lastFailure: number }>();
const CONVERSATION_RESUME_MAX_FAILURES = 3;
const CONVERSATION_RESUME_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after max failures

// The circuit breaker is reason-aware. A FATAL failure (no conversation, retired
// model, session JSONL truly gone) means "stop trying for a while" — the long
// cooldown. A TRANSIENT failure (a resume we just launched died, a slow/raced
// boot, a one-off SESSION_EXITED during inject) means "back off briefly, then
// retry" — a short cooldown. Treating both the same is what turned a single
// recoverable cold-boot into a 5-minute dead session: 3 quick transient give-ups
// tripped the 300s breaker even though the identical resume succeeded moments
// later. The cooldown is set by the MOST RECENT failure's severity.
const sessionDeliveryFailures = new Map<string, { count: number; lastFailure: number; cooldownMs: number }>();
const SESSION_CIRCUIT_BREAKER_THRESHOLD = 3;
const SESSION_CIRCUIT_BREAKER_COOLDOWN_MS = 300_000; // 5 minutes — fatal failures
const SESSION_CIRCUIT_BREAKER_TRANSIENT_COOLDOWN_MS = 15_000; // 15s — transient (slow/raced boot)

export function isSessionCircuitOpen(sessionId: string): boolean {
  const entry = sessionDeliveryFailures.get(sessionId);
  if (!entry) return false;
  if (entry.count >= SESSION_CIRCUIT_BREAKER_THRESHOLD) {
    if (Date.now() - entry.lastFailure < entry.cooldownMs) return true;
    sessionDeliveryFailures.delete(sessionId);
  }
  return false;
}

export function recordSessionDeliveryFailure(sessionId: string, opts?: { transient?: boolean }): void {
  const prev = sessionDeliveryFailures.get(sessionId);
  const cooldownMs = opts?.transient
    ? SESSION_CIRCUIT_BREAKER_TRANSIENT_COOLDOWN_MS
    : SESSION_CIRCUIT_BREAKER_COOLDOWN_MS;
  sessionDeliveryFailures.set(sessionId, {
    count: (prev?.count ?? 0) + 1,
    lastFailure: Date.now(),
    cooldownMs,
  });
}

export function resetSessionDeliveryFailures(sessionId: string): void {
  sessionDeliveryFailures.delete(sessionId);
}

const UUID_JSONL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function classifyClaudeResumeFatalReason(paneContent: string): ResumeFatalReason | null {
  if (/No conversation found with session ID:/i.test(paneContent)) return "missing_conversation";
  if (/Session not found/i.test(paneContent)) return "session_not_found";
  return null;
}

export function shouldMaterializeFreshClaudeSession(reason: ResumeFatalReason | null | undefined): boolean {
  return reason === "missing_conversation" || reason === "session_not_found";
}

export function shouldStartBlankSessionAfterResumeFailure(reason: ResumeFatalReason | null | undefined): boolean {
  return !shouldMaterializeFreshClaudeSession(reason);
}

// A reconstituted session's JSONL records the model it was made with — often a
// pinned snapshot like claude-opus-4-6-20260205. Snapshots get retired when a
// newer model ships, and `claude --resume` then dies with "the selected model
// ... may not exist". Claude also accepts the short names opus/sonnet/haiku, which
// always resolve to the current model of that line. Return the short name matching
// the recorded model so a resume lands on a live model instead of a dead snapshot.
export function claudeModelAlias(jsonlContent: string): string | null {
  const m = jsonlContent.match(/"model"\s*:\s*"claude-(opus|sonnet|haiku)\b/);
  return m ? m[1] : null;
}

// Pick the `--model` flag for a resume. We override the model on EVERY resume,
// not just forks: the reconstructed JSONL records whatever model the session last
// ran on, which may be a now-retired pinned snapshot. Resolving to the line's
// short alias (opus/sonnet/haiku) always lands on a live model and never goes
// stale — if the recorded model is still current the alias resolves to it anyway.
// An explicit --model in extraFlags always wins.
export function resumeModelFlag(jsonlContent: string, extraFlags: string): string {
  if (/(^|\s)--model(\s|=)/.test(extraFlags)) return "";
  const alias = claudeModelAlias(jsonlContent);
  return alias ? ` --model ${alias}` : "";
}

function stopManagedSessionHeartbeat(sessionId: string | undefined): void {
  if (!sessionId) return;
  managedHeartbeatSessions.delete(sessionId);
}

function ensureManagedSessionHeartbeat(sessionId: string): void {
  if (!syncServiceRef) return;
  managedHeartbeatSessions.add(sessionId);
  ensureHeartbeatFlushLoop();
}

function ensureHeartbeatFlushLoop(): void {
  if (heartbeatFlushTimer || !syncServiceRef) return;
  heartbeatFlushTimer = setInterval(() => { void flushManagedHeartbeats(); }, HEARTBEAT_FLUSH_INTERVAL_MS);
}

// Run an async op over items with bounded concurrency (a small worker pool), so
// a fleet-wide pass doesn't fire N tmux/network calls at once.
async function runBounded<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const worker = async () => { while (idx < items.length) await fn(items[idx++]); };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// Deterministically place a session in one of `mod` buckets — used to spread the
// per-session health check across flush ticks instead of running the whole fleet
// on one tick.
export function heartbeatHealthCheckBucket(sessionId: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return h % mod;
}

// One flush per HEARTBEAT_FLUSH_INTERVAL_MS for the WHOLE fleet: collapses N
// per-session heartbeat transactions into ⌈N/25⌉ batched ones, so the inbox
// subscription recomputes ~once per flush instead of ~once per session.
async function flushManagedHeartbeats(): Promise<void> {
  if (!syncServiceRef || managedHeartbeatSessions.size === 0) return;
  // Re-entrancy guard: the flush does the batched sends AND a bounded tmux
  // health-check pass, which under load can run past one interval. Skipping a
  // tick while the prior flush is still in flight keeps flushes from piling up
  // (registration stamps last_heartbeat fresh, so a skipped tick is harmless).
  if (heartbeatFlushInProgress) return;
  heartbeatFlushInProgress = true;
  try {
    await runHeartbeatFlush();
  } finally {
    heartbeatFlushInProgress = false;
  }
}

async function runHeartbeatFlush(): Promise<void> {
  const ids = [...managedHeartbeatSessions];
  const flushTick = heartbeatFlushCount++;
  const now = Date.now();

  // Batched liveness write. logHeartbeatStatus stays per-session (throttled,
  // local-only). Resource metrics are pushed separately by collectResourceSnapshot.
  const payload = ids.map((sessionId) => {
    const status = lastSentAgentStatus.get(sessionId);
    logHeartbeatStatus(sessionId, status);
    return status
      ? { session_id: sessionId, agent_status: status, client_ts: now }
      : { session_id: sessionId };
  });
  const batchCount = Math.ceil(payload.length / HEARTBEAT_BATCH_SIZE);
  for (let i = 0; i < payload.length; i += HEARTBEAT_BATCH_SIZE) {
    try {
      await syncServiceRef.heartbeatManagedSessionsBatch(payload.slice(i, i + HEARTBEAT_BATCH_SIZE));
    } catch {}
  }
  // One line/tick to confirm the fleet flushes in a handful of transactions
  // (each = one inbox invalidation) rather than ~N. Pre-batch this was N/30s.
  log(`[HEARTBEAT-FLUSH] sessions=${ids.length} batches=${batchCount}`);

  // Self-heal pass (local): reconcile a status latched on a lost hook transition
  // against the transcript/pane. Sharded by session so only ~1/N of the fleet
  // runs each tick (every session every N ticks ≈ 90s), and bounded so the tmux
  // captures stay gentle. heartbeatHealthCheck also reconstitutes a session whose
  // tmux has vanished.
  const phase = flushTick % HEALTH_CHECK_EVERY_N_HEARTBEATS;
  const due = ids.filter((id) => heartbeatHealthCheckBucket(id, HEALTH_CHECK_EVERY_N_HEARTBEATS) === phase);
  for (const sessionId of due) {
    try { reconcileStatusFromTranscript(sessionId, syncServiceRef); } catch {}
  }
  await runBounded(due, 5, (sessionId) => heartbeatHealthCheck(sessionId).catch(() => {}));
}

// Reads the last ~64KB of a file as UTF-8 without loading the whole thing --
// transcripts run to MBs and this is called per-session on every heartbeat.
function readFileTailSync(filePath: string, maxBytes = 64 * 1024): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Self-heals a status latch frozen on a lost lifecycle transition by reconciling
// lastSentAgentStatus against the session's JSONL transcript (the universal
// ground truth -- works for tmux-managed and bare-terminal sessions alike). The
// decision is the pure reconciledStatus, which defers on any ambiguity. Claude and
// Codex transcripts are both parsed (each via its own tail classifier); Codex in
// particular has no Stop-hook equivalent and its watcher-driven idle transition
// rides a setTimeout that dies across macOS sleep, so this heartbeat-driven path
// is its only durable latch recovery. Gemini/Cursor formats are not yet classified.
function reconcileStatusFromTranscript(sessionId: string, syncService: SyncService): void {
  const stored = lastSentAgentStatus.get(sessionId);

  // permission_blocked recovery runs for ALL sessions, tmux-managed included:
  // it's the one latch neither the pane reconcile (paneReconcileTarget defers on
  // it) nor reconciledStatus recovers, and the pane can't distinguish an answered
  // poll from a pending one. The transcript can -- a tail ending in a user turn
  // means the prompt was answered. Restricted to Claude (Codex permission blocks
  // are recovered by startCodexPermissionPoller's own working transition).
  if (stored === "permission_blocked") {
    const file = findSessionFile(sessionId);
    if (!file || file.agentType !== "claude") return;
    let lastRole: "user" | "assistant" | null;
    try {
      lastRole = transcriptTailLastRealRole(readFileTailSync(file.path));
    } catch {
      return; // can't read the transcript -> defer, never guess
    }
    const corrected = permissionBlockedRecoveryTarget(stored, lastRole);
    if (!corrected) return;
    const conversationId = readConversationCache()[sessionId];
    if (!conversationId) return;
    log(`[STATUS-RECONCILE] ${sessionId.slice(0, 8)} stored=permission_blocked lastRole=${lastRole ?? "none"} -> ${corrected}`);
    sendAgentStatus(syncService, conversationId, sessionId, corrected);
    return;
  }

  // tmux-managed sessions are reconciled from the live pane (the authoritative
  // busy/idle signal) by reconcileStatusFromPane. Skip the transcript path for
  // them: a turn cut off mid-tool reads "active" forever, so the transcript would
  // flip a pane-confirmed idle back to "working" every cycle. The transcript path
  // remains the reconcile for bare-terminal sessions, which have no pane.
  if (resumeSessionCache.has(sessionId)) return;
  // Cheap in-memory gate first: skip the file read entirely unless the stored
  // status is one we'd ever correct.
  if (!(stored === "working" || stored === "thinking" || stored === "idle" || stored === "connected")) {
    return;
  }
  const file = findSessionFile(sessionId);
  if (!file) return;
  let turn: TranscriptTurnState;
  try {
    const tail = readFileTailSync(file.path);
    if (file.agentType === "claude") turn = classifyTranscriptTail(tail);
    else if (file.agentType === "codex") turn = classifyCodexTranscriptTail(tail);
    else return; // gemini/cursor formats not classified yet -> defer
  } catch {
    return; // can't read the transcript -> defer, never guess
  }
  const corrected = reconciledStatus(stored, turn);
  if (!corrected) return;
  // Only now (a correction is warranted) pay the conversation-cache read.
  const conversationId = readConversationCache()[sessionId];
  if (!conversationId) return;
  log(`[STATUS-RECONCILE] ${sessionId.slice(0, 8)} stored=${stored} turn=${turn} -> ${corrected}`);
  sendAgentStatus(syncService, conversationId, sessionId, corrected);
}

async function heartbeatHealthCheck(sessionId: string): Promise<void> {
  const tmux = resumeSessionCache.get(sessionId);
  if (!tmux) return;

  if (resumeInFlight.has(sessionId)) return;
  const restartTs = restartingSessionIds.get(sessionId);
  if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) return;

  // The only auto-action allowed: if the tmux server no longer lists this
  // session, reconstitute the worker. The kill inside handleDeadSession is a
  // no-op in that case (nothing to kill), and the reconstitution restores the
  // agent the user wants alive.
  try {
    await tmuxExec(["has-session", "-t", tmux], { timeout: 3000, killSignal: "SIGKILL" });
  } catch {
    log(`[HEARTBEAT-HEALTH] tmux session ${tmux} gone for ${sessionId.slice(0, 8)}, triggering reconstitution`);
    await handleDeadSession(sessionId, tmux);
    return;
  }

  if (syncServiceRef) {
    const cache = readConversationCache();
    const convId = cache[sessionId];
    if (convId) {
      const pending = pendingInteractivePrompts.get(sessionId);
      if (pending && Date.now() - pending.timestamp > 90_000) {
        try {
          const { stdout: pane } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmux + ":0.0", "-S", "-50"]);
          if (!parseInteractivePrompt(pane)) {
            pendingInteractivePrompts.delete(sessionId);
            log(`[HEARTBEAT-HEALTH] Cleared stale pending prompt for ${sessionId.slice(0, 8)}`);
          } else {
            pending.timestamp = Date.now();
          }
        } catch {
          pendingInteractivePrompts.delete(sessionId);
        }
      } else if (!pending) {
        checkForInteractivePrompt(tmux + ":0.0", sessionId, convId, syncServiceRef, 0).catch(() => {});
      }
    }
  }
}

async function handleDeadSession(sessionId: string, tmuxSession: string): Promise<void> {
  try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
  resumeSessionCache.delete(sessionId);
  stopCodexPermissionPoller(sessionId);
  stopManagedSessionHeartbeat(sessionId);

  const cache = readConversationCache();
  const conversationId = cache[sessionId];

  // Crash recovery shares the kill_session lifecycle contract: the tmux pane has
  // been torn down, any "injected" messages on Convex were lost with it, and the
  // daemon's local dedup state now references a dead pane. Reset both so the
  // reconstituted session can replay pending work.
  await clearConversationDeliveryAndResumeState(conversationId, sessionId, "HEARTBEAT-HEALTH");

  if (conversationId && syncServiceRef) {
    await syncServiceRef.setSessionError(conversationId, "Session crashed — reconstituting from database").catch(logConvexFailure);
  }

  const repaired = await repairAndResumeSession(sessionId, "", readTitleCache(), undefined, conversationId);
  if (repaired) {
    log(`[HEARTBEAT-HEALTH] Reconstituted session ${sessionId.slice(0, 8)}`);
    if (conversationId && syncServiceRef) {
      await syncServiceRef.setSessionError(conversationId).catch(logConvexFailure);
      await syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(logConvexFailure);
    }
  } else {
    log(`[HEARTBEAT-HEALTH] Reconstitution failed for ${sessionId.slice(0, 8)}`);
    if (conversationId && syncServiceRef) {
      await syncServiceRef.setSessionError(conversationId, "Session crashed and could not be reconstituted").catch(logConvexFailure);
    }
  }
}

function registerManagedStartedSession(conversationId: string, sessionId: string, tmuxSession: string): void {
  if (!syncServiceRef) return;
  syncServiceRef.markSessionActive(conversationId).catch(logConvexFailure);
  syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(logConvexFailure);
  ensureManagedSessionHeartbeat(sessionId);
}

function deleteStartedSession(conversationId: string): void {
  const entry = startedSessionTmux.get(conversationId);
  if (entry?.sessionId) {
    stopManagedSessionHeartbeat(entry.sessionId);
  }
  startedSessionTmux.delete(conversationId);
}

export function getInitialManagedSessionId(
  agentType: "claude" | "codex" | "cursor" | "gemini",
  expectedSessionId?: string,
  appServerThreadId?: string,
): string | undefined {
  if (agentType === "codex") return appServerThreadId || expectedSessionId;
  return expectedSessionId;
}

async function discoverAndLinkSession(
  conversationId: string,
  tmuxSession: string,
  cwd: string,
): Promise<void> {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const projectDirName = cwd.replace(/\//g, "-");
  const projectDir = path.join(claudeProjectsDir, projectDirName);

  const existingFiles = new Set<string>();
  if (fs.existsSync(projectDir)) {
    for (const f of fs.readdirSync(projectDir)) {
      if (UUID_JSONL_RE.test(f)) existingFiles.add(f);
    }
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!startedSessionTmux.has(conversationId)) {
      log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked by watcher, stopping discovery`);
      return;
    }
    if (!fs.existsSync(projectDir)) continue;
    const candidates: string[] = [];
    for (const f of fs.readdirSync(projectDir)) {
      const m = f.match(UUID_JSONL_RE);
      if (!m || existingFiles.has(f)) continue;
      const sessionId = m[1];
      const cache = readConversationCache();
      if (cache[sessionId]) continue;
      candidates.push(sessionId);
    }
    if (candidates.length === 0) continue;
    // Verify which candidate belongs to this tmux session's process
    let linkedSessionId: string | null = null;
    let foundInOtherTmux = false;
    for (const sessionId of candidates) {
      try {
        const proc = await findSessionProcess(sessionId, "claude").catch(() => null);
        if (proc) {
          const tmuxPane = await findTmuxPaneForTty(proc.tty);
          if (tmuxPane && tmuxPane.split(":")[0] === tmuxSession) {
            linkedSessionId = sessionId;
            break;
          } else {
            // Process located but not in our tmux — either a different tmux or
            // no tmux at all (a bare terminal/iTerm session). A web-started
            // session always runs inside its own tmux, so this candidate is
            // not ours regardless. Block the single-candidate fallback below.
            foundInOtherTmux = true;
            log(`[DISCOVER] Candidate ${sessionId.slice(0, 8)} is in ${tmuxPane ? `tmux ${tmuxPane.split(":")[0]}` : "no tmux"}, not ${tmuxSession} — skipping`);
          }
        }
      } catch {}
    }
    // Fall back to single candidate only if process wasn't found at all —
    // if it was found in a different tmux session, it belongs to another conversation
    if (!linkedSessionId && candidates.length === 1 && !foundInOtherTmux) {
      linkedSessionId = candidates[0];
    }
    if (linkedSessionId) {
      const startedEntry = startedSessionTmux.get(conversationId);
      const cache = readConversationCache();
      const reverseCache = buildReverseConversationCache(cache);
      if (reverseCache[conversationId]) {
        log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked to ${reverseCache[conversationId].slice(0, 8)} by another writer`);
        deleteStartedSession(conversationId);
        return;
      }
      cache[linkedSessionId] = conversationId;
      if (conversationCacheRef) {
        conversationCacheRef[linkedSessionId] = conversationId;
      }
      saveConversationCache(cache);
      if (syncServiceRef) {
        // Reconcile project_path/git_root to the real session cwd (see Claude
        // match branch). `cwd` is authoritative here: the linked candidate's
        // JSONL was found under the cwd-derived project dir.
        const discoveryGitInfo = getGitInfo(cwd);
        syncServiceRef.updateSessionId(conversationId, linkedSessionId, cwd, discoveryGitInfo?.repoRoot || discoveryGitInfo?.root).catch(logConvexFailure);
        registerManagedStartedSession(conversationId, linkedSessionId, tmuxSession);
        if (startedEntry?.sessionId && startedEntry.sessionId !== linkedSessionId) {
          stopManagedSessionHeartbeat(startedEntry.sessionId);
        }
      }
      deleteStartedSession(conversationId);
      log(`[DISCOVER] Linked session ${linkedSessionId.slice(0, 8)} to conversation ${conversationId.slice(0, 12)} via JSONL discovery`);
      return;
    }
  }
  log(`[DISCOVER] Timed out discovering session for conversation ${conversationId.slice(0, 12)}`);
}

function remapConversationSession(
  oldSessionId: string,
  newSessionId: string,
  conversationId: string,
  conversationCache?: ConversationCache,
): void {
  const cache = conversationCache || readConversationCache();
  delete cache[oldSessionId];
  cache[newSessionId] = conversationId;
  saveConversationCache(cache);
  if (conversationCacheRef) {
    delete conversationCacheRef[oldSessionId];
    conversationCacheRef[newSessionId] = conversationId;
  }
  resumeSessionCache.delete(oldSessionId);
  stopManagedSessionHeartbeat(oldSessionId);
  stopCodexPermissionPoller(oldSessionId);
  resumeFatalReasons.delete(oldSessionId);
}

const planHandoffChildren = new Map<string, string>();
const planHandoffChecked = new Set<string>();
const planModeSynced = new Set<string>();
const planModePlanMap = new Map<string, string>(); // sessionId -> plan short_id
const planModeTaskMap = new Map<string, Map<string, string>>(); // sessionId -> (localTaskId -> shortId)

const PLAN_MODE_CACHE_FILE = path.join(CONFIG_DIR, "plan-mode-cache.json");

function loadPlanModeCache(): void {
  try {
    if (!fs.existsSync(PLAN_MODE_CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PLAN_MODE_CACHE_FILE, "utf-8"));
    if (data.synced) for (const s of data.synced) planModeSynced.add(s);
    if (data.plans) for (const [k, v] of Object.entries(data.plans)) planModePlanMap.set(k, v as string);
    if (data.tasks) {
      for (const [sessionId, taskObj] of Object.entries(data.tasks)) {
        const map = new Map<string, string>();
        for (const [localId, shortId] of Object.entries(taskObj as Record<string, string>)) {
          map.set(localId, shortId);
        }
        planModeTaskMap.set(sessionId, map);
      }
    }
  } catch {}
}

function savePlanModeCache(): void {
  try {
    const tasks: Record<string, Record<string, string>> = {};
    for (const [sessionId, map] of planModeTaskMap) {
      tasks[sessionId] = Object.fromEntries(map);
    }
    fs.writeFileSync(PLAN_MODE_CACHE_FILE, JSON.stringify({
      synced: [...planModeSynced],
      plans: Object.fromEntries(planModePlanMap),
      tasks,
    }), { mode: 0o600 });
  } catch {}
}

loadPlanModeCache();

// Track subagent sessions whose parent hasn't been cached yet: childSessionId -> parentSessionId
const pendingSubagentParents = new Map<string, string>();
// Track subagent descriptions read from .meta.json: sessionId -> description
const subagentDescriptions = new Map<string, string>();
// Track tmux sessions spawned by known parent sessions: tmuxSessionName -> parentConversationId
const tmuxSpawnedBySession = new Map<string, string>();

interface CachedProcessInfo {
  pid: number;
  tty: string;
  tmuxTarget?: string;
  termProgram?: string;
  lastVerified: number;
}

const sessionProcessCache = new Map<string, CachedProcessInfo>();
const PROCESS_CACHE_TTL_MS = 30_000;

function cacheSessionProcess(sessionId: string, info: ClaudeSessionInfo, tmuxTarget?: string): void {
  sessionProcessCache.set(sessionId, {
    pid: info.pid,
    tty: info.tty,
    tmuxTarget,
    termProgram: info.termProgram,
    lastVerified: Date.now(),
  });
}

async function getCachedSessionProcess(sessionId: string): Promise<ClaudeSessionInfo | null> {
  const cached = sessionProcessCache.get(sessionId);
  if (!cached) return null;
  if (Date.now() - cached.lastVerified > PROCESS_CACHE_TTL_MS) {
    if (!isProcessRunning(cached.pid) || !isAgentProcess(cached.pid)) {
      sessionProcessCache.delete(sessionId);
      return null;
    }
    cached.lastVerified = Date.now();
  }
  return { pid: cached.pid, tty: cached.tty, sessionId, termProgram: cached.termProgram };
}

function validateProcessCache(): void {
  for (const [sessionId, cached] of sessionProcessCache) {
    if (!isProcessRunning(cached.pid) || !isAgentProcess(cached.pid)) {
      sessionProcessCache.delete(sessionId);
    }
  }
}

const latestSessionResources = new Map<string, SessionResources>();
const RESOURCE_MONITOR_INTERVAL_MS = 30_000;

// Sleep-aware idle accounting. We accumulate idle time per session only across
// ticks where the machine was awake, so a closed-lid gap never makes a frozen
// session look "idle for hours" the moment it wakes. A session's counter resets
// to 0 whenever it shows activity (CPU above the floor or a working status).
const sessionAwakeIdleMs = new Map<string, number>();
// Last metrics actually pushed per session, so shouldReportMetrics can skip
// re-reporting idle, unchanged sessions every tick (see resourceMonitor.ts).
const lastReportedMetrics = new Map<string, ReportedMetrics>();
let lastResourceTickAt = 0;
// A gap larger than this between resource ticks means the daemon was suspended
// (sleep) or stalled — either way that interval is not real awake-idle time.
const RESOURCE_TICK_SLEEP_GAP_MS = RESOURCE_MONITOR_INTERVAL_MS * 2.5;

export function getLatestSessionResources(): ReadonlyMap<string, SessionResources> {
  return latestSessionResources;
}

export function getSessionAwakeIdleMs(sessionId: string): number {
  return sessionAwakeIdleMs.get(sessionId) ?? 0;
}

async function collectResourceSnapshot(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (sessionProcessCache.size === 0) return;

  const sessionPids = new Map<string, number>();
  for (const [sessionId, info] of sessionProcessCache) {
    sessionPids.set(sessionId, info.pid);
  }

  try {
    const resources = await collectSessionResources(sessionPids);
    latestSessionResources.clear();
    for (const [sessionId, r] of resources) {
      latestSessionResources.set(sessionId, r);
    }

    // Advance per-session awake-idle counters. Skip the very first tick, wake
    // grace, and any oversized gap (sleep/stall) so suspended time is excluded.
    const now = Date.now();
    const elapsed = lastResourceTickAt > 0 ? now - lastResourceTickAt : 0;
    const sleepSkip = lastResourceTickAt === 0 || isInWakeGrace() || elapsed > RESOURCE_TICK_SLEEP_GAP_MS;
    lastResourceTickAt = now;

    for (const [sessionId, r] of resources) {
      sessionAwakeIdleMs.set(sessionId, nextAwakeIdleMs({
        prevIdleMs: sessionAwakeIdleMs.get(sessionId) ?? 0,
        cpu: r.cpu,
        status: lastSentAgentStatus.get(sessionId),
        elapsedMs: elapsed,
        sleepSkip,
      }));
    }
    // Drop counters for sessions whose process tree is gone (no longer collected).
    for (const sessionId of sessionAwakeIdleMs.keys()) {
      if (!resources.has(sessionId)) sessionAwakeIdleMs.delete(sessionId);
    }
    for (const sessionId of lastReportedMetrics.keys()) {
      if (!resources.has(sessionId)) lastReportedMetrics.delete(sessionId);
    }

    // Push metrics for every live session here (not only resume-managed ones),
    // so the Sessions page sees fresh metrics — and thus liveness — for anything
    // with a real process tree, including sessions reporting a "stopped" status.
    //
    // Bounded concurrency: firing one mutation per session at once (a burst of N
    // simultaneous POSTs for N live sessions, every tick) saturates the daemon's
    // outbound connection pool and file descriptors, starving the message-sync
    // mutations of sockets so they hang to their 60s timeout while the backend is
    // actually idle. A small worker pool caps in-flight metric requests so syncs
    // always have headroom. Metrics are best-effort and unawaited per-call, so the
    // pool just paces them across the tick.
    let metricsReported = 0;
    let metricsSkipped = 0;
    if (syncServiceRef) {
      const entries = [...resources.entries()];
      const METRICS_CONCURRENCY = 4;
      let idx = 0;
      const worker = async () => {
        while (idx < entries.length) {
          const [sessionId, r] = entries[idx++];
          const agentPid = sessionProcessCache.get(sessionId)?.pid;
          const status = lastSentAgentStatus.get(sessionId);
          // Skip flat, idle, recently-reported sessions: this is what keeps the
          // per-tick write burst proportional to ACTIVE sessions rather than the
          // whole fleet, leaving socket headroom for message sync.
          if (!shouldReportMetrics({ cur: { cpu: r.cpu, memory: r.memory, pidCount: r.pidCount, agentPid }, prev: lastReportedMetrics.get(sessionId), status, now })) {
            metricsSkipped++;
            continue;
          }
          metricsReported++;
          lastReportedMetrics.set(sessionId, { cpu: r.cpu, memory: r.memory, pidCount: r.pidCount, agentPid, at: now });
          await syncServiceRef!.reportSessionMetrics(
            sessionId, r.cpu, r.memory, r.pidCount, agentPid, sessionAwakeIdleMs.get(sessionId) ?? 0,
          ).catch(() => {});
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(METRICS_CONCURRENCY, entries.length) }, worker),
      );
    }

    if (resources.size > 0) {
      log(`[RESOURCES] metrics reported=${metricsReported} skipped=${metricsSkipped} | ${formatResourcesLog(resources)}`);
    }
  } catch (err) {
    log(`[RESOURCES] Collection failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
  }
}

const LIVENESS_RECONCILE_INTERVAL_MS = 120_000; // 2 min — conservative; daemon is load-sensitive

// Periodic liveness reconciliation for the Sessions page.
//
// sessionProcessCache is otherwise seeded only by event-driven discovery (a
// JSONL write), so a session that goes idle and stops writing is never
// re-tracked after a daemon restart and wrongly shows as "dead". This sweep
// re-establishes the session→pid mapping for every managed_sessions row whose
// agent is still alive, so collectResourceSnapshot reports fresh metrics and the
// page's liveness signal becomes accurate.
//
// Cheap by construction: one Convex query + one `tmux list-panes -a`, then a
// bounded process-tree walk only for rows whose tmux session is actually live.
async function reconcileSessionLiveness(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!syncServiceRef) return;
  if (isInWakeGrace()) return;

  const catalog = await syncServiceRef.listManagedSessions();
  if (!catalog || catalog.length === 0) return;

  // session_name -> pane_pid for every live pane, in one call.
  const paneByTmux = new Map<string, number>();
  if (hasTmux()) {
    try {
      const { stdout } = await tmuxExec(
        ["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"],
        { timeout: 5000, killSignal: "SIGKILL" },
      );
      for (const line of stdout.trim().split("\n")) {
        const [name, pid] = line.trim().split(/\s+/);
        const n = parseInt(pid, 10);
        if (name && !isNaN(n) && !paneByTmux.has(name)) paneByTmux.set(name, n);
      }
    } catch {}
  }

  // Rows needing resolution (skip ones collectResourceSnapshot already tracks).
  const pending = catalog.filter((row) => !sessionProcessCache.has(row.session_id));

  // Resolve agent pids with bounded concurrency — each resolution is a
  // process-tree walk (pgrep), and doing ~160 sequentially stalls for tens of
  // seconds under load. A small pool keeps the boot sweep to a few seconds
  // without flooding the process table.
  let seeded = 0;
  const CONCURRENCY = 12;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      let agentPid: number | null = null;
      const panePid = row.tmux_session ? paneByTmux.get(row.tmux_session) : undefined;
      if (panePid !== undefined) {
        agentPid = await findAgentPidInTree(panePid);
      } else if (row.agent_pid && isProcessRunning(row.agent_pid) && isAgentProcess(row.agent_pid)) {
        agentPid = row.agent_pid;
      }
      if (agentPid !== null) {
        cacheSessionProcess(
          row.session_id,
          { pid: agentPid, tty: "", sessionId: row.session_id },
          row.tmux_session,
        );
        seeded++;
      }
    }));
  }

  if (seeded > 0) log(`[LIVENESS] Reconciled ${seeded} live session(s) into process cache`);
}

function resolveSessionId(filePath: string): string {
  const name = path.basename(filePath, ".jsonl");
  if (CLAUDE_UUID_RE.test(name)) return name;
  const parts = filePath.split(path.sep);
  if (parts.includes("subagents")) return name;
  try {
    const head = readFileHead(filePath, 4096);
    const m = head.match(/"sessionId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    if (m) return m[1];
  } catch {}
  return name;
}

function slugify(text: string, maxLen = 30): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

/**
 * Ordered, de-duplicated list of tmux sessions to probe for a live agent before
 * spawning a fresh resume session. Priority: the cached resume tmux, then the
 * original started session (cc-<agent>-<convId> from start_session), then the
 * resume-named session. Including the started session is what stops a force-resume
 * of an already-live started session from spawning a parallel cc-resume- tmux and
 * splitting message delivery across two panes.
 */
export function resumeReuseCandidates(
  cachedTmux: string | undefined,
  startedTmux: string | undefined,
  resumeTmux: string,
): string[] {
  const out: string[] = [];
  for (const t of [cachedTmux, startedTmux, resumeTmux]) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Build the `env` prefix for an auto-resume command. Always strips CLAUDECODE so the
// resumed agent doesn't refuse to launch "inside another Claude Code session". For Claude,
// also pushes the "Resume from summary?" thresholds out of reach: that prompt fires for
// old/large sessions (default >70min AND >100k tokens) and blocks the TUI awaiting a choice,
// but a daemon auto-resume has no human at the pane to answer it — so it would wedge forever
// and trip the web stuck-banner into a kill+restart loop. There is no CLI flag for it, only
// these env gates (read by Claude Code as process.env.CLAUDE_CODE_RESUME_THRESHOLD_*).
export function buildResumeEnvPrefix(agentType: string): string {
  const base = "env -u CLAUDECODE";
  return agentType === "claude"
    ? `${base} CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999 CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999999`
    : base;
}

interface ResolvedLiveSession {
  /** A live tmux target ready for injection (bare "cc-x" for cache/started/resume-name,
   *  "cc-x:win.pane" for a process-discovered pane), or null if no live tmux was found. */
  tmuxTarget: string | null;
  /** Where the live target came from (logging), or null when no live tmux was found. */
  source: "cache" | "started" | "resume-name" | "process" | null;
  /** The live agent process when discovered by process scan — lets callers fall back to
   *  direct-terminal (AppleScript/CLI) injection for agents not running inside tmux. */
  proc: ClaudeSessionInfo | null;
  /** True when a cached resume tmux existed and passed has-session. */
  cachedStillValid: boolean;
}

/**
 * Single source of truth for "is this session already running, and where do I inject?".
 * Probes, in order: the cached resume tmux, the original started session
 * (cc-<agent>-<convId>), an optional resume-named session, then a live OS process
 * (→ its tmux pane, or the bare process for non-tmux terminal injection). Read-only
 * apart from self-healing cache eviction (drops a cached entry whose tmux is gone or
 * whose agent has died). Both deliverMessage and autoResumeSession route through this
 * so the two delivery paths can never disagree about whether a session is already live.
 */
async function resolveLiveTmuxTarget(
  conversationId: string | undefined,
  sessionId: string,
  agentType: "claude" | "codex" | "cursor" | "gemini",
  resumeTmuxName?: string,
): Promise<ResolvedLiveSession> {
  const cachedTmux = resumeSessionCache.get(sessionId);
  let cachedStillValid = false;

  const dropCache = () => {
    resumeSessionCache.delete(sessionId);
    stopCodexPermissionPoller(sessionId);
    stopManagedSessionHeartbeat(sessionId);
  };

  // 1. Cached resume tmux — verified before use; self-heals on gone/dead.
  if (cachedTmux) {
    let hasSessionOk = false;
    try {
      await tmuxExec(["has-session", "-t", cachedTmux], { timeout: 3000, killSignal: "SIGKILL" });
      hasSessionOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only a definitive "no such session" drops the cache — transient tmux errors
      // (timeout, EAGAIN) must not nuke a live mapping; just fall through to other probes.
      if (/can't find session|no such session|session not found/i.test(msg)) {
        logDelivery(`Cached tmux ${cachedTmux} gone (${msg.slice(0, 80)}), clearing cache`);
        dropCache();
      } else {
        logDelivery(`Cached tmux ${cachedTmux} has-session transient error (${msg.slice(0, 80)}), keeping cache and falling through`);
      }
    }
    if (hasSessionOk) {
      cachedStillValid = true;
      let agentAlive = true;
      try { agentAlive = await isTmuxAgentAlive(cachedTmux); } catch {}
      if (agentAlive) {
        return { tmuxTarget: cachedTmux, source: "cache", proc: null, cachedStillValid: true };
      }
      // Dead agent: drop the cache (leave the tmux in place) and keep probing.
      logDelivery(`Cached tmux ${cachedTmux} has no live agent, clearing cache (leaving tmux in place)`);
      dropCache();
      cachedStillValid = false;
    }
  }

  // 2/3. Started session, then optional resume-named session — both verified alive.
  const startedTmux = conversationId ? startedSessionTmux.get(conversationId)?.tmuxSession : undefined;
  for (const candidate of resumeReuseCandidates(undefined, startedTmux, resumeTmuxName ?? "")) {
    try {
      await tmuxExec(["has-session", "-t", candidate], { timeout: 3000, killSignal: "SIGKILL" });
      if (await isTmuxAgentAlive(candidate)) {
        return {
          tmuxTarget: candidate,
          source: candidate === startedTmux ? "started" : "resume-name",
          proc: null,
          cachedStillValid,
        };
      }
    } catch {}
  }

  // 4. Live OS process → its tmux pane (or the bare process for AppleScript/CLI fallback).
  // Materialized sessions have no running process and CWD+timing heuristics false-positive.
  const isMaterialized = materializedSessions.has(sessionId);
  const proc = isMaterialized ? null : await findSessionProcess(sessionId, agentType);
  if (proc) {
    if (!isAgentProcess(proc.pid)) {
      // Leftover shell, not an agent — drop the stale process cache and give up on it.
      sessionProcessCache.delete(sessionId);
      return { tmuxTarget: null, source: null, proc: null, cachedStillValid };
    }
    let pane = await findTmuxPaneForTty(proc.tty);
    // Claude often runs in a tmux pane whose pty mapping isn't visible (nested tmux, fresh
    // pane): fall back to a still-valid cached target rather than the AppleScript path,
    // which would type into the foreground terminal and silently drop the message.
    if (!pane && cachedStillValid && cachedTmux) pane = cachedTmux;
    return { tmuxTarget: pane, source: pane ? "process" : null, proc, cachedStillValid };
  }

  return { tmuxTarget: null, source: null, proc: null, cachedStillValid };
}

async function autoResumeSession(sessionId: string, content: string, titleCache: TitleCache, cwdOverride?: string, conversationId?: string, agentTypeHint?: "claude" | "codex" | "cursor" | "gemini"): Promise<boolean> {
  // Remote-device safety gate: a remote daemon (the cloud Mac) ONLY manages
  // sessions explicitly OWNED by it. Unlike the primary local daemon, it must
  // NOT adopt/reconstitute/resume unowned sessions — doing so reconstitutes the
  // user's real sessions from Convex and double-manages them (cross-device
  // stomp). The local primary daemon keeps its legacy adopt-unowned behavior.
  if (process.env.CODECAST_REMOTE_DEVICE === "1") {
    if (!conversationId) {
      log(`[OWNER] remote daemon skipping resume of ${sessionId.slice(0, 8)} — no conversation id to verify ownership`);
      return false;
    }
    const owner = syncServiceRef ? await syncServiceRef.getConversationOwner(conversationId) : null;
    if (owner !== deviceId()) {
      log(`[OWNER] remote daemon skipping resume of ${sessionId.slice(0, 8)} — owner=${owner ? owner.slice(0, 8) : "unowned"} (this device ${deviceId().slice(0, 8)})`);
      return false;
    }
  }
  // Deduplicate concurrent resume attempts on the same session
  const existing = resumeInFlight.get(sessionId);
  if (existing) {
    const startedAt = resumeInFlightStarted.get(sessionId) ?? 0;
    const age = Date.now() - startedAt;
    if (age > RESUME_IN_FLIGHT_TIMEOUT_MS) {
      logDelivery(`Resume in-flight for ${sessionId.slice(0, 8)} is stale (${Math.round(age / 1000)}s), clearing and retrying`);
      resumeInFlight.delete(sessionId);
      resumeInFlightStarted.delete(sessionId);
    } else {
      logDelivery(`Resume already in flight for ${sessionId.slice(0, 8)}, waiting (age=${Math.round(age / 1000)}s)...`);
      try {
        const result = await Promise.race([
          existing,
          new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("resume_timeout")), RESUME_IN_FLIGHT_TIMEOUT_MS - age)),
        ]);
        if (result && content) {
          const tmuxSession = resumeSessionCache.get(sessionId);
          if (tmuxSession) {
            await injectViaTmux(tmuxSession + ":0.0", content);
            log(`Injected message to already-resumed session ${sessionId.slice(0, 8)}`);
          }
        }
        return result;
      } catch (err) {
        if (err instanceof Error && err.message === "resume_timeout") {
          logDelivery(`Resume in-flight timed out for ${sessionId.slice(0, 8)}, clearing and retrying`);
          resumeInFlight.delete(sessionId);
          resumeInFlightStarted.delete(sessionId);
        } else {
          throw err;
        }
      }
    }
  }
  const promise = autoResumeSessionInner(sessionId, content, titleCache, cwdOverride, conversationId, agentTypeHint);
  resumeInFlight.set(sessionId, promise);
  resumeInFlightStarted.set(sessionId, Date.now());
  try {
    return await promise;
  } finally {
    resumeInFlight.delete(sessionId);
    resumeInFlightStarted.delete(sessionId);
  }
}

async function autoResumeSessionInner(sessionId: string, content: string, titleCache: TitleCache, cwdOverride?: string, conversationId?: string, agentTypeHint?: "claude" | "codex" | "cursor" | "gemini"): Promise<boolean> {
  if (!hasTmux()) {
    logDelivery(`Cannot auto-resume ${sessionId.slice(0, 8)}: tmux not installed`);
    return false;
  }
  const priorFatalReason = resumeFatalReasons.get(sessionId);
  if (priorFatalReason) {
    logDelivery(`Skipping auto-resume for ${sessionId.slice(0, 8)}: prior fatal reason=${priorFatalReason}`);
    return false;
  }
  let sessionFile = findSessionFile(sessionId);
  const config = readConfig();
  if (!sessionFile && conversationId && config?.auth_token && config?.convex_url) {
    logDelivery(`Session ${sessionId.slice(0, 8)} not found locally, reconstituting from codecast...`);
    try {
      const siteUrl = config.convex_url.replace(".cloud", ".site");
      const data = await fetchExport(siteUrl, config.auth_token, conversationId);
      if (data.messages.length === 0) {
        logDelivery(`Reconstitution skipped for ${sessionId.slice(0, 8)}: conversation has 0 messages`);
        return false;
      }
      const reconAgentType = agentTypeHint || (data.conversation.agent_type === "codex" ? "codex" : undefined) || "claude";
      let jsonl: string;
      let reconId: string;
      if (reconAgentType === "codex") {
        ({ jsonl, sessionId: reconId } = generateCodexJsonl(data, { sessionId }));
      } else {
        const tailMessages = chooseClaudeAutoTrim(data);
        ({ jsonl, sessionId: reconId } = generateClaudeCodeJsonl(data, { tailMessages, sessionId }));
      }
      // Write under the same cwd the resume will run in (see localSessionDir):
      // a valid override wins, otherwise the locally-resolved repo path.
      const reconDir = (cwdOverride && fs.existsSync(cwdOverride))
        ? cwdOverride
        : localSessionDir(data.conversation.project_path || undefined);
      const result = reconAgentType === "codex"
        ? { sessionId: reconId, filePath: writeCodexSession(jsonl, reconId) }
        : writeClaudeCodeSession(jsonl, reconId, reconDir);
      logDelivery(`Reconstituted ${sessionId.slice(0, 8)} (${data.messages.length} msgs)`);
      if (conversationId && reconId !== sessionId) {
        remapConversationSession(sessionId, reconId, conversationId);
        if (syncServiceRef) {
          syncServiceRef.updateSessionId(conversationId, reconId).catch(logConvexFailure);
        }
      } else if (conversationId) {
        // Ensure cache has the mapping even when sessionId is preserved
        const cache = readConversationCache();
        cache[sessionId] = conversationId;
        saveConversationCache(cache);
        if (conversationCacheRef) conversationCacheRef[sessionId] = conversationId;
      }
      sessionId = reconId;
      sessionFile = findSessionFile(reconId);
      if (!sessionFile) {
        logDelivery(`Reconstituted file not found at expected path: ${result.filePath}`);
        return false;
      }
    } catch (err) {
      logDelivery(`Reconstitution failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  } else if (!sessionFile) {
    logDelivery(`Cannot auto-resume ${sessionId.slice(0, 8)}: session JSONL file not found${!conversationId ? " (no conversation ID for reconstitution)" : ""}`);
    return false;
  }

  const { path: jsonlPath, agentType } = sessionFile;
  const jsonlContent = readFileHead(jsonlPath, 5000);

  let cwd: string;
  let resumeCmd: string;
  const shortId = sessionId.slice(0, 8);
  const title = titleCache[sessionId] || extractSummaryTitle(jsonlContent);
  const slug = title ? slugify(title) : "";

  // Resolve where to resume. A recorded transcript cwd we can't map to a local
  // checkout means refusing (mirrors start_session) — NOT $HOME, which would run
  // the agent in the wrong dir and mislabel the project as the home dir. Gemini
  // transcripts carry no cwd, so they have nothing to refuse on and keep $HOME.
  const recordedCwd =
    agentType === "codex" ? (extractCodexCwd(jsonlContent) || undefined)
    : agentType === "gemini" ? undefined
    : (extractCwd(jsonlContent) || undefined);
  const resolvedCwd = await resolveResumeCwdOrRefuse({ recordedCwd, cwdOverride, conversationId });
  if (resolvedCwd) {
    cwd = resolvedCwd;
  } else if (agentType === "gemini" && !recordedCwd) {
    cwd = process.env.HOME || "/tmp";
  } else {
    await refuseResumeNoLocalCheckout(sessionId, conversationId, recordedCwd);
    return false;
  }

  if (agentType === "codex") {
    let extraFlags = config?.codex_args || "";
    const permFlags = getPermissionFlags("codex", config);
    if (permFlags) extraFlags = extraFlags ? extraFlags + " " + permFlags : permFlags;
    resumeCmd = `codex resume ${sessionId}${extraFlags ? " " + extraFlags : ""}`;
  } else if (agentType === "gemini") {
    resumeCmd = `gemini --resume latest`;
  } else {
    const jsonlBypass = extractJsonlPermissionMode(jsonlContent) === "bypassPermissions";
    const extraFlags = combineClaudeResumeFlags(
      config?.claude_args,
      getPermissionFlags("claude", config),
      jsonlBypass,
    );
    let resumeId = sessionId;
    try {
      const rewrite = rewriteSubagentJsonlToUuid(sessionId, jsonlPath);
      if (rewrite.rewrote) {
        log(`Copied non-UUID session ${sessionId} to resumable UUID ${rewrite.resumeId}`);
        resumeId = rewrite.resumeId;
        // Remap all caches so subsequent lookups use the new UUID
        if (conversationId) {
          remapConversationSession(sessionId, rewrite.resumeId, conversationId);
          if (syncServiceRef) {
            syncServiceRef.updateSessionId(conversationId, rewrite.resumeId).catch(logConvexFailure);
          }
        }
      }
    } catch (err) {
      log(`Failed to copy session for UUID resume: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Guarantee the session JSONL lives under the slug of the cwd we're about to
    // resume in. findSessionFile() searches *every* project dir, so it can return
    // a copy written under another machine's path (e.g. a fork whose origin was
    // /Users/<other>/...). `claude --resume` only scans its own cwd's project dir,
    // so relocate the file there or Claude reports "No conversation found with
    // session ID" and crashes. This also self-heals stale wrong-dir JSONLs left by
    // earlier runs.
    try {
      const resumeFile = findSessionFile(resumeId);
      if (resumeFile) {
        const cwdProjectDir = path.join(process.env.HOME || "", ".claude", "projects", cwd.replace(/\//g, "-"));
        const desiredPath = path.join(cwdProjectDir, `${resumeId}.jsonl`);
        if (path.resolve(resumeFile.path) !== path.resolve(desiredPath)) {
          fs.mkdirSync(cwdProjectDir, { recursive: true });
          fs.copyFileSync(resumeFile.path, desiredPath);
          log(`Relocated session ${resumeId.slice(0, 8)} JSONL into resume cwd dir (${cwd})`);
        }
      }
    } catch (err) {
      log(`Failed to relocate session JSONL for ${resumeId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Override the recorded model with its short alias so the resume never lands
    // on a retired pinned snapshot. See resumeModelFlag.
    const modelFlag = resumeModelFlag(jsonlContent, extraFlags);
    resumeCmd = `claude --resume ${resumeId}${modelFlag}${extraFlags ? " " + extraFlags : ""}`;
  }

  const prefix = agentType === "codex" ? "cx" : agentType === "gemini" ? "gm" : "cc";
  const tmuxSession = slug ? `${prefix}-resume-${slug}-${shortId}` : `${prefix}-resume-${shortId}`;

  // Check if this session already has a healthy agent running (avoid killing + recreating).
  // resolveLiveTmuxTarget probes the cached resume tmux, the original started session
  // (cc-<agent>-<convId>), this resume-named session, and any live process — reusing the
  // first with a live agent. The started-session probe is what prevents a force-resume of
  // an already-live started session from spawning a parallel cc-resume- tmux and splitting
  // delivery across two panes.
  const live = await resolveLiveTmuxTarget(conversationId, sessionId, agentType, tmuxSession);
  if (live.tmuxTarget) {
    const bareName = live.tmuxTarget.split(":")[0];
    logDelivery(`Session ${shortId} already alive in tmux=${live.tmuxTarget} (${live.source}), reusing`);
    resumeSessionCache.set(sessionId, bareName);
    if (content) {
      await injectViaTmux(live.tmuxTarget.includes(":") ? live.tmuxTarget : live.tmuxTarget + ":0.0", content);
    }
    // Ensure heartbeat + sync registration exist (may be missing after daemon restart)
    if (syncServiceRef && conversationId && !managedHeartbeatSessions.has(sessionId)) {
      syncServiceRef.registerManagedSession(sessionId, process.pid, bareName, conversationId).catch(logConvexFailure);
      syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(logConvexFailure);
      ensureManagedSessionHeartbeat(sessionId);
    }
    return true;
  }

  try {
    try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}

    await tmuxExec(["new-session", "-d", "-s", tmuxSession, "-c", cwd]);
    await setTmuxSessionOption(tmuxSession, "@codecast_session_id", sessionId);
    await setTmuxSessionOption(tmuxSession, "@codecast_agent_type", agentType);

    // See buildResumeEnvPrefix: strips CLAUDECODE and (for Claude) suppresses the
    // "Resume from summary?" prompt that would otherwise wedge an unattended auto-resume.
    const resumeEnvPrefix = buildResumeEnvPrefix(agentType);
    await tmuxExec(["send-keys", "-t", tmuxSession, "-l", `${resumeEnvPrefix} ${resumeCmd}`]);
    await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);

    logDelivery(`Auto-resumed ${agentType} ${shortId} in tmux=${tmuxSession} cwd=${cwd} cmd=${resumeCmd}`);

    // Register managed session early with "resuming" status — will transition to "connected" once prompt is visible
    resumeSessionCache.set(sessionId, tmuxSession);
    if (syncServiceRef && conversationId) {
      syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(logConvexFailure);
      syncServiceRef.updateSessionAgentStatus(conversationId, "resuming").catch(logConvexFailure);
      stopManagedSessionHeartbeat(sessionId);
      ensureManagedSessionHeartbeat(sessionId);

      // Start tmux pane monitoring for Codex permission prompts
      if (agentType === "codex" && conversationId) {
        startCodexPermissionPoller(sessionId, tmuxSession, conversationId, syncServiceRef);
      }
    }

    // Poll for agent readiness - check every 250ms, bail on fatal errors
    // Must see the input prompt (❯ for Claude, › for Codex) to know the TUI is ready
    const fatalErrors = [
      "cannot be launched inside another",
      "command not found",
      "No such file or directory",
      "Session not found",
      "No conversation found",
      "is not an object",
      "ENOENT",
    ];
    const promptPattern = /[❯›]/;
    // Scale readiness poll based on JSONL file size — large sessions take much longer to resume
    let jsonlSize = 0;
    try { jsonlSize = fs.statSync(jsonlPath).size; } catch {}
    const maxPollMs = resumeReadinessPollMs(jsonlSize);
    const maxIterations = Math.ceil(maxPollMs / 250);
    const startTime = Date.now();
    let ready = false;

    for (let i = 0; i < maxIterations; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-20"]);
          if (fatalErrors.some(e => paneContent.includes(e))) {
            const fatalReason = agentType === "claude" ? classifyClaudeResumeFatalReason(paneContent) : null;
            if (fatalReason) {
              resumeFatalReasons.set(sessionId, fatalReason);
            }
            logDelivery(`Auto-resume FATAL for ${shortId}: agent crashed. Pane: ${paneContent.slice(0, 300)}`);
            try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
            return false;
          }
          // The resume exited straight back to a bare shell (Claude prints "Resume this
          // session with: …" on exit; a failed launch leaves a shell command-not-found).
          // This is the failure that produced "SESSION_EXITED: agent has exited" — the
          // old poll didn't recognize it, waited the full window, then pasted into the
          // dead shell. Detect it and abort fast WITHOUT recording a fatal reason: a
          // bare-shell exit is transient (an identical resume succeeds moments later once
          // any prior holder is gone), so the delivery loop's short-cooldown retry path
          // takes over instead of locking the session for 5 minutes.
          if (classifyTmuxLiveState(extractTmuxLiveRegion(paneContent)) === "exited") {
            logDelivery(`Auto-resume EXITED for ${shortId}: resume dropped to a bare shell, aborting (transient). Pane: ${paneContent.slice(-200)}`);
            try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
            return false;
          }
          if (promptPattern.test(paneContent) && await isTmuxAgentAlive(tmuxSession)) {
            // A bare ❯/› also renders as the cursor of a blocking selection menu (e.g. Claude's
            // "Resume from summary?" prompt). Matching that would publish a false "connected" while
            // the agent is frozen awaiting a choice. Keep polling until the menu clears. Only guard
            // against option menus (isConfirmation false) — "press enter to continue" warnings are
            // cleared by the Escape pass below, so they must not block readiness here.
            const blockingMenu = parseInteractivePrompt(paneContent);
            if (blockingMenu && !blockingMenu.isConfirmation) {
              continue;
            }
            resumeFatalReasons.delete(sessionId);
            logDelivery(`Agent ${shortId} ready (prompt visible) after ${Date.now() - startTime}ms`);
            ready = true;
            break;
          }
      } catch {}
    }
    if (!ready) {
      const alive = await isTmuxAgentAlive(tmuxSession).catch(() => false);
      if (!alive) {
        logDelivery(`Agent ${shortId} startup timed out after ${Date.now() - startTime}ms and agent is not alive, marking stopped`);
        try { await tmuxExec(["kill-session", "-t", tmuxSession]); } catch {}
        resumeSessionCache.delete(sessionId);
        stopManagedSessionHeartbeat(sessionId);
        if (syncServiceRef && conversationId) {
          sendAgentStatus(syncServiceRef, conversationId, sessionId, "stopped");
        }
        return false;
      }
      logDelivery(`Agent ${shortId} startup timed out after ${Date.now() - startTime}ms (max=${maxPollMs}ms, jsonl=${Math.round(jsonlSize / 1024)}KB) but agent process alive, proceeding`);
    }

    // Transition to "connected" only when we actually saw the input prompt. On a timeout-but-alive
    // resume we don't know the agent is interactive yet, so leave it "resuming" — the next hook event
    // (working/idle) will correct it. Reporting "connected" prematurely is exactly the false-live
    // signal that lets the web watchdog escalate to a destructive kill+restart.
    if (ready && syncServiceRef && conversationId) {
      syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(logConvexFailure);
    }

    // Dismiss startup warnings (model mismatch, rate limit) before injection
    // These warnings block the prompt -- send Escape then Enter to clear them
    if (ready || !content) {
      try {
        const { stdout: preInjectPane } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-15"]);
        const warningPatterns = /⚠|recorded with model|weekly limit|Update available|Press enter to continue/;
        if (warningPatterns.test(preInjectPane)) {
          logDelivery(`Clearing startup warnings for ${shortId} before injection`);
          await tmuxExec(["send-keys", "-t", tmuxSession, "Escape"]);
          await new Promise(resolve => setTimeout(resolve, 300));
          // Wait for the prompt to appear after clearing warnings
          for (let w = 0; w < 20; w++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            try {
              const { stdout: cleared } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-5"]);
              if (promptPattern.test(cleared.split("\n").slice(-3).join("\n"))) break;
            } catch {}
          }
        }
      } catch {}
    }

    // Inject the message (skip if empty — resume-only mode)
    if (content) {
      await injectViaTmux(tmuxSession + ":0.0", content);
      log(`Injected message to auto-resumed ${agentType} session ${shortId}`);
    } else {
      log(`Auto-resumed ${agentType} session ${shortId} (no message to inject)`);
    }

    return true;
  } catch (err) {
    logDelivery(`Auto-resume EXCEPTION ${agentType} ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const repairAttempts = new Map<string, number>();
const REPAIR_COOLDOWN_MS = 60 * 1000;
const repairInFlight = new Map<string, Promise<boolean>>();

async function repairAndResumeSession(
  sessionId: string,
  content: string,
  titleCache: TitleCache,
  cwdOverride?: string,
  conversationId?: string,
  agentTypeHint?: "claude" | "codex" | "cursor" | "gemini"
): Promise<boolean> {
  const existing = repairInFlight.get(sessionId);
  if (existing) return existing;

  const cooldownKey = conversationId || sessionId;
  const lastAttempt = repairAttempts.get(cooldownKey) || repairAttempts.get(sessionId);
  if (lastAttempt && Date.now() - lastAttempt < REPAIR_COOLDOWN_MS) {
    log(`Repair cooldown active for ${sessionId.slice(0, 8)} (conv=${conversationId?.slice(0, 8) ?? "?"}), skipping`);
    return false;
  }

  const promise = (async (): Promise<boolean> => {
    let success = false;

    try {
      const config = readConfig();
      if (!config?.convex_url || !config?.auth_token) {
        log(`Cannot repair session: missing config`);
        return false;
      }

      const convId = conversationId || (() => {
        const cache = readConversationCache();
        return cache[sessionId];
      })();

      if (!convId) {
        log(`Cannot repair ${sessionId.slice(0, 8)}: no conversation_id found`);
        return false;
      }

      const siteUrl = config.convex_url.replace(".cloud", ".site");

      try {
        log(`Repairing session ${sessionId.slice(0, 8)} via Convex regeneration...`);
        const exportData = await fetchExport(siteUrl, config.auth_token!, convId);
        if (exportData.messages.length === 0) {
          log(`Repair aborted for ${sessionId.slice(0, 8)}: conversation has 0 messages, nothing to resume`);
          return false;
        }
        const sessionFile = findSessionFile(sessionId);
        const agentType = agentTypeHint || sessionFile?.agentType || "claude";
        const isCodexSession = agentType === "codex";
        const failureReason = !isCodexSession ? resumeFatalReasons.get(sessionId) ?? null : null;
        const projectPath = cwdOverride || exportData.conversation.project_path || undefined;

        let jsonl: string;
        let tailMessages: number | undefined;
        let targetSessionId = sessionId;

        if (isCodexSession) {
          ({ jsonl } = generateCodexJsonl(exportData, { sessionId }));
        } else {
          const TOKEN_BUDGET = 100_000;
          tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
          if (shouldMaterializeFreshClaudeSession(failureReason)) {
            const generated = generateClaudeCodeJsonl(exportData, { tailMessages });
            jsonl = generated.jsonl;
            targetSessionId = generated.sessionId;
          } else {
            ({ jsonl } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId }));
          }
        }

        if (targetSessionId !== sessionId) {
          const { filePath: repairFilePath } = writeClaudeCodeSession(jsonl, targetSessionId, localSessionDir(projectPath));
          setPosition(repairFilePath, fs.statSync(repairFilePath).size);
          remapConversationSession(sessionId, targetSessionId, convId);
          if (titleCache[sessionId] && !titleCache[targetSessionId]) {
            titleCache[targetSessionId] = titleCache[sessionId];
            saveTitleCache(titleCache);
          }
          if (syncServiceRef) {
            syncServiceRef.updateSessionId(convId, targetSessionId).catch(logConvexFailure);
          }
          log(`Materialized fresh Claude session ${targetSessionId.slice(0, 8)} from stale ${sessionId.slice(0, 8)} (${exportData.messages.length} messages, tail=${tailMessages})`);

          const resumed = await autoResumeSession(targetSessionId, content, titleCache, cwdOverride || projectPath, convId);
          if (resumed) {
            log(`Repair + resume succeeded for ${sessionId.slice(0, 8)} via fresh session ${targetSessionId.slice(0, 8)}`);
            success = true;
            return true;
          }
        } else if (sessionFile) {
          const bakPath = sessionFile.path + ".bak";
          if (!fs.existsSync(bakPath)) {
            fs.copyFileSync(sessionFile.path, bakPath);
          }
          fs.writeFileSync(sessionFile.path, jsonl);
          if (isCodexSession) {
            log(`Repaired Codex JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} messages)`);
          } else {
            log(`Repaired JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} messages, tail=${tailMessages})`);
          }
        } else if (isCodexSession) {
          writeCodexSession(jsonl, sessionId, "rollout");
          log(`Wrote new Codex session file for ${sessionId.slice(0, 8)}`);
        } else {
          const { filePath: repairFilePath } = writeClaudeCodeSession(jsonl, sessionId, localSessionDir(projectPath));
          setPosition(repairFilePath, fs.statSync(repairFilePath).size);
          log(`Wrote new session file for ${sessionId.slice(0, 8)}`);
        }

        const resumed = await autoResumeSession(sessionId, content, titleCache, cwdOverride || projectPath, convId);
        if (resumed) {
          log(`Repair + resume succeeded for ${sessionId.slice(0, 8)}`);
          success = true;
          return true;
        }
      } catch (err) {
        log(`Convex regeneration failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const sessionFile = findSessionFile(sessionId);
        if (!sessionFile) return false;

        log(`Attempting surgical JSONL cleanup for ${sessionId.slice(0, 8)}...`);
        const lines = fs.readFileSync(sessionFile.path, "utf-8").split("\n").filter(l => l.trim());
        const cleanLines: string[] = [];
        let removed = 0;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const content = parsed.message?.content;
            if (Array.isArray(content)) {
              const hasCorruptToolResult = content.some((c: any) =>
                c.type === "tool_result" && c.content && typeof c.content === "string" &&
                (c.content.includes("is not an object") || c.content.includes("undefined"))
              );
              if (hasCorruptToolResult) {
                removed++;
                continue;
              }
            }
            cleanLines.push(line);
          } catch {
            cleanLines.push(line);
          }
        }

        if (removed > 0) {
          const bakPath = sessionFile.path + ".bak";
          if (!fs.existsSync(bakPath)) {
            fs.copyFileSync(sessionFile.path, bakPath);
          }
          fs.writeFileSync(sessionFile.path, cleanLines.join("\n") + "\n");
          log(`Surgical cleanup: removed ${removed} corrupt entries from ${sessionId.slice(0, 8)}`);

          const resumed = await autoResumeSession(sessionId, content, titleCache, cwdOverride, convId);
          if (resumed) {
            log(`Surgical repair + resume succeeded for ${sessionId.slice(0, 8)}`);
            success = true;
            return true;
          }
        }
      } catch (err) {
        log(`Surgical cleanup failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }

      return false;
    } finally {
      repairInFlight.delete(sessionId);
      const now = Date.now();
      if (success) {
        repairAttempts.delete(sessionId);
        if (conversationId) repairAttempts.delete(conversationId);
      } else {
        repairAttempts.set(sessionId, now);
        if (conversationId) repairAttempts.set(conversationId, now);
      }
    }
  })();

  repairInFlight.set(sessionId, promise);
  return promise;
}

async function postDeliveryHealthCheck(
  sessionId: string,
  conversationId: string,
  content: string,
  messageId: string,
  syncService: SyncService,
  titleCache: TitleCache,
  conversationCache: ConversationCache
): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 15000));

  // Skip health check if a resume is already in flight (remote or auto)
  if (resumeInFlight.has(sessionId)) {
    log(`Health check: skipping for ${sessionId.slice(0, 8)}, resume in flight`);
    return;
  }
  const restartTs = restartingSessionIds.get(sessionId);
  if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) {
    log(`Health check: skipping for ${sessionId.slice(0, 8)}, restart in progress`);
    return;
  }

  const tmuxSession = resumeSessionCache.get(sessionId);
  if (!tmuxSession) return;

  try {
    await tmuxExec(["has-session", "-t", tmuxSession]);
  } catch {
    log(`Health check: tmux session ${tmuxSession} is dead after delivery for ${sessionId.slice(0, 8)}`);

    const repaired = await repairAndResumeSession(sessionId, content, titleCache, undefined, conversationId);
    if (repaired) {
      log(`Health check: repaired and re-delivered message for ${sessionId.slice(0, 8)}`);
      try { await syncService.setSessionError(conversationId); } catch {}
    } else {
      log(`Health check: repair failed for ${sessionId.slice(0, 8)}, retrying message delivery`);
      try {
        await syncService.retryMessage(messageId);
        await syncService.setSessionError(conversationId, "Session crashed — retrying message delivery");
      } catch {}
    }
    return;
  }

  // Detection-only past this point. The tmux-session-missing branch above
  // already covers the unambiguous death case (and reconstitutes the worker
  // since there is nothing to kill). If the tmux is still listed we trust it
  // — a missing agent process or empty pane is not enough signal to tear
  // down a session out from under the user. They drive repair from the UI's
  // Kill & restart action when something looks wrong.
  const alive = await isTmuxAgentAlive(tmuxSession);
  if (alive) {
    log(`Health check: session ${sessionId.slice(0, 8)} is healthy`);
    try { await syncService.setSessionError(conversationId); } catch {}
  } else {
    log(`Health check: session ${sessionId.slice(0, 8)} agent looks idle/missing in ${tmuxSession}; not auto-killing (use Kill & restart in UI if wedged)`);
  }
}

const materializeFailures = new Map<string, number>();
const materializeInFlight = new Map<string, Promise<string | null>>();
const materializedSessions = new Set<string>();
const MATERIALIZE_COOLDOWN_MS = 5 * 60 * 1000;

// Pure selector: from a set of tmux sessions tagged with a conversation id,
// pick a live one belonging to this conversation. Used to reuse an existing
// managed session instead of spawning a duplicate when the in-memory
// startedSessionTmux cache is stale (e.g. resurrected from disk across a
// daemon restart, pointing at a session that was killed in a prior lifetime).
export function pickReusableConversationTmux(
  candidates: Array<{ tmuxSession: string; conversationId: string | null; alive: boolean }>,
  conversationId: string,
): string | null {
  for (const c of candidates) {
    if (c.alive && c.conversationId === conversationId) return c.tmuxSession;
  }
  return null;
}

// tmux is the durable source of truth for "is a session for this conversation
// already running?" — unlike startedSessionTmux, which persists to disk and
// reloads stale entries on each daemon construction.
async function findLiveTmuxForConversation(
  conversationId: string,
): Promise<StartedSessionInfo | null> {
  if (!hasTmux()) return null;
  try {
    const { stdout } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
    const names = stdout
      .trim()
      .split("\n")
      .filter(n => n.startsWith("cc-") || n.startsWith("cx-") || n.startsWith("gm-") || n.startsWith("ct-"));
    const candidates: Array<{ tmuxSession: string; conversationId: string | null; alive: boolean }> = [];
    for (const name of names) {
      const convId = await getTmuxSessionOption(name, "@codecast_conversation_id");
      // Only pay for the liveness check on a conversation match.
      const alive = convId === conversationId ? await isTmuxAgentAlive(name) : false;
      candidates.push({ tmuxSession: name, conversationId: convId, alive });
    }
    const match = pickReusableConversationTmux(candidates, conversationId);
    if (!match) return null;
    const projectPath =
      (await getTmuxSessionOption(match, "@codecast_project_path")) || process.env.HOME || "/tmp";
    const agentType =
      ((await getTmuxSessionOption(match, "@codecast_agent_type")) as StartedSessionInfo["agentType"] | null) ||
      "claude";
    return { tmuxSession: match, projectPath, startedAt: Date.now(), agentType };
  } catch {
    return null;
  }
}

async function startFreshSessionForDelivery(
  conversationId: string,
): Promise<StartedSessionInfo | null> {
  const existing = startedSessionTmux.get(conversationId);
  if (existing) return existing;

  if (!hasTmux()) {
    logDelivery(`Cannot start fresh session: tmux not available`);
    return null;
  }

  // Before spawning ANOTHER blank session, consult tmux for a live one already
  // tagged with this conversation. Guards against the double-start where the
  // in-memory cache lost track of a running session (resume fallback, restart
  // reload) and a redundant session would otherwise be created and the live one
  // orphaned.
  const reusable = await findLiveTmuxForConversation(conversationId);
  if (reusable) {
    startedSessionTmux.set(conversationId, reusable);
    logDelivery(
      `Reusing live tmux ${reusable.tmuxSession} for conv=${conversationId.slice(0, 12)} instead of starting fresh`,
    );
    return reusable;
  }

  const config = readConfig();
  let projectPath = process.env.HOME || "/tmp";

  if (config?.convex_url && config?.auth_token) {
    try {
      const siteUrl = config.convex_url.replace(".cloud", ".site");
      const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
      if (exportData.conversation?.project_path && fs.existsSync(exportData.conversation.project_path)) {
        projectPath = exportData.conversation.project_path;
      }
    } catch {}
  }

  const shortId = Math.random().toString(36).slice(2, 8);
  const tmuxSession = `cc-claude-${shortId}`;
  let extraFlags = config?.claude_args || "";
  const blankArgs = extraFlags ? extraFlags.split(/\s+/).filter(Boolean) : [];
  const safeBlankArgs = sanitizeBinaryArgs(blankArgs);
  const blankCmdText = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${["claude", ...safeBlankArgs].join(" ")}`;

  try {
    tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", projectPath], { timeout: 5000 });
    await setTmuxSessionOption(tmuxSession, "@codecast_conversation_id", conversationId).catch(() => {});
    await setTmuxSessionOption(tmuxSession, "@codecast_agent_type", "claude").catch(() => {});
    await setTmuxSessionOption(tmuxSession, "@codecast_project_path", projectPath).catch(() => {});
    tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", blankCmdText], { timeout: 5000 });
    tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
    const entry: StartedSessionInfo = {
      tmuxSession,
      projectPath,
      startedAt: Date.now(),
      agentType: "claude",
    };
    startedSessionTmux.set(conversationId, entry);
    if (syncServiceRef) {
      syncServiceRef.registerManagedSession(tmuxSession, process.pid, tmuxSession, conversationId as any).catch(logConvexFailure);
      ensureManagedSessionHeartbeat(tmuxSession);
    }
    discoverAndLinkSession(conversationId, tmuxSession, projectPath).catch(err => {
      log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
    });
    logDelivery(`Started fresh session ${tmuxSession} for conv=${conversationId.slice(0, 12)} in ${projectPath}`);
    return entry;
  } catch (err) {
    logDelivery(`Failed to start fresh session for conv=${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function materializeSession(
  conversationId: string,
  conversationCache: ConversationCache,
  titleCache: TitleCache,
  syncService?: SyncService
): Promise<string | null> {
  const existing = materializeInFlight.get(conversationId);
  if (existing) return existing;

  const lastFail = materializeFailures.get(conversationId);
  if (lastFail && Date.now() - lastFail < MATERIALIZE_COOLDOWN_MS) {
    return null;
  }

  const config = readConfig();
  if (!config?.convex_url || !config?.auth_token) {
    logDelivery(`Cannot materialize: missing convex_url or auth_token`);
    return null;
  }

  const siteUrl = config.convex_url.replace(".cloud", ".site");

  const promise = (async (): Promise<string | null> => {
    try {
      logDelivery(`Materializing session for conv=${conversationId.slice(0, 12)}...`);
      const exportData = await fetchExport(siteUrl, config.auth_token!, conversationId);
      if (exportData.messages.length === 0) {
        logDelivery(`Materialization skipped for ${conversationId.slice(0, 12)}: 0 messages (session_id=${exportData.conversation?.session_id?.slice(0, 8) || "none"})`);
        return null;
      }

      const TOKEN_BUDGET = 100_000;
      const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
      // Use the conversation's actual session_id so the JSONL matches Convex
      const convSessionId = exportData.conversation.session_id || undefined;
      const { jsonl, sessionId } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId: convSessionId });
      const projectPath = exportData.conversation.project_path || undefined;
      const { filePath: matFilePath } = writeClaudeCodeSession(jsonl, sessionId, localSessionDir(projectPath));
      setPosition(matFilePath, fs.statSync(matFilePath).size);

      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      materializedSessions.add(sessionId);
      if (exportData.conversation.title) {
        titleCache[sessionId] = exportData.conversation.title;
        saveTitleCache(titleCache);
      }

      if (syncService) {
        syncService.updateSessionId(conversationId, sessionId).catch(logConvexFailure);
      }

      logDelivery(`Materialized session=${sessionId.slice(0, 8)} conv=${conversationId.slice(0, 12)} (${exportData.messages.length} msgs, tail=${tailMessages})`);
      return sessionId;
    } catch (err) {
      logDelivery(`Materialization FAILED for ${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      materializeFailures.set(conversationId, Date.now());
      return null;
    } finally {
      materializeInFlight.delete(conversationId);
    }
  })();

  materializeInFlight.set(conversationId, promise);
  return promise;
}

async function downloadImage(storageId: string, syncService: SyncService): Promise<string | null> {
  const destPath = `/tmp/codecast/images/${storageId}.png`;
  if (fs.existsSync(destPath)) return destPath;

  const imageUrl = await syncService.getClient().query("images:getImageUrl" as any, { storageId });
  if (!imageUrl) return null;

  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
  return destPath;
}

async function deliverMessage(
  conversationId: string,
  content: string,
  conversationCache: ConversationCache,
  syncService: SyncService,
  messageId: string,
  titleCache: TitleCache
): Promise<boolean> {
  logDelivery(`deliverMessage called: conv=${conversationId.slice(0, 12)} msgId=${messageId.slice(0, 12)} content="${content.slice(0, 80)}"`);

  const childConvId = planHandoffChildren.get(conversationId);
  if (childConvId) {
    logDelivery(`Redirecting message from plan parent ${conversationId.slice(0, 12)} to child ${childConvId.slice(0, 12)}`);
    return deliverMessage(childConvId, content, conversationCache, syncService, messageId, titleCache);
  }

  if (codexAppServerInstance?.running) {
    const appServerThreadId = appServerConversations.get(conversationId);
    if (appServerThreadId) {
      try {
        const input: Array<{ type: "text"; text: string }> = [{ type: "text", text: content }];
        await codexAppServerInstance.turnStart({ threadId: appServerThreadId, input });
        await syncService.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        logDelivery(`[codex-app-server] delivered via app-server to thread ${appServerThreadId.slice(0, 8)}`);
        return true;
      } catch (err) {
        removeAppServerThreadRegistration(appServerThreads, appServerConversations, conversationId, appServerThreadId);
        if (err instanceof Error && /thread not found|no rollout found/i.test(err.message)) {
          forgetPersistedAppServerConversation(conversationId);
        }
        logDelivery(`[codex-app-server] delivery failed, falling back to tmux: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const reverseCache = buildReverseConversationCache(conversationCache);
  let sessionId = reverseCache[conversationId];

  const pendingPrompt = pendingInteractivePrompts.get(sessionId || conversationId);
  pendingInteractivePrompts.delete(sessionId || conversationId);
  lastEmittedSyntheticPrompt.delete(sessionId || conversationId);

  // If there's an active poll and the message is plain text (not already a poll response),
  // check if it matches one of the poll options and convert to a poll response
  if (pendingPrompt && !parsePollMessage(content)) {
    const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized && pendingPrompt.options.length > 0) {
      if (pendingPrompt.isConfirmation) {
        const isConfirm = /^(continue|enter|yes|ok|confirm|proceed|accept|y)$/i.test(normalized) ||
          (pendingPrompt.options[0] && normalized.includes(pendingPrompt.options[0].label.toLowerCase().split(" (")[0]));
        const isCancel = /^(cancel|escape|esc|no|quit|n)$/i.test(normalized) ||
          (pendingPrompt.options[1] && normalized.includes(pendingPrompt.options[1].label.toLowerCase().split(" (")[0]));
        if (isConfirm) {
          content = JSON.stringify({ __cc_poll: true, keys: ["Enter"], display: "Continue" });
          logDelivery(`Converted plain text to confirmation Enter for session=${(sessionId || conversationId).slice(0, 8)}`);
        } else if (isCancel) {
          content = JSON.stringify({ __cc_poll: true, keys: ["Escape"], display: "Cancel" });
          logDelivery(`Converted plain text to confirmation Escape for session=${(sessionId || conversationId).slice(0, 8)}`);
        }
      } else {
        const matchIdx = pendingPrompt.options.findIndex(opt => {
          const optNorm = opt.label.replace(/\s+/g, " ").trim().toLowerCase();
          return optNorm === normalized || normalized.includes(optNorm) || optNorm.includes(normalized);
        });
        if (matchIdx >= 0) {
          const display = pendingPrompt.options[matchIdx].label;
          const steps: Array<{ key: string }> = [];
          for (let i = 0; i < matchIdx; i++) steps.push({ key: "Down" });
          steps.push({ key: "Enter" });
          content = JSON.stringify({ __cc_poll: true, steps, display });
          logDelivery(`Converted plain text "${display}" to poll arrows=${matchIdx}+Enter for session=${(sessionId || conversationId).slice(0, 8)}`);
        }
      }
    }
  }

  if (!sessionId) {
    const cacheKeys = Object.keys(conversationCache);
    const reverseKeys = Object.keys(reverseCache);
    logDelivery(`No session in cache for conv=${conversationId.slice(0, 12)}, cache has ${cacheKeys.length} sessions/${reverseKeys.length} convs, startedTmux has ${startedSessionTmux.size} entries`);
    syncService.updateSessionAgentStatus(conversationId, "starting").catch(logConvexFailure);
    // Try delivering via a recently started tmux session (from start_session command)
    const tryStartedTmux = async (entry: StartedSessionInfo): Promise<boolean> => {
      try {
        await tmuxExec(["has-session", "-t", entry.tmuxSession]);
        // Agent-specific prompt patterns:
        // Claude: ❯ or ⏵   Codex: >   Gemini: various
        const promptPattern = entry.agentType === "codex" ? />\s*$/ : entry.agentType === "gemini" ? />\s*$|gemini/i : /❯|⏵/;
        const fatalErrors = [
          "cannot be launched inside another",
          "command not found",
          "No such file or directory",
          "ENOENT",
        ];
        let ready = false;
        const startTime = Date.now();
        const trustPromptPatterns = /trust this folder|safety check|Is this a project/i;
        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          try {
            const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", entry.tmuxSession, "-S", "-20"]);
            if (fatalErrors.some(e => paneContent.includes(e))) {
              log(`Started session ${entry.tmuxSession} hit fatal error, falling through. Pane: ${paneContent.slice(0, 200)}`);
              deleteStartedSession(conversationId);
              return false;
            }
            // Dismiss workspace trust prompt if detected (shows ❯ but isn't the input prompt)
            if (trustPromptPatterns.test(paneContent)) {
              log(`Started session ${entry.tmuxSession} showing trust prompt, sending Enter to accept`);
              await tmuxExec(["send-keys", "-t", entry.tmuxSession, "Enter"]);
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
            if (promptPattern.test(paneContent)) {
              // Verify it's the actual input prompt, not the trust prompt's ❯
              const lastLines = paneContent.split("\n").slice(-10).join("\n");
              if (trustPromptPatterns.test(lastLines)) continue;
              log(`Started session ${entry.tmuxSession} ready (prompt visible) after ${Date.now() - startTime}ms`);
              ready = true;
              break;
            }
          } catch {}
        }
        if (!ready) {
          log(`Started session ${entry.tmuxSession} startup timed out after ${Date.now() - startTime}ms, proceeding anyway`);
        }
        // Extra settle time: Claude Code's input handler may not be ready
        // immediately after the prompt is visible. Original budget was 1.5s
        // (speculative — no documented incident at lower values); the e2e
        // suite covers this exact race (Scenario 1: inject right after
        // first prompt). 500ms keeps a safety margin while shaving a full
        // second off cold-start delivery. If injects start failing
        // intermittently for fresh sessions, raise this back up first.
        await new Promise(resolve => setTimeout(resolve, 500));
        const startedTmuxTarget = entry.tmuxSession + ":0.0";
        // Paste first — the local send-keys IS the delivery and must not wait on Convex. Mark
        // "injected" best-effort after: the content-matched ack in addMessages flips the row to
        // "delivered" when Claude echoes the message to JSONL, so a blocking mark before the
        // paste is both unnecessary and a hang risk (an un-timed mark wedged the live-tmux path
        // for the full 180s timeout under Convex load).
        await injectViaTmux(startedTmuxTarget, content);
        markInjectedBestEffort(syncService, messageId);
        syncService.updateSessionAgentStatus(conversationId, "connected").catch(logConvexFailure);
        log(`Injected message to started session tmux ${entry.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
        const isPollResponse = !!parsePollMessage(content);
        if (content.trimStart().startsWith("/") || isPollResponse) {
          checkForInteractivePrompt(startedTmuxTarget, conversationId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
        }
        return true;
      } catch (err) {
        log(`Started session tmux ${entry.tmuxSession} not reachable, falling through: ${err instanceof Error ? err.message : String(err)}`);
        // Only clear if session is old (>60s). Fresh sessions may just need more startup time.
        if (Date.now() - entry.startedAt > 60_000) {
          deleteStartedSession(conversationId);
        }
        return false;
      }
    };

    const started = startedSessionTmux.get(conversationId);
    if (started && await tryStartedTmux(started)) return true;

    const freshCache = readConversationCache();
    const freshReverse = buildReverseConversationCache(freshCache);
    sessionId = freshReverse[conversationId];

    // OWNER GATE (split-brain guard). We have no started tmux and no cached
    // session for this conversation, so the only ways forward below are to
    // materialize from the server or spawn a brand-new session in $HOME. Neither
    // is ours to do if a *different* live, non-remote device owns this
    // conversation — that owner will deliver. A non-owner fabricating a fallback
    // session is exactly how m1 hijacked an owned conversation and answered with
    // an expired-auth 401 (see [OWNER] guard on session commands above; this is
    // the un-gated delivery twin). Fail-open on any lookup error.
    if (!sessionId) {
      try {
        const info = await syncService.getConversationOwnerInfo(conversationId);
        if (info && info.ownerDeviceId !== deviceId() && info.ownerOnline && !info.ownerIsRemote) {
          // Don't write agent status here — the owner is authoritative and may
          // already have set "working"; a non-owner "idle" write would clobber it.
          logDelivery(`[OWNER] skipping delivery for ${conversationId.slice(0, 12)} — owned by live local device ${info.ownerDeviceId.slice(0, 8)} (not ${deviceId().slice(0, 8)}), no local session to serve it`);
          return false;
        }
      } catch { /* on any error, fall through and try to deliver (fail-open) */ }
    }

    if (sessionId) {
      conversationCache[sessionId] = conversationId;
      log(`Found session ${sessionId.slice(0, 8)} for conversation ${conversationId.slice(0, 12)} via disk cache refresh`);
    } else if (!started) {
      logDelivery(`Waiting up to 12s for start_session to populate startedSessionTmux for conv=${conversationId.slice(0, 12)}`);
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500));
        const justStarted = startedSessionTmux.get(conversationId);
        if (justStarted) {
          log(`Found startedSessionTmux for ${conversationId.slice(0, 12)} after ${(i + 1) * 500}ms wait`);
          if (await tryStartedTmux(justStarted)) return true;
          break;
        }
        // Also check disk cache - session may have linked via watcher
        const recheckCache = readConversationCache();
        const recheckReverse = buildReverseConversationCache(recheckCache);
        if (recheckReverse[conversationId]) {
          sessionId = recheckReverse[conversationId];
          conversationCache[sessionId!] = conversationId;
          log(`Found session ${sessionId!.slice(0, 8)} for ${conversationId.slice(0, 12)} via disk cache on wait iteration ${i + 1}`);
          break;
        }
      }
      if (!sessionId) {
        log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
        sessionId = (await materializeSession(conversationId, conversationCache, titleCache, syncService))!;
        if (!sessionId) {
          logDelivery(`Materialization failed for conv=${conversationId.slice(0, 12)}, starting fresh session`);
          const freshEntry = await startFreshSessionForDelivery(conversationId);
          if (freshEntry && await tryStartedTmux(freshEntry)) return true;
          log(`Cannot deliver: no local session, materialization failed, and fresh start failed for ${conversationId}`);
          return false;
        }
        syncService.updateSessionAgentStatus(conversationId, "resuming").catch(logConvexFailure);
      }
    } else {
      log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
      sessionId = (await materializeSession(conversationId, conversationCache, titleCache, syncService))!;
      if (!sessionId) {
        logDelivery(`Materialization failed for conv=${conversationId.slice(0, 12)}, starting fresh session`);
        const freshEntry = await startFreshSessionForDelivery(conversationId);
        if (freshEntry && await tryStartedTmux(freshEntry)) return true;
        logDelivery(`Cannot deliver: no local session, materialization failed, and fresh start failed for conv=${conversationId.slice(0, 12)}`);
        return false;
      }
      syncService.updateSessionAgentStatus(conversationId, "resuming").catch(logConvexFailure);
    }
  }

  // Determine session type for process discovery and auto-resume
  const isCursorSession = sessionId.startsWith("cursor-");
  const isGeminiSession = sessionId.startsWith("session-");

  // Cursor is an IDE, not a terminal process - can't inject
  if (isCursorSession) {
    logDelivery(`Session ${sessionId.slice(0, 20)} is Cursor IDE, cannot inject - skipping`);
    return false;
  }

  // Detect codex sessions by checking if the JSONL exists in codex paths
  let detectedType: "claude" | "codex" | "cursor" | "gemini" = isGeminiSession ? "gemini" : "claude";
  if (!isGeminiSession) {
    const sessionFile = findSessionFile(sessionId);
    if (sessionFile) detectedType = sessionFile.agentType;
  }

  logDelivery(`Delivering to session=${sessionId.slice(0, 12)} conv=${conversationId.slice(0, 12)} type=${detectedType}`);


  // Find an already-live session (cached tmux / started session / live process pane) via the
  // shared resolver, so this path and autoResumeSession agree on "is it live and where".
  const live = await resolveLiveTmuxTarget(conversationId, sessionId, detectedType);
  let agentDetectedDead = false;
  if (live.tmuxTarget) {
    // Bare names (cache/started) target the session's active pane via ":0.0"; a
    // process-discovered pane ("cc-x:win.pane") is already fully qualified.
    const injectTarget = live.tmuxTarget.includes(":") ? live.tmuxTarget : live.tmuxTarget + ":0.0";
    const tmuxSessionName = injectTarget.split(":")[0];
    try {
      // Paste first — the local send-keys IS the delivery and must not wait on Convex. Mark
      // "injected" best-effort after (never a blocking await before): an un-timed mark here was
      // wedging the whole delivery for the 180s timeout under Convex load, so the paste never
      // ran. Correctness is preserved by the content-matched ack in addMessages, which flips the
      // pending row to "delivered" when Claude echoes the message to its JSONL regardless of the
      // intermediate "injected" status.
      await injectViaTmux(injectTarget, content);
      markInjectedBestEffort(syncService, messageId);
      // A process-discovered pane can go stale between scan and inject — verify the agent
      // survived and fall through to auto-resume if it crashed (the original optimistic path).
      if (live.source === "process" && !(await isTmuxAgentAlive(tmuxSessionName))) {
        logDelivery(`Agent in ${injectTarget} is dead after injection, falling through to auto-resume`);
        sessionProcessCache.delete(sessionId);
        agentDetectedDead = true;
      } else {
        if (live.source === "cache") syncService.setSessionError(conversationId).catch(logConvexFailure);
        logDelivery(`Injected via tmux ${injectTarget} (source=${live.source})`);
        const isPollResponse = !!parsePollMessage(content);
        if (content.trimStart().startsWith("/") || isPollResponse) {
          checkForInteractivePrompt(injectTarget, sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
        }
        return true;
      }
    } catch (err) {
      logDelivery(`tmux injection failed for ${injectTarget}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Live agent process not inside tmux (or the tmux inject failed without a confirmed-dead
  // agent): try direct terminal injection (AppleScript for iTerm2/Terminal.app, CLI for
  // Kitty/WezTerm). Skipped when the agent was just detected dead — that goes to auto-resume.
  if (live.proc && !agentDetectedDead) {
    const termLabel = getTerminalLabel(live.proc.termProgram);
    logDelivery(`Trying ${termLabel} injection for tty=${live.proc.tty}`);
    try {
      await injectViaTerminal(live.proc.tty, content, live.proc.termProgram);
      markInjectedBestEffort(syncService, messageId);
      logDelivery(`Injected via ${termLabel} tty=${live.proc.tty}`);
      return true;
    } catch (err) {
      logDelivery(`${termLabel} injection failed for ${live.proc.tty}: ${err instanceof Error ? err.message : String(err)}`);
    }
    logDelivery(`All injection methods failed for live process pid=${live.proc.pid}, falling back to auto-resume`);
  } else if (!live.tmuxTarget && !live.proc) {
    logDelivery(`No running process found for session=${sessionId.slice(0, 12)} type=${detectedType}`);
  }

  // Circuit breaker: skip auto-resume if this session has failed too many times recently
  if (isSessionCircuitOpen(sessionId)) {
    logDelivery(`Circuit breaker OPEN for session=${sessionId.slice(0, 8)}, skipping auto-resume (cooldown ${SESSION_CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s)`);
    return false;
  }

  // Last resort: auto-resume in a new tmux session
  const tmuxAvailable = hasTmux();
  logDelivery(`Attempting auto-resume: session=${sessionId.slice(0, 8)} tmux=${tmuxAvailable}`);
  if (!tmuxAvailable) {
    logDelivery(`CANNOT auto-resume: tmux is not installed. Install with: brew install tmux`);
  }
  // Mark "injected" best-effort (non-blocking) before the resume. autoResumeSession spins up
  // tmux + Claude and injects the content; the content-matched ack in addMessages flips the row
  // to "delivered" when Claude echoes the message to JSONL, so this status write is not
  // load-bearing. Keeping it non-blocking ensures a slow/stalled Convex mark can't wedge the
  // resume+inject — the same failure mode fixed on the live-tmux path above.
  markInjectedBestEffort(syncService, messageId);
  const resumed = await autoResumeSession(sessionId, content, titleCache, undefined, conversationId);
  if (resumed) {
    resetSessionDeliveryFailures(sessionId);
    materializedSessions.delete(sessionId);
    logDelivery(`Injected via auto-resume for session=${sessionId.slice(0, 8)}`);
    const isPollResponse = !!parsePollMessage(content);
    if (content.trimStart().startsWith("/") || isPollResponse) {
      const resumeTmux = resumeSessionCache.get(sessionId);
      if (resumeTmux) {
        checkForInteractivePrompt(resumeTmux + ":0.0", sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
      }
    }
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService, titleCache, conversationCache).catch(err => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  // Auto-resume failed - try repair (regenerate JSONL from Convex)
  logDelivery(`Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
  // Row is already marked "injected" from the auto-resume attempt above; repair+resume is a
  // second delivery path for the same message, so no re-mark needed.
  const repaired = await repairAndResumeSession(sessionId, content, titleCache, undefined, conversationId);
  if (repaired) {
    resetSessionDeliveryFailures(sessionId);
    materializedSessions.delete(sessionId);
    logDelivery(`Injected via repair+resume for session=${sessionId.slice(0, 8)}`);
    const isPollResponse = !!parsePollMessage(content);
    if (content.trimStart().startsWith("/") || isPollResponse) {
      const resumeTmux = resumeSessionCache.get(sessionId);
      if (resumeTmux) {
        checkForInteractivePrompt(resumeTmux + ":0.0", sessionId, conversationId, syncService, isPollResponse ? 4000 : 2000).catch(() => {});
      }
    }
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService, titleCache, conversationCache).catch(err => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  // Only a genuinely-unrecoverable resume (recorded in resumeFatalReasons: missing
  // conversation, retired model, session truly gone) earns the long 5-min cooldown.
  // Everything else — a resume we launched that died, a slow/raced cold boot, a
  // one-off SESSION_EXITED during inject — is transient and gets the short backoff,
  // so a recoverable hiccup can no longer masquerade as a dead session for minutes.
  const fatal = resumeFatalReasons.has(sessionId);
  recordSessionDeliveryFailure(sessionId, { transient: !fatal });
  logDelivery(`DELIVERY FAILED: all methods exhausted for session=${sessionId.slice(0, 8)} conv=${conversationId.slice(0, 12)} (${fatal ? "fatal" : "transient"})`);
  return false;
}

function isSyncPaused(): boolean {
  return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
}

async function repairProjectPaths(syncService: SyncService): Promise<void> {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return;

  log("Checking for project paths that need repair...");

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let repaired = 0;
  let checked = 0;

  for (const dir of projectDirs) {
    const dirPath = path.join(claudeProjectsDir, dir);
    const sessionFiles = fs.readdirSync(dirPath)
      .filter(f => f.endsWith(".jsonl") && f !== "sessions-index.json");

    const decodedPath = decodeProjectDirName(dir);
    const resolvedDir = decodedPath && decodedPath !== process.env.HOME && fs.existsSync(decodedPath) ? decodedPath : null;
    // Learn this repo's local home so a fork recorded on another machine (different
    // absolute path, same basename) resolves here even if it lives off-convention.
    // (Never the bare $HOME — that's the fingerprint of a stray $HOME-fallback dir.)
    if (resolvedDir) recordProjectMapping(path.basename(resolvedDir), resolvedDir);

    for (const file of sessionFiles) {
      const filePath = path.join(dirPath, file);
      const sessionId = resolveSessionId(filePath);

      try {
        checked++;

        // Trust the transcript's recorded cwd over the (lossy, copyable) folder
        // slug; a transcript resumed/copied into a foreign or $HOME dir would
        // otherwise re-clobber project_path to e.g. "/Users/m1" on every startup.
        const projectPath = resolveTranscriptProjectPath(filePath, dir);
        if (!projectPath) continue;

        const gitInfo = getGitInfo(projectPath);
        const result = await syncService.updateProjectPath(sessionId, projectPath, gitInfo?.repoRoot || gitInfo?.root);
        if (result?.updated) {
          repaired++;
          log(`Repaired path for ${sessionId.slice(0, 8)}: ${projectPath}`);
        }
      } catch {
        // Skip files we can't read or sessions that don't exist in Convex
      }
    }
  }

  if (repaired > 0) {
    log(`Repaired ${repaired} project paths (checked ${checked})`);
  }
}

async function backfillPlanModeFromJSONL(syncService: SyncService): Promise<void> {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return;

  let synced = 0;
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of projectDirs) {
    const dirPath = path.join(claudeProjectsDir, dir);
    let sessionFiles: string[];
    try {
      sessionFiles = fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl") && !f.includes("sessions-index"));
    } catch { continue; }

    const decodedPath = decodeProjectDirName(dir);

    for (const file of sessionFiles) {
      const filePath = path.join(dirPath, file);
      const sessionId = file.replace(".jsonl", "");
      if (planModeSynced.has(sessionId)) continue;

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (!content.includes("ExitPlanMode")) continue;

        let planContent: string | undefined;
        for (const line of content.split("\n")) {
          if (!line.includes("ExitPlanMode")) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry.message || entry;
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            for (const block of blocks) {
              if (block.type === "tool_use" && block.name === "ExitPlanMode" && block.input?.plan) {
                planContent = block.input.plan;
                break;
              }
            }
          } catch { continue; }
          if (planContent) break;
        }

        if (!planContent) continue;

        // Trust the transcript cwd over a slug that only resolves to $HOME (a
        // stray $HOME-fallback dir); keep undefined when nothing resolves.
        const projPath =
          decodedPath && decodedPath !== process.env.HOME && fs.existsSync(decodedPath)
            ? decodedPath
            : (extractCwd(content) || undefined);
        const planShortId = await syncService.syncPlanFromPlanMode({
          sessionId,
          planContent,
          projectPath: projPath,
        });

        planModeSynced.add(sessionId);
        if (planShortId) planModePlanMap.set(sessionId, planShortId);
        savePlanModeCache();
        synced++;
        log(`Backfilled plan_mode plan ${planShortId || "doc-only"} for session ${sessionId.slice(0, 8)}`);
      } catch (err) {
        // Skip individual failures silently
      }
    }
  }

  if (synced > 0) log(`Backfilled ${synced} plan_mode plan(s) from JSONL history`);
}

async function waitForConfig(): Promise<{ config: Config; convexUrl: string }> {
  const checkInterval = 30000;
  let lastReason: string | null = null;
  let unchangedRepeats = 0;
  const HEARTBEAT_EVERY = 20; // re-log the same reason every ~10min so it can't slip past log rotation

  while (true) {
    const diag = diagnoseConfig();
    if (diag.ok) {
      return { config: diag.config, convexUrl: diag.convexUrl };
    }
    if (diag.reason !== lastReason) {
      log(diag.reason);
      lastReason = diag.reason;
      unchangedRepeats = 0;
    } else if (++unchangedRepeats >= HEARTBEAT_EVERY) {
      log(diag.reason);
      unchangedRepeats = 0;
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isTmuxAgentAlive(tmuxSession: string): Promise<boolean> {
  if (!hasTmux()) return false;
  try {
    const { stdout } = await tmuxExec(
      ["list-panes", "-t", tmuxSession, "-F", "#{pane_pid}"], { timeout: 3000, killSignal: "SIGKILL" }
    );
    const panePid = stdout.trim();
    if (!panePid) return false;

    const hasProcess = await hasAgentProcessInTree(parseInt(panePid, 10));

    try {
      const { stdout: paneContent } = await tmuxExec(
        ["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-10"], { timeout: 3000, killSignal: "SIGKILL" }
      );
      const trimmed = paneContent.trim();
      if (!trimmed) return false;
      if (/Resume this session with:/i.test(trimmed)) return false;
      if (/Segmentation fault|panic:|SIGABRT|core dumped|exited with/.test(trimmed)) return false;
      if (/-(?:ba)?sh:.*(?:No such file|command not found)/.test(trimmed)) return false;
      if (hasProcess) return true;
      // No agent process in the process tree — the agent has exited or crashed.
      // Don't optimistically return true just because the pane has content; that
      // content is likely a crash stack trace or leftover output from the dead
      // process. Return false so the caller falls through to auto-resume.
      return false;
    } catch {}
    return hasProcess;
  } catch {
    return false;
  }
}

// Walk a process tree (BFS, bounded depth) and return the first agent process
// pid found, or null. The pid is what we seed into sessionProcessCache — it must
// be the agent itself (not the parent shell) so the cache's isAgentProcess
// revalidation keeps it alive.
async function findAgentPidInTree(rootPid: number, maxDepth = 4): Promise<number | null> {
  const visited = new Set<number>();
  async function scan(pids: number[], depth: number): Promise<number | null> {
    if (depth > maxDepth || pids.length === 0) return null;
    for (const pid of pids) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      if (isAgentProcess(pid)) return pid;
    }
    for (const pid of pids) {
      try {
        const { stdout } = await execAsync(`pgrep -P ${pid}`, { timeout: 3000, killSignal: "SIGKILL" });
        const children = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
        const found = await scan(children, depth + 1);
        if (found !== null) return found;
      } catch {}
    }
    return null;
  }
  // Include the root itself, then descend — a bare `claude` pane_pid is the agent.
  if (isAgentProcess(rootPid)) return rootPid;
  try {
    const { stdout } = await execAsync(`pgrep -P ${rootPid}`, { timeout: 3000, killSignal: "SIGKILL" });
    const childPids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    return scan(childPids, 1);
  } catch {}
  return null;
}

async function hasAgentProcessInTree(rootPid: number, maxDepth = 4): Promise<boolean> {
  return (await findAgentPidInTree(rootPid, maxDepth)) !== null;
}

function isAgentProcess(pid: number): boolean {
  try {
    const comm = execSync(`ps -o comm= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (!comm) return false;
    const agentPatterns = ["claude", "codex", "gemini", "node", "bun", "deno"];
    const lower = comm.toLowerCase();
    return agentPatterns.some(p => lower.includes(p));
  } catch {
    return false;
  }
}

let skipRespawn = false;

function isManagedByLaunchd(): boolean {
  return !!process.env.XPC_SERVICE_NAME;
}

// Mutual supervision: the launchd watchdog revives the daemon, and the daemon
// (here) revives the watchdog. As long as either is alive it restores the other,
// so the pair survives sleep, crashes, `cast stop`, and the upgrade/login races
// that can boot one of them out of launchd. Without this the watchdog had no
// backstop — once it was booted out nothing brought it back, and a daemon that
// then died stayed dead (the 30-min outage we hit). Throttled so the periodic
// health tick doesn't shell out to launchctl when the watchdog is already healthy.
//
// "Loaded" is NOT "alive". A StartInterval watchdog was observed wedged at runs=1
// for 27h — launchd listed it as loaded while it had stopped firing entirely, so a
// loaded-only check (the old behavior here) saw "fine" and never revived it. The
// resident watchdog now stamps a heartbeat file every loop; we treat a stale stamp
// as a dead loop and kickstart it, mirroring how the watchdog judges the daemon.
let lastWatchdogEnsureAt = 0;
function ensureWatchdogSupervised(force = false): void {
  if (platform !== "darwin" || !process.getuid || !isManagedByLaunchd()) return;
  const now = Date.now();
  if (!force && now - lastWatchdogEnsureAt < 4 * 60 * 1000) return;
  lastWatchdogEnsureAt = now;
  try {
    const uid = process.getuid();
    const domain = `gui/${uid}`;
    const label = "sh.codecast.watchdog";
    const loaded =
      spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0;
    if (!loaded) {
      const plistPath = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
      if (!fs.existsSync(plistPath)) {
        log(`Watchdog plist missing (${plistPath}) — run 'cast setup' to restore supervision`);
        return;
      }
      log("Watchdog launchd job not loaded — bootstrapping it");
      spawnSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
      spawnSync("launchctl", ["kickstart", `${domain}/${label}`], { stdio: "ignore" });
      return;
    }
    // Loaded — but is the loop actually running? Stale heartbeat ⇒ wedged/dead loop.
    let heartbeat: string | null = null;
    try {
      heartbeat = fs.readFileSync(path.join(CONFIG_DIR, WATCHDOG_HEARTBEAT_FILENAME), "utf-8");
    } catch { heartbeat = null; }
    if (watchdogHeartbeatStale(heartbeat, now)) {
      log("Watchdog loaded but heartbeat stale — kickstarting the wedged loop");
      spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
    }
  } catch (err) {
    log(`ensureWatchdogSupervised failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function spawnReplacement(): boolean {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CODECAST_RESTART: "1" },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Force launchd to relaunch this job via `kickstart -k` (kill + start). We do NOT
// trust KeepAlive to notice our exit on its own: it has been observed to silently
// not respawn after a self-heal exit, leaving the daemon dead for hours until a
// manual kickstart. kickstart is an explicit imperative that works even when
// KeepAlive is wedged, and because it SIGKILLs us externally it also doesn't depend
// on our own exit timer firing — which matters when we're restarting precisely
// because the timer subsystem is dead (post-sleep). Detached so it outlives our exit.
// `-k` kills the current instance before starting; the brief sleep lets us flush
// and (if timers are alive) exit gracefully first, but the kill makes restart happen
// even if our own exit never does. Pure so the wiring (label, gui/$uid, -k) is testable
// without spawning a real kickstart against the live daemon.
export function buildLaunchdKickstartCommand(uid: number): string {
  return `sleep 1; launchctl kickstart -k gui/${uid}/sh.codecast.daemon`;
}

function requestLaunchdRestart(): boolean {
  if (platform !== "darwin" || !process.getuid) return false;
  try {
    const uid = process.getuid();
    persistLogQueue(); // SIGKILL skips exit handlers; flush queued logs first
    spawn("sh", ["-c", buildLaunchdKickstartCommand(uid)], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return true;
  } catch {
    return false;
  }
}

function triggerSelfRestart(): void {
  if (isManagedByLaunchd()) {
    // Imperatively kick launchd; kickstart -k kills this instance and starts a fresh
    // one. Only fall through to the exit-and-trust-KeepAlive path if that fails.
    if (requestLaunchdRestart()) return;
  } else {
    const spawned = spawnReplacement();
    if (spawned) skipRespawn = true;
  }
  setTimeout(() => process.exit(0), 500);
}

// Cross-platform self-heal. setInterval/setTimeout do not reliably survive a long
// system sleep (kqueue-timer death on macOS, similar hazards elsewhere): they stop
// firing and never re-arm, so the daemon stays alive but every interval-based safety
// net is dead. We cannot detect that from a timer (the detector would be dead too),
// so we check from event-driven callbacks that DO resume on wake (file watcher, Convex
// socket) and restart through the existing supervisor contract (launchd KeepAlive /
// systemd Restart=always / self-respawn) to get a fresh timer subsystem. No OS-specific
// code. lastEventLoopTick is refreshed by the event-loop monitor every ~30s; if it
// drifts far past that, the monitor's timer is dead rather than merely slow.
let lastEventLoopTick = Date.now();
let selfHealing = false;
const SELF_HEAL_TICK_STALE_MS = 5 * 60 * 1000;

// Restart only when the event-loop monitor's timer is dead (tick far past its ~30s
// cadence), never when it is merely slow under load, and never twice.
export function shouldSelfHeal(
  staleMs: number,
  alreadyHealing: boolean,
  thresholdMs: number = SELF_HEAL_TICK_STALE_MS,
): boolean {
  if (alreadyHealing) return false;
  return staleMs > thresholdMs;
}

function selfHealIfTimersStalled(source: string): void {
  const stale = Date.now() - lastEventLoopTick;
  if (!shouldSelfHeal(stale, selfHealing)) return;
  selfHealing = true;
  log(`[SELF-HEAL] event-loop timer stalled ${Math.round(stale / 1000)}s (timers dead, likely post-sleep), restarting via ${source}`);
  logLifecycle("self_heal_restart", `tick stalled ${Math.round(stale / 1000)}s, via ${source}`);
  triggerSelfRestart();
}

const CRASH_FILE = path.join(CONFIG_DIR, "crash-count.json");

function recordCrash(): { count: number; backoffMinutes: number } {
  try {
    let crashes: { count: number; firstCrash: number } = { count: 0, firstCrash: Date.now() };
    if (fs.existsSync(CRASH_FILE)) {
      crashes = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
    }
    const windowMs = 30 * 60 * 1000;
    if (Date.now() - crashes.firstCrash > windowMs) {
      crashes = { count: 0, firstCrash: Date.now() };
    }
    crashes.count++;
    fs.writeFileSync(CRASH_FILE, JSON.stringify(crashes));
    const backoffMinutes = crashes.count <= 3 ? 0 : Math.min(crashes.count * 2, 30);
    return { count: crashes.count, backoffMinutes };
  } catch {
    return { count: 1, backoffMinutes: 0 };
  }
}

function clearCrashCount(): void {
  try { if (fs.existsSync(CRASH_FILE)) fs.unlinkSync(CRASH_FILE); } catch {}
}

function readPidFile(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function tryAcquirePidFileLock(
  pidFile: string,
  pid: number,
  options: {
    nowMs?: number;
    staleGraceMs?: number;
    isProcessRunning?: (pid: number) => boolean;
  } = {},
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const staleGraceMs = options.staleGraceMs ?? PID_FILE_STALE_GRACE_MS;
  const isPidRunning = options.isProcessRunning ?? isProcessRunning;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(pidFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${pid}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return false;
    }

    const existingPid = readPidFile(pidFile);
    if (existingPid === pid) return true;
    if (existingPid && isPidRunning(existingPid)) return false;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(pidFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return false;
    }

    if (nowMs - stat.mtimeMs < staleGraceMs) {
      return false;
    }

    try {
      fs.unlinkSync(pidFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return false;
    }
  }

  return false;
}

export function releasePidFileIfOwned(pidFile: string, pid: number): boolean {
  if (readPidFile(pidFile) !== pid) return false;
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  const underLaunchd = isManagedByLaunchd();

  // Even without a PID file, check for zombie daemon processes (e.g. from a
  // shutdown that deleted the PID file but failed to exit).
  if (!underLaunchd) {
    try {
      const pgrepOut = execSync(`pgrep -f 'daemon\\.ts$' 2>/dev/null || true`, { encoding: "utf-8", timeout: 3000 });
      const pids = pgrepOut.trim().split("\n").map(Number).filter(p => p && p !== process.pid && isProcessRunning(p));
      for (const zombiePid of pids) {
        log(`Killing zombie daemon process ${zombiePid}`);
        try { process.kill(zombiePid, "SIGKILL"); } catch {}
      }
    } catch {}
  }

  return tryAcquirePidFileLock(PID_FILE, process.pid);
}

function findStaleSessionFiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const staleFiles: { path: string; mtimeMs: number }[] = [];
  const now = Date.now();

  if (!fs.existsSync(claudeProjectsDir)) {
    return [];
  }

  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(claudeProjectsDir, projectDir);
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;

      const files = fs.readdirSync(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(projectPath, file);
        try {
          const fileStat = fs.statSync(filePath);
          const fileAge = now - fileStat.mtimeMs;

          if (fileAge > maxAgeMs) continue;

          const syncRecord = getSyncRecord(filePath);
          if (shouldTreatClaudeFileAsStale(fileStat, syncRecord)) {
            staleFiles.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
          }
        } catch {
        }
      }
    }
  } catch (err) {
    log(`Watchdog: Error scanning for stale files: ${err instanceof Error ? err.message : String(err)}`);
  }

  staleFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return staleFiles.map(f => f.path);
}

export function shouldTreatClaudeFileAsStale(
  fileStat: { mtimeMs: number; size: number },
  syncRecord: SyncRecord | null
): boolean {
  if (!syncRecord) {
    return true;
  }
  if (!syncRecord.isLegacyFallback && fileStat.mtimeMs > syncRecord.lastSyncedAt) {
    return true;
  }
  return fileStat.size > syncRecord.lastSyncedPosition;
}

export function isAppServerManagedCodexSessionHead(headContent: string): boolean {
  const firstLine = headContent.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) return false;

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { originator?: string; source?: string | { custom?: string } };
    };
    if (parsed.type !== "session_meta") return false;
    if (parsed.payload?.originator === "codecast") return true;
    return typeof parsed.payload?.source === "object" && parsed.payload.source?.custom === "codecast";
  } catch {
    return firstLine.includes('"originator":"codecast"') || firstLine.includes('"source":{"custom":"codecast"}');
  }
}

function findStaleCodexSessionFiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const codexSessionsDir = path.join(process.env.HOME || "", ".codex", "sessions");
  const staleFiles: { path: string; mtimeMs: number }[] = [];
  const now = Date.now();

  if (!fs.existsSync(codexSessionsDir)) {
    return [];
  }

  const scanDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = fs.statSync(fullPath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs) continue;

          const lastPosition = getPosition(fullPath);
          if (fileStat.size !== lastPosition) {
            const headContent = readFileHead(fullPath, 2048);
            if (isAppServerManagedCodexSessionHead(headContent)) continue;
            staleFiles.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
          }
        } catch {
          continue;
        }
      }
    }
  };

  scanDir(codexSessionsDir);
  staleFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return staleFiles.map(f => f.path);
}

function detectCursorPath(): string {
  const platform = process.platform;
  const home = process.env.HOME || "";

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor");
  } else if (platform === "linux") {
    return path.join(home, ".config", "Cursor");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor");
  }

  return path.join(home, ".cursor");
}

function getCursorWorkspaceStoragePath(): string | null {
  const cursorPath = detectCursorPath();
  const workspaceStoragePath = path.join(cursorPath, "User", "workspaceStorage");
  if (!fs.existsSync(workspaceStoragePath)) {
    return null;
  }
  return workspaceStoragePath;
}

function getCursorWorkspaceFolderPath(workspaceStorageDir: string): string | null {
  const workspaceJsonPath = path.join(workspaceStorageDir, "workspace.json");
  try {
    if (!fs.existsSync(workspaceJsonPath)) {
      return null;
    }
    const content = fs.readFileSync(workspaceJsonPath, "utf-8");
    const data = JSON.parse(content);

    const folderUri = data.folder || data.workspace;
    if (!folderUri) {
      return null;
    }

    if (folderUri.startsWith("file://")) {
      const decoded = decodeURIComponent(folderUri.slice(7));
      if (process.platform === "win32" && decoded.match(/^\/[A-Z]:/i)) {
        return decoded.slice(1);
      }
      return decoded;
    }

    return folderUri;
  } catch {
    return null;
  }
}

function getCursorMaxRowId(dbPath: string): number {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const tableExists = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
      )
      .get();

    if (!tableExists) {
      return 0;
    }

    const maxRowIdResult = db
      .query<{ maxRowId: number | null }, []>(
        "SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'"
      )
      .get();

    return maxRowIdResult?.maxRowId ?? 0;
  } catch {
    return 0;
  } finally {
    if (db) {
      db.close();
    }
  }
}

interface CursorComposerData {
  allComposers?: Array<{
    composerId?: string;
  }>;
}

function getCursorComposerData(dbPath: string): CursorComposerData | null {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1"
      )
      .get();
    if (!row?.value) {
      return null;
    }
    return JSON.parse(row.value) as CursorComposerData;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

function findWorkspacePathForCursorConversation(sessionId: string): string | null {
  const workspaceStoragePath = getCursorWorkspaceStoragePath();
  if (!workspaceStoragePath) {
    return null;
  }

  let workspaceDirs: string[];
  try {
    workspaceDirs = fs.readdirSync(workspaceStoragePath);
  } catch {
    return null;
  }

  for (const workspaceHash of workspaceDirs) {
    const dbPath = path.join(workspaceStoragePath, workspaceHash, "state.vscdb");
    if (!fs.existsSync(dbPath)) {
      continue;
    }

    const composerData = getCursorComposerData(dbPath);
    const composers = composerData?.allComposers || [];
    if (!composers.some(c => c.composerId === sessionId)) {
      continue;
    }

    const workspaceStorageDir = path.dirname(dbPath);
    return getCursorWorkspaceFolderPath(workspaceStorageDir);
  }

  return null;
}

interface StaleCursorSession {
  sessionId: string;
  workspacePath: string;
  dbPath: string;
  mtimeMs: number;
}

function findStaleCursorSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): StaleCursorSession[] {
  const workspaceStoragePath = getCursorWorkspaceStoragePath();
  const staleSessions: StaleCursorSession[] = [];
  const now = Date.now();

  if (!workspaceStoragePath) {
    return staleSessions;
  }

  let workspaceDirs: string[];
  try {
    workspaceDirs = fs.readdirSync(workspaceStoragePath);
  } catch {
    return staleSessions;
  }

  for (const workspaceHash of workspaceDirs) {
    const dbPath = path.join(workspaceStoragePath, workspaceHash, "state.vscdb");
    if (!fs.existsSync(dbPath)) {
      continue;
    }

    try {
      const stat = fs.statSync(dbPath);
      const fileAge = now - stat.mtimeMs;
      if (fileAge > maxAgeMs) continue;

      const maxRowId = getCursorMaxRowId(dbPath);
      if (maxRowId <= 0) continue;

      const lastRowId = getPosition(dbPath);
      if (maxRowId <= lastRowId) continue;

      const workspaceStorageDir = path.dirname(dbPath);
      const workspacePath = getCursorWorkspaceFolderPath(workspaceStorageDir) || workspaceHash;

      staleSessions.push({
        sessionId: workspaceHash,
        workspacePath,
        dbPath,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      continue;
    }
  }

  staleSessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return staleSessions;
}

function findStaleCursorTranscriptFiles(
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): string[] {
  const cursorProjectsDir = path.join(process.env.HOME || "", ".cursor", "projects");
  const staleFiles: { path: string; mtimeMs: number }[] = [];
  const now = Date.now();

  if (!fs.existsSync(cursorProjectsDir)) {
    return [];
  }

  const scanDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".txt")) {
        if (!fullPath.includes(`${path.sep}agent-transcripts${path.sep}`)) {
          continue;
        }
        try {
          const fileStat = fs.statSync(fullPath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs) continue;

          const lastPosition = getPosition(fullPath);
          if (fileStat.size !== lastPosition) {
            staleFiles.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
          }
        } catch {
          continue;
        }
      }
    }
  };

  scanDir(cursorProjectsDir);
  staleFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return staleFiles.map(f => f.path);
}

interface WatchdogDependencies {
  config: Config;
  syncService: SyncService;
  conversationCache: ConversationCache;
  retryQueue: RetryQueue;
  pendingMessages: PendingMessages;
  titleCache: TitleCache;
  updateState: () => void;
  watcher: SessionWatcher;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

async function checkForForcedUpdate(syncService: SyncService): Promise<boolean> {
  try {
    const minVersion = await syncService.getMinCliVersion();
    if (!minVersion) return false;

    const currentVersion = getVersion();
    if (compareVersions(currentVersion, minVersion) < 0) {
      logLifecycle("forced_update_start", `current=${currentVersion} min=${minVersion}`);
      await flushRemoteLogs();
      const result = await performUpdate();
      if (result.success) {
        logLifecycle("forced_update_complete", `Binary replaced from v${currentVersion}, target>=${minVersion}`);
        await flushRemoteLogs();
        if (!isManagedByLaunchd()) {
          spawnReplacement();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        process.exit(0);
      } else {
        logLifecycle("forced_update_failed", `current=${currentVersion} target>=${minVersion} error=${result.error}`);
        await flushRemoteLogs();
      }
      return false;
    }
    return false;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Forced update check failed`, err instanceof Error ? err : undefined);
    return false;
  }
}

function checkDiskVersionMismatch(): void {
  try {
    const updateTsPath = path.join(__dirname, "update.ts");
    const updateJsPath = path.join(__dirname, "update.js");
    const filePath = fs.existsSync(updateTsPath) ? updateTsPath : updateJsPath;
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const match = content.match(/const VERSION\s*=\s*["']([^"']+)["']/);
    if (!match) return;

    const diskVersion = match[1];
    if (diskVersion !== daemonVersion) {
      log(`Disk version mismatch: running=${daemonVersion} disk=${diskVersion}, restarting`);
      logLifecycle("version_mismatch_restart", `${daemonVersion} -> ${diskVersion}`);
      flushRemoteLogs().then(() => {
        if (!isManagedByLaunchd()) {
          const spawned = spawnReplacement();
          if (spawned) skipRespawn = true;
        }
        setTimeout(() => process.exit(0), 500);
      }).catch(() => {
        if (!isManagedByLaunchd()) {
          const spawned = spawnReplacement();
          if (spawned) skipRespawn = true;
        }
        setTimeout(() => process.exit(0), 500);
      });
    }
  } catch {}
}

function startEventLoopMonitor(): NodeJS.Timeout {
  let lastTickTime = Date.now();

  return setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickTime;
    lastTickTime = now;

    saveDaemonState({ lastHeartbeatTick: now });
    lastEventLoopTick = now;

    if (elapsed > EVENT_LOOP_LAG_THRESHOLD_MS) {
      logLifecycle("wake_detected", `System was suspended for ${Math.round(elapsed / 1000)}s, recovering`);
      // Re-arm to `now`, not 0. Setting to 0 would make the next watchdog tick
      // see ~56 years of idle time and force a watcher.restart() on every wake,
      // which can deadlock bun's native File Watcher thread (lock inversion in
      // fs.watch close→open under load). The watcher's FSEvents handle survives
      // sleep/wake on macOS; if it doesn't, the genuine 60-min idle path catches it.
      lastWatcherEventTime = now;
    }
  }, EVENT_LOOP_CHECK_INTERVAL_MS);
}

function startVersionChecker(syncService: SyncService): NodeJS.Timeout {
  checkForForcedUpdate(syncService);
  maybeUpdateDesktopApp();

  return setInterval(() => {
    checkForForcedUpdate(syncService);
    maybeUpdateDesktopApp();
  }, VERSION_CHECK_INTERVAL_MS);
}

// Out-of-band updater for the Codecast desktop app: Squirrel.Mac's in-app
// auto-update is wedged on macOS 26 (launchd never runs its ShipIt helper), so
// the daemon — which updates over a Squirrel-independent channel — finishes the
// job. Gated on config (opt-out) and guarded against disrupting a running app.
function maybeUpdateDesktopApp(): void {
  const config = readConfig();
  if (config?.desktop_auto_update === false) return;
  checkForDesktopUpdate((msg) => log(msg)).catch(() => {});
}

function logHealthReport(retryQueue: RetryQueue): void {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);
  const droppedOps = retryQueue.getDroppedOperations();
  const queueSize = retryQueue.getLogicalQueueSize();

  if (unsyncedFiles.length > 0 || droppedOps.length > 0 || queueSize > 10) {
    logWarn(
      `Health: ${unsyncedFiles.length} pending files, ${droppedOps.length} dropped ops, ${queueSize} in retry queue`
    );
  }
}

function startReconciliation(
  syncService: SyncService,
  retryQueue: RetryQueue,
  conversationCache: ConversationCache
): NodeJS.Timeout {
  log("Reconciliation scheduler started (runs every hour)");

  // Run initial reconciliation after 5 minutes (let daemon stabilize first)
  setTimeout(async () => {
    try {
      // Log health report
      logHealthReport(retryQueue);

      const result = await performReconciliation(
        syncService,
        (msg, level) => log(msg, level || "info"),
        conversationCache
      );

      if (result.discrepancies.length > 0) {
        logWarn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
        // Auto-repair by resetting positions
        const repaired = await repairDiscrepancies(result.discrepancies, log);
        log(`Reconciliation: Reset ${repaired} sessions for re-sync`);
      }
    } catch (err) {
      logError("Initial reconciliation failed", err instanceof Error ? err : new Error(String(err)));
    }
  }, 5 * 60 * 1000);

  return setInterval(async () => {
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    try {
      // Log health report
      logHealthReport(retryQueue);

      const result = await performReconciliation(
        syncService,
        (msg, level) => log(msg, level || "info"),
        conversationCache
      );

      if (result.discrepancies.length > 0) {
        logWarn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
        const repaired = await repairDiscrepancies(result.discrepancies, log);
        log(`Reconciliation: Reset ${repaired} sessions for re-sync`);
      }
    } catch (err) {
      logError("Reconciliation failed", err instanceof Error ? err : new Error(String(err)));
    }
  }, RECONCILIATION_INTERVAL_MS);
}

// Tier 3 warm pool. Opt-in via config.warm_pool_size (default 0 = off). Re-resumes
// the N most-recently-active sessions whose agent has died, so a follow-up lands on a
// live agent instead of a cold boot. Reuses autoResumeSession in resume-only mode
// (empty content) — and autoResumeSession self-guards against duplicating a live
// agent, so a stale aliveness read here can only cost a cheap no-op, never a double
// spawn. Bounded by cap and a short recency window; runs at the end of the watchdog
// tick, after stale status files are reaped, so just-completed sessions are excluded.
const WARM_POOL_RECENCY_WINDOW_MS = 15 * 60 * 1000;

async function prewarmRecentlyActiveSessions(deps: WatchdogDependencies): Promise<void> {
  const cap = deps.config.warm_pool_size ?? 0;
  if (cap <= 0) return;
  if (!hasTmux()) return;

  const now = Date.now();
  let files: string[];
  try {
    if (!fs.existsSync(AGENT_STATUS_DIR)) return;
    files = fs.readdirSync(AGENT_STATUS_DIR).filter(f => f.endsWith(".json"));
  } catch { return; }

  // Cheap prefilter (status + recency + has conversation) so the expensive aliveness
  // probe runs on a handful of sessions, not all of them.
  const prefiltered: Array<{ sessionId: string; convId: string; status: string; tsMs: number }> = [];
  for (const file of files) {
    const sessionId = file.replace(".json", "");
    try {
      const data = JSON.parse(fs.readFileSync(path.join(AGENT_STATUS_DIR, file), "utf-8")) as HookStatusData;
      if (!data.ts) continue;
      const tsMs = data.ts * 1000;
      if (now - tsMs > WARM_POOL_RECENCY_WINDOW_MS) continue;
      if (!WARM_POOL_ACTIVE_STATUSES.has(data.status)) continue;
      const convId = deps.conversationCache[sessionId];
      if (!convId) continue;
      prefiltered.push({ sessionId, convId, status: data.status, tsMs });
    } catch {}
  }
  if (prefiltered.length === 0) return;

  const candidates: WarmCandidate[] = [];
  for (const p of prefiltered) {
    let agentAlive = false;
    try {
      const live = await resolveLiveTmuxTarget(p.convId, p.sessionId, "claude");
      agentAlive = !!live.tmuxTarget;
    } catch {}
    candidates.push({
      sessionId: p.sessionId,
      status: p.status,
      tsMs: p.tsMs,
      agentAlive,
      circuitOpen: isSessionCircuitOpen(p.sessionId),
      fatal: resumeFatalReasons.has(p.sessionId),
    });
  }

  const toWarm = selectSessionsToWarm(candidates, now, { recencyWindowMs: WARM_POOL_RECENCY_WINDOW_MS, cap });
  const aliveCount = candidates.filter(c => c.agentAlive).length;
  log(`Warm pool: evaluated ${candidates.length} recent active session(s) — ${aliveCount} already warm, ${candidates.length - aliveCount} dead, warming ${toWarm.length} (cap=${cap})`);
  if (toWarm.length === 0) return;
  log(`Warm pool: re-warming session(s) with dead agents: ${toWarm.map(s => s.slice(0, 8)).join(", ")}`);
  for (const sessionId of toWarm) {
    const convId = deps.conversationCache[sessionId];
    try {
      // Empty content = resume-only: spin up the agent, inject nothing.
      const ok = await autoResumeSession(sessionId, "", deps.titleCache, undefined, convId);
      log(`Warm pool: ${ok ? "re-warmed" : "failed to re-warm"} session ${sessionId.slice(0, 8)}`);
    } catch (err) {
      log(`Warm pool: error re-warming ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Decide whether the stale-status watchdog should mark a session "completed".
// The watchdog's job is to catch sessions that ended without a SessionEnd hook,
// using idle time as a proxy for "the agent died". But a live agent simply
// waiting for the user's next prompt is indistinguishable from a dead one by
// time alone — so we ONLY reap when the agent process is genuinely gone. Marking
// a live, idle-waiting session completed flips its conversation to "stopped" in
// the UI and stops the web from streaming the next turn until a manual reload
// (root cause of "tmux messages didn't sync to the web UI" after an idle gap).
// `hasLiveAgentProcess` is a positive signal only; when no process is found we
// fall back to the original time-based behavior (never more aggressive).
export function shouldMarkSessionCompleted(args: {
  status: string | undefined;
  ageMs: number;
  hasLiveAgentProcess: boolean;
  idleStaleMs?: number;
  activeStaleMs?: number;
}): boolean {
  if (args.hasLiveAgentProcess) return false;
  const idleStaleMs = args.idleStaleMs ?? 10 * 60 * 1000;
  const activeStaleMs = args.activeStaleMs ?? 30 * 60 * 1000;
  const threshold =
    args.status === "idle" || args.status === "stopped" ? idleStaleMs : activeStaleMs;
  return args.ageMs >= threshold;
}

function startWatchdog(
  deps: WatchdogDependencies
): NodeJS.Timeout {
  log("Watchdog started");
  let watchdogRunning = false;
  let watchdogStartedAt = 0;
  const WATCHDOG_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes - must complete before next 5-min interval

  return setInterval(async () => {
    if (isInWakeGrace()) return;
    if (watchdogRunning) {
      const elapsed = Date.now() - watchdogStartedAt;
      if (elapsed > WATCHDOG_TIMEOUT_MS) {
        log(`[WARN] Watchdog stalled for ${Math.round(elapsed / 1000)}s, force-resetting`);
        watchdogRunning = false;
      } else {
        return;
      }
    }
    watchdogRunning = true;
    watchdogStartedAt = Date.now();
    try {
    const state = readDaemonState();
    const now = Date.now();

    saveDaemonState({ lastWatchdogCheck: now });

    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      return;
    }

    // Validate process cache
    validateProcessCache();

    // Prune the daemon's internal tracking of started sessions older than
    // STARTED_SESSION_TTL_MS. Two cases:
    //   - tmux has-session fails → the session is genuinely gone, just untrack.
    //   - tmux still exists → stop tracking it but leave the pane alone. The
    //     user may still be using it; "agent process not visible" is the weak
    //     signal we no longer trust as grounds for tearing down a pane.
    for (const [convId, entry] of startedSessionTmux.entries()) {
      if (now - entry.startedAt > STARTED_SESSION_TTL_MS) {
        try {
          await tmuxExec(["has-session", "-t", entry.tmuxSession], { timeout: 3000, killSignal: "SIGKILL" });
          log(`Untracking started session ${entry.tmuxSession} after ${Math.round((now - entry.startedAt) / 3600000)}h (leaving tmux in place)`);
          deleteStartedSession(convId);
        } catch {
          deleteStartedSession(convId);
        }
      }
    }

    // Zombie reaping of untracked cc-resume-*/cc-claude-* tmux sessions has been
    // removed. It used the same weak isTmuxAgentAlive signal that we no longer
    // act on. Orphan accumulation is a manual cleanup — `tmux kill-session` from
    // a shell, or the UI's Kill & restart on a specific conversation.

    // Mark stale agent-status files as completed (session ended without SessionEnd hook)
    try {
      const statusDir = AGENT_STATUS_DIR;
      if (fs.existsSync(statusDir)) {
        const IDLE_STALE_MS = 10 * 60 * 1000;
        const ACTIVE_STALE_MS = 30 * 60 * 1000;
        for (const file of fs.readdirSync(statusDir)) {
          if (!file.endsWith(".json")) continue;
          const sessionId = file.replace(".json", "");
          const filePath = path.join(statusDir, file);
          try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(raw) as HookStatusData;
            if (!data.ts) continue;
            const ageMs = now - data.ts * 1000;
            // Cheap time gate first, so we only pay for a process lookup on
            // sessions that are actually stale by time.
            const threshold = (data.status === "idle" || data.status === "stopped") ? IDLE_STALE_MS : ACTIVE_STALE_MS;
            if (ageMs < threshold) continue;
            const convId = deps.conversationCache[sessionId];
            if (!convId) { try { fs.unlinkSync(filePath); } catch {} continue; }
            // Stale by time — but is the agent actually gone, or just idling for
            // the user? Only reap when no live process remains (see predicate).
            const liveProcess = await findSessionProcess(sessionId, detectSessionAgentType(sessionId)).catch(() => null);
            if (!shouldMarkSessionCompleted({ status: data.status, ageMs, hasLiveAgentProcess: !!liveProcess, idleStaleMs: IDLE_STALE_MS, activeStaleMs: ACTIVE_STALE_MS })) continue;
            log(`Watchdog: stale ${data.status} session ${sessionId.slice(0, 8)} (${Math.round(ageMs / 60000)}min, no live process), marking completed`);
            deps.syncService.markSessionCompleted(convId).catch(logConvexFailure);
            sendAgentStatus(deps.syncService, convId, sessionId, "stopped");
            try { fs.unlinkSync(filePath); } catch {}
          } catch {}
        }
      }
    } catch {}

    // Tier 3 warm pool (opt-in): after stale files are reaped above, re-warm the most
    // recently-active sessions whose agent has died so a follow-up skips the cold boot.
    try { await prewarmRecentlyActiveSessions(deps); } catch (err) {
      log(`Warm pool tick error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Check for watcher staleness -- only restart if idle for 60+ min.
    // Short idle periods are normal (no active sessions, nighttime, etc.)
    const watcherIdleMinutes = Math.floor((now - lastWatcherEventTime) / 60000);
    if (watcherIdleMinutes >= 60) {
      log(`Watcher idle for ${watcherIdleMinutes}min, restarting`);
      // Guard with a timeout. The synchronous form of this call previously
      // deadlocked the event loop indefinitely against bun's File Watcher
      // thread on an os_unfair_lock (see recursiveWatcher.restart()).
      // Promise.race lets the watchdog tick recover even if the deadlock recurs.
      try {
        await Promise.race([
          deps.watcher.restart(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("watcher restart timeout after 10s")), 10_000),
          ),
        ]);
        lastWatcherEventTime = now;
        log(`Watcher restarted successfully`);
      } catch (err) {
        logError("Failed to restart watcher", err instanceof Error ? err : new Error(String(err)));
      }
    }

    const WATCHDOG_CONCURRENCY = 20;
    const WATCHDOG_MAX_STALE_PER_TYPE = 200;

    async function runConcurrent<T>(items: T[], fn: (item: T) => Promise<void>, concurrency: number): Promise<void> {
      let i = 0;
      const next = async (): Promise<void> => {
        while (i < items.length) {
          const idx = i++;
          try {
            await fn(items[idx]);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Watchdog worker failed for item ${JSON.stringify(items[idx])}: ${errMsg}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
    }

    const staleClaudeFiles = findStaleSessionFiles().slice(0, WATCHDOG_MAX_STALE_PER_TYPE);
    const staleCodexFiles = findStaleCodexSessionFiles().slice(0, WATCHDOG_MAX_STALE_PER_TYPE);
    const staleCursorSessions = findStaleCursorSessions().slice(0, WATCHDOG_MAX_STALE_PER_TYPE);
    const staleCursorTranscriptFiles = findStaleCursorTranscriptFiles().slice(0, WATCHDOG_MAX_STALE_PER_TYPE);
    const totalStale =
      staleClaudeFiles.length +
      staleCodexFiles.length +
      staleCursorSessions.length +
      staleCursorTranscriptFiles.length;

    if (totalStale === 0) {
      return;
    }

    log(`Watchdog: Detected ${totalStale} files needing sync (concurrent=${WATCHDOG_CONCURRENCY}, cap=${WATCHDOG_MAX_STALE_PER_TYPE})`);

    const currentRestarts = state?.watchdogRestarts || 0;
    saveDaemonState({ watchdogRestarts: currentRestarts + 1 });

    await runConcurrent(staleClaudeFiles, async (filePath) => {
      const parts = filePath.split(path.sep);
      const sessionId = resolveSessionId(filePath);
      const projectDirName = parts[parts.length - 2];
      const projectPath = resolveTranscriptProjectPath(filePath, projectDirName);

      if (deps.config.excluded_paths && isPathExcluded(projectPath, deps.config.excluded_paths)) {
        return;
      }

      if (!isProjectAllowedToSync(projectPath, deps.config)) {
        return;
      }

      log(`Watchdog: Syncing stale session ${sessionId}`);

      await processSessionFile(
        filePath,
        sessionId,
        projectPath,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.titleCache,
        deps.updateState
      );
    }, WATCHDOG_CONCURRENCY);

    await runConcurrent(staleCodexFiles, async (filePath) => {
      const filename = path.basename(filePath, ".jsonl");
      const match = filename.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      );
      const sessionId = match ? match[1] : filename;

      log(`Watchdog: Syncing stale Codex session ${sessionId}`);

      await processCodexSession(
        filePath,
        sessionId,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.titleCache,
        deps.updateState
      );
    }, WATCHDOG_CONCURRENCY);

    await runConcurrent(staleCursorSessions, async (cursorSession) => {
      if (deps.config.excluded_paths && isPathExcluded(cursorSession.workspacePath, deps.config.excluded_paths)) {
        return;
      }

      if (!isProjectAllowedToSync(cursorSession.workspacePath, deps.config)) {
        return;
      }

      log(`Watchdog: Syncing stale Cursor session ${cursorSession.sessionId}`);

      await processCursorSession(
        cursorSession.dbPath,
        cursorSession.sessionId,
        cursorSession.workspacePath,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.updateState
      );
    }, WATCHDOG_CONCURRENCY);

    await runConcurrent(staleCursorTranscriptFiles, async (filePath) => {
      const sessionId = path.basename(filePath, ".txt");
      const workspacePath = findWorkspacePathForCursorConversation(sessionId);

      if (workspacePath) {
        if (deps.config.excluded_paths && isPathExcluded(workspacePath, deps.config.excluded_paths)) {
          return;
        }

        if (!isProjectAllowedToSync(workspacePath, deps.config)) {
          return;
        }
      } else if (deps.config.sync_mode === "selected") {
        return;
      }

      log(`Watchdog: Syncing stale Cursor transcript ${sessionId}`);

      await processCursorTranscriptFile(
        filePath,
        sessionId,
        deps.syncService,
        deps.config.user_id!,
        deps.config.team_id,
        deps.conversationCache,
        deps.retryQueue,
        deps.pendingMessages,
        deps.updateState
      );
    }, WATCHDOG_CONCURRENCY);

    log(`Watchdog: Sync completed for ${totalStale} files`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
      log(`Watchdog cycle aborted: ${errMsg}${stack}`);
    } finally { watchdogRunning = false; }
  }, WATCHDOG_INTERVAL_MS);
}

async function main(): Promise<void> {
  ensureConfigDir();
  ensureCastAlias();

  if (!acquireLock()) {
    const existingPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    console.error(`Daemon already running (PID: ${existingPid}). Exiting.`);
    process.exit(0);
  }

  // Exit guard: respawn with backoff if crash looping.
  // Skip self-respawn when running under launchd (KeepAlive handles restarts).
  const underLaunchd = isManagedByLaunchd();
  process.on("exit", (code) => {
    persistLogQueue();
    if (skipRespawn || underLaunchd) return;
    if (code !== 0) {
      const { count, backoffMinutes } = recordCrash();
      if (backoffMinutes > 0) {
        try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] CRASH LOOP: ${count} crashes, backing off ${backoffMinutes}min before respawn\n`); } catch {}
        try {
          spawn("sh", ["-c", `sleep ${backoffMinutes * 60} && "${process.execPath}" ${process.argv.slice(1).map(a => `"${a}"`).join(" ")}`], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, CODECAST_RESTART: "1" },
          }).unref();
        } catch {}
        return;
      }
    } else {
      clearCrashCount();
    }
    try {
      spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODECAST_RESTART: "1" },
      }).unref();
    } catch {}
  });

  process.on("uncaughtException", async (err) => {
    logError("Uncaught exception", err);
    persistLogQueue();
    sendLogImmediate("error", `UNCAUGHT EXCEPTION: ${err.message}`, {
      error_code: err.name,
      stack: err.stack?.slice(0, 1000),
    });
    await flushRemoteLogs().catch(() => {});
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError("Unhandled rejection", err);
    await flushRemoteLogs().catch(() => {});
  });

  try {
    daemonVersion = getVersion();
  } catch {
    daemonVersion = "unknown";
  }

  try {
    fs.writeFileSync(VERSION_FILE, daemonVersion, { mode: 0o600 });
  } catch {}

  activeConfig = readConfig();
  loadPersistedLogQueue();

  // Report crash recovery if we had crashes before this successful startup
  let crashRecoveryInfo = "";
  if (fs.existsSync(CRASH_FILE)) {
    try {
      const crashes = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
      if (crashes.count > 0) {
        crashRecoveryInfo = ` (recovered from ${crashes.count} crashes)`;
      }
    } catch {}
  }
  clearCrashCount();

  const isRestart = process.env.CODECAST_RESTART === "1";
  const startMsg = `v${daemonVersion} PID=${process.pid}${isRestart ? " (restart after update)" : ""}${crashRecoveryInfo}`;
  logLifecycle("daemon_start", startMsg);
  sendLogImmediate("info", `[LIFECYCLE] daemon_start: ${startMsg}`, { error_code: "daemon_start" });
  log(`PID: ${process.pid}`);

  if (isSyncPaused()) {
    log("⚠️  Sync is PAUSED via environment variable (CODE_CHAT_SYNC_PAUSED or CODECAST_PAUSED)");
  }

  saveDaemonState({ connected: false, runtimeVersion: getVersion(), lastHeartbeatTick: Date.now() });

  // Guarantee our supervisor exists. If an upgrade/login race left the watchdog
  // booted out, restore it now so the daemon is never left without a backstop.
  ensureWatchdogSupervised(true);

  // Start heartbeat immediately so the daemon doesn't appear "blocked" during slow init
  const eventLoopMonitorInterval = startEventLoopMonitor();

  const { config, convexUrl } = await waitForConfig();
  activeConfig = config;

  log(`User ID: ${config.user_id}`);
  log(`Convex URL: ${convexUrl}`);
  if (config.auth_token) {
    log(`Auth token: ${maskToken(config.auth_token)}`);
  }
  if (config.excluded_paths) {
    log(`Excluded paths: ${config.excluded_paths}`);
  }

  const syncService = new SyncService({
    convexUrl,
    authToken: config.auth_token,
    userId: config.user_id,
  });
  syncServiceRef = syncService;

  // Register this device EARLY + on its own interval, so device presence never
  // depends on the rest of (potentially slow/headless-stalling) init. Logs the
  // first result for diagnosability.
  // Register this device early + on its own interval, so device presence never
  // depends on later (potentially slow) init steps.
  void sendHeartbeat().catch(() => {});
  setInterval(() => { sendHeartbeat().catch(() => {}); }, 30_000);

  // Check for forced updates immediately on startup before anything else
  // This allows recovery from broken versions by downloading a fix early
  try {
    const didUpdate = await checkForForcedUpdate(syncService);
    if (didUpdate) return; // process.exit already called inside
  } catch (err) {
    log(`Startup update check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Repair any project paths that were stored incorrectly (one-time on startup)
  repairProjectPaths(syncService).catch(err => {
    log(`Failed to repair project paths: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Backfill plan_mode plans from JSONL files that the daemon missed (e.g., sessions completed before daemon started)
  backfillPlanModeFromJSONL(syncService).catch(err => {
    log(`Failed to backfill plan_mode from JSONL: ${err instanceof Error ? err.message : String(err)}`);
  });

  setInterval(() => {
    flushRemoteLogs().catch(() => {});
  }, LOG_FLUSH_INTERVAL_MS);

  setInterval(() => {
    logHealthSummary();
    sendHeartbeat().catch(() => {});
    checkDiskVersionMismatch();
    ensureWatchdogSupervised();
  }, HEALTH_REPORT_INTERVAL_MS);

  setInterval(() => {
    pollDaemonCommands().catch(() => {});
  }, 10_000);

  // Auto-dispatch: detect active plans with bound workflows that haven't started
  const notifiedPlanWorkflows = new Set<string>();
  async function checkPlanAutoDispatch() {
    if (!config.auth_token) return;
    const siteUrl = (config.convex_url || "").replace(".cloud", ".site");
    try {
      const resp = await fetch(`${siteUrl}/cli/plans/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: config.auth_token, status: "active" }),
      });
      const data = await resp.json() as any;
      const plans = Array.isArray(data) ? data : (data?.plans || []);
      for (const plan of plans) {
        if (plan.workflow_id && !plan.workflow_run_id && !notifiedPlanWorkflows.has(plan.short_id)) {
          notifiedPlanWorkflows.add(plan.short_id);
          log(`[AUTO-DISPATCH] Plan ${plan.short_id} has workflow ready — start from web UI or: cast workflow run --plan ${plan.short_id}`);
        }
      }
    } catch {}
  }

  setInterval(() => {
    checkPlanAutoDispatch().catch(() => {});
  }, 60_000);

  setInterval(() => {
    collectResourceSnapshot().catch(() => {});
  }, RESOURCE_MONITOR_INTERVAL_MS);

  // Re-establish session→pid liveness mapping (esp. for idle sessions that don't
  // write JSONL) so the Sessions page can tell live-idle from dead. Run once
  // shortly after boot so the page recovers fast post-restart, then on a timer.
  setTimeout(() => { reconcileSessionLiveness().catch(() => {}); }, 10_000);
  setInterval(() => {
    reconcileSessionLiveness().catch(() => {});
  }, LIVENESS_RECONCILE_INTERVAL_MS);

  // Send initial heartbeat
  sendHeartbeat().catch(() => {});

  // Start task scheduler
  const taskScheduler = new TaskScheduler({
    syncService,
    config,
    log,
  });
  taskScheduler.start();

  const conversationCache = readConversationCache();
  conversationCacheRef = conversationCache;
  const titleCache = readTitleCache();
  const pendingMessages: PendingMessages = {};
  const activeSessions = new Map<string, ActiveSession>();

  // Warm restart: rebuild in-memory caches from surviving tmux sessions.
  // After daemon restart, in-memory caches are lost but tmux sessions survive.
  // We handle three shapes:
  //   1. Resume tmuxes tagged with @codecast_session_id → restore resumeSessionCache.
  //   2. Fresh tmuxes tagged with @codecast_conversation_id → restore startedSessionTmux.
  //   3. Untagged legacy tmuxes → register anyway so user sees them in the sessions UI.
  // Every recovered tmux is registered with managed_sessions so the UI lists it.
  if (hasTmux()) {
    try {
      const sessions = tmuxExecSync(["list-sessions", "-F", "#{session_name}"], { timeout: 5000 }).trim().split("\n").filter(Boolean);
      const ccSessions = sessions.filter(s => s.startsWith("cc-") || s.startsWith("cx-") || s.startsWith("gm-") || s.startsWith("ct-"));
      let recovered = 0;
      for (const tmuxSession of ccSessions) {
        try {
          const alive = await isTmuxAgentAlive(tmuxSession);
          if (!alive) continue;

          const sessionId = await getTmuxSessionOption(tmuxSession, "@codecast_session_id");
          const tmuxConvId = await getTmuxSessionOption(tmuxSession, "@codecast_conversation_id");
          const tmuxAgentType = await getTmuxSessionOption(tmuxSession, "@codecast_agent_type");
          const tmuxProjectPath = await getTmuxSessionOption(tmuxSession, "@codecast_project_path");

          if (sessionId) {
            resumeSessionCache.set(sessionId, tmuxSession);
            const convId = tmuxConvId || conversationCache[sessionId];
            if (syncServiceRef) {
              syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, (convId || undefined) as any).catch(logConvexFailure);
              ensureManagedSessionHeartbeat(sessionId);
            }
            recovered++;
            continue;
          }

          if (tmuxConvId) {
            const agentType = (tmuxAgentType as StartedSessionInfo["agentType"] | null) || "claude";
            startedSessionTmux.set(tmuxConvId, {
              tmuxSession,
              projectPath: tmuxProjectPath || process.env.HOME || "/tmp",
              startedAt: Date.now(),
              agentType,
            });
            if (syncServiceRef) {
              syncServiceRef.registerManagedSession(tmuxSession, process.pid, tmuxSession, tmuxConvId as any).catch(logConvexFailure);
              ensureManagedSessionHeartbeat(tmuxSession);
            }
            recovered++;
            continue;
          }

          if (syncServiceRef) {
            syncServiceRef.registerManagedSession(tmuxSession, process.pid, tmuxSession).catch(logConvexFailure);
            ensureManagedSessionHeartbeat(tmuxSession);
            recovered++;
          }
        } catch {}
      }
      if (recovered > 0) {
        log(`[WARM-RESTART] Recovered ${recovered} live session(s) from tmux`);
        // Scan recovered sessions for undetected interactive prompts
        setTimeout(() => {
          const cache = readConversationCache();
          for (const [sid, tmux] of resumeSessionCache) {
            const convId = cache[sid];
            if (convId && !pendingInteractivePrompts.has(sid) && syncServiceRef) {
              checkForInteractivePrompt(tmux + ":0.0", sid, convId, syncServiceRef, 0).catch(() => {});
            }
          }
        }, 10_000);
      }
    } catch (err) {
      log(`[WARM-RESTART] tmux scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sync skills to user profile on startup (global + per-project)
  {
    const globalSkills = readAvailableSkills();
    if (globalSkills.length > 0) {
      const skillsJson = JSON.stringify(globalSkills);
      log(`Startup: syncing ${globalSkills.length} global skills to user profile`);
      syncService.setAvailableSkills(undefined as any, skillsJson).then(() => {
        log(`Startup: user-level skills synced`);
      }).catch(err => log(`Startup skills sync error: ${err}`));
    }
    const globalNames = new Set(globalSkills.map(s => s.name));
    const projectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    const decodeProjectPath = (dirName: string): string | null => {
      const segments = dirName.replace(/^-/, "").split("-");
      let resolved = "";
      let i = 0;
      while (i < segments.length) {
        let candidate = segments[i];
        i++;
        while (true) {
          const testPath = resolved + "/" + candidate;
          if (i >= segments.length) { resolved = testPath; break; }
          try {
            if (fs.statSync(testPath).isDirectory()) { resolved = testPath; break; }
          } catch {}
          candidate += "-" + segments[i];
          i++;
        }
      }
      return fs.existsSync(resolved) ? resolved : null;
    };
    try {
      const entries = fs.readdirSync(projectsDir);
      for (const entry of entries) {
        const projectPath = decodeProjectPath(entry);
        if (!projectPath) continue;
        const hasCommands = fs.existsSync(path.join(projectPath, ".claude", "commands"));
        const hasSkills = fs.existsSync(path.join(projectPath, ".claude", "skills"));
        if (!hasCommands && !hasSkills) continue;
        const allSkills = readAvailableSkills(projectPath);
        const projectOnly = allSkills.filter(s => !globalNames.has(s.name));
        if (projectOnly.length > 0) {
          log(`Startup: syncing ${projectOnly.length} project skills for ${path.basename(projectPath)}`);
          syncService.setAvailableSkills(undefined as any, JSON.stringify(projectOnly), projectPath).catch(logConvexFailure);
        }
      }
    } catch {}
  }

  const retryQueue = new RetryQueue({
    initialDelayMs: 3000,
    maxDelayMs: 60000,
    maxAttempts: 15,
    concurrency: 12,
    persistPath: `${CONFIG_DIR}/retry-queue.json`,
    droppedPath: `${CONFIG_DIR}/dropped-operations.json`,
    onLog: (message, level) => log(message, level || "info"),
  });

  retryQueueRef = retryQueue;

  const updateState = () => {
    saveDaemonState({
      lastSyncTime: Date.now(),
      pendingQueueSize: retryQueue.getLogicalQueueSize(),
    });
  };

  retryQueue.setExecutor(async (op: RetryOperation): Promise<boolean> => {
    if (op.type === "createConversation") {
      const params = op.params as {
        userId: string;
        teamId?: string;
        sessionId: string;
        agentType: "claude_code" | "codex" | "cursor";
        projectPath: string;
        slug?: string;
        startedAt?: number;
        gitInfo?: GitInfo;
      };
      const conversationId = await syncService.createConversation(params);
      conversationCache[params.sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Retry: Created conversation ${conversationId} for session ${params.sessionId}`);

      if (pendingMessages[params.sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[params.sessionId], conversationId, syncService, retryQueue);
        delete pendingMessages[params.sessionId];
      }
      updateState();
      return true;
    }

    if (op.type === "addMessages") {
      const params = op.params as {
        conversationId: string;
        messages: Array<{
          messageUuid?: string;
          role: "human" | "assistant" | "system";
          content: string;
          timestamp: number;
          thinking?: string;
          toolCalls?: any;
          toolResults?: any;
          images?: any;
          subtype?: string;
        }>;
      };
      // Offload any still-inline images to file storage before re-sending, then
      // persist so the queue stops carrying raw base64 across attempts. Images
      // are normally offloaded at enqueue (syncMessagesBatch), but when the
      // upload mutation is failing (e.g. a backend write-path stall) the base64
      // is kept inline and persisted. The first retry after recovery replaces it
      // with a storageId reference once, instead of re-uploading the same bytes
      // (and re-bloating retry-queue.json / dropped-operations.json) every time.
      const hasInlineImage = params.messages.some(
        (m) => Array.isArray(m.images) && m.images.some((i: any) => i?.data && !i?.storageId),
      );
      if (hasInlineImage) {
        await syncService.offloadImages(params.messages as any);
        retryQueue.persistNow();
      }
      await syncService.addMessages({ ...params, reconcileRemoteExisting: true });
      updateState();
      log(`Retry: Batch synced ${params.messages.length} messages for ${params.conversationId.slice(0, 12)}`);
      return true;
    }

    if (op.type === "addMessage") {
      const params = op.params as {
        conversationId: string;
        messageUuid?: string;
        role: "human" | "assistant" | "system";
        content: string;
        timestamp: number;
        thinking?: string;
        toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
        images?: Array<{ mediaType: string; data: string }>;
        subtype?: string;
      };
      await syncService.addMessage(params);
      updateState();
      return true;
    }

    return false;
  });

  retryQueue.start();

  const watcher = new SessionWatcher();
  const fileSyncs = new Map<string, InvalidateSync>();

  watcher.on("ready", () => {
    log("Session watcher ready (depth=2)");
  });

  watcher.on("session", (event: SessionEvent) => {
    selfHealIfTimersStalled("watcher");
    const filePath = event.filePath;
    lastWatcherEventTime = Date.now();

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping session: ${event.sessionId}`);
      return;
    }

    // event.projectPath is the encoded directory name. Resolve the real path —
    // preferring the transcript's recorded cwd over the (lossy, copyable) slug —
    // so sync_mode:"selected" matching and the project label are both correct.
    const projectPath = resolveTranscriptProjectPath(filePath, event.projectPath);

    if (isPathExcluded(projectPath, config.excluded_paths)) {
      log(`Skipping sync for excluded path: ${projectPath}`);
      return;
    }

    if (!isProjectAllowedToSync(projectPath, config)) {
      log(`Skipping sync for non-selected project: ${projectPath}`);
      return;
    }


    let sync = fileSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processSessionFile(
          filePath,
          event.sessionId,
          projectPath,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState
        );
      }, MESSAGE_SYNC_DEBOUNCE);
      fileSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  watcher.on("error", (error: Error) => {
    logError("Watcher error", error);
  });

  watcher.start();

  // Agent status hook file watcher
  fs.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
  const statusWatcher = chokidarWatch(AGENT_STATUS_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    depth: 0,
  });
  statusWatcher.on("add", handleStatusFile).on("change", handleStatusFile);

  // Process existing status files on startup (chokidar ignoreInitial skips them)
  try {
    for (const file of fs.readdirSync(AGENT_STATUS_DIR)) {
      if (file.endsWith(".json")) {
        handleStatusFile(path.join(AGENT_STATUS_DIR, file));
      }
    }
  } catch {}

  function handleStatusData(sessionId: string, data: HookStatusData, filePath?: string) {
    try {
      if (!data.status || !data.ts) return;

      const convId = conversationCache[sessionId];
      if (!convId) return;

      const prev = lastHookStatus.get(sessionId);
      if (prev && prev.ts > data.ts) return;
      if (prev && prev.ts === data.ts && prev.status === data.status) return;

      // In bypassPermissions mode, Claude Code still emits permission_prompt
      // Notification events for tools it auto-approves. Those notifications do
      // not pause the agent — no real block exists. Treating them as
      // permission_blocked spawns a phantom Approve/Deny dialog in the web UI
      // that has no way to resolve, because the agent has already moved on.
      // The Notification event doesn't carry permission_mode, so fall back to
      // the last mode we observed for this session.
      //
      // EXCEPT while an AskUserQuestion block is open (classifyBypassBlock tracks it):
      // those follow-up Notifications are context-free (no tool name) and look identical
      // to a phantom here, but the agent really IS waiting. Suppressing them downgrades
      // the honest "waiting for input" status to "working" and the web falls behind for
      // the whole wait — worst for raw-iTerm sessions, where the question can't be
      // scraped from a pane or read from the buffered JSONL until it's answered.
      const inheritedMode = data.permission_mode || prev?.permission_mode;
      if (classifyBypassBlock(awaitingAskUserQuestion, sessionId, data.status, inheritedMode, data.message).suppress) {
        log(`Suppressing phantom permission_blocked in bypassPermissions mode for session ${sessionId.slice(0, 8)}`);
        data = { ...data, status: "working" };
      }

      // One-shot sweep for sessions in bypass mode. Catches stale records
      // from before the phantom-suppression fix shipped.
      if (inheritedMode === "bypassPermissions" && !bypassPermissionsCleaned.has(sessionId)) {
        bypassPermissionsCleaned.add(sessionId);
        syncService.cancelPendingPermissions(sessionId, Date.now())
          .then((n) => { if (n > 0) log(`Swept ${n} pre-existing pending permission(s) for bypass-mode session ${sessionId.slice(0, 8)}`); })
          .catch((err) => log(`Bypass-mode permission sweep failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      const statusChanged = !prev || prev.status !== data.status;
      const modeChanged = data.permission_mode && (!prev || prev.permission_mode !== data.permission_mode);
      // Notification events don't carry permission_mode; preserve the last
      // observed mode so subsequent bypass-mode suppression stays correct.
      if (!data.permission_mode && prev?.permission_mode) {
        data = { ...data, permission_mode: prev.permission_mode };
      }
      lastHookStatus.set(sessionId, data);

      if (data.status === "compacting" || data.status === "thinking" || data.status === "stopped") {
        const existingTimer = idleTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          idleTimers.delete(sessionId);
        }
      }

      // Post-compaction recovery: track compaction events and detect dropped messages.
      // CC sometimes goes idle after compacting instead of continuing the user's turn.
      if (data.status === "compacting") {
        recentCompactionTs.set(sessionId, Date.now());
      }
      // Cancel pending recovery if session becomes active again
      if (data.status !== "idle" && data.status !== "compacting") {
        const recoveryTimer = postCompactionRecoveryTimers.get(sessionId);
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          postCompactionRecoveryTimers.delete(sessionId);
          log(`Post-compaction recovery cancelled: session ${sessionId.slice(0, 8)} is now ${data.status}`);
        }
      }
      // Detect compaction -> idle pattern: schedule delayed re-injection
      if (data.status === "idle" && statusChanged) {
        const compactedAt = recentCompactionTs.get(sessionId);
        const injection = recentSessionInjections.get(convId);
        if (compactedAt && (Date.now() - compactedAt) < 60_000 &&
            injection && (Date.now() - injection.ts) < 120_000) {
          log(`Post-compaction idle: session ${sessionId.slice(0, 8)} compacted ${Math.round((Date.now() - compactedAt) / 1000)}s ago, scheduling message recovery in 5s`);
          const timerId = setTimeout(() => {
            postCompactionRecoveryTimers.delete(sessionId);
            const currentStatus = lastHookStatus.get(sessionId);
            if (currentStatus?.status !== "idle") {
              log(`Post-compaction recovery skipped: session ${sessionId.slice(0, 8)} is now ${currentStatus?.status}`);
              return;
            }
            log(`Post-compaction recovery: re-queuing message ${injection.messageId.slice(0, 8)} for session ${sessionId.slice(0, 8)}`);
            compactionRedeliveryBypass.add(injection.messageId);
            syncService.retryMessage(injection.messageId).catch(err => {
              log(`Post-compaction retry failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }, 5000);
          postCompactionRecoveryTimers.set(sessionId, timerId);
        }
        recentCompactionTs.delete(sessionId);
        recentSessionInjections.delete(convId);
      }

      if (statusChanged || modeChanged) {
        sendAgentStatus(syncService, convId, sessionId, data.status, data.ts * 1000, data.permission_mode);
        log(`Hook status: ${data.status}${data.permission_mode ? ` mode=${data.permission_mode}` : ''} for session ${sessionId.slice(0, 8)}`);
      }

      if (data.status === "stopped" && statusChanged) {
        const restartTs = restartingSessionIds.get(sessionId);
        if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) {
          log(`Session ended for ${sessionId.slice(0, 8)}, but restart in progress — skipping completion`);
          if (filePath) try { fs.unlinkSync(filePath); } catch {}
        } else {
          log(`Session ended for ${sessionId.slice(0, 8)}, marking completed`);
          syncService.markSessionCompleted(convId).catch(logConvexFailure);
          if (filePath) try { fs.unlinkSync(filePath); } catch {}
        }
      }

      if (data.status === "permission_blocked" && !permissionRecordPending.has(sessionId)) {
        permissionRecordPending.add(sessionId);
        permissionJustResolved.add(sessionId);
        const transcriptPath = data.transcript_path || findTranscriptForSession(sessionId);

        const hookToolName = data.message?.split(/[:\s]/)[0] || null;
        const toolInfo = !hookToolName ? extractPendingToolUseFromTranscript(transcriptPath || "") : null;
        const toolName = hookToolName || toolInfo?.tool_name || extractToolFromMessage(data.message || "");
        const preview = toolInfo?.arguments_preview || data.message || "";

        const SKIP_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
        if (toolName && !SKIP_TOOLS.has(toolName)) {
          log(`Creating permission record: ${toolName} for session ${sessionId.slice(0, 8)}`);
          const permPrompt = { tool_name: toolName, arguments_preview: preview };

          syncService.createSessionNotification({
            conversation_id: convId,
            type: "permission_request",
            title: "codecast - Permission needed",
            message: truncateForNotification(`${toolName}: ${preview}`, 150),
          }).catch(() => {});

          handlePermissionRequest(syncService, convId, sessionId, permPrompt, log)
            .then((decision) => {
              permissionRecordPending.delete(sessionId);
              if (decision) {
                const key = decision.approved ? "Enter" : "Escape";
                log(`Permission ${decision.approved ? "approved" : "denied"} for session ${sessionId.slice(0, 8)}, sending '${key}'`);
                findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
                  if (!proc) { log("No process found for permission injection"); return; }
                  findTmuxPaneForTty(proc.tty).then(async (tmuxTarget) => {
                    try {
                      if (tmuxTarget) {
                        await tmuxExec(["send-keys", "-t", tmuxTarget, key]);
                      } else {
                        await injectViaTerminal(proc.tty, decision.approved ? "\r" : "\x1b", proc.termProgram);
                      }
                      log(`Injected '${key}' for session ${sessionId.slice(0, 8)}`);
                      sendAgentStatus(syncService, convId, sessionId, "working");
                    } catch (err) {
                      log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  });
                }).catch((err) => {
                  log(`Failed to find session process: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            })
            .catch((err) => {
              permissionRecordPending.delete(sessionId);
              log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
            });
        } else {
          log(`Skipped permission record for ${toolName || "unknown"} (SKIP_TOOLS) session ${sessionId.slice(0, 8)}`);
          permissionRecordPending.delete(sessionId);
          if (toolName === "AskUserQuestion") {
            findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then(async (proc) => {
              if (!proc) return;
              const tmuxTarget = await findTmuxPaneForTty(proc.tty) || (resumeSessionCache.get(sessionId) ?? null);
              if (tmuxTarget) {
                checkForInteractivePrompt(tmuxTarget, sessionId, convId, syncService, 3000).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      }

      if (data.status !== "permission_blocked" && prev?.status === "permission_blocked") {
        permissionRecordPending.delete(sessionId);
        // The agent moved past the permission point without the web UI's
        // approval — bypass auto-approved, the user answered in the TUI, or
        // Claude Code emitted a stale permission_prompt for a tool that never
        // actually blocked. Either way, records created up to this transition
        // are stale; pass a cutoff so a freshly created record for the *next*
        // tool can't be racily cancelled by an in-flight mutation.
        const cutoff = Date.now();
        syncService.cancelPendingPermissions(sessionId, cutoff)
          .then((n) => { if (n > 0) log(`Cancelled ${n} stale permission record(s) for session ${sessionId.slice(0, 8)}`); })
          .catch((err) => log(`Failed to cancel pending permissions: ${err instanceof Error ? err.message : String(err)}`));
      }
    } catch {}
  }

  function handleStatusFile(filePath: string) {
    try {
      const basename = path.basename(filePath, ".json");
      if (!basename || !filePath.endsWith(".json")) return;
      const sessionId = basename;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as HookStatusData;
      handleStatusData(sessionId, data, filePath);
    } catch {}
  }

  // HTTP hook server -- instant push path (file watcher above is the fallback)
  hookServer = startHookServer((sessionId, data) => {
    handleStatusData(sessionId, data);
    try {
      fs.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
      // Persist the normalized record (with inherited permission_mode) so a
      // daemon restart can correctly classify cached permission_blocked events
      // from sessions running in bypassPermissions mode.
      const persistData = lastHookStatus.get(sessionId) || data;
      fs.writeFileSync(path.join(AGENT_STATUS_DIR, `${sessionId}.json`), JSON.stringify(persistData));
    } catch {}

    // Piggyback message sync onto hook events — fs.watch can miss events on macOS,
    // so use the reliable hook path to also trigger a transcript re-read.
    const transcriptPath = data.transcript_path || findTranscriptForSession(sessionId);
    if (transcriptPath) {
      const existingSync = fileSyncs.get(transcriptPath);
      if (existingSync) {
        existingSync.invalidate();
      } else {
        // Session file exists but watcher never saw it — bootstrap the sync
        const parts = transcriptPath.split(path.sep);
        const projectDirName = parts[parts.length - 2];
        const projectPath = resolveTranscriptProjectPath(transcriptPath, projectDirName);

        if (isProjectAllowedToSync(projectPath, config) && !isPathExcluded(projectPath, config.excluded_paths)) {
          const sync = new InvalidateSync(async () => {
            await processSessionFile(
              transcriptPath,
              sessionId,
              projectPath,
              syncService,
              config.user_id!,
              config.team_id,
              conversationCache,
              retryQueue,
              pendingMessages,
              titleCache,
              updateState
            );
          }, MESSAGE_SYNC_DEBOUNCE);
          fileSyncs.set(transcriptPath, sync);
          sync.invalidate();
        }
      }
    }
  });

  function extractToolFromMessage(message: string): string {
    const colonMatch = message.match(/^(\w+):\s/);
    if (colonMatch) return colonMatch[1];
    const m = message.match(/permission to use (\w+)/i) || message.match(/allow (\w+)/i);
    return m?.[1] || "Bash";
  }

  function findTranscriptForSession(sessionId: string): string | null {
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    try {
      const dirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of dirs) {
        const jsonlPath = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(jsonlPath)) return jsonlPath;
      }
    } catch {}
    return null;
  }

  // Clean up stale agent-status files every 30 minutes
  const statusCleanupInterval = setInterval(() => {
    try {
      const files = fs.readdirSync(AGENT_STATUS_DIR);
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const file of files) {
        const fp = path.join(AGENT_STATUS_DIR, file);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          const sid = path.basename(file, ".json");
          lastHookStatus.delete(sid);
          bypassPermissionsCleaned.delete(sid);
        }
      }
    } catch {}
  }, 30 * 60 * 1000);

  const CLAUDE_PLANS_DIR = path.join(process.env.HOME || "", ".claude", "plans");
  const planFileSynced = new Map<string, number>();

  function findMostRecentSessionId(): string | null {
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    if (!fs.existsSync(claudeProjectsDir)) return null;
    let best: { sessionId: string; mtime: number } | null = null;
    try {
      for (const dir of fs.readdirSync(claudeProjectsDir)) {
        const dirPath = path.join(claudeProjectsDir, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith(".jsonl") || file.includes("sessions-index")) continue;
          const fp = path.join(dirPath, file);
          const mtime = fs.statSync(fp).mtimeMs;
          if (!best || mtime > best.mtime) {
            best = { sessionId: file.replace(".jsonl", ""), mtime };
          }
        }
      }
    } catch {}
    return best?.sessionId || null;
  }

  function handlePlanFile(filePath: string) {
    if (!filePath.endsWith(".md")) return;
    try {
      const stat = fs.statSync(filePath);
      const lastSynced = planFileSynced.get(filePath);
      if (lastSynced && stat.mtimeMs <= lastSynced) return;

      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) return;

      const sessionId = findMostRecentSessionId();
      if (!sessionId) return;

      planFileSynced.set(filePath, stat.mtimeMs);
      syncService.syncPlanFromPlanMode({
        sessionId,
        planContent: content,
      }).then(planShortId => {
        if (planShortId) {
          planModePlanMap.set(sessionId, planShortId);
          savePlanModeCache();
          log(`Synced plan file ${path.basename(filePath)} -> ${planShortId} for session ${sessionId.slice(0, 8)}`);
        }
      }).catch(err => {
        log(`Failed to sync plan file ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch {}
  }

  if (fs.existsSync(CLAUDE_PLANS_DIR)) {
    const planFileWatcher = chokidarWatch(CLAUDE_PLANS_DIR, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      depth: 0,
    });
    planFileWatcher.on("add", handlePlanFile).on("change", handlePlanFile);
    log(`Plan file watcher started on ${CLAUDE_PLANS_DIR}`);
  }

  // Startup scan: sync any files that were missed while daemon was down
  const performStartupScan = async () => {
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");

    // Safety check: ensure directory exists
    if (!fs.existsSync(claudeProjectsDir)) {
      log("Startup scan: No projects directory found, skipping");
      return;
    }

    let unsyncedFiles: string[] = [];
    try {
      unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);
    } catch (err) {
      logError("Startup scan failed to find unsynced files", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (unsyncedFiles.length > 0) {
      log(`Startup scan: Found ${unsyncedFiles.length} files needing sync`);

      for (const filePath of unsyncedFiles) {
        const parts = filePath.split(path.sep);
        const sessionId = resolveSessionId(filePath);

        const isSubagentFile = parts.includes("subagents");
        let projectDirName: string;
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          projectDirName = parts[subagentsIdx - 2] || parts[parts.length - 2];
        } else {
          projectDirName = parts[parts.length - 2];
        }
        const projectPath = resolveTranscriptProjectPath(filePath, projectDirName);

        if (config.excluded_paths && isPathExcluded(projectPath, config.excluded_paths)) {
          continue;
        }

        if (!isProjectAllowedToSync(projectPath, config)) {
          continue;
        }

        let parentConversationId: string | undefined;
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          const parentSessionId = parts[subagentsIdx - 1];
          if (parentSessionId && conversationCache[parentSessionId]) {
            parentConversationId = conversationCache[parentSessionId];
          }
          try {
            const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
              if (meta.description) subagentDescriptions.set(sessionId, meta.description);
            }
          } catch {}
        }

        log(`Startup scan: Syncing ${sessionId}${parentConversationId ? ` (subagent of ${parentConversationId})` : ""}`);

        await processSessionFile(
          filePath,
          sessionId,
          projectPath,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState,
          parentConversationId,
        );
      }

      // Resolve any remaining pending subagent parents after all files processed
      for (const [childSessionId, parentSessionId] of pendingSubagentParents) {
        const parentConvId = conversationCache[parentSessionId];
        const childConvId = conversationCache[childSessionId];
        if (parentConvId && childConvId) {
          syncService.linkSessions(parentConvId, childConvId, subagentDescriptions.get(childSessionId)).then(() => {
            log(`Startup scan: Linked subagent ${childSessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
          }).catch((err) => {
            log(`Startup scan: Failed to link subagent ${childSessionId.slice(0, 8)}: ${err}`);
          });
          pendingSubagentParents.delete(childSessionId);
        }
      }

      log(`Startup scan: Completed syncing ${unsyncedFiles.length} files`);
    } else {
      log("Startup scan: All files up to date");
    }
  };

  // Run startup scan in background (don't block daemon startup)
  performStartupScan().then(async () => {
    // Backfill: detect unlinked plan handoff children
    const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
    let linked = 0;
    const alreadyLinked = new Set(planHandoffChildren.values());
    for (const [childSessionId, childConvId] of Object.entries(conversationCache)) {
      if (alreadyLinked.has(childConvId)) continue;
      const possiblePaths = [
        path.join(claudeProjectsDir, `-Users-ashot-src-codecast`, `${childSessionId}.jsonl`),
      ];
      // Find the JSONL file across all project dirs
      try {
        const projDirs = fs.readdirSync(claudeProjectsDir);
        for (const dir of projDirs) {
          const fp = path.join(claudeProjectsDir, dir, `${childSessionId}.jsonl`);
          if (fs.existsSync(fp) && !possiblePaths.includes(fp)) {
            possiblePaths.push(fp);
          }
        }
      } catch {}
      for (const fp of possiblePaths) {
        if (!fs.existsSync(fp)) continue;
        try {
          const headContent = readFileHead(fp, 16384);
          const msgs = parseSessionFile(headContent);
          const userMsgs = msgs.filter(m => m.role === "user").slice(0, 3);
          for (const msg of userMsgs) {
            if (!msg.content) continue;
            const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
            if (handoffMatch) {
              const jsonlPath = handoffMatch[1];
              const parentMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
              if (parentMatch) {
                const parentSessionId = parentMatch[1];
                const parentConvId = conversationCache[parentSessionId];
                if (parentConvId && parentConvId !== childConvId) {
                  try {
                    await syncService.linkPlanHandoff(parentConvId, childConvId);
                    planHandoffChildren.set(parentConvId, childConvId);
                    linked++;
                    log(`Backfill: linked plan handoff ${childSessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
                  } catch (err) {
                    log(`Backfill: failed to link ${childSessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
              break;
            }
          }
        } catch {}
        break;
      }
    }
    if (linked > 0) log(`Backfill: linked ${linked} plan handoff session(s)`);
  }).catch(err => {
    logError("Startup scan failed", err instanceof Error ? err : new Error(String(err)));
  });

  const watchdogInterval = startWatchdog({
    config,
    syncService,
    conversationCache,
    retryQueue,
    pendingMessages,
    titleCache,
    updateState,
    watcher,
  });

  const versionCheckInterval = startVersionChecker(syncService);
  const reconciliationInterval = startReconciliation(syncService, retryQueue, conversationCache);

  const cursorWatcher = new CursorWatcher();
  const cursorSyncs = new Map<string, InvalidateSync>();

  cursorWatcher.on("ready", () => {
    log("Cursor watcher ready");
  });

  cursorWatcher.on("session", (event: CursorSessionEvent) => {
    const dbPath = event.dbPath;

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Cursor session: ${event.sessionId}`);
      return;
    }

    if (isPathExcluded(event.workspacePath, config.excluded_paths)) {
      log(`Skipping sync for excluded path: ${event.workspacePath}`);
      return;
    }

    if (!isProjectAllowedToSync(event.workspacePath, config)) {
      log(`Skipping sync for non-selected project: ${event.workspacePath}`);
      return;
    }

    let sync = cursorSyncs.get(dbPath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorSession(
          dbPath,
          event.sessionId,
          event.workspacePath,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          updateState
        );
      }, MESSAGE_SYNC_DEBOUNCE);
      cursorSyncs.set(dbPath, sync);
    }

    sync.invalidate();
  });

  cursorWatcher.on("error", (error: Error) => {
    logError("Cursor watcher error", error);
  });

  cursorWatcher.start();

  const cursorTranscriptWatcher = new CursorTranscriptWatcher();
  const cursorTranscriptSyncs = new Map<string, InvalidateSync>();

  cursorTranscriptWatcher.on("ready", () => {
    log("Cursor transcript watcher ready");
  });

  cursorTranscriptWatcher.on("session", (event: CursorTranscriptEvent) => {
    const filePath = event.filePath;
    lastWatcherEventTime = Date.now();

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Cursor transcript: ${event.sessionId}`);
      return;
    }

    const workspacePath = findWorkspacePathForCursorConversation(event.sessionId);
    if (workspacePath) {
      if (isPathExcluded(workspacePath, config.excluded_paths)) {
        log(`Skipping sync for excluded path: ${workspacePath}`);
        return;
      }

      if (!isProjectAllowedToSync(workspacePath, config)) {
        log(`Skipping sync for non-selected project: ${workspacePath}`);
        return;
      }
    } else if (config.sync_mode === "selected") {
      log(`Skipping Cursor transcript with unknown workspace path: ${event.sessionId}`);
      return;
    }

    let sync = cursorTranscriptSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorTranscriptFile(
          filePath,
          event.sessionId,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          updateState
        );
      }, MESSAGE_SYNC_DEBOUNCE);
      cursorTranscriptSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  cursorTranscriptWatcher.on("error", (error: Error) => {
    logError("Cursor transcript watcher error", error);
  });

  cursorTranscriptWatcher.start();

  codexAppServerInstance = new CodexAppServer({
    log,
    onApproval: async (threadId: string, approval: ApprovalRequest) => {
      const entry = appServerThreads.get(threadId);
      if (!entry) return true;
      if (entry.approvalPolicy === "never") {
        log(`[codex-app-server] auto-approving ${approval.method} for thread ${threadId.slice(0, 8)} (approvalPolicy=never)`);
        return true;
      }
      const permissionPrompt = {
        tool_name: approval.method,
        arguments_preview: JSON.stringify(approval.params).slice(0, 200),
      };
      try {
        const decision = await handlePermissionRequest(syncService, entry.conversationId, threadId, permissionPrompt, log);
        return decision?.approved ?? true;
      } catch (err) {
        log(`[codex-app-server] approval error: ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
    },
  });

  codexAppServerInstance.on("ready", () => {
    if (rehydratePersistedAppServerThreadsPromise) return;
    rehydratePersistedAppServerThreadsPromise = rehydratePersistedAppServerThreads()
      .catch((err) => {
        log(`[codex-app-server] rehydrate failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        rehydratePersistedAppServerThreadsPromise = null;
      });
  });

  codexAppServerInstance.on("exited", () => {
    if (appServerThreads.size > 0 || appServerConversations.size > 0) {
      log(`[codex-app-server] clearing ${appServerThreads.size} live thread registration(s) after exit`);
      // Notify every active conversation that its session has stopped
      // before wiping the maps, so the UI doesn't stay stuck on "working"
      for (const [threadId, entry] of appServerThreads) {
        sendAgentStatus(syncService, entry.conversationId, threadId, "stopped");
        stopManagedSessionHeartbeat(threadId);
      }
    }
    clearLiveAppServerThreadRegistrations();
  });

  codexAppServerInstance.on("turnCompleted", async (threadId: string, turnId: string, messages: any[], status: string) => {
    const entry = appServerThreads.get(threadId);
    try {
      if (!entry) return;
      await syncAppServerTurnMessagesIfChanged(
        turnId,
        entry.conversationId,
        messages as RawMessage[],
        syncService,
        retryQueue,
        threadId.slice(0, 8),
      );
      if (status === "completed") {
        markAppServerConversationResumable(entry.conversationId, threadId);
      }
      sendAgentStatus(syncService, entry.conversationId, threadId, status === "completed" ? "idle" : "working");
    } finally {
      appServerTurnProgress.delete(turnId);
    }
  });

  codexAppServerInstance.on("turnStarted", (threadId: string, turnId: string) => {
    const entry = appServerThreads.get(threadId);
    appServerTurnProgress.set(turnId, { threadId, items: [] });
    if (entry) {
      sendAgentStatus(syncService, entry.conversationId, threadId, "working");
      // Persist early so mid-turn threads survive an app-server crash
      markAppServerConversationResumable(entry.conversationId, threadId);
    }
  });

  codexAppServerInstance.on("itemCompleted", (threadId: string, turnId: string, item: ThreadItem) => {
    const entry = appServerThreads.get(threadId);
    const progress = appServerTurnProgress.get(turnId);
    if (!entry || !progress) return;
    progress.items.push(item);
    const messages = threadItemsToMessages(progress.items) as RawMessage[];
    syncAppServerTurnMessagesIfChanged(
      turnId,
      entry.conversationId,
      messages,
      syncService,
      retryQueue,
      threadId.slice(0, 8),
    ).catch((err) => {
      log(`[codex-app-server] live sync failed for thread ${threadId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  codexAppServerInstance.on("statusChanged", (threadId: string, status: AppServerThreadStatus) => {
    const entry = appServerThreads.get(threadId);
    if (!entry) return;
    const agentStatus = mapCodexAppServerThreadStatusToAgentStatus(status);
    if (!agentStatus) return;
    const activeFlags = status.activeFlags?.length ? ` flags=${status.activeFlags.join(",")}` : "";
    log(`[codex-app-server] thread ${threadId.slice(0, 8)} status=${status.type}${activeFlags} -> ${agentStatus}`);
    sendAgentStatus(syncService, entry.conversationId, threadId, agentStatus);
  });

  codexAppServerInstance.on("threadNameUpdated", async (threadId: string, name: string | null) => {
    if (!name) return;
    const entry = appServerThreads.get(threadId);
    if (!entry) return;
    try {
      await syncService.updateTitle(entry.conversationId, name);
      log(`[codex-app-server] updated title for thread ${threadId.slice(0, 8)}: ${name}`);
    } catch {}
  });

  codexAppServerInstance.on("approvalRequested", (threadId: string, approval: ApprovalRequest) => {
    const entry = appServerThreads.get(threadId);
    if (entry && entry.approvalPolicy !== "never") {
      sendAgentStatus(syncService, entry.conversationId, threadId, "permission_blocked");
      syncService.createSessionNotification({
        conversation_id: entry.conversationId,
        type: "permission_request" as any,
        title: "codecast - Permission needed",
        message: `${approval.method}: ${JSON.stringify(approval.params).slice(0, 200)}`,
      }).catch(() => {});
    }
  });

  codexAppServerInstance.on("error", (err: Error) => {
    log(`[codex-app-server] error: ${err.message}`);
  });

  codexAppServerInstance.on("binaryNotFound", (binary: string) => {
    log(`[codex-app-server] "${binary}" not installed -- codex sessions will return install instructions`);
  });

  try {
    codexAppServerInstance.start();
    log("[codex-app-server] started");
  } catch (err: any) {
    log(`[codex-app-server] failed to start: ${err?.message ?? err} -- codex features disabled`);
  }

  const codexWatcher = new CodexWatcher();
  const codexSyncs = new Map<string, InvalidateSync>();

  codexWatcher.on("ready", () => {
    log("Codex watcher ready");
  });

  codexWatcher.on("session", (event: CodexSessionEvent) => {
    const filePath = event.filePath;

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Codex session: ${event.sessionId}`);
      return;
    }

    let sync = codexSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCodexSession(
          filePath,
          event.sessionId,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState
        );
      }, MESSAGE_SYNC_DEBOUNCE);
      codexSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  codexWatcher.on("error", (error: Error) => {
    logError("Codex watcher error", error);
  });

  codexWatcher.start();

  const geminiWatcher = new GeminiWatcher();
  const geminiSyncs = new Map<string, InvalidateSync>();

  geminiWatcher.on("ready", () => {
    log("Gemini watcher ready");
  });

  geminiWatcher.on("session", (event: GeminiSessionEvent) => {
    const filePath = event.filePath;

    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }

    if (isSyncPaused()) {
      log(`Sync paused, skipping Gemini session: ${event.sessionId}`);
      return;
    }

    let sync = geminiSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processGeminiSession(
          filePath,
          event.sessionId,
          event.projectHash,
          syncService,
          config.user_id!,
          config.team_id,
          conversationCache,
          retryQueue,
          pendingMessages,
          titleCache,
          updateState
        );
      }, MESSAGE_SYNC_DEBOUNCE);
      geminiSyncs.set(filePath, sync);
    }

    sync.invalidate();
  });

  geminiWatcher.on("error", (error: Error) => {
    logError("Gemini watcher error", error);
  });

  geminiWatcher.start();

  const subscriptionClient = syncService.getSubscriptionClient();
  let unsubscribe: (() => void) | null = null;
  let permissionUnsubscribe: (() => void) | null = null;
  let commandUnsubscribe: (() => void) | null = null;
  const processedPermissionIds = new Set<string>();
  const processedCommandIds = new Set<string>();
  const messageRetryTimers = new Set<string>();

  function scheduleMessageRetry(
    messageId: string,
    retryCount: number,
    conversationId: string,
    messageContent: string,
  ) {
    if (messageRetryTimers.has(messageId)) return;
    if (retryCount >= 10) {
      logDelivery(`msg=${messageId.slice(0, 8)} exceeded max retries (10), marking undeliverable`);
      syncService.updateMessageStatus({ messageId, status: "undeliverable" as any }).catch(logConvexFailure);
      return;
    }
    const delays = [1000, 5000, 15000, 30000, 60000];
    const delay = delays[Math.min(retryCount, delays.length - 1)];
    logDelivery(`Scheduling retry ${retryCount + 1}/10 for msg=${messageId.slice(0, 8)} in ${delay / 1000}s`);
    messageRetryTimers.add(messageId);
    setTimeout(async () => {
      messageRetryTimers.delete(messageId);
      try {
        await syncService.retryMessage(messageId);
        logDelivery(`Retry ${retryCount + 1} triggered for msg=${messageId.slice(0, 8)}`);
      } catch (err) {
        logDelivery(`Retry trigger failed for msg=${messageId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay);
  }

  // messagesInFlight / injectedMessageTs are module-scoped so kill_session can wipe a
  // conversation's entries — otherwise a forced restart leaves the local dedup convinced
  // the message just landed even though the tmux it landed in was just killed.
  // Hard ceiling on a single deliverMessage attempt. Worst legitimate path is auto-resume
  // of a large JSONL (~90s poll + tmux startup); 180s leaves margin without leaving the
  // in-flight slot wedged forever if a tmux/Convex call hangs.
  const DELIVERY_TIMEOUT_MS = 180_000;

  const setupSubscription = () => {
    try {
      logDelivery("Setting up pending messages subscription");
      unsubscribe = subscriptionClient.onUpdate(
        "pendingMessages:getPendingMessages" as any,
        { user_id: config.user_id, api_token: config.auth_token },
        async (messages: any) => {
          selfHealIfTimersStalled("convex");
          if (!messages) {
            return;
          }

          if (Array.isArray(messages)) {
            if (messages.length > 0) {
              logDelivery(`Subscription: ${messages.length} pending message(s) received`);
            }
            for (const msg of messages) {
              if ((msg.retry_count ?? 0) >= 12) {
                logDelivery(`msg=${msg._id.slice(0, 8)} retry_count=${msg.retry_count} exceeds cap, marking undeliverable`);
                syncService.updateMessageStatus({ messageId: msg._id, status: "undeliverable" as any }).catch(logConvexFailure);
                continue;
              }
              const inFlight = messagesInFlight.get(msg._id);
              if (inFlight !== undefined) {
                const age = Date.now() - inFlight.ts;
                if (age < IN_FLIGHT_HARD_TTL_MS) {
                  logDelivery(`Skipping msg=${msg._id.slice(0, 8)} - already in flight (age=${Math.round(age / 1000)}s)`);
                  continue;
                }
                logDelivery(`Reclaiming msg=${msg._id.slice(0, 8)} - in-flight ${Math.round(age / 1000)}s exceeds ${IN_FLIGHT_HARD_TTL_MS / 1000}s TTL, retrying`);
                messagesInFlight.delete(msg._id);
              }
              messagesInFlight.set(msg._id, { ts: Date.now(), conversationId: msg.conversation_id });

              // Per-conversation serialization: only one message delivers to a given tmux
              // pane at a time. The subscription fires reactively when the first completes,
              // giving the next message its turn.
              if (conversationDeliveryActive.has(msg.conversation_id)) {
                logDelivery(`Skipping msg=${msg._id.slice(0, 8)} - delivery already active for conv=${msg.conversation_id.slice(0, 12)}`);
                messagesInFlight.delete(msg._id);
                continue;
              }
              conversationDeliveryActive.add(msg.conversation_id);

              const imageIds = msg.image_storage_ids ?? (msg.image_storage_id ? [msg.image_storage_id] : []);
              logDelivery(`Processing: msg=${msg._id.slice(0, 8)} conv=${msg.conversation_id.slice(0, 12)} content="${msg.content.slice(0, 80)}" images=${imageIds.length} retry=${msg.retry_count ?? 0}`);

              let messageContent = msg.content;
              if (imageIds.length > 0) {
                const imagePaths: string[] = [];
                for (const storageId of imageIds) {
                  try {
                    const imagePath = await downloadImage(storageId, syncService);
                    if (imagePath) {
                      imagePaths.push(imagePath);
                      log(`Downloaded image to ${imagePath}`);
                    }
                  } catch (err) {
                    log(`Failed to download image: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                if (imagePaths.length > 0) {
                  const realText = msg.content.replace(/^\[image\]$/i, "").trim();
                  const imageTags = imagePaths.map(p => `[Image ${p}]`).join(" ");
                  messageContent = realText ? `${realText} ${imageTags}` : imageTags;
                }
              }

              syncService.updateSessionAgentStatus(msg.conversation_id, "connected").catch(logConvexFailure);

              // If recently injected to tmux, skip re-delivery (prevents retry race causing duplicates).
              // TTL ensures we allow re-delivery if the agent dropped/crashed after injection.
              // Exception: compaction recovery bypass allows re-delivery of messages dropped during CC compaction.
              const isCompactionRecovery = compactionRedeliveryBypass.delete(msg._id);
              const lastInjected = injectedMessageTs.get(msg._id);
              if (lastInjected && (Date.now() - lastInjected.ts) < INJECTION_DEDUP_TTL_MS && !isCompactionRecovery) {
                logDelivery(`DEDUP: msg=${msg._id.slice(0, 8)} injected ${Math.round((Date.now() - lastInjected.ts) / 1000)}s ago, updating status only`);
                try {
                  await syncService.updateMessageStatus({ messageId: msg._id, status: "injected" });
                } catch {}
                messagesInFlight.delete(msg._id);
                conversationDeliveryActive.delete(msg.conversation_id);
                continue;
              }

              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              try {
                const delivered = await Promise.race([
                  deliverMessage(
                    msg.conversation_id,
                    messageContent,
                    conversationCache,
                    syncService,
                    msg._id,
                    titleCache
                  ),
                  new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(
                      () => reject(new Error(`deliverMessage timed out after ${DELIVERY_TIMEOUT_MS / 1000}s`)),
                      DELIVERY_TIMEOUT_MS,
                    );
                  }),
                ]);
                if (delivered) {
                  logDelivery(`SUCCESS: msg=${msg._id.slice(0, 8)} injected${isCompactionRecovery ? " (compaction recovery)" : ""}`);
                  injectedMessageTs.set(msg._id, { ts: Date.now(), conversationId: msg.conversation_id });
                  // Track for post-compaction recovery: if CC compacts and goes idle,
                  // we can re-inject this message. Skip on recovery re-injections to
                  // prevent infinite compaction->recovery loops.
                  if (!isCompactionRecovery) {
                    recentSessionInjections.set(msg.conversation_id, {
                      messageId: msg._id,
                      content: messageContent,
                      ts: Date.now(),
                    });
                  }
                  // GC: evict expired entries to prevent unbounded growth
                  if (injectedMessageTs.size > 500) {
                    const now = Date.now();
                    for (const [id, entry] of injectedMessageTs) {
                      if (now - entry.ts > INJECTION_DEDUP_TTL_MS) injectedMessageTs.delete(id);
                    }
                  }
                } else {
                  logDelivery(`FAILED: msg=${msg._id.slice(0, 8)} delivery returned false, scheduling retry ${(msg.retry_count ?? 0) + 1}`);
                  scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, messageContent);
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logDelivery(`ERROR: msg=${msg._id.slice(0, 8)} exception: ${errMsg}`);
                scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, msg.content);
              } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                messagesInFlight.delete(msg._id);
                conversationDeliveryActive.delete(msg.conversation_id);
              }
            }
          } else {
            log(`Received non-array: ${typeof messages}`);
          }

          resetReconnectDelay();
        }
      );
      logDelivery("Pending messages subscription established");
      saveDaemonState({ connected: true });
      if (reconnectAttempt > 0) {
        sendLogImmediate("info", `[LIFECYCLE] connection_restored: after ${reconnectAttempt} attempts`, { error_code: "connection_restored" });
      }
      resetReconnectDelay();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Subscription error", error);
      saveDaemonState({ connected: false });
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      const delay = getReconnectDelay();
      logWarn(`Connection lost, reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
      if (reconnectAttempt <= 3 || reconnectAttempt % 10 === 0) {
        sendLogImmediate("warn", `Connection lost, attempt ${reconnectAttempt}: ${error.message}`, {
          error_code: "connection_lost",
          stack: error.stack?.slice(0, 500),
        });
      }
      setTimeout(() => {
        setupSubscription();
      }, delay);
    }
  };

  setupSubscription();

  const setupPermissionSubscription = () => {
    try {
      log("Setting up permission responses subscription");
      permissionUnsubscribe = subscriptionClient.onUpdate(
        "permissions:getAllRespondedPermissions" as any,
        { user_id: config.user_id, api_token: config.auth_token },
        async (permissions: any) => {
          log(`Permission subscription update received: ${JSON.stringify(permissions)?.slice(0, 200)}`);

          if (!permissions || !Array.isArray(permissions)) {
            log("No permissions in update or invalid format");
            return;
          }

          for (const permission of permissions) {
            if (processedPermissionIds.has(permission._id)) {
              continue;
            }

            log(`New permission response: ${permission._id} status=${permission.status} tool=${permission.tool_name}`);

            // "cancelled" means the daemon itself marked the record resolved
            // because the agent moved past the permission point. Injecting
            // Enter/Escape would land in a TUI that no longer has a prompt
            // open and corrupt the next user input.
            if (permission.status === "cancelled") {
              processedPermissionIds.add(permission._id);
              continue;
            }

            try {
              const approved = permission.status === "approved";
              const key = approved ? "Enter" : "Escape";
              const sessionId = permission.session_id;
              let injected = false;

              if (sessionId) {
                const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
                if (proc) {
                  const tmuxTarget = await findTmuxPaneForTty(proc.tty);
                  if (tmuxTarget) {
                    try {
                      await tmuxExec(["send-keys", "-t", tmuxTarget, key]);
                      injected = true;
                    } catch {}
                  }
                  if (!injected) {
                    try {
                      await injectViaTerminal(proc.tty, approved ? "\r" : "\x1b", proc.termProgram);
                      injected = true;
                    } catch {}
                  }
                }
              }

              if (injected) {
                log(`Injected permission '${key}' for session ${sessionId?.slice(0, 8)}`);
              } else {
                // Check if the permission is stale (resolved > 60s ago) — no point retrying
                const resolvedAge = permission.resolved_at ? Date.now() - permission.resolved_at : Infinity;
                if (resolvedAge > 60_000) {
                  log(`Skipping stale permission response for session ${sessionId?.slice(0, 8)} (resolved ${Math.round(resolvedAge / 1000)}s ago)`);
                } else {
                  log(`Failed to inject permission response for session ${sessionId?.slice(0, 8)}, will retry on next update`);
                }
              }
              // Always mark as processed — if the session process is gone, retrying won't help
              processedPermissionIds.add(permission._id);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log(`Error handling permission response: ${errMsg}`);
            }
          }

          resetReconnectDelay();
        }
      );
      log("Permission subscription established successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Permission subscription error", error);
      if (permissionUnsubscribe) {
        permissionUnsubscribe();
        permissionUnsubscribe = null;
      }

      const delay = getReconnectDelay();
      logWarn(`Permission subscription lost, reconnecting in ${delay}ms`);
      setTimeout(() => {
        setupPermissionSubscription();
      }, delay);
    }
  };

  setupPermissionSubscription();

  const setupCommandSubscription = () => {
    try {
      log("Setting up daemon commands subscription");
      commandUnsubscribe = subscriptionClient.onUpdate(
        "users:getMyPendingCommands" as any,
        { api_token: config.auth_token, device_id: deviceId() },
        async (commands: any) => {
          if (!commands || !Array.isArray(commands) || commands.length === 0) {
            return;
          }

          log(`Command subscription update: ${commands.length} pending command(s)`);

          for (const cmd of commands) {
            if (processedCommandIds.has(cmd.id) || processedPollCommandIds.has(cmd.id)) {
              continue;
            }

            processedCommandIds.add(cmd.id);
            processedPollCommandIds.add(cmd.id);
            log(`[SUBSCRIPTION] Executing command: ${cmd.command} (${cmd.id})`);
            await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
          }

          resetReconnectDelay();
        }
      );
      log("Command subscription established successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Command subscription error", error);
      if (commandUnsubscribe) {
        commandUnsubscribe();
        commandUnsubscribe = null;
      }

      const delay = getReconnectDelay();
      logWarn(`Command subscription lost, reconnecting in ${delay}ms`);
      setTimeout(() => {
        setupCommandSubscription();
      }, delay);
    }
  };

  setupCommandSubscription();

  const shutdown = async () => {
    skipRespawn = true;
    log("Shutting down gracefully");

    // Hard exit guarantee: if graceful shutdown takes too long, force exit.
    // This prevents zombie daemons that hold the event loop open via in-flight retries.
    const hardExitTimer = setTimeout(() => {
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [CRITICAL] Hard exit after shutdown timeout\n`); } catch {}
      releasePidFileIfOwned(PID_FILE, process.pid);
      try { fs.unlinkSync(VERSION_FILE); } catch {}
      process.exit(1);
    }, 15_000);
    hardExitTimer.unref();

    saveDaemonState({ connected: false });

    if (unsubscribe) {
      unsubscribe();
    }

    if (permissionUnsubscribe) {
      permissionUnsubscribe();
    }

    if (commandUnsubscribe) {
      commandUnsubscribe();
    }

    clearInterval(watchdogInterval);
    clearInterval(versionCheckInterval);
    clearInterval(reconciliationInterval);
    clearInterval(eventLoopMonitorInterval);
    clearInterval(statusCleanupInterval);
    log("Watchdog and reconciliation stopped");

    stopHookServer();
    statusWatcher.close();
    watcher.stop();
    cursorWatcher.stop();
    cursorTranscriptWatcher.stop();
    codexAppServerInstance?.stop();

    retryQueue.stop();

    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Dropping ${pendingOps} pending retry operations`);
    }

    for (const sync of fileSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorTranscriptSyncs.values()) {
      sync.stop();
    }

    if (releasePidFileIfOwned(PID_FILE, process.pid)) {
      log("PID file removed");
    }
    try { fs.unlinkSync(VERSION_FILE); } catch {}

    logLifecycle("daemon_stop", "graceful shutdown");
    sendLogImmediate("info", "[LIFECYCLE] daemon_stop: graceful shutdown", { error_code: "daemon_stop" });
    await flushRemoteLogs();
    persistLogQueue();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch((err) => {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    shutdown().catch((err) => {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });

  await new Promise(() => {});
}

// Flag to prevent double execution when imported and called via runDaemon
let daemonStarted = false;

export async function runDaemon(): Promise<void> {
  if (daemonStarted) return;
  daemonStarted = true;
  return main();
}

export async function runWatchdog(): Promise<void> {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    process.exit(0);
  }

  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const version = getVersion();
  const logLine = (msg: string) => {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [watchdog] ${msg}\n`); } catch {}
  };

  // 1. Report crash loop info if crash file exists
  if (fs.existsSync(CRASH_FILE)) {
    try {
      const crashes = JSON.parse(fs.readFileSync(CRASH_FILE, "utf-8"));
      if (crashes.count > 3) {
        await fetch(`${siteUrl}/cli/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            level: "error",
            message: `CRASH LOOP: ${crashes.count} crashes since ${new Date(crashes.firstCrash).toISOString()}, watchdog reporting`,
            metadata: { error_code: "crash_loop" },
            cli_version: version,
            platform: process.platform,
          }),
        }).catch(() => {});
      }
    } catch {}
  }

  // 2. Check if daemon is alive (process exists AND event loop is responsive)
  let daemonAlive = false;
  let daemonPid = 0;
  if (fs.existsSync(PID_FILE)) {
    try {
      daemonPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (daemonPid > 0) {
        process.kill(daemonPid, 0);
        daemonAlive = true;
      }
    } catch {
      daemonAlive = false;
    }
  }

  // 2b. If process is alive, check if event loop is actually responsive
  if (daemonAlive && daemonPid > 0) {
    try {
      const state = readDaemonState();
      const lastTick = state.lastHeartbeatTick || state.lastWatchdogCheck || 0;
      const staleness = Date.now() - lastTick;
      if (lastTick > 0 && staleness > HEARTBEAT_STALE_THRESHOLD_MS) {
        logLine(`Daemon PID ${daemonPid} is alive but event loop frozen for ${Math.round(staleness / 1000)}s, killing`);
        try { process.kill(daemonPid, 9); } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
        daemonAlive = false;
      }
    } catch {}
  }

  // 3. Send heartbeat (keeps server aware even if daemon is dead)
  let commands: Array<{ id: string; command: string }> = [];
  let minCliVersion: string | undefined;
  try {
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonAlive ? version : `${version}-watchdog`,
        platform: process.platform,
        pid: 0,
        autostart_enabled: true,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      commands = data.commands || [];
      minCliVersion = data.min_cli_version;
    }
  } catch {}

  // 3b. Check min_cli_version -- if daemon binary is outdated, update it
  // This catches cases where the daemon's own checkForForcedUpdate failed or killed the daemon
  const sendWatchdogLog = async (level: string, message: string) => {
    await fetch(`${siteUrl}/cli/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        level,
        message,
        cli_version: `${version}-watchdog`,
        platform: process.platform,
      }),
    }).catch(() => {});
  };

  if (minCliVersion && compareVersions(version, minCliVersion) < 0) {
    logLine(`Binary outdated: current=${version} min=${minCliVersion}, updating...`);
    await sendWatchdogLog("info", `[LIFECYCLE] watchdog_update_start: current=${version} min=${minCliVersion}`);
    const result = await performUpdate();
    if (result.success) {
      logLine("Watchdog update successful");
      await sendWatchdogLog("info", `[LIFECYCLE] watchdog_update_complete: ${version} -> ${minCliVersion}`);
      clearCrashCount();
      // Kill the running daemon so it restarts with the new binary
      if (daemonAlive && daemonPid > 0) {
        logLine(`Killing outdated daemon PID ${daemonPid}`);
        try { process.kill(daemonPid, 15); } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
        daemonAlive = false;
      }
    } else {
      logLine(`Watchdog update failed: ${result.error}`);
      await sendWatchdogLog("warn", `[LIFECYCLE] watchdog_update_failed: current=${version} target>=${minCliVersion} error=${result.error}`);
    }
  }

  // 3c. If daemon is alive but running an older version than the binary, kill it
  if (daemonAlive && daemonPid > 0) {
    try {
      const state = readDaemonState();
      const daemonVersion = state.runtimeVersion;
      // If runtimeVersion is missing, daemon predates this field -- assume outdated if min_cli_version is set
      const needsKill = daemonVersion
        ? compareVersions(daemonVersion, version) < 0
        : !!(minCliVersion && compareVersions(version, minCliVersion) >= 0);
      if (needsKill) {
        logLine(`Daemon running v${daemonVersion || "unknown"} but binary is v${version}, killing to upgrade`);
        await sendWatchdogLog("info", `[LIFECYCLE] watchdog_version_mismatch: daemon=${daemonVersion || "unknown"} binary=${version}, killing`);
        try { process.kill(daemonPid, 15); } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
        daemonAlive = false;
      }
    } catch {}
  }

  // 4. If daemon is dead, restart it
  if (!daemonAlive) {
    logLine("Daemon not running, restarting...");

    // Handle force_update before restart so daemon starts with new binary
    const updateCmd = commands.find(c => c.command === "force_update");
    if (updateCmd) {
      logLine("Force update pending, updating before restart...");
      const result = await performUpdate();
      // Report result
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: updateCmd.id,
          result: result.success ? "Updated by watchdog" : undefined,
          error: result.success ? undefined : `Watchdog update failed: ${result.error}`,
        }),
      }).catch(() => {});
      if (result.success) {
        logLine("Update successful");
        clearCrashCount();
      }
      commands = commands.filter(c => c.id !== updateCmd.id);
    }

    // Mark remaining commands as executed (daemon will get fresh ones on reconnect)
    for (const cmd of commands) {
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: cmd.id,
          result: `Handled by watchdog (daemon was dead): restarting`,
        }),
      }).catch(() => {});
    }

    // Spawn daemon
    clearCrashCount();
    const { executablePath, args } = getDaemonExecInfo();
    try {
      const child = spawn(executablePath, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODECAST_RESTART: "1" },
      });
      child.unref();
      logLine("Daemon restarted");
    } catch (err) {
      logLine(`Failed to restart daemon: ${err}`);
    }
  } else if (commands.some(c => c.command === "force_update")) {
    // Daemon is alive but has pending force_update -- it should handle it via subscription
    // But if it hasn't within reasonable time, the watchdog can nudge by sending SIGUSR1
    logLine("Daemon alive with pending force_update, daemon should handle via subscription");
  }
}

function getDaemonExecInfo(): { executablePath: string; args: string[] } {
  const execPath = process.execPath;
  const isBinary = !execPath.endsWith("/bun") && !execPath.endsWith("/node") && !execPath.includes("node_modules");
  if (isBinary) {
    return { executablePath: execPath, args: ["--", "_daemon"] };
  }
  return { executablePath: execPath, args: [path.resolve(__dirname, "daemon.js")] };
}

// Only run directly if executed as the main module (not when imported)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js")) {
  daemonStarted = true;
  main().catch((err) => {
    logError("Fatal error", err instanceof Error ? err : new Error(String(err)));
    flushRemoteLogs().finally(() => process.exit(1));
  });
}
