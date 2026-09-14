/**
 * The human's own Chrome as a process: is it running, start it when it is
 * not, and hand it a URL. Everything here addresses the instance on the
 * default profile, the one the cast extension lives in.
 *
 * Why the binary and never Apple events. `open -a` and `tell application`
 * address a bundle id, and the agent's separate Chrome is the same bundle on
 * another profile: with both running, Launch Services answers for whichever
 * it likes, in practice the clone, and a launch request activates the clone
 * instead of starting the human's Chrome. Chrome's own process singleton is
 * exact: a Chrome started without `--user-data-dir` hands its command line
 * to the instance holding the default profile and exits, or becomes that
 * instance when none is running.
 *
 * A launch opens no window on macOS (`--no-startup-window`): Chrome runs,
 * loads its extensions, and the bridge connects, all behind whatever the
 * human is doing. The extension makes a window the first time a session
 * needs a tab (background.js createTab). On Linux a windowless Chrome quits
 * at once, so a window it is.
 *
 * Every URL travels as the path of a 0600 file whose script forwards to it
 * (protocol.ts bridgePairingPage): the command line is readable by every user
 * on the machine, and the pairing URL carries the token.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "../../proc.js";
import { findChromeBinary, keychainArgs } from "../../workspace/chrome.js";
import { realChromePid } from "../localChrome.js";
import { browserHome } from "../profile.js";
import { bridgePairingPage, bridgeWakeUrl } from "./protocol.js";

export function realChromeRunning(): boolean {
  return realChromePid() !== null;
}

/** Start Chrome detached with `args`; true when a process was spawned. */
function spawnChrome(args: string[]): boolean {
  const bin = findChromeBinary();
  if (!bin) return false;
  try {
    const child = spawn(bin, [...keychainArgs(), ...args], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return !!child.pid;
  } catch {
    return false;
  }
}

/**
 * When this process last launched Chrome or woke the extension, so several
 * sessions hitting a dead worker at once produce one launch and one wake,
 * not one per session.
 */
function stampPath(): string {
  return path.join(browserHome(), "real-chrome.json");
}

function stamp(kind: "launchedAt" | "wokeAt", withinMs: number): boolean {
  let current: Record<string, number> = {};
  try {
    current = JSON.parse(fs.readFileSync(stampPath(), "utf-8"));
  } catch {}
  if (Date.now() - (current[kind] ?? 0) < withinMs) return false;
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stampPath(), JSON.stringify({ ...current, [kind]: Date.now() }), { mode: 0o600 });
  return true;
}

export const LAUNCH_ONCE_MS = 60_000;
export const WAKE_ONCE_MS = 30_000;

/**
 * Start the human's Chrome in the background. True when a launch was
 * issued (or one was issued moments ago by another session).
 */
export function launchRealChrome(): boolean {
  if (!stamp("launchedAt", LAUNCH_ONCE_MS)) return true;
  return spawnChrome(process.platform === "darwin" ? ["--no-startup-window"] : []);
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
 * closes the page again. This is the last rung: it puts a tab in front of the
 * human for a moment, so it is sent only after the worker's own alarm has
 * had its chance, and at most once per WAKE_ONCE_MS across sessions.
 */
export function wakeExtension(): boolean {
  if (!stamp("wokeAt", WAKE_ONCE_MS)) return true;
  return openInRealChrome(bridgeWakeUrl());
}
