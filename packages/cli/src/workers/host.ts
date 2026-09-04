import { spawn, type ChildProcess } from "node:child_process";
import { FrameDecoder, encodeFrame, MAX_QUEUE, MAX_INFLIGHT, MAX_DEADLINE_MS, type WorkerFrame } from "./protocol.js";
import { killWorkerGroup, workerEnv, workerInvocation } from "./invocation.js";
import { sawSuspend } from "../suspendClock.js";
import type { WorkerKind } from "./operations.js";
export class WorkerUnavailable extends Error {}
export class WorkerOperationError extends Error {}
type Pending = { frame: WorkerFrame; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; abort?: () => void; signal?: AbortSignal; sent: boolean };
export type WorkerHostOptions = {
  invocation?: { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  spawnChild?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  killChild?: (child: ChildProcess) => void;
  backoffMs?: readonly number[];
  heartbeatTimeoutMs?: number;
  clock?: { wall: () => number; mono: () => number };
};
export class WorkerHost {
  private child: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private generation = 0;
  private sequence = 0;
  private crashes: number[] = [];
  private retryAt = 0;
  private disabled = false;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private wall = 0;
  private mono = 0;
  private wakeUntil = -1;
  constructor(readonly kind: WorkerKind, private readonly options: WorkerHostOptions = {}) {
    if (process.env.CODECAST_WORKER === "1") throw new Error("nested worker runtime refused");
    this.wall = this.wallNow(); this.mono = this.monoNow();
  }
  private wallNow() { return this.options.clock?.wall() ?? Date.now(); }
  private monoNow() { return this.options.clock?.mono() ?? performance.now(); }
  private sampleClock() {
    const wall = this.wallNow(), mono = this.monoNow();
    if (sawSuspend(wall - this.wall, mono - this.mono)) {
      this.wakeUntil = mono + 1000;
      this.lastHeartbeat = mono;
    }
    this.wall = wall; this.mono = mono;
    return { wall, mono, waking: mono <= this.wakeUntil };
  }
  get state() { return { kind: this.kind, pid: this.child?.pid ?? null, generation: this.generation, pending: this.pending.size, disabled: this.disabled, closed: this.closed, retryAt: this.retryAt }; }
  request(operation: "ping" | "read" | "scan", payload: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const clock = this.sampleClock();
    const timeout = opts.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_DEADLINE_MS) return Promise.reject(new WorkerOperationError("invalid worker deadline"));
    if (opts.signal?.aborted) return Promise.reject(new WorkerOperationError("cancelled"));
    if (this.closed || this.disabled || clock.mono < this.retryAt) return Promise.reject(new WorkerUnavailable("worker unavailable"));
    if (this.pending.size >= MAX_QUEUE + MAX_INFLIGHT) return Promise.reject(new WorkerUnavailable("worker queue full"));
    const frame: WorkerFrame = { v: 1, kind: this.kind, type: "request", id: `${this.generation + 1}_${++this.sequence}`, operation, payload, deadline: clock.wall + timeout };
    try { encodeFrame(frame); } catch { return Promise.reject(new WorkerOperationError("invalid worker request")); }
    return new Promise((resolve, reject) => {
      const p: Pending = { frame, resolve, reject, sent: false, timer: setTimeout(() => {
        if (p.sent) this.fail(this.generation, new WorkerUnavailable("worker deadline"));
        else this.settle(frame.id!, new WorkerUnavailable("worker queue deadline"));
      }, timeout), signal: opts.signal };
      if (opts.signal) {
        p.abort = () => {
          if (p.sent) {
            this.settle(frame.id!, new WorkerOperationError("cancelled"));
            this.fail(this.generation, new WorkerUnavailable("worker cancelled"), false);
          } else this.settle(frame.id!, new WorkerOperationError("cancelled"));
        };
        opts.signal.addEventListener("abort", p.abort, { once: true });
      }
      this.pending.set(frame.id!, p);
      try { if (!this.child) this.start(); this.pump(); } catch { this.fail(this.generation, new WorkerUnavailable("worker launch failed")); }
    });
  }
  private start() {
    const generation = ++this.generation;
    const invocation = this.options.invocation ?? workerInvocation(this.kind);
    const env = workerEnv(this.options.env ?? process.env);
    const child = this.options.spawnChild?.(invocation.command, invocation.args, env) ?? spawn(invocation.command, invocation.args, { env, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const decoder = new FrameDecoder();
    const failed = () => this.fail(generation, new WorkerUnavailable("worker exited"));
    child.on("error", failed);
    child.on("exit", failed);
    child.on("close", failed);
    child.stdin?.on("error", failed);
    child.stdout?.on("error", failed);
    child.stderr?.on("error", failed);
    child.stdout?.on("end", failed);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (generation !== this.generation || this.child !== child) return;
      try { for (const frame of decoder.push(chunk)) this.receive(frame); }
      catch { this.fail(generation, new WorkerUnavailable("invalid worker response")); }
    });
    let diagnostics = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostics += chunk.length;
      if (diagnostics > 8192) this.fail(generation, new WorkerUnavailable("worker diagnostic limit"));
    });
    this.lastHeartbeat = this.monoNow();
    this.heartbeat = setInterval(() => {
      const clock = this.sampleClock();
      if (!clock.waking && clock.mono - this.lastHeartbeat > (this.options.heartbeatTimeoutMs ?? 8000)) this.fail(generation, new WorkerUnavailable("worker heartbeat expired"));
    }, 1000);
    this.heartbeat.unref();
  }
  private receive(frame: WorkerFrame) {
    const clock = this.sampleClock();
    if (frame.kind !== this.kind) throw new Error("wrong worker kind");
    if (frame.type === "heartbeat") {
      if (frame.pid !== this.child?.pid) throw new Error("wrong worker pid");
      this.lastHeartbeat = this.monoNow(); return;
    }
    const p = frame.id && this.pending.get(frame.id);
    if (!p || !p.sent || !["result", "error"].includes(frame.type)) throw new Error("unexpected worker response");
    if (clock.wall >= p.frame.deadline!) { this.fail(this.generation, new WorkerUnavailable("worker deadline")); return; }
    if (frame.type === "result" && frame.operation !== p.frame.operation) throw new Error("wrong result operation");
    this.settle(frame.id!, frame.type === "error" ? new WorkerOperationError(frame.error) : null, frame.result);
    this.pump();
  }
  private pump() {
    if (!this.child) return;
    let active = [...this.pending.values()].filter(p => p.sent).length;
    for (const p of this.pending.values()) {
      if (active >= MAX_INFLIGHT) break;
      if (p.sent) continue;
      p.sent = true; active++;
      this.child.stdin!.write(encodeFrame(p.frame));
    }
  }
  private settle(id: string, error: Error | null, result?: unknown) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.abort) p.signal?.removeEventListener("abort", p.abort);
    if (error) p.reject(error); else p.resolve(result);
  }
  private fail(generation: number, error: Error, crashed = true) {
    if (generation !== this.generation) return;
    const clock = this.sampleClock();
    const child = this.child;
    this.child = null;
    this.generation++;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (child) {
      if (this.options.killChild) this.options.killChild(child);
      else if (child.pid) killWorkerGroup(child.pid);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    }
    for (const id of this.pending.keys()) this.settle(id, error);
    if (!this.closed && crashed && !clock.waking) {
      const now = clock.mono;
      this.crashes = this.crashes.filter(t => now - t < 600_000);
      this.crashes.push(now);
      this.retryAt = now + (this.options.backoffMs ?? [1000, 5000, 30000])[Math.min(this.crashes.length - 1, 2)];
      if (this.crashes.length >= 3) this.disabled = true;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(this.generation, new WorkerUnavailable("worker closed"));
  }
}
