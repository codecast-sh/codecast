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
import { compareVersions, isBelowMinimum } from "@platform/cli-kit/update";
import { defaultConfigDir } from "./config/configDir.js";
import { execFileAsync, execFileSync, spawnSync } from "./proc.js";
import { isDevMode } from "./update.js";
import { codecastDir } from "./codecastDir.js";

const DESKTOP_FEED = "https://dl.codecast.sh/desktop/latest-mac.yml";
const DESKTOP_BASE = "https://dl.codecast.sh/desktop";
const APP_PATH = "/Applications/Codecast.app";
const APP_PLIST = path.join(APP_PATH, "Contents", "Info.plist");
// Our Apple Developer Team ID. The swapped bundle MUST be signed by this team,
// otherwise we refuse to install it (this replaces an app in /Applications from
// a downloaded artifact, so signer authenticity is mandatory).
const EXPECTED_TEAM_ID = "WRG9THCK9Q";

const CONFIG_DIR = defaultConfigDir();
const STATE_FILE = path.join(CONFIG_DIR, "desktop-update-state.json");
const WORK_DIR = path.join(process.env.HOME || "", "Library", "Caches", "codecast-desktop-update");
const SHIPIT_CACHE = path.join(process.env.HOME || "", "Library", "Caches", "sh.codecast.desktop.ShipIt");

// Don't re-download the (~95MB) artifact for the same target version more often
// than this when an attempt fails; a successful apply no-ops via version compare.
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
// An attempt made by another process may never have failed: the watchdog
// replaces a daemon it thinks is hung, and an install killed that way logs
// nothing. It waits this long instead of the full throttle.
const INTERRUPTED_RETRY_MS = 15 * 60 * 1000;

type Logger = (msg: string) => void;

interface DesktopUpdateState {
  appliedVersion?: string;
  lastAttemptVersion?: string;
  lastAttemptAt?: number;
  /** The daemon process that made the attempt (see INTERRUPTED_RETRY_MS). */
  lastAttemptPid?: number;
  /** Inode of the installed bundle that last passed codesign (installedBundleIntact). */
  intactIno?: number;
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

// Whether to apply the update even while the app is running (quit + swap +
// relaunch) instead of deferring. A manual `--force` always does; otherwise only
// when the installed app is below the server-pinned floor (min_desktop_version)
// — the lever that drags always-open clients forward. Pure so it can be tested
// without the surrounding fs/network side effects.
// Whether checkForDesktopUpdate should run at all. macOS-only; a developer's
// source checkout (cast/daemon under `bun src/…` → isDevMode) is skipped for
// AUTOMATIC checks so it never swaps the installed app behind the dev's back —
// but an explicit `force` (the in-app "Update now" button or
// `cast desktop-update --force`) is a deliberate human action and must run even
// from a dev environment. Without the force bypass a dev-mode machine can never
// update through any path: every caller bailed here, leaving the in-app banner
// stuck on "Updating…" forever. Pure so it can be tested without side effects.
export function shouldAttemptDesktopUpdate(
  platform: NodeJS.Platform,
  isDev: boolean,
  force: boolean,
): boolean {
  if (platform !== "darwin") return false;
  if (isDev && !force) return false;
  return true;
}

export function shouldApplyWhileRunning(
  installed: string,
  opts: { force?: boolean; minVersion?: string | null },
): boolean {
  if (opts.force === true) return true;
  return isBelowMinimum(installed, opts.minVersion);
}

// Whether a forced run should reinstall an app that is ALREADY at the feed
// version. `cast desktop-update --force` means "put a fresh copy down" and
// reinstalls. The web's below-floor gate sends the same forced command to every
// daemon of the user (it cannot name the machine it runs on: the shell bridge
// is exactly what is dead on the builds it rescues), so a second Mac that is
// already current must not have its app quit and rewritten for nothing.
export function wantsReinstall(opts: { force?: boolean; reinstall?: boolean }): boolean {
  return opts.force === true && opts.reinstall !== false;
}

export interface DesktopUpdateOpts {
  force?: boolean;
  minVersion?: string | null;
  reinstall?: boolean;
  // Install the app when /Applications has none. Only `cast desktop-update`,
  // run by a person on this Mac, sets it: a floor or a remote command must
  // never put the app on a machine that does not have it.
  install?: boolean;
  // Where a bail-out goes when the run MATTERED: a forced request, or an app
  // below the floor. The daemon uploads only warn and error lines, so a
  // routine "deferring, app is running" stays local while "below the floor but
  // the daemon runs from a source checkout" reaches the server.
  warn?: Logger;
}

function plistValue(plistPath: string, key: string): string | null {
  try {
    const out = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plistPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

function plistVersion(plistPath: string): string | null {
  return plistValue(plistPath, "CFBundleShortVersionString");
}

function macosVersion(): string | null {
  try {
    return execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether this Mac can launch a bundle that declares `minimum` as its
 * LSMinimumSystemVersion. The swap replaces the working app, so installing a
 * build the system refuses to open leaves the person with no app at all: the
 * Electron 44 shell needs macOS 13, and a Mac on 12 must keep the build it has.
 * Unknown on either side installs, as every earlier release did.
 */
export function macosMeetsMinimum(current: string | null, minimum: string | null): boolean {
  if (!current || !minimum) return true;
  return compareVersions(current, minimum) >= 0;
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

// The app installs a bundle it staged itself when it quits (main.js
// spawnUpdateSwap): a detached helper renames `.Codecast.app.incoming` over the
// app once the process exits, then removes `.Codecast.app.old`. The daemon's
// forced update quits the app too, so that helper runs at the same moment as
// the daemon's own swap. Both used to stage in the same folder, and a helper
// rename that landed during the daemon's copy installed a half-copied bundle:
// "Codecast is damaged" (2026-09-24). So the daemon stages under its own names
// and, once the app is gone, waits for the app's swap to finish first.
export function stagingPaths(appPath: string) {
  const dir = path.dirname(appPath);
  return {
    appIncoming: path.join(dir, ".Codecast.app.incoming"),
    appOld: path.join(dir, ".Codecast.app.old"),
    incoming: path.join(dir, ".Codecast.app.daemon-incoming"),
    old: path.join(dir, ".Codecast.app.daemon-old"),
  };
}

// Wait while the app's quit-time swap is in flight (its staged bundle or the
// bundle it moved aside still exists). True when it settled. A staged bundle
// left by an app that was killed before it could quit never moves, so after
// the timeout it is removed: no helper is left to rename it.
export async function waitForAppSwap(appPath: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
  const { appIncoming, appOld } = stagingPaths(appPath);
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (fs.existsSync(appIncoming) || fs.existsSync(appOld)) {
    if (Date.now() >= deadline) {
      rmrf(appIncoming);
      rmrf(appOld);
      return false;
    }
    await sleep(opts.pollMs ?? 250);
  }
  return true;
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

// Swap a verified bundle into appPath: stage a sibling on the same volume,
// then two renames. Throws when the swap fails, after putting the old app back.
export function swapInBundle(newApp: string, appPath: string): void {
  const { incoming, old } = stagingPaths(appPath);
  rmrf(incoming);
  rmrf(old);
  execFileSync("/usr/bin/ditto", [newApp, incoming], { stdio: ["ignore", "ignore", "ignore"] });
  if (!fs.existsSync(appPath)) {
    fs.renameSync(incoming, appPath); // a fresh install: nothing to move aside
    return;
  }
  try {
    fs.renameSync(appPath, old); // atomic
    fs.renameSync(incoming, appPath); // atomic
  } catch (e) {
    // Roll back if the second rename failed and we moved the old one away.
    if (!fs.existsSync(appPath) && fs.existsSync(old)) {
      try { fs.renameSync(old, appPath); } catch {}
    }
    rmrf(incoming);
    throw e;
  }
  rmrf(old);
}

// A bundle that fails its signature cannot launch, so it can never update
// itself, and its version still reads as current: only the daemon can put a
// good copy back. codesign reads the whole bundle, so a bundle that passed is
// remembered by inode (every swap makes a new one) and not read again.
function installedBundleIntact(): boolean {
  let ino: number;
  try {
    ino = fs.statSync(APP_PATH).ino;
  } catch {
    return true;
  }
  if (readState().intactIno === ino) return true;
  if (!verifyBundleSignature(APP_PATH, () => {})) return false;
  writeState({ ...readState(), intactIno: ino });
  return true;
}

/**
 * Check the published desktop feed and, if a newer version is available and the
 * app is not currently running, download + verify + atomically swap it in.
 * Fire-and-forget: never throws (failures are logged and retried later).
 * Returns true if an update was applied.
 */
export async function checkForDesktopUpdate(
  log: Logger,
  opts: DesktopUpdateOpts = {},
): Promise<boolean> {
  const force = opts.force === true;
  if (process.platform !== "darwin") return false;
  // The installed version is read before any gate, so a run that matters (a
  // forced request, or an app below the floor) can say WHY it did nothing at a
  // level the server sees. Silent gates are how a client sits on a broken
  // build for weeks with every dashboard reading "up to date".
  const installed = fs.existsSync(APP_PATH) ? plistVersion(APP_PLIST) : null;
  const belowFloor = installed != null && isBelowMinimum(installed, opts.minVersion);
  const bail: Logger = force || belowFloor ? (opts.warn ?? log) : log;

  if (!shouldAttemptDesktopUpdate(process.platform, isDevMode(), force)) {
    if (belowFloor) {
      bail(
        `desktop update: v${installed} is below the floor v${opts.minVersion}, but this daemon runs from a source checkout and never swaps the app on its own; run \`cast desktop-update --force\` from the installed cast`,
      );
    }
    return false;
  }
  if (!fs.existsSync(APP_PATH) && !opts.install) {
    if (force || opts.minVersion) bail("desktop update: /Applications/Codecast.app not found");
    return false;
  }

  try {
    // A damaged bundle cannot launch to update itself, and its version may
    // still read as current, so it takes the reinstall path.
    const damaged = !installed || (!isDesktopAppRunning() && !installedBundleIntact());
    if (!fs.existsSync(APP_PATH)) log("desktop update: the app is not installed; installing");
    else if (damaged) bail(`desktop update: the installed app ${installed ? `v${installed} ` : ""}fails its signature or has no readable version; reinstalling`);
    const current = installed ?? "0.0.0";

    // Server-pinned floor: when the installed app is below min_desktop_version,
    // apply even while the app is running (quit + swap + relaunch) so an
    // always-open client converges — the routine path only swaps when closed.
    // A manual `--force` does the same. Unlike `--force`, the min-version path
    // still respects the per-version retry throttle, so a persistently failing
    // apply can't quit-and-relaunch the app every cycle.
    const applyWhileRunning = shouldApplyWhileRunning(current, opts);

    const res = await fetch(DESKTOP_FEED);
    if (!res.ok) {
      bail(`desktop update: feed answered ${res.status}`);
      return false;
    }
    const { version, zip, sha512 } = parseFeed(await res.text());
    if (!version || !zip || !sha512) {
      bail("desktop update: could not parse latest-mac.yml");
      return false;
    }

    if (!damaged && compareVersions(version, current) <= 0) {
      // Already current — clear any stale per-version attempt bookkeeping.
      const st = readState();
      if (st.appliedVersion !== installed) writeState({ ...st, appliedVersion: installed });
      if (wantsReinstall(opts)) {
        log(`desktop update: already on v${installed} (forcing reinstall of v${version})`);
      } else {
        if (force) log(`desktop update: already on v${installed}; nothing to apply`);
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
    const retryAfter = state.lastAttemptPid === process.pid ? RETRY_INTERVAL_MS : INTERRUPTED_RETRY_MS;
    if (
      !force &&
      state.lastAttemptVersion === version &&
      state.lastAttemptAt &&
      Date.now() - state.lastAttemptAt < retryAfter
    ) {
      if (belowFloor) {
        const ago = Math.round((Date.now() - state.lastAttemptAt) / 60_000);
        bail(`desktop update: v${installed} is below the floor v${opts.minVersion}; the last attempt at v${version} failed ${ago} min ago, retrying after ${Math.round(retryAfter / 60_000)} min`);
      }
      return false;
    }
    writeState({ ...state, lastAttemptVersion: version, lastAttemptAt: Date.now(), lastAttemptPid: process.pid });

    log(`desktop update: installing v${version} (from v${installed})`);
    rmrf(WORK_DIR);
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const zipPath = path.join(WORK_DIR, zip);
    const zipUrl = `${DESKTOP_BASE}/${zip}`;

    // curl streams to disk and works reliably under launchd. Off the event
    // loop: a synchronous download froze the daemon for minutes, its
    // heartbeats stopped, and the watchdog replaced it mid-install (2026-09-24).
    await execFileAsync("/usr/bin/curl", ["-fsSL", zipUrl, "-o", zipPath], { timeout: 600000 });

    const got = await sha512Base64(zipPath);
    if (got !== sha512) {
      bail("desktop update: sha512 mismatch; aborting");
      rmrf(WORK_DIR);
      return false;
    }

    // Extract the .app from the zip.
    const extractDir = path.join(WORK_DIR, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
    const newApp = path.join(extractDir, "Codecast.app");
    if (!fs.existsSync(newApp)) {
      bail("desktop update: Codecast.app not found in archive; aborting");
      rmrf(WORK_DIR);
      return false;
    }

    const newVersion = plistVersion(path.join(newApp, "Contents", "Info.plist"));
    if (newVersion !== version) {
      bail(`desktop update: archive version ${newVersion} != feed ${version}; aborting`);
      rmrf(WORK_DIR);
      return false;
    }
    if (!verifyBundleSignature(newApp, bail)) {
      rmrf(WORK_DIR);
      return false;
    }
    const minimumOs = plistValue(path.join(newApp, "Contents", "Info.plist"), "LSMinimumSystemVersion");
    const currentOs = macosVersion();
    if (!macosMeetsMinimum(currentOs, minimumOs)) {
      bail(`desktop update: v${version} needs macOS ${minimumOs}; this Mac runs ${currentOs}; keeping v${installed}`);
      rmrf(WORK_DIR);
      return false;
    }

    // Bundle is downloaded + verified — only NOW stop the app and swap just in
    // time. Forced/below-floor: graceful quit → SIGTERM → SIGKILL. Routine: this
    // bails if the app launched mid-download (we'll swap on a later closed check).
    if (!(await ensureAppNotRunning(applyWhileRunning, log))) {
      bail("desktop update: could not stop the app; deferring swap");
      rmrf(WORK_DIR);
      return false;
    }

    if (!(await waitForAppSwap(APP_PATH))) log("desktop update: the app's own staged bundle never moved; removed it");
    try {
      // The app's quit helper may have installed this very version already.
      if (plistVersion(APP_PLIST) === version && verifyBundleSignature(APP_PATH, () => {})) {
        log(`desktop update: the app installed v${version} itself on quit`);
      } else {
        swapInBundle(newApp, APP_PATH);
      }
    } catch (e) {
      bail(`desktop update: swap failed: ${e instanceof Error ? e.message : String(e)}`);
      rmrf(WORK_DIR);
      return false;
    }
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
    bail(`desktop update: ${e instanceof Error ? e.message : String(e)}`);
    rmrf(WORK_DIR);
    return false;
  }
}
