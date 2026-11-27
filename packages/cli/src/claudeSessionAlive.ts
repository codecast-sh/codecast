import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "./proc.js";

// ── Is a Claude session's process alive? ────────────────────────────────────
// Claude Code registers each live process in <config dir>/sessions/<pid>.json
// with the session it runs now and its start (`procStart`, `ps lstart` read in
// UTC). The file can outlive its process (a SIGKILLed parent left one behind
// in the pl-1134 spike), and a pid is reused, so the process counts only while
// the pid is alive and still has that start. A start `ps` cannot read is taken
// as a match: the callers hold work back while a session runs, and wrongly
// holding costs a wait where wrongly releasing starts a second copy.
export interface ProcessProbe {
  alive(pid: number): boolean;
  /** `ps lstart` in UTC, or null when ps could not say. */
  startOf(pid: number): string | null;
}

const liveProcessProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // ESRCH, or EPERM: another user's process under a reused pid
    }
  },
  startOf(pid) {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 3000,
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      }) as string;
      return out.trim() || null;
    } catch {
      return null;
    }
  },
};

const sameStart = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

export function claudeSessionProcessAlive(sessionsDir: string, sessionId: string, probe: ProcessProbe = liveProcessProbe): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let reg: { pid?: unknown; sessionId?: unknown; procStart?: unknown };
    try {
      reg = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf-8"));
    } catch {
      continue;
    }
    if (reg.sessionId !== sessionId || typeof reg.pid !== "number" || !probe.alive(reg.pid)) continue;
    if (typeof reg.procStart !== "string") return true;
    const start = probe.startOf(reg.pid);
    if (start === null || sameStart(start, reg.procStart)) return true;
  }
  return false;
}
