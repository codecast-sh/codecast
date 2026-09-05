// One `ps` snapshot of the whole process table, plus the pure tree walks built
// on it: descendants of a pid, and the "stale tmux server generation" detector
// that `cast doctor` runs.
//
// Why stale generations matter: when the default tmux socket file is replaced
// (the server wedged and a client unlinked it, /tmp was swept, a crashed
// respawn), the old server keeps running unreachable and holds every pane and
// agent process of its generation. `tmux list-sessions` only talks to the
// socket's current owner, so the fleet is invisible — and the daemon re-resumes
// the same session ids on the new server, doubling every agent. Seen twice
// (2026-08-14: 165 orphan claudes / 56GB; 2026-08-20: 290 processes, 10 orphan
// teammates / 5GB plus 267 idle login shells pushing `ps aux` past 20s).

import { execFileAsync, execFileSync } from "./proc.js";
import { isRecognizedAgentComm } from "./sessionProcessMatcher.js";
import { tmuxRunAsync } from "./tmux.js";
import { CLAUDE_VERSIONED_BINARY_RE } from "./stableClaudeBinary.js";

/** `uid` is the owning user, absent when the table was parsed from output that
 *  did not carry the column. A kill decision treats absent as "not mine". */
export type ProcRow = { pid: number; ppid: number; uid?: number; command: string };

// `ps -o command` prints a multi-line command line with its newlines intact,
// so a row can span lines: a line that does not start with a pid continues
// the previous row's command.
//
// Two shapes are accepted, `pid ppid uid command` and `pid ppid command`, so a
// caller that already holds a table without the owner column keeps working. The
// three number form is tried first and only wins when a third bare number is
// followed by more text, which no real command line starts with.
export function parseProcessTable(stdout: string): ProcRow[] {
  const procs: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    // macOS prints the uid of a `nobody` process as -2, so the owner column is
    // signed. Without the sign those rows fell through to the two number shape
    // and carried "-2" into the command text.
    const withUid = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S.*)$/);
    const m = withUid ?? line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) {
      procs.push(
        withUid
          ? { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), command: m[4] }
          : { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] },
      );
    } else if (procs.length && line.length) {
      procs[procs.length - 1].command += "\n" + line;
    }
  }
  return procs;
}

// The owner column rides along because the daemon's hourly sweep kills stale
// tmux servers unattended, and on a shared box (the EC2 Mac mini, the Linux
// agent hosts) another user's server on the default socket is not ours to touch.
const PS_ARGS = ["-axww", "-o", "pid=,ppid=,uid=,command="];
const PS_OPTS = { encoding: "utf-8" as const, maxBuffer: 64 * 1024 * 1024 };

/** How long to wait for `ps`. The default is generous because a doctor sweep
 *  would rather wait than miss an orphan fleet; on this laptop `ps aux` has run
 *  to 26s under load. An interactive caller passes something shorter: an empty
 *  table costs it one sweep, a stall costs the user the whole command. */
const PS_TIMEOUT_MS = 30_000;

export interface ProcessTableOptions {
  /** Milliseconds before `ps` is abandoned and the table comes back empty. */
  timeout?: number;
}

/** The live process table (pid, ppid, full command line). Empty on failure. */
export function snapshotProcessTable(opts: ProcessTableOptions = {}): ProcRow[] {
  try {
    return parseProcessTable(
      execFileSync("ps", PS_ARGS, { ...PS_OPTS, timeout: opts.timeout ?? PS_TIMEOUT_MS }) as string,
    );
  } catch {
    return [];
  }
}

/** The same snapshot off the event loop. The daemon uses this one: a `ps` that
 *  runs for seconds under load must never be the thing holding the loop. */
export async function snapshotProcessTableAsync(opts: ProcessTableOptions = {}): Promise<ProcRow[]> {
  try {
    const { stdout } = await execFileAsync("ps", PS_ARGS, {
      ...PS_OPTS,
      timeout: opts.timeout ?? PS_TIMEOUT_MS,
    });
    return parseProcessTable(String(stdout));
  } catch {
    return [];
  }
}

/** Every transitive child of `root` (root excluded), parents before children. */
export function descendantPids(procs: ProcRow[], root: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Does a command line's program look like one of our agent clients? Matches the
 *  registry binary names and the claude launcher's versioned binaries
 *  (`~/.local/share/claude/versions/2.1.237`), whose basename is a version. */
export function isAgentCommand(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  if (CLAUDE_VERSIONED_BINARY_RE.test(argv0)) return true;
  const base = argv0.split("/").pop() ?? "";
  // interpreters (node/bun) are too generic for a whole-tree count
  if (/^(node|bun|deno)$/.test(base)) return false;
  return isRecognizedAgentComm(base);
}

/** Program names that can be argv0 of a daemon. Anything else naming `_daemon`
 *  or a daemon file is talking ABOUT the daemon, not running it. */
const DAEMON_ARGV0_RE = /^(codecast|cast|bun|node|deno)(\.exe)?$/;

/**
 * Is this command line a codecast daemon? Matches all three install shapes:
 * source (`bun .../packages/cli/src/daemon.ts _daemon`), built JS
 * (`node .../dist/daemon.js`) and the compiled binary (`codecast -- _daemon`).
 *
 * Two tests keep the neighbours out, and both are load bearing because the
 * split brain sweep KILLS what this matches. The program has to be one of ours
 * or an interpreter, which rejects `nginx: master ... -g daemon off;`. And the
 * daemon token has to sit in the first argument position, which rejects every
 * cast command that merely mentions it: `cast send jx7c6zk restart the _daemon
 * now` and `cast blame packages/cli/src/daemon.ts` are ordinary commands, and
 * ps flattens quoting so a message body is just more argv tokens.
 *
 * It also deliberately misses `codecast _watchdog` and the worker shape
 * `codecast _worker <kind>`: those are meant to live.
 */
export function isDaemonCommand(command: string): boolean {
  const argv = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (argv.length < 2) return false;
  const argv0 = argv[0].split("/").pop() ?? "";
  if (!DAEMON_ARGV0_RE.test(argv0)) return false;
  // Interpreter flags (`bun --smol`, `node --enable-source-maps`), the argument
  // separator, and bun's own `run` subcommand sit before the entry point;
  // nothing else may. `bun run x/daemon.ts` executes the file in this process,
  // so it is a daemon like any other shape.
  const rest = /^(bun|deno)(\.exe)?$/.test(argv0) && argv[1] === "run" ? argv.slice(2) : argv.slice(1);
  const first = rest.find((t) => t !== "--" && !t.startsWith("-"));
  if (!first) return false;
  return first === "_daemon" || first.endsWith("/daemon.ts") || first.endsWith("/daemon.js");
}

/** Pids of every other daemon process on this machine. */
export function findOtherDaemonPids(procs: ProcRow[], selfPid = process.pid): number[] {
  return procs.filter((p) => p.pid !== selfPid && isDaemonCommand(p.command)).map((p) => p.pid);
}

export interface StaleTmuxServer {
  pid: number;
  command: string;
  /** Every process in its tree, the server excluded. The killer takes this
   *  list as it is: walking the table a second time to rebuild it can only
   *  disagree with the list the agent count was derived from. */
  tree: number[];
  /** How many of those are agent processes (claude, codex, ...). */
  agents: number;
}

/** tmux SERVER processes on the default socket: daemonized (ppid 1) `tmux`
 *  rows not pinned to another socket with -L/-S. Clients attached from a shell
 *  keep their shell as parent and never match.
 *
 *  `ownerUid` keeps another user's server out of the list, and every caller that
 *  can end in a kill passes it. A row with no owner column is dropped by it too:
 *  a killer must fail closed. Omitting it reports every server on the socket. */
export function tmuxServerRows(procs: ProcRow[], ownerUid?: number): ProcRow[] {
  return procs.filter((p) => {
    if (p.ppid !== 1) return false;
    if (ownerUid !== undefined && p.uid !== ownerUid) return false;
    const argv = p.command.trim().split(/\s+/);
    const base = argv[0]?.split("/").pop();
    if (base !== "tmux") return false;
    return !argv.some((a, i) => i > 0 && (a === "-L" || a === "-S" || a.startsWith("-L") || a.startsWith("-S")));
  });
}

/** Servers on the default socket other than the one tmux itself answers from.
 *  `livePid` null (tmux unreachable) reports every server, since none can be
 *  the live one. */
export function findStaleTmuxServers(procs: ProcRow[], livePid: number | null, ownerUid?: number): StaleTmuxServer[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return tmuxServerRows(procs, ownerUid)
    .filter((s) => s.pid !== livePid)
    .map((s) => {
      const tree = descendantPids(procs, s.pid);
      const agents = tree.filter((pid) => isAgentCommand(byPid.get(pid)?.command ?? "")).length;
      return { pid: s.pid, command: s.command, tree, agents };
    });
}

/**
 * What the daemon's unattended sweep may kill.
 *
 * Three guards, all here so they can be tested without a process table or a
 * tmux.
 *
 * No live pid means no kills at all: findStaleTmuxServers reports EVERY server
 * when it cannot name the live one, because none of them can be it, so a tmux
 * that is briefly unreachable would otherwise take the entire fleet down.
 *
 * Only this user's servers are candidates, because on a shared agent box
 * another account's server is neither stale nor ours.
 *
 * And a server whose tree holds this process is refused outright. A daemon
 * started from inside a tmux pane, which is the ordinary from-source shape,
 * would otherwise kill itself and its watchdog on an hourly tick the moment its
 * own generation went stale. The whole tree goes with the server, so dropping
 * one pid from the list is not enough: the parent shell dies and takes this
 * process with it. Reported separately so the sweep can say what it spared.
 */
export function staleTmuxServerKillPlan(
  procs: ProcRow[],
  livePid: number | null,
  ownerUid?: number,
  selfPid: number = process.pid,
): { kill: StaleTmuxServer[]; selfHosted: StaleTmuxServer[]; refused: "tmux-unreachable" | "owner-unknown" | null } {
  if (!Number.isInteger(livePid) || livePid! <= 1) return { kill: [], selfHosted: [], refused: "tmux-unreachable" };
  if (!Number.isInteger(ownerUid) || ownerUid! < 0) return { kill: [], selfHosted: [], refused: "owner-unknown" };
  const kill: StaleTmuxServer[] = [];
  const selfHosted: StaleTmuxServer[] = [];
  for (const server of findStaleTmuxServers(procs, livePid, ownerUid)) {
    if (server.pid === selfPid || server.tree.includes(selfPid)) selfHosted.push(server);
    else kill.push(server);
  }
  return { kill, selfHosted, refused: null };
}

/** The pid of the tmux server behind the default socket, or null when tmux is
 *  not installed or no server is running.
 *
 *  Async because the daemon's hourly stale-generation sweep asks for it on the
 *  main event loop, where a tmux that takes seconds to answer would block every
 *  session's delivery. Through tmuxRunAsync, not a bare execFileAsync, because
 *  that is the call that enriches PATH: under launchd the daemon's PATH has no
 *  /opt/homebrew/bin, so a bare `tmux` is simply not found and every server
 *  reads stale. */
export async function liveTmuxServerPid(): Promise<number | null> {
  const { status, stdout } = await tmuxRunAsync(["display-message", "-p", "#{pid}"], { timeout: 10_000 });
  const pid = parseInt(String(stdout ?? "").trim(), 10);
  return status === 0 && Number.isFinite(pid) && pid > 0 ? pid : null;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM every pid, wait up to `graceMs`, SIGKILL the survivors. Killing a
 *  tmux server alone leaks its tree, so callers pass the server AND its
 *  descendants. Returns how many needed the hard kill. */
export async function killProcessTree(pids: number[], graceMs = 3_000): Promise<{ terminated: number; killed: number }> {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + graceMs;
  let survivors = pids.filter(isAlive);
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    survivors = survivors.filter(isAlive);
  }
  for (const pid of survivors) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  return { terminated: pids.length - survivors.length, killed: survivors.length };
}
