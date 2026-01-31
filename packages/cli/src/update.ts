import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawn } from "child_process";

const VERSION = "1.0.24";
const MEMORY_VERSION = "3";
const LATEST_URL = "https://dl.codecast.sh/latest.json";
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

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

export async function performUpdate(): Promise<boolean> {
  const platformKey = getPlatformKey();

  try {
    const response = await fetch(LATEST_URL);
    if (!response.ok) {
      console.error("Failed to fetch update info");
      return false;
    }

    const latest: LatestInfo = await response.json();
    const binary = latest.binaries[platformKey];

    if (!binary) {
      console.error(`No binary available for platform: ${platformKey}`);
      return false;
    }

    console.log(`Downloading codecast v${latest.version}...`);

    const binaryResponse = await fetch(binary.url);
    if (!binaryResponse.ok) {
      console.error("Failed to download binary");
      return false;
    }

    const binaryData = await binaryResponse.arrayBuffer();

    // Verify checksum
    const hash = await crypto.subtle.digest("SHA-256", binaryData);
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (hashHex !== binary.sha256) {
      console.error("Checksum verification failed");
      return false;
    }

    // Get current executable path
    const currentExe = process.execPath;
    const backupExe = currentExe + ".backup";
    const newExe = currentExe + ".new";

    // Write new binary
    fs.writeFileSync(newExe, Buffer.from(binaryData));
    fs.chmodSync(newExe, 0o755);

    // Backup current and replace
    if (fs.existsSync(backupExe)) {
      fs.unlinkSync(backupExe);
    }
    fs.renameSync(currentExe, backupExe);
    fs.renameSync(newExe, currentExe);

    // Clean up backup
    try {
      fs.unlinkSync(backupExe);
    } catch {}

    // Update state
    const state = readUpdateState();
    state.availableVersion = undefined;
    writeUpdateState(state);

    console.log(`Updated to v${latest.version}`);
    return true;
  } catch (err) {
    console.error("Update failed:", err);
    return false;
  }
}

export function showUpdateNotice(availableVersion: string): void {
  console.log(`\n  Update available: v${VERSION} -> v${availableVersion}`);
  console.log(`  Run 'codecast update' to update\n`);
}
