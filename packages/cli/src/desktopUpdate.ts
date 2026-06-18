// Daemon-driven updater for the Codecast desktop (Electron) app.
//
// Why this exists: on macOS 26 (Darwin 25.x) Electron's Squirrel.Mac registers
// its ShipIt install helper as a launchd job but launchd never runs it, so the
// in-app "Restart to update" quits the app and nothing ever swaps the bundle
// (see daemon/desktop note + ct-32425). The daemon, by contrast, updates itself
// over a plain R2 + curl channel that has nothing to do with Squirrel. So we let
// the daemon finish the desktop update out-of-band: read electron-builder's
// published feed, verify the artifact is authentically signed by us, and swap
// /Applications/Codecast.app atomically. This rescues already-wedged clients,
// since the fix ships through the (working) CLI auto-update channel.

import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { isDevMode } from "./update.js";

const DESKTOP_FEED = "https://dl.codecast.sh/desktop/latest-mac.yml";
const DESKTOP_BASE = "https://dl.codecast.sh/desktop";
const APP_PATH = "/Applications/Codecast.app";
const APP_PLIST = path.join(APP_PATH, "Contents", "Info.plist");
// Our Apple Developer Team ID. The swapped bundle MUST be signed by this team,
// otherwise we refuse to install it (this replaces an app in /Applications from
// a downloaded artifact, so signer authenticity is mandatory).
const EXPECTED_TEAM_ID = "WRG9THCK9Q";

const CONFIG_DIR = path.join(process.env.HOME || "", ".codecast");
const STATE_FILE = path.join(CONFIG_DIR, "desktop-update-state.json");
const WORK_DIR = path.join(process.env.HOME || "", "Library", "Caches", "codecast-desktop-update");
const SHIPIT_CACHE = path.join(process.env.HOME || "", "Library", "Caches", "sh.codecast.desktop.ShipIt");

// Don't re-download the (~95MB) artifact for the same target version more often
// than this when an attempt fails; a successful apply no-ops via version compare.
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

type Logger = (msg: string) => void;

interface DesktopUpdateState {
  appliedVersion?: string;
  lastAttemptVersion?: string;
  lastAttemptAt?: number;
}

function readState(): DesktopUpdateState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state: DesktopUpdateState): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

// Semver-ish numeric compare (matches daemon.compareVersions).
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Whether to apply the update even while the app is running (quit + swap +
// relaunch) instead of deferring. A manual `--force` always does; otherwise only
// when the installed app is below the server-pinned floor (min_desktop_version)
// — the lever that drags always-open clients forward. Pure so it can be tested
// without the surrounding fs/network side effects.
export function shouldApplyWhileRunning(
  installed: string,
  opts: { force?: boolean; minVersion?: string | null },
): boolean {
  if (opts.force === true) return true;
  return !!opts.minVersion && compareVersions(installed, opts.minVersion) < 0;
}

function plistVersion(plistPath: string): string | null {
  try {
    const out = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", plistPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

// Matches ONLY the app's main process (helpers live under Frameworks/… and
// don't contain this substring; killing main tears them down anyway).
const APP_PROC_PATTERN = "Codecast.app/Contents/MacOS/Codecast";

function isDesktopAppRunning(): boolean {
  try {
    execFileSync("/usr/bin/pgrep", ["-f", APP_PROC_PATTERN], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true; // exit 0 => at least one match
  } catch {
    return false; // exit 1 => no match
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll up to `tries` × 500ms for the app process to disappear.
async function waitForExit(tries: number): Promise<boolean> {
  for (let i = 0; i < tries && isDesktopAppRunning(); i++) await sleep(500);
  return !isDesktopAppRunning();
}

function signalApp(extraArgs: string[]): void {
  try {
    execFileSync("/usr/bin/pkill", [...extraArgs, "-f", APP_PROC_PATTERN], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {}
}

// Ensure the app isn't running before we swap its bundle. Unforced, we just
// defer (return false) so we never disrupt an in-use app. Forced, we MUST stop
// it — and a graceful `quit` can't be trusted: the app keeps itself alive in the
// dock/tray and silently swallows the quit Apple event (verified on macOS 26),
// so an osascript-only quit left always-open clients stranded forever. Escalate
// quit → SIGTERM → SIGKILL so the forced/min-version rollout can't stall.
async function ensureAppNotRunning(force: boolean, log: Logger): Promise<boolean> {
  if (!isDesktopAppRunning()) return true;
  if (!force) return false;

  log("desktop update: quitting running app to apply (forced)");
  try {
    execFileSync("/usr/bin/osascript", ["-e", 'tell application "Codecast" to quit'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {}
  if (await waitForExit(8)) return true; // graceful, ~4s

  log("desktop update: app ignored quit; sending SIGTERM");
  signalApp([]);
  if (await waitForExit(8)) return true; // ~4s

  log("desktop update: app still running; sending SIGKILL");
  signalApp(["-9"]);
  return await waitForExit(8); // ~4s
}

// Parse only the fields we need from latest-mac.yml (avoids a YAML dependency).
function parseFeed(text: string): { version?: string; zip?: string; sha512?: string } {
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  let zip: string | undefined;
  let sha512: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/url:\s*(\S+-mac\.zip)\s*$/);
    if (m) {
      zip = m[1].trim();
      const sm = lines[i + 1]?.match(/sha512:\s*(\S+)\s*$/);
      if (sm) sha512 = sm[1].trim();
      break;
    }
  }
  return { version, zip, sha512 };
}

async function sha512Base64(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const digest = await crypto.subtle.digest("SHA-512", buf);
  return Buffer.from(digest).toString("base64");
}

// Verify the extracted bundle is a valid, untampered signature from our team.
function verifyBundleSignature(appPath: string, log: Logger): boolean {
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", appPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    log("desktop update: codesign --verify failed; refusing to install");
    return false;
  }
  // `codesign -dvv` writes its details (Authority, TeamIdentifier) to stderr,
  // so use spawnSync and read both streams.
  const r = spawnSync("/usr/bin/codesign", ["-dvv", appPath], { encoding: "utf8" });
  const info = `${r.stdout || ""}${r.stderr || ""}`;
  if (!info.includes(`TeamIdentifier=${EXPECTED_TEAM_ID}`)) {
    log("desktop update: unexpected TeamIdentifier; refusing to install");
    return false;
  }
  return true;
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

/**
 * Check the published desktop feed and, if a newer version is available and the
 * app is not currently running, download + verify + atomically swap it in.
 * Fire-and-forget: never throws (failures are logged and retried later).
 * Returns true if an update was applied.
 */
export async function checkForDesktopUpdate(
  log: Logger,
  opts: { force?: boolean; minVersion?: string | null } = {},
): Promise<boolean> {
  const force = opts.force === true;
  // Only meaningful for a packaged daemon on macOS with the app installed.
  if (process.platform !== "darwin" || isDevMode()) return false;
  if (!fs.existsSync(APP_PATH)) {
    if (force) log("desktop update: /Applications/Codecast.app not found");
    return false;
  }

  try {
    const installed = plistVersion(APP_PLIST);
    if (!installed) return false;

    // Server-pinned floor: when the installed app is below min_desktop_version,
    // apply even while the app is running (quit + swap + relaunch) so an
    // always-open client converges — the routine path only swaps when closed.
    // A manual `--force` does the same. Unlike `--force`, the min-version path
    // still respects the per-version retry throttle, so a persistently failing
    // apply can't quit-and-relaunch the app every cycle.
    const applyWhileRunning = shouldApplyWhileRunning(installed, opts);

    const res = await fetch(DESKTOP_FEED);
    if (!res.ok) return false;
    const { version, zip, sha512 } = parseFeed(await res.text());
    if (!version || !zip || !sha512) {
      log("desktop update: could not parse latest-mac.yml");
      return false;
    }

    if (compareVersions(version, installed) <= 0) {
      // Already current — clear any stale per-version attempt bookkeeping.
      const st = readState();
      if (st.appliedVersion !== installed) writeState({ ...st, appliedVersion: installed });
      if (force) {
        log(`desktop update: already on v${installed} (forcing reinstall of v${version})`);
      } else {
        return false;
      }
    }

    // Routine path: defer early on an in-use app — the swap lands next time it's
    // closed, and there's no point downloading ~95MB to throw away. The forced /
    // below-floor path does NOT stop the app here; it downloads and verifies the
    // new bundle FIRST, then stops + swaps just-in-time (below). Stopping only
    // once a good bundle is in hand means a failed download can never leave the
    // user with no app (and then get throttled out of retrying for hours).
    if (!applyWhileRunning && isDesktopAppRunning()) {
      log(`desktop update: v${version} available (installed v${installed}); deferring — app is running`);
      return false;
    }

    // Throttle repeated failures for the same target version (skip when forced).
    const state = readState();
    if (
      !force &&
      state.lastAttemptVersion === version &&
      state.lastAttemptAt &&
      Date.now() - state.lastAttemptAt < RETRY_INTERVAL_MS
    ) {
      return false;
    }
    writeState({ ...state, lastAttemptVersion: version, lastAttemptAt: Date.now() });

    log(`desktop update: installing v${version} (from v${installed})`);
    rmrf(WORK_DIR);
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const zipPath = path.join(WORK_DIR, zip);
    const zipUrl = `${DESKTOP_BASE}/${zip}`;

    // curl streams to disk and works reliably under launchd.
    execFileSync("/usr/bin/curl", ["-fsSL", zipUrl, "-o", zipPath], {
      timeout: 600000,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const got = await sha512Base64(zipPath);
    if (got !== sha512) {
      log("desktop update: sha512 mismatch; aborting");
      rmrf(WORK_DIR);
      return false;
    }

    // Extract the .app from the zip.
    const extractDir = path.join(WORK_DIR, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const newApp = path.join(extractDir, "Codecast.app");
    if (!fs.existsSync(newApp)) {
      log("desktop update: Codecast.app not found in archive; aborting");
      rmrf(WORK_DIR);
      return false;
    }

    const newVersion = plistVersion(path.join(newApp, "Contents", "Info.plist"));
    if (newVersion !== version) {
      log(`desktop update: archive version ${newVersion} != feed ${version}; aborting`);
      rmrf(WORK_DIR);
      return false;
    }
    if (!verifyBundleSignature(newApp, log)) {
      rmrf(WORK_DIR);
      return false;
    }

    // Bundle is downloaded + verified — only NOW stop the app and swap just in
    // time. Forced/below-floor: graceful quit → SIGTERM → SIGKILL. Routine: this
    // bails if the app launched mid-download (we'll swap on a later closed check).
    if (!(await ensureAppNotRunning(applyWhileRunning, log))) {
      log("desktop update: could not stop the app; deferring swap");
      rmrf(WORK_DIR);
      return false;
    }

    // Atomic swap on the /Applications volume: stage a sibling, then rename.
    const incoming = "/Applications/.Codecast.app.incoming";
    const old = "/Applications/.Codecast.app.old";
    rmrf(incoming);
    rmrf(old);
    execFileSync("/usr/bin/ditto", [newApp, incoming], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      fs.renameSync(APP_PATH, old); // atomic
      fs.renameSync(incoming, APP_PATH); // atomic
    } catch (e) {
      // Roll back if the second rename failed and we moved the old one away.
      if (!fs.existsSync(APP_PATH) && fs.existsSync(old)) {
        try { fs.renameSync(old, APP_PATH); } catch {}
      }
      rmrf(incoming);
      log(`desktop update: swap failed: ${e instanceof Error ? e.message : String(e)}`);
      rmrf(WORK_DIR);
      return false;
    }
    rmrf(old);
    rmrf(WORK_DIR);

    // Defensive: clear quarantine so Gatekeeper doesn't block relaunch, and drop
    // any stale Squirrel staged update so autoInstallOnAppQuit can't revert us.
    try {
      execFileSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", APP_PATH], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {}
    try {
      rmrf(path.join(SHIPIT_CACHE, "ShipItState.plist"));
      for (const entry of fs.readdirSync(SHIPIT_CACHE)) {
        if (entry.startsWith("update.")) rmrf(path.join(SHIPIT_CACHE, entry));
      }
    } catch {}

    writeState({ appliedVersion: version });
    log(`desktop update: installed v${version}; relaunching`);

    // Relaunch. When the user explicitly asked for this (force — the in-app
    // "Update now" command or `cast desktop-update --force`), bring the app to
    // the FOREGROUND so the update doesn't look like it silently died: the
    // foreground app vanished (we killed it) and a background `open -g` relaunch
    // left nothing visible, which read as a hang. The silent below-floor rollout
    // (minVersion, no force) still uses -g so it never steals focus uninvited.
    try {
      const openArgs = force ? [APP_PATH] : ["-g", APP_PATH];
      execFileSync("/usr/bin/open", openArgs, { stdio: ["ignore", "ignore", "ignore"] });
    } catch {}
    return true;
  } catch (e) {
    log(`desktop update: ${e instanceof Error ? e.message : String(e)}`);
    rmrf(WORK_DIR);
    return false;
  }
}
