/**
 * One tmux server per agent session.
 *
 * macOS divides CPU between groups of processes before it divides it between
 * the processes inside a group, and each launchd job is a group. Every agent
 * used to run in one tmux server, so the whole fleet was one group, and a busy
 * group yields to every light one: on 2026-10-06 eight busy loops in an agent
 * pane got 0.05 cores while the same eight spread over eight launchd jobs got
 * 1.5. So an agent session gets its own tmux server, started as its own
 * launchd job, and a session that saturates its group slows itself rather
 * than every other session on the machine.
 *
 * A session's server listens on a socket named after the session, so a call
 * that names its target finds the server with one stat and no lookup table.
 * Ids are a different matter: every server numbers its panes and sessions
 * from %0 and $0, so a call that targets an id, or lists the whole fleet,
 * inside work for one session runs in that session's scope (withTmuxSession)
 * and reaches only that session's server. Outside any scope a fleet listing
 * asks every server and joins the answers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { readLocalConfig } from "./config/readLocalConfig.js";

export const SESSION_SOCKET_PREFIX = "cast-";

/** Names of the tmux sessions agents run in (resumeCommand.ts MANAGED_TMUX_PREFIXES, plus workflow, task and wrapper panes). */
const AGENT_SESSION_RE = /^(cc|cx|cu|gm|oc|pi|wf|ct|codecast)-[\w-]+$/;

export function tmuxSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
}

export function sessionSocketName(session: string): string {
  return SESSION_SOCKET_PREFIX + session;
}

/** Every per-session server socket on this machine, by socket name. */
export function sessionServerSockets(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return fs.readdirSync(tmuxSocketDir(env)).filter((f) => f.startsWith(SESSION_SOCKET_PREFIX)).sort();
  } catch {
    return [];
  }
}

export function hasSessionServer(session: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(path.join(tmuxSocketDir(env), sessionSocketName(session)));
}

let enabledCache: { at: number; value: boolean } | null = null;
/** Whether new agent sessions get their own server: macOS, and `tmux_server_per_session` in config.json. */
export function perSessionServersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODECAST_TMUX_PER_SESSION) return env.CODECAST_TMUX_PER_SESSION === "1";
  if (process.platform !== "darwin") return false;
  const now = Date.now();
  if (!enabledCache || now - enabledCache.at > 10_000) {
    enabledCache = { at: now, value: readLocalConfig()?.tmux_server_per_session === true };
  }
  return enabledCache.value;
}

const scope = new AsyncLocalStorage<string>();

/** Run `fn` as work for one session: its id targets and fleet listings reach only that session's server. */
export function withTmuxSession<T>(session: string, fn: () => T): T {
  return scope.run(session, fn);
}

const FLEET_LISTINGS = new Set(["list-sessions", "ls", "list-panes", "list-clients", "list-windows"]);

function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** The session a target names, `null` for an id target (%3, $2, @1), `undefined` when there is none. */
export function targetSession(target: string | null): string | null | undefined {
  if (target === null) return undefined;
  const t = target.startsWith("=") ? target.slice(1) : target;
  if (/^[%$@]/.test(t)) return null;
  const name = t.split(/[:.]/)[0];
  return name || undefined;
}

/** The verb and its arguments, past any global flags a caller already put in front. */
function verbIndex(args: string[]): number {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-L" || args[i] === "-S" || args[i] === "-f" ? 2 : 1;
  return i;
}

/** The agent session a server-starting `new-session` names, when that session should get its own server. */
export function ownServerSession(args: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (args.includes("-L") || args.includes("-S")) return null;
  const rest = args.slice(verbIndex(args));
  if (rest[0] !== "new-session" && rest[0] !== "new") return null;
  const name = flagValue(rest, "-s");
  if (!name || !AGENT_SESSION_RE.test(name) || !perSessionServersEnabled(env)) return null;
  return name;
}

/**
 * The argv lists one tmux call becomes: one list for a call that reaches one
 * server, one per server for a fleet listing outside any session scope.
 */
export function routeTmuxArgs(args: string[], env: NodeJS.ProcessEnv = process.env, scoped: string | undefined = scope.getStore()): string[][] {
  if (args.includes("-L") || args.includes("-S")) return [args];
  const rest = args.slice(verbIndex(args));
  const verb = rest[0] ?? "";
  const target = verb === "new-session" || verb === "new" ? flagValue(rest, "-s") : flagValue(rest, "-t");
  const named = targetSession(target);
  const own = (session: string | undefined) => (session && hasSessionServer(session, env) ? [["-L", sessionSocketName(session), ...args]] : null);
  if (named) return own(named) ?? [args];
  if (scoped) return own(scoped) ?? [args];
  const fleet = named === undefined && FLEET_LISTINGS.has(verb) && (verb !== "list-panes" && verb !== "list-windows" || rest.includes("-a"));
  if (!fleet) return [args];
  return [args, ...sessionServerSockets(env).map((s) => ["-L", s, ...args])];
}

/** Join the stdout of a fleet listing: one line per row, whatever each server ended with. */
export function joinListings(outputs: string[]): string {
  const rows = outputs.map((o) => o.replace(/\n+$/, "")).filter(Boolean);
  return rows.length ? `${rows.join("\n")}\n` : "";
}

/**
 * Run one routed tmux call. `exec` throws on failure. A fleet listing answers
 * with every server that answered, and fails only when none did: a server
 * that exited between the directory read and the call is simply not listed.
 */
export function runRoutedSync<T>(argvs: string[][], exec: (argv: string[]) => T, join: (results: T[]) => T): T {
  if (argvs.length === 1) return exec(argvs[0]);
  const results: T[] = [];
  let firstError: unknown;
  for (const argv of argvs) {
    try {
      results.push(exec(argv));
    } catch (err) {
      firstError ??= err;
    }
  }
  if (results.length === 0) throw firstError;
  return join(results);
}

const FLEET_CONCURRENCY = 8;

export async function runRouted<T>(argvs: string[][], exec: (argv: string[]) => Promise<T>, join: (results: T[]) => T): Promise<T> {
  if (argvs.length === 1) return exec(argvs[0]);
  const settled: PromiseSettledResult<T>[] = new Array(argvs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, argvs.length) }, async () => {
    while (next < argvs.length) {
      const i = next++;
      settled[i] = await exec(argvs[i]).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
    }
  }));
  const results = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (results.length === 0) throw (settled.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
  return join(results);
}
