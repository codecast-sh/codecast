/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Why not puppeteer/playwright: both are ~50MB of dependency that bundle their
 * own browser download logic, and `cast` ships as a single compiled binary. We
 * speak ~15 CDP methods; that is a 200-line client, not a framework. `ws` is
 * already a CLI dependency (terminalServer.ts uses it).
 *
 * Connection model: one WebSocket to the BROWSER endpoint, with per-target
 * sessions multiplexed over it via `flatten: true`. That is the modern CDP
 * shape — one socket, sessionId-routed messages — and it means attaching to a
 * new tab costs a message rather than a new connection.
 */

import { WebSocket } from "ws";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type EventHandler = (ev: CdpEvent) => void;

/**
 * What every driver layer above the transport actually needs. Two transports
 * implement it: CdpConnection (a WebSocket straight into a Chrome we launched)
 * and BridgeConnection (a relay through the cast extension in the user's real
 * Chrome, where `sessionId` is "tab:<id>"). actions.ts, snapshot.ts and
 * observe.ts are written against this interface, which is why the same verbs
 * work on both browsers.
 */
export interface CdpClient {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  on(handler: EventHandler): () => void;
  waitFor(predicate: (ev: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent>;
  close(): void;
}

/** A call that never came back. Distinct from CdpError, which is a real reply. */
export class CdpTimeout extends Error {
  constructor(
    public readonly method: string,
    ms: number,
  ) {
    super(`${method} did not answer within ${ms}ms`);
    this.name = "CdpTimeout";
  }
}

export class CdpError extends Error {
  constructor(
    message: string,
    public readonly method: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
}

export class CdpConnection implements CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<EventHandler>();
  private closed = false;

  private constructor(private readonly url: string) {}

  static async connect(webSocketDebuggerUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const conn = new CdpConnection(webSocketDebuggerUrl);
    await conn.open(timeoutMs);
    return conn;
  }

  /** Discover the browser-level socket from the CDP HTTP endpoint. */
  static async fromPort(ep: CdpEndpoint, timeoutMs = 10_000): Promise<CdpConnection> {
    return CdpConnection.connect(await browserSocketUrl(ep, timeoutMs), timeoutMs);
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Chrome sends large AX trees in one frame; the default 100MB max is fine
      // but permessage-deflate costs real CPU on every snapshot, so decline it.
      const ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        if (!this.closed) reject(err);
      });
      ws.on("close", () => {
        this.closed = true;
        // Fail every in-flight call rather than hanging the CLI forever.
        for (const [, p] of this.pending) p.reject(new Error("CDP connection closed"));
        this.pending.clear();
      });
      ws.on("message", (raw) => this.onMessage(String(raw)));
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        const detail = msg.error.data ? ` (${msg.error.data})` : "";
        p.reject(new CdpError(`${msg.error.message}${detail}`, p.method));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const ev: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const h of this.handlers) {
        try {
          h(ev);
        } catch {
          /* a bad listener must not kill the socket */
        }
      }
    }
  }

  /**
   * Issue a CDP call. `sessionId` targets a page session; omit for browser scope.
   *
   * Every call is bounded. Some CDP methods do not merely fail slowly, they
   * never answer at all: a `Runtime.evaluate` issued while the page is between
   * documents waits for an execution context that the navigation already threw
   * away, and the reply never comes. There is nothing to catch, so a CLI
   * without this timeout hangs forever — which for an agent is worse than any
   * error, because it burns the whole turn learning nothing.
   */
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection is not open (${method})`));
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(method, timeoutMs));
      }, timeoutMs);
      const settle = <R>(fn: (v: R) => void) => (v: R) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Still usable? False once the socket closed for any reason. */
  isOpen(): boolean {
    return !this.closed && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Subscribe to protocol events. Returns an unsubscribe function. */
  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Resolve once `predicate` matches an event, or reject on timeout. */
  waitFor(predicate: (ev: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on((ev) => {
        if (!predicate(ev)) return;
        off();
        clearTimeout(timer);
        resolve(ev);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a CDP event`));
      }, timeoutMs);
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

/**

 * Where a CDP HTTP face lives. A bare port is Chrome's own endpoint; the
 * object form carries the token the extension bridge host requires on its
 * `/json/*` routes (Chrome's has none — its safety comes from refusing to be
 * driven at all on the default profile).
 */
export type CdpEndpoint = number | { port: number; token?: string };

const portOf = (ep: CdpEndpoint): number => (typeof ep === "number" ? ep : ep.port);

export function cdpHttpUrl(ep: CdpEndpoint, path: string): string {
  const url = new URL(`http://127.0.0.1:${portOf(ep)}${path}`);
  if (typeof ep !== "number" && ep.token) url.searchParams.set("token", ep.token);
  return url.toString();
}

/**
 * Discover the browser-level socket URL for an endpoint. Stable for the life
 * of that browser, so callers may cache it and skip this HTTP hop next time
 * (the built-in driver records it in instance.json at launch). Goes through
 * `cdpHttpUrl`, so a token-carrying bridge endpoint is discovered the same way
 * as Chrome's own.
 */
export async function browserSocketUrl(ep: CdpEndpoint, timeoutMs = 10_000): Promise<string> {
  const res = await fetch(cdpHttpUrl(ep, "/json/version"), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`CDP endpoint on port ${portOf(ep)} returned ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error(`CDP endpoint on port ${portOf(ep)} exposed no browser socket`);
  return body.webSocketDebuggerUrl;
}

/**
 * List page targets over an open connection — one message on a socket we
 * already hold, instead of a fresh HTTP request.
 */
export async function listTargetsVia(conn: CdpClient, timeoutMs = 5000): Promise<CdpTarget[]> {
  const res = await conn.send<{ targetInfos: Array<Record<string, any>> }>("Target.getTargets", {}, undefined, timeoutMs);
  return res.targetInfos
    .filter((t) => t.type === "page")
    .map((t) => ({ targetId: t.targetId, type: t.type, title: t.title ?? "", url: t.url ?? "", attached: t.attached }));
}

/** List page targets via the HTTP endpoint (cheaper than attaching). */
export async function listTargets(ep: CdpEndpoint): Promise<CdpTarget[]> {
  const res = await fetch(cdpHttpUrl(ep, "/json/list"), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, any>>;
  return raw
    .filter((t) => t.type === "page")
    .map((t) => ({ targetId: t.id, type: t.type, title: t.title ?? "", url: t.url ?? "" }));
}

/** True if a CDP endpoint is answering on this port. */
export async function isCdpAlive(ep: CdpEndpoint, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(cdpHttpUrl(ep, "/json/version"), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
