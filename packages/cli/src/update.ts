import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "./proc.js";
import pkg from "../package.json";

const VERSION = pkg.version;
// Per-snippet version labels. These are NOT the rewrite key: the installer
// decides reinstalls by a content hash of the body it ships (snippetStale /
// stampSnippet, ./snippets.ts), so editing a body needs no bump here. They are
// written alongside the hash as a display value and as a compat shadow — an
// older CLI compares its own constant against the config key, so a downgrade
// still finds the value it expects instead of rewriting on every run. Bump one
// when you want the recorded version to say something meaningful to a human.
const MEMORY_VERSION = "14"; // bumped: --state done / dormant, states answer who acts next
const TASK_VERSION = "5"; // bumped: triggers have short ids (tr-42) + shared "Referencing objects" section
const WORK_VERSION = "8"; // bumped: "Reading tasks" — server-side filters, --json on every read, show takes several ids and lists linked sessions
const PLAN_VERSION = "2";
const WORKFLOW_VERSION = "1";
const MESSAGING_VERSION = "8"; // bumped: cast stash/restore canonical (dismiss/undismiss legacy); stash silent-except-asks contract
const VISUAL_VERSION = "6"; // bumped: image captions from alt text + side-by-side rows for adjacent images
const FORKS_VERSION = "5"; // bumped: cast spawn --subagent — nested subagent row the parent session manages, on any agent backend
const PUBLISH_VERSION = "4"; // bumped: cast image cross-reference for single-image sharing; never link local paths
const BROWSER_VERSION = "7"; // bumped: batching by default — cast browser do is the loop, not a footnote
const CHAT_VERSION = "1"; // first release: channels, threads, search, anchor replies
const DECIDE_VERSION = "2"; // v2: age + messages-since on ls, stale-ask sweeping guidance
const CALLS_VERSION = "1"; // first release: cast calls / cast call (transcripts, summaries)
const LIMITS_VERSION = "1"; // first release: usage limits are a pause, not a stop; cast usage
const STATE_VERSION = "6"; // bumped: blocked declaration resurfaces a stashed session (the attention claim)
const LATEST_URL = "https://dl.codecast.sh/latest.json";
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const UPDATE_RETRY_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

interface LatestInfo {
  version: string;
  released: string;
  binaries: {
    [key: string]: {
      url: string;
      sha256: string;
    };
  };
}

interface UpdateState {
  lastCheck?: string;
  availableVersion?: string;
  dismissed?: string;
  failedVersion?: string;
  failedAt?: string;
}

const CONFIG_DIR = process.env.HOME + "/.codecast";
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, "update-state.json");

function getPlatformKey(): string {
  const platform = os.platform();
  const arch = os.arch();

  const platformMap: { [key: string]: string } = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };

  const archMap: { [key: string]: string } = {
    arm64: "arm64",
    x64: "x64",
    x86_64: "x64",
  };

  const p = platformMap[platform] || platform;
  const a = archMap[arch] || arch;

  return `${p}-${a}`;
}

function readUpdateState(): UpdateState {
  try {
    if (fs.existsSync(UPDATE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(UPDATE_STATE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function writeUpdateState(state: UpdateState): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
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

export function getVersion(): string {
  return VERSION;
}

export function getMemoryVersion(): string {
  return MEMORY_VERSION;
}

export function getTaskVersion(): string {
  return TASK_VERSION;
}

export function getWorkVersion(): string {
  return WORK_VERSION;
}

export function getPlanVersion(): string {
  return PLAN_VERSION;
}

export function getWorkflowVersion(): string {
  return WORKFLOW_VERSION;
}

export function getMessagingVersion(): string {
  return MESSAGING_VERSION;
}

export function getVisualVersion(): string {
  return VISUAL_VERSION;
}

export function getForksVersion(): string {
  return FORKS_VERSION;
}

export function getStateVersion(): string {
  return STATE_VERSION;
}

export function getPublishVersion(): string {
  return PUBLISH_VERSION;
}

export function getBrowserVersion(): string {
  return BROWSER_VERSION;
}

export function getChatVersion(): string {
  return CHAT_VERSION;
}

export function getDecideVersion(): string {
  return DECIDE_VERSION;
}

export function getCallsVersion(): string {
  return CALLS_VERSION;
}

export function getLimitsVersion(): string {
  return LIMITS_VERSION;
}

export async function checkForUpdates(force = false): Promise<string | null> {
  const state = readUpdateState();
  const now = Date.now();

  // Skip if checked recently (unless forced)
  if (!force && state.lastCheck) {
    const lastCheck = new Date(state.lastCheck).getTime();
    if (now - lastCheck < UPDATE_CHECK_INTERVAL) {
      // Return cached available version if any
      if (state.availableVersion && compareVersions(state.availableVersion, VERSION) > 0) {
        return state.availableVersion;
      }
      return null;
    }
  }

  try {
    const response = await fetch(LATEST_URL);
    if (!response.ok) return null;

    const latest: LatestInfo = await response.json();

    state.lastCheck = new Date().toISOString();

    if (compareVersions(latest.version, VERSION) > 0) {
      state.availableVersion = latest.version;
      writeUpdateState(state);
      return latest.version;
    }

    state.availableVersion = undefined;
    writeUpdateState(state);
    return null;
  } catch {
    return null;
  }
}

export function isDevMode(): boolean {
  const exe = process.execPath.toLowerCase();
  return exe.includes("bun") || (!exe.includes("codecast") && !exe.includes("/cast"));
}

export function updateRecentlyFailed(version: string): boolean {
  const state = readUpdateState();
  if (state.failedVersion !== version || !state.failedAt) return false;
  return Date.now() - new Date(state.failedAt).getTime() < UPDATE_RETRY_INTERVAL;
}

export function recordUpdateFailure(version: string): void {
  const state = readUpdateState();
  state.failedVersion = version;
  state.failedAt = new Date().toISOString();
  writeUpdateState(state);
}

export async function performUpdate(): Promise<{ success: boolean; error?: string }> {
  if (isDevMode()) {
    return { success: false, error: "dev_mode" };
  }

  const platformKey = getPlatformKey();
  const currentExe = process.execPath;
  const newExe = currentExe + ".new";
  const backupExe = currentExe + ".backup";

  try {
    // Fetch metadata (small JSON — fine via fetch)
    const response = await fetch(LATEST_URL);
    if (!response.ok) {
      return { success: false, error: `fetch_latest_${response.status}` };
    }

    const latest: LatestInfo = await response.json();
    const binary = latest.binaries[platformKey];

    if (!binary) {
      return { success: false, error: `no_binary_${platformKey}` };
    }

    console.log(`Downloading cast v${latest.version}...`);

    // Download binary via curl (streams to disk, works under launchd)
    try { fs.unlinkSync(newExe); } catch {}
    execSync(`curl -fsSL "${binary.url}" -o "${newExe}"`, { timeout: 180000, stdio: "ignore" });

    // Verify checksum
    const downloaded = fs.readFileSync(newExe);
    const hash = await crypto.subtle.digest("SHA-256", downloaded.buffer);
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (hashHex !== binary.sha256) {
      try { fs.unlinkSync(newExe); } catch {}
      return { success: false, error: `checksum_mismatch_${platformKey}` };
    }

    // Replace binary
    fs.chmodSync(newExe, 0o755);
    if (fs.existsSync(backupExe)) fs.unlinkSync(backupExe);
    fs.renameSync(currentExe, backupExe);
    fs.renameSync(newExe, currentExe);
    try { fs.unlinkSync(backupExe); } catch {}

    // Update state
    const state = readUpdateState();
    state.availableVersion = undefined;
    state.failedVersion = undefined;
    state.failedAt = undefined;
    writeUpdateState(state);

    console.log(`Updated to v${latest.version}`);
    ensureCastAlias();
    return { success: true };
  } catch (err) {
    try { fs.unlinkSync(newExe); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Update failed:", msg);
    return { success: false, error: msg };
  }
}

export function ensureCastAlias(): void {
  if (isDevMode()) return;
  const exe = process.execPath;
  const dir = path.dirname(exe);
  const castLink = path.join(dir, "cast");
  try {
    const target = fs.readlinkSync(castLink);
    if (target === exe) return;
    fs.unlinkSync(castLink);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      // no symlink yet, create below
    } else {
      // not a symlink (regular file) or other error — don't clobber
      return;
    }
  }
  try {
    fs.symlinkSync(exe, castLink);
  } catch {}
}

export function showUpdateNotice(availableVersion: string): void {
  console.log(`\n  Update available: v${VERSION} -> v${availableVersion}`);
  console.log(`  Run 'cast update' to update\n`);
}
