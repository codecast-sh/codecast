/**
 * The requester side of a direct link: dial a grant and stream its body into
 * a sink. Every way the transfer can go wrong rejects, so a caller never
 * mistakes a partial body for the whole one.
 */

import * as http from "node:http";
import { PassThrough } from "node:stream";

export interface PullOpts {
  ip: string;
  port: number;
  secret: string;
  maxBytes: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  onBytes?: (n: number) => void;
  signal?: AbortSignal;
}

/** Pull the grant into `sink`; resolves with the bytes received once both the transfer and the sink succeed. */
export async function pullGrantInto(opts: PullOpts & { sink: (body: NodeJS.ReadableStream) => Promise<void> }): Promise<{ bytes: number }> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error(`bad grant port ${opts.port}`);
  const body = new PassThrough();
  body.on("error", () => {});
  let bytes = 0;
  let sinkRun: Promise<void> | null = null;
  const transfer = new Promise<void>((resolve, reject) => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(connect);
      clearTimeout(idle);
      opts.signal?.removeEventListener("abort", onAbort);
      const err = new Error(why);
      req.destroy(err);
      body.destroy(err);
      reject(err);
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail("idle_timeout"), opts.idleTimeoutMs ?? 30_000);
    };
    const req = http.get({ host: opts.ip, port: opts.port, path: `/grant/${opts.secret}`, agent: false, headers: { Connection: "close" } });
    const connect = setTimeout(() => fail("connect_timeout"), opts.connectTimeoutMs ?? 5_000);
    const onAbort = () => fail("cancelled");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort);
    req.on("error", (e) => fail(e.message));
    req.on("response", (res) => {
      clearTimeout(connect);
      if (res.statusCode !== 200) {
        res.resume();
        fail(`http_${res.statusCode}`);
        return;
      }
      sinkRun = opts.sink(body);
      sinkRun.catch((e) => fail(`sink_failed: ${e instanceof Error ? e.message : String(e)}`));
      armIdle();
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > opts.maxBytes) return fail(`over ${opts.maxBytes} bytes`);
        opts.onBytes?.(bytes);
        armIdle();
        if (!body.write(chunk)) {
          res.pause();
          body.once("drain", () => { armIdle(); res.resume(); });
        }
      });
      res.on("error", () => fail("truncated"));
      res.on("close", () => {
        if (!res.complete) return fail("truncated");
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        opts.signal?.removeEventListener("abort", onAbort);
        body.end();
        resolve();
      });
    });
  });
  const [t, s] = await Promise.allSettled([transfer, transfer.then(() => sinkRun, () => sinkRun)]);
  if (t.status === "rejected") throw t.reason;
  if (s.status === "rejected") throw s.reason;
  return { bytes };
}
