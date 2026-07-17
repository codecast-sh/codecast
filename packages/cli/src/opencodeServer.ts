// OpenCode's optional RICH transport — a daemon-owned `opencode serve` sidecar
// reached over HTTP + SSE. This is to opencode what codexAppServer.ts is to codex:
// an opt-in richer channel that ADDS to the plain path, never replaces it. When no
// server is attachable the wave-3 DB-polling path (OpencodeStorageWatcher) keeps
// working unchanged — every capability here degrades away cleanly.
//
// What this sidecar can and cannot do was settled by live investigation against
// opencode 1.18.3 (recorded on ct-39079). The two facts that shape the design:
//
//   1. opencode's SQLite store (~/.local/share/opencode/opencode.db) is SHARED by
//      every opencode process. So DB-backed API calls — most importantly
//      POST /session/{id}/fork — act on ANY session by id, regardless of which
//      process created it. Verified: forking a session created by a different
//      process minted a real `ses_*` id with its messages copied.
//
//   2. opencode's live event bus (GET /event, Server-Sent Events) is PER-PROCESS.
//      A standalone `opencode serve` NEVER receives events for a session driven by
//      a different opencode process (TUI / `opencode run`), even in the same project
//      — verified: a full turn driven through a second serve instance was invisible
//      on the first instance's /event stream though it persisted to the shared DB.
//      A normally-launched TUI also exposes no discoverable server of its own.
//
// The consequence: this transport's FORK helper works for any codecast opencode
// session (they all live in the shared DB), while its SSE stream accelerates STATE
// only for sessions DRIVEN THROUGH THIS SERVER (created + prompted via the API).
// It does not — and cannot — accelerate a tmux-TUI session's state; the DB watcher
// stays authoritative for those. Callers gate on the registry capabilities
// (`forkApi`, `liveEvents`) accordingly.
//
// The DB path stays authoritative for transcript CONTENT in every case: this module
// never syncs message bodies. SSE carries STATE (working / idle / permission) only.

import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";

/** Coarse work-state the daemon's `sendAgentStatus` understands. The SSE stream is
 *  mapped down to this; content deltas are ignored (the DB path owns content). */
export type OpencodeWorkState = "working" | "idle" | "permission_blocked";

/** One decoded SSE event off `GET /event`: `{ id, type, properties }`. */
export interface OpencodeRawEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
}

/** A raw event enriched with the session it concerns and, when the event is
 *  state-bearing, the work-state it implies. Content-only events (message.part.*)
 *  carry a sessionId but no workState. */
export interface OpencodeServerEvent {
  type: string;
  sessionId?: string;
  workState?: OpencodeWorkState;
  raw: OpencodeRawEvent;
}

/** opencode session object (the fields we use), returned by create/fork/list. */
export interface OpencodeApiSession {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  parentID?: string;
  slug?: string;
}

export interface OpencodeForkOptions {
  /** Fork at a specific message; omit to fork at the tip. */
  messageID?: string;
  /** Override the forked session's working directory (defaults to the parent's). */
  directory?: string;
}

export interface OpencodeServerOptions {
  log: (msg: string) => void;
  /** TCP port to bind. 0 / undefined → bind an OS-chosen port and self-discover it
   *  from the server's announce line (race-free, no pre-bind probe). */
  port?: number;
  hostname?: string;
  /** Directory the sidecar runs in — sets its project scope (git root, or "global"
   *  for a non-git dir). Fork/list see the sessions of THIS project. */
  cwd?: string;
  opencodeBinary?: string;
  /** Injectable for tests. Defaults to child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** How long to wait for the server to answer /global/health before giving up on
   *  a spawn attempt. */
  healthTimeoutMs?: number;
  /** Stop the sidecar after this many ms with no fork activity. The serve process
   *  binds 127.0.0.1 but has NO auth (opencode serve offers none), so a live
   *  instance is an unauthenticated local HTTP surface; bounding its lifetime to
   *  "shortly after the last fork" instead of "forever after the first fork" keeps
   *  the exposure window to a single fork burst. 0 disables the timeout. */
  idleTimeoutMs?: number;
}

// ── Pure helpers (unit-tested with fixtures) ──────────────────────────────────

const LISTENING_RE = /listening on\s+https?:\/\/[^\s:]+:(\d+)/i;

/** Parse the port opencode announces at boot, e.g.
 *  "opencode server listening on http://127.0.0.1:41968" → 41968. null if absent. */
export function parseListeningPort(line: string): number | null {
  const m = LISTENING_RE.exec(line);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Split a growing SSE buffer into complete events. Frames are separated by a blank
 * line; within a frame every `data:` line is concatenated per the SSE spec, and the
 * joined payload is JSON-parsed. Non-`data:` fields (`id:`, `:comment`, heartbeats)
 * are ignored. Returns the parsed events plus the unconsumed tail (a partial frame)
 * to carry into the next chunk. Unparseable payloads are dropped, not thrown.
 */
export function parseSseFrames(buffer: string): { events: OpencodeRawEvent[]; rest: string } {
  const events: OpencodeRawEvent[] = [];
  // Normalize CRLF so the frame delimiter is a single "\n\n".
  const normalized = buffer.replace(/\r\n/g, "\n");
  const lastBreak = normalized.lastIndexOf("\n\n");
  if (lastBreak === -1) return { events, rest: normalized };

  const complete = normalized.slice(0, lastBreak);
  const rest = normalized.slice(lastBreak + 2);

  for (const frame of complete.split("\n\n")) {
    const dataParts: string[] = [];
    for (const rawLine of frame.split("\n")) {
      if (rawLine.startsWith("data:")) {
        // A single leading space after the colon is part of the field syntax.
        dataParts.push(rawLine.slice(rawLine.startsWith("data: ") ? 6 : 5));
      }
    }
    if (dataParts.length === 0) continue;
    const payload = dataParts.join("\n");
    if (!payload.trim()) continue;
    try {
      const obj = JSON.parse(payload) as OpencodeRawEvent;
      if (obj && typeof obj.type === "string") events.push(obj);
    } catch {
      /* drop partial/garbage payloads */
    }
  }
  return { events, rest };
}

function propSessionId(raw: OpencodeRawEvent): string | undefined {
  const sid = raw.properties?.sessionID;
  return typeof sid === "string" ? sid : undefined;
}

/**
 * Map a raw opencode event to the typed shape the daemon consumes, deriving a
 * work-state for the state-bearing events only. Everything else passes through with
 * its sessionId so callers can observe activity without changing state:
 *
 *   session.status  → status.type "idle" → idle;  anything else (busy/retry) → working
 *   session.idle    → idle  (turn complete)
 *   session.error   → idle  (turn ended in failure; the agent is no longer working)
 *   permission.asked / permission.v2.asked   → permission_blocked
 *   permission.replied / permission.v2.replied → working (resumed)
 *   message.* / session.created / session.updated → no workState (content/metadata)
 */
export function mapOpencodeEvent(raw: OpencodeRawEvent): OpencodeServerEvent | null {
  if (!raw || typeof raw.type !== "string") return null;
  const sessionId = propSessionId(raw);
  let workState: OpencodeWorkState | undefined;

  switch (raw.type) {
    case "session.status": {
      const status = raw.properties?.status as { type?: string } | undefined;
      workState = status?.type === "idle" ? "idle" : "working";
      break;
    }
    case "session.idle":
    case "session.error":
      workState = "idle";
      break;
    case "permission.asked":
    case "permission.v2.asked":
      workState = "permission_blocked";
      break;
    case "permission.replied":
    case "permission.v2.replied":
      workState = "working";
      break;
    default:
      workState = undefined;
  }

  return { type: raw.type, sessionId, workState, raw };
}

// ── The sidecar ───────────────────────────────────────────────────────────────

const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;
const MAX_RESTART_DELAY_MS = 30_000;
const QUICK_EXIT_THRESHOLD_MS = 3_000;
const MAX_CONSECUTIVE_QUICK_EXITS = 5;
// Forks cluster within seconds (a user branching a session a few ways), so a short
// idle window keeps the sidecar warm across a burst while bounding the
// unauthenticated-serve exposure to ~a minute past the last fork instead of forever.
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Manages one `opencode serve` subprocess and its HTTP + SSE channel. Lifecycle
 * rhymes with CodexAppServer: `start()`/`stop()`, `running`/`binaryMissing`
 * getters, exponential-backoff restart with a quick-exit circuit breaker, and an
 * ENOENT → `binaryNotFound` disable. Readiness is the server's own announce line
 * ("… listening on http://host:port") confirmed by a `/global/health` probe.
 *
 * Events: `ready` (healthy, port resolved), `event` (OpencodeServerEvent),
 * `workState` (sessionId, OpencodeWorkState) — the deduped state seam the daemon
 * feeds into sendAgentStatus — `error`, `exited`, `closed`, `binaryNotFound`,
 * `idleStopped` (self-torn-down after the idle timeout; the daemon drops its
 * singleton so the next fork lazily respawns a fresh one).
 */
export class OpencodeServer extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private log: (msg: string) => void;
  private hostname: string;
  private requestedPort: number;
  private resolvedPort = 0;
  private cwd?: string;
  private opencodeBinary: string;
  private spawnFn: typeof spawn;
  private fetchImpl: typeof fetch;
  private healthTimeoutMs: number;
  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private stopped = false;
  private healthy = false;
  private _binaryMissing = false;
  private restartDelay = 1000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveQuickExits = 0;
  private lastSpawnTime = 0;
  private sseController: AbortController | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OpencodeServerOptions) {
    super();
    this.log = opts.log;
    this.hostname = opts.hostname || "127.0.0.1";
    this.requestedPort = opts.port ?? 0;
    this.cwd = opts.cwd;
    this.opencodeBinary = opts.opencodeBinary || "opencode";
    this.spawnFn = opts.spawnFn || spawn;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  start(): void {
    if (this.process) return;
    this.stopped = false;
    this.spawnProcess();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearIdleTimer();
    this.stopSse();
    this.killProcess();
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null && this.healthy;
  }

  get binaryMissing(): boolean {
    return this._binaryMissing;
  }

  get port(): number {
    return this.resolvedPort;
  }

  get baseUrl(): string {
    return `http://${this.hostname}:${this.resolvedPort}`;
  }

  private spawnProcess(): void {
    const args = ["serve", "--hostname", this.hostname, "--port", String(this.requestedPort)];
    this.log(`[opencode-server] spawning: ${this.opencodeBinary} ${args.join(" ")}`);
    this.lastSpawnTime = Date.now();
    this.healthy = false;
    // Clear the previous life's port so THIS spawn's announce line re-triggers the
    // health confirm — without this the `!this.resolvedPort` guard below would swallow
    // a restarted process's announce, leaving the respawned sidecar never marked ready
    // (matters for the idle-stop → next-fork restart path).
    this.resolvedPort = 0;

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.opencodeBinary, args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: [
            process.env.HOME + "/.opencode/bin",
            process.env.HOME + "/.bun/bin",
            process.env.PATH,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
          ].filter(Boolean).join(":"),
        },
      });
    } catch (err: any) {
      this.handleSpawnFailure(err);
      return;
    }

    this.process = child;
    if (!child.stdout) {
      this.log("[opencode-server] failed to get stdout handle");
      this.scheduleRestart();
      return;
    }

    // The bound port arrives on the announce line; confirm health, then subscribe.
    const rl = readline.createInterface({ input: child.stdout });
    this.rl = rl;
    rl.on("line", (line) => {
      const port = parseListeningPort(line);
      if (port && !this.resolvedPort) {
        this.resolvedPort = port;
        this.confirmHealthy();
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text && /error|fatal|unhandled/i.test(text)) this.log(`[opencode-server:stderr] ${text}`);
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.handleSpawnFailure(err);
        return;
      }
      this.log(`[opencode-server] process error: ${err.message}`);
      this.emit("error", err);
      this.cleanup();
      this.scheduleRestart();
    });

    child.on("close", (code, signal) => {
      this.log(`[opencode-server] process exited: code=${code} signal=${signal}`);
      const uptime = Date.now() - this.lastSpawnTime;
      if (uptime < QUICK_EXIT_THRESHOLD_MS) {
        this.consecutiveQuickExits++;
        if (this.consecutiveQuickExits >= MAX_CONSECUTIVE_QUICK_EXITS) {
          this.log(`[opencode-server] ${this.consecutiveQuickExits} consecutive quick exits, disabling`);
          this.stopped = true;
          this.cleanup();
          this.emit("closed");
          return;
        }
      } else {
        this.consecutiveQuickExits = 0;
      }
      this.emit("exited", code, signal);
      this.cleanup();
      if (!this.stopped) this.scheduleRestart();
      else this.emit("closed");
    });
  }

  private handleSpawnFailure(err: any): void {
    const msg = err?.message ?? String(err);
    const isNotFound = err?.code === "ENOENT" || msg.includes("ENOENT") || msg.includes("not found");
    this.log(`[opencode-server] spawn failed: ${msg}`);
    if (isNotFound) {
      this._binaryMissing = true;
      this.stopped = true;
      this.cleanup();
      this.emit("binaryNotFound", this.opencodeBinary);
    } else {
      this.emit("error", err instanceof Error ? err : new Error(msg));
      this.cleanup();
      this.scheduleRestart();
    }
  }

  /** Poll /global/health until it answers healthy (bounded by healthTimeoutMs),
   *  then mark ready, reset backoff, and open the SSE stream. */
  private async confirmHealthy(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline && !this.stopped && this.process) {
      try {
        const resp = await this.fetchImpl(`${this.baseUrl}/global/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          const body = (await resp.json()) as { healthy?: boolean };
          if (body?.healthy) {
            this.healthy = true;
            this.restartDelay = 1000;
            this.consecutiveQuickExits = 0;
            this.log(`[opencode-server] ready on ${this.baseUrl}`);
            this.emit("ready", this.resolvedPort);
            this.subscribeEvents();
            // A sidecar that becomes ready but is never forked through must still
            // tear itself down — arm the idle countdown now, fork() re-arms it.
            this.armIdleTimer();
            return;
          }
        }
      } catch {
        /* not up yet — retry */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!this.healthy && !this.stopped) {
      this.log("[opencode-server] health check timed out — killing unhealthy process");
      this.emit("error", new Error("opencode serve health check timed out"));
      // Don't leak a spawned-but-never-healthy child: kill it. Its `close`
      // handler then schedules a backoff restart (self-recovery), the same
      // shape every other failure path here uses. (The prior code emitted
      // 'error' but left the process running forever — see ct-39150.)
      this.killProcess();
    }
  }

  /**
   * Open GET /event and stream typed events until the process stops. Reconnects on
   * a dropped stream while the server is still running. Because opencode's bus is
   * per-process, this only carries events for sessions driven through THIS server.
   */
  private async subscribeEvents(): Promise<void> {
    if (this.sseController || this.stopped || !this.process) return;
    const controller = new AbortController();
    this.sseController = controller;
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/event`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        this.log(`[opencode-server] /event returned ${resp.status}`);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const raw of events) this.dispatchEvent(raw);
      }
    } catch (err: any) {
      if (controller.signal.aborted) return; // deliberate stop
      this.log(`[opencode-server] /event stream error: ${err?.message ?? err}`);
    } finally {
      if (this.sseController === controller) this.sseController = null;
    }
    // Reconnect if the server is still meant to be up.
    if (!this.stopped && this.running) {
      this.sseReconnectTimer = setTimeout(() => {
        this.sseReconnectTimer = null;
        this.subscribeEvents();
      }, 1000);
    }
  }

  private dispatchEvent(raw: OpencodeRawEvent): void {
    const mapped = mapOpencodeEvent(raw);
    if (!mapped) return;
    this.emit("event", mapped);
    if (mapped.workState && mapped.sessionId) {
      this.emit("workState", mapped.sessionId, mapped.workState);
    }
  }

  private stopSse(): void {
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    if (this.sseController) {
      this.sseController.abort();
      this.sseController = null;
    }
  }

  private killProcess(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      const child = this.process;
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.healthy = false;
    this.stopSse();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.process = null;
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    this.log(`[opencode-server] restarting in ${this.restartDelay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnProcess();
    }, this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** (Re)start the idle countdown. When it fires the sidecar stops itself and emits
   *  `idleStopped` so the daemon can drop its singleton and lazily respawn on the
   *  next fork. `unref` so this timer never keeps the daemon alive on its own. */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.stopped || !this.process) return;
      this.log(`[opencode-server] idle ${this.idleTimeoutMs}ms — stopping sidecar`);
      this.emit("idleStopped");
      this.stop();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  // ── HTTP API ────────────────────────────────────────────────────────────────

  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.resolvedPort) throw new Error("opencode server not ready");
    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`opencode ${method} ${path} → ${resp.status} ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  }

  /**
   * Fork a session by id (optionally at a message), returning the new session with
   * its REAL `ses_*` id. This is the verified cross-process capability: the parent
   * need not have been created by this server — the shared DB makes any session
   * forkable, and the minted id is one `opencode -s <id>` can actually resume
   * (unlike a synthetic copy id).
   */
  async fork(sessionId: string, opts: OpencodeForkOptions = {}): Promise<OpencodeApiSession> {
    const query = opts.directory ? `?directory=${encodeURIComponent(opts.directory)}` : "";
    const body = opts.messageID ? { messageID: opts.messageID } : {};
    // Re-arm at the START too so the idle timer can't fire mid-fork (a fork is
    // bounded well under the idle window); the finally re-arms from completion.
    this.armIdleTimer();
    try {
      return await this.apiRequest<OpencodeApiSession>("POST", `/session/${sessionId}/fork${query}`, body);
    } finally {
      // Fork is the only activity that keeps the sidecar alive — restart the idle
      // countdown from the end of each fork so a burst holds the server open but a
      // quiet period after it lets the server shut itself down.
      this.armIdleTimer();
    }
  }

  /** Sessions in this sidecar's project scope. */
  async listSessions(): Promise<OpencodeApiSession[]> {
    return this.apiRequest<OpencodeApiSession[]>("GET", "/session");
  }

  /** Create a session driven through this server (its turns WILL stream on /event). */
  async createSession(body: { title?: string; parentID?: string } = {}): Promise<OpencodeApiSession> {
    return this.apiRequest<OpencodeApiSession>("POST", "/session", body);
  }
}
