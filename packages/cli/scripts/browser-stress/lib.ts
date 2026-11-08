/**
 * Shared plumbing for the `cast browser` stress suites (soak.ts, fuzz.ts):
 * the rig they run against, a seeded PRNG, a bounded CLI runner, a small CDP
 * client for the bridge and the rig Chrome, and the run directory.
 *
 * Everything acts on ONE rig brought up by scripts/browser-rig.ts (its
 * /tmp/cast-browser-rig/<name>/state.json and env). Nothing here reads the
 * human's ~/.codecast or talks to port 41729: the bridge port, token and HOME
 * all come from the rig's own files, and `requireRig` refuses a rig whose
 * HOME is the real home.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BRIDGE_DEFAULT_PORT } from "../../src/browser/bridge/protocol.ts";

export const REPO = path.resolve(import.meta.dir, "../../../..");
export const CLI_ENTRY = path.join(REPO, "packages/cli/src/main.ts");
export const RIG_SCRIPT = path.join(REPO, "packages/cli/scripts/browser-rig.ts");
const RIG_ROOT = process.env.CAST_RIG_ROOT || "/tmp/cast-browser-rig";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function args(argv = process.argv.slice(2)) {
  const opt = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const num = (name: string, fallback: number) => {
    const v = Number(opt(name));
    return Number.isFinite(v) && opt(name) !== undefined ? v : fallback;
  };
  return { opt, num, flag: (name: string) => argv.includes(`--${name}`) };
}

// ---------------------------------------------------------------------------
// Seeded PRNG: a failing run replays with the same --seed
// ---------------------------------------------------------------------------

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // xorshift32
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** A child stream, so one consumer's draws do not shift another's. */
  fork(salt: number): Rng {
    return new Rng((this.int(2 ** 31) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

export interface Rig {
  name: string;
  dir: string;
  bridgePort: number;
  cdpPort: number;
  chromePid: number;
  fixtures?: [string, string];
  /** The rig's env file, parsed: what `exec` sets, minus the session. */
  env: Record<string, string>;
  /** Variables the rig unsets so the calling agent's own ids do not leak in. */
  unset: string[];
}

export function rigDir(name: string): string {
  return path.join(RIG_ROOT, name);
}

export function requireRig(name: string | undefined): Rig {
  if (!name) die("--rig <name> is required: bring one up with `bun packages/cli/scripts/browser-rig.ts up --fixtures --name <name>`");
  const dir = rigDir(name);
  let state: any;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
  } catch {
    die(`rig "${name}" is not up (no ${dir}/state.json)`);
  }
  const env: Record<string, string> = {};
  let unset: string[] = [];
  for (const line of fs.readFileSync(path.join(dir, "env"), "utf-8").split("\n")) {
    const ex = /^export ([A-Z_]+)='(.*)'$/.exec(line);
    if (ex) env[ex[1]] = ex[2].replace(/'\\''/g, "'");
    const un = /^unset (.+)$/.exec(line);
    if (un) unset = un[1].split(/\s+/);
  }
  const realHome = path.resolve(os.userInfo().homedir);
  if (!env.HOME || path.resolve(env.HOME).startsWith(realHome)) die(`rig "${name}" has HOME ${env.HOME}, which is not a /tmp rig home`);
  if (state.bridgePort === BRIDGE_DEFAULT_PORT) die(`rig "${name}" sits on the live bridge port ${BRIDGE_DEFAULT_PORT}`);
  return { name, dir, bridgePort: state.bridgePort, cdpPort: state.cdpPort, chromePid: state.chromePid, fixtures: state.fixtures, env, unset };
}

/** The rig's bridge.json: port, token and the current host pid (a respawned host rewrites it). */
export function rigBridge(rig: Rig): { port: number; token: string; hostPid?: number } {
  return JSON.parse(fs.readFileSync(path.join(rig.env.CODECAST_DIR, "browser", "bridge.json"), "utf-8"));
}

export function rigState(rig: Rig): { chromePid: number; cdpPort: number } {
  return JSON.parse(fs.readFileSync(path.join(rig.dir, "state.json"), "utf-8"));
}

/** The env a CLI process acting as `session` runs with. */
export function sessionEnv(rig: Rig, session: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of rig.unset) delete env[k];
  return { ...env, ...rig.env, CAST_SESSION_ID: session, CODECAST_SESSION_ID: session };
}

/** Refuse to start a long run on an overloaded machine (the rule is the caller's: soak/fuzz pass their own ceiling). */
export function checkLoad(ceiling: number, force: boolean): number {
  const load = os.loadavg()[0];
  if (load > ceiling && !force) die(`load average is ${load.toFixed(0)} (> ${ceiling}); try later, or pass --force`);
  return load;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** Killed at its deadline. */
  hung: boolean;
  /** When the process itself exited; a hang with an exit time is output held open by something it started. */
  exitedMs: number | null;
}

/** Pids of every child this process started and has not seen exit; the end-of-run check reads it. */
export const liveChildren = new Set<number>();

/** Run a command with a hard deadline: past it the process and everything under it is killed and the result says `hung`. */
export async function run(cmd: string, argv: string[], opts: { env?: NodeJS.ProcessEnv; deadlineMs: number; cwd?: string; onHang?: (pid: number) => Promise<void> }): Promise<RunResult> {
  const started = Date.now();
  // Bun.spawn rather than child_process: under many concurrent children the
  // latter left exited commands unreaped (zombies) and never emitted "close",
  // which read as a hang in the command.
  const proc = Bun.spawn([cmd, ...argv], { env: opts.env, cwd: opts.cwd ?? REPO, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  liveChildren.add(proc.pid);
  let hung = false;
  let exitedAt = 0;
  const exited = proc.exited.then((code) => ((exitedAt = Date.now()), code));
  const timer = setTimeout(async () => {
    hung = true;
    await opts.onHang?.(proc.pid).catch(() => {});
    for (const pid of descendants(proc.pid).reverse()) try { process.kill(pid, "SIGKILL"); } catch {}
  }, opts.deadlineMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), exited]);
  clearTimeout(timer);
  liveChildren.delete(proc.pid);
  return { code: hung ? null : code, stdout, stderr, ms: Date.now() - started, hung, exitedMs: exitedAt ? exitedAt - started : null };
}

/** `pid` and every process under it, parents first. */
export function descendants(pid: number): number[] {
  const rows = Bun.spawnSync(["ps", "-Ao", "pid=,ppid="]).stdout.toString().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2);
  const out = [pid];
  for (let k = 0; k < out.length; k++) for (const [c, p] of rows) if (p === out[k] && !out.includes(c)) out.push(c);
  return out;
}

export function cli(rig: Rig, session: string, browserArgs: string[], deadlineMs: number, extraEnv: Record<string, string> = {}, onHang?: (pid: number) => Promise<void>): Promise<RunResult> {
  return run("bun", [CLI_ENTRY, "browser", ...browserArgs], { env: { ...sessionEnv(rig, session), ...extraEnv }, deadlineMs, onHang });
}

export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process state letter from ps (T = stopped, Z = zombie), or null when it is gone. */
export function procState(pid: number): string | null {
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const s = r.stdout.toString().trim();
  return s ? s[0] : null;
}

// ---------------------------------------------------------------------------
// CDP over a websocket (the bridge's face or the rig Chrome's own)
// ---------------------------------------------------------------------------

export class CdpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export class CdpClient {
  private id = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer }>();
  readonly events: Array<{ method: string; params: any; sessionId?: string }> = [];
  closed: { code: number; reason: string } | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      let m: any;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new CdpError(m.error.message, m.error.code)) : p.resolve(m.result);
      } else if (m.method) {
        if (this.events.length < 500) this.events.push(m);
      }
    };
    ws.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason };
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new CdpError(`socket closed (${e.code})`));
      }
      this.pending.clear();
    };
  }
  static connect(url: string, timeoutMs = 15_000, headers?: Record<string, string>): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, headers ? ({ headers } as any) : undefined);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`websocket ${url.replace(/\/devtools\/browser\/[^?]+/, "/devtools/browser/<token>")} did not open within ${timeoutMs}ms`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      };
      ws.onerror = () => {};
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(`websocket closed before open (${e.code} ${e.reason})`));
      };
    });
  }
  /** The rig Chrome's own browser socket: the oracle, outside the bridge. */
  static async chrome(cdpPort: number): Promise<CdpClient> {
    const v = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(10_000) })).json()) as any;
    return CdpClient.connect(v.webSocketDebuggerUrl);
  }
  /** The bridge's CDP face as one cast session (or none: the human's own tooling). */
  static bridge(port: number, token: string, session?: string): Promise<CdpClient> {
    return CdpClient.connect(`ws://127.0.0.1:${port}/devtools/browser/${token}${session ? `?session=${encodeURIComponent(session)}` : ""}`);
  }
  send(method: string, params: unknown = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    return this.sendRaw({ method, params, ...(sessionId ? { sessionId } : {}) }, timeoutMs);
  }
  /** Send a message with any shape (the id is assigned here); resolves with the result, rejects with the error. */
  sendRaw(msg: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new CdpError(`socket closed (${this.closed?.code ?? this.ws.readyState})`));
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError(`${String(msg.method)} timed out after ${timeoutMs}ms`, -1));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export class RunLog {
  readonly dir: string;
  private files = new Map<string, number>();
  constructor(kind: string, seed: number) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.dir = path.join(os.tmpdir(), "cast-browser-stress", `${stamp}-${kind}-seed${seed}`);
    fs.mkdirSync(this.dir, { recursive: true });
  }
  write(file: string, row: Record<string, unknown>): void {
    let fd = this.files.get(file);
    if (fd === undefined) this.files.set(file, (fd = fs.openSync(path.join(this.dir, file), "a")));
    fs.writeSync(fd, JSON.stringify({ t: new Date().toISOString(), ...row }) + "\n");
  }
  text(file: string, body: string): string {
    const p = path.join(this.dir, file);
    fs.writeFileSync(p, body);
    return p;
  }
}

export function oneLine(s: string, max = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function die(msg: string): never {
  console.error(`browser-stress: ${msg}`);
  process.exit(2);
}

/** The process tree under `pid` (its group), one line each: what a hung command was waiting on. */
export function processTree(pid: number): string {
  const out = Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,pgid=,etime=,stat=,command="]).stdout.toString().split("\n");
  const rows = out.map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const keep = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (!keep.has(+r[1]) && (keep.has(+r[2]) || +r[3] === pid)) (keep.add(+r[1]), (grew = true));
  }
  return rows.filter((r) => keep.has(+r[1])).map((r) => `${r[1]} ppid ${r[2]} ${r[4]} ${r[5]} ${r[6].slice(0, 200)}`).join("\n");
}

/** Evaluate an expression in the cast extension's service worker over the rig Chrome's own CDP port. */
export async function inWorker(cdpPort: number, extId: string, expression: string): Promise<unknown> {
  const c = await CdpClient.chrome(cdpPort);
  try {
    const { targetInfos } = await c.send("Target.getTargets");
    const sw = (targetInfos as any[]).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!sw) return null;
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, 10_000);
    return r.result?.value ?? r.exceptionDetails?.text;
  } finally {
    c.close();
  }
}

/**
 * Other processes holding this process's child pipes (fd 0-2 on a pipe whose
 * address one of ours names): what keeps a command's output open after it exited.
 */
export function pipeHolders(): string[] {
  const ours = Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(process.pid)]).stdout.toString().split("\n").filter((l) => / PIPE /.test(l));
  const addrs = new Set(ours.flatMap((l) => [...l.matchAll(/0x[0-9a-f]+/g)].map((m) => m[0])));
  const all = Bun.spawnSync(["lsof", "-nP", "-d", "0,1,2"]).stdout.toString().split("\n");
  return all.filter((l) => / PIPE /.test(l) && !new RegExp(`^\\S+\\s+${process.pid}\\s`).test(l) && [...l.matchAll(/0x[0-9a-f]+/g)].some((m) => addrs.has(m[0])));
}
