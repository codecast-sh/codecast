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
  const out: BrowserProcess[] = [];
  let ps: string;
  try {
    ps = spawnSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf-8", timeout: 10_000 }).stdout ?? "";
  } catch {
    return out;
  }
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
export function realChromePid(processes: BrowserProcess[] = listBrowserProcesses()): number | null {
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

/** Live debug ports, one per Chrome user-data-dir. */
export function listChromeDebugPorts(): ChromeDebugPort[] {
  const out: ChromeDebugPort[] = [];
  const seen = new Set<string>();
  for (const { pid, command } of listBrowserProcesses()) {
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
