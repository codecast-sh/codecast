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

/** Live debug ports, one per Chrome user-data-dir. */
export function listChromeDebugPorts(): ChromeDebugPort[] {
  const out: ChromeDebugPort[] = [];
  const seen = new Set<string>();
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
    // Helper processes (--type=gpu-process, renderer …) share the flag; only
    // the browser process itself owns the port.
    if (/\s--type=/.test(command)) continue;
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
    if (port > 0) out.push({ port, pid: parseInt(m[1], 10), userDataDir });
  }
  return out;
}
