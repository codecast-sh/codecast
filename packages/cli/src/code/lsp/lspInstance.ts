// One language server process and the socket currently driving it.
//
// The daemon relays JSON-RPC verbatim in both directions and inspects only what
// it must to keep a process reusable across sockets:
//
// - initialize. The first answer is cached. A socket that reattaches to a warm
//   process (a reload inside the grace period) re-sends initialize; it gets the
//   cached result and its `initialized` is dropped if the server already had
//   one. Restarting instead would throw away the index, which is the point of
//   the grace period. The daemon also fills in what the browser cannot know:
//   its own pid (so a server outlives no daemon), the root folders, and the
//   server's default initializationOptions (the project's tsserver).
// - detach. When a socket goes, its open documents are closed, its pending
//   requests are cancelled and their late answers dropped, and the server's
//   pending requests to it are answered with an error so the server never
//   waits on a client that is gone. The next client then starts clean.
// - ids. A reattached client numbers its requests from 1 again; an id that
//   still has a cancelled request in flight is renamed on the way in and back
//   on the way out, so a late answer never reaches the wrong request. Big
//   messages keep this bookkeeping without being parsed (envelope.ts).
// - back-pressure. For a browser that sends acks (LspWsHello.acks), the relay
//   pauses while more than ACK_HIGH_WATER chars it was sent are unacknowledged:
//   the server's stdout stops, and messages already read wait in `held` (bun
//   reads a pipe in chunks of tens of megabytes). The socket cannot report this
//   itself under bun, the daemon's runtime: once its native queue backs up, the
//   `ws` shim stops lowering bufferedAmount, skips send callbacks, re-sends one
//   frame many times and drops the rest.
//
//   The other direction never pauses the socket. A paused socket stops
//   delivering everything behind the stalled message, including a person's
//   Restart and the browser's close, and node's ws (the npm build bundles it)
//   resumes only on a stdin 'drain' that never comes if the process exits
//   first. Instead the relay counts what it queued for a server that stopped
//   reading (bun's stdin reports writableLength 0 however much is queued) and
//   kills a server that lets STDIN_MAX_QUEUED build up: the crash and restart
//   path then takes over.

import * as path from "path";
import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "../../proc.js";
import type { LspServerInfo, LspWsAck, LspWsControl, LspWsRestart } from "@codecast/shared/contracts";
import { isPlainObject, readEnvelope, type Envelope, type Id, type Message } from "./envelope.js";
import { LspFrameReader, encodeLspFrame } from "./framing.js";
import type { LspLaunch } from "./registry.js";

/** Unacknowledged chars past which the server's output is paused, and below
 *  which it resumes. The high mark keeps bun's native queue under its limit. */
const ACK_HIGH_WATER = 4 * 1024 * 1024;
const ACK_LOW_WATER = 1024 * 1024;
/** Input queued for a server that is not reading, past which it is wedged. */
const STDIN_MAX_QUEUED = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const STDERR_LINES_PER_MINUTE = 30;
const STDERR_LINE_MAX = 400;

const ERR_INTERNAL = -32603;
const ERR_CANCELLED = -32800;

let instanceSeq = 0;

const idKey = (id: Id) => (typeof id === "number" ? `n${id}` : `s${id}`);

/** `given` wins; nested objects merge. */
function mergeDefaults(defaults: Record<string, unknown> | undefined, given: unknown): unknown {
  if (!defaults) return given;
  if (!isPlainObject(given)) return given === undefined || given === null ? defaults : given;
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(given)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDefaults(out[k] as Record<string, unknown>, v) : v;
  return out;
}

export interface LspInstanceHost {
  log(msg: string): void;
  /** Whether a crash may be followed by a restart; records the crash. */
  allowRestart(key: string): boolean;
  restartDelayMs(key: string): number;
  /** Input queued for a server that is not reading, past which it is wedged. */
  readonly stdinMaxQueued?: number;
  /** The socket went away cleanly; keep the process warm or drop it. */
  parked(inst: LspInstance): void;
  gone(inst: LspInstance): void;
}

export class LspInstance {
  socket: WebSocket | null = null;
  private child: ChildProcess | null = null;
  private disposed = false;
  /** Order of creation: a fresh hello disposes older ones (lspServer.ts). */
  readonly seq = ++instanceSeq;
  /** LspWsHello.client of the socket attached now, or last, if it named one. */
  client: string | undefined;
  private relayPaused = false;
  /** Bytes written to the current stdin since a write returned false and
   *  before it drained; null while it keeps up. Per process. */
  private stdinBacklog: number | null = null;
  /** Server messages read while the relay was paused, in order. */
  private held: string[] = [];
  // Per socket: chars sent to it, and acknowledged by it when it acks.
  private acks = false;
  private sentChars = 0;
  private ackedChars = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartRequested = false;

  // Per process; reset when it exits.
  private initResult: unknown = undefined;
  private initPendingKey: string | null = null;
  private initWaiters: Id[] = [];
  private initializedSent = false;
  private shuttingDown = false;
  private openDocs = new Set<string>();
  /** Client requests the server has not answered, by wire id. */
  private clientPending = new Map<string, Id>();
  /** Wire ids of requests whose client is gone: their answers are dropped. */
  private orphans = new Set<string>();
  /** Renamed wire id -> the client's own id. */
  private renamed = new Map<string, Id>();
  private renameSeq = 0;
  /** Server-to-client requests the client has not answered. */
  private serverPending = new Map<string, Id>();

  private stderrBudget = { windowStart: 0, used: 0, dropped: 0 };
  private stderrPartial = "";
  private lastStderr = "";

  constructor(
    readonly key: string,
    readonly vaultId: string,
    readonly root: string,
    readonly rootUri: string,
    readonly info: LspServerInfo,
    private readonly launch: LspLaunch,
    private readonly host: LspInstanceHost,
  ) {}

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  private get label(): string {
    return `[LSP] ${this.info.id} ${path.basename(this.root)}`;
  }

  /** Spawn the process. Rejects when it cannot start at all (ENOENT, EACCES),
   *  or when the instance was disposed while it started. */
  async start(): Promise<void> {
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.root,
      env: this.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a kill takes the server's helpers with it
      // (typescript-language-server runs tsserver as a child).
      detached: process.platform !== "win32",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // Disposed while spawning (the socket left mid-restart, the routes closed):
    // dispose had no process to stop, so this one must not outlive it.
    if (this.disposed) {
      this.signal("SIGKILL", child);
      throw new Error("language server closed while starting");
    }
    this.child = child;
    const reader = new LspFrameReader({
      message: (json) => (this.relayPaused ? this.held.push(json) : this.fromServer(json)),
      oversize: (bytes) => this.host.log(`${this.label} dropped a ${bytes}-byte message over the cap`),
      error: (reason) => {
        this.host.log(`${this.label} wrote a broken frame (${reason}); restarting it`);
        this.signal("SIGKILL");
      },
    });
    child.stdout!.on("data", (chunk: Buffer) => reader.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => this.onStderr(chunk));
    // A write after the server died raises EPIPE here; the exit handler owns it.
    child.stdin!.on("error", () => {});
    child.on("error", (err) => this.host.log(`${this.label} process error: ${err.message}`));
    child.once("exit", (code, signal) => {
      if (this.child === child) this.onExit(code, signal);
    });
  }

  attach(ws: WebSocket, opts: { acks?: boolean; client?: string } = {}): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.socket = ws;
    this.client = opts.client;
    this.acks = !!opts.acks;
    this.sentChars = this.ackedChars = 0;
    ws.on("message", (raw, isBinary) => {
      if (this.socket !== ws || isBinary) return;
      const text = raw.toString("utf8");
      if (text.startsWith('{"type":')) this.onControl(text);
      else this.fromClient(text);
    });
    const onGone = () => {
      if (this.socket === ws) this.detach();
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
    this.control({ type: "ready", server: { ...this.info, running: true }, root_uri: this.rootUri });
  }

  private control(frame: LspWsControl): void {
    this.sendToClient(JSON.stringify(frame));
  }

  /** Browser control frames: acks, and a restart asked for by a person. */
  private onControl(text: string): void {
    let frame: Partial<LspWsAck> | Partial<LspWsRestart>;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === "restart") return this.restart();
    if (frame.type !== "ack" || typeof frame.chars !== "number") return;
    this.ackedChars = Math.max(this.ackedChars, frame.chars);
    if (this.relayPaused && this.sentChars - this.ackedChars <= ACK_LOW_WATER) this.resumeRelay();
  }

  // ── Client to server ──────────────────────────────────────────────────────

  private fromClient(text: string): void {
    const env = readEnvelope(text);
    if (!env) return;
    const isRequest = env.id !== undefined && env.method !== undefined;
    if (!this.alive) {
      if (isRequest) this.replyToClient(env.id!, { error: { code: ERR_INTERNAL, message: "language server is restarting" } });
      return;
    }
    if (isRequest && env.method === "initialize") {
      const msg = env.full();
      return msg ? this.clientInitialize(env.id!, msg) : undefined;
    }

    switch (env.method) {
      case "initialized":
        if (this.initializedSent) return;
        this.initializedSent = true;
        break;
      case "textDocument/didOpen":
      case "textDocument/didClose": {
        const uri = env.uri ?? env.full()?.params?.textDocument?.uri;
        if (typeof uri !== "string") break;
        if (env.method === "textDocument/didOpen") this.openDocs.add(uri);
        else this.openDocs.delete(uri);
        break;
      }
      case "shutdown":
        this.shuttingDown = true;
        break;
      case "$/cancelRequest": {
        // A request renamed on the way in is known to the server by its wire
        // id; a cancel naming the client's id must reach that one.
        const wire = this.renamedWireId(env.full()?.params?.id);
        if (wire !== undefined) {
          const msg = env.full()!;
          return this.toServer(JSON.stringify({ ...msg, params: { ...msg.params, id: wire } }));
        }
        break;
      }
    }

    if (isRequest) {
      const key = idKey(env.id!);
      if (this.orphans.has(key)) {
        const wire = `codecast-${++this.renameSeq}`;
        this.renamed.set(idKey(wire), env.id!);
        this.clientPending.set(idKey(wire), wire);
        return this.toServer(env.withId(wire));
      }
      this.clientPending.set(key, env.id!);
    } else if (env.id !== undefined) {
      this.serverPending.delete(idKey(env.id));
    }
    this.toServer(text);
  }

  /** The wire id a still-pending client request was renamed to, if it was. */
  private renamedWireId(id: unknown): Id | undefined {
    if (typeof id !== "number" && typeof id !== "string") return undefined;
    for (const [wireKey, original] of this.renamed) {
      if (original === id && this.clientPending.has(wireKey)) return this.clientPending.get(wireKey);
    }
    return undefined;
  }

  private clientInitialize(id: Id, msg: Message): void {
    if (this.initResult !== undefined) return this.replyToClient(id, { result: this.initResult });
    if (this.initPendingKey) {
      this.initWaiters.push(id);
      return;
    }
    const params: Record<string, unknown> = { ...(msg.params ?? {}) };
    params.processId = process.pid;
    params.rootUri ??= this.rootUri;
    params.rootPath ??= this.root;
    params.workspaceFolders ??= [{ uri: this.rootUri, name: path.basename(this.root) }];
    params.initializationOptions = mergeDefaults(this.launch.initializationOptions, params.initializationOptions);
    this.initPendingKey = idKey(id);
    this.clientPending.set(this.initPendingKey, id);
    this.toServer(JSON.stringify({ ...msg, params }));
  }

  private toServer(json: string): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    const frame = encodeLspFrame(json);
    const flowing = stdin.write(frame);
    if (this.stdinBacklog !== null) this.stdinBacklog += frame.length;
    else if (!flowing) {
      // One drain listener per stall, on this process's stdin: a drain from a
      // process that has since been replaced changes nothing.
      this.stdinBacklog = frame.length;
      stdin.once("drain", () => {
        if (this.child?.stdin === stdin) this.stdinBacklog = null;
      });
    }
    const queued = Math.max(this.stdinBacklog ?? 0, stdin.writableLength);
    if (queued > (this.host.stdinMaxQueued ?? STDIN_MAX_QUEUED)) {
      this.host.log(`${this.label} stopped reading its input (${queued} bytes queued); killing it`);
      this.stdinBacklog = null;
      this.signal("SIGKILL");
    }
  }

  /** Bytes queued for a server that is not reading (tests). */
  get stdinQueued(): number {
    return this.stdinBacklog ?? 0;
  }

  // ── Server to client ──────────────────────────────────────────────────────

  private fromServer(text: string): void {
    const env = readEnvelope(text);
    if (env?.id !== undefined) {
      const key = idKey(env.id);
      if (env.method === undefined) {
        if (key === this.initPendingKey) this.settleInitialize(env);
        this.clientPending.delete(key);
        if (this.orphans.delete(key)) return;
        const original = this.renamed.get(key);
        if (original !== undefined) {
          this.renamed.delete(key);
          return this.sendToClient(env.withId(original));
        }
      } else {
        if (!this.socket) return this.toServer(JSON.stringify({ jsonrpc: "2.0", id: env.id, error: { code: ERR_CANCELLED, message: "no editor is attached" } }));
        this.serverPending.set(key, env.id);
      }
    }
    this.sendToClient(text);
  }

  private settleInitialize(env: Envelope): void {
    const msg = env.full() ?? { error: { code: ERR_INTERNAL, message: "unreadable initialize result" } };
    this.initPendingKey = null;
    const waiters = this.initWaiters;
    this.initWaiters = [];
    if (msg.error === undefined) this.initResult = msg.result ?? null;
    for (const id of waiters) this.replyToClient(id, msg.error === undefined ? { result: this.initResult } : { error: msg.error });
  }

  private replyToClient(id: Id, body: { result?: unknown; error?: unknown }): void {
    this.sendToClient(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  }

  private sendToClient(json: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(json);
    this.sentChars += json.length;
    if (this.acks && !this.relayPaused && this.sentChars - this.ackedChars > ACK_HIGH_WATER) {
      this.relayPaused = true;
      this.child?.stdout?.pause();
    }
  }

  private resumeRelay(): void {
    this.relayPaused = false;
    while (this.held.length > 0 && !this.relayPaused) this.fromServer(this.held.shift()!);
    if (!this.relayPaused) this.child?.stdout?.resume();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** The socket is gone. Leave the server as a fresh client would find it. */
  private detach(): void {
    this.socket = null;
    // Held messages still carry answers the bookkeeping below must see.
    if (this.relayPaused) this.resumeRelay();
    if (!this.alive || this.shuttingDown) return this.dispose();
    for (const uri of this.openDocs) {
      this.toServer(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } }));
    }
    this.openDocs.clear();
    for (const [key, id] of this.clientPending) {
      // initialize is not cancelled: its answer is what the next client gets,
      // through settleInitialize, and the raw answer is then dropped.
      if (key !== this.initPendingKey) this.toServer(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }));
      this.orphans.add(key);
    }
    this.clientPending.clear();
    this.renamed.clear();
    for (const id of this.serverPending.values()) {
      this.toServer(JSON.stringify({ jsonrpc: "2.0", id, error: { code: ERR_CANCELLED, message: "the editor closed" } }));
    }
    this.serverPending.clear();
    this.host.parked(this);
  }

  /** Stop this process and start a fresh one, without counting a crash: a
   *  person asked (the status chip's Restart), usually because the server
   *  wedged, so a server that ignores SIGTERM is killed after the grace. */
  restart(): void {
    const child = this.child;
    if (!child || !this.alive || this.restartRequested) return;
    this.restartRequested = true;
    this.host.log(`${this.label} restarting on request`);
    this.signal("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) this.signal("SIGKILL", child);
    }, KILL_GRACE_MS);
    force.unref?.();
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const requested = this.restartRequested;
    this.restartRequested = false;
    this.flushStderr();
    // What the server said before it died arrives before the news that it did.
    this.relayPaused = false;
    for (const json of this.held.splice(0)) this.fromServer(json);
    const socket = this.socket;
    const pending = [...this.clientPending.entries(), ...this.initWaiters.map((id) => [idKey(id), id] as const)];
    this.child = null;
    this.resetProcessState();
    if (this.disposed) return;
    if (!socket || this.shuttingDown) {
      this.control({ type: "exit", code, signal, restarting: false });
      socket?.close(1000, "server exited");
      return this.dispose();
    }

    const reason = requested ? "restarted" : this.lastStderr || undefined;
    const restarting = requested || this.host.allowRestart(this.key);
    this.host.log(`${this.label} exited (code ${code}, signal ${signal})${restarting ? ", restarting" : ", giving up"}${reason ? `: ${reason}` : ""}`);
    for (const [key, id] of pending) {
      this.replyToClient(this.renamed.get(key) ?? id, { error: { code: ERR_INTERNAL, message: "language server exited" } });
    }
    this.renamed.clear();
    this.control({ type: "exit", code, signal, restarting, ...(reason ? { reason } : {}) });
    if (!restarting) {
      socket.close(4002, "language server crashed");
      return this.dispose();
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      this.start().then(
        () => (this.socket ? this.control({ type: "ready", server: { ...this.info, running: true }, root_uri: this.rootUri }) : this.host.parked(this)),
        (err: Error) => {
          if (this.disposed) return;
          this.control({ type: "unavailable", server: this.info.id, reason: `could not restart: ${err.message}` });
          this.socket?.close(4002, "language server crashed");
          this.dispose();
        },
      );
    }, requested ? 0 : this.host.restartDelayMs(this.key));
  }

  private resetProcessState(): void {
    this.initResult = undefined;
    this.initPendingKey = null;
    this.initWaiters = [];
    this.initializedSent = false;
    this.shuttingDown = false;
    this.openDocs.clear();
    this.clientPending.clear();
    this.orphans.clear();
    this.serverPending.clear();
    this.stdinBacklog = null;
    // A new process starts reading; the next send pauses it if still behind.
    this.relayPaused = false;
  }

  /** Stop the process tree for good. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (child && this.alive) {
      this.signal("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) this.signal("SIGKILL", child);
      }, KILL_GRACE_MS);
      force.unref?.();
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, "closed");
    this.socket = null;
    this.host.gone(this);
  }

  /** Signal the whole process group. Sync, so it can run in an exit hook. */
  signal(sig: NodeJS.Signals, child = this.child): void {
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  }

  // ── Stderr ────────────────────────────────────────────────────────────────

  private onStderr(chunk: Buffer): void {
    const lines = (this.stderrPartial + chunk.toString("utf8")).split("\n");
    this.stderrPartial = lines.pop() ?? "";
    if (this.stderrPartial.length > STDERR_LINE_MAX) {
      lines.push(this.stderrPartial);
      this.stderrPartial = "";
    }
    for (const line of lines) this.stderrLine(line);
  }

  private flushStderr(): void {
    if (this.stderrPartial) this.stderrLine(this.stderrPartial);
    this.stderrPartial = "";
  }

  /** Servers log freely (rust-analyzer can write thousands of lines while it
   *  indexes), so the daemon log gets a bounded sample per minute. */
  private stderrLine(raw: string): void {
    const line = raw.trim().slice(0, STDERR_LINE_MAX);
    if (!line) return;
    this.lastStderr = line;
    const b = this.stderrBudget;
    const now = Date.now();
    if (now - b.windowStart > 60_000) {
      if (b.dropped) this.host.log(`${this.label} stderr: ${b.dropped} more lines not logged`);
      b.windowStart = now;
      b.used = 0;
      b.dropped = 0;
    }
    if (b.used++ < STDERR_LINES_PER_MINUTE) this.host.log(`${this.label} stderr: ${line}`);
    else b.dropped++;
  }
}
