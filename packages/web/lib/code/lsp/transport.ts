// @codemirror/lsp-client's Transport over the daemon's /lsp/ws. One transport
// is one (vault, server) socket: it says hello, waits for the daemon to start
// (or reattach to) the server, relays JSON-RPC as text frames, and reconnects
// with backoff when the socket drops. Its connection state is observable so a
// status chip can show starting, ready, restarting, unavailable or crashed.
//
// Every "ready" means a server that expects initialize: a fresh process after a
// crash, or a warm one the daemon reattached to (it answers that initialize
// from cache). The pool reconnects its LSPClient on each one.
//
// It acks what it reads (LspWsAck), so the daemon stops reading a server that
// is outrunning the tab instead of queueing for it without bound.
//
// A socket can be open and still dead: a request goes out and its response
// never comes back. When the oldest unanswered request is RESPONSE_DEADLINE_MS
// old (four times that until the first response after ready, while a cold
// server loads its project), and no work-done progress is open, the state
// stays "ready" (the client keeps its documents) but carries `unresponsive`.
// Notifications prove nothing: a server can log while it answers nothing.
// restartServer() then closes the socket and says a fresh hello, so the daemon
// starts a new process and kills the old one even when that socket's relay is
// wedged.
//
// Protocol: packages/shared/contracts/codeProtocol.ts (LspWsHello, LspWsControl, LspWsAck).

import type { Transport } from "@codemirror/lsp-client";
import type { LspServerInfo, LspWsAck, LspWsControl, LspWsHello, LspWsRestart } from "@codecast/shared/contracts";
import type { VaultEndpoint } from "../../vault/client";
import { hostOfEndpoint, hostOfVault, onHostEndpointChange, reestablishHost, routeEndpoint, wireVaultId } from "../../vault/hosts/routes";

export type LspStatus =
  /** Connecting, or waiting for the daemon to start the server. */
  | "starting"
  | "ready"
  /** The server crashed and the daemon is starting it again. */
  | "restarting"
  /** Not installed, or refused; see `reason` and `installHint`. Final until retry(). */
  | "unavailable"
  /** Crashed too often; the daemon gave up. Final until retry(). */
  | "crashed"
  /** No daemon to talk to. Keeps retrying. */
  | "offline";

export interface LspConnectionState {
  status: LspStatus;
  server?: LspServerInfo;
  rootUri?: string;
  reason?: string;
  installHint?: string;
  /** Ready, but a request has gone unanswered past the deadline. */
  unresponsive?: boolean;
}

export type LspEndpointResolver = () => VaultEndpoint | null | Promise<VaultEndpoint | null>;

type SocketCtor = new (url: string) => WebSocket;

export interface LspTransportOptions {
  vaultId: string;
  server: string;
  endpoint: LspEndpointResolver;
  /** Injected in tests. */
  WebSocket?: SocketCtor;
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** How long a request may go unanswered before the connection is unresponsive. */
  responseDeadlineMs?: number;
  /** How long a restart frame may go unanswered before the socket is replaced. */
  restartWatchdogMs?: number;
}

const OPEN = 1;
const ACK_EVERY_CHARS = 256 * 1024;
const RESPONSE_DEADLINE_MS = 15_000;
const RESTART_WATCHDOG_MS = 4_000;
/** lsp-client writes a request with these keys first (requestInner): its id. */
const requestId = (message: string) => /^\{"jsonrpc":"2\.0","id":([^,]+),"method":/.exec(message)?.[1] ?? null;
const ID = String.raw`("(?:[^"\\]|\\.)*"|-?\d+)`;
const HEAD_RESPONSE = new RegExp(String.raw`^\{(?:"jsonrpc":"2\.0",)?"id":${ID},"(?:result|error)"`);
const TAIL_ID = new RegExp(String.raw`"id":${ID}\}$`);
/** A server request or notification names its method before any nested object. */
const TOP_METHOD = /^\{[^{]*"method":/;
const PARSE_LIMIT = 64 * 1024;

/** The id a server's response answers, or null for anything else. Read off
 *  the message's ends; only a small message with its id elsewhere is parsed. */
function responseId(text: string): string | null {
  const head = HEAD_RESPONSE.exec(text);
  if (head) return head[1];
  if (TOP_METHOD.test(text)) return null;
  const tail = TAIL_ID.exec(text.length > 256 ? text.slice(-256) : text);
  if (tail) return tail[1];
  if (text.length > PARSE_LIMIT) return null;
  try {
    const m = JSON.parse(text) as { id?: unknown; method?: unknown };
    return m.method === undefined && (typeof m.id === "number" || typeof m.id === "string") ? JSON.stringify(m.id) : null;
  } catch {
    return null;
  }
}

/** A `$/progress` begin or end, by token. */
function progressEdge(text: string): { token: string; open: boolean } | null {
  if (text.length > 4096 || !text.includes('"$/progress"')) return null;
  const token = /"token":("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text)?.[1];
  const kind = /"kind":"(begin|end)"/.exec(text)?.[1];
  return token && kind ? { token, open: kind === "begin" } : null;
}
const FINAL: ReadonlySet<LspStatus> = new Set(["unavailable", "crashed"]);

/** The daemon writes control frames itself, always with `type` first; a
 *  JSON-RPC message never has a top-level `type`. Testing the prefix spares
 *  parsing every (possibly huge) server message just to route it. */
const isControlFrame = (text: string) => text.startsWith('{"type":');

/** Requests and responses carry an id; their sender must hear that the send
 *  failed. Notifications can be dropped: on reconnect the client opens every
 *  file again with its full text. */
function carriesId(message: string): boolean {
  try {
    const parsed = JSON.parse(message) as { id?: unknown };
    return parsed.id !== undefined && parsed.id !== null;
  } catch {
    return true;
  }
}

export class LspWebSocketTransport implements Transport {
  private handlers = new Set<(message: string) => void>();
  private listeners = new Set<(state: LspConnectionState) => void>();
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The cloud host the last connect went to, null for this machine. */
  private host: string | null = null;
  /** Waiting for an unreachable host's next forward. */
  private parked: (() => void) | null = null;

  private unpark(): void {
    this.parked?.();
    this.parked = null;
  }
  private retryMs: number;
  private disposed = false;
  private current: LspConnectionState = { status: "starting" };
  /** Requests sent and not yet answered: id -> when it went out. */
  private outstanding = new Map<string, number>();
  /** Work-done progress the server has begun and not ended. */
  private openProgress = new Set<string>();
  /** A response has arrived since the last ready. */
  private answered = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private restartWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** The next hello asks for a new process (LspWsHello.fresh). */
  private freshNext = false;
  /** This transport across its reconnects (LspWsHello.client): a fresh hello
   *  kills only the processes it held, never another window's. */
  private readonly client = Math.random().toString(36).slice(2) + Date.now().toString(36);

  constructor(private readonly opts: LspTransportOptions) {
    this.retryMs = opts.retryInitialMs ?? 500;
    void this.connect();
  }

  get state(): LspConnectionState {
    return this.current;
  }

  send(message: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === OPEN && this.current.status === "ready") {
      ws.send(message);
      const id = requestId(message);
      if (id !== null) {
        this.outstanding.set(id, Date.now());
        if (!this.silenceTimer) this.armDeadline();
      }
      return;
    }
    if (carriesId(message)) throw new Error(`language server is ${this.current.status}`);
  }

  subscribe(handler: (message: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (message: string) => void): void {
    this.handlers.delete(handler);
  }

  /** Called with the current state now and on every change. */
  onState(listener: (state: LspConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  /** Ask the daemon for a fresh server process. Over a socket that answers,
   *  a restart frame (LspWsRestart); if it goes unanswered, or the socket had
   *  already stopped answering, a new socket with a fresh hello. False when
   *  there is no socket to restart through. */
  restartServer(): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    if (this.current.unresponsive) {
      this.reconnectFresh();
      return true;
    }
    ws.send(JSON.stringify({ type: "restart" } satisfies LspWsRestart));
    if (this.restartWatchdog) clearTimeout(this.restartWatchdog);
    this.restartWatchdog = setTimeout(() => {
      this.restartWatchdog = null;
      if (this.ws === ws) this.reconnectFresh();
    }, this.opts.restartWatchdogMs ?? RESTART_WATCHDOG_MS);
    return true;
  }

  /** A new socket whose hello asks for a new process (LspWsHello.fresh): the
   *  daemon kills what this browser held, so it works even when the old
   *  socket, or the process behind it, never answers again. */
  reconnectFresh(): void {
    if (this.disposed) return;
    this.freshNext = true;
    this.retry();
  }

  /** Time the oldest unanswered request against the deadline. Open progress
   *  defers the verdict; its end (heard) arms the timer again. */
  private armDeadline(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const oldest = Math.min(...this.outstanding.values());
    if (!Number.isFinite(oldest)) return;
    const deadline = (this.opts.responseDeadlineMs ?? RESPONSE_DEADLINE_MS) * (this.answered ? 1 : 4);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.current.status !== "ready" || !this.outstanding.size) return;
      // The server says it is working: wait for its progress to end.
      if (this.openProgress.size) return;
      this.setState({ ...this.current, unresponsive: true });
    }, Math.max(0, oldest + deadline - Date.now()));
  }

  /** A server message: a response settles its request, progress shows work. */
  private heard(text: string): void {
    const edge = progressEdge(text);
    if (edge) {
      if (edge.open) this.openProgress.add(edge.token);
      else if (this.openProgress.delete(edge.token) && !this.openProgress.size && this.outstanding.size) {
        // The work it reported is done: its requests' time starts now.
        const now = Date.now();
        for (const id of this.outstanding.keys()) this.outstanding.set(id, now);
        this.armDeadline();
      }
    }
    if (!this.outstanding.size) return;
    const id = responseId(text);
    if (id === null || !this.outstanding.delete(id)) return;
    this.answered = true;
    this.armDeadline();
    if (this.current.unresponsive) this.setState({ ...this.current, unresponsive: undefined });
  }

  /** Reconnect now, including after unavailable or crashed. */
  retry(): void {
    if (this.disposed) return;
    this.unpark();
    this.retryMs = this.opts.retryInitialMs ?? 500;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
    void this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.unpark();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.drop();
    this.handlers.clear();
    this.listeners.clear();
  }

  private setState(next: LspConnectionState): void {
    const prev = this.current;
    if (prev.status === next.status && prev.reason === next.reason && prev.server === next.server && !prev.unresponsive === !next.unresponsive) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.outstanding.clear();
    this.openProgress.clear();
    this.answered = false;
    for (const t of [this.silenceTimer, this.restartWatchdog]) if (t) clearTimeout(t);
    this.silenceTimer = this.restartWatchdog = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    // Offline stays offline across retries rather than flickering to starting.
    if (this.current.status !== "starting" && this.current.status !== "offline") this.setState({ status: "starting" });
    let ep: VaultEndpoint | null = null;
    try {
      ep = await this.opts.endpoint();
    } catch {}
    if (this.disposed || this.ws) return;
    if (!ep) {
      this.setState({ status: "offline", reason: "no codecast daemon on this machine" });
      return this.scheduleRetry();
    }
    // The server runs on the vault's own machine: a cloud host's vault
    // reaches the host's daemon (its binaries, its checkout) through the
    // forward, re-routed on every attempt since a forward can reopen on a
    // new port.
    const routed = routeEndpoint(ep, this.opts.vaultId);
    this.host = hostOfVault(this.opts.vaultId) ?? hostOfEndpoint(routed);
    if (!routed) {
      // The host's forward is closed (the retry reopens it), or this
      // machine's daemon is not known yet.
      this.setState({ status: "offline", reason: this.host ? "cloud host not reachable" : "no codecast daemon on this machine" });
      return this.scheduleRetry();
    }
    ep = routed;
    const Ctor = this.opts.WebSocket ?? WebSocket;
    const ws = new Ctor(`ws://127.0.0.1:${ep.port}/lsp/ws`);
    const token = ep.token;
    this.ws = ws;
    let received = 0;
    let acked = 0;
    ws.onopen = () => {
      const hello: LspWsHello = { type: "hello", token, vault: wireVaultId(this.opts.vaultId), server: this.opts.server, acks: true, client: this.client, ...(this.freshNext ? { fresh: true } : {}) };
      this.freshNext = false;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ws !== this.ws) return;
      const text = String(ev.data);
      received += text.length;
      // Any frame at all answers a restart frame's watchdog.
      if (this.restartWatchdog) {
        clearTimeout(this.restartWatchdog);
        this.restartWatchdog = null;
      }
      if (received - acked >= ACK_EVERY_CHARS) ws.send(JSON.stringify({ type: "ack", chars: (acked = received) } satisfies LspWsAck));
      this.onFrame(text);
    };
    ws.onclose = () => {
      if (ws === this.ws) this.onClose();
    };
    ws.onerror = () => ws.close();
  }

  private onFrame(text: string): void {
    if (!isControlFrame(text)) {
      this.heard(text);
      for (const handler of [...this.handlers]) handler(text);
      return;
    }
    let frame: LspWsControl | { type: "error"; message: string };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame.type) {
      case "ready":
        this.retryMs = this.opts.retryInitialMs ?? 500;
        // A new or reattached process: whatever was asked before is moot.
        this.outstanding.clear();
        this.openProgress.clear();
        this.answered = false;
        if (this.silenceTimer) clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
        return this.setState({ status: "ready", server: frame.server, rootUri: frame.root_uri });
      case "unavailable":
        return this.setState({ status: "unavailable", reason: frame.reason, installHint: frame.install_hint });
      case "exit":
        return this.setState({
          status: frame.restarting ? "restarting" : "crashed",
          server: this.current.server,
          reason: frame.reason ?? (frame.signal ? `killed by ${frame.signal}` : `exited with code ${frame.code}`),
        });
      case "error":
        // A refused hello (stale token after a daemon restart, say); the close
        // that follows reconnects through a fresh endpoint.
        return this.setState({ status: "starting", reason: frame.message });
    }
  }

  private onClose(): void {
    this.drop();
    if (this.disposed || FINAL.has(this.current.status)) return;
    this.setState({ status: "starting", reason: this.current.reason });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // A host's forward may have closed while idle: reopen it first. A host
      // that cannot be reached is not asked again on a timer (a relay round
      // and an ssh probe each); the next forward anything opens resumes it.
      const host = this.host;
      if (!host) return void this.connect();
      void reestablishHost(host).then((fresh) => {
        if (this.disposed) return;
        if (fresh) return void this.connect();
        this.unpark();
        this.parked = onHostEndpointChange((device, ep) => {
          if (device !== host || !ep) return;
          this.unpark();
          this.retryMs = this.opts.retryInitialMs ?? 500;
          void this.connect();
        });
      });
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.opts.retryMaxMs ?? 15_000);
  }
}
