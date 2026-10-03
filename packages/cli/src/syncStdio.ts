// Output to a pipe goes to its fd synchronously, the whole of it.
//
// Under Bun, touching process.stdout (even reading .isTTY) leaves a piped fd 1
// non-blocking. From then on console.log and fs.writeSync stop at the pipe's
// buffer (64 KB) with EAGAIN, and the rest is dropped: `cast trigger ls --json
// | wc -c` printed 65536 of 377555 bytes. process.stdout.write queues instead,
// but a process.exit after it cuts the queue short. A loop that waits out
// EAGAIN loses nothing and survives any exit, so every console and stream
// write to a non-tty fd goes through it. A tty keeps Bun's own console.
import fs from "node:fs";
import tty from "node:tty";
import { format } from "node:util";

const pause = new Int32Array(new SharedArrayBuffer(4));
// A reader that went away (`| head`) takes nothing more; the command finishes
// as it would under Bun's own console, which drops such writes too.
const closed = new Set<number>();

/** Write all of `data` to `fd`, waiting out EAGAIN on a non-blocking pipe. */
export function writeFdSync(fd: number, data: string | Uint8Array): void {
  if (closed.has(fd)) return;
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e: any) {
      if (e?.code === "EPIPE") { closed.add(fd); return; }
      if (e?.code !== "EAGAIN") throw e;
      Atomics.wait(pause, 0, 0, 2);
    }
  }
}

let installed = false;

/** Route console.* and process.std{out,err}.write through writeFdSync for
 *  each of fd 1 and fd 2 that is not a tty. Idempotent. */
export function installSyncStdio(isTty: (fd: number) => boolean = tty.isatty): void {
  if (installed) return;
  installed = true;
  for (const [fd, stream, methods] of [
    [1, process.stdout, ["log", "info", "debug"]],
    [2, process.stderr, ["warn", "error"]],
  ] as const) {
    if (isTty(fd)) continue;
    const line = (...args: unknown[]) => writeFdSync(fd, format(...args) + "\n");
    for (const m of methods) (console as any)[m] = line;
    (stream as any).write = (chunk: string | Uint8Array, enc?: unknown, cb?: unknown) => {
      const done = typeof enc === "function" ? enc : cb;
      writeFdSync(fd, typeof chunk === "string" && typeof enc === "string" ? Buffer.from(chunk, enc as BufferEncoding) : chunk);
      if (typeof done === "function") queueMicrotask(() => (done as () => void)());
      return true;
    };
  }
}
