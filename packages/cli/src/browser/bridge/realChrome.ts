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
 * One automatic wake per outage. A wake puts a tab in the human's Chrome,
 * and when the extension system itself is wedged (the case that leaves the
 * worker dead for minutes) the worker never answers to close it; a wake
 * that did not work will not work ten minutes later either. An outage is
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
export async function launchRealChrome(): Promise<boolean> {
  if (!(await takeStamp("launchedAt", LAUNCH_ONCE_MS))) return true;
  return spawnChrome([]);
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
 * closes the page again, and the page closes itself when no worker answers.
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
