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
import { TMUX_SESSION_SOCKET_PREFIX } from "@codecast/shared/contracts";
import { readLocalConfig } from "./config/readLocalConfig.js";
import { snapshotProcessTable, snapshotProcessTableAsync, tmuxServerRows, type ProcRow } from "./processTable.js";

export const SESSION_SOCKET_PREFIX = TMUX_SESSION_SOCKET_PREFIX;

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
/** Whether new agent sessions get their own server: on macOS unless `tmux_server_per_session` is false in config.json. */
export function perSessionServersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODECAST_TMUX_PER_SESSION) return env.CODECAST_TMUX_PER_SESSION === "1";
  if (process.platform !== "darwin") return false;
  const now = Date.now();
  if (!enabledCache || now - enabledCache.at > 10_000) {
    enabledCache = { at: now, value: readLocalConfig()?.tmux_server_per_session !== false };
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
/** Whether the call already names its server: -L or -S among the global flags before the verb (capture-pane's -S is a line number). */
function namesServer(args: string[]): boolean {
  const globals = args.slice(0, verbIndex(args));
  return globals.includes("-L") || globals.includes("-S");
}

export function ownServerSession(args: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (namesServer(args)) return null;
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
  if (namesServer(args)) return [args];
  const rest = args.slice(verbIndex(args));
  const verb = rest[0] ?? "";
  const target = verb === "new-session" || verb === "new" ? flagValue(rest, "-s") : flagValue(rest, "-t");
  const named = targetSession(target);
  // Inside a pane, tmux talks to the server in $TMUX, which may be a session's
  // own; the shared server is then named outright. An id target or a bare
  // command keeps meaning the pane's own server, as it always has.
  const shared = socketOfTmuxEnv(env.TMUX) === "default" ? args : ["-L", "default", ...args];
  const own = (session: string | undefined) => (session && hasSessionServer(session, env) ? [["-L", sessionSocketName(session), ...args]] : null);
  if (named) return own(named) ?? [shared];
  if (scoped) return own(scoped) ?? [shared];
  const fleet = named === undefined && FLEET_LISTINGS.has(verb) && (verb !== "list-panes" && verb !== "list-windows" || rest.includes("-a"));
  if (!fleet) return [args];
  return [shared, ...sessionServerSockets(env).map((s) => ["-L", s, ...args])];
}

/** Join the stdout of a fleet listing: one line per row, whatever each server ended with. */
export function joinListings(outputs: string[]): string {
  const rows = outputs.map((o) => o.replace(/\n+$/, "")).filter(Boolean);
  return rows.length ? `${rows.join("\n")}\n` : "";
}

const errText = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = e?.stderr;
  return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(e?.message ?? err ?? "");
};

/** The socket a routed argv addresses, or null for the shared server reached without -L. */
function socketOf(argv: string[]): string | null {
  const i = argv.indexOf("-L");
  return i >= 0 ? argv[i + 1] ?? null : null;
}

/**
 * Whether a server's failure leaves a fleet listing complete. A socket file
 * that is gone held nothing. A socket nobody accepts on is either a server too
 * busy to answer or one that exited (tmux leaves its socket behind), and tmux
 * says "no server running" for both, so the process table decides: no server
 * process on it means it held nothing, and a session server's leftover socket
 * is removed so later listings do not ask it again. A server that is alive and
 * did not answer leaves the listing incomplete, and callers read a session
 * missing from a listing as gone, so that fails the listing.
 */
function holdsNothing(err: unknown, argv: string[], procs: () => ProcRow[], env: NodeJS.ProcessEnv): boolean {
  const text = errText(err);
  if (/error connecting to .+ \(No such file or directory\)/i.test(text)) return true;
  if (!/no server running on |error connecting to .+ \(Connection refused\)/i.test(text)) return false;
  const socket = socketOf(argv) ?? "default";
  if (socket === "default") return !!env.TMUX_TMPDIR || tmuxServerRows(procs(), process.getuid?.()).length === 0;
  if (procs().some((p) => p.command.includes(` -L ${socket} `))) return false;
  try { fs.rmSync(path.join(tmuxSocketDir(env), socket), { force: true }); } catch {}
  return true;
}

/**
 * Run one routed tmux call. `exec` throws on failure. A fleet listing answers
 * with every server, or fails as a single call would (holdsNothing).
 */
export function runRoutedSync<T>(argvs: string[][], exec: (argv: string[]) => T, join: (results: T[]) => T, env: NodeJS.ProcessEnv = process.env): T {
  if (argvs.length === 1) return exec(argvs[0]);
  const results: T[] = [];
  let firstError: unknown;
  let procs: ProcRow[] | null = null;
  for (const argv of argvs) {
    try {
      results.push(exec(argv));
    } catch (err) {
      firstError ??= err;
      if (!holdsNothing(err, argv, () => (procs ??= snapshotProcessTable()), env)) throw err;
    }
  }
  if (results.length === 0) throw firstError;
  return join(results);
}

const FLEET_CONCURRENCY = 8;

export async function runRouted<T>(argvs: string[][], exec: (argv: string[]) => Promise<T>, join: (results: T[]) => T, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (argvs.length === 1) return exec(argvs[0]);
  const settled: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = new Array(argvs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, argvs.length) }, async () => {
    while (next < argvs.length) {
      const i = next++;
      settled[i] = await exec(argvs[i]).then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
    }
  }));
  const failed = settled.flatMap((r, i) => (r.ok ? [] : [{ error: r.error, argv: argvs[i] }]));
  if (failed.length) {
    const procs = failed.some((f) => /no server running on |Connection refused/i.test(errText(f.error))) ? await snapshotProcessTableAsync() : [];
    const blocking = failed.find((f) => !holdsNothing(f.error, f.argv, () => procs, env));
    if (blocking) throw blocking.error;
  }
  const results = settled.flatMap((r) => (r.ok ? [r.value] : []));
  if (results.length === 0) throw failed[0].error;
  return join(results);
}

/** The socket a `$TMUX` value names, by file name; "default" for the shared server or none. */
export function socketOfTmuxEnv(tmux: string | undefined): string {
  return tmux ? path.basename(tmux.split(",")[0] ?? "") || "default" : "default";
}

/**
 * A pane's identity across every server: its id alone on the shared server
 * (`%7`, as it always was), and `%7@<socket>` on a session's own server,
 * where the same id is also in use on every other server.
 */
export function paneOwnerId(paneId: string, socket: string): string {
  return socket === "default" ? paneId : `${paneId}@${socket}`;
}

/** The environment a process in pane `id` (from paneOwnerId) would have. */
export function paneOwnerEnv(id: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const [pane, socket] = id.split("@");
  return socket ? { TMUX_PANE: pane, TMUX: `${path.join(tmuxSocketDir(env), socket)},0,0` } : { TMUX_PANE: pane };
}
