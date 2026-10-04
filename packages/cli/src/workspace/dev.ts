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
import { spawn } from "../proc.js";
import { codecastPath } from "../codecastDir.js";
import { worktreeEnv } from "../worktreeEnv.js";
import { isPortFree } from "./ports.js";
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
}

export type DevStatus =
  | { name: string; state: "running"; record: DevRecord }
  | { name: string; state: "started"; record: DevRecord }
  | { name: string; state: "external"; port: number; url: string }
  | { name: string; state: "shared"; url: string }
  | { name: string; state: "stopped" }
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

export async function probeOnce(probe: { kind: "http" | "tcp"; port: number; path: string }): Promise<boolean> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    if (probe.kind === "tcp") {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: host.replace(/[[\]]/g, ""), port: probe.port });
        const done = (v: boolean) => { s.destroy(); resolve(v); };
        s.setTimeout(2000, () => done(false));
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
      });
      if (ok) return true;
      continue;
    }
    try {
      await fetch(`http://${host}:${probe.port}${probe.path}`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      return true;
    } catch { /* try the next address */ }
  }
  return false;
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
}

/** Ensure one service is serving in this checkout; reuse it when it already is. */
export async function ensureService(svc: DevService, opts: StartOptions): Promise<DevStatus> {
  const env: Record<string, string | undefined> = { ...process.env, ...worktreeEnv(opts.checkout), ...opts.manifest.env };
  if (svc.spec.mode === "shared") return { name: svc.name, state: "shared", url: expandVars(svc.spec.url ?? "", env) };

  const existing = readRecord(opts.checkout, svc.name);
  if (existing && isAlive(existing.pid)) {
    const probe = readyProbe(svc.spec, existing.port, { ...env, [`PORT_${svc.portName.toUpperCase()}`]: String(existing.port) });
    if (await probeOnce(probe)) return { name: svc.name, state: "running", record: existing };
    return waitReady(svc, existing, probe, opts);
  }
  if (existing) clearRecord(opts.checkout, svc.name);

  const { port, assigned } = await choosePort(svc, opts.manifest, env);
  const portVar = `PORT_${svc.portName.toUpperCase()}`;
  const runEnv = { ...env, [portVar]: String(port), PORT: String(port) };
  const probe = readyProbe(svc.spec, port, runEnv);
  const url = `http://localhost:${port}`;
  if (assigned && !(await isPortFree(port))) {
    // This checkout's own port already answers: a server someone started by hand.
    if (await probeOnce(probe)) return { name: svc.name, state: "external", port, url };
    return { name: svc.name, state: "failed", reason: `port ${port} (${portVar}) is held by another process that does not answer HTTP` };
  }

  const log = path.join(devStateDir(opts.checkout), `${svc.name}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "w");
  const command = svc.spec.start!;
  const child = spawn("bash", ["-c", command], {
    cwd: opts.checkout,
    env: runEnv as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  child.unref();
  if (!child.pid) return { name: svc.name, state: "failed", reason: `could not start: ${command}` };
  const record: DevRecord = {
    name: svc.name, pid: child.pid, port, url, command, cwd: opts.checkout, log, startedAt: new Date().toISOString(),
  };
  writeRecord(opts.checkout, record);
  const status = await waitReady(svc, record, probe, opts);
  return status.state === "running" ? { ...status, state: "started" } : status;
}

async function waitReady(
  svc: DevService,
  record: DevRecord,
  probe: { kind: "http" | "tcp"; port: number; path: string },
  opts: StartOptions,
): Promise<DevStatus> {
  const limitMs = (opts.timeoutSec ?? svc.spec.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC) * 1000;
  const start = Date.now();
  let lastNote = 0;
  while (Date.now() - start < limitMs) {
    if (!isAlive(record.pid)) {
      clearRecord(opts.checkout, svc.name);
      return { name: svc.name, state: "failed", reason: "the server exited", record, logTail: tailFile(record.log, 30) };
    }
    if (await probeOnce(probe)) return { name: svc.name, state: "running", record };
    const waited = Math.floor((Date.now() - start) / 1000);
    if (waited - lastNote >= 15) { lastNote = waited; opts.onWait?.(svc, waited); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    name: svc.name, state: "failed", record, logTail: tailFile(record.log, 30),
    reason: `not answering on ${probe.kind}:${probe.port}${probe.kind === "http" ? probe.path : ""} after ${Math.round(limitMs / 1000)}s (still running, pid ${record.pid})`,
  };
}

/** Read-only status of one service. */
export async function serviceStatus(svc: DevService, checkout: string, manifest: WorkspaceManifest): Promise<DevStatus> {
  const env: Record<string, string | undefined> = { ...process.env, ...worktreeEnv(checkout), ...manifest.env };
  if (svc.spec.mode === "shared") return { name: svc.name, state: "shared", url: expandVars(svc.spec.url ?? "", env) };
  const record = readRecord(checkout, svc.name);
  if (record && isAlive(record.pid)) {
    const ok = await probeOnce(readyProbe(svc.spec, record.port, { ...env, [`PORT_${svc.portName.toUpperCase()}`]: String(record.port) }));
    return ok ? { name: svc.name, state: "running", record } : { name: svc.name, state: "failed", reason: "running but not answering", record, logTail: tailFile(record.log, 15) };
  }
  return { name: svc.name, state: "stopped" };
}

/** Stop a service this checkout started: TERM its process group, KILL after 5s. */
export async function stopService(svc: DevService, checkout: string): Promise<boolean> {
  const record = readRecord(checkout, svc.name);
  if (!record) return false;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-record.pid, sig); } catch { try { process.kill(record.pid, sig); } catch { /* gone */ } }
  };
  if (isAlive(record.pid)) {
    if (svc.spec.stop) {
      spawn("bash", ["-c", svc.spec.stop], { cwd: checkout, stdio: "ignore", env: { ...process.env, PORT: String(record.port) } });
    }
    signal("SIGTERM");
    for (let i = 0; i < 50 && isAlive(record.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (isAlive(record.pid)) signal("SIGKILL");
  }
  clearRecord(checkout, svc.name);
  return true;
}
