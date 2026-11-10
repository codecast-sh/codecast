// The daemon's side of a Claude SDK host: start the host process, connect to
// its socket, send requests, and keep a live copy of its state. A connection
// that drops while the host still runs (the daemon restarting, a socket
// hiccup) is reopened; a host that is gone is reported once, so the daemon can
// resume the saved Claude session on the next delivery.

import { isPidAlive } from "../pidAlive.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { execFileAsync, spawn } from "../proc.js";
import { LAUNCHD_LABEL_ENV, startLaunchdJobAsync, stopLaunchdJob } from "../launchdJob.js";
import { sdkHostDir, sdkHostPaths, writeFileAtomic, type SdkHostPaths } from "./paths.js";
import type { SdkLaunchSpec } from "./options.js";
import {
  encodeFrame, frameReader,
  type ClientFrame, type HostFrame, type SdkActivity, type SdkHostState, type SdkImage, type SdkPermissionAnswer, type SdkPermissionRequest, type SdkTurnError,
} from "./protocol.js";

export interface SdkHostClientEvents {
  state: [SdkHostState];
  activity: [SdkActivity];
  /** Claude moved to another session in the same process (a /clear). */
  session: [string];
  permission: [SdkPermissionRequest];
  permission_settled: [string, "answer" | "abort"];
  result: [{ subtype: string; isError: boolean; text: string | null; error: SdkTurnError | null }];
  too_old: [string | null, string];
  /** The host is gone: it exited, or its process is dead and its socket refuses. */
  gone: [string];
}

const REQUEST_TIMEOUT_MS = 30_000;

export { isPidAlive as pidAlive };

/**
 * Is this pid a live SDK host? A pid recorded before a reboot can belong to
 * any process now, so the command line has to name the host entry too.
 */
export async function hostProcessAlive(pid: number | undefined | null): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  // Async: the daemon's loop must not wait on ps, which takes seconds on a loaded machine.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/bin/ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }));
  } catch (err) {
    // ps exits 1 for a pid it cannot find; anything else (a timeout) is no proof the host is gone.
    const code = (err as { code?: unknown }).code;
    return code !== 1;
  }
  // A killed host its parent has not reaped yet is a zombie: gone, though kill(pid, 0) still answers.
  return !stdout.trimStart().startsWith("Z") && stdout.includes("_claude-sdk-host");
}

export function readHostState(sessionId: string, dir?: string): SdkHostState | null {
  try {
    return JSON.parse(fs.readFileSync(sdkHostPaths(sessionId, dir).state, "utf-8")) as SdkHostState;
  } catch {
    return null;
  }
}

export class SdkHostClient extends EventEmitter<SdkHostClientEvents> {
  readonly sessionId: string;
  readonly paths: SdkHostPaths;
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private waiters = new Map<string, { resolve: (f: Extract<HostFrame, { type: "reply" }>) => void; timer: ReturnType<typeof setTimeout> }>();
  private _state: SdkHostState | null = null;
  private closed = false;
  private goneReported = false;

  constructor(sessionId: string, dir?: string) {
    super();
    this.sessionId = sessionId;
    this.paths = sdkHostPaths(sessionId, dir);
  }

  get state(): SdkHostState | null {
    return this._state;
  }
  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed && !this.connecting;
  }
  get gone(): boolean {
    return this.goneReported;
  }

  /** Connect (or reconnect) and fetch the state. Rejects when nothing answers on the socket. */
  connect(timeoutMs = 5_000): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    this.closed = false;
    // Bun raises a missing socket's ENOENT before an error listener can attach.
    if (!fs.existsSync(this.paths.socket)) return Promise.reject(new Error(`no host socket for ${this.sessionId}`));
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.paths.socket);
      const onState = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off("state", onState);
        // An attempt that timed out is not a dropped connection: the close it causes is not reported.
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        reject(new Error(`host for ${this.sessionId} did not answer`));
      }, timeoutMs);
      // Connected means the host's state is in hand: a caller reads pending prompts straight after.
      socket.once("connect", () => {
        this.socket = socket;
        this.once("state", onState);
        socket.write(encodeFrame({ op: "hello" }));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("data", frameReader<HostFrame>((frame) => this.onFrame(frame)));
      socket.on("close", () => this.onClose(socket));
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onFrame(frame: HostFrame): void {
    switch (frame.type) {
      case "state":
        this._state = frame.state;
        this.emit("state", frame.state);
        return;
      case "reply": {
        const w = this.waiters.get(frame.id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiters.delete(frame.id);
        w.resolve(frame);
        return;
      }
      case "activity":
        if (this._state) this._state = { ...this._state, activity: frame.activity };
        this.emit("activity", frame.activity);
        return;
      case "session":
        if (this._state) this._state = { ...this._state, claudeSessionId: frame.claudeSessionId };
        this.emit("session", frame.claudeSessionId);
        return;
      case "permission":
        if (this._state && !this._state.pending.some((p) => p.requestId === frame.request.requestId)) {
          this._state = { ...this._state, pending: [...this._state.pending, frame.request] };
        }
        this.emit("permission", frame.request);
        return;
      case "permission_settled":
        if (this._state) this._state = { ...this._state, pending: this._state.pending.filter((p) => p.requestId !== frame.requestId) };
        this.emit("permission_settled", frame.requestId, frame.by);
        return;
      case "result":
        this.emit("result", frame);
        return;
      case "too_old":
        this.emit("too_old", frame.version, frame.minimum);
        return;
      case "exit":
        this.reportGone(frame.reason);
        return;
    }
  }

  private onClose(socket: net.Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      w.resolve({ type: "reply", id, ok: false, error: "host connection closed" });
    }
    this.waiters.clear();
    // Before the first state there is no pid to judge by, and the caller is still retrying the connect.
    if (this.closed || this.goneReported || !this._state) return;
    this.reconnectWhileAlive(250);
  }

  /** A host is gone only when its process is: a host too busy to answer under load is still the session's. */
  private reconnectWhileAlive(delayMs: number): void {
    void hostProcessAlive(this._state?.pid).then((alive) => {
      if (this.closed || this.goneReported) return;
      if (!alive) return this.reportGone("host process ended");
      setTimeout(() => {
        if (this.closed || this.goneReported) return;
        this.connect().catch(() => this.reconnectWhileAlive(Math.min(delayMs * 2, 5_000)));
      }, delayMs);
    });
  }

  private reportGone(reason: string): void {
    if (this.goneReported) return;
    this.goneReported = true;
    if (this._state) this._state = { ...this._state, status: "stopped", pending: [] };
    this.emit("gone", reason);
  }

  /** Send a request and wait for its reply. Never throws; a failed request replies ok:false. */
  async request(frame: ClientFrame & { id?: string }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    if (!this.socket || this.socket.destroyed) {
      try {
        await this.connect();
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    const id = frame.id ?? crypto.randomUUID();
    const withId = { ...frame, id } as ClientFrame;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve({ ok: false, error: "host did not reply in time" });
      }, timeoutMs);
      this.waiters.set(id, { resolve: (f) => resolve({ ok: f.ok, error: f.error, data: f.data }), timer });
      this.socket!.write(encodeFrame(withId));
    });
  }

  /** Deliver a user message. `id` dedupes a retried delivery of the same message. */
  send(messageId: string, text: string, images?: SdkImage[], uuid?: string) {
    // A turn can wait on startup (init) before the host acks, so allow longer than a control call.
    return this.request({ op: "send", id: crypto.randomUUID(), messageId, text, ...(images?.length ? { images } : {}), ...(uuid && { uuid }) }, 120_000);
  }
  interrupt() {
    return this.request({ op: "interrupt", id: crypto.randomUUID() }, 120_000);
  }
  answer(requestId: string, answer: SdkPermissionAnswer) {
    return this.request({ op: "answer", requestId, answer });
  }
  annotate(requestId: string, cardId: string) {
    return this.request({ op: "annotate", requestId, cardId });
  }
  setModel(model: string | null) {
    return this.request({ op: "set_model", id: crypto.randomUUID(), model });
  }
  setPermissionMode(mode: string) {
    return this.request({ op: "set_permission_mode", id: crypto.randomUUID(), mode });
  }
  stop() {
    return this.request({ op: "stop" }, 20_000);
  }

  /** Drop the connection without stopping the host (daemon shutdown). */
  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }
}

export interface LaunchHostOptions {
  /** argv that runs cast itself: [cmd, ...prefixArgs] from resolveCastInvocation. */
  castArgv: string[];
  /** The account and provider-key shell prefix the tmux launch line starts with ("" for none). */
  shellPrefix?: string;
  dir?: string;
  env?: Record<string, string | undefined>;
  /** Wait this long for the socket to answer: a bun parsing the CLI from source is slow under load. */
  startTimeoutMs?: number;
  log?: (line: string) => void;
  /** Tests: skip launchd and spawn directly. */
  noLaunchd?: boolean;
}

/** The host's argv: cast's own, wrapped in a shell only when the launch carries an account prefix. */
export function hostArgv(castArgv: string[], specPath: string, shellPrefix = ""): string[] {
  const argv = [...castArgv, "_claude-sdk-host", specPath];
  return shellPrefix ? ["/bin/bash", "-c", `${shellPrefix}exec "$@"`, "bash", ...argv] : argv;
}

/**
 * Start a host for `spec` and connect to it. The spec file is written 0600;
 * it carries no secrets (the account rides the shell prefix as for tmux).
 */
export async function launchSdkHost(spec: SdkLaunchSpec, opts: LaunchHostOptions): Promise<SdkHostClient> {
  const dir = opts.dir ?? sdkHostDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = sdkHostPaths(spec.sessionId, dir);
  writeFileAtomic(paths.spec, JSON.stringify(spec));
  fs.rmSync(paths.state, { force: true });
  const argv = hostArgv(opts.castArgv, paths.spec, opts.shellPrefix);
  // A label of its own per launch: the unload a dying host sends for its own job must never
  // reach the host that replaces it under the same session id.
  const label = `${paths.label}.${Date.now().toString(36)}`;
  const env: Record<string, string | undefined> = { ...(opts.env ?? process.env), ...(dir !== sdkHostDir() ? { CODECAST_CLAUDE_SDK_DIR: dir } : {}) };
  const viaLaunchd = !opts.noLaunchd && await startLaunchdJobAsync({ label, argv, plistPath: paths.plist, logPath: paths.log, env });
  // launchd holds a loaded job without its plist, and a refused one never needs it: the plist
  // carries the daemon's environment, so it does not stay on disk either way.
  fs.rmSync(paths.plist, { force: true });
  let childPid: number | undefined;
  if (!viaLaunchd) {
    const log = fs.openSync(paths.log, "a", 0o600);
    try {
      // Not a launchd job: a label inherited from the daemon's own job must not read as the host's.
      const childEnv = { ...env };
      delete childEnv[LAUNCHD_LABEL_ENV];
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", log, log], env: childEnv as NodeJS.ProcessEnv });
      childPid = child.pid;
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  }
  opts.log?.(`[claude-sdk] started host for ${spec.sessionId.slice(0, 8)} via ${viaLaunchd ? "launchd" : "detached spawn"}`);
  const client = new SdkHostClient(spec.sessionId, dir);
  const deadline = Date.now() + (opts.startTimeoutMs ?? 90_000);
  for (;;) {
    try {
      await client.connect(2_000);
      return client;
    } catch (err) {
      if (Date.now() > deadline) {
        // A host that comes up after the caller gave up would run beside whatever replaces it.
        if (viaLaunchd) stopLaunchdJob(label);
        else if (childPid) try { process.kill(-childPid, "SIGKILL"); } catch { try { process.kill(childPid, "SIGKILL"); } catch {} }
        let tail = "";
        try { tail = fs.readFileSync(paths.log, "utf-8").split("\n").slice(-5).join("\n"); } catch {}
        throw new Error(`Claude SDK host did not start: ${(err as Error).message}${tail ? `\n${tail}` : ""}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Reattach to a host a previous daemon started. Null only when its process is
 * gone; a live host that does not answer within `waitMs` (a machine under
 * load) throws, so the caller retries rather than starting a second Claude on
 * the same session.
 */
export async function attachSdkHost(sessionId: string, dir?: string, waitMs = 60_000): Promise<SdkHostClient | null> {
  const state = readHostState(sessionId, dir);
  if (!state || !(await hostProcessAlive(state.pid))) return null;
  const client = new SdkHostClient(sessionId, dir);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await client.connect();
      return client;
    } catch (err) {
      if (!(await hostProcessAlive(state.pid))) return null;
      if (Date.now() > deadline) throw new Error(`Claude SDK host ${state.pid} for ${sessionId} is running but not answering: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Remove what a dead host left behind (state, spec, plist, socket); `withLog` also its log, once the session is forgotten. */
export function cleanupDeadHost(sessionId: string, dir?: string, withLog = false): void {
  const p = sdkHostPaths(sessionId, dir);
  // A host killed outright never unloaded its own job; its state names the job's label.
  const label = readHostState(sessionId, dir)?.launchdLabel;
  if (label) stopLaunchdJob(label);
  for (const f of [p.state, p.spec, p.plist, p.socket, ...(withLog ? [p.log] : [])]) fs.rmSync(f, { force: true });
}
