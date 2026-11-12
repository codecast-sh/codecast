/**
 * The source side of a direct link (docs/architecture/peer-transport.md): a
 * single-use HTTP listener on this machine's tailnet IP that streams one
 * payload to one requester, then closes.
 */

import * as http from "node:http";
import type { Socket } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAX_LIVE_GRANTS = 2;
let liveGrants = 0;
const closers = new Set<() => void>();

export function liveGrantCount(): number {
  return liveGrants;
}

/** Close every open grant (daemon shutdown). */
export function closeAllGrants(): void {
  for (const close of [...closers]) close();
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newGrantSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("hex");
  return { secret, hash: sha256hex(secret) };
}

const normalize = (a: string | undefined) => (a ?? "").replace(/^::ffff:/i, "");

/** A socket the grant may read from: from the requester, to the grant address. */
export function acceptGrantSocket(sock: { remoteAddress?: string; localAddress?: string }, bindIp: string, allowFrom: string): boolean {
  return normalize(sock.remoteAddress) === allowFrom && normalize(sock.localAddress) === bindIp;
}

export interface GrantOutcome { served: boolean; reason: string; bytes: number }

export interface GrantOpts {
  bindIp: string;
  allowFrom: string;
  tokenHash: string;
  serve: () => { stream: NodeJS.ReadableStream; kill: () => void };
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxTotalMs?: number;
}

export async function openGrant(opts: GrantOpts): Promise<{ port: number; done: Promise<GrantOutcome>; close: () => void }> {
  if (!opts.bindIp || opts.bindIp === "0.0.0.0" || opts.bindIp === "::") throw new Error(`refusing to bind a grant to "${opts.bindIp}"`);
  if (!/^[0-9a-f]{64}$/.test(opts.tokenHash)) throw new Error("grant token hash must be 64 hex characters");
  if (liveGrants >= MAX_LIVE_GRANTS) throw new Error(`${MAX_LIVE_GRANTS} grants are already open`);
  liveGrants++;

  const want = Buffer.from(opts.tokenHash);
  const server = http.createServer();
  server.maxConnections = 1;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  const sockets = new Set<Socket>();
  let serving = false;
  let bytes = 0;
  let producer: { stream: NodeJS.ReadableStream; kill: () => void } | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (o: GrantOutcome) => void;
  const done = new Promise<GrantOutcome>((r) => { resolveDone = r; });
  let finished = false;
  const close = () => finish(false, "closed");
  closers.add(close);

  const finish = (served: boolean, reason: string) => {
    if (finished) return;
    finished = true;
    liveGrants--;
    closers.delete(close);
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    clearTimeout(idle);
    server.close();
    if (!served) {
      producer?.kill();
      for (const s of sockets) s.destroy();
    }
    resolveDone({ served, reason, bytes });
  };
  const connectTimer = setTimeout(() => { if (!serving) finish(false, "connect_timeout"); }, opts.connectTimeoutMs ?? 60_000);
  const totalTimer = setTimeout(() => finish(false, "total_timeout"), opts.maxTotalMs ?? 60 * 60_000);
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => finish(false, "idle_timeout"), opts.idleTimeoutMs ?? 30_000);
  };

  server.on("connection", (sock: Socket) => {
    if (finished || serving || !acceptGrantSocket(sock, opts.bindIp, opts.allowFrom)) {
      sock.destroy();
      return;
    }
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const m = /^\/grant\/([^/?#]{1,128})$/.exec(req.url ?? "");
    const given = m ? Buffer.from(sha256hex(m[1])) : null;
    if (finished || !acceptGrantSocket(req.socket, opts.bindIp, opts.allowFrom)) {
      req.socket.destroy();
      return;
    }
    if (serving || req.method !== "GET" || !given || !timingSafeEqual(given, want)) {
      res.writeHead(404, { Connection: "close" });
      res.end();
      return;
    }
    serving = true;
    clearTimeout(connectTimer);
    try {
      producer = opts.serve();
    } catch (e) {
      res.writeHead(500, { Connection: "close" });
      res.end();
      finish(false, `producer_failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { stream } = producer;
    res.writeHead(200, { "Content-Type": "application/gzip", Connection: "close" });
    res.flushHeaders();
    armIdle();
    stream.on("data", (chunk: Buffer) => { bytes += chunk.length; armIdle(); });
    stream.on("error", (e: Error) => {
      req.socket.destroy();
      finish(false, `producer_failed: ${e.message}`);
    });
    res.on("finish", () => finish(true, "served"));
    // A reader that goes away ends the grant at once. bun's ServerResponse does
    // not always emit "close" when the client drops, so the socket closing
    // counts too; otherwise the transfer waits out the idle deadline.
    const readerGone = () => { if (!res.writableFinished) finish(false, "reader_closed"); };
    res.on("close", readerGone);
    req.socket.once("close", readerGone);
    stream.pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      finish(false, `listen_failed: ${e.message}`);
      reject(e);
    });
    server.listen(0, opts.bindIp, () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, done, close });
    });
  });
}
