import { execFile } from "../proc.js";
import { LAUNCH_TOKEN_VAR } from "../agentEnv.js";
import { detectDeliveryTarget, type DeliveryTarget } from "./targets.js";

export type RegisterOptions = { sessionId?: string; cwd?: string };

export type HookInput = { session_id?: string; cwd?: string };

export type CommandClient = { mutation(name: string, args: Record<string, unknown>): Promise<any> };

export type RegisterDeps = {
  config: { auth_token?: string; convex_url?: string } | null;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  readStdin: () => Promise<string>;
  ancestorComms: () => Promise<string[]>;
  identify: (target: DeliveryTarget) => Promise<string | undefined>;
  gitRemote: (cwd: string) => Promise<string | undefined>;
  deviceId: () => string;
  cwd: () => string;
  makeClient: (convexUrl: string) => CommandClient;
  out: (line: string) => void;
  err: (line: string) => void;
  timeoutMs?: number;
};

export const COMMAND_TIMEOUT_MS = 5_000;
const STDIN_TIMEOUT_MS = 2_000;
const MAX_ANCESTORS = 16;

export function parseHookInput(raw: string): HookInput {
  try {
    const parsed = JSON.parse(raw);
    return {
      session_id: typeof parsed?.session_id === "string" ? parsed.session_id : undefined,
      cwd: typeof parsed?.cwd === "string" ? parsed.cwd : undefined,
    };
  } catch {
    return {};
  }
}

export function isClaudeComm(comm: string): boolean {
  const name = comm.trim().split("/").pop() ?? "";
  return /^claude(-code)?$/i.test(name) || /^\d+\.\d+\.\d+$/.test(name);
}

export async function resolveInput(opts: RegisterOptions, deps: Pick<RegisterDeps, "stdinIsTTY" | "readStdin" | "cwd">): Promise<{ sessionId?: string; cwd: string }> {
  const fromHook = !deps.stdinIsTTY && (!opts.sessionId || !opts.cwd) ? parseHookInput(await deps.readStdin()) : {};
  return { sessionId: opts.sessionId ?? fromHook.session_id, cwd: opts.cwd ?? fromHook.cwd ?? deps.cwd() };
}

export function cleanServerError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const match = text.match(/Uncaught Error: ([^\n]*)/);
  return (match?.[1] ?? text.split("\n")[0]).replace(/\s+at (handler|async).*$/, "").trim();
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function guarded(name: string, deps: RegisterDeps, body: () => Promise<void>): Promise<number> {
  try {
    await withTimeout(body(), (deps.timeoutMs ?? COMMAND_TIMEOUT_MS) + STDIN_TIMEOUT_MS + 1_000, name);
  } catch (err) {
    deps.err(`cast ${name}: ${cleanServerError(err)}`);
  }
  return 0;
}

export function runRegister(opts: RegisterOptions, deps: RegisterDeps): Promise<number> {
  return guarded("register", deps, async () => {
    if (deps.env[LAUNCH_TOKEN_VAR]) return;
    const target = detectDeliveryTarget(deps.env);
    if (!target) return;
    const ancestry = (await deps.ancestorComms()).filter(isClaudeComm).length;
    if (ancestry !== 1) {
      if (ancestry > 1) return;
      deps.err("cast register: not running inside a Claude Code session; nothing registered");
      return;
    }
    const provider = await withTimeout(deps.identify(target), Math.min(3_000, deps.timeoutMs ?? COMMAND_TIMEOUT_MS), "identify").catch(() => undefined);
    if (provider && provider.toLowerCase() !== "claude") return;
    const { sessionId, cwd } = await resolveInput(opts, deps);
    if (!sessionId) return deps.err("cast register: no session id (pass --session-id or run from a SessionStart hook)");
    if (!deps.config?.auth_token || !deps.config.convex_url) return deps.err("cast register: not logged in; run: cast auth");
    const git_remote_url = await deps.gitRemote(cwd);
    const client = deps.makeClient(deps.config.convex_url);
    const res = await withTimeout(
      client.mutation("registeredSessions:registerSession", {
        api_token: deps.config.auth_token,
        session_id: sessionId,
        cwd,
        device_id: deps.deviceId(),
        delivery_target: target,
        ...(git_remote_url ? { git_remote_url } : {}),
      }),
      deps.timeoutMs ?? COMMAND_TIMEOUT_MS,
      "registerSession",
    );
    if (deps.stdoutIsTTY && res?.short_id) deps.out(res.short_id);
  });
}

export function runUnregister(opts: RegisterOptions, deps: RegisterDeps): Promise<number> {
  return guarded("unregister", deps, async () => {
    const { sessionId } = await resolveInput(opts, deps);
    const target = detectDeliveryTarget(deps.env);
    if (!sessionId) return deps.err("cast unregister: no session id (pass --session-id or run from a SessionEnd hook)");
    if (!deps.config?.auth_token || !deps.config.convex_url) return deps.err("cast unregister: not logged in; run: cast auth");
    try {
      await withTimeout(
        deps.makeClient(deps.config.convex_url).mutation("registeredSessions:markEnded", {
          api_token: deps.config.auth_token,
          session_id: sessionId,
          device_id: deps.deviceId(),
          ...(target ? { delivery_target: target } : {}),
        }),
        deps.timeoutMs ?? COMMAND_TIMEOUT_MS,
        "markEnded",
      );
    } catch (err) {
      if (/No registered session found/.test(cleanServerError(err))) return;
      throw err;
    }
  });
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8", timeout: timeoutMs }, (err: Error | null, stdout: string) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export async function realAncestorComms(startPid: number = process.pid, exec: (file: string, args: string[], timeoutMs: number) => Promise<string> = run): Promise<string[]> {
  const comms: string[] = [];
  let pid = startPid;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const line = await exec("ps", ["-o", "ppid=,comm=", "-p", String(pid)], 2_000).catch(() => "");
    const m = line.match(/^\s*(\d+)\s+(.*?)\s*$/m);
    if (!m) break;
    if (i > 0) comms.push(m[2]);
    pid = Number(m[1]);
  }
  return comms;
}

export async function realGitRemote(cwd: string): Promise<string | undefined> {
  const out = await run("git", ["-C", cwd, "remote", "get-url", "origin"], 2_000).catch(() => "");
  return out.trim() || undefined;
}

export function readStdinBounded(stream: NodeJS.ReadableStream = process.stdin, timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", done);
      stream.removeListener("error", done);
      resolve(buf);
    };
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
    };
    const timer = setTimeout(done, timeoutMs);
    stream.on("data", onData);
    stream.on("end", done);
    stream.on("error", done);
  });
}
