/**
 * Every Chrome on this machine that is listening for CDP, whoever launched it.
 *
 * Chrome writes the port it chose to `DevToolsActivePort` inside its
 * user-data-dir, and the user-data-dir is on the command line — so `ps` plus
 * one file read per profile finds every debuggable browser without knowing who
 * started it. That is what lets the daemon raise a tab in an agent-browser
 * session, a throwaway `--remote-debugging-port` Chrome, or the built-in
 * driver's browser with the same code: it never needs the engine's help to
 * find the browser, only the target id.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { execFileAsync } from "../proc.js";
import { isWSL } from "../windowsSupport.js";
import { isPidAlive } from "../workspace/chrome.js";

export interface ChromeDebugPort {
  port: number;
  pid: number;
  userDataDir: string;
}

export interface BrowserProcess {
  pid: number;
  command: string;
}

/**
 * Every top-level process on the machine that is not a Chrome helper
 * (`--type=renderer` and friends share the browser binary and are skipped),
 * from one `ps` pass. The single process listing both scans below read.
 */
export function listBrowserProcesses(): BrowserProcess[] {
  let ps: string;
  try {
    ps = spawnSync("ps", PS_ARGS, { encoding: "utf-8", timeout: 10_000 }).stdout ?? "";
  } catch {
    return [];
  }
  return parseBrowserProcesses(ps);
}

const PS_ARGS = ["ax", "-o", "pid=,command="];
// A listing this recent answers the next caller too: one click asks both
// engines, twice when the row's tab is gone, and hovers ask again.
const SHARED_LISTING_MS = 2_000;
let sharedListing: { promise: Promise<BrowserProcess[]>; settledAt: number | null } | null = null;

/**
 * The same listing for the daemon, off its event loop. On a loaded machine
 * `ps` takes tens of seconds; run synchronously from the focus route it froze
 * the whole daemon for 50s to 244s at a time (2026-11-07), and every "open
 * tab" click and hover waited behind it. Callers in flight share one `ps`.
 */
export function listBrowserProcessesAsync(): Promise<BrowserProcess[]> {
  const cached = sharedListing;
  if (cached && (cached.settledAt === null || Date.now() - cached.settledAt < SHARED_LISTING_MS)) return cached.promise;
  const entry: { promise: Promise<BrowserProcess[]>; settledAt: number | null } = { promise: Promise.resolve([]), settledAt: null };
  entry.promise = execFileAsync("ps", PS_ARGS, { encoding: "utf-8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
    .then(({ stdout }) => (lastListing = parseBrowserProcesses(stdout)), () => [])
    .finally(() => {
      entry.settledAt = Date.now();
    });
  sharedListing = entry;
  return entry.promise;
}

let lastListing: BrowserProcess[] | null = null;

/**
 * The last listing that came back, at once, while a newer one is taken for
 * the next caller; only the first call of a process waits. For a caller a
 * person is waiting on: which Chromes run with a debugging port changes
 * rarely, and a browser started since the last listing is seen one click
 * later, where waiting for `ps` held every click for a closed tab.
 */
export function lastBrowserProcesses(): Promise<BrowserProcess[]> {
  const fresh = listBrowserProcessesAsync();
  return lastListing ? Promise.resolve(lastListing) : fresh;
}

function parseBrowserProcesses(ps: string): BrowserProcess[] {
  const out: BrowserProcess[] = [];
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const command = m[2];
    if (/\s--type=/.test(command)) continue;
    out.push({ pid: parseInt(m[1], 10), command });
  }
  return out;
}

/**
 * The executable of a command line: everything before its first `--flag`.
 * Browser paths carry spaces ("Google Chrome.app/Contents/MacOS/Google
 * Chrome"), so splitting on whitespace would cut them in half.
 */
function executableOf(command: string): string {
  return command.split(/\s--/)[0].trim();
}

/** A Chromium-family browser's main binary, by its file name — never a
 *  crashpad handler, a native-messaging host or an unrelated process whose
 *  path happens to contain "chrome". */
const BROWSER_BINARY = /(^|\/)(Google Chrome( for Testing| Canary| Beta| Dev)?|Chromium|Brave Browser|Microsoft Edge|chrome|chromium(-browser)?|google-chrome(-\w+)?|brave(-browser)?|msedge)$/;

/**
 * The human's own Chrome: a browser binary on its default profile, so no
 * `--user-data-dir` and no debugging port — every Chrome an agent launches
 * carries both (focusSentinel.ts isAgentChromeCommand). This is the process
 * the extension bridge lives in, and the one to bring frontmost after the
 * extension has selected a tab. Null when none is running (or the human runs
 * Chrome some other way); the raise is best effort either way.
 */
export function realChromePid(processes?: BrowserProcess[]): number | null {
  // Inside WSL the human's Chrome is a Windows process, invisible to `ps`.
  if (!processes && isWSL()) return windowsChromePid();
  processes ??= listBrowserProcesses();
  const real = processes.filter(
    (p) =>
      BROWSER_BINARY.test(executableOf(p.command)) &&
      !/--user-data-dir=/.test(p.command) &&
      !/--remote-debugging-port=/.test(p.command) &&
      !/--headless/.test(p.command),
  );
  // A test build (puppeteer's "Chrome for Testing") is never the human's.
  return (real.find((p) => !/for Testing/.test(p.command)) ?? real[0])?.pid ?? null;
}

let knownChromePid: number | null = null;
let chromePidLookup: Promise<void> | null = null;

/**
 * The human's Chrome pid as last seen, without waiting on a process listing:
 * it lives across many clicks, so the answer is remembered while that process
 * does. A missing or dead one starts a lookup in the background and reads
 * null until it lands; the hover probe before a click usually starts it.
 */
export function knownRealChromePid(): number | null {
  if (knownChromePid !== null && isPidAlive(knownChromePid)) return knownChromePid;
  chromePidLookup ??= (isWSL() ? Promise.resolve(windowsChromePid()) : listBrowserProcessesAsync().then((procs) => realChromePid(procs)))
    .then((pid) => {
      knownChromePid = pid;
    })
    .finally(() => {
      chromePidLookup = null;
    });
  return null;
}

/** A running Windows chrome.exe, seen from WSL through interop. */
export function windowsChromePid(): number | null {
  try {
    const out = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], { encoding: "utf-8", timeout: 10_000 }).stdout ?? "";
    const m = out.match(/^"chrome\.exe","(\d+)"/im);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** Live debug ports, one per Chrome user-data-dir. */
export function listChromeDebugPorts(processes: BrowserProcess[] = listBrowserProcesses()): ChromeDebugPort[] {
  const out: ChromeDebugPort[] = [];
  const seen = new Set<string>();
  for (const { pid, command } of processes) {
    const dirMatch = command.match(/--user-data-dir=(\S+)/);
    if (!dirMatch) continue;
    const userDataDir = dirMatch[1];
    if (seen.has(userDataDir)) continue;
    seen.add(userDataDir);
    let port = 0;
    try {
      port = parseInt(fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf-8").split("\n")[0], 10);
    } catch {
      continue;
    }
    if (port > 0) out.push({ port, pid, userDataDir });
  }
  return out;
}
