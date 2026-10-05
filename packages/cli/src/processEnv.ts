// The session a process was started by, read from the environment it was
// exec'd with. An agent's shell exports its session id, and every process
// that shell starts inherits it, including ones that leave the agent's
// process tree: a job backgrounded with `&` or nohup is reparented to init,
// yet still names the session. A process's exec environment never changes,
// so each one is read once per process generation.
import fs from "node:fs";
import { AGENT_START_JITTER_MS, type ProcessInfo } from "./resourceMonitor.js";
import { sessionIdFromEnv } from "./sessionIdentity.js";

const KEYS = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODECAST_SESSION_ID", "CODECAST_MANAGED_SESSION", "TMUX"];
type Env = Record<string, string>;

/** Pick the keys we care about out of NUL-separated `KEY=value` strings. */
export function pickEnv(strings: Iterable<string>): Env {
  const out: Env = {};
  for (const s of strings) {
    const eq = s.indexOf("=");
    if (eq > 0 && KEYS.includes(s.slice(0, eq))) out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

/** KERN_PROCARGS2 layout: int argc, exec path, NUL padding, argc args, then env strings until an empty one. */
export function parseProcArgs2(buf: Uint8Array): Env {
  if (buf.length < 4) return {};
  const argc = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(0, true);
  const dec = new TextDecoder();
  let i = 4;
  const next = () => { const start = i; while (i < buf.length && buf[i] !== 0) i++; const s = dec.decode(buf.subarray(start, i)); i++; return s; };
  next(); // exec path
  while (i < buf.length && buf[i] === 0) i++;
  for (let a = 0; a < argc && i < buf.length; a++) next();
  const env: string[] = [];
  while (i < buf.length) { const s = next(); if (!s) break; env.push(s); }
  return pickEnv(env);
}

let darwinReader: ((pid: number) => Env | null) | null | undefined;
function darwinEnv(pid: number): Env | null {
  if (darwinReader === undefined) {
    darwinReader = null;
    try {
      const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
      const lib = dlopen("libSystem.B.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });
      const buf = new Uint8Array(1 << 20); // kern.argmax
      const mib = new Int32Array([1 /* CTL_KERN */, 49 /* KERN_PROCARGS2 */, 0]);
      const len = new BigUint64Array(1);
      darwinReader = (p) => {
        mib[2] = p;
        len[0] = BigInt(buf.length);
        if (lib.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(len), null, 0) !== 0) return null;
        return parseProcArgs2(buf.subarray(0, Number(len[0])));
      };
    } catch {
      // No FFI (not under bun): attribution falls back to the process tree alone.
    }
  }
  return darwinReader ? darwinReader(pid) : null;
}

function readEnv(pid: number): Env | null {
  try {
    if (process.platform === "linux") return pickEnv(fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0"));
    if (process.platform === "darwin") return darwinEnv(pid);
  } catch {}
  return null;
}

const cache = new Map<number, { startedAt?: number; env: Env | null }>();
/** Reads per sample. A daemon's first sample meets every process at once; the rest are read on later samples. */
const READS_PER_SAMPLE = 400;

/**
 * A lookup from a process to the live session its environment names, for
 * processes outside every session's tree. A process inside a tmux pane
 * inherits the tmux server's environment, so an id the server itself carries
 * (an agent started the server) says nothing about the pane and is ignored.
 */
export function envSessionLookup(snapshot: Map<number, ProcessInfo>, sessions: Map<string, number>, read: (pid: number) => Env | null = readEnv): (p: ProcessInfo) => string | undefined {
  for (const pid of cache.keys()) if (!snapshot.has(pid)) cache.delete(pid);
  let reads = 0;
  const env = (pid: number): Env | null => {
    const p = snapshot.get(pid);
    const hit = cache.get(pid);
    if (hit && (hit.startedAt === undefined || p?.startedAt === undefined || Math.abs(hit.startedAt - p.startedAt) <= AGENT_START_JITTER_MS)) return hit.env;
    if (++reads > READS_PER_SAMPLE) return null;
    const e = read(pid);
    cache.set(pid, { startedAt: p?.startedAt, env: e });
    return e;
  };
  return (p) => {
    const e = env(p.pid);
    const id = e ? sessionIdFromEnv(e) : null;
    if (!id || !sessions.has(id)) return undefined;
    const server = Number(e!.TMUX?.split(",")[1]);
    if (server && server !== p.pid && (() => { const s = env(server); return s && sessionIdFromEnv(s) === id; })()) return undefined;
    return id;
  };
}
