import { WORKER_KINDS, validProbePayload, validProbeResult, type WorkerKind } from "./operations.js";
import { validScanPayload, validScanPage } from "./scanTypes.js";
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_INFLIGHT = 4;
export const MAX_QUEUE = 32;
export const MAX_DEADLINE_MS = 60_000;
export type WorkerFrame = { v: 1; kind: WorkerKind; type: "request" | "result" | "error" | "heartbeat" | "cancel"; id?: string; operation?: "ping" | "read" | "scan"; payload?: unknown; deadline?: number; result?: unknown; error?: string; pid?: number };
export function validateFrame(value: unknown): asserts value is WorkerFrame {
  const f = value as WorkerFrame;
  if (!f || typeof f !== "object" || Array.isArray(f) || f.v !== PROTOCOL_VERSION || !WORKER_KINDS.includes(f.kind)) throw new Error("invalid worker envelope");
  const keys = { request: ["id", "operation", "payload", "deadline"], result: ["id", "operation", "result"], error: ["id", "error"], heartbeat: ["pid"], cancel: ["id"] }[f.type];
  if (!keys || Object.keys(f).some(k => !["v", "kind", "type", ...keys].includes(k))) throw new Error("invalid worker frame");
  if (f.type === "heartbeat") {
    if (!Number.isSafeInteger(f.pid) || f.pid! <= 1) throw new Error("invalid heartbeat");
    return;
  }
  if (typeof f.id !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(f.id)) throw new Error("invalid correlation id");
  if (f.type === "request" || f.type === "result") {
    if (f.operation !== "ping" && !(f.operation === "read" && f.kind === "probe") && !(f.operation === "scan" && f.kind === "scan")) throw new Error("invalid worker operation");
  }
  if (f.type === "request") {
    if (!Number.isSafeInteger(f.deadline) || f.deadline! <= 0) throw new Error("invalid deadline");
    if (f.operation === "scan" ? !validScanPayload(f.payload) : f.operation === "read" ? !validProbePayload(f.payload) : f.payload !== null) throw new Error("invalid worker payload");
  }
  if (f.type === "result") {
    if (f.operation === "scan" ? !validScanPage(f.result) : f.operation === "read" ? !validProbeResult(f.result) : f.result !== "pong") throw new Error("invalid worker result");
  }
  if (f.type === "error" && !["deadline", "cancelled", "busy", "operation_failed"].includes(f.error ?? "")) throw new Error("invalid worker error");
}
export function encodeFrame(frame: WorkerFrame): string {
  validateFrame(frame);
  const line = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("worker frame too large");
  return line;
}
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit = MAX_FRAME_BYTES) {}
  push(chunk: Buffer): WorkerFrame[] {
    const frames: WorkerFrame[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      this.append(chunk.subarray(start, i + 1));
      const line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.chunks, this.size));
      this.chunks = []; this.size = 0;
      const frame: unknown = JSON.parse(line);
      validateFrame(frame);
      frames.push(frame);
      start = i + 1;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
    return frames;
  }
  private append(chunk: Buffer) {
    this.size += chunk.length;
    if (this.size > this.limit) throw new Error("worker frame too large");
    this.chunks.push(Buffer.from(chunk));
  }
  end() { if (this.size) throw new Error("truncated worker frame"); }
}
