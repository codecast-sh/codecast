import { execFile } from "../proc.js";
import { FrameDecoder, encodeFrame, MAX_INFLIGHT, MAX_DEADLINE_MS, type WorkerFrame } from "./protocol.js";
import { WORKER_KINDS, type WorkerKind, type ProbePayload, type ProbeResult } from "./operations.js";
import { workerEnv } from "./invocation.js";
import { scanPages } from "./scanJobs.js";
import type { ScanPayload, ScanRow } from "./scanTypes.js";
export function runWorker(kind: string): void {
  if (!WORKER_KINDS.includes(kind as WorkerKind) || process.platform === "win32" || Number(process.env.CODECAST_WORKER_PARENT_PID) !== process.ppid || process.ppid <= 1) {
    process.stderr.write("invalid worker context\n"); process.exit(64);
  }
  process.env.CODECAST_WORKER = "1";
  const parent = process.ppid;
  const decoder = new FrameDecoder();
  const inflight = new Set<string>();
  const seen = new Set<string>();
  const scans = new Map<string, { iterator: AsyncGenerator<ScanRow[]>; busy: boolean; timer?: ReturnType<typeof setTimeout> }>();
  const finish = () => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(0); }
  };
  const send = (frame: WorkerFrame) => {
    try {
      if (process.stdout.writableLength > 2 * 16 * 1024 * 1024) return finish();
      process.stdout.write(encodeFrame(frame));
    } catch { finish(); }
  };
  const heartbeat = () => send({ v: 1, kind: kind as WorkerKind, type: "heartbeat", pid: process.pid });
  process.on("SIGTERM", finish); process.on("SIGINT", finish);
  process.stdin.on("end", finish); process.stdin.on("error", finish); process.stdout.on("error", finish);
  setInterval(() => { if (process.ppid !== parent) finish(); }, 250).unref();
  setInterval(heartbeat, 1000).unref();
  heartbeat();
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== kind) throw new Error("wrong kind");
        if (frame.type === "cancel") { if (inflight.has(frame.id!)) finish(); continue; }
        if (frame.type !== "request" || seen.has(frame.id!)) throw new Error("invalid request");
        if (seen.size >= 4096) seen.delete(seen.values().next().value!);
        seen.add(frame.id!);
        const remaining = frame.deadline! - Date.now();
        if (remaining <= 0 || remaining > MAX_DEADLINE_MS) {
          send({ v: 1, kind: frame.kind, type: "error", id: frame.id, error: "deadline" }); continue;
        }
        if (inflight.size >= MAX_INFLIGHT) {
          send({ v: 1, kind: frame.kind, type: "error", id: frame.id, error: "busy" }); continue;
        }
        if (frame.operation === "ping") { send({ v: 1, kind: frame.kind, type: "result", id: frame.id, operation: "ping", result: "pong" }); continue; }
        if (frame.operation === "scan") {
          const payload = frame.payload as ScanPayload;
          const cursor = payload.action === "open" ? frame.id! : payload.cursor;
          if (payload.action === "open" && scans.size < MAX_INFLIGHT) scans.set(cursor, { iterator: scanPages(payload.job), busy: false });
          const scan = scans.get(cursor);
          if (!scan || scan.busy) {
            send({ v: 1, kind: frame.kind, type: "error", id: frame.id, error: "busy" }); continue;
          }
          if (scan.timer) clearTimeout(scan.timer);
          scan.busy = true;
          inflight.add(frame.id!);
          const deadline = setTimeout(finish, remaining);
          const run = payload.action === "close" ? scan.iterator.return(undefined) : scan.iterator.next();
          void run.then(result => {
            if (Date.now() >= frame.deadline!) return finish();
            if (result.done) scans.delete(cursor);
            else scan.timer = setTimeout(() => { scans.delete(cursor); void scan.iterator.return(undefined); }, 30_000);
            send({ v: 1, kind: frame.kind, type: "result", id: frame.id, operation: "scan", result: { cursor, rows: result.done ? [] : result.value, done: !!result.done } });
          }, () => {
            scans.delete(cursor);
            send({ v: 1, kind: frame.kind, type: "error", id: frame.id, error: "operation_failed" });
          }).finally(() => { clearTimeout(deadline); inflight.delete(frame.id!); scan.busy = false; });
          continue;
        }
        const payload = frame.payload as ProbePayload;
        inflight.add(frame.id!);
        const deadline = setTimeout(finish, remaining);
        const command = payload.operation === "keychain" ? "security" : payload.operation;
        execFile(command, payload.args, {
          ...payload.options,
          encoding: "utf8",
          timeout: Math.min(payload.options.timeout ?? remaining, remaining),
          env: workerEnv(payload.options.env ?? process.env, parent),
          killSignal: payload.options.killSignal as NodeJS.Signals | undefined,
        }, (error, stdout, stderr) => {
          clearTimeout(deadline); inflight.delete(frame.id!);
          if (Date.now() >= frame.deadline!) return finish();
          const e = error as (Error & { code?: number | string; signal?: NodeJS.Signals; killed?: boolean }) | null;
          if (e?.killed) return finish();
          const secretFailure = payload.operation === "keychain" && !!e;
          const result: ProbeResult = { status: e ? typeof e.code === "number" ? e.code : null : 0, signal: e?.signal ?? null, killed: !!e?.killed, stdout: secretFailure ? "" : String(stdout ?? ""), stderr: payload.operation === "keychain" ? "" : String(stderr ?? ""), ...(typeof e?.code === "string" ? { code: e.code } : {}) };
          send({ v: 1, kind: frame.kind, type: "result", id: frame.id, operation: "read", result });
        });
      }
    } catch {
      process.stderr.write("worker protocol rejected\n"); finish();
    }
  });
}
