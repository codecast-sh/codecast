/**
 * The human's own Chrome as a process: is it running, start it when it is
 * not, and hand it a URL. Everything here addresses the instance on the
 * default profile, the one the cast extension lives in.
 *
 * A launch opens Chrome's normal window. A windowless launch
 * (`--no-startup-window`) was tried first and looked right on a throwaway
 * profile, but in a real profile Chrome ended the extension's service
 * worker seconds after every start and refused tab creation ("Tabs cannot
 * be edited right now"), so the bridge never worked in that state
 * (2026-09-15). One window appearing once is the price of a Chrome that
 * runs extensions.
 *
 * Every URL travels as the path of a 0600 file whose script forwards to it
 * (protocol.ts bridgePairingPage): the command line is readable by every user
 * on the machine, and the pairing URL carries the token.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "../../lockFile.js";
import { spawn } from "../../proc.js";
import { findChromeBinary, keychainArgs } from "../../workspace/chrome.js";
import { realChromePid } from "../localChrome.js";
import { browserHome } from "../profile.js";
import { bridgePairingPage, bridgeWakeUrl } from "./protocol.js";

export function realChromeRunning(): boolean {
  return realChromePid() !== null;
}

export function chromeLaunchCommand(bin: string, args: string[], platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin" && bin.includes(".app/Contents/MacOS/")) {
    return { command: "/usr/bin/open", args: ["-n", "-g", "-a", bin.slice(0, bin.indexOf(".app/Contents/MacOS/") + 4), "--args", ...args] };
  }
  return { command: bin, args };
}

/** Start Chrome detached with `args`; true when a process was spawned. */
function spawnChrome(args: string[]): boolean {
  const bin = findChromeBinary();
  if (!bin) return false;
  try {
    const launch = chromeLaunchCommand(bin, [...keychainArgs(), ...args]);
    const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return !!child.pid;
  } catch {
    return false;
  }
}

/**
 * When any cast process on this machine last launched Chrome or woke the
 * extension. Every session's verbs walk the same ladder, so without this a
 * dead worker meant one launch or one wake per session per command. A claim
 * is read, checked and written under the CLI's cross-process file lock
 * (lockFile.ts): several sessions reaching the same rung in the same
 * instant would otherwise all read the old stamp and all act.
 */
export function stampPath(): string {
  return path.join(browserHome(), "real-chrome.json");
}

async function claim(decide: (current: Record<string, unknown>) => Record<string, unknown> | null): Promise<boolean> {
  // The lock's own budgets: the claim holds it for microseconds, and a
  // holder that died is reclaimed by its dead pid, so a live one on a loaded
  // machine is never stolen from.
  const release = await acquireFileLock(stampPath() + ".lock", { describe: "cast browser real chrome stamp" });
  try {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(stampPath(), "utf-8"));
    } catch {}
    // Test seam: widens the read-to-write window so the concurrent regression
    // (realChrome.test.ts) fails for certain without the lock.
    const widen = Number(process.env.CAST_REAL_CHROME_CLAIM_DELAY_MS) || 0;
    if (widen) await sleep(widen);
    const next = decide(current);
    if (!next) return false;
    fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stampPath(), JSON.stringify(next), { mode: 0o600 });
    return true;
  } finally {
    release();
  }
}

/** Take the stamp for `kind` unless one was taken within `withinMs`; true when this caller holds it. */
export function takeStamp(kind: "launchedAt", withinMs: number, now = Date.now()): Promise<boolean> {
  // A stamp in the future is a hold: it says "not until then".
  return claim((current) => (now - (Number(current[kind]) || 0) < withinMs ? null : { ...current, [kind]: now }));
}

export const LAUNCH_ONCE_MS = 60_000;

/**
 * One automatic wake per outage. A wake puts a tab in the human's Chrome.
 * When Chrome refuses to start the worker at all, the page reloads the
 * extension (status.js reviveIfRefused), which is the one thing that brings
 * such a worker back; a second wake for the same outage would find the
 * reload already spent and change nothing. An outage is
 * named by the last time the extension proved itself (bridge.json
 * extensionSeenAt): the same value means the same outage and no second
 * wake; a reconnect writes a new one and the next outage gets its wake.
 * Two sessions racing on a fresh outage are held apart by WAKE_ONCE_MS.
 */
export const WAKE_ONCE_MS = 60_000;
/**
 * And never more often than this, whatever the outage key says. A worker
 * that Chrome ends every minute proves itself every minute, which moves
 * extensionSeenAt and would earn a wake tab per minute (seen 2026-09-15 in
 * a windowless Chrome). The worker's own alarm carries a dying worker; the
 * visible wake is for a worker that is not coming back at all.
 */
export const WAKE_MIN_GAP_MS = 10 * 60_000;

export function takeWake(outage: string, now = Date.now()): Promise<boolean> {
  return claim((current) => {
    if (current.wokeForOutage === outage) return null;
    // Not twice within the gap either, and a stamp in the future is a hold.
    if (now - (Number(current.wokeAt) || 0) < WAKE_MIN_GAP_MS) return null;
    return { ...current, wokeAt: now, wokeForOutage: outage };
  });
}

/**
 * Start the human's Chrome in the background. True when a launch was
 * issued (or one was issued moments ago by another session).
 */
/**
 * Chrome runs the renderer of a tab that is not visible at background
 * priority, which macOS starves on a busy machine: an agent's tab, opened in
 * the background on purpose so it never takes the human's screen, then
 * answers nothing for tens of seconds (measured 2026-09-17: renderer at
 * priority 4, attach failed after 23 s at load 750, while the active tab's
 * renderer answered at once). This switch is Chrome's own way to keep
 * background renderers at normal priority; every browser automation tool
 * passes it. It applies only to a Chrome this command starts: a Chrome the
 * human opened from the Dock keeps Chrome's default.
 */
export const REAL_CHROME_LAUNCH_ARGS = ["--disable-renderer-backgrounding"];

export async function launchRealChrome(): Promise<boolean> {
  if (!(await takeStamp("launchedAt", LAUNCH_ONCE_MS))) return true;
  return spawnChrome(REAL_CHROME_LAUNCH_ARGS);
}

/** The forwarding page `setup` leaves for Chrome to open; removed once pairing settles. */
export function pairingPagePath(): string {
  return path.join(browserHome(), "pair.html");
}

/**
 * Hand a URL to the human's own Chrome without waiting for it. Nothing here
 * can see whether Chrome showed the page or an error, which is why callers
 * ask the host afterwards and print the fallback themselves.
 */
export function openInRealChrome(url: string): boolean {
  const page = pairingPagePath();
  try {
    fs.mkdirSync(path.dirname(page), { recursive: true, mode: 0o700 });
    fs.rmSync(page, { force: true });
    fs.writeFileSync(page, bridgePairingPage(url), { mode: 0o600 });
  } catch {
    return false;
  }
  return spawnChrome([pathToFileURL(page).href]);
}

/** Drop the forwarding page; Chrome has read it by the time the wait settled either way. */
export function discardPairingPage(): void {
  try {
    fs.rmSync(pairingPagePath(), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Wake the extension's service worker from outside: open its options page
 * with `#wake` (protocol.ts bridgeWakeUrl). The page's message starts a
 * worker Chrome ended and makes a live one drop a stuck socket; the worker
 * closes the page again. A worker Chrome refuses to start for 10 s is
 * revived by the page reloading the extension, which closes the page; one
 * that neither answers nor refuses is waited on, then the page closes itself.
 * This is the last rung: it puts a tab in front of the human, so it is sent
 * only by a verb that needs a page, only after the worker's own alarm has
 * had its chance, and once per outage across every session (takeWake).
 * False when this outage already had its wake: the caller then waits on
 * that wake rather than adding a tab.
 */
export async function wakeExtension(outage: string): Promise<boolean> {
  if (!(await takeWake(outage))) return false;
  return openInRealChrome(bridgeWakeUrl());
}

// ---------------------------------------------------------------------------
// Restarting the human's Chrome with the switch, and a Dock launcher that
// keeps it: the switch applies only at launch, and a Chrome opened from the
// Dock gets none.
// ---------------------------------------------------------------------------

import * as os from "node:os";
import { spawnSync } from "../../proc.js";

export const CHROME_LAUNCHER_NAME = "Google Chrome for Codecast";

/**
 * Quit Chrome the way its own menu does (tabs are saved for restore), wait
 * for the process to go, then start it again with the switch and Chrome's
 * own "restore the last session" flag. Graceful only: a Chrome that will not
 * quit in `quitWaitMs` is reported, never killed, because a forced end can
 * lose what the human had open. The human runs this; nothing here runs on
 * its own.
 */
export async function restartRealChrome(opts: { quitWaitMs?: number; note?: (line: string) => void } = {}): Promise<{ restarted: boolean; pid: number | null; reason?: string }> {
  const note = opts.note ?? (() => {});
  const was = realChromePid();
  if (was) {
    note(`asking Chrome (pid ${was}) to quit…`);
    spawnSync("osascript", ["-e", 'tell application "Google Chrome" to quit'], { timeout: 15_000 });
    const deadline = Date.now() + (opts.quitWaitMs ?? 60_000);
    while (Date.now() < deadline && realChromePid() !== null) await sleep(500);
    if (realChromePid() !== null) return { restarted: false, pid: was, reason: `Chrome did not quit within ${Math.round((opts.quitWaitMs ?? 60_000) / 1000)}s; quit it by hand and run this again` };
    // Chrome's singleton lock and the DevToolsActivePort file linger a beat.
    await sleep(1_500);
  }
  note("starting Chrome with --disable-renderer-backgrounding…");
  if (!spawnChrome([...REAL_CHROME_LAUNCH_ARGS, "--restore-last-session"])) return { restarted: false, pid: null, reason: "no Chrome binary found" };
  const deadline = Date.now() + 30_000;
  let pid: number | null = null;
  while (Date.now() < deadline && !(pid = realChromePid())) await sleep(500);
  return { restarted: pid !== null, pid, reason: pid ? undefined : "Chrome did not appear within 30s" };
}

/**
 * A minimal app bundle whose only job is to open Chrome with the switch, for
 * the Dock. It carries Chrome's own icon, its own bundle id, and a name that
 * says what it is; Chrome's bundle, updater, profile and default browser
 * registration are untouched. `open --args` hands the switch to Chrome only
 * when Chrome is not already running, which is exactly when it can apply.
 */
export function installChromeLauncher(dir = path.join(os.homedir(), "Applications")): { app: string; iconCopied: boolean } {
  const app = path.join(dir, `${CHROME_LAUNCHER_NAME}.app`);
  const contents = path.join(app, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  const script = `#!/bin/bash
# Opens Google Chrome with the switch that keeps background tabs and the
# Codecast extension's worker at normal priority (see codecast:
# packages/browser-extension/README.md). Made by \`cast browser chrome launcher\`.
exec /usr/bin/open -a "Google Chrome" --args ${REAL_CHROME_LAUNCH_ARGS.join(" ")} "$@"
`;
  fs.writeFileSync(path.join(contents, "MacOS", "launch"), script, { mode: 0o755 });
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${CHROME_LAUNCHER_NAME}</string>
  <key>CFBundleDisplayName</key><string>${CHROME_LAUNCHER_NAME}</string>
  <key>CFBundleIdentifier</key><string>sh.codecast.chrome-launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`,
  );
  let iconCopied = false;
  const chromeIcon = "/Applications/Google Chrome.app/Contents/Resources/app.icns";
  if (fs.existsSync(chromeIcon)) {
    fs.copyFileSync(chromeIcon, path.join(contents, "Resources", "app.icns"));
    iconCopied = true;
  }
  // Launch Services learns the bundle when it is registered; the Dock reads the icon from it.
  spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app], { timeout: 15_000 });
  return { app, iconCopied };
}
