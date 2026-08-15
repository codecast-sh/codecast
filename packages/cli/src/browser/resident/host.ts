/**
 * The browser driver resident in the daemon.
 *
 * Why it exists: every `cast browser` verb used to be a fresh process that
 * discovered the CDP socket over HTTP, opened a WebSocket, attached to its tab,
 * enabled five domains, re-armed the console recorder and re-applied the
 * viewport — then threw all of it away on exit. That setup was most of a
 * command's wall time, and it happened once per verb, per agent, all day.
 *
 * The daemon is the one process on the machine that outlives every command,
 * so it holds the browser connection instead: ONE socket to Chrome, and one
 * attached CDP session per tab that stays attached between commands. A CLI
 * verb connects here over loopback, says which tab it wants, and starts
 * issuing CDP calls immediately. Persistence also fixes a class of bugs the
 * old model could only paper over: `Page.addScriptToEvaluateOnNewDocument`
 * (the recorder) and `Emulation.setDeviceMetricsOverride` (the viewport) are
 * bound to the CDP session that set them, so they now survive across commands
 * because the session does.
 *
 * Isolation between agents: a client sees events only for tabs IT attached
 * (plus browser-scope events with no session), so two agents in different tabs
 * cannot observe each other's pages. Wedge handling — a tab that will not
 * answer, a browser that has gone, a session that vanished under a call — goes
 * through recovery.ts, the same code the direct path uses.
 *
 * Mounted on the daemon's existing loopback hook server next to the terminal
 * and vault features; nothing here touches sync.
 */

import type * as http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { onWsUpgrade } from "../../terminal/terminalServer.js";
import { CdpConnection, listTargetsVia, type CdpEvent } from "../cdp.js";
import {
  attachToTarget, probeLiveness, readState, type InstanceState, type Liveness, type PageSession,
} from "../instance.js";
import { armRecorder } from "../observe.js";
import { setViewport } from "../actions.js";
import { isStaleSession, TabUnresponsive } from "../recovery.js";
import {
  RESIDENT_HTTP_PREFIX, RESIDENT_PROTOCOL_VERSION, RESIDENT_WS_PATH,
  type AttachParams, type AttachResult, type HelloResult, type ResidentStatus, type TargetsResult,
  type WireCall, type WireMessage,
} from "./protocol.js";

export interface ResidentHostOptions {
  log: (msg: string) => void;
}

interface AttachedTab {
  sessionId: string;
  /** Which viewport (by JSON) was last applied, so a changed one is re-applied. */
  viewportKey: string;
}

/**
 * The persistent link to Chrome plus everything remembered about it. One per
 * daemon; rebuilt whenever the browser it pointed at is replaced or dies.
 */
class BrowserLink {
  conn: CdpConnection | null = null;
  port: number | null = null;
  attached = new Map<string, AttachedTab>();
  attaching = new Map<string, Promise<AttachedTab>>();
  private connecting: Promise<CdpConnection> | null = null;
  private listeners = new Set<(ev: CdpEvent) => void>();

  constructor(private readonly log: (msg: string) => void) {}

  /**
   * The live connection, opened on demand. Returns the liveness verdict rather
   * than throwing so callers can hand the CLI the SAME "gone" vs "not
   * answering" message the direct path gives (recovery.ts).
   */
  async ensure(): Promise<{ conn: CdpConnection; state: InstanceState } | { liveness: Liveness; state: InstanceState | null }> {
    const state = readState();
    if (this.conn?.isOpen() && state && state.port === this.port) return { conn: this.conn, state };
    if (this.connecting && state && state.port === this.port) {
      try {
        return { conn: await this.connecting, state };
      } catch {
        /* fall through and re-probe */
      }
    }
    // Different browser than the one we held (restarted under us), or none yet.
    this.drop();
    const liveness = await probeLiveness(state);
    if (liveness !== "live" || !state) return { liveness, state };
    this.port = state.port;
    this.connecting = CdpConnection.fromPort(state.port).then((conn) => {
      this.conn = conn;
      conn.on((ev) => this.onEvent(ev));
      this.log(`[BROWSER] connected to managed Chrome on port ${state.port}`);
      return conn;
    });
    try {
      return { conn: await this.connecting, state };
    } catch (err) {
      this.drop();
      this.log(`[BROWSER] connect failed: ${(err as Error).message}`);
      return { liveness: await probeLiveness(readState()), state: readState() };
    } finally {
      this.connecting = null;
    }
  }

  private onEvent(ev: CdpEvent): void {
    // The tab went away (closed by anyone, or the browser is shutting down):
    // forget its session so the next attach starts clean instead of reusing an
    // id Chrome no longer knows.
    if (ev.method === "Target.detachedFromTarget") {
      const sid = (ev.params as { sessionId?: string }).sessionId;
      for (const [targetId, tab] of this.attached) {
        if (tab.sessionId === sid) this.attached.delete(targetId);
      }
    }
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a bad listener must not kill the link */
      }
    }
  }

  subscribe(l: (ev: CdpEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  drop(): void {
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
    this.port = null;
    this.attached.clear();
    this.attaching.clear();
  }

  /** Forget one tab's attachment (its session id proved stale). */
  evictSession(sessionId: string): void {
    for (const [targetId, tab] of this.attached) {
      if (tab.sessionId === sessionId) this.attached.delete(targetId);
    }
  }

  /**
   * Attach to a tab once and remember it. Concurrent requests for the same tab
   * share one attach so a burst of commands from a `do` flow — or from several
   * agents on the same page — never races the enables against each other.
   */
  async attach(conn: CdpConnection, state: InstanceState, targetId: string): Promise<{ tab: AttachedTab; reused: boolean }> {
    const vp = state.viewportByTab?.[targetId];
    const viewportKey = vp ? JSON.stringify(vp) : "";
    const have = this.attached.get(targetId);
    if (have) {
      // Viewport changed on disk since we applied it (a `viewport` verb ran on
      // this tab, possibly through the direct path): re-apply, keep the session.
      if (have.viewportKey !== viewportKey) {
        const page: PageSession = { conn, sessionId: have.sessionId, targetId };
        if (vp) await setViewport(page, vp).catch(() => {});
        have.viewportKey = viewportKey;
      }
      return { tab: have, reused: true };
    }
    let inflight = this.attaching.get(targetId);
    if (!inflight) {
      inflight = (async () => {
        const page = await attachToTarget(conn, targetId);
        // Armed once per session and it stays armed: the new-document script is
        // bound to this session, which now lives as long as the daemon does.
        await armRecorder(page);
        if (vp) await setViewport(page, vp).catch(() => {});
        const tab: AttachedTab = { sessionId: page.sessionId, viewportKey };
        this.attached.set(targetId, tab);
        return tab;
      })();
      this.attaching.set(targetId, inflight);
      inflight.finally(() => this.attaching.delete(targetId)).catch(() => {});
    }
    return { tab: await inflight, reused: false };
  }
}

// A single link per daemon process; created on first mount.
let link: BrowserLink | null = null;
let clientCount = 0;

function linkFor(opts: ResidentHostOptions): BrowserLink {
  if (!link) link = new BrowserLink(opts.log);
  return link;
}

/** For `cast browser status`, and tests. */
export function residentStatus(): ResidentStatus {
  return {
    connected: !!link?.conn,
    port: link?.port ?? null,
    attachedTabs: link?.attached.size ?? 0,
    clients: clientCount,
  };
}

/** HTTP surface: a health probe the CLI can hit before deciding to use us. */
export function handleBrowserHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = req.url ?? "";
  if (!url.startsWith(RESIDENT_HTTP_PREFIX)) return false;
  // Loopback only and never for a web page: a browser tab must not be able to
  // reach the driver that drives browser tabs.
  if (req.headers.origin) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (req.method === "GET" && url.startsWith(`${RESIDENT_HTTP_PREFIX}health`)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: RESIDENT_PROTOCOL_VERSION, ...residentStatus() }));
    return true;
  }
  res.writeHead(404);
  res.end();
  return true;
}

/** Wire the resident driver's WebSocket endpoint onto the hook server. */
export function attachResidentBrowserServer(server: http.Server, opts: ResidentHostOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  const detach = onWsUpgrade(server, RESIDENT_WS_PATH, (req, socket, head) => {
    if (req.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, linkFor(opts), opts));
  });
  return {
    close() {
      detach();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      link?.drop();
      link = null;
    },
  };
}

function handleClient(ws: WebSocket, link: BrowserLink, opts: ResidentHostOptions): void {
  clientCount++;
  // Sessions this client attached. Events are forwarded for these only, so an
  // agent never sees another agent's page traffic.
  const mine = new Set<string>();
  const send = (m: WireMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const unsubscribe = link.subscribe((ev) => {
    if (ev.sessionId && !mine.has(ev.sessionId)) return;
    send({ event: { method: ev.method, params: ev.params, sessionId: ev.sessionId } });
  });

  ws.on("message", async (raw) => {
    let call: WireCall;
    try {
      call = JSON.parse(String(raw)) as WireCall;
    } catch {
      return;
    }
    try {
      const result = await dispatch(call, link, mine);
      send({ id: call.id, result });
    } catch (err) {
      const e = err as Error;
      send({ id: call.id, error: { name: e.name, message: e.message } });
    }
  });
  ws.on("close", () => {
    clientCount--;
    unsubscribe();
  });
  ws.on("error", (err) => opts.log(`[BROWSER] client socket error: ${err.message}`));
}

/**
 * Failure text when the browser is not usable. Kept as a distinct error name
 * so the CLI can print the recovery hint from recovery.ts instead of a bare
 * message.
 */
export class BrowserUnavailable extends Error {
  constructor(public readonly liveness: Liveness) {
    super(`browser ${liveness}`);
    this.name = "BrowserUnavailable";
  }
}

async function dispatch(call: WireCall, link: BrowserLink, mine: Set<string>): Promise<unknown> {
  if (call.method === "cast.hello") {
    const r = await link.ensure();
    const hello: HelloResult = {
      version: RESIDENT_PROTOCOL_VERSION,
      liveness: "conn" in r ? "live" : r.liveness,
      state: r.state,
    };
    return hello;
  }
  if (call.method === "cast.status") return residentStatus();

  const r = await link.ensure();
  if (!("conn" in r)) throw new BrowserUnavailable(r.liveness);
  const { conn, state } = r;

  if (call.method === "cast.targets") {
    const out: TargetsResult = { targets: await listTargetsVia(conn) };
    return out;
  }
  if (call.method === "cast.attach") {
    const { targetId } = (call.params ?? {}) as AttachParams;
    if (!targetId) throw new Error("cast.attach needs a targetId");
    let got: { tab: AttachedTab; reused: boolean };
    try {
      got = await link.attach(conn, state, targetId);
    } catch (err) {
      // A cached session that Chrome no longer knows: forget it and try once
      // more from scratch rather than handing the client a dead id.
      if (!isStaleSession(err) || err instanceof TabUnresponsive) throw err;
      link.attached.delete(targetId);
      got = await link.attach(conn, state, targetId);
    }
    mine.add(got.tab.sessionId);
    const out: AttachResult = { sessionId: got.tab.sessionId, reused: got.reused };
    return out;
  }
  if (call.method === "cast.detach") {
    // Explicit release of a tab session (used by `close`); the tab itself is
    // closed by the client with Target.closeTarget.
    const { targetId } = (call.params ?? {}) as AttachParams;
    const tab = link.attached.get(targetId);
    if (tab) {
      link.attached.delete(targetId);
      await conn.send("Target.detachFromTarget", { sessionId: tab.sessionId }, undefined, 3000).catch(() => {});
    }
    return { ok: true };
  }
  if (call.method.startsWith("cast.")) throw new Error(`unknown resident call ${call.method}`);

  // Raw CDP passthrough. The client's timeout travels with the call so a
  // wedged renderer fails on the client's clock, not a default one.
  try {
    return await conn.send(call.method, call.params ?? {}, call.sessionId, call.timeoutMs);
  } catch (err) {
    if (call.sessionId && isStaleSession(err)) link.evictSession(call.sessionId);
    throw err;
  }
}
