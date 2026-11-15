/**
 * The laptop end of `cast computer --on laptop` (docs/architecture/computer-remote.md):
 * one cloud-host socket on the bridge's `/computer` face, served by an
 * ordinary local helper client. The helper socket never leaves this process:
 * each request is parsed, held to the person's grant and the method list,
 * and re-sent by this process, which is the helper's own authorized peer.
 *
 * A screenshot crosses as one binary frame before its JSON result: a 4-byte
 * request id, a 2-byte content-type length, the content type, then the
 * image bytes as the helper produced them. The JSON names its size and type
 * and carries no pixels.
 */

import * as fs from "node:fs";
import type { CloudHost } from "../browser/cloudHost.js";
import { asComputerError, ComputerError } from "./errors.js";
import { remoteRefusal } from "./remoteGrant.js";
import { screenshotDir } from "./screenshotFile.js";
import type { ComputerClientLike } from "./run.js";
import type { ComputerActionMethod, ComputerScreenshotData } from "./types.js";

export interface RemoteSocket {
  send(data: string | Buffer, options?: { binary: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (raw: Buffer | string, isBinary?: boolean) => void): unknown;
  on(event: "close", fn: () => void): unknown;
}

export interface ServeComputerOptions {
  host: string;
  session: string | null;
  laptop: string;
  /** The host's registry entry as it stands now, read on every request so a revoke binds at once. */
  hostEntry: () => CloudHost | undefined;
  client: () => Promise<ComputerClientLike>;
  log: (line: string) => void;
  /** The first granted request of the day from this host. */
  onFirstUse?: (host: string) => void;
  /** How often a live socket rechecks its grant with no request in flight. */
  sweepMs?: number;
  now?: () => number;
}

export const CLOSE_NOT_GRANTED = 4403;

/** Encode one screenshot frame. */
export function screenshotFrame(id: number, contentType: string, bytes: Buffer): Buffer {
  const ct = Buffer.from(contentType, "utf-8");
  const head = Buffer.alloc(6);
  head.writeUInt32BE(id >>> 0, 0);
  head.writeUInt16BE(ct.length, 4);
  return Buffer.concat([head, ct, bytes]);
}

export function parseScreenshotFrame(frame: Buffer): { id: number; contentType: string; bytes: Buffer } | null {
  if (frame.length < 6) return null;
  const ctLen = frame.readUInt16BE(4);
  if (frame.length < 6 + ctLen) return null;
  return { id: frame.readUInt32BE(0), contentType: frame.subarray(6, 6 + ctLen).toString("utf-8"), bytes: frame.subarray(6 + ctLen) };
}

/** The helper's pixels as bytes: the file it wrote, removed once read. */
export function takeScreenshotBytes(shot: ComputerScreenshotData): { bytes: Buffer; meta: Record<string, unknown> } | null {
  const { path: file, expiresAt: _e, ...meta } = shot;
  if (!file) return null;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
  } catch {
    return null;
  }
  return { bytes, meta: { ...meta, bytes: bytes.length, contentType: `image/${shot.format}` } };
}

async function call(client: ComputerClientLike, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "capabilities": return client.capabilities();
    case "listApps": return client.listApps();
    case "listWindows": return client.listWindows(params);
    case "getAppState": return client.getAppState(params);
    default: return client.action(method as ComputerActionMethod, params);
  }
}

export function serveComputerSocket(ws: RemoteSocket, o: ServeComputerOptions): void {
  const now = o.now ?? Date.now;
  let client: Promise<ComputerClientLike> | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const where = `${o.host}${o.session ? ` session ${o.session}` : ""}`;
  o.log(`[COMPUTER-REMOTE] ${where} connected`);

  const sweep = setInterval(() => {
    const why = remoteRefusal(o.hostEntry(), { host: o.host, session: o.session, method: "listApps", params: {} }, o.laptop, now());
    if (why) {
      o.log(`[COMPUTER-REMOTE] ${where} cut off: ${why.split(". Ask")[0]}`);
      ws.close(CLOSE_NOT_GRANTED, "grant revoked");
    }
  }, o.sweepMs ?? 2_000);

  const reply = (id: number, body: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }) => {
    if (!closed) ws.send(JSON.stringify({ id, ...body }));
  };

  const handle = async (raw: string): Promise<void> => {
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try { req = JSON.parse(raw); } catch { return; }
    const id = typeof req.id === "number" ? req.id : -1;
    const method = typeof req.method === "string" ? req.method : "";
    const params = req.params && typeof req.params === "object" && !Array.isArray(req.params) ? { ...(req.params as Record<string, unknown>) } : {};
    const why = remoteRefusal(o.hostEntry(), { host: o.host, session: o.session, method, params }, o.laptop, now());
    if (why) {
      o.log(`[COMPUTER-REMOTE] ${where} refused ${method}: ${why.split(". Ask")[0]}`);
      return reply(id, { ok: false, error: { code: "remote_refused", message: why } });
    }
    // Where the helper writes its capture is this laptop's business, never the caller's.
    if ("screenshotDir" in params) params.screenshotDir = screenshotDir();
    o.onFirstUse?.(o.host);
    o.log(`[COMPUTER-REMOTE] ${where} ${method}${typeof params.app === "string" ? ` ${params.app}` : ""}`);
    try {
      client ??= o.client();
      const result = await call(await client, method, params) as { screenshot?: ComputerScreenshotData | null } | null;
      const shot = result && typeof result === "object" && result.screenshot ? takeScreenshotBytes(result.screenshot) : null;
      if (shot && !closed) ws.send(screenshotFrame(id, String(shot.meta.contentType), shot.bytes), { binary: true });
      reply(id, { ok: true, result: shot ? { ...result, screenshot: shot.meta } : result });
    } catch (err) {
      const e = asComputerError(err);
      reply(id, { ok: false, error: { code: e.code, message: e instanceof ComputerError ? e.message : String(err) } });
    }
  };

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    // One request at a time, in order, like the helper's own client queue.
    chain = chain.then(() => handle(String(raw)));
  });
  ws.on("close", () => {
    closed = true;
    clearInterval(sweep);
    o.log(`[COMPUTER-REMOTE] ${where} left`);
    void client?.then((c) => c.shutdown(), () => {});
  });
}
