/**
 * Stop `cast dev` servers nobody can use, and orphaned dev servers whose tree
 * is gone. The daemon runs one pass on its reap cadence (`cast dev reap` runs
 * one by hand).
 *
 * A `cast dev` server runs detached in its own process group and outlives the
 * session that started it, so without this nothing ever stops it. On
 * 2026-11-24 four of them took a laptop into thermal emergency sleep: each
 * `bun run dev` wrapper had panicked ("Bun has crashed", segfault) and kept
 * spinning at ~97% CPU for 12 hours afterwards, two of them in worktrees that
 * had been deleted, none with a client. When the wrappers were finally killed,
 * their vite children lived on, orphaned.
 *
 * A server in the registry (~/.codecast/dev/<checkout>/<name>.json) stops,
 * whole process group with its vite children, when:
 *   gone:    its checkout no longer exists at the recorded path (removed, or
 *            moved to a _trash- directory on its way out);
 *   crashed: its log says its runner crashed (a panicked bun spins);
 *   idle:    no client and no `cast dev` asking for it for IDLE_STOP_MS
 *            of awake time.
 * A stopped server keeps its record as a tombstone (`stopped`) and gets one
 * line in its log, so `cast dev status` and `cast dev logs` say what happened.
 * A process outside the registry is looked at only when it is an orphan (ppid
 * 1) of this user shaped like a dev server that is codecast's own (a `cast
 * dev` log for stdout, or a path in a .codecast/ or .claude/ worktree), and
 * stopped only with no client connected, when its tree is gone, or when it is
 * a `cast dev` server (its
 * output goes to a log under ~/.codecast/dev) that has run IDLE_STOP_MS. Such
 * strays are vite children whose `bun run dev` parent died or was killed
 * alone: their record went with the parent, so the registry pass misses them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { codecastPath } from "../codecastDir.js";
import { etimeSecs } from "../sim/reap.js";
import { groupAlive, isAlive, stillOurs, tcpListeners, type DevRecord } from "./dev.js";

/**
 * Two hours with no client connected. An open tab holds vite's HMR websocket,
 * so a page a person left open is a connection and never idles; an agent that
 * verifies a change comes back within minutes. Two hours of nobody at all
 * means the work moved on, and `cast dev` brings the server back in seconds.
 */
export const IDLE_STOP_MS = 2 * 60 * 60_000;

/**
 * The daemon sweeps about every 5 minutes. A sweep that finds the previous one
 * further back than this knows the machine slept (or no daemon ran), and
 * restarts the idle count: hours asleep are not hours nobody looked.
 */
export const SWEEP_GAP_MS = 20 * 60_000;

export type DevExit = "gone" | "crashed" | "idle";

/**
 * Why a registered server should stop now, or null. `clients` null means the
 * connections could not be read, which never counts as idle. The idle count
 * runs from the latest of its start, its last use, and when this machine last
 * woke (awakeSince).
 */
export function devServerExit(s: { treeExists: boolean; crashed: boolean; clients: number | null; startedAt: number; lastUsedAt?: number; awakeSince: number }, now = Date.now()): DevExit | null {
  if (!s.treeExists) return "gone";
  if (s.crashed) return "crashed";
  if (s.clients !== 0) return null;
  return now - Math.max(s.startedAt, s.lastUsedAt ?? 0, s.awakeSince) >= IDLE_STOP_MS ? "idle" : null;
}

/** Where sweeps record when they ran and since when they have run unbroken. */
export function sweepFile(): string {
  return codecastPath("dev", "sweep.json");
}

/** Since when sweeps have run without a gap, counting this one at `now`. */
export function awakeSince(prev: { at: number; awakeSince: number } | null, now: number): number {
  return prev && now - prev.at <= SWEEP_GAP_MS ? prev.awakeSince : now;
}

function readSweep(): { at: number; awakeSince: number } | null {
  try {
    const s = JSON.parse(fs.readFileSync(sweepFile(), "utf-8")) as { at: number; awakeSince: number };
    return Number.isFinite(s.at) && Number.isFinite(s.awakeSince) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Why an orphan outside the registry should stop, or null. Only codecast's
 * own: a `cast dev` server (castDev) or one in a codecast worktree
 * (inWorktree); a dev server anything else runs is never touched. Never with
 * a client, or when the connections cannot be read. Idle only for a `cast
 * dev` server, which has no record to say when a client was last seen, so it
 * must have run the whole window with none connected now.
 */
export function orphanExit(o: { treeGone: boolean; castDev: boolean; inWorktree: boolean; upMs: number; clients: number | null }): "gone" | "idle" | null {
  if (!o.castDev && !o.inWorktree) return null;
  if (o.clients !== 0) return null;
  if (o.treeGone) return "gone";
  return o.castDev && o.upMs >= IDLE_STOP_MS ? "idle" : null;
}

/** Whether a process's cwd or the script its command names sits in a codecast or agent worktree. */
export function inCodecastWorktree(cwd: string | null, args: string): boolean {
  const paths = [cwd ?? "", ...args.split(/\s+/).filter((t) => t.startsWith("/"))];
  return paths.some((p) => /\/\.(codecast|claude)\/worktrees\//.test(p));
}

const REASONS: Record<DevExit, string> = {
  gone: "its checkout is gone",
  crashed: "its runner crashed",
  idle: `no client for ${IDLE_STOP_MS / 3_600_000}h`,
};

/** A runner's crash banner: bun prints this, then can spin at full CPU instead of exiting. */
export function logSaysCrashed(tail: string): boolean {
  return /Bun has crashed|^panic\(/m.test(tail);
}

const LOG_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * A server's log, which `cast dev` truncates at each start: whole, or its last
 * LOG_SCAN_BYTES when larger. Vite keeps printing after its runner crashed, so
 * the crash banner is rarely in the last lines.
 */
export function readLogEnd(file: string, maxBytes = LOG_SCAN_BYTES): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Connected rows of /proc/net/tcp or tcp6, as their local ports: ESTABLISHED
 * (01), and SYN_RECV (03), where Linux keeps a connection Bun's server has
 * not accepted yet: it sets TCP_DEFER_ACCEPT, so a client that has sent
 * nothing stays there, and it is still a client.
 */
export function parseProcNetClients(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] === "01" || cols[3] === "03") out.push(parseInt(cols[1].split(":")[1], 16));
  }
  return out;
}

/** lsof -F p/g/n/T output as one row per TCP socket. */
export function parseLsofTcp(out: string): { pid: number; local: number; state: string }[] {
  const rows: { pid: number; local: number; state: string }[] = [];
  let pid = 0;
  let name = "";
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n") name = line.slice(1);
    else if (line.startsWith("TST=")) {
      const local = name.split("->")[0];
      rows.push({ pid, local: Number(local.slice(local.lastIndexOf(":") + 1)), state: line.slice(4) });
    }
  }
  return rows;
}

/**
 * Clients connected to the servers of one process group (or of the given
 * processes in it): connections to a port they listen on. Their own
 * outbound connections do not count. Null when the sockets cannot be read.
 */
export function clientCount(pgid: number, pids?: number[]): number | null {
  const mine = (pid: number) => pids === undefined || pids.includes(pid);
  if (process.platform === "linux") {
    const listening = tcpListeners({ pgid })?.filter((l) => mine(l.pid));
    if (!listening) return null;
    const ports = new Set(listening.map((l) => l.port));
    if (ports.size === 0) return 0;
    try {
      const connected = [...parseProcNetClients(fs.readFileSync("/proc/net/tcp", "utf-8")), ...parseProcNetClients(fs.readFileSync("/proc/net/tcp6", "utf-8"))];
      return connected.filter((p) => ports.has(p)).length;
    } catch {
      return null;
    }
  }
  const r = spawnSync("lsof", ["-nP", "-a", "-g", String(pgid), "-iTCP", "-FpgnT"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  const rows = parseLsofTcp(r.stdout ?? "").filter((s) => mine(s.pid));
  const ports = new Set(rows.filter((s) => s.state === "LISTEN").map((s) => s.local));
  return rows.filter((s) => s.state === "ESTABLISHED" && ports.has(s.local)).length;
}

async function stopGroup(pgid: number): Promise<void> {
  const signal = (sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* gone */ } };
  signal("SIGTERM");
  for (let i = 0; i < 50 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
  if (groupAlive(pgid)) signal("SIGKILL");
}

/** When a pid started, as ps prints it; null once it is gone. Names one process where a pid alone may be reused. */
function startOf(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return (r.stdout ?? "").trim().replace(/\s+/g, " ") || null;
}

/**
 * Stop processes seen in a ps snapshot taken a while ago. Each signal goes
 * only to a pid that still started when the snapshot says, so a pid the
 * kernel handed to a new process since is never touched.
 */
async function stopProcessTree(procs: { pid: number; start: string }[]): Promise<void> {
  const same = () => procs.filter((p) => startOf(p.pid) === p.start);
  const signal = (sig: NodeJS.Signals, to: { pid: number }[]) => { for (const p of to) try { process.kill(p.pid, sig); } catch { /* gone */ } };
  signal("SIGTERM", same());
  for (let i = 0; i < 50 && procs.some((p) => isAlive(p.pid)); i++) await new Promise((r) => setTimeout(r, 100));
  signal("SIGKILL", same());
}

interface Registered { file: string; record: DevRecord }

function registered(): Registered[] {
  const root = codecastPath("dev");
  const out: Registered[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, dir, f);
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf-8")) as DevRecord;
        if (Number.isInteger(record.pid) && record.pid > 1 && record.cwd && record.startedAt) out.push({ file, record });
      } catch { /* half-written or foreign */ }
    }
  }
  return out;
}

export interface PsRow { pid: number; ppid: number; pgid: number; uid: number; etimeSecs: number; start: string; args: string }

/** `ps -axo pid=,ppid=,pgid=,uid=,etime=,lstart=,args=` as rows. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d:-]+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], uid: +m[4], etimeSecs: etimeSecs(m[5]), start: m[6].replace(/\s+/g, " "), args: m[7] });
  }
  return rows;
}

/**
 * Clients of a process and its descendants, group by group: a `bun run dev`
 * wrapper listens on nothing, and its vite child holds the clients. Null when
 * any group's sockets cannot be read.
 */
export function treeClients(tree: { pid: number; pgid: number }[]): number | null {
  let total = 0;
  for (const pgid of new Set(tree.map((p) => p.pgid))) {
    const n = clientCount(pgid, tree.filter((p) => p.pgid === pgid).map((p) => p.pid));
    if (n === null) return null;
    total += n;
  }
  return total;
}

/** A dev server's command line: vite, or a package manager's `run dev`. */
export function looksLikeDevServer(args: string): boolean {
  return /(^|[\s/])vite(\s|$)|\brun dev\b|(^|[\s/])next dev\b/.test(args);
}

/**
 * Whether an orphan's tree is gone, judged by the checkout its working
 * directory sits in (the worktree root when it is in one, else the directory
 * itself): gone, or moved to a _trash- directory. A deleted node_modules is a
 * reinstall, not a gone tree. An unreadable cwd is never gone.
 */
export function orphanTreeGone(cwd: string | null, exists: (p: string) => boolean = fs.existsSync): boolean {
  if (cwd === null) return false;
  const root = /^.*?\/\.(codecast|claude)\/worktrees\/[^/]+/.exec(cwd)?.[0] ?? cwd;
  return /\/_trash-[^/]*(\/|$)/.test(cwd) || !exists(root);
}

/** Where a process's fd ("cwd", or "1" for stdout) points; null when unreadable. Linux marks a deleted target " (deleted)", a path that does not exist either. */
function processFd(pid: number, fd: "cwd" | "1"): string | null {
  if (process.platform === "linux") {
    try { return fs.readlinkSync(fd === "cwd" ? `/proc/${pid}/cwd` : `/proc/${pid}/fd/1`); } catch { return null; }
  }
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", fd, "-Fn"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  return (r.stdout ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
}

function realPath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export interface ReapOptions {
  /** The clock the idle rule reads (tests move it forward). */
  now?: number;
  dryRun?: boolean;
  /** False skips the machine-wide orphan pass (tests: it reads every process of this user). */
  orphans?: boolean;
  /** One line per stop. */
  log?: (line: string) => void;
}

/** One pass: returns a line per server stopped (or, dry, that would be). */
export async function reapDevServers(opts: ReapOptions = {}): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const lines: string[] = [];
  const say = (line: string) => { lines.push(line); opts.log?.(line); };
  const handled = new Set<number>();
  const awake = awakeSince(readSweep(), now);
  if (!opts.dryRun) {
    try {
      fs.mkdirSync(path.dirname(sweepFile()), { recursive: true });
      fs.writeFileSync(sweepFile(), JSON.stringify({ at: now, awakeSince: awake }));
    } catch { /* best effort: the next sweep sees a gap and only waits longer */ }
  }
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,etime=,lstart=,args="], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  const rows = parsePs(ps);

  for (const { file, record } of registered()) {
    if (record.stopped) continue;
    if (!groupAlive(record.pid)) {
      if (!opts.dryRun) fs.rmSync(file, { force: true });
      continue;
    }
    if (!stillOurs(record)) continue;
    handled.add(record.pid);
    const clients = clientCount(record.pid);
    const lastUsedAt = clients ? now : record.lastUsedAt ? Date.parse(record.lastUsedAt) : undefined;
    if (clients && !opts.dryRun) {
      try { fs.writeFileSync(file, JSON.stringify({ ...record, lastUsedAt: new Date(now).toISOString() }, null, 2)); } catch { /* best effort */ }
    }
    const why = devServerExit({
      treeExists: fs.existsSync(record.cwd),
      crashed: logSaysCrashed(readLogEnd(record.log)),
      clients,
      startedAt: Date.parse(record.startedAt),
      lastUsedAt,
      awakeSince: awake,
    }, now);
    if (!why) continue;
    // Idle only: read the connections again in the instant before the stop, as a tab opened since counts.
    // A crashed runner spins whoever is connected, so it stops regardless.
    if (why === "idle" && clientCount(record.pid) !== 0) continue;
    const pids = rows.filter((r) => r.pgid === record.pid).map((r) => r.pid);
    say(`${opts.dryRun ? "would stop" : "stopped"} ${record.name} (port ${record.port}, pids ${pids.join(",") || record.pid}) in ${record.cwd}: ${REASONS[why]}`);
    if (!opts.dryRun) {
      await stopGroup(record.pid);
      // A tombstone, not a deletion: `cast dev status` and `cast dev logs` still answer for it.
      const stopped: DevRecord = { ...record, stopped: { at: new Date(now).toISOString(), reason: REASONS[why] } };
      try { fs.writeFileSync(file, JSON.stringify(stopped, null, 2)); } catch { /* best effort */ }
      try { fs.appendFileSync(record.log, `\n[codecast] stopped by the codecast daemon: ${REASONS[why]}; \`cast dev\` starts it again\n`); } catch { /* log gone with its state dir */ }
    }
  }

  if (opts.orphans === false) return lines;
  const uid = process.getuid?.();
  const logs = realPath(codecastPath("dev")) + path.sep;
  for (const row of rows) {
    if (row.ppid !== 1 || row.uid !== uid || handled.has(row.pgid) || !looksLikeDevServer(row.args)) continue;
    const tree = [row];
    for (let i = 0; i < tree.length; i++) for (const r of rows) if (r.ppid === tree[i].pid) tree.push(r);
    const cwd = processFd(row.pid, "cwd");
    const why = orphanExit({
      treeGone: orphanTreeGone(cwd),
      castDev: (processFd(row.pid, "1") ?? "").startsWith(logs),
      inWorktree: inCodecastWorktree(cwd, row.args),
      // Up since it started or this machine last woke, whichever is later.
      upMs: Math.min(row.etimeSecs * 1000, now - awake),
      clients: treeClients(tree),
    });
    if (!why) continue;
    say(`${opts.dryRun ? "would stop" : "stopped"} orphan (pids ${tree.map((t) => t.pid).join(",")}) in ${cwd ?? "?"} (${row.args.slice(0, 120)}): ${why === "gone" ? "its tree is gone" : `a stray cast dev server with no client, up over ${IDLE_STOP_MS / 3_600_000}h`}`);
    if (!opts.dryRun) await stopProcessTree(tree);
  }
  return lines;
}
