/**
 * `cast dev`: the project's dev servers, started on demand in this checkout.
 *
 * A session that changes UI has to see the page, and on a cloud host nothing
 * else starts a dev server: the session knows its PORT_WEB but not the command
 * that serves on it, so it falls back to rendering components in a static rig.
 * The command lives in the manifest's `[services.<name>]` (mode "isolated",
 * `start`, `port`, `ready_check`), or detection supplies one for a web
 * framework app with a `dev` script, so every repo answers the same question
 * the same way on a laptop and on a host.
 *
 * Idempotent: a server this checkout already runs is reused, never doubled.
 * Each server runs detached in its own process group with its output in a log
 * file, so it outlives the agent's shell and `cast dev logs` can show it.
 * State lives under the CLI directory (never in the repo), keyed by checkout.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { execSync, spawn, spawnSync } from "../proc.js";
import { codecastPath } from "../codecastDir.js";
import { worktreeEnv } from "../worktreeEnv.js";
import { isPortFree } from "./ports.js";
import { etimeSecs } from "../sim/reap.js";
import { memoryDeath, oomKillCount, thisMachineTooSmall } from "../repoNeed.js";
import type { ServiceSpec, WorkspaceManifest } from "./types.js";

export interface DevService {
  name: string;
  spec: ServiceSpec;
  /** The named port the server listens on (PORT_<NAME>). */
  portName: string;
}

export interface DevRecord {
  name: string;
  pid: number;
  port: number;
  url: string;
  command: string;
  cwd: string;
  log: string;
  startedAt: string;
  /** When it was last in use: a reap pass saw a client (devReap.ts), or `cast dev` reused it. */
  lastUsedAt?: string;
  /** Set when the daemon stopped it: the record stays as a tombstone so status and logs still answer. */
  stopped?: { at: string; reason: string };
}

export type DevStatus =
  | { name: string; state: "running"; record: DevRecord }
  | { name: string; state: "started"; record: DevRecord }
  | { name: string; state: "external"; port: number; url: string }
  | { name: string; state: "shared"; url: string }
  /** stoppedBy: the daemon stopped it (devReap.ts), when and why. */
  | { name: string; state: "stopped"; stoppedBy?: { at: string; reason: string } }
  | { name: string; state: "failed"; reason: string; record?: DevRecord; logTail?: string };

const DEFAULT_PORT = 3000;
const DEFAULT_READY_TIMEOUT_SEC = 180;

/** The services `cast dev` can run or point at, in manifest order. */
export function devServices(manifest: WorkspaceManifest): DevService[] {
  return Object.entries(manifest.services)
    .filter(([, spec]) => spec.mode === "shared" || !!spec.start)
    .map(([name, spec]) => ({ name, spec, portName: portNameOf(name, spec) }));
}

/** `port = "web"` and `port = "$PORT_WEB"` both name the web port. */
export function portNameOf(name: string, spec: ServiceSpec): string {
  return (spec.port ?? name).replace(/^\$\{?/, "").replace(/\}$/, "").replace(/^PORT_/i, "").toLowerCase();
}

/** The checkout the cwd sits in (its git top level), else the cwd. */
export function checkoutRoot(cwd = process.cwd()): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

/** The server `cast dev` runs for this checkout under `name`, if it is still alive. */
export function runningDevServer(checkout: string, name = "web"): DevRecord | null {
  const record = readRecord(checkout, name);
  return record && serverAlive(record) ? record : null;
}

export function devStateDir(checkout: string): string {
  const key = crypto.createHash("sha1").update(path.resolve(checkout)).digest("hex").slice(0, 12);
  return codecastPath("dev", `${path.basename(checkout)}-${key}`);
}

export function readRecord(checkout: string, name: string): DevRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(devStateDir(checkout), `${name}.json`), "utf-8")) as DevRecord;
  } catch {
    return null;
  }
}

function writeRecord(checkout: string, record: DevRecord): void {
  fs.mkdirSync(devStateDir(checkout), { recursive: true });
  fs.writeFileSync(path.join(devStateDir(checkout), `${record.name}.json`), JSON.stringify(record, null, 2));
}

function clearRecord(checkout: string, name: string): void {
  fs.rmSync(path.join(devStateDir(checkout), `${name}.json`), { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether any process is left in a process group. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the record's process group is still the one `cast dev` started. A
 * living leader must have started when the record says (a pid the kernel
 * handed out again would be younger). A dead leader with members left is the
 * old group: the kernel does not reuse a pid that still names a group.
 */
export function stillOurs(record: DevRecord): boolean {
  if (!isAlive(record.pid)) return true;
  // Elapsed time, not ps's start time: that one is printed in the local zone.
  const etime = (spawnSync("ps", ["-o", "etime=", "-p", String(record.pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "").trim();
  return !!etime && Math.abs(Date.now() - etimeSecs(etime) * 1000 - Date.parse(record.startedAt)) < 2 * 60_000;
}

/**
 * Whether the server a record names still runs. Its group, not its leader: a
 * `bun run dev` wrapper can die (or be killed alone) while its vite child
 * keeps serving, and that is still this checkout's server, never a reason to
 * start a second one beside it.
 */
export function serverAlive(record: DevRecord): boolean {
  return !record.stopped && groupAlive(record.pid) && stillOurs(record);
}

/** Expand $VAR / ${VAR} from env; unknown names stay as written. */
export function expandVars(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (m, k: string) => env[k] ?? m);
}

/**
 * What "ready" means for a server on `port`: `ready_check` ("http:<port>/path"
 * or "tcp:<port>") after expansion, else any HTTP answer at `/`. An HTTP
 * answer of any status counts; a socket that accepts and never answers (a
 * server wedged under load) does not.
 */
export function readyProbe(spec: ServiceSpec, port: number, env: Record<string, string | undefined>): { kind: "http" | "tcp"; port: number; path: string } {
  const raw = spec.readyCheck ? expandVars(spec.readyCheck, env) : `http:${port}/`;
  const m = /^(http|tcp):(\d+)?(\/.*)?$/.exec(raw.trim());
  if (!m) return { kind: "http", port, path: "/" };
  return { kind: m[1] as "http" | "tcp", port: m[2] ? Number(m[2]) : port, path: m[3] ?? "/" };
}

/**
 * One readiness probe, both loopback addresses at once (a server may bind
 * either). The HTTP wait is long on purpose: under heavy load vite takes 20s+
 * to answer a healthy request, and a slow answer is still an answer.
 */
export async function probeOnce(probe: { kind: "http" | "tcp"; port: number; path: string }, timeoutMs = 30_000): Promise<boolean> {
  const one = (host: string) => probe.kind === "tcp"
    ? new Promise<boolean>((resolve) => {
        const s = net.connect({ host, port: probe.port });
        const done = (v: boolean) => { s.destroy(); resolve(v); };
        s.setTimeout(timeoutMs, () => done(false));
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
      })
    : fetch(`http://${host.includes(":") ? `[${host}]` : host}:${probe.port}${probe.path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" })
        .then(() => true, () => false);
  const tries = ["127.0.0.1", "::1"].map(one);
  return Promise.any(tries.map((t) => t.then((ok) => ok || Promise.reject()))).catch(() => false);
}

/** lsof's field output, "" when nothing matched; null when lsof cannot answer (missing, failed, timed out). */
function lsof(args: string[]): string | null {
  const r = spawnSync("lsof", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, env: process.env });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return r.stdout ?? "";
}

/** A TCP listener. pid 0: a socket whose process this user cannot see. */
export interface Listener { pid: number; pgid: number; port: number }

/** LISTEN rows of /proc/net/tcp or tcp6, as socket inode → port. */
export function parseProcNetTcp(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] === "0A") out.set(cols[9], parseInt(cols[1].split(":")[1], 16));
  }
  return out;
}

/** The process group in a /proc/<pid>/stat line (after the parenthesized command, which may hold spaces). */
export function pgidFromStat(stat: string): number {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

/** Linux reads /proc directly: no subprocess to stall under load, and no dependency on lsof being installed. */
function procListeners(): Listener[] | null {
  const inodes = new Map<string, number>();
  try {
    for (const [inode, port] of parseProcNetTcp(fs.readFileSync("/proc/net/tcp", "utf-8"))) inodes.set(inode, port);
    for (const [inode, port] of parseProcNetTcp(fs.readFileSync("/proc/net/tcp6", "utf-8"))) inodes.set(inode, port);
  } catch {
    if (inodes.size === 0) return null;
  }
  const found: Listener[] = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = "";
      try { link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      const port = inode ? inodes.get(inode) : undefined;
      if (!inode || !port) continue;
      let pgid = 0;
      try { pgid = pgidFromStat(fs.readFileSync(`/proc/${entry}/stat`, "utf-8")); } catch { continue; }
      seen.add(inode);
      found.push({ pid: Number(entry), pgid, port });
    }
  }
  for (const [inode, port] of inodes) if (!seen.has(inode)) found.push({ pid: 0, pgid: 0, port });
  return found;
}

/**
 * The TCP listeners of one process group, or on one port; null when they cannot
 * be read. Only the process group scope is cheap on macOS: lsof then reads
 * just that group's processes (0.07s at load 150). A port scope, like no scope,
 * walks every process on the machine (0.7 to 0.8s there, and over 15s at worse
 * load), so callers keep it off the common path.
 */
export function tcpListeners(scope: { pgid: number } | { port: number }): Listener[] | null {
  const wanted = (l: Listener) => ("pgid" in scope ? l.pgid === scope.pgid : l.port === scope.port);
  if (process.platform === "linux") return procListeners()?.filter(wanted) ?? null;
  const select = "pgid" in scope ? ["-a", "-g", String(scope.pgid), "-iTCP", "-sTCP:LISTEN"] : [`-iTCP:${scope.port}`, "-sTCP:LISTEN"];
  const out = lsof(["-nP", ...select, "-Fpgn"]);
  if (out === null) return null;
  const found: Listener[] = [];
  let pid = 0;
  let pgid = 0;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "g") pgid = Number(line.slice(1));
    else if (line[0] === "n") found.push({ pid, pgid, port: Number(line.slice(line.lastIndexOf(":") + 1)) });
  }
  return found;
}

/** A process's working directory; null when it cannot be read. */
function processCwd(pid: number): string | null {
  if (pid <= 0) return null;
  if (process.platform === "linux") {
    try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  return (lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]) ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
}

function realPath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function gitTopLevel(dir: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export type PortOwner =
  | { owner: "ours" }
  /** A server running in another git checkout, a worktree nested inside this one included. */
  | { owner: "other-checkout"; pid: number; checkout: string }
  /** Running outside any git checkout (a container's proxy, say): not another checkout's server. */
  | { owner: "outside" }
  /** No process this user can see listens there (maybe one it cannot see). */
  | { owner: "none" }
  /** Ownership could not be established. Never reported as this checkout's server. */
  | { owner: "unknown"; why: string };

/** Whose server listens on `port`, judged by the listener's working directory. */
export function portOwner(port: number, checkout: string): PortOwner {
  const on = tcpListeners({ port });
  if (!on) return { owner: "unknown", why: "the listening sockets could not be read" };
  if (on.length === 0) return { owner: "none" };
  const root = realPath(checkout);
  let verdict: PortOwner | undefined;
  for (const { pid } of on) {
    const cwd = processCwd(pid);
    if (!cwd) return { owner: "unknown", why: pid ? `the working directory of pid ${pid} could not be read` : "its process is not visible to this user" };
    const top = gitTopLevel(cwd);
    if (top && realPath(top) !== root) return { owner: "other-checkout", pid, checkout: top };
    verdict ??= top || (realPath(cwd) + path.sep).startsWith(root + path.sep) ? { owner: "ours" } : { owner: "outside" };
  }
  return verdict!;
}

function heldReason(port: number, owner: Exclude<PortOwner, { owner: "ours" | "outside" }>): string {
  if (owner.owner === "none") return `nothing this user can see listens on port ${port}`;
  return owner.owner === "other-checkout"
    ? `port ${port} is held by another checkout's server (${owner.checkout}, pid ${owner.pid})`
    : `could not tell which process listens on port ${port}: ${owner.why}`;
}

/**
 * Where a server this checkout started answers, or why that cannot be said.
 * It may not hold the port it was given: vite moves to the next free port when
 * that one is taken, and then another checkout's server answers on the
 * recorded one. The server's own process group says where it went, which
 * answers the common case. Only a group listening nowhere (not up yet, or a
 * server run by another process, such as a container) asks who holds the
 * recorded port, and keeps it only when that listener is provably not another
 * checkout's. That question walks every process on the machine, so it is asked
 * only once something accepts on the port and the group still listens nowhere
 * after that: a server that binds between the first look and the connect is
 * found by the second look, not by the walk.
 */
export async function ownPort(record: DevRecord, checkout: string): Promise<{ port: number } | { refused: string }> {
  const fromGroup = (): { port: number } | { refused: string } | null => {
    const group = tcpListeners({ pgid: record.pid });
    if (!group) return { refused: heldReason(record.port, { owner: "unknown", why: "the listening sockets could not be read" }) };
    const ports = [...new Set(group.map((l) => l.port))].sort((a, b) => a - b);
    if (ports.includes(record.port)) return { port: record.port };
    if (ports.length) return { port: ports.find((p) => p > record.port) ?? ports[0] };
    return null;
  };
  const first = fromGroup();
  if (first) return first;
  if (!(await probeOnce({ kind: "tcp", port: record.port, path: "/" }, 2_000))) return { refused: heldReason(record.port, { owner: "none" }) };
  const second = fromGroup();
  if (second) return second;
  const owner = portOwner(record.port, checkout);
  return owner.owner === "ours" || owner.owner === "outside" ? { port: record.port } : { refused: heldReason(record.port, owner) };
}

/** The port a service should listen on in this checkout. */
async function choosePort(svc: DevService, manifest: WorkspaceManifest, env: Record<string, string | undefined>): Promise<{ port: number; assigned: boolean }> {
  const fromEnv = Number(env[`PORT_${svc.portName.toUpperCase()}`]);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return { port: fromEnv, assigned: true };
  const base = manifest.ports[svc.portName]?.base ?? DEFAULT_PORT;
  for (let port = base; port < base + 200; port++) {
    if (await isPortFree(port)) return { port, assigned: false };
  }
  throw new Error(`no free port in ${base}-${base + 199} for ${svc.name}`);
}

export function tailFile(file: string, lines: number): string {
  try {
    const text = fs.readFileSync(file, "utf-8");
    return text.split("\n").slice(-lines - 1).join("\n").trimEnd();
  } catch {
    return "";
  }
}

export interface StartOptions {
  checkout: string;
  manifest: WorkspaceManifest;
  /** Wait at most this long for readiness (default: the service's ready_timeout_sec, else 180). */
  timeoutSec?: number;
  onWait?: (svc: DevService, seconds: number) => void;
  /** A line worth saying before the wait: this machine is smaller than the repo needs. */
  onNote?: (line: string) => void;
  /** The project's [vault] env, asked for only when a server is about to start. A throw fails that start. */
  secretEnv?: () => Promise<Record<string, string>>;
}

/** Ensure one service is serving in this checkout; reuse it when it already is. */
export async function ensureService(svc: DevService, opts: StartOptions): Promise<DevStatus> {
  const env: Record<string, string | undefined> = { ...process.env, ...worktreeEnv(opts.checkout), ...opts.manifest.env };
  if (svc.spec.mode === "shared") return { name: svc.name, state: "shared", url: expandVars(svc.spec.url ?? "", env) };

  const portVar = `PORT_${svc.portName.toUpperCase()}`;
  const probeAt = (port: number) => readyProbe(svc.spec, port, { ...env, [portVar]: String(port) });
  const existing = readRecord(opts.checkout, svc.name);
  if (existing && serverAlive(existing)) {
    // Asked for: in use now, whether or not a client connects before the next reap pass.
    const used = { ...existing, lastUsedAt: new Date().toISOString() };
    writeRecord(opts.checkout, used);
    return waitReady(svc, used, probeAt, opts);
  }
  if (existing) clearRecord(opts.checkout, svc.name);

  const { port, assigned } = await choosePort(svc, opts.manifest, env);
  const runEnv = { ...env, [portVar]: String(port), PORT: String(port) };
  const url = `http://localhost:${port}`;
  if (assigned && !(await isPortFree(port))) {
    // This checkout's own port already answers: a server someone started by hand, unless it runs in another checkout.
    const owner = portOwner(port, opts.checkout);
    if (owner.owner !== "ours" && owner.owner !== "outside") return { name: svc.name, state: "failed", reason: `${heldReason(port, owner)}; ${portVar} names it for this checkout` };
    if (await probeOnce(probeAt(port))) return { name: svc.name, state: "external", port, url };
    return { name: svc.name, state: "failed", reason: `port ${port} (${portVar}) is held by another process that does not answer HTTP` };
  }

  let secrets: Record<string, string> = {};
  try {
    secrets = (await opts.secretEnv?.()) ?? {};
  } catch (err) {
    return { name: svc.name, state: "failed", reason: err instanceof Error ? err.message : String(err) };
  }

  const log = path.join(devStateDir(opts.checkout), `${svc.name}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // The last run's output (a crash banner, the daemon's stop line) survives one restart.
  try { fs.renameSync(log, `${log}.prev`); } catch { /* no earlier log */ }
  const fd = fs.openSync(log, "w");
  const command = svc.spec.start!;
  const oomBefore = oomKillCount();
  const child = spawn("bash", ["-c", command], {
    cwd: opts.checkout,
    env: { ...runEnv, ...secrets } as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  // Close our copy only once the child holds its own: closing right after
  // spawn() returned lost the child's output under load.
  const closeFd = () => { try { fs.closeSync(fd); } catch { /* closed */ } };
  child.once("spawn", closeFd);
  child.once("error", closeFd);
  // How it ended, if it ends while we wait: a memory kill is reported as one.
  let killed = false;
  child.once("exit", (code, signal) => { killed = signal === "SIGKILL" || code === 137; });
  child.unref();
  if (!child.pid) return { name: svc.name, state: "failed", reason: `could not start: ${command}` };
  const record: DevRecord = {
    name: svc.name, pid: child.pid, port, url, command, cwd: opts.checkout, log, startedAt: new Date().toISOString(),
  };
  writeRecord(opts.checkout, record);
  const small = thisMachineTooSmall(opts.checkout);
  if (small) opts.onNote?.(small);
  const status = await waitReady(svc, record, probeAt, opts);
  if (status.state === "failed" && status.reason === "the server exited") {
    const memory = memoryDeath({ what: `the ${svc.name} server`, killed, oomBefore, oomAfter: oomKillCount(), repoRoot: opts.checkout });
    if (memory) return { ...status, reason: memory };
  }
  return status.state === "running" ? { ...status, state: "started" } : status;
}

type ProbeAt = (port: number) => { kind: "http" | "tcp"; port: number; path: string };

/** The record, moved to the port its server actually took. */
function movedTo(record: DevRecord, port: number, checkout: string): DevRecord {
  if (port === record.port) return record;
  const moved = { ...record, port, url: `http://localhost:${port}` };
  writeRecord(checkout, moved);
  return moved;
}

async function waitReady(svc: DevService, record: DevRecord, probeAt: ProbeAt, opts: StartOptions): Promise<DevStatus> {
  const limitMs = (opts.timeoutSec ?? svc.spec.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC) * 1000;
  const start = Date.now();
  let lastNote = 0;
  let held: string | undefined;
  while (Date.now() - start < limitMs) {
    if (!serverAlive(record)) {
      clearRecord(opts.checkout, svc.name);
      return { name: svc.name, state: "failed", reason: "the server exited", record, logTail: tailFile(record.log, 30) };
    }
    const where = await ownPort(record, opts.checkout);
    if ("port" in where) {
      held = undefined;
      record = movedTo(record, where.port, opts.checkout);
      if (await probeOnce(probeAt(record.port))) return { name: svc.name, state: "running", record };
    } else {
      held = where.refused;
    }
    const waited = Math.floor((Date.now() - start) / 1000);
    if (waited - lastNote >= 15) { lastNote = waited; opts.onWait?.(svc, waited); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const probe = probeAt(record.port);
  return {
    name: svc.name, state: "failed", record, logTail: tailFile(record.log, 30),
    reason: `${held ?? `not answering on ${probe.kind}:${probe.port}${probe.kind === "http" ? probe.path : ""}`} after ${Math.round(limitMs / 1000)}s (still running, pid ${record.pid})`,
  };
}

/** Read-only status of one service. */
export async function serviceStatus(svc: DevService, checkout: string, manifest: WorkspaceManifest): Promise<DevStatus> {
  const env: Record<string, string | undefined> = { ...process.env, ...worktreeEnv(checkout), ...manifest.env };
  if (svc.spec.mode === "shared") return { name: svc.name, state: "shared", url: expandVars(svc.spec.url ?? "", env) };
  const found = readRecord(checkout, svc.name);
  if (found?.stopped) return { name: svc.name, state: "stopped", stoppedBy: found.stopped };
  if (found && serverAlive(found)) {
    const where = await ownPort(found, checkout);
    if (!("port" in where)) return { name: svc.name, state: "failed", reason: `running, but ${where.refused}`, record: found };
    const record = movedTo(found, where.port, checkout);
    const ok = await probeOnce(readyProbe(svc.spec, record.port, { ...env, [`PORT_${svc.portName.toUpperCase()}`]: String(record.port) }));
    return ok ? { name: svc.name, state: "running", record } : { name: svc.name, state: "failed", reason: "running but not answering", record, logTail: tailFile(record.log, 15) };
  }
  return { name: svc.name, state: "stopped" };
}

/**
 * Stop a service this checkout started: TERM its whole process group (a dead
 * wrapper's vite child included), KILL after 5s, and wait for the group to go
 * before clearing the record.
 */
export async function stopService(svc: DevService, checkout: string): Promise<boolean> {
  const record = readRecord(checkout, svc.name);
  if (!record || record.stopped) return false;
  const signal = (sig: NodeJS.Signals) => { try { process.kill(-record.pid, sig); } catch { /* gone */ } };
  if (serverAlive(record)) {
    if (svc.spec.stop) {
      spawn("bash", ["-c", svc.spec.stop], { cwd: checkout, stdio: "ignore", env: { ...process.env, PORT: String(record.port) } });
    }
    signal("SIGTERM");
    for (let i = 0; i < 50 && groupAlive(record.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (groupAlive(record.pid)) signal("SIGKILL");
    for (let i = 0; i < 20 && groupAlive(record.pid); i++) await new Promise((r) => setTimeout(r, 100));
  }
  clearRecord(checkout, svc.name);
  return true;
}
