import crypto from "crypto";
import type http from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { TmuxControlClient, shellSafe, type ControlClientMode } from "./controlClient.js";
import { tmuxRunAsync, hasTmux } from "../tmux.js";
import { isManagedTmuxName } from "../resumeCommand.js";

export const TERM_SESSION_PREFIX = "cast-term-";
const WS_PATH = "/term/ws";
// Above this many unsent bytes on the socket we stop reading tmux output
// (backpressure) instead of buffering a runaway `yes`-style flood in memory.
const HIGH_WATER_BYTES = 1_000_000;
const DRAIN_POLL_MS = 50;

// Origins allowed to open terminal sockets. The WS handshake is NOT subject to
// CORS, so this server-side check is the only thing standing between an
// arbitrary web page and a shell on the user's machine. Keep it tight.
const ALLOWED_ORIGIN = /^https:\/\/(local\.(\d+\.)?)?codecast\.sh$|^https?:\/\/localhost:\d+$|^https?:\/\/127\.0\.0\.1:\d+$/;

export interface TerminalServerOptions {
  token: string;
  log: (msg: string) => void;
  /** Extra origin check on top of the built-in allowlist (dev override). */
  allowOrigin?: (origin: string) => boolean;
}

interface HelloMessage {
  type: "hello";
  token: string;
  mode: "create" | "attach";
  /** create: reattach this session (else a new one is created) */
  name?: string;
  /** create: working directory for a new session */
  cwd?: string;
  /** attach: tmux session name (from managed_sessions.tmux_session) */
  target?: string;
  /** attach: request write access (default read-only) */
  interactive?: boolean;
  cols: number;
  rows: number;
}

export interface TerminalSessionInfo {
  name: string;
  path: string;
  command: string;
  created: number;
  attached: number;
}

// NB: separators must be printable: tmux sanitizes control chars (tabs
// included) to "_" in format output. Fixed width fields come first; the path
// goes LAST and is re-joined, since it is the one field that may itself
// contain the separator. pane_current_command expands through the session's
// active pane, so one list call carries it and no per session query is needed.
const SESSION_LIST_FORMAT = "#{session_name}|#{session_created}|#{session_attached}|#{pane_current_command}|#{session_path}";

/** Parse `tmux list-sessions -F SESSION_LIST_FORMAT` output: the panel's own
 *  sessions (cast-term-*), oldest first. */
export function parseTerminalSessionRows(stdout: string): TerminalSessionInfo[] {
  const out: TerminalSessionInfo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, created, attached, command, ...pathParts] = line.split("|");
    if (!name || !name.startsWith(TERM_SESSION_PREFIX)) continue;
    out.push({
      name,
      path: pathParts.join("|"),
      command: (command ?? "").trim(),
      created: (parseInt(created ?? "", 10) || 0) * 1000,
      attached: parseInt(attached ?? "", 10) || 0,
    });
  }
  return out.sort((a, b) => a.created - b.created);
}

/** List the panel's own tmux sessions (cast-term-*). One tmux call, off the loop. */
export async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
  const r = await tmuxRunAsync(["list-sessions", "-F", SESSION_LIST_FORMAT]);
  if (r.status !== 0) return [];
  return parseTerminalSessionRows(r.stdout);
}

export async function killTerminalSession(name: string): Promise<boolean> {
  if (!name.startsWith(TERM_SESSION_PREFIX)) return false;
  try {
    shellSafe(name);
  } catch {
    return false;
  }
  return (await tmuxRunAsync(["kill-session", "-t", name])).status === 0;
}

// Panel terminals outlive their tabs by design (close = detach), so without a
// reaper every "+" ever clicked accumulates as a live tmux session forever,
// and the panel restores all of them on open. Reap sessions nobody is attached
// to once they have been idle past the TTL; an attached client or recent
// activity always keeps a session alive. Callers: daemon boot + periodic.
const REAP_IDLE_MS = 3 * 24 * 60 * 60 * 1000;
const REAP_LIST_FORMAT = "#{session_name}|#{session_attached}|#{session_activity}";

/** The panel sessions `tmux list-sessions -F REAP_LIST_FORMAT` output says are
 *  detached and idle past the TTL, with their idle time. */
export function staleTerminalSessions(stdout: string, now: number): Array<{ name: string; idleMs: number }> {
  const out: Array<{ name: string; idleMs: number }> = [];
  for (const line of stdout.split("\n")) {
    const [name, attached, activity] = line.split("|");
    if (!name || !name.startsWith(TERM_SESSION_PREFIX)) continue;
    if ((parseInt(attached ?? "", 10) || 0) > 0) continue;
    const lastActivity = (parseInt(activity ?? "", 10) || 0) * 1000;
    if (now - lastActivity < REAP_IDLE_MS) continue;
    out.push({ name, idleMs: now - lastActivity });
  }
  return out;
}

export async function reapStaleTerminalSessions(log?: (msg: string) => void): Promise<number> {
  const r = await tmuxRunAsync(["list-sessions", "-F", REAP_LIST_FORMAT]);
  if (r.status !== 0) return 0;
  let reaped = 0;
  for (const { name, idleMs } of staleTerminalSessions(r.stdout, Date.now())) {
    if (await killTerminalSession(name)) {
      reaped++;
      log?.(`[TERM] Reaped idle terminal session ${name} (idle ${Math.round(idleMs / 3_600_000)}h)`);
    }
  }
  return reaped;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function originAllowed(origin: string | undefined, opts: TerminalServerOptions): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGIN.test(origin)) return true;
  return opts.allowOrigin?.(origin) ?? false;
}

// A constant-time compare of two zero-length buffers reports a match, so an
// unconfigured server would accept a caller presenting no token at all. The
// daemon's token is state now (it loads from disk early in boot), so "not yet
// loaded" is a state a caller can reach; make it authenticate nobody.
function presentedTokenMatches(presented: string, opts: TerminalServerOptions): boolean {
  return opts.token.length > 0 && timingSafeEqual(presented, opts.token);
}

/** Constant-time check of a token presented on a WS hello frame. */
export function tokenMatches(token: unknown, opts: TerminalServerOptions): boolean {
  return typeof token === "string" && presentedTokenMatches(token, opts);
}

/** The whole auth envelope for one loopback HTTP request: an allowed origin AND
 *  the bearer token the daemon keeps on disk (loopbackIdentity.ts, rotated with
 *  `cast daemon rotate-token`). Every feature mounted on this server (terminal,
 *  vault) goes through this one check — a route that authenticated differently
 *  would be the hole in a server that can read the user's disk. */
export function authorizeLocalRequest(req: http.IncomingMessage, opts: TerminalServerOptions): boolean {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return originAllowed(req.headers.origin, opts) && presentedTokenMatches(token, opts);
}

export function corsHeaders(origin: string | undefined, opts: TerminalServerOptions): Record<string, string> {
  if (!originAllowed(origin, opts)) return {};
  return {
    "Access-Control-Allow-Origin": origin!,
    // If-Match / X-Vault-Base-Mtime are the vault write guards: a preflight that
    // doesn't list them makes every conflict-checked PUT fail in the browser.
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Vault-Base-Mtime",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    // The browser can only read these off a cross-origin response if they're
    // exposed; the vault's write guard depends on the client seeing the ETag.
    "Access-Control-Expose-Headers": "ETag, X-Vault-Mtime, X-Vault-Size",
    // Chrome Private Network Access: a public https page fetching loopback
    // must see this on the preflight or the request is blocked.
    "Access-Control-Allow-Private-Network": "true",
    "Vary": "Origin",
  };
}

type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;

// One 'upgrade' listener per HTTP server, routing by path prefix. Node hands an
// upgrade to EVERY listener, so two features each installing their own listener
// would have the first one destroying the second one's sockets. Registering
// through here keeps that impossible, and keeps "nobody claimed it" a single
// decision rather than a race between listeners.
const upgradeRouters = new WeakMap<http.Server, Map<string, UpgradeHandler>>();

export function onWsUpgrade(server: http.Server, prefix: string, handler: UpgradeHandler): () => void {
  let routes = upgradeRouters.get(server);
  if (!routes) {
    routes = new Map();
    upgradeRouters.set(server, routes);
    server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";
      for (const [routePrefix, routeHandler] of routes!) {
        if (url.startsWith(routePrefix)) return routeHandler(req, socket, head);
      }
      socket.destroy();
    });
  }
  routes.set(prefix, handler);
  return () => routes!.delete(prefix);
}

/**
 * HTTP endpoints for the terminal feature, mounted on the daemon's existing
 * loopback hook server. Returns true when the request was handled.
 */
export function handleTerminalHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TerminalServerOptions,
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/term/")) return false;
  const origin = req.headers.origin;
  const headers = { "Content-Type": "application/json", ...corsHeaders(origin, opts) };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return true;
  }

  if (!authorizeLocalRequest(req, opts)) {
    res.writeHead(403, headers);
    res.end(JSON.stringify({ error: "forbidden" }));
    return true;
  }

  // The tmux routes answer off the loop. The request listener stays
  // synchronous (the same shape handleVaultHttp uses on this server); a route
  // that throws before its headers went out answers 500 instead of hanging.
  const dispatch = (route: () => Promise<void>): void => {
    void route().catch((err) => {
      opts.log(`[TERM] ${req.method} ${url} failed: ${(err as Error)?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "server error" }));
      } else res.end();
    });
  };

  if (req.method === "GET" && url.startsWith("/term/sessions")) {
    dispatch(async () => {
      const sessions = await listTerminalSessions();
      res.writeHead(200, headers);
      res.end(JSON.stringify({ sessions, tmux: hasTmux() }));
    });
    return true;
  }

  if (req.method === "POST" && url.startsWith("/term/kill")) {
    const name = new URL(url, "http://localhost").searchParams.get("name") ?? "";
    dispatch(async () => {
      const ok = await killTerminalSession(name);
      res.writeHead(ok ? 200 : 400, headers);
      res.end(JSON.stringify({ ok }));
    });
    return true;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found" }));
  return true;
}

/** Wire the terminal WebSocket endpoint onto an existing HTTP server. */
export function attachTerminalServer(server: http.Server, opts: TerminalServerOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const live = new Set<ConnectionHandle>();

  const detach = onWsUpgrade(server, WS_PATH, (req, socket, head) => {
    if (!originAllowed(req.headers.origin, opts)) {
      opts.log(`[TERM] Rejected WS from origin ${req.headers.origin ?? "(none)"}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, opts, live));
  });

  return {
    close() {
      detach();
      // Shutdown: the process is about to exit, so each attach must hand its
      // pane back NOW, from outside the control channel — the socket close
      // event (and the in-band restore it would trigger) arrives too late.
      for (const h of live) h.shutdown();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

interface ConnectionHandle {
  shutdown(): void;
}

function handleConnection(ws: WebSocket, opts: TerminalServerOptions, live: Set<ConnectionHandle>): void {
  let client: TmuxControlClient | null = null;
  let drainTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const sendJson = (obj: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const fail = (message: string) => {
    sendJson({ type: "error", message });
    ws.close(4000, message.slice(0, 100));
  };
  let sessionLabel = "?";
  const cleanup = (sync = false) => {
    if (closed) return;
    closed = true;
    live.delete(handle);
    if (drainTimer) clearInterval(drainTimer);
    if (client) {
      const back = client.restoresTo;
      opts.log(`[TERM] detach ${sessionLabel}${back ? ` (window back to ${back}${sync ? ", shutdown" : ""})` : ""}`);
      if (sync) client.closeSync();
      else client.close();
    }
    client = null;
  };
  const handle: ConnectionHandle = { shutdown: () => cleanup(true) };
  live.add(handle);

  // The first message must be the hello; nothing is spawned until the token
  // inside it checks out.
  const helloTimeout = setTimeout(() => fail("hello timeout"), 10_000);
  helloTimeout.unref?.();

  ws.once("message", async (raw, isBinary) => {
    clearTimeout(helloTimeout);
    if (isBinary) return fail("expected hello");
    let hello: HelloMessage;
    try {
      hello = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail("bad hello");
    }
    if (hello.type !== "hello") return fail("bad hello");
    if (!tokenMatches(hello.token, opts)) return fail("forbidden");
    if (!hasTmux()) return fail("tmux is not installed on this machine");

    const cols = clampDim(hello.cols, 200);
    const rows = clampDim(hello.rows, 50);

    let mode: ControlClientMode;
    if (hello.mode === "create") {
      let name = hello.name ?? `${TERM_SESSION_PREFIX}${crypto.randomBytes(3).toString("hex")}`;
      try {
        name = shellSafe(name);
      } catch {
        return fail("bad session name");
      }
      if (!name.startsWith(TERM_SESSION_PREFIX)) return fail("bad session name");
      const cwd = typeof hello.cwd === "string" && hello.cwd.startsWith("/") ? hello.cwd : undefined;
      // Fresh vs reattach decides the seeding strategy (see controlClient).
      const fresh = (await tmuxRunAsync(["has-session", "-t", name])).status !== 0;
      if (closed) return;
      mode = { kind: "create", sessionName: name, cwd, fresh };
    } else if (hello.mode === "attach") {
      const target = hello.target ?? "";
      // Attach only to sessions this product owns: agent sessions the daemon
      // manages, or the panel's own terminals. Never arbitrary tmux sessions.
      if (!/^[a-zA-Z0-9_.:-]+$/.test(target)) return fail("bad target");
      if (!isManagedTmuxName(target) && !target.startsWith(TERM_SESSION_PREFIX)) return fail("target not allowed");
      const exists = (await tmuxRunAsync(["has-session", "-t", target])).status === 0;
      // The socket may have gone away during the probe.
      if (closed) return;
      if (!exists) return fail("session not found");
      mode = { kind: "attach", target, readOnly: !hello.interactive };
    } else {
      return fail("bad mode");
    }

    client = new TmuxControlClient(mode, {
      onOutput(data) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(data);
        if (ws.bufferedAmount > HIGH_WATER_BYTES && client && !drainTimer) {
          client.pauseOutput();
          drainTimer = setInterval(() => {
            if (ws.bufferedAmount < HIGH_WATER_BYTES / 4) {
              if (drainTimer) clearInterval(drainTimer);
              drainTimer = null;
              client?.resumeOutput();
            }
          }, DRAIN_POLL_MS);
          drainTimer.unref?.();
        }
      },
      onExit(reason) {
        sendJson({ type: "exit", reason });
        ws.close(1000);
        cleanup();
      },
      onReseed({ cols, rows, seed }) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // JSON first so the client resets + resizes before the seed bytes land.
        sendJson({ type: "reseed", cols, rows });
        if (seed.length > 0) ws.send(seed);
      },
    });

    client
      .start(cols, rows)
      .then(({ cols: c, rows: r, seed, sessionName }) => {
        if (ws.readyState !== WebSocket.OPEN) return cleanup();
        sendJson({
          type: "ready",
          cols: c,
          rows: r,
          sessionName,
          readOnly: client?.isReadOnly ?? false,
          mode: hello.mode,
        });
        if (seed.length > 0) ws.send(seed);
        sessionLabel = sessionName;
        opts.log(`[TERM] ${hello.mode} ${sessionName} (${c}x${r}${client?.isReadOnly ? ", read-only" : ""})`);
      })
      .catch((err) => {
        const message = typeof err?.message === "string" && err.message ? err.message : "failed to start terminal";
        opts.log(`[TERM] start failed: ${message}`);
        fail(message);
        // Reap the control client now — a hung tmux child would otherwise
        // linger until the ws close event wanders in.
        cleanup();
      });

    ws.on("message", (data, isBinary) => {
      if (!client) return;
      if (isBinary) {
        client.sendInput(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "resize") {
          // An attach reshapes the AGENT's screen, so it has a floor a panel
          // shell doesn't: below ~80x12 Claude Code's renderer drops and
          // splices lines, and that lands in the agent's scrollback for
          // good. Current clients never ask for less (termSessions.ts) and
          // scroll the pane instead; this is the backstop for older ones.
          const attach = hello.mode === "attach";
          client.resize(
            clampDim(msg.cols, 500, attach ? ATTACH_MIN_COLS : 2),
            clampDim(msg.rows, 200, attach ? ATTACH_MIN_ROWS : 2),
          );
        } else if (msg.type === "kill") {
          void client.killSession().then(() => {
            sendJson({ type: "exit", reason: "killed" });
            ws.close(1000);
            cleanup();
          });
        }
      } catch {}
    });
  });

  ws.on("close", () => cleanup());
  ws.on("error", () => cleanup());
}

// Same floor as the web client's MIN_FIT_COLS/ROWS (termSessions.ts).
export const ATTACH_MIN_COLS = 80;
export const ATTACH_MIN_ROWS = 12;

export function clampDim(value: unknown, max: number, min = 2): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return Math.max(80, min);
  return Math.min(Math.max(n, min), max);
}
