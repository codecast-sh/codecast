// The session a process was started by, read from the environment it was
// exec'd with. An agent's shell exports its session id, and every process
// that shell starts inherits it, including ones that leave the agent's
// process tree: a job backgrounded with `&` or nohup is reparented to init,
// yet still names the session. A process's exec environment never changes,
// so each one is read once per process generation.
import fs from "node:fs";
import { AGENT_START_JITTER_MS, type ProcessInfo } from "./resourceMonitor.js";
import { sessionIdFromEnv } from "./sessionIdentity.js";

/** The variables that name the session a process works for (sessionIdFromEnv reads them). */
export const SESSION_ENV_KEYS = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODECAST_SESSION_ID", "CODECAST_MANAGED_SESSION"];
const KEYS = [...SESSION_ENV_KEYS, "TMUX"];

/** An environment that names no session: for what the daemon starts on its own behalf. */
export function withoutSessionIds<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const k of SESSION_ENV_KEYS) delete out[k];
  return out;
}

/** Sessions from `tmux show-environment -t <s>` output that name `sessionId`. */
export function tmuxEnvNamesSession(showEnvironment: string, sessionId: string): boolean {
  return sessionIdFromEnv(pickEnv(showEnvironment.split("\n"))) === sessionId;
}

/**
 * The tmux options that make a session an agent creates carry the agent's id:
 * tmux copies only the variables in `update-environment` from the creating
 * client, so without them every pane inherits the server's environment and
 * names nobody. Returns the `set-option` calls still needed, given the current value.
 */
export function tmuxSessionEnvUpdates(current: string): string[][] {
  const have = new Set(current.split(/\s+/).filter(Boolean));
  return SESSION_ENV_KEYS.filter((k) => !have.has(k)).map((k) => ["set-option", "-ga", "update-environment", k]);
}
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
/** Reads per periodic sample. A daemon's first sample meets every process at once; the rest are read on later samples. */
const READS_PER_SAMPLE = 400;

export type EnvSession = { sessionId: string; via: "tmux" | "background" };

/**
 * A lookup from a process to the session its environment names, for processes
 * outside every session's tree. Two inherited ids are no evidence and are
 * ignored: one the tmux server itself carries (an agent started the server, so
 * every pane inherits it), and anything under this daemon (started from an
 * agent's shell, its children all carry that agent's id).
 */
export function envSessionLookup(snapshot: Map<number, ProcessInfo>, sessions: Map<string, number>, read: (pid: number) => Env | null = readEnv, self = process.pid, budget = READS_PER_SAMPLE): (p: ProcessInfo) => EnvSession | undefined {
  for (const pid of cache.keys()) if (!snapshot.has(pid)) cache.delete(pid);
  let reads = 0;
  const env = (pid: number): Env | null => {
    const p = snapshot.get(pid);
    const hit = cache.get(pid);
    if (hit && (hit.startedAt === undefined || p?.startedAt === undefined || Math.abs(hit.startedAt - p.startedAt) <= AGENT_START_JITTER_MS)) return hit.env;
    if (++reads > budget) return null;
    const e = read(pid);
    cache.set(pid, { startedAt: p?.startedAt, env: e });
    return e;
  };
  const under = (p: ProcessInfo, ancestor: number) => {
    const seen = new Set<number>();
    for (let c: ProcessInfo | undefined = p; c && !seen.has(c.pid); c = snapshot.get(c.ppid)) {
      if (c.pid === ancestor) return true;
      seen.add(c.pid);
    }
    return false;
  };
  return (p) => {
    // A tmux server serves every pane on the machine, whoever's shell started it.
    if (/(^|\/)tmux( |$)/.test(p.command ?? "")) return undefined;
    const e = env(p.pid);
    const id = e ? sessionIdFromEnv(e) : null;
    if (!id || !sessions.has(id) || under(p, self)) return undefined;
    const server = Number(e!.TMUX?.split(",")[1]);
    if (server && server !== p.pid) {
      const s = env(server);
      if (s && sessionIdFromEnv(s) === id) return undefined;
    }
    // TMUX is inherited too: a job an agent in a pane backgrounds carries it, yet left the pane.
    return { sessionId: id, via: server && under(p, server) ? "tmux" : "background" };
  };
}
