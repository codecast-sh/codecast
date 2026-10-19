// The large local files a session's heavy processes are working on.
//
// A session that renders hours of footage from a photo or video library, trains
// on a local dataset, or serves a big local database can only run where those
// files are: moving it to a host leaves its data behind. The resource sheet
// names that before anyone presses Move. Only processes a session owns and that
// are busy are looked at (a handful per minute), so the cost stays one short
// lsof (or a /proc walk on Linux) per minute.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileAsync } from "./proc.js";
import { resourceProbe } from "./resourceProbe.js";
import type { ResourceProcess } from "@codecast/shared/contracts";
import { sameStartedAt } from "./resourceMonitor.js";

export type LocalData = NonNullable<ResourceProcess["localData"]>;
export type OpenFile = { pid: number; path: string; size: number };

/** A process is looked at when it is busy; idle ones are not costing the machine anything. */
const BUSY_CPU = 20;
const MAX_PIDS = 16;
const REFRESH_MS = 60_000;
/** Below this a process's open files are ordinary working files, not data. */
export const LOCAL_DATA_MIN_BYTES = 256 * 1024 ** 2;

const HOME = os.homedir();
const SYSTEM_PREFIXES = ["/System/", "/usr/", "/bin/", "/sbin/", "/Library/", "/Applications/", "/opt/", "/private/var/", "/private/tmp/", "/tmp/", "/var/", "/dev/", "/proc/", "/sys/", "/etc/", "/nix/", "/snap/", "/run/"];
const HOME_TOOL_DIRS = ["Library", ".codecast", ".claude", ".codex", ".bun", ".cache", ".npm", ".cargo", ".rustup", ".local", ".nvm", ".pnpm-store", ".gradle", ".m2"];

/** Whether an open file is the session's data rather than system, toolchain or cache. */
export function isDataPath(p: string, home = HOME): boolean {
  if (!p.startsWith("/")) return false;
  if (SYSTEM_PREFIXES.some((s) => p.startsWith(s))) return false;
  if (p.includes("/node_modules/") || p.includes("/.git/")) return false;
  if (p.startsWith(home + "/")) {
    const first = p.slice(home.length + 1).split("/")[0];
    if (HOME_TOOL_DIRS.includes(first)) return false;
  }
  return true;
}

/** Where a file lives, as a person would name it: the library or bundle it is
 *  inside (`iMovie Library.imovielibrary`), else its directory. */
export function dataRoot(p: string, home = HOME): string {
  const parts = p.split("/");
  const bundle = parts.slice(0, -1).findIndex((seg) => /\.[A-Za-z][A-Za-z0-9]{2,}$/.test(seg) && !seg.startsWith("."));
  const dir = bundle >= 0 ? parts.slice(0, bundle + 1).join("/") : path.dirname(p);
  return dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
}

/** Each process's open data files, summed per process: distinct paths, and the root holding most of the bytes. */
export function summarizeOpenFiles(files: OpenFile[], home = HOME): Map<number, LocalData> {
  const byPid = new Map<number, Map<string, number>>();
  for (const f of files) {
    if (!isDataPath(f.path, home) || !(f.size > 0)) continue;
    const m = byPid.get(f.pid) ?? new Map<string, number>();
    m.set(f.path, f.size);
    byPid.set(f.pid, m);
  }
  const out = new Map<number, LocalData>();
  for (const [pid, m] of byPid) {
    let bytes = 0;
    const roots = new Map<string, number>();
    for (const [p, size] of m) {
      bytes += size;
      const r = dataRoot(p, home);
      roots.set(r, (roots.get(r) ?? 0) + size);
    }
    if (bytes < LOCAL_DATA_MIN_BYTES) continue;
    const root = [...roots].sort((a, b) => b[1] - a[1])[0][0].slice(0, 240);
    out.set(pid, { bytes, files: m.size, root });
  }
  return out;
}

/** `lsof -F pftsn` output: regular files only, without the executable and its mapped libraries. */
export function parseLsof(stdout: string): OpenFile[] {
  const out: OpenFile[] = [];
  let pid = 0, fd = "", type = "", size = 0;
  const flush = (name: string) => {
    if (type === "REG" && fd !== "txt" && fd !== "mem" && /^\d/.test(fd)) out.push({ pid, path: name, size });
  };
  for (const line of stdout.split("\n")) {
    const tag = line[0], value = line.slice(1);
    if (tag === "p") pid = Number(value);
    else if (tag === "f") { fd = value; type = ""; size = 0; }
    else if (tag === "t") type = value;
    else if (tag === "s") size = Number(value);
    else if (tag === "n") flush(value);
  }
  return out;
}

/** Null when the read did not answer (busy, timed out): what was found before still holds. */
async function readOpenFiles(pids: number[]): Promise<OpenFile[] | null> {
  if (process.platform === "darwin") {
    const r = await resourceProbe("lsof", () => execFileAsync("lsof", ["-nP", "-w", "-b", "-Fftsn", "-p", pids.join(",")], { timeout: 4000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }).catch((e: any) => ({ stdout: String(e?.stdout ?? "") })), 4000);
    return r ? parseLsof(r.stdout) : null;
  }
  if (process.platform === "linux") {
    const out: OpenFile[] = [];
    for (const pid of pids) {
      let fds: string[] = [];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try {
          const p = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          const st = fs.statSync(p);
          if (st.isFile()) out.push({ pid, path: p, size: st.size });
        } catch {}
      }
    }
    return out;
  }
  return null;
}

/** By pid: what was found for the process that had this start time. */
const cache = new Map<number, { startedAt?: number; data: LocalData | null }>();
let lastRefresh = 0;
const found = (p: Pick<ResourceProcess, "pid" | "startedAt">) => {
  const e = cache.get(p.pid);
  return e && sameStartedAt(e.startedAt, p.startedAt) ? e : undefined;
};

/** The session processes worth looking at: owned by one session, and busy. */
export function busySessionPids(processes: ResourceProcess[]): ResourceProcess[] {
  return processes.filter((p) => p.sessionId && p.cpu >= BUSY_CPU).sort((a, b) => b.cpu - a.cpu).slice(0, MAX_PIDS);
}

/** Stamps `localData` on the processes it measured. Refreshes at most once a
 *  minute; between refreshes, a process keeps what was last found for it. */
export async function annotateLocalData(processes: ResourceProcess[], now = Date.now(), read: (pids: number[]) => Promise<OpenFile[] | null> = readOpenFiles): Promise<ResourceProcess[]> {
  if (now - lastRefresh >= REFRESH_MS) {
    const busy = busySessionPids(processes);
    if (busy.length) {
      lastRefresh = now;
      const files = await read(busy.map((p) => p.pid)).catch(() => null);
      if (files) {
        const byPid = summarizeOpenFiles(files);
        for (const p of busy) cache.set(p.pid, { startedAt: p.startedAt, data: byPid.get(p.pid) ?? null });
      }
    }
  }
  const live = new Set(processes.filter((p) => found(p)).map((p) => p.pid));
  for (const pid of cache.keys()) if (!live.has(pid)) cache.delete(pid);
  return processes.map((p) => {
    const data = found(p)?.data;
    return data ? { ...p, localData: data } : p;
  });
}

export function resetLocalDataForTest(): void {
  cache.clear();
  lastRefresh = 0;
}
